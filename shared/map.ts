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
  const fromWater = bfs(isWater);
  const fromLand = bfs((i) => !isWater(i));
  const elev = new Array(w * h).fill(0);
  for (let i = 0; i < w * h; i++) {
    if (isWater(i)) {
      const wd = fromLand[i] <= 0 ? 1 : fromLand[i];
      elev[i] = SHORE_ELEV - wd * BEACH_SLOPE;
    } else {
      const ld = fromWater[i] < 0 ? 20 : fromWater[i];
      const t = tiles[i];
      // Sand beaches rise very gently, so a wide flat (e.g. Pachena Beach) stays
      // inside the intertidal band for many tiles and the tide sweeps far across
      // it. Other terrain climbs faster and stays dry.
      const slope = t === Tile.Sand ? 0.75 : BEACH_SLOPE;
      let e = SHORE_ELEV + ld * slope;
      if (t === Tile.Hill) e += 34;
      else if (t === Tile.Rock) e += 50;
      else if (t === Tile.Forest) e += 8;
      else if (t === Tile.Dock) e -= 4;
      elev[i] = Math.min(100, e);
    }
  }
  return elev;
}

// ---------------------------------------------------------------------------
// Map dimensions — much larger for realistic scale
// ---------------------------------------------------------------------------
export const MAP_WIDTH  = 200;
export const MAP_HEIGHT = 120;

export interface RegionDef {
  id: string;
  name: string;
  map: WorldMap;
  buildings: BuildingState[];
  spawn: { x: number; y: number };
  travelNodes: TravelNode[];
  vehicles: VehicleSpawn[];
  resourceNodes: ResourceNodeDef[];
  plants: PlantDef[];
}

function fill(tile: Tile): Tile[] {
  return new Array(MAP_WIDTH * MAP_HEIGHT).fill(tile);
}

function worldMap(tiles: Tile[]): WorldMap {
  return {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    tiles,
    elevation: computeElevation(tiles, MAP_WIDTH, MAP_HEIGHT),
  };
}

// Turn grass tiles adjacent to water into sand beach.
function beachify(tiles: Tile[], w = MAP_WIDTH, h = MAP_HEIGHT) {
  const out = tiles.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tiles[y * w + x] !== Tile.Water) continue;
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (out[ny * w + nx] === Tile.Grass) out[ny * w + nx] = Tile.Sand;
      }
    }
  }
  return out;
}

function setTile(tiles: Tile[], x: number, y: number, t: Tile, w = MAP_WIDTH, h = MAP_HEIGHT) {
  if (x >= 0 && y >= 0 && x < w && y < h) tiles[y * w + x] = t;
}

function hLine(tiles: Tile[], x0: number, x1: number, y: number, t: Tile) {
  for (let x = Math.min(x0,x1); x <= Math.max(x0,x1); x++) setTile(tiles, x, y, t);
}
function vLine(tiles: Tile[], x: number, y0: number, y1: number, t: Tile) {
  for (let y = Math.min(y0,y1); y <= Math.max(y0,y1); y++) setTile(tiles, x, y, t);
}
function rect(tiles: Tile[], x0: number, y0: number, x1: number, y1: number, t: Tile) {
  for (let y = Math.min(y0,y1); y <= Math.max(y0,y1); y++)
    for (let x = Math.min(x0,x1); x <= Math.max(x0,x1); x++)
      setTile(tiles, x, y, t);
}

// BFS distance (in tiles) from every cell to the nearest Water tile.
function distanceToWater(tiles: Tile[], w = MAP_WIDTH, h = MAP_HEIGHT): Int32Array {
  const d = new Int32Array(w * h).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < w * h; i++) if (tiles[i] === Tile.Water) { d[i] = 0; q.push(i); }
  for (let head = 0; head < q.length; head++) {
    const i = q[head], x = i % w, y = (i / w) | 0;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (d[ni] === -1) { d[ni] = d[i] + 1; q.push(ni); }
    }
  }
  return d;
}

