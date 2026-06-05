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

  // Bamfield Inlet: a narrow channel that splits the town in two — West
  // Bamfield (the boardwalk, no road) on the left bank, East Bamfield (road
  // access) on the right — and opens south into Barkley Sound / Trevor Channel.
  const center = 27;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const wig = y < 6 ? Math.round(Math.sin(y)) : 0; // wiggle only at the north end
    const c = center + wig;
    const half = y >= 30 ? 2 + (y - 29) * 2 : 2; // flare wide into the sound
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (Math.abs(x - c) <= half) tiles[idx(x, y)] = Tile.Water;
    }
  }

  // Grappler Inlet: a side-arm branching east off the main inlet to the north.
  for (let y = 7; y <= 9; y++) {
    for (let x = center; x <= 36; x++) tiles[idx(x, y)] = Tile.Water;
  }

  // Brady's Beach: the open-coast (Pacific-facing) water pocket on the far west.
  for (let y = 22; y < 31; y++) {
    for (let x = 0; x < 4; x++) tiles[idx(x, y)] = Tile.Water;
  }

  tiles = beachify(tiles);

  // Forested hills frame the town inland on both edges.
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (tiles[idx(x, y)] !== Tile.Grass) continue;
      const distToEdge = Math.min(x, MAP_WIDTH - 1 - x);
      if (distToEdge < 3) tiles[idx(x, y)] = Tile.Hill;
      else if (distToEdge < 6) tiles[idx(x, y)] = Tile.Forest;
    }
  }

  // Bamfield Main: the road into East Bamfield, ending up the hill in the south.
  const setRoad = (x: number, y: number) => {
    if (tiles[idx(x, y)] !== Tile.Water) tiles[idx(x, y)] = Tile.Road;
  };
  for (let x = 38; x <= 53; x++) setRoad(x, 3); // arriving from the northeast
  for (let y = 3; y <= 30; y++) setRoad(38, y); // south through town to the road's end

  // West Bamfield boardwalk: docks/piers reaching into the inlet.
  for (const py of [12, 16, 20, 26]) {
    for (let x = 23; x <= 25; x++) {
      const t = tiles[idx(x, py)];
      if (t === Tile.Grass || t === Tile.Sand || t === Tile.Water) tiles[idx(x, py)] = Tile.Dock;
    }
  }

  return { width: MAP_WIDTH, height: MAP_HEIGHT, tiles };
}

function bamfieldBuildings(): BuildingState[] {
  return mkBuildings("bf", [
    // West Bamfield — boardwalk houses along the west bank.
    { kind: "house", x: 20, y: 10, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 20, y: 14, w: 2, h: 2, hp: 100 },
    { kind: "boathouse", x: 20, y: 24, w: 2, h: 3, hp: 120 },
    // East Bamfield — road-side village with the market.
    { kind: "shop", x: 34, y: 13, w: 3, h: 2, hp: 140 }, // the market (bus stop)
    { kind: "house", x: 34, y: 17, w: 2, h: 2, hp: 100 },
    { kind: "house", x: 35, y: 21, w: 2, h: 2, hp: 100 },
    { kind: "boathouse", x: 32, y: 25, w: 2, h: 2, hp: 120 }, // government dock
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
    spawn: { x: 33, y: 15 }, // East Bamfield, by the market (~242 Frigate Rd)
    travelNodes: [
      {
        id: "bf-bus",
        kind: "bus",
        x: 33,
        y: 15,
        w: 2,
        h: 1,
        label: "Catch the bus at the market to Anacla",
        toRegion: "anacla",
        toSpawn: { x: 37, y: 22 },
      },
      {
        id: "bf-car",
        kind: "car",
        x: 38,
        y: 29,
        w: 1,
        h: 1,
        label: "Drive up Bamfield Main to Anacla",
        toRegion: "anacla",
        toSpawn: { x: 40, y: 1 },
      },
      {
        id: "bf-boat",
        kind: "boat",
        x: 22,
        y: 26,
        w: 2,
        h: 1,
        label: "Boat out the inlet to Pachena Bay",
        toRegion: "anacla",
        toSpawn: { x: 30, y: 30 },
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
