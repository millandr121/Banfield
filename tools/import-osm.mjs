#!/usr/bin/env node
// Build a Banfield Tides region from real OpenStreetMap data + AWS terrain DEM.
//
// This is the same approach used by Build-The-Earth / WorldPainter plugins:
//   • OSM  → coastline, inlet, docks, roads, building footprints, campground, beach
//   • AWS Terrain Tiles (legally open, CC0) → real depths and hill heights
//
// USAGE (run in your Codespace — needs internet):
//
//   # Bamfield
//   node tools/import-osm.mjs \
//     --bbox 48.815,-125.16,48.855,-125.09 \
//     --width 200 --id bamfield --name "Bamfield" \
//     --sea-seed 0,199 \
//     --out shared/regions/bamfield.json
//
//   # Anacla / Pachena Bay
//   node tools/import-osm.mjs \
//     --bbox 48.785,-125.13,48.820,-125.07 \
//     --width 200 --id anacla --name "Anacla / Pachena Bay" \
//     --sea-seed 0,199 \
//     --out shared/regions/anacla.json
//
// After each run, re-run the other region so the travel links in the index are
// up to date, then run `npm run dev` in the project root to see the new maps.
//
// OFFLINE (Codespace with flaky internet / sandbox):
//   1. Open https://overpass-turbo.eu/, paste the query printed by --dump-query,
//      click Run, then Export → Download as raw OSM data (JSON).
//   2. Pass the file with --osm-json <file>. Elevation falls back to the
//      BFS-slope method when AWS tiles can't be fetched (--no-dem flag).
//
// OUTPUT: a RegionData JSON that shared/regions/index.ts imports so the engine
// uses it instead of the handcrafted map for that region id.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Tile enum (mirrors shared/protocol.ts — no TS import in a .mjs script)
// ---------------------------------------------------------------------------
const T = { Water: 0, Sand: 1, Grass: 2, Forest: 3, Hill: 4, Rock: 5, Road: 6, Dock: 7 };

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) { a[key] = true; }
      else { a[key] = next; i++; }
    }
  }
  return a;
}

const args = parseArgs(process.argv);

if (args["dump-query"] && args.bbox) {
  const [S, W, N, E] = args.bbox.split(",").map(Number);
  console.log(buildOverpassQuery(S, W, N, E));
  process.exit(0);
}