// Natural coastal landcover: a grassy inhabited band hugs the shore, dense
// rainforest fills the interior, and steep hills ring the map edges. This
// replaces hand-tuned checkerboard fills with something that reads as real
// terrain. Only paints over Grass — water/roads/docks are left untouched.
function applyLandcover(tiles: Tile[], w = MAP_WIDTH, h = MAP_HEIGHT) {
  const dw = distanceToWater(tiles, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tiles[i] !== Tile.Grass) continue;
      const edge = Math.min(x, w - 1 - x, y, h - 1 - y);
      const d = dw[i] < 0 ? 9999 : dw[i];
      if (edge < 3) {
        tiles[i] = Tile.Hill;            // steep rim at the very edge
      } else if (edge < 8 && d > 10) {
        tiles[i] = Tile.Forest;          // forested slope behind the rim
      } else if (d <= 11) {
        tiles[i] = Tile.Grass;           // inhabited shore band (town)
      } else {
        // Interior: forest, with the occasional rocky knoll deep inland.
        tiles[i] = d > 26 && edge > 16 ? Tile.Hill : Tile.Forest;
      }
    }
  }
}

// Carve a cleared (grassy) margin around every road so it reads as a road
// through the trees rather than a line buried in forest.
function clearRoadMargins(tiles: Tile[], radius = 2, w = MAP_WIDTH, h = MAP_HEIGHT) {
  const roads: number[] = [];
  for (let i = 0; i < w * h; i++) if (tiles[i] === Tile.Road) roads.push(i);
  for (const i of roads) {
    const x = i % w, y = (i / w) | 0;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (tiles[ni] === Tile.Forest || tiles[ni] === Tile.Hill) tiles[ni] = Tile.Grass;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BAMFIELD  (200 × 120 tiles)
//
// Real geography key facts:
//   • Bamfield Inlet runs N→S, ~8 tiles wide at the narrows, widening south.
//   • West Bamfield on the WEST bank (boardwalk, no road), ~x 80-90.
//   • East Bamfield on the EAST bank (Bamfield Main road), ~x 100-115.
//   • Grappler Inlet branches EAST from the main inlet at roughly y=30-40,
//     and is where the Bamfield Marine Sciences Centre (BMSC) sits on the
//     west side / south shore of Grappler Inlet.
//   • Government wharf (car ferry) is in the main inlet, east side, y≈45.
//   • Brady's Beach: open Pacific-facing beach, far west side of the map.
//   • Barkley Sound / Trevor Channel opens to the south of the inlet mouth.
//   • Dense rainforest covers the hills on both sides.
// ---------------------------------------------------------------------------
function generateBamfieldMap(): WorldMap {
  const W = MAP_WIDTH, H = MAP_HEIGHT;
  const tiles: Tile[] = fill(Tile.Grass);

  // --- BAMFIELD INLET (main N-S channel) ---
  // Center of inlet at x≈92. Width narrows from 10 at the north mouth to 14 at
  // the south as it opens into Trevor Channel.
  const INLET_CX = 92;
  for (let y = 0; y < H; y++) {
    // Inlet tapers: narrower at top (narrows), wider toward Barkley Sound.
    const halfW = y < 20  ? 5 :
                  y < 50  ? 6 + Math.round((y-20)*0.1) :
                  y < 80  ? 9 + Math.round((y-50)*0.15) :
                             14 + Math.round((y-80)*0.3);
    const wig = Math.round(Math.sin(y * 0.18) * 2); // gentle meander
    const cx = INLET_CX + wig;
    rect(tiles, cx - halfW, y, cx + halfW, y, Tile.Water);
  }

  // --- GRAPPLER INLET (branches east from main inlet at y≈30-45) ---
  // Runs from the main inlet eastward, about 4-5 tiles wide, to ~x=140.
  // The BMSC sits on its south shore.
  for (let x = INLET_CX - 5; x <= 145; x++) {
    const w2 = x < 110 ? 4 : 3; // slightly narrower toward the end
    const cy = 37 + Math.round(Math.sin((x - INLET_CX) * 0.08) * 2);
    rect(tiles, x, cy - w2, x, cy + w2, Tile.Water);
  }

  // --- BARKLEY SOUND / TREVOR CHANNEL (open ocean, south) ---
  // Starts below y=95, full width open water for boating and fishing.
  rect(tiles, 10, 95, W - 10, H - 1, Tile.Water);

  // --- BRADY'S BEACH (Pacific-facing beach, west side) ---
  // A pocket of water on the far west edge, y=55-90.
  rect(tiles, 0, 55, 8, 90, Tile.Water);
  rect(tiles, 0, 90, 20, 95, Tile.Water); // connects to Trevor Channel

  // --- NATURAL LANDCOVER: grassy shore band, rainforest interior, hill rim ---
  applyLandcover(tiles, W, H);

  // --- ROADS ---
  // Bamfield Main (East Bamfield): runs south from the junction at y=5 down
  // to the road-end at y=88. Roughly at x=110.
  const ROAD_X = 110;
  // Incoming from the NE across the hill (ferry/bus terminal area):
  for (let x = ROAD_X; x <= W - 15; x++) setTile(tiles, x, 5, Tile.Road);
  // South along the east bank:
  vLine(tiles, ROAD_X, 5, 88, Tile.Road);
  // Short side-streets to the government wharf:
  hLine(tiles, ROAD_X, ROAD_X + 8, 46, Tile.Road);
  // Side road to the campground area:
  hLine(tiles, ROAD_X, ROAD_X - 10, 72, Tile.Road);

  // Clear a grassy margin so the road runs through the trees, not under them.
  clearRoadMargins(tiles, 2, W, H);

  // --- DOCKS & PIERS ---
  // West Bamfield boardwalk docks (fingerpiers into the inlet, west bank):
  for (const [px, py] of [[83,20],[83,28],[83,36],[82,48],[82,56],[82,66]] as [number,number][]) {
    hLine(tiles, px, px+5, py, Tile.Dock);
  }
  // Government wharf (east bank, car ferry terminal):
  hLine(tiles, ROAD_X + 2, ROAD_X + 10, 46, Tile.Dock);
  hLine(tiles, ROAD_X + 2, ROAD_X + 10, 47, Tile.Dock);
  // BMSC dock (Grappler Inlet, south shore):
  hLine(tiles, 115, 125, 44, Tile.Dock);
  hLine(tiles, 115, 125, 45, Tile.Dock);
  // Small float plane dock (south of BMSC):
  hLine(tiles, 118, 124, 48, Tile.Dock);

  // --- BEACH STRIP (shore-side sand where Brady's Beach meets the land) ---
  // Already handled by beachify(), but add a wider sandy flat at Brady's Beach.
  rect(tiles, 9, 56, 18, 88, Tile.Sand);

  return worldMap(beachify(tiles));
}

function bamfieldBuildings(): BuildingState[] {
  return mkBuildings("bf", [
    // ---- WEST BAMFIELD (boardwalk) ----
    // Houses along the inlet bank, accessed by boardwalk only.
    { kind:"house",     x:80, y:18, w:3, h:2, hp:100 },
    { kind:"house",     x:80, y:24, w:3, h:2, hp:100 },
    { kind:"house",     x:79, y:30, w:3, h:2, hp:100 },
    { kind:"house",     x:80, y:38, w:2, h:2, hp:100 },
    { kind:"boathouse", x:81, y:44, w:3, h:3, hp:120 },
    { kind:"house",     x:80, y:52, w:3, h:2, hp:100 },
    { kind:"house",     x:80, y:60, w:3, h:2, hp:100 },
    { kind:"house",     x:79, y:68, w:3, h:2, hp:100 },

    // ---- BAMFIELD MARINE SCIENCES CENTRE (BMSC) ----
    // On the south shore of Grappler Inlet, west side ~x=112-130.
    { kind:"shop",      x:112, y:42, w:6, h:4, hp:200 }, // main research building
    { kind:"house",     x:120, y:42, w:4, h:3, hp:140 }, // accommodation
    { kind:"house",     x:126, y:42, w:4, h:3, hp:140 },
    { kind:"boathouse", x:132, y:41, w:4, h:3, hp:120 }, // boat shed / research boats

    // ---- EAST BAMFIELD (road side) ----
    // Market / general store (bus stop is here):
    { kind:"shop",      x:106, y:52, w:4, h:3, hp:160 },
    // Houses along Bamfield Main:
    { kind:"house",     x:106, y:20, w:3, h:2, hp:100 },
    { kind:"house",     x:106, y:28, w:3, h:2, hp:100 },
    { kind:"house",     x:106, y:34, w:3, h:2, hp:100 },
    { kind:"house",     x:106, y:58, w:3, h:2, hp:100 },
    { kind:"house",     x:106, y:64, w:3, h:2, hp:100 },
    { kind:"house",     x:106, y:70, w:3, h:2, hp:100 },
    { kind:"house",     x:107, y:76, w:3, h:2, hp:100 },
    { kind:"house",     x:107, y:82, w:3, h:2, hp:100 },
    // Government wharf building (ferry terminal):
    { kind:"dock",      x:113, y:44, w:4, h:3, hp:180 },
    // Boathouse near the road's end:
    { kind:"boathouse", x:104, y:86, w:4, h:3, hp:120 },
  ]);
}

// ---------------------------------------------------------------------------
// ANACLA / PACHENA BAY  (200 × 120 tiles)
//
// Real geography key facts:
//   • Pachena Bay: wide open crescent-shaped bay facing southwest.
//     Pachena Beach is a long (~3km) flat sandy beach — very wide tidal flat.
//   • The bay is shallow and sandy; the deep ocean is only at the bay mouth.
//   • Anacla village sits on the north/east side of the bay.
//   • Pachena River enters from the north into the NE corner of the bay.
//   • Bamfield Main road arrives from the north (connects to Bamfield).
//   • Pachena Bay campground is near the beach in the south.
// ---------------------------------------------------------------------------
function generateAnaclaMap(): WorldMap {
  const W = MAP_WIDTH, H = MAP_HEIGHT;
  const tiles: Tile[] = fill(Tile.Grass);

  // --- PACHENA BAY (wide navigable bay, ringed by a huge sandy flat) ---
  // An on-map ellipse of water reaching up to ~y=80 in the centre, so there's
  // real water to boat and fish in, with the open ocean across the very bottom.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const bx = (x - 100) / 78;
      const by = (y - 112) / 34;
      if (bx * bx + by * by < 1.0) tiles[y * W + x] = Tile.Water; // the bay
      if (y >= 112) tiles[y * W + x] = Tile.Water;                // open ocean
    }
  }

  // --- PACHENA RIVER (meanders from north into the bay) ---
  // Enters at the NE corner of the bay, around x=145-155.
  for (let y = 0; y < 80; y++) {
    const rx = 148 + Math.round(8 * Math.sin(y * 0.12));
    for (let x = rx - 2; x <= rx + 2; x++) {
      if (x >= 0 && x < W) tiles[y * W + x] = Tile.Water;
    }
  }

  // --- BARKLEY SOUND (open west side of map — boat access from Bamfield) ---
  rect(tiles, 0, 70, 15, H-1, Tile.Water);

  // --- NATURAL LANDCOVER: rainforest + hills frame the bay ---
  applyLandcover(tiles, W, H);

  // --- WIDE SANDY FLAT (Pachena Beach) ---
  // Pachena is a long, flat, sandy beach — the tidal flat is huge. Carve a wide
  // sand band around the whole bay shore (over grass AND the forest fringe), so
  // the tide sweeps far in and out across it.
  const dwBay = distanceToWater(tiles, W, H);
  for (let y = 56; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if ((t === Tile.Grass || t === Tile.Forest) && dwBay[i] > 0 && dwBay[i] <= 16) {
        tiles[i] = Tile.Sand;
      }
    }
  }

  // --- ROAD (Bamfield Main arriving from north) ---
  // Road comes in from the north at around x=130, bends west to the village.
  const roadEntryX = 130;
  vLine(tiles, roadEntryX, 0, 55, Tile.Road);
  // Bends west through the village:
  for (let x = roadEntryX; x >= 80; x--) setTile(tiles, x, 55, Tile.Road);
  // Then south to the campground area:
  vLine(tiles, 80, 55, 75, Tile.Road);
  clearRoadMargins(tiles, 2, W, H);

  return worldMap(beachify(tiles));
}

