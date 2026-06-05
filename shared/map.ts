import { Tile, WorldMap, BuildingState } from "./protocol";

// A handcrafted, Bamfield-inspired layout. Bamfield, BC straddles an inlet:
// the west side is the famous boardwalk fronting the water, the east side has
// the road, and Barkley Sound opens to the south. Forested hills rise inland.
//
// This is intentionally simple data so you can later REPLACE it by tracing your
// Minecraft build (see README "Getting Bamfield into the game"). The shape of
// this function is the contract: return a WorldMap of `Tile`s.

export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;

export function generateBamfieldMap(): WorldMap {
  const w = MAP_WIDTH;
  const h = MAP_HEIGHT;
  const tiles: Tile[] = new Array(w * h).fill(Tile.Grass);

  const at = (x: number, y: number) => y * w + x;

  // The inlet: a wavy channel of water running top (north) to bottom (south),
  // widening into Barkley Sound at the bottom.
  for (let y = 0; y < h; y++) {
    const center = 30 + Math.round(4 * Math.sin(y / 5));
    const widen = y > h - 12 ? (y - (h - 12)) * 0.9 : 0; // open to the sound
    const half = 3 + widen;
    for (let x = 0; x < w; x++) {
      if (Math.abs(x - center) <= half) tiles[at(x, y)] = Tile.Water;
    }
  }

  // Sand beaches line the water; forest/hills sit further inland.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tiles[at(x, y)] !== Tile.Water) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (tiles[at(nx, ny)] === Tile.Grass) tiles[at(nx, ny)] = Tile.Sand;
      }
    }
  }

  // Inland hills/forest on the far edges.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tiles[at(x, y)] !== Tile.Grass) continue;
      const distToEdge = Math.min(x, w - 1 - x);
      if (distToEdge < 4) tiles[at(x, y)] = Tile.Hill;
      else if (distToEdge < 7) tiles[at(x, y)] = Tile.Forest;
    }
  }

  // The east-side road running the length of town.
  const roadX = 40;
  for (let y = 2; y < h - 4; y++) {
    if (tiles[at(roadX, y)] !== Tile.Water) tiles[at(roadX, y)] = Tile.Road;
  }

  // Docks reaching from the west boardwalk into the inlet.
  for (const dy of [8, 16, 24]) {
    for (let x = 24; x < 28; x++) {
      if (tiles[at(x, dy)] === Tile.Water || tiles[at(x, dy)] === Tile.Sand) {
        tiles[at(x, dy)] = Tile.Dock;
      }
    }
  }

  return { width: w, height: h, tiles };
}

// Buildings that exist at world start. They have HP, can be destroyed into
// rubble, and rebuilt. Placed along the west boardwalk + a couple east-side.
export function initialBuildings(): BuildingState[] {
  const defs: Array<{
    kind: BuildingState["kind"];
    x: number;
    y: number;
    w: number;
    h: number;
    hp: number;
  }> = [
    { kind: "house", x: 21, y: 6, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 21, y: 12, w: 2, h: 2, hp: 100 },
    { kind: "shop", x: 20, y: 18, w: 3, h: 2, hp: 140 },
    { kind: "boathouse", x: 21, y: 24, w: 2, h: 3, hp: 120 },
    { kind: "house", x: 22, y: 30, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 43, y: 10, w: 2, h: 2, hp: 100 },
    { kind: "shop", x: 43, y: 20, w: 3, h: 2, hp: 140 },
  ];
  return defs.map((d, i) => ({
    id: `b${i}`,
    kind: d.kind,
    x: d.x,
    y: d.y,
    w: d.w,
    h: d.h,
    hp: d.hp,
    maxHp: d.hp,
  }));
}

// A safe spawn point on high ground (won't flood, away from water).
export const SPAWN = { x: 36, y: 6 };