if (!args.bbox || !args.width || !args.id || !args.out) {
  console.error(
    "Usage: --bbox S,W,N,E --width N --id <id> --name <name> --out <json>\n" +
    "       [--osm-json <file>] [--osm-xml <file>] [--sea-seed X,Y] [--no-dem] [--dump-query]"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// OSM XML parser (openstreetmap.org export format → same shape as Overpass JSON)
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function extractAttr(str, name) {
  const m = str.match(new RegExp(`${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

function parseOsmXml(xml) {
  const nodeMap = new Map(); // id → {lat, lon}
  const elements = [];
  let current = null;

  for (const rawLine of xml.split("\n")) {
    const line = rawLine.trim();

    if (line.startsWith("<node ")) {
      const id  = extractAttr(line, "id");
      const lat = parseFloat(extractAttr(line, "lat") ?? "NaN");
      const lon = parseFloat(extractAttr(line, "lon") ?? "NaN");
      if (id && !isNaN(lat) && !isNaN(lon)) {
        nodeMap.set(id, { lat, lon });
        current = { type: "node", id: +id, lat, lon, tags: {} };
        if (line.includes("/>")) { elements.push(current); current = null; }
      }
    } else if (line === "</node>") {
      if (current?.type === "node") { elements.push(current); current = null; }
    } else if (line.startsWith("<way ")) {
      const id = extractAttr(line, "id");
      if (id) current = { type: "way", id: +id, _refs: [], geometry: [], tags: {} };
    } else if (line === "</way>") {
      if (current?.type === "way") {
        current.geometry = current._refs.map(r => nodeMap.get(r)).filter(Boolean);
        delete current._refs;
        elements.push(current);
      }
      current = null;
    } else if (line.startsWith("<nd ")) {
      const ref = extractAttr(line, "ref");
      if (ref && current?._refs) current._refs.push(ref);
    } else if (line.startsWith("<tag ")) {
      const k = extractAttr(line, "k");
      const v = extractAttr(line, "v");
      if (k != null && v != null && current) current.tags[k] = v;
    }
  }

  return { elements };
}

// ---------------------------------------------------------------------------
// Overpass query
// ---------------------------------------------------------------------------
function buildOverpassQuery(S, W, N, E) {
  const box = `(${S},${W},${N},${E})`;
  return `[out:json][timeout:90];
(
  way["natural"="coastline"]${box};
  way["natural"="water"]${box};
  relation["natural"="water"]${box};
  way["waterway"]${box};
  way["natural"="beach"]${box};
  way["natural"="sand"]${box};
  way["natural"="wood"]${box};
  way["landuse"="forest"]${box};
  way["landuse"="grass"]${box};
  way["leisure"="campsite"]${box};
  way["leisure"="campground"]${box};
  way["man_made"="pier"]${box};
  way["man_made"="breakwater"]${box};
  way["man_made"="jetty"]${box};
  way["highway"]${box};
  way["building"]${box};
  relation["building"]${box};
  node["amenity"="ferry_terminal"]${box};
  node["man_made"="pier"]${box};
);
out body geom;`;
}

async function fetchOsm(S, W, N, E) {
  // Try multiple Overpass mirrors in order.
  const mirrors = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  const query = buildOverpassQuery(S, W, N, E);
  let lastErr;
  for (const url of mirrors) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
      });
      if (res.ok) return res.json();
      lastErr = new Error(`Overpass HTTP ${res.status} from ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }
  // All mirrors failed — print the query so the user can fetch it manually.
  console.error("\n⚠  All Overpass mirrors failed. Paste this query at https://overpass-turbo.eu/,");
  console.error('   click Run → Export → "Download as raw OSM data (JSON)", then re-run with:');
  console.error("   --osm-json <downloaded-file.json>\n");
  console.error("Query:\n" + query);
  throw lastErr;
}

// ---------------------------------------------------------------------------
// AWS Terrain Tiles (open data, CC0)
// https://registry.opendata.aws/terrain-tiles/
// Elevation encoded as PNG: height = (R*256 + G + B/256) - 32768  (metres)
// ---------------------------------------------------------------------------
function latLonToTileXY(lat, lon, zoom) {
  const n = Math.pow(2, zoom);
  const x = Math.floor((lon + 180) / 360 * n);
  const latR = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n);
  return { x, y };
}

async function fetchTerrainTile(z, x, y) {
  const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  // Parse PNG ourselves — we only need the RGB channels.
  // Use pngjs if available (in devDependencies), otherwise skip.
  try {
    const require = createRequire(import.meta.url);
    const { PNG } = require("pngjs");
    return await new Promise((resolve, reject) => {
      const png = new PNG();
      png.parse(buf, (err, data) => {
        if (err) reject(err);
        else resolve(data);
      });
    });
  } catch {
    return null; // pngjs not installed, fall back
  }
}

// Sample the real elevation (metres) for a lat/lon using AWS Terrarium tiles.
// Returns an array parallel to the tile grid: elev[y*W+x] = metres above sea level.
async function fetchDEM(S, W_lon, N, E, gridW, gridH) {
  console.log("  Fetching terrain elevation (AWS Terrarium tiles)…");
  const zoom = 13; // ~10m/pixel at this latitude

  // Figure out which terrain tiles we need to cover the bbox.
  const tl = latLonToTileXY(N, W_lon, zoom);
  const br = latLonToTileXY(S, E, zoom);

  const TILE_PX = 256;

  // Build a mosaic of all needed terrain tiles.
  const mosaicTilesX = br.x - tl.x + 1;
  const mosaicTilesY = br.y - tl.y + 1;
  const mosaicW = mosaicTilesX * TILE_PX;
  const mosaicH = mosaicTilesY * TILE_PX;
  const mosaic = new Float32Array(mosaicW * mosaicH); // elevation in metres

  let fetchedAny = false;
  for (let ty = tl.y; ty <= br.y; ty++) {
    for (let tx = tl.x; tx <= br.x; tx++) {
      const png = await fetchTerrainTile(zoom, tx, ty);
      if (!png) continue;
      fetchedAny = true;
      const offX = (tx - tl.x) * TILE_PX;
      const offY = (ty - tl.y) * TILE_PX;
      for (let py = 0; py < TILE_PX; py++) {
        for (let px = 0; px < TILE_PX; px++) {
          const pi = (py * TILE_PX + px) * 4; // RGBA
          const r = png.data[pi], g = png.data[pi + 1], b = png.data[pi + 2];
          const metres = (r * 256 + g + b / 256) - 32768;
          mosaic[(offY + py) * mosaicW + (offX + px)] = metres;
        }
      }
    }
  }

  if (!fetchedAny) {
    console.log("  ⚠ Terrain tiles unavailable — falling back to BFS slope elevation.");
    return null;
  }

  // Resample mosaic onto our game tile grid.
  const lonSpan = E - W_lon, latSpan = N - S;
  const grid = new Float32Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const lat = N - (gy / (gridH - 1)) * latSpan;
      const lon = W_lon + (gx / (gridW - 1)) * lonSpan;
      // Map lat/lon to mosaic pixel coords.
      const tileX = (lon + 180) / 360 * Math.pow(2, zoom);
      const latR = lat * Math.PI / 180;
      const tileY = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * Math.pow(2, zoom);
      const px = Math.round((tileX - tl.x) * TILE_PX);
      const py = Math.round((tileY - tl.y) * TILE_PX);
      const clampedPx = Math.max(0, Math.min(mosaicW - 1, px));
      const clampedPy = Math.max(0, Math.min(mosaicH - 1, py));
      grid[gy * gridW + gx] = mosaic[clampedPy * mosaicW + clampedPx];
    }
  }
  console.log(`  ✓ Elevation sampled (${mosaicTilesX * mosaicTilesY} terrain tiles)`);
  return grid;
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------
function makeGrid(W, H) {
  return { W, H, t: new Int32Array(W * H).fill(T.Grass) };
}
function set(g, x, y, tile) {
  if (x >= 0 && y >= 0 && x < g.W && y < g.H) g.t[y * g.W + x] = tile;
}
function get(g, x, y) {
  if (x < 0 || y < 0 || x >= g.W || y >= g.H) return -1;
  return g.t[y * g.W + x];
}

function fillPolygon(g, pts, tile) {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(g.H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (a.y > y !== b.y > y) {
        xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      for (let x = Math.max(0, Math.round(xs[i])); x <= Math.min(g.W - 1, Math.round(xs[i + 1])); x++)
        set(g, x, y, tile);
    }
  }
}

function drawLine(g, pts, tile, thickness = 1) {
  const r = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let i = 0; i + 1 < pts.length; i++) {
    let { x: x0, y: y0 } = pts[i], { x: x1, y: y1 } = pts[i + 1];
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let ox = -r; ox <= r; ox++) for (let oy = -r; oy <= r; oy++) set(g, x0 + ox, y0 + oy, tile);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}