function anaclaBuildings(): BuildingState[] {
  return mkBuildings("an", [
    // ---- ANACLA VILLAGE (along the road) ----
    { kind:"house",     x:122, y:30, w:3, h:2, hp:100 },
    { kind:"house",     x:118, y:38, w:3, h:2, hp:100 },
    { kind:"house",     x:122, y:44, w:3, h:2, hp:100 },
    { kind:"house",     x:115, y:50, w:3, h:2, hp:100 },
    { kind:"shop",      x:108, y:52, w:4, h:3, hp:150 }, // village store / bus stop
    { kind:"house",     x:102, y:52, w:3, h:2, hp:100 },
    { kind:"house",     x: 96, y:54, w:3, h:2, hp:100 },
    { kind:"house",     x: 90, y:55, w:3, h:2, hp:100 },
    // ---- BEACH CAMPGROUND ----
    { kind:"house",     x: 82, y:64, w:3, h:2, hp: 80 }, // camp shelter
    { kind:"house",     x: 88, y:64, w:3, h:2, hp: 80 },
    { kind:"boathouse", x: 76, y:66, w:4, h:3, hp:120 }, // boat launch
  ]);
}

// ---------------------------------------------------------------------------
// Region assembly helpers
// ---------------------------------------------------------------------------
function mkBuildings(
  prefix: string,
  defs: Array<{ kind: BuildingState["kind"]; x: number; y: number; w: number; h: number; hp: number }>,
): BuildingState[] {
  return defs.map((d, i) => ({
    id: `${prefix}${i}`,
    kind: d.kind, x: d.x, y: d.y, w: d.w, h: d.h, hp: d.hp, maxHp: d.hp,
  }));
}

