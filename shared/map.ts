import { BuildingState, InvasiveKind, ResourceKind, Tile, TravelNode, VehicleKind, WorldMap } from "./protocol";
import { IMPORTED_REGIONS } from "./regions";

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

  // Bamfield Inlet: a WIDE channel that splits the town in two — West Bamfield
  // (the boardwalk, no road) on the left bank, East Bamfield (road access) on
  // the right. It's a real crossing: you swim a while or take a boat. It opens
  // south into Barkley Sound / Trevor Channel (open ocean to boat & fish).
  const center = 26;
  for (let y = 0; y < MAP_HEIGHT; y++) {
    const wig = y < 6 ? Math.round(Math.sin(y)) : 0; // wiggle only at the north end
    const c = center + wig;
    const half = y >= 26 ? 5 + (y - 25) * 1.4 : 5; // ~11 tiles wide, flaring south
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (Math.abs(x - c) <= half) tiles[idx(x, y)] = Tile.Water;
    }
  }

  // Barkley Sound: open ocean across the south end — room to boat around and
  // fish, and the sea route out to Anacla / Pachena Bay.
  for (let y = 33; y < MAP_HEIGHT; y++) {
    for (let x = 3; x < MAP_WIDTH - 3; x++) tiles[idx(x, y)] = Tile.Water;
  }

  // Grappler Inlet: a side-arm branching east off the main inlet to the north.
  for (let y = 6; y <= 9; y++) {
    for (let x = center; x <= 38; x++) tiles[idx(x, y)] = Tile.Water;
  }

  // Brady's Beach: the open-coast (Pacific-facing) water pocket on the far west.
  for (let y = 20; y < 31; y++) {
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
      {
        id: "bf-sea",
        kind: "sea",
        x: 14,
        y: 37,
        w: 26,
        h: 3,
        label: "Sail out the mouth of the inlet to Pachena Bay",
        toRegion: "anacla",
        toSpawn: { x: 30, y: 35 }, // arrive on the water in Pachena Bay
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
      {
        id: "an-sea",
        kind: "sea",
        x: 12,
        y: 37,
        w: 30,
        h: 3,
        label: "Sail out of Pachena Bay round to Bamfield Inlet",
        toRegion: "bamfield",
        toSpawn: { x: 26, y: 35 }, // arrive on the water in Barkley Sound
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

  return applyImported([bamfield, anacla]);
}

// ---------------------------------------------------------------------------
// Real-geography overlay (OSM + terrain DEM)
// ---------------------------------------------------------------------------
// If the importer has produced region JSON (listed in ./regions), use it in
// place of the handcrafted version of that region. The imported map can be a
// very different SIZE, so we re-derive the cross-region travel links from the
// new geometry instead of trusting the handcrafted coordinates.
function applyImported(handcrafted: RegionDef[]): RegionDef[] {
  if (!IMPORTED_REGIONS.length) return handcrafted;

  const byId = new Map(handcrafted.map((r) => [r.id, r]));
  for (const data of IMPORTED_REGIONS) {
    const imported = regionFromData(data);
    const base = byId.get(data.id);
    byId.set(data.id, {
      ...imported,
      // The importer auto-generates these from the tile grid; if it left any
      // empty, fall back to the handcrafted placements for that region.
      vehicles: imported.vehicles.length ? imported.vehicles : base?.vehicles ?? [],
      resourceNodes: imported.resourceNodes.length
        ? imported.resourceNodes
        : base?.resourceNodes ?? [],
      plants: imported.plants.length ? imported.plants : base?.plants ?? [],
      travelNodes: [], // filled in below once every region's geometry is known
    });
  }

  const regions = [...byId.values()];
  // Second pass: now that all regions exist, link each to the "other" one.
  for (const r of regions) {
    const data = IMPORTED_REGIONS.find((d) => d.id === r.id);
    if (data && data.travelNodes.length) {
      r.travelNodes = data.travelNodes; // importer/author supplied explicit links
      continue;
    }
    const other = regions.find((o) => o.id !== r.id);
    if (other) r.travelNodes = deriveTravelNodes(r, other);
  }
  return regions;
}

// Find a walkable (dry, non-water) tile nearest to a target, spiralling out.
function nearestWalkable(map: WorldMap, tx: number, ty: number): { x: number; y: number } {
  const { width: w, height: h, tiles } = map;
  for (let r = 0; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = tx + dx;
        const y = ty + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (tiles[y * w + x] !== Tile.Water) return { x, y };
      }
    }
  }
  return { x: Math.floor(w / 2), y: Math.floor(h / 2) };
}

// Build bus / gate / sea links from one region's geometry to another. The sea
// node spans the region's southern open-water edge (boat across); the gate sits
// at the northernmost road tile (hike out); the bus waits at the spawn (market).
function deriveTravelNodes(from: RegionDef, to: RegionDef): TravelNode[] {
  const map = from.map;
  const { width: w, height: h, tiles } = map;
  const nodes: TravelNode[] = [];

  // Destination foot arrival: a dry tile near the other region's spawn.
  const footTo = nearestWalkable(to.map, to.spawn.x, to.spawn.y);
  // Destination boat arrival: open water near the other region's southern edge.
  const seaTo = openWaterAnchor(to.map);

  // Bus at this region's spawn.
  nodes.push({
    id: `${from.id}-bus`,
    kind: "bus",
    x: from.spawn.x,
    y: from.spawn.y,
    w: 2,
    h: 1,
    label: `Catch the bus to ${to.name}`,
    toRegion: to.id,
    toSpawn: footTo,
  });

  // Gate at the northernmost stretch of road.
  let gate: { x: number; y: number } | null = null;
  for (let y = 0; y < h && !gate; y++) {
    for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] === Tile.Road) { gate = { x, y }; break; }
    }
  }
  if (gate) {
    nodes.push({
      id: `${from.id}-gate`,
      kind: "gate",
      x: gate.x,
      y: gate.y,
      w: 1,
      h: 1,
      label: `Hike the road to ${to.name}`,
      toRegion: to.id,
      toSpawn: footTo,
    });
  }

  // Sea node spanning the southern open-water band (drive a boat across).
  const band = southernWaterBand(map);
  if (band) {
    nodes.push({
      id: `${from.id}-sea`,
      kind: "sea",
      x: band.x,
      y: band.y,
      w: band.w,
      h: band.h,
      label: `Sail the open water round to ${to.name}`,
      toRegion: to.id,
      toSpawn: seaTo,
    });
  }
  return nodes;
}

// A patch of open water near a region's southern edge (where boats arrive).
function openWaterAnchor(map: WorldMap): { x: number; y: number } {
  const { width: w, height: h, tiles } = map;
  for (let y = h - 1; y >= 0; y--) {
    for (let x = Math.floor(w / 2); x >= 0; x--) {
      if (tiles[y * w + x] === Tile.Water) return { x, y: Math.max(0, y - 1) };
    }
  }
  return { x: Math.floor(w / 2), y: h - 2 };
}

// The contiguous water band along the southern edge, as a travel rectangle.
function southernWaterBand(map: WorldMap): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h, tiles } = map;
  const bottom = h - 1;
  let minX = w, maxX = -1;
  for (let x = 0; x < w; x++) {
    if (tiles[bottom * w + x] === Tile.Water) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  if (maxX < 0) return null;
  return { x: minX, y: Math.max(0, h - 3), w: maxX - minX + 1, h: 3 };
}

export const DEFAULT_REGION = "bamfield";