function floodFill(g, sx, sy, target, replace) {
  if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
  sx = Math.max(0, Math.min(g.W - 1, Math.round(sx)));
  sy = Math.max(0, Math.min(g.H - 1, Math.round(sy)));
  if (get(g, sx, sy) !== target) return;
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (get(g, x, y) !== target) continue;
    set(g, x, y, replace);
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

// Flood the open ocean inward from every map edge, but SEAL hairline gaps in the
// coastal barrier first so the sea can't pour through a 1-3 tile break and drown
// a whole enclosed landmass (this is what turned all of Pachena Bay / Anacla
// into water). We temporarily fatten every non-Grass "solid" tile (coastline
// sand, beach, forest, tagged water edges) into the surrounding grass by `seal`
// tiles — closing any gap up to 2*seal wide — flood, then peel the temp layer
// back to Grass. Real bay mouths are far wider than the seal, so genuine water
// still floods in; only the rounding cracks between coastline ways get plugged.
function floodOceanFromEdges(g, seaSeed) {
  const { W, H, t } = g;
  const seal = Math.max(2, Math.round(W / 1000)); // ~2 at 2200 wide, 3 at 3300
  // Mark the current barrier (everything that isn't bare Grass).
  const temp = new Uint8Array(W * H);
  let frontier = [];
  for (let i = 0; i < W * H; i++) if (t[i] !== T.Grass) frontier.push(i);
  // Grow the barrier into adjacent Grass `seal` times, tagging the temp tiles.
  for (let step = 0; step < seal; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % W, y = (i / W) | 0;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const ni = ny * W + nx;
        if (t[ni] === T.Grass && !temp[ni]) { temp[ni] = 1; next.push(ni); }
      }
    }
    frontier = next;
  }
  // Turn the temp halo into a barrier (Sand) so the flood can't cross it.
  for (let i = 0; i < W * H; i++) if (temp[i]) t[i] = T.Sand;
  // Flood the sea in from all four edges.
  for (let x = 0; x < W; x++) { floodFill(g, x, 0, T.Grass, T.Water); floodFill(g, x, H - 1, T.Grass, T.Water); }
  for (let y = 0; y < H; y++) { floodFill(g, 0, y, T.Grass, T.Water); floodFill(g, W - 1, y, T.Grass, T.Water); }
  if (seaSeed) floodFill(g, seaSeed.x, seaSeed.y, T.Grass, T.Water);
  // Peel the temporary halo back to Grass — it was never really sea or barrier.
  for (let i = 0; i < W * H; i++) if (temp[i]) t[i] = T.Grass;
}

function beachify(g) {
  const out = g.t.slice();
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    if (g.t[y * g.W + x] !== T.Water) continue;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.W || ny >= g.H) continue;
      if (out[ny * g.W + nx] === T.Grass) out[ny * g.W + nx] = T.Sand;
    }
  }
  g.t = out;
}

// BFS distance (in tiles) from every cell to the nearest Water tile.
function distanceToWater(g) {
  const { W, H, t } = g;
  const d = new Int32Array(W * H).fill(-1);
  const q = [];
  for (let i = 0; i < W * H; i++) if (t[i] === T.Water) { d[i] = 0; q.push(i); }
  for (let h = 0; h < q.length; h++) {
    const i = q[h], x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (d[ni] === -1) { d[ni] = d[i] + 1; q.push(ni); }
    }
  }
  return d;
}

// Clothe BARE grass (areas OSM left untagged) in natural coastal rainforest:
// a grassy shore band you can build/walk on, dense forest interior, and the
// odd rocky knoll on high ground. Without this the untagged south reads as one
// flat featureless lawn. Only ever paints over Grass — never water/sand/roads.
function applyLandcover(g) {
  const { W, H, t } = g;
  const dw = distanceToWater(g);
  for (let i = 0; i < W * H; i++) {
    if (t[i] !== T.Grass) continue;
    const d = dw[i] < 0 ? 9999 : dw[i];
    if (d <= 6) continue; // keep a grassy waterfront band (walkable shore/town)
    const x = i % W, y = (i / W) | 0;
    // Hash noise (non-periodic) so clearings & knolls scatter naturally instead
    // of forming a regular polka-dot grid.
    const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const r = v - Math.floor(v); // 0..1
    if (d > 26 && r > 0.94) t[i] = T.Hill;       // rare ridge knoll deep inland
    else if (r > 0.985) continue;                 // the odd meadow clearing
    else t[i] = T.Forest;
  }
}

// Carve a grassy margin around every road so it reads as a road through trees.
function clearRoadMargins(g, radius = 2) {
  const { W, H, t } = g;
  const roads = [];
  for (let i = 0; i < W * H; i++) if (t[i] === T.Road) roads.push(i);
  for (const i of roads) {
    const x = i % W, y = (i / W) | 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx;
      if (t[ni] === T.Forest || t[ni] === T.Hill) t[ni] = T.Grass;
    }
  }
}