// Shape produced by the OSM importer (tools/import-osm.mjs).
export interface RegionData {
  id: string;
  name: string;
  width: number;
  height: number;
  tiles: number[];
  elevation?: number[];
  buildings: BuildingState[];
  spawn: { x: number; y: number };
  travelNodes: TravelNode[];
  vehicles?: VehicleSpawn[];
  resourceNodes?: ResourceNodeDef[];
  plants?: PlantDef[];
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

// ---------------------------------------------------------------------------
// Real-geography overlay (from tools/import-osm.mjs)
// ---------------------------------------------------------------------------
function applyImported(handcrafted: RegionDef[]): RegionDef[] {
  if (!IMPORTED_REGIONS.length) return handcrafted;
  const byId = new Map(handcrafted.map((r) => [r.id, r]));
  for (const data of IMPORTED_REGIONS) {
    const imported = regionFromData(data);
    const base = byId.get(data.id);
    byId.set(data.id, {
      ...imported,
      vehicles:      imported.vehicles.length      ? imported.vehicles      : base?.vehicles      ?? [],
      resourceNodes: imported.resourceNodes.length ? imported.resourceNodes : base?.resourceNodes ?? [],
      plants:        imported.plants.length        ? imported.plants        : base?.plants        ?? [],
      travelNodes: [],
    });
  }
  const regions = [...byId.values()];
  for (const r of regions) {
    const data = IMPORTED_REGIONS.find((d) => d.id === r.id);
    if (data && data.travelNodes.length) { r.travelNodes = data.travelNodes; continue; }
    const other = regions.find((o) => o.id !== r.id);
    if (other) r.travelNodes = deriveTravelNodes(r, other);
  }
  return regions;
}

function nearestWalkable(map: WorldMap, tx: number, ty: number): { x: number; y: number } {
  const { width: w, height: h, tiles } = map;
  for (let r = 0; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = tx + dx, y = ty + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (tiles[y * w + x] !== Tile.Water) return { x, y };
    }
  }
  return { x: Math.floor(w / 2), y: Math.floor(h / 2) };
}

