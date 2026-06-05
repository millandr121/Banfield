import { BuildingState, Tile, TravelNode, WorldMap } from "./protocol";

// The world is a set of REGIONS that share one tide clock. Right now there are
// two, a couple of km apart in reality, linked by travel (bus / car / boat):
//
//   bamfield  — West & East Bamfield + Grappler Inlet, open to Barkley Sound
//   anacla    — Lower Anacla village + Pachena Bay & the Pachena River
//
// These are handcrafted, recognizable approximations. To swap in the REAL
// geography (OSM + elevation, or a traced Minecraft screenshot) see
// REGION_IMPORT.md — the importer outputs data in exactly this shape.

export const MAP_WIDTH = 60;
export const MAP_HEIGHT = 40;

export interface RegionDef {
  id: string;
  name: string;
  map: WorldMap;
  buildings: BuildingState[];
  spawn: { x: number; y: number }; // default arrival / respawn point
  travelNodes: TravelNode[];
}

const idx = (x: number, y: number) => y * MAP_WIDTH + x;

function fill(tile: Tile): Tile[] {
  return new Array(MAP_WIDTH * MAP_HEIGHT).fill(tile);
}

// Turn any grass tile touching water into a sand beach.
function beachify(tiles: Tile[]) {
  const out = tiles.slice();
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (tiles[idx(x, y)] !== Tile.Water) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_WIDTH || ny >= MAP_HEIGHT) continue;
        if (out[idx(nx, ny)] === Tile.Grass) out[idx(nx, ny)] = Tile.Sand;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BAMFIELD
// ---------------------------------------------------------------------------
function generateBamfieldMap(): WorldMap {
  let tiles = fill(Tile.Grass);

  // Grappler/Bamfield Inlet: a wavy channel north->south, widening to the sound.
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const center = 30 + Math.round(4 * Math.sin(y / 5));
    const widen = y > MAP_HEIGHT - 12 ? (y - (MAP_HEIGHT - 12)) * 0.9 : 0;
    const half = 3 + widen;
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (Math.abs(x - center) <= half) tiles[idx(x, y)] = Tile.Water;
    }
  }

  tiles = beachify(tiles);

  // Inland forest + hills on the far edges (West and East Bamfield rise inland).
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (tiles[idx(x, y)] !== Tile.Grass) continue;
      const distToEdge = Math.min(x, MAP_WIDTH - 1 - x);
      if (distToEdge < 4) tiles[idx(x, y)] = Tile.Hill;
      else if (distToEdge < 7) tiles[idx(x, y)] = Tile.Forest;
    }
  }

  // Bamfield Main: the east-side road running up the hill (north end).
  const roadX = 40;
  for (let y = 2; y < MAP_HEIGHT - 4; y++) {
    if (tiles[idx(roadX, y)] !== Tile.Water) tiles[idx(roadX, y)] = Tile.Road;
  }

  // West-side boardwalk docks reaching into the inlet.
  for (const dy of [8, 16, 24]) {
    for (let x = 24; x < 28; x++) {
      const t = tiles[idx(x, dy)];
      if (t === Tile.Water || t === Tile.Sand) tiles[idx(x, dy)] = Tile.Dock;
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles };
}

function bamfieldBuildings(): BuildingState[] {
  return mkBuildings("bf", [
    { kind: "house", x: 21, y: 6, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 21, y: 12, w: 2, h: 2, hp: 100 },
    { kind: "shop", x: 20, y: 18, w: 3, h: 2, hp: 140 }, // the market
    { kind: "boathouse", x: 21, y: 24, w: 2, h: 3, hp: 120 },
    { kind: "house", x: 22, y: 30, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 43, y: 10, w: 2, h: 2, hp: 100 },
    { kind: "shop", x: 43, y: 20, w: 3, h: 2, hp: 140 },
  ]);
}

// ---------------------------------------------------------------------------
// ANACLA / PACHENA BAY
// ---------------------------------------------------------------------------
function generateAnaclaMap(): WorldMap {
  let tiles = fill(Tile.Grass);

  // Pachena Bay opens to the ocean across the bottom (south).
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const fromBottom = MAP_HEIGHT - 1 - y;
      const shore = 9 + Math.round(3 * Math.sin(x / 6)); // wavy shoreline
      if (fromBottom < shore) tiles[idx(x, y)] = Tile.Water;
    }
  }

  // Pachena River meanders from the north down into the bay.
  for (let y = 0; y < MAP_HEIGHT - 6; y++) {
    const rx = 18 + Math.round(6 * Math.sin(y / 7));
    for (let x = rx - 1; x <= rx + 1; x++) {
      if (x >= 0 && x < MAP_WIDTH) tiles[idx(x, y)] = Tile.Water;
    }
  }

  tiles = beachify(tiles);

  // Dense forest and hills frame the bay (it's deep in Pacific Rim country).
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (tiles[idx(x, y)] !== Tile.Grass) continue;
      const distEdge = Math.min(x, MAP_WIDTH - 1 - x, y);
      if (distEdge < 3) tiles[idx(x, y)] = Tile.Hill;
      else if (distEdge < 6) tiles[idx(x, y)] = Tile.Forest;
    }
  }

  // The road in from Bamfield, arriving at the top and running to the village.
  const roadX = 40;
  for (let y = 0; y < 26; y++) {
    if (tiles[idx(roadX, y)] !== Tile.Water) tiles[idx(roadX, y)] = Tile.Road;
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles };
}