// ---------------------------------------------------------------------------
// Elevation: convert real DEM metres -> game elevation values
// Game range: 0..100, waterline sweeps 1..30.
// Sea level = 0m, beach = ~1-3m, town = 5-30m, forest/hill = 20-150m+
// ---------------------------------------------------------------------------
function demToGameElevation(demGrid, tileGrid, W, H) {
  if (!demGrid) return null; // caller will use BFS fallback

  // Find sea-level reference: median of submerged tiles' DEM values.
  const waterDems = [];
  for (let i = 0; i < W * H; i++) {
    if (tileGrid[i] === T.Water) waterDems.push(demGrid[i]);
  }
  waterDems.sort((a, b) => a - b);
  const seaRef = waterDems[Math.floor(waterDems.length / 2)] ?? 0;

  // Typical land range in Bamfield is 0–150m. We map:
  //   seaRef - 30m (deep water) -> game elevation 0
  //   seaRef             (shore) -> game elevation 8
  //   seaRef + 20m (low town)   -> game elevation 24
  //   seaRef + 60m (forested)   -> game elevation 48
  //   seaRef + 150m (hill top)  -> game elevation 90
  const elev = new Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const m = demGrid[i] - seaRef;
    let e;
    if (m <= 0) {
      // Water / submerged: deeper = lower elevation
      e = Math.max(0, 8 + m * 0.25); // -1m → 7.75, -30m → 0.5
    } else {
      // Land: gentle ramp, clamp at 100
      e = 8 + m * 0.55;
    }
    elev[i] = Math.min(100, Math.max(0, Math.round(e)));
  }
  return elev;
}

// ---------------------------------------------------------------------------
// Resource-node auto-placement
// ---------------------------------------------------------------------------
const BERRY_VARIETIES = ["huckleberry", "salmonberry", "salal", "thimbleberry", "trailing blackberry"];
const INVASIVE_KINDS  = ["scotchBroom", "himalayanBlackberry", "foxglove"];