function openWaterAnchor(map: WorldMap): { x: number; y: number } {
  const { width: w, height: h, tiles } = map;
  for (let y = h - 1; y >= 0; y--)
    for (let x = Math.floor(w / 2); x >= 0; x--)
      if (tiles[y * w + x] === Tile.Water) return { x, y: Math.max(0, y - 1) };
  return { x: Math.floor(w / 2), y: h - 2 };
}

function southernWaterBand(map: WorldMap): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h, tiles } = map;
  const bottom = h - 1;
  let minX = w, maxX = -1;
  for (let x = 0; x < w; x++)
    if (tiles[bottom * w + x] === Tile.Water) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  if (maxX < 0) return null;
  return { x: minX, y: Math.max(0, h - 3), w: maxX - minX + 1, h: 3 };
}

function deriveTravelNodes(from: RegionDef, to: RegionDef): TravelNode[] {
  const map = from.map;
  const { width: w, height: h, tiles } = map;
  const nodes: TravelNode[] = [];
  const footTo = nearestWalkable(to.map, to.spawn.x, to.spawn.y);
  const seaTo  = openWaterAnchor(to.map);

  nodes.push({ id:`${from.id}-bus`, kind:"bus", x:from.spawn.x, y:from.spawn.y, w:2, h:1,
    label:`Catch the bus to ${to.name}`, toRegion:to.id, toSpawn:footTo });

  let gate: {x:number;y:number}|null = null;
  for (let y = 0; y < h && !gate; y++)
    for (let x = 0; x < w; x++)
      if (tiles[y*w+x] === Tile.Road) { gate = {x,y}; break; }
  if (gate) nodes.push({ id:`${from.id}-gate`, kind:"gate", x:gate.x, y:gate.y, w:1, h:1,
    label:`Hike the road to ${to.name}`, toRegion:to.id, toSpawn:footTo });

  const band = southernWaterBand(map);
  if (band) nodes.push({ id:`${from.id}-sea`, kind:"sea", x:band.x, y:band.y, w:band.w, h:band.h,
    label:`Sail the open water round to ${to.name}`, toRegion:to.id, toSpawn:seaTo });

  return nodes;
}

