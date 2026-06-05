#!/usr/bin/env node
// Build a Bamfield Tides region from REAL OpenStreetMap data.
//
// OSM gives us the actual coastline, inlet, rivers, roads, and building
// footprints — legally shippable, unlike Google/satellite imagery (use that
// only as a visual reference). This rasterizes that vector data onto our tile
// grid and writes a region JSON.
//
// Two ways to run:
//
//   1) Live (needs internet — run on your own machine):
//      node tools/import-osm.mjs \
//        --bbox 48.815,-125.16,48.85,-125.11 \
//        --width 90 --id bamfield --name "Bamfield" \
//        --sea-seed 0,89 --out shared/regions/bamfield.json
//
//   2) Offline (works anywhere): first save Overpass JSON to a file, then:
//      node tools/import-osm.mjs --osm-json maps/bamfield.osm.json \
//        --bbox 48.815,-125.16,48.85,-125.11 --width 90 \
//        --id bamfield --name "Bamfield" --sea-seed 0,89 \
//        --out shared/regions/bamfield.json
//
// --sea-seed X,Y is a tile that sits in the OPEN OCEAN; the ocean is flood-
// filled from there inland up to the coastline. (Bottom-left works for Bamfield
// since Barkley Sound is to the south/west.)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const Tile = { Water: 0, Sand: 1, Grass: 2, Forest: 3, Hill: 4, Rock: 5, Road: 6, Dock: 7 };

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

const OVERPASS = "https://overpass-api.de/api/interpreter";

function overpassQuery(s, w, n, e) {
  const box = `(${s},${w},${n},${e})`;
  return `[out:json][timeout:60];
(
  way["natural"="coastline"]${box};
  way["natural"="water"]${box};
  relation["natural"="water"]${box};
  way["waterway"]${box};
  way["natural"="beach"]${box};
  way["natural"="wood"]${box};
  way["landuse"="forest"]${box};
  way["highway"]${box};
  way["building"]${box};
  relation["building"]${box};
);
out body geom;`;
}