// Deterministic 0..1 hash for a cell (stable across re-runs).
const hash2 = (x, y, salt = 0) => {
  const n = Math.sin(x * 12.9898 + y * 78.233 + salt * 37.719) * 43758.5453;
  return n - Math.floor(n);
};
// Smooth value-noise (bilinear over a coarse hash grid) → clumpy, organic
// density fields instead of a rigid grid. `cell` = how many tiles per noise cell.
function valueNoise(x, y, cell, salt) {
  const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
  const fx = x / cell - gx, fy = y / cell - gy;
  const a = hash2(gx, gy, salt),     b = hash2(gx + 1, gy, salt);
  const c = hash2(gx, gy + 1, salt), d = hash2(gx + 1, gy + 1, salt);
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

// Pick a NW-coast tree species for a spot. Species ride in the node's `variety`.
// Rarity & habitat are true to Bamfield: cedar/hemlock/spruce/fir dominate the
// rainforest, alder & shore pine fringe the water, Pacific yew is a rare
// understorey prize, and arbutus is a super-rare rocky-shore find that does NOT
// grow back once felled (handled server-side).
function pickTreeSpecies(x, y, d) {
  const r = hash2(x, y, 7);
  if (d > 18 && r > 0.972) return "yew";                                    // rare understorey
  if (d <= 6)  return r < 0.55 ? "redalder" : "shorepine";                  // waterfront fringe
  if (d <= 14) return r < 0.4 ? "sitkaspruce" : r < 0.7 ? "redalder" : "hemlock";
  // interior old-growth coastal rainforest
  if (r < 0.34) return "redcedar";
  if (r < 0.58) return "hemlock";
  if (r < 0.78) return "douglasfir";
  if (r < 0.9)  return "sitkaspruce";
  return "bigleafmaple";
}

function autoPlaceResources(g, regionId) {
  const { W, H, t } = g;
  const nodes = [], plants = [];
  let ni = 0;
  const dw = distanceToWater(g);

  // --- TREES: organic, clumpy density (dense stands + open glades), scattered
  //     off-grid so it never reads as rows. A coarse value-noise field decides
  //     local density; a fine scan + jitter places the trunks. ---
  const coastalTrees = []; // candidates for the super-rare arbutus sprinkle
  const STEP = 4; // scan resolution; noise + hash gate the actual placements
  for (let y = 2; y < H - 2; y += STEP) {
    for (let x = 2; x < W - 2; x += STEP) {
      if (t[y * W + x] !== T.Forest) continue;
      // Density 0.10 (glade) .. ~0.4 (deep dense stand); denser further inland.
      const dens = valueNoise(x, y, 22, 3);
      const d = dw[y * W + x] < 0 ? 9999 : dw[y * W + x];
      const deepBonus = Math.min(0.12, d * 0.004);
      const prob = 0.10 + dens * 0.30 + deepBonus;
      if (hash2(x, y, 5) > prob) continue;
      // Jitter the trunk up to ±2 tiles off the scan point.
      const jx = Math.max(0, Math.min(W - 1, x + Math.round((hash2(x, y, 1) - 0.5) * 4)));
      const jy = Math.max(0, Math.min(H - 1, y + Math.round((hash2(x, y, 2) - 0.5) * 4)));
      if (t[jy * W + jx] !== T.Forest) continue;
      const dj = dw[jy * W + jx] < 0 ? 9999 : dw[jy * W + jx];
      const node = { id: `${regionId}-t${ni++}`, kind: "tree", x: jx, y: jy, variety: pickTreeSpecies(jx, jy, dj) };
      nodes.push(node);
      if (dj >= 3 && dj <= 9) coastalTrees.push(node); // rocky-shore band
    }
  }
  // Arbutus is impossibly rare — only a handful cling to rocky bluffs near the
  // shore, and they're gone for good once felled. Sprinkle ~7 deterministically
  // across the coastal band so they're a genuine "did you find one?" event.
  coastalTrees.sort((a, b) => hash2(b.x, b.y, 11) - hash2(a.x, a.y, 11));
  const ARBUTUS = Math.min(7, coastalTrees.length);
  for (let k = 0; k < ARBUTUS; k++) {
    // Spread the picks across the (hash-shuffled) coastal band so they don't clump.
    coastalTrees[Math.floor((k + 0.5) / ARBUTUS * coastalTrees.length)].variety = "arbutus";
  }

  // --- BERRIES, ORE: coarser scan over the same grid. ---
  for (let y = 2; y < H - 2; y += 8) {
    for (let x = 2; x < W - 2; x += 8) {
      const tile = t[y * W + x];
      if (tile === T.Forest) {
        if ((x + y) % 24 === 0) {
          const v = BERRY_VARIETIES[(x * 3 + y) % BERRY_VARIETIES.length];
          nodes.push({ id: `${regionId}-b${ni++}`, kind: "berryBush", x: x + 2, y: y + 1, variety: v });
        }
      } else if (tile === T.Hill || tile === T.Rock) {
        if ((x + y) % 20 === 0) nodes.push({ id: `${regionId}-i${ni++}`, kind: "ironOre", x, y });
        if ((x + y) % 20 === 10) nodes.push({ id: `${regionId}-s${ni++}`, kind: "stoneOre", x, y });
      } else if (tile === T.Grass) {
        if ((x + y) % 32 === 4) {
          const hasNearbyForest = [-1,0,1].some(dx => [-1,0,1].some(dy => {
            const ni2 = (y+dy)*W+(x+dx);
            return ni2>=0 && ni2<W*H && t[ni2]===T.Forest;
          }));
          if (hasNearbyForest) {
            const v = BERRY_VARIETIES[(x + y * 2) % BERRY_VARIETIES.length];
            nodes.push({ id: `${regionId}-b${ni++}`, kind: "berryBush", x, y, variety: v });
          }
        }
      }
    }
  }

  // Place a few invasive plants in disturbed/open sandy zones.
  let plantCount = 0, pi = 0;
  for (let y = 3; y < H - 3 && plantCount < 6; y += 15) {
    for (let x = 3; x < W - 3 && plantCount < 6; x += 18) {
      if (t[y * W + x] === T.Sand || t[y * W + x] === T.Grass) {
        const kind = INVASIVE_KINDS[plantCount % INVASIVE_KINDS.length];
        plants.push({ id: `${regionId}-inv${pi++}`, kind, x, y });
        plantCount++;
      }
    }
  }

  return { nodes, plants };
}

// ---------------------------------------------------------------------------
// Named building kinds from OSM tags
// ---------------------------------------------------------------------------
function buildingKind(tags) {
  const name = (tags.name || "").toLowerCase();
  const use  = (tags.building || tags["building:use"] || "").toLowerCase();
  const am   = (tags.amenity  || "").toLowerCase();
  if (name.includes("marine") || name.includes("research") || name.includes("science") || am === "research_institute") return "shop";
  if (use === "commercial" || am === "fuel" || am === "marketplace" || name.includes("shop") || name.includes("store") || name.includes("market") || name.includes("gas") || tags.shop) return "shop";
  if (am === "school" || am === "community_centre" || am === "social_facility") return "shop";
  if (name.includes("boat") || name.includes("marina") || use === "boathouse") return "boathouse";
  if (name.includes("dock") || name.includes("ferry")) return "dock";
  return "house";
}

// Assign a stable shop ID for known landmark buildings so shared/map.ts can
// re-attach ShopDef objects after JSON round-trip.
function stableId(regionId, tags) {
  const name = (tags.name || "").toLowerCase();
  const am   = (tags.amenity || "").toLowerCase();
  // Ostrom's Gas Bar lives on the Bamfield→Anacla road — it shows up in
  // whichever bbox it falls in. (OSM may label it "Pachena Bay Gas Bar"; locally
  // it's Ostrom's — NAME_OVERRIDE below fixes the displayed name.)
  if (am === "fuel" || name.includes("gas bar") || name.includes("gas station")) return "an-shop-gas";
  if (regionId === "bamfield") {
    if (name.includes("breakers"))                                       return "bf-shop-breakers";
    if (name.includes("marine sciences") || name.includes("bmsc"))      return "bf-shop-bmsc";
    if (name.includes("ostrom") || name.includes("tides") || name.includes("trails market")) return "bf-shop-ostroms";
    if (name.includes("mercantile") || name.includes("general"))        return "bf-shop-market";
    if (name.includes("flora") && tags.amenity === "restaurant") return "bf-shop-floras";
    if (am === "clinic" || am === "hospital")                           return "bf-shop-health";
    if (am === "post_office")                                            return "bf-shop-post";
    if (am === "fire_station")                                           return "bf-poi-firehall";
    if (am === "ferry_terminal" && name.includes("west"))               return "bf-dock-west";
    if (am === "ferry_terminal" && name.includes("east"))               return "bf-dock-east";
    if (am === "ferry_terminal")                                         return "bf-dock-ferry";
  }
  if (regionId === "anacla") {
    if ((tags.office === "government") || name.includes("huu-ay-aht")) return "an-shop-gov";
    if (name.includes("hacas") || name.includes("inn") || name.includes("lodge")) return "an-house-food";
  }
  return null;
}

// Force the displayed name for certain landmarks regardless of how OSM labels
// them (OSM data is sometimes stale or uses a different local name).
const NAME_OVERRIDE = {
  "an-shop-gas": "Ostrom's Gas Bar",
};
function displayName(stableIdValue, tags) {
  return NAME_OVERRIDE[stableIdValue] ?? tags.name;
}

// Returns true for ways that represent a building footprint (has polygon + is a structure).
function isBuilding(tags) {
  return !!(tags.building || tags.amenity || tags.shop || tags.office);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const [S, W_lon, N, E] = args.bbox.split(",").map(Number);
  const gridW = parseInt(args.width, 10);

  // Keep tiles roughly square via lat/lon metric ratio.
  const midLat = (S + N) / 2;
  const mPerLon = 111320 * Math.cos(midLat * Math.PI / 180);
  const mPerLat = 111320;
  const widthM  = (E - W_lon) * mPerLon;
  const heightM = (N - S) * mPerLat;
  const gridH = Math.max(8, Math.round(gridW * heightM / widthM));

  console.log(`Grid: ${gridW} × ${gridH} tiles  bbox: ${S},${W_lon} → ${N},${E}`);

  // --- OSM -------------------------------------------------------------------
  let osmSource = "Overpass API";
  if (args["osm-json"])  osmSource = args["osm-json"];
  if (args["osm-xml"])   osmSource = args["osm-xml"] + " (XML)";
  console.log(`  Loading OSM from ${osmSource}`);

  const osm = args["osm-xml"]
    ? parseOsmXml(readFileSync(args["osm-xml"], "utf8"))
    : args["osm-json"]
      ? JSON.parse(readFileSync(args["osm-json"], "utf8"))
      : await fetchOsm(S, W_lon, N, E);
  const ways  = (osm.elements || []).filter(e => e.type === "way");
  const nodes_osm = (osm.elements || []).filter(e => e.type === "node");
  console.log(`  ✓ ${ways.length} ways, ${nodes_osm.length} nodes`);

  const lonSpan = E - W_lon, latSpan = N - S;
  const toTile = (lon, lat) => ({
    x: ((lon - W_lon) / lonSpan) * (gridW - 1),
    y: ((N - lat)    / latSpan) * (gridH - 1),
  });
  const geom = el => (el.geometry || []).filter(Boolean).map(p => toTile(p.lon, p.lat));
  const tag  = (e, k) => e.tags && e.tags[k];

  // --- DEM ------------------------------------------------------------------
  let demGrid = null;
  if (!args["no-dem"]) {
    demGrid = await fetchDEM(S, W_lon, N, E, gridW, gridH).catch(err => {
      console.warn("  ⚠ DEM fetch failed:", err.message, "— using BFS slope fallback.");
      return null;
    });
  }

  // --- Rasterize OSM --------------------------------------------------------
  const g = makeGrid(gridW, gridH);

  // 1. Forest / wood areas
  for (const e of ways)
    if (tag(e,"natural")==="wood" || tag(e,"landuse")==="forest")
      fillPolygon(g, geom(e), T.Forest);

  // 2. Water bodies (inland lakes, Grappler Inlet as a polygon, etc.)
  for (const e of ways)
    if (tag(e,"natural")==="water" || tag(e,"waterway")==="riverbank")
      fillPolygon(g, geom(e), T.Water);

  // 3. Beach / sand polygons
  for (const e of ways)
    if (tag(e,"natural")==="beach" || tag(e,"natural")==="sand")
      fillPolygon(g, geom(e), T.Sand);

  // 4. Campground / campsite → Grass with a marker we keep
  for (const e of ways)
    if (tag(e,"leisure")==="campsite" || tag(e,"leisure")==="campground")
      fillPolygon(g, geom(e), T.Grass); // stays grass, spawn players here

  // 5. Coastline as a sand shoreline barrier (3px so the ocean flood-fill can't
  //    leak through diagonal gaps between segments — a leak here is what made
  //    Grappler Bay's east shore read as water instead of forested land).
  for (const e of ways)
    if (tag(e,"natural")==="coastline")
      drawLine(g, geom(e), T.Sand, 3);

  // 6. Waterways as water lines (rivers, streams, the main inlet as a way)
  for (const e of ways) {
    const ww = tag(e, "waterway");
    if (ww) {
      const thickness = ww === "river" ? 3 : ww === "stream" ? 2 : 1;
      drawLine(g, geom(e), T.Water, thickness);
    }
  }

  // 7. Flood the open ocean INWARD from every map edge — with hairline gaps in
  //    the coastal barrier sealed first, so the sea can't leak through a 1-3 tile
  //    crack between coastline ways and drown an entire enclosed landmass.
  let seaSeed = null;
  if (args["sea-seed"]) {
    const [sx, sy] = args["sea-seed"].split(",").map(Number);
    seaSeed = { x: sx, y: sy };
  }
  floodOceanFromEdges(g, seaSeed);

  // 7b. Clothe the remaining bare grass (untagged interior) in rainforest so
  //     the back-country reads as real coastal forest, not a flat lawn.
  applyLandcover(g);

  // 8. Roads (on top of everything — they're authoritative). Drawn wide so the
  //    main roads read as real two-lane traffic, tracks/trails a touch narrower.
  for (const e of ways) {
    const hw = tag(e, "highway");
    if (!hw) continue;
    // Keep footways/trails too (Bamfield is full of boardwalk), just thinner.
    const trail = hw === "footway" || hw === "path" || hw === "cycleway" || hw === "steps";
    const major = hw === "primary" || hw === "secondary" || hw === "tertiary"
               || hw === "residential" || hw === "unclassified";
    const thickness = trail ? 1 : major ? 3 : 2; // 3 = two-lane, 2 = service/track
    drawLine(g, geom(e), T.Road, thickness);
  }
  // Keep a grassy verge along the roads so they're not buried in the new forest.
  clearRoadMargins(g, 2);

  // 9. Docks / piers / breakwaters
  for (const e of ways) {
    const mm = tag(e, "man_made");
    if (mm === "pier" || mm === "breakwater" || mm === "jetty")
      drawLine(g, geom(e), T.Dock, 2);
  }

  // 10. Soften shorelines
  beachify(g);

  // 11. Apply DEM: upgrade grass tiles with real elevation to Hill/Rock.
  if (demGrid) {
    for (let i = 0; i < gridW * gridH; i++) {
      if (g.t[i] === T.Grass || g.t[i] === T.Forest) {
        const seaRef = 0; // already relative
        const m = demGrid[i];
        if (m > 80 && g.t[i] === T.Grass)  g.t[i] = T.Hill;
        if (m > 150 && g.t[i] !== T.Water) g.t[i] = T.Rock;
      }
    }
  }

  // 12. Reef polygons → Rock tiles (drawn after flood fill so they appear in water).
  for (const e of ways)
    if (tag(e, "natural") === "reef")
      fillPolygon(g, geom(e), T.Rock);

  // --- Buildings -----------------------------------------------------------
  const buildings = [];
  const usedIds = new Set(); // prevent duplicate stable IDs
  let bi = 0;
  const addBuilding = (id, kind, x, y, w, h, name) => {
    if (usedIds.has(id)) id = `${args.id}-b${bi++}`; // fallback if stable ID already taken
    usedIds.add(id);
    const b = { id, kind, x, y, w, h, hp: 100, maxHp: 100 };
    if (name) b.name = name;           // real OSM name, shown on the building
    buildings.push(b);
  };

  // a. Way-based building footprints
  for (const e of ways) {
    if (!isBuilding(e.tags || {})) continue;
    const pts = geom(e);
    if (pts.length < 3) continue;
    let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
    for (const p of pts) {
      minX = Math.min(minX,p.x); minY = Math.min(minY,p.y);
      maxX = Math.max(maxX,p.x); maxY = Math.max(maxY,p.y);
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) continue;
    // Clamp footprint size — some OSM polygons are whole campuses/boundaries
    // (e.g. the BMSC grounds). Anything bigger than a real building gets
    // centred on its centroid at a sane size instead of a giant box.
    const MAXD = 6;
    let rw = Math.round(maxX - minX) || 1;
    let rh = Math.round(maxY - minY) || 1;
    rw = Math.min(rw, MAXD); rh = Math.min(rh, MAXD);
    const bx = Math.max(0, Math.min(gridW - rw, Math.round(cx - rw / 2)));
    const by = Math.max(0, Math.min(gridH - rh, Math.round(cy - rh / 2)));
    const tags = e.tags || {};
    const sid = stableId(args.id, tags);
    addBuilding(sid ?? `${args.id}-b${bi++}`, buildingKind(tags), bx, by, rw, rh, displayName(sid, tags));
  }

  // b. Amenity/shop/tourism/office NODES — POI pins with no footprint polygon.
  for (const n of nodes_osm) {
    const tags = n.tags || {};
    if (!(tags.amenity || tags.shop || tags.tourism || tags.office)) continue;
    const skip = ["parking", "bench", "waste_basket", "recycling", "vending_machine", "atm", "toilets"];
    if (skip.includes(tags.amenity)) continue;
    const p = toTile(n.lon, n.lat);
    const bx = Math.round(p.x), by = Math.round(p.y);
    if (bx < 0 || bx >= gridW || by < 0 || by >= gridH) continue;
    const sid = stableId(args.id, tags);
    addBuilding(sid ?? `${args.id}-poi${bi++}`, buildingKind(tags), bx, by, 1, 1, displayName(sid, tags));
  }

  // --- Spawn ---------------------------------------------------------------
  // --spawn-near "name" anchors the spawn at a named building (e.g. the market,
  // so the West Coast Trail bus stop ends up right out front). Falls back to the
  // map centre, then walks outward to the nearest road/grass tile.
  let spawnX = Math.floor(gridW / 2), spawnY = Math.floor(gridH / 2);
  if (args["spawn-near"]) {
    const want = String(args["spawn-near"]).toLowerCase();
    const hit = buildings.find((b) => (b.name || "").toLowerCase().includes(want));
    if (hit) { spawnX = hit.x; spawnY = hit.y + hit.h + 1; } // just south of it (street side)
  }
  for (let r = 0; r < Math.max(gridW, gridH); r++) {
    let found = false;
    for (let dy = -r; dy <= r && !found; dy++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        if (Math.max(Math.abs(dx),Math.abs(dy)) !== r) continue;
        const x = spawnX + dx, y = spawnY + dy;
        if (x<0||y<0||x>=gridW||y>=gridH) continue;
        if (g.t[y*gridW+x] === T.Road || g.t[y*gridW+x] === T.Grass) {
          spawnX = x; spawnY = y; found = true;
        }
      }
    }
    if (found) break;
  }

  // --- Game elevation -------------------------------------------------------
  const elevation = demToGameElevation(demGrid, Array.from(g.t), gridW, gridH);

  // --- Resource nodes + invasive plants ------------------------------------
  const { nodes: resourceNodes, plants } = autoPlaceResources(g, args.id);

  // --- Starter vehicles (near spawn, in THIS map's coordinate space) --------
  // A car on the nearest road, a couple of boats on the nearest water — so they
  // don't fall back to stale handcrafted coords on the big imported map.
  const nearestTile = (wantTiles) => {
    for (let r = 1; r < Math.max(gridW, gridH); r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = spawnX + dx, y = spawnY + dy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        if (wantTiles.includes(g.t[y * gridW + x])) return { x, y };
      }
    }
    return null;
  };
  const vehicles = [];
  const carAt = nearestTile([T.Road]);
  if (carAt) vehicles.push({ id: `${args.id}-car-1`, kind: "car", x: carAt.x, y: carAt.y });
  const boatAt = nearestTile([T.Water]);
  if (boatAt) {
    vehicles.push({ id: `${args.id}-boat-1`, kind: "boat", x: boatAt.x, y: boatAt.y });
    vehicles.push({ id: `${args.id}-boat-2`, kind: "boat", x: boatAt.x, y: Math.min(gridH - 1, boatAt.y + 2) });
  }

  // --- In-world travel: the $3 West Coast Trail bus ------------------------
  // This is ONE big world (Anacla & Pachena Bay are the SE corner of the same
  // map, not a separate region). The bus is a paid fast-travel between the
  // Bamfield market and the Anacla road — for when you can't be bothered with
  // the long walk and don't have a car/boat. Both ends teleport WITHIN this map.
  const findNearestTo = (tx, ty, wantTiles) => {
    tx = Math.round(tx); ty = Math.round(ty);
    if (tx >= 0 && ty >= 0 && tx < gridW && ty < gridH && wantTiles.includes(g.t[ty * gridW + tx])) return { x: tx, y: ty };
    for (let r = 1; r < Math.max(gridW, gridH); r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx, y = ty + dy;
        if (x < 0 || y < 0 || x >= gridW || y >= gridH) continue;
        if (wantTiles.includes(g.t[y * gridW + x])) return { x, y };
      }
    }
    return null;
  };
  const travelNodes = [];
  if (args.id === "bamfield") {
    // Anacla village sits by the road on the NE shore of Pachena Bay.
    const anaclaTile = toTile(-125.1156, 48.7935);
    const anaclaStop = findNearestTo(anaclaTile.x, anaclaTile.y, [T.Road]) ||
                       findNearestTo(anaclaTile.x, anaclaTile.y, [T.Grass]);
    if (anaclaStop) {
      const FARE = 3;
      travelNodes.push({
        id: "bf-bus-anacla", kind: "bus", x: spawnX, y: spawnY, w: 2, h: 1, fare: FARE,
        label: `Catch the bus to Anacla ($${FARE})`,
        toRegion: args.id, toSpawn: { x: anaclaStop.x, y: anaclaStop.y },
      });
      travelNodes.push({
        id: "bf-bus-bamfield", kind: "bus", x: anaclaStop.x, y: anaclaStop.y, w: 2, h: 1, fare: FARE,
        label: `Catch the bus to Bamfield ($${FARE})`,
        toRegion: args.id, toSpawn: { x: spawnX, y: spawnY },
      });
      console.log(`  Bus: market (${spawnX},${spawnY}) <-> Anacla (${anaclaStop.x},${anaclaStop.y})`);
    }
  }

  // --- Output JSON ----------------------------------------------------------
  const out = {
    id: args.id,
    name: args.name || args.id,
    width: gridW,
    height: gridH,
    tiles: Array.from(g.t),
    ...(elevation ? { elevation } : {}),
    buildings,
    spawn: { x: spawnX, y: spawnY },
    travelNodes,
    vehicles,
    resourceNodes,
    plants,
  };

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 0)); // compact — it's big
  console.log(
    `✓ Wrote ${outPath}  (${gridW}×${gridH} = ${(gridW*gridH/1000).toFixed(0)}k tiles, ` +
    `${buildings.length} buildings, ${resourceNodes.length} resource nodes, ` +
    `${plants.length} invasive plants)`
  );

  // Rewrite shared/regions/index.ts to import this JSON and export it.
  updateRegionIndex(outPath, args.id, args.name || args.id);

  console.log("\nNext steps:");
  console.log("  1. git pull in your Codespace, then npm run dev");
  console.log("  2. Walk around, note the spawn, vehicles, and travel-link tiles");
  console.log("  3. Edit travelNodes / vehicles / spawn directly in the JSON if needed");
  console.log("  4. Run for the other region (Anacla) to get the full world");
}

