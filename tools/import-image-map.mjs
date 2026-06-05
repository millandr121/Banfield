#!/usr/bin/env node
// Convert a top-down image into a Bamfield Tides region JSON.
//
// Each pixel of the input PNG becomes one tile. Paint (or trace satellite
// imagery / your Minecraft screenshot) using the palette below, then run:
//
//   node tools/import-image-map.mjs \
//     --image maps/anacla.png \
//     --id anacla --name "Anacla / Pachena Bay" \
//     --out shared/regions/anacla.json
//
// Optional --elevation maps/anacla_height.png (grayscale: white=high) refines
// grass into hill/rock on steep ground.
//
// Buildings: paint magenta (#ff00ff). Connected magenta blobs become building
// rectangles (kind defaults to "house"; tweak in the JSON afterwards).
//
// Requires: npm i -D pngjs   (already in devDependencies)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

// Tile enum mirrors shared/protocol.ts (kept in sync by hand).
const Tile = { Water: 0, Sand: 1, Grass: 2, Forest: 3, Hill: 4, Rock: 5, Road: 6, Dock: 7 };
const BUILDING = -1; // sentinel during classification

// Palette: [r, g, b] -> tile. Match the colors used by the client renderer.
const PALETTE = [
  { rgb: [28, 95, 134], tile: Tile.Water },
  { rgb: [216, 201, 140], tile: Tile.Sand },
  { rgb: [79, 125, 58], tile: Tile.Grass },
  { rgb: [47, 90, 40], tile: Tile.Forest },
  { rgb: [107, 111, 87], tile: Tile.Hill },
  { rgb: [125, 125, 125], tile: Tile.Rock },
  { rgb: [91, 82, 74], tile: Tile.Road },
  { rgb: [122, 90, 54], tile: Tile.Dock },
  { rgb: [255, 0, 255], tile: BUILDING }, // magenta marker
];

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

function loadPng(path) {
  return PNG.sync.read(readFileSync(path));
}

function nearestTile(r, g, b) {
  let best = Tile.Grass;
  let bestD = Infinity;
  for (const p of PALETTE) {
    const d = (p.rgb[0] - r) ** 2 + (p.rgb[1] - g) ** 2 + (p.rgb[2] - b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = p.tile;
    }
  }
  return best;
}

// Group connected BUILDING cells into bounding-box rectangles.
function extractBuildings(grid, w, h) {
  const seen = new Uint8Array(w * h);
  const rects = [];
  const at = (x, y) => y * w + x;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (grid[at(x, y)] !== BUILDING || seen[at(x, y)]) continue;
      let minX = x, minY = y, maxX = x, maxY = y;
      const stack = [[x, y]];
      seen[at(x, y)] = 1;
      while (stack.length) {
        const [cx, cy] = stack.pop();
        minX = Math.min(minX, cx); minY = Math.min(minY, cy);
        maxX = Math.max(maxX, cx); maxY = Math.max(maxY, cy);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (grid[at(nx, ny)] === BUILDING && !seen[at(nx, ny)]) {
            seen[at(nx, ny)] = 1;
            stack.push([nx, ny]);
          }
        }
      }
      rects.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
  }
  return rects;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.image || !args.id || !args.out) {
    console.error("Usage: --image <png> --id <id> --name <name> --out <json> [--elevation <png>]");
    process.exit(1);
  }

  const png = loadPng(args.image);
  const { width: w, height: h } = png;
  const grid = new Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      grid[y * w + x] = nearestTile(png.data[i], png.data[i + 1], png.data[i + 2]);
    }
  }

  // Optional elevation refinement.
  if (args.elevation) {
    const el = loadPng(args.elevation);
    if (el.width === w && el.height === h) {
      for (let i = 0; i < w * h; i++) {
        if (grid[i] !== Tile.Grass && grid[i] !== Tile.Forest) continue;
        const lum = el.data[i * 4]; // grayscale -> red channel
        if (lum > 210) grid[i] = Tile.Rock;
        else if (lum > 160) grid[i] = Tile.Hill;
      }
    } else {
      console.warn("elevation image size mismatch; ignoring");
    }
  }

  // Buildings, then backfill their cells with grass so the ground is walkable.
  const rects = extractBuildings(grid, w, h);
  const buildings = rects.map((r, i) => ({
    id: `${args.id}-b${i}`,
    kind: "house",
    x: r.x,
    y: r.y,
    w: r.w,
    h: r.h,
    hp: 100,
    maxHp: 100,
  }));
  for (let i = 0; i < grid.length; i++) if (grid[i] === BUILDING) grid[i] = Tile.Grass;

  const out = {
    id: args.id,
    name: args.name || args.id,
    width: w,
    height: h,
    tiles: grid,
    buildings,
    spawn: { x: Math.floor(w / 2), y: Math.floor(h / 2) },
    travelNodes: [],
  };

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(out));
  console.log(
    `Wrote ${args.out}: ${w}x${h} tiles, ${buildings.length} buildings. ` +
      `Edit spawn/travelNodes, then register it in shared/map.ts buildRegions().`,
  );
}

main();