// ---------------------------------------------------------------------------
// Region definitions
// ---------------------------------------------------------------------------
export function buildRegions(): RegionDef[] {
  const bamfield: RegionDef = {
    id: "bamfield",
    name: "Bamfield",
    map: generateBamfieldMap(),
    buildings: bamfieldBuildings(),
    spawn: { x: 108, y: 55 }, // East Bamfield, by the market
    travelNodes: [
      {
        id: "bf-bus", kind: "bus",
        x: 107, y: 55, w: 3, h: 1,
        label: "Catch the bus at the market to Anacla",
        toRegion: "anacla", toSpawn: { x: 108, y: 54 },
      },
      {
        id: "bf-gate", kind: "gate",
        x: 110, y: 5, w: 2, h: 1,
        label: "Drive the road out to Anacla",
        toRegion: "anacla", toSpawn: { x: 130, y: 5 },
      },
      {
        id: "bf-sea", kind: "sea",
        x: 20, y: 110, w: 140, h: 8,
        label: "Sail south out of the inlet to Pachena Bay",
        toRegion: "anacla", toSpawn: { x: 30, y: 100 },
      },
    ],
    vehicles: [
      { id: "bf-car-1",  kind: "car",  x: 112, y: 10  }, // on Bamfield Main
      { id: "bf-car-2",  kind: "car",  x: 112, y: 60  }, // mid-road
      { id: "bf-boat-1", kind: "boat", x:  88, y: 50  }, // inlet, west bank
      { id: "bf-boat-2", kind: "boat", x:  97, y: 46  }, // government wharf
      { id: "bf-boat-3", kind: "boat", x: 120, y: 38  }, // Grappler Inlet, by BMSC
    ],
    resourceNodes: [
      // Trees in the forested hills (both sides)
      { id:"bf-t1",  kind:"tree",      x: 15, y: 20 },
      { id:"bf-t2",  kind:"tree",      x: 12, y: 35 },
      { id:"bf-t3",  kind:"tree",      x: 14, y: 55 },
      { id:"bf-t4",  kind:"tree",      x: 16, y: 70 },
      { id:"bf-t5",  kind:"tree",      x: 18, y: 85 },
      { id:"bf-t6",  kind:"tree",      x:130, y: 10 },
      { id:"bf-t7",  kind:"tree",      x:135, y: 25 },
      { id:"bf-t8",  kind:"tree",      x:138, y: 55 },
      { id:"bf-t9",  kind:"tree",      x:132, y: 72 },
      { id:"bf-t10", kind:"tree",      x:136, y: 85 },
      // Ore in the rocky hillsides
      { id:"bf-i1",  kind:"ironOre",   x:  6, y: 30 },
      { id:"bf-i2",  kind:"ironOre",   x:  7, y: 65 },
      { id:"bf-s1",  kind:"stoneOre",  x:185, y: 20 },
      { id:"bf-s2",  kind:"stoneOre",  x:188, y: 50 },
      // Native berries along forest edges
      { id:"bf-b1",  kind:"berryBush", x: 22, y: 18, variety:"huckleberry" },
      { id:"bf-b2",  kind:"berryBush", x: 20, y: 42, variety:"salmonberry" },
      { id:"bf-b3",  kind:"berryBush", x: 24, y: 68, variety:"salal" },
      { id:"bf-b4",  kind:"berryBush", x:128, y: 15, variety:"thimbleberry" },
      { id:"bf-b5",  kind:"berryBush", x:126, y: 60, variety:"trailing blackberry" },
      { id:"bf-b6",  kind:"berryBush", x: 18, y: 82, variety:"huckleberry" },
    ],
    plants: [
      { id:"bf-inv1", kind:"scotchBroom",         x:120, y: 12 },
      { id:"bf-inv2", kind:"himalayanBlackberry",  x: 25, y: 75 },
      { id:"bf-inv3", kind:"foxglove",             x:125, y: 65 },
      { id:"bf-inv4", kind:"scotchBroom",          x:108, y: 85 },
    ],
  };

  const anacla: RegionDef = {
    id: "anacla",
    name: "Anacla / Pachena Bay",
    map: generateAnaclaMap(),
    buildings: anaclaBuildings(),
    spawn: { x: 130, y: 5 }, // arriving from the north road
    travelNodes: [
      {
        id: "an-bus", kind: "bus",
        x: 100, y: 54, w: 3, h: 1,
        label: "Catch the bus back to Bamfield",
        toRegion: "bamfield", toSpawn: { x: 108, y: 55 },
      },
      {
        id: "an-gate", kind: "gate",
        x: 130, y: 0, w: 2, h: 1,
        label: "Drive the road back to Bamfield",
        toRegion: "bamfield", toSpawn: { x: 110, y: 8 },
      },
      {
        id: "an-sea", kind: "sea",
        x: 0, y: 105, w: 25, h: 12,
        label: "Sail north out of Pachena Bay round to Bamfield Inlet",
        toRegion: "bamfield", toSpawn: { x: 30, y: 100 },
      },
    ],
    vehicles: [
      { id:"an-car-1",  kind:"car",  x:130, y: 20 }, // on the village road
      { id:"an-car-2",  kind:"car",  x: 95, y: 55 }, // near the store
      { id:"an-boat-1", kind:"boat", x: 95, y: 100 }, // Pachena Bay
      { id:"an-boat-2", kind:"boat", x:115, y: 103 }, // bay, deeper water
    ],
    resourceNodes: [
      { id:"an-t1",  kind:"tree",      x: 20, y: 15 },
      { id:"an-t2",  kind:"tree",      x: 18, y: 30 },
      { id:"an-t3",  kind:"tree",      x: 22, y: 45 },
      { id:"an-t4",  kind:"tree",      x:165, y: 10 },
      { id:"an-t5",  kind:"tree",      x:168, y: 28 },
      { id:"an-t6",  kind:"tree",      x:162, y: 48 },
      { id:"an-i1",  kind:"ironOre",   x:  8, y: 25 },
      { id:"an-s1",  kind:"stoneOre",  x:  7, y: 40 },
      { id:"an-s2",  kind:"stoneOre",  x:185, y: 18 },
      { id:"an-b1",  kind:"berryBush", x: 28, y: 20, variety:"salmonberry" },
      { id:"an-b2",  kind:"berryBush", x:158, y: 20, variety:"huckleberry" },
      { id:"an-b3",  kind:"berryBush", x: 24, y: 48, variety:"thimbleberry" },
      { id:"an-b4",  kind:"berryBush", x:155, y: 45, variety:"salal" },
      // Campground berry patch:
      { id:"an-b5",  kind:"berryBush", x: 86, y: 62, variety:"trailing blackberry" },
    ],
    plants: [
      { id:"an-inv1", kind:"scotchBroom",         x:138, y: 18 },
      { id:"an-inv2", kind:"foxglove",             x: 28, y: 38 },
      { id:"an-inv3", kind:"himalayanBlackberry",  x:120, y: 58 },
    ],
  };

  return applyImported([bamfield, anacla]);
}

export const DEFAULT_REGION = "bamfield";