// ---------------------------------------------------------------------------
// Rewrite shared/regions/index.ts to include this and any other already-
// imported region JSONs found alongside it.
// ---------------------------------------------------------------------------
function updateRegionIndex(outPath, id, _name) {
  const dir = dirname(outPath);
  const indexPath = join(dir, "index.ts");

  // Discover all region JSONs present alongside the index.
  const candidates = ["bamfield", "anacla", id].filter((v, i, a) => a.indexOf(v) === i);
  const present = candidates.filter(rid => existsSync(join(dir, `${rid}.json`)));

  const lines = [
    "// AUTO-GENERATED by tools/import-osm.mjs — do not edit by hand.",
    "import type { RegionData } from \"../map\";",
    "",
    ...present.map(f => {
      const rid = f.replace(".json","");
      return `import ${rid}Data from "./${f}.json";`;
    }),
    "",
    "export const IMPORTED_REGIONS: RegionData[] = [",
    ...present.map(f => `  ${f.replace(".json","")}Data as unknown as RegionData,`),
    "];",
  ];
  writeFileSync(indexPath, lines.join("\n") + "\n");
  console.log(`✓ Updated ${indexPath}  (regions: ${present.map(f=>f.replace(".json","")).join(", ")})`);
}

main().catch(err => { console.error(err); process.exit(1); });