async function fetchOsm(s, w, n, e) {
  const res = await fetch(OVERPASS, {
    method: "POST",
    body: "data=" + encodeURIComponent(overpassQuery(s, w, n, e)),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

// --- rasterization ----------------------------------------------------------
function makeGrid(W, H) {
  return { W, H, t: new Array(W * H).fill(Tile.Grass) };
}

function inBounds(g, x, y) {
  return x >= 0 && y >= 0 && x < g.W && y < g.H;
}

function set(g, x, y, tile) {
  if (inBounds(g, x, y)) g.t[y * g.W + x] = tile;
}

function fillPolygon(g, pts, tile) {
  if (pts.length < 3) return;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(g.H - 1, Math.ceil(maxY));
  for (let y = minY; y <= maxY; y++) {
    const xs = [];
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (a.y <= y && b.y > y) {
        // a.y < y <= b.y
      }
      const intersects = a.y > y !== b.y > y;
      if (intersects) {
        const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
        xs.push(x);
      }
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const x0 = Math.max(0, Math.round(xs[i]));
      const x1 = Math.min(g.W - 1, Math.round(xs[i + 1]));
      for (let x = x0; x <= x1; x++) set(g, x, y, tile);
    }
  }
}

function drawLine(g, pts, tile, thickness = 1) {
  const r = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let i = 0; i + 1 < pts.length; i++) {
    let { x: x0, y: y0 } = pts[i];
    let { x: x1, y: y1 } = pts[i + 1];
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      for (let ox = -r; ox <= r; ox++)
        for (let oy = -r; oy <= r; oy++) set(g, x0 + ox, y0 + oy, tile);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}

// Flood the ocean inland from a seed, stopping at any non-grass (coastline is
// drawn as Sand, so it acts as the shoreline barrier).
function floodOcean(g, sx, sy) {
  if (!inBounds(g, sx, sy)) return;
  const stack = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (!inBounds(g, x, y) || g.t[y * g.W + x] !== Tile.Grass) continue;
    g.t[y * g.W + x] = Tile.Water;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

function beachify(g) {
  const out = g.t.slice();
  for (let y = 0; y < g.H; y++)
    for (let x = 0; x < g.W; x++) {
      if (g.t[y * g.W + x] !== Tile.Water) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (inBounds(g, nx, ny) && out[ny * g.W + nx] === Tile.Grass)
          out[ny * g.W + nx] = Tile.Sand;
      }
    }
  g.t = out;
}

// --- main -------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  if (!args.bbox || !args.width || !args.id || !args.out) {
    console.error(
      "Usage: --bbox S,W,N,E --width N --id <id> --name <name> --out <json> " +
        "[--osm-json <file>] [--sea-seed X,Y]",
    );
    process.exit(1);
  }

  const [S, Wd, N, E] = args.bbox.split(",").map(Number);
  const W = parseInt(args.width, 10);

  // Keep tiles roughly square: scale height by the lat/lon metric ratio.
  const midLat = (S + N) / 2;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((midLat * Math.PI) / 180);
  const widthM = (E - Wd) * mPerLon;
  const heightM = (N - S) * mPerLat;
  const H = Math.max(8, Math.round((W * heightM) / widthM));

  const osm = args["osm-json"]
    ? JSON.parse(readFileSync(args["osm-json"], "utf8"))
    : await fetchOsm(S, Wd, N, E);

  const lonSpan = E - Wd, latSpan = N - S;
  const toTile = (lon, lat) => ({
    x: ((lon - Wd) / lonSpan) * (W - 1),
    y: ((N - lat) / latSpan) * (H - 1), // north at top
  });
  // Overpass "geom" gives each way an inline geometry array of {lat,lon}.
  const geom = (el) => (el.geometry || []).filter(Boolean).map((p) => toTile(p.lon, p.lat));

  const g = makeGrid(W, H);
  const ways = (osm.elements || []).filter((e) => e.type === "way");

  const tag = (e, k) => e.tags && e.tags[k];

  // 1. areas: forest, then inlet/lake water, then beaches
  for (const e of ways)
    if (tag(e, "natural") === "wood" || tag(e, "landuse") === "forest")
      fillPolygon(g, geom(e), Tile.Forest);
  for (const e of ways) if (tag(e, "natural") === "water") fillPolygon(g, geom(e), Tile.Water);
  for (const e of ways) if (tag(e, "natural") === "beach") fillPolygon(g, geom(e), Tile.Sand);

  // 2. coastline as the shoreline barrier (Sand)
  for (const e of ways) if (tag(e, "natural") === "coastline") drawLine(g, geom(e), Tile.Sand, 1);

  // 3. rivers/streams as water lines
  for (const e of ways) if (tag(e, "waterway")) drawLine(g, geom(e), Tile.Water, 2);

  // 4. flood the open ocean inland from the seed
  if (args["sea-seed"]) {
    const [sx, sy] = args["sea-seed"].split(",").map(Number);
    floodOcean(g, sx, sy);
  }

  // 5. roads on top
  for (const e of ways) if (tag(e, "highway")) drawLine(g, geom(e), Tile.Road, 1);

  // 6. soften shorelines
  beachify(g);

  // 7. buildings -> rectangles (footprint bounding boxes)
  const buildings = [];
  let bi = 0;
  for (const e of ways) {
    if (!tag(e, "building")) continue;
    const pts = geom(e);
    if (pts.length < 3) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    const x = Math.max(0, Math.round(minX)), y = Math.max(0, Math.round(minY));
    const w = Math.max(1, Math.min(g.W - x, Math.round(maxX - minX) || 1));
    const h = Math.max(1, Math.min(g.H - y, Math.round(maxY - minY) || 1));
    buildings.push({ id: `${args.id}-b${bi++}`, kind: "house", x, y, w, h, hp: 100, maxHp: 100 });
  }

  const out = {
    id: args.id,
    name: args.name || args.id,
    width: W,
    height: H,
    tiles: g.t,
    buildings,
    spawn: { x: Math.floor(W / 2), y: Math.floor(H / 3) },
    travelNodes: [],
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(out));
  console.log(
    `Wrote ${args.out}: ${W}x${H} tiles from ${ways.length} OSM ways, ` +
      `${buildings.length} buildings.\n` +
      `Next: set spawn + travelNodes, then register it in shared/map.ts buildRegions().`,
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
