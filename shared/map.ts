import { BuildingState, InvasiveKind, ResourceKind, Tile, TravelNode, VehicleKind, WorldMap } from "./protocol";

// Where a driveable vehicle starts life in a region.
export interface VehicleSpawn {
  id: string;
  kind: VehicleKind;
  x: number;
  y: number;
}

// Static placement of a harvestable resource node.
export interface ResourceNodeDef {
  id: string;
  kind: ResourceKind;
  x: number;
  y: number;
  variety?: string; // berry kind, for berryBush nodes
}

// Static placement of a starting invasive plant.
export interface PlantDef {
  id: string;
  kind: InvasiveKind;
  x: number;
  y: number;
}

// Build a sloped heightmap from the tile grid so the tide sweeps gradually.
// Land rises ~SLOPE per tile away from the shore; the seabed drops the same
// going offshore. Hills/rock/forest get a bump so they stay dry at high tide.
const SHORE_ELEV = 8;
const BEACH_SLOPE = 2;
export function computeElevation(tiles: Tile[], w: number, h: number): number[] {
  const isWater = (i: number) => tiles[i] === Tile.Water;
  const bfs = (isSource: (i: number) => boolean): Int32Array => {
    const d = new Int32Array(w * h).fill(-1);
    const q: number[] = [];
    for (let i = 0; i < w * h; i++) if (isSource(i)) { d[i] = 0; q.push(i); }
    for (let head = 0; head < q.length; head++) {
      const i = q[head];
      const x = i % w;
      const y = (i / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (d[ni] === -1) { d[ni] = d[i] + 1; q.push(ni); }
      }
    }
    return d;
  };
  const fromWater = bfs(isWater); // land tiles -> distance to the sea
  const fromLand = bfs((i) => !isWater(i)); // water tiles -> distance to land
  const elev = new Array(w * h).fill(0);
  for (let i = 0; i < w * h; i++) {
    if (isWater(i)) {
      const wd = fromLand[i] <= 0 ? 1 : fromLand[i];
      elev[i] = SHORE_ELEV - wd * BEACH_SLOPE; // seabed drops offshore
    } else {
      const ld = fromWater[i] < 0 ? 20 : fromWater[i]; // no sea in map -> high & dry
      let e = SHORE_ELEV + ld * BEACH_SLOPE;
      const t = tiles[i];
      if (t === Tile.Hill) e += 34;
      else if (t === Tile.Rock) e += 50;
      else if (t === Tile.Forest) e += 8;
      else if (t === Tile.Dock) e -= 4; // docks sit low, flood first
      elev[i] = Math.min(100, e);
    }
  }
  return elev;
}

function worldMap(tiles: Tile[]): WorldMap {
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    tiles,
    elevation: computeElevation(tiles, MAP_WIDTH, MAP_HEIGHT),
  };
}

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
  vehicles: VehicleSpawn[];
  resourceNodes: ResourceNodeDef[];
  plants: PlantDef[];
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

  return worldMap(tiles);
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

  return worldMap(tiles);
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
  elevation?: number[]; // optional; derived from the tile grid if omitted
  buildings: BuildingState[];
  spawn: { x: number; y: number };
  travelNodes: TravelNode[];
  vehicles?: VehicleSpawn[]; // optional; defaults to none
  resourceNodes?: ResourceNodeDef[]; // optional; defaults to none
  plants?: PlantDef[]; // optional; defaults to none
}