function anaclaBuildings(): BuildingState[] {
  return mkBuildings("an", [
    { kind: "house", x: 30, y: 20, w: 2, h: 2, hp: 100 }, // village along the bay
    { kind: "house", x: 34, y: 22, w: 2, h: 2, hp: 100 },
    { kind: "shop", x: 37, y: 21, w: 3, h: 2, hp: 140 }, // bus stop is here
    { kind: "house", x: 42, y: 23, w: 2, h: 2, hp: 100 },
    { kind: "boathouse", x: 26, y: 24, w: 2, h: 3, hp: 120 },
  ]);
}

// ---------------------------------------------------------------------------
// Region assembly + travel links
// ---------------------------------------------------------------------------
function mkBuildings(
  prefix: string,
  defs: Array<{
    kind: BuildingState["kind"];
    x: number;
    y: number;
    w: number;
    h: number;
    hp: number;
  }>,
): BuildingState[] {
  return defs.map((d, i) => ({
    id: `${prefix}${i}`,
    kind: d.kind,
    x: d.x,
    y: d.y,
    w: d.w,
    h: d.h,
    hp: d.hp,
    maxHp: d.hp,
  }));
}

// Shape produced by the map importer (tools/import-image-map.mjs). Drop the
// JSON into shared/regions/ and register it in buildRegions() to use real
// (OSM / traced) geography instead of the handcrafted maps below.
export interface RegionData {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: number[];
  buildings: BuildingState[];
  spawn: { x: number; y: number };
  travelNodes: TravelNode[];
}

export function regionFromData(data: RegionData): RegionDef {
  return {
    id: data.id,
    name: data.name,
    map: { width: data.width, height: data.height, tiles: data.tiles as Tile[] },
    buildings: data.buildings,
    spawn: data.spawn,
    travelNodes: data.travelNodes,
  };
}

export function buildRegions(): RegionDef[] {
  const bamfield: RegionDef = {
    id: "bamfield",
    name: "Bamfield",
    map: generateBamfieldMap(),
    buildings: bamfieldBuildings(),
    spawn: { x: 36, y: 6 },
    travelNodes: [
      {
        id: "bf-bus",
        kind: "bus",
        x: 19,
        y: 21,
        w: 2,
        h: 1,
        label: "Catch the bus at the market to Anacla",
        toRegion: "anacla",
        toSpawn: { x: 38, y: 24 },
      },
      {
        id: "bf-car",
        kind: "car",
        x: 39,
        y: 2,
        w: 2,
        h: 1,
        label: "Drive up Bamfield Main to Anacla",
        toRegion: "anacla",
        toSpawn: { x: 40, y: 1 },
      },
      {
        id: "bf-boat",
        kind: "boat",
        x: 30,
        y: 37,
        w: 3,
        h: 2,
        label: "Boat out the inlet to Pachena Bay",
        toRegion: "anacla",
        toSpawn: { x: 30, y: 33 },
      },
    ],
  };

  const anacla: RegionDef = {
    id: "anacla",
    name: "Anacla / Pachena Bay",
    map: generateAnaclaMap(),
    buildings: anaclaBuildings(),
    spawn: { x: 40, y: 1 },
    travelNodes: [
      {
        id: "an-bus",
        kind: "bus",
        x: 36,
        y: 23,
        w: 2,
        h: 1,
        label: "Catch the bus back to Bamfield",
        toRegion: "bamfield",
        toSpawn: { x: 20, y: 20 },
      },
      {
        id: "an-car",
        kind: "car",
        x: 39,
        y: 0,
        w: 2,
        h: 1,
        label: "Drive back to Bamfield",
        toRegion: "bamfield",
        toSpawn: { x: 40, y: 3 },
      },
      {
        id: "an-boat",
        kind: "boat",
        x: 28,
        y: 32,
        w: 3,
        h: 2,
        label: "Boat back to Bamfield Inlet",
        toRegion: "bamfield",
        toSpawn: { x: 30, y: 35 },
      },
    ],
  };

  return [bamfield, anacla];
}

export const DEFAULT_REGION = "bamfield";
