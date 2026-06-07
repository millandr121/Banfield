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

function autoPlaceResources(g, regionId) {
  const { W, H, t } = g;
  const nodes = [], plants = [];
  let ni = 0, pi = 0;

  // Spacing: every ~8 tiles for trees, ~20 for ore, ~12 for berry.
  for (let y = 2; y < H - 2; y += 8) {
    for (let x = 2; x < W - 2; x += 8) {
      const tile = t[y * W + x];
      if (tile === T.Forest) {
        nodes.push({ id: `${regionId}-t${ni++}`, kind: "tree", x, y });
        // Chance of a berry bush in the forest understorey.
        if ((x + y) % 24 === 0) {
          const v = BERRY_VARIETIES[(x * 3 + y) % BERRY_VARIETIES.length];
          nodes.push({ id: `${regionId}-b${ni++}`, kind: "berryBush", x: x + 2, y: y + 1, variety: v });
        }
      } else if (tile === T.Hill || tile === T.Rock) {
        if ((x + y) % 20 === 0) nodes.push({ id: `${regionId}-i${ni++}`, kind: "ironOre", x, y });
        if ((x + y) % 20 === 10) nodes.push({ id: `${regionId}-s${ni++}`, kind: "stoneOre", x, y });
      } else if (tile === T.Grass) {
        // Sparse berry on grass edges near forest.
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
  let plantCount = 0;
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
  // Gas bar lives on the Bamfield→Anacla road — it shows up in whichever bbox it falls in.
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

  // 5. Coastline as a sand shoreline barrier (2px so the flood can't leak
  //    through diagonal gaps between segments).
  for (const e of ways)
    if (tag(e,"natural")==="coastline")
      drawLine(g, geom(e), T.Sand, 2);

  // 6. Waterways as water lines (rivers, streams, the main inlet as a way)
  for (const e of ways) {
    const ww = tag(e, "waterway");
    if (ww) {
      const thickness = ww === "river" ? 3 : ww === "stream" ? 2 : 1;
      drawLine(g, geom(e), T.Water, thickness);
    }
  }

  // 7. Flood the open ocean INWARD from every map edge. In a coastal bbox the
  //    border is almost all sea; the coastline drawn above is the barrier, so
  //    any grass the flood can't reach from the border stays as inland ground.
  //    (A single interior seed left huge bays unfilled — see issue with the NW
  //    and SW corners reading as land.)
  for (let x = 0; x < gridW; x++) {
    floodFill(g, x, 0, T.Grass, T.Water);
    floodFill(g, x, gridH - 1, T.Grass, T.Water);
  }
  for (let y = 0; y < gridH; y++) {
    floodFill(g, 0, y, T.Grass, T.Water);
    floodFill(g, gridW - 1, y, T.Grass, T.Water);
  }
  // Optional explicit seed too, for an interior basin the border can't reach.
  if (args["sea-seed"]) {
    const [sx, sy] = args["sea-seed"].split(",").map(Number);
    floodFill(g, sx, sy, T.Grass, T.Water);
  }

  // 8. Roads (on top of everything — they're authoritative).
  for (const e of ways) {
    const hw = tag(e, "highway");
    if (!hw) continue;
    // Skip footpaths and cycleway only; keep everything motorised.
    if (hw === "footway" || hw === "path" || hw === "cycleway" || hw === "steps") continue;
    const thickness = hw === "primary" || hw === "secondary" ? 2 : 1;
    drawLine(g, geom(e), T.Road, thickness);
  }

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
    addBuilding(stableId(args.id, tags) ?? `${args.id}-b${bi++}`, buildingKind(tags), bx, by, rw, rh, tags.name);
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
    addBuilding(stableId(args.id, tags) ?? `${args.id}-poi${bi++}`, buildingKind(tags), bx, by, 1, 1, tags.name);
  }

  // --- Spawn ---------------------------------------------------------------
  // Default: find a road tile near the middle of the map (= town centre).
  let spawnX = Math.floor(gridW / 2), spawnY = Math.floor(gridH / 2);
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
    travelNodes: [],      // derived dynamically at runtime by applyImported()
    vehicles: [],         // place by hand after first look
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