export function regionFromData(data: RegionData): RegionDef {
  const tiles = data.tiles as Tile[];
  return {
    id: data.id,
    name: data.name,
    map: {
      width: data.width,
      height: data.height,
      tiles,
      elevation: data.elevation ?? computeElevation(tiles, data.width, data.height),
    },
    buildings: data.buildings,
    spawn: data.spawn,
    travelNodes: data.travelNodes,
    vehicles: data.vehicles ?? [],
    resourceNodes: data.resourceNodes ?? [],
    plants: data.plants ?? [],
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
        id: "bf-gate",
        kind: "gate",
        x: 38,
        y: 29,
        w: 1,
        h: 1,
        label: "Hike the road's end up Bamfield Main to Anacla",
        toRegion: "anacla",
        toSpawn: { x: 40, y: 1 },
      },
    ],
    vehicles: [
      { id: "bf-car-1", kind: "car", x: 38, y: 6 }, // parked on Bamfield Main
      { id: "bf-boat-1", kind: "boat", x: 27, y: 18 }, // tied up in the inlet
      { id: "bf-boat-2", kind: "boat", x: 32, y: 26 }, // at the government dock
    ],
    // Trees in the forested hills on both edges; iron+stone in the rocky hillside.
    resourceNodes: [
      { id: "bf-t1", kind: "tree",     x: 8,  y: 4  },
      { id: "bf-t2", kind: "tree",     x: 9,  y: 12 },
      { id: "bf-t3", kind: "tree",     x: 8,  y: 20 },
      { id: "bf-t4", kind: "tree",     x: 10, y: 28 },
      { id: "bf-t5", kind: "tree",     x: 49, y: 5  },
      { id: "bf-t6", kind: "tree",     x: 50, y: 14 },
      { id: "bf-t7", kind: "tree",     x: 49, y: 22 },
      { id: "bf-t8", kind: "tree",     x: 51, y: 31 },
      { id: "bf-i1", kind: "ironOre",  x: 5,  y: 8  },
      { id: "bf-i2", kind: "ironOre",  x: 5,  y: 18 },
      { id: "bf-s1", kind: "stoneOre", x: 54, y: 7  },
      { id: "bf-s2", kind: "stoneOre", x: 54, y: 19 },
      // Native berry bushes along the forest edges (free food, no fire needed).
      { id: "bf-b1", kind: "berryBush", x: 12, y: 8,  variety: "huckleberry" },
      { id: "bf-b2", kind: "berryBush", x: 11, y: 24, variety: "salmonberry" },
      { id: "bf-b3", kind: "berryBush", x: 47, y: 11, variety: "salal" },
      { id: "bf-b4", kind: "berryBush", x: 47, y: 27, variety: "thimbleberry" },
      { id: "bf-b5", kind: "berryBush", x: 13, y: 16, variety: "trailing blackberry" },
    ],
    // A couple of established invasives to deal with from day one.
    plants: [
      { id: "bf-inv1", kind: "scotchBroom",        x: 44, y: 9 },
      { id: "bf-inv2", kind: "himalayanBlackberry", x: 15, y: 30 },
      { id: "bf-inv3", kind: "foxglove",            x: 45, y: 18 },
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
        id: "an-gate",
        kind: "gate",
        x: 39,
        y: 0,
        w: 2,
        h: 1,
        label: "Hike the road back to Bamfield",
        toRegion: "bamfield",
        toSpawn: { x: 38, y: 28 },
      },
    ],
    vehicles: [
      { id: "an-car-1", kind: "car", x: 40, y: 18 }, // on the village road
      { id: "an-boat-1", kind: "boat", x: 26, y: 32 }, // on Pachena Bay
    ],
    resourceNodes: [
      { id: "an-t1", kind: "tree",     x: 7,  y: 5  },
      { id: "an-t2", kind: "tree",     x: 6,  y: 12 },
      { id: "an-t3", kind: "tree",     x: 8,  y: 18 },
      { id: "an-t4", kind: "tree",     x: 52, y: 6  },
      { id: "an-t5", kind: "tree",     x: 53, y: 14 },
      { id: "an-t6", kind: "tree",     x: 51, y: 20 },
      { id: "an-i1", kind: "ironOre",  x: 4,  y: 9  },
      { id: "an-s1", kind: "stoneOre", x: 4,  y: 3  },
      { id: "an-s2", kind: "stoneOre", x: 55, y: 10 },
      { id: "an-b1", kind: "berryBush", x: 10, y: 8,  variety: "salmonberry" },
      { id: "an-b2", kind: "berryBush", x: 49, y: 9,  variety: "huckleberry" },
      { id: "an-b3", kind: "berryBush", x: 12, y: 22, variety: "thimbleberry" },
    ],
    plants: [
      { id: "an-inv1", kind: "scotchBroom", x: 46, y: 14 },
      { id: "an-inv2", kind: "foxglove",    x: 9,  y: 16 },
    ],
  };

  return [bamfield, anacla];
}

export const DEFAULT_REGION = "bamfield";
