import { BuildingState, InvasiveKind, ResourceKind, ShopDef, Tile, TravelNode, VehicleKind, WorldMap } from "./protocol";
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
      // Sand beaches rise very gently so the tide sweeps far across the flat.
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
// Map dimensions — 300 × 180 for realistic scale
// ---------------------------------------------------------------------------
export const MAP_WIDTH  = 300;
export const MAP_HEIGHT = 180;

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

// Natural coastal landcover: grassy shore band, dense rainforest interior,
// steep hill rim. Reads as real coastal rainforest; only paints over Grass.
function applyLandcover(tiles: Tile[], w = MAP_WIDTH, h = MAP_HEIGHT) {
  const dw = distanceToWater(tiles, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (tiles[i] !== Tile.Grass) continue;
      const edge = Math.min(x, w - 1 - x, y, h - 1 - y);
      const d = dw[i] < 0 ? 9999 : dw[i];
      if (edge < 3) {
        tiles[i] = Tile.Hill;
      } else if (edge < 8 && d > 12) {
        tiles[i] = Tile.Forest;
      } else if (d <= 13) {
        tiles[i] = Tile.Grass;
      } else {
        tiles[i] = d > 30 && edge > 18 ? Tile.Hill : Tile.Forest;
      }
    }
  }
}

// Carve a grassy margin around every road so it reads as a road through trees.
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
// BAMFIELD  (300 × 180 tiles)
//
// Real geography:
//   • Bamfield Inlet: N→S channel, centre-line at x≈170. Narrows at top,
//     widens south into Trevor Channel / Barkley Sound (y ≥ 155).
//   • West Bamfield (x≈140-165): boardwalk community on the west bank.
//     No road — all access by water taxi or on foot along the boardwalk.
//     Houses crowd right to the inlet edge. McKay Bay Lodge in the middle.
//   • Brady's Beach (x≈20-70, y≈90-155): long open-Pacific sandy beach
//     on the far west side. Trail from West Bamfield runs through the forest.
//   • Grappler Inlet: branches EAST from the main inlet at y≈45-58.
//     Runs from x≈168 east to x≈268. BMSC sits on its south shore.
//   • Port Desire: small sheltered inlet on the EAST side, y≈90-110.
//   • East Bamfield (x≈178-210): road-side community. Bamfield Main runs N→S
//     at x≈185. Ostrom's Gas Bar is partway down the road. Market near y=72.
//   • Government Wharf (car ferry) at x≈188, y≈54 on the east bank.
//   • Dense rainforest on all hillsides; rocky knolls on ridge-tops.
// ---------------------------------------------------------------------------
function generateBamfieldMap(): WorldMap {
  const W = MAP_WIDTH, H = MAP_HEIGHT;
  const tiles: Tile[] = fill(Tile.Grass);

  // --- BAMFIELD INLET (main N→S channel, centre-line at x=170) ---
  const INLET_CX = 170;
  for (let y = 0; y < H; y++) {
    const halfW = y < 25  ? 6 :
                  y < 60  ? 7 + Math.round((y - 25) * 0.06) :
                  y < 110 ? 9 + Math.round((y - 60) * 0.10) :
                             14 + Math.round((y - 110) * 0.40);
    const wig = Math.round(Math.sin(y * 0.15) * 2);
    const cx = INLET_CX + wig;
    rect(tiles, cx - halfW, y, cx + halfW, y, Tile.Water);
  }

  // --- GRAPPLER INLET (branches east from main inlet at y≈45-58) ---
  // BMSC sits on the south shore; inlet runs ~100 tiles east.
  for (let x = INLET_CX - 6; x <= 268; x++) {
    const w2 = x < 210 ? 5 : 4;
    const cy = 50 + Math.round(Math.sin((x - INLET_CX) * 0.06) * 3);
    rect(tiles, x, cy - w2, x, cy + w2, Tile.Water);
  }

  // --- PORT DESIRE (small inlet east side, south of Grappler) ---
  // Sheltered bay on the east bank, roughly y=88-112, x=176-198.
  for (let y = 88; y <= 112; y++) {
    const half = 8 + Math.round(4 * Math.sin(Math.PI * (y - 88) / 24));
    const cx = 190;
    rect(tiles, cx - half, y, cx + half, y, Tile.Water);
  }

  // --- BARKLEY SOUND / TREVOR CHANNEL (open water, south) ---
  // Start at y=138 — well south of the last building (y≈123). The inlet
  // has already widened to ~50 tiles at this point, so the channel
  // transitions naturally into open sound. Depth in the centre reaches
  // the DEPTH_OCEAN (abyss-tier) zone, giving prawn and whale territory.
  rect(tiles, 0, 138, W - 1, H - 1, Tile.Water);

  // --- BRADY'S BEACH (Pacific-facing beach, far west) ---
  // Large open-coast bay: x=20-70, y=90-155, connects south to Barkley Sound.
  rect(tiles, 0, 88, 68, 155, Tile.Water);
  // Wide sandy flat backing Brady's Beach (above the water line)
  rect(tiles, 68, 90, 90, 152, Tile.Sand);

  // --- NATURAL LANDCOVER ---
  applyLandcover(tiles, W, H);

  // West Bamfield is a long-established boardwalk settlement — explicitly clear
  // the forest strip along the west bank so houses aren't buried in trees.
  for (let y = 15; y <= 118; y++)
    for (let x = 138; x <= 163; x++)
      if (tiles[y * W + x] === Tile.Forest || tiles[y * W + x] === Tile.Hill)
        tiles[y * W + x] = Tile.Grass;

  // East Bamfield community along Bamfield Main — clear a wide settled corridor.
  for (let y = 10; y <= 130; y++)
    for (let x = 178; x <= 214; x++)
      if (tiles[y * W + x] === Tile.Forest || tiles[y * W + x] === Tile.Hill)
        tiles[y * W + x] = Tile.Grass;

  // Bushy back-country trail linking West & East Bamfield around the north end
  // of the inlet. There is NO road between the two sides — you cross by boat, or
  // hoof this rough single-track through the forest (a faint grassy line).
  for (let x = 150; x <= 188; x++) {
    const ty = 10 + Math.round(2 * Math.sin(x * 0.35));
    for (let yy = ty; yy <= ty + 1; yy++)
      if (tiles[yy * W + x] === Tile.Forest || tiles[yy * W + x] === Tile.Hill)
        tiles[yy * W + x] = Tile.Grass;
  }

  // --- ROADS ---
  // Bamfield Main: arrives from the NE (ferry road end), runs S to road-end.
  const ROAD_X = 185;
  // Incoming highway from east (top of map):
  for (let x = ROAD_X; x <= W - 12; x++) setTile(tiles, x, 6, Tile.Road);
  // Main road south:
  vLine(tiles, ROAD_X, 6, 125, Tile.Road);
  // Side road east to Government Wharf:
  hLine(tiles, ROAD_X, ROAD_X + 12, 54, Tile.Road);
  // Side road south-east to Port Desire dock:
  hLine(tiles, ROAD_X, ROAD_X + 8, 96, Tile.Road);
  // Short spur: Ostrom's Gas Bar access:
  hLine(tiles, ROAD_X, ROAD_X + 6, 68, Tile.Road);

  clearRoadMargins(tiles, 2, W, H);

  // --- WEST BAMFIELD BOARDWALK (docks along west bank of inlet) ---
  // Fingerpiers run from land (x≈152) east into the inlet water.
  // The inlet meanders ±2 tiles so we extend well into the channel.
  for (const py of [28, 36, 44, 52, 60, 70, 80, 90, 98, 108]) {
    hLine(tiles, 152, 172, py, Tile.Dock);
  }

  // --- GOVERNMENT WHARF (east bank, car ferry terminal) ---
  rect(tiles, ROAD_X + 4, 54, ROAD_X + 14, 57, Tile.Dock);

  // --- BMSC DOCK (south shore of Grappler Inlet) ---
  rect(tiles, 218, 58, 248, 60, Tile.Dock);
  hLine(tiles, 228, 242, 62, Tile.Dock); // float plane dock

  // --- PORT DESIRE DOCK ---
  hLine(tiles, ROAD_X + 4, ROAD_X + 10, 96, Tile.Dock);
  hLine(tiles, ROAD_X + 4, ROAD_X + 10, 97, Tile.Dock);

  return worldMap(beachify(tiles));
}

function bamfieldBuildings(): BuildingState[] {
  return mkBuildings("bf", [
    // ---- WEST BAMFIELD (boardwalk community) ----
    // Rows of houses right along the west bank, facing the inlet.
    { kind:"house",     x:148, y: 22, w:3, h:2, hp:100 },
    { kind:"house",     x:152, y: 22, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 30, w:3, h:2, hp:100 },
    { kind:"house",     x:153, y: 30, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 38, w:3, h:2, hp:100 },
    { kind:"house",     x:153, y: 40, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 48, w:3, h:2, hp:100 },
    { kind:"boathouse", x:153, y: 48, w:4, h:3, hp:120 },
    // McKay Bay Lodge — west-side marina lodge, sells fuel
    { kind:"shop",      x:145, y: 58, w:5, h:3, hp:180, shop:{
      name:"McKay Bay Lodge", buys:[{item:"fish",price:3}], sells:[{item:"rod",price:16}] } },
    { kind:"house",     x:148, y: 62, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 70, w:3, h:2, hp:100 },
    { kind:"house",     x:152, y: 70, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 78, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y: 86, w:3, h:2, hp:100 },
    { kind:"boathouse", x:154, y: 88, w:4, h:3, hp:120 },
    { kind:"house",     x:148, y: 96, w:3, h:2, hp:100 },
    { kind:"house",     x:148, y:104, w:3, h:2, hp:100 },

    // ---- BAMFIELD MARINE SCIENCES CENTRE (BMSC) ----
    // South shore of Grappler Inlet: main lab, accommodation, boat barn.
    { kind:"shop",      x:218, y: 62, w:8, h:5, hp:250, shop:SHOP_BMSC }, // main research building
    { kind:"house",     x:230, y: 62, w:4, h:3, hp:140 }, // grad student housing
    { kind:"house",     x:236, y: 62, w:4, h:3, hp:140 },
    { kind:"house",     x:242, y: 62, w:4, h:3, hp:140 },
    { kind:"boathouse", x:248, y: 62, w:5, h:4, hp:150 }, // research boat barn

    // ---- EAST BAMFIELD (road side) ----
    // Government wharf / ferry terminal:
    { kind:"dock",      x:195, y: 52, w:5, h:4, hp:180 },
    // Ostrom's Gas Bar + metal shop:
    { kind:"shop",      x:188, y: 66, w:4, h:3, hp:200, shop:SHOP_OSTROMS },
    // General store / market (bus stop in front):
    { kind:"shop",      x:180, y: 72, w:5, h:4, hp:180, shop:SHOP_MARKET },
    // Breaker's Marine (sells jerry cans, boat parts):
    { kind:"shop",      x:180, y: 82, w:4, h:3, hp:160, shop:SHOP_BREAKERS },
    // Houses along Bamfield Main:
    { kind:"house",     x:190, y: 18, w:3, h:2, hp:100 },
    { kind:"house",     x:196, y: 18, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y: 26, w:3, h:2, hp:100 },
    { kind:"house",     x:196, y: 26, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y: 34, w:3, h:2, hp:100 },
    { kind:"house",     x:196, y: 34, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y: 42, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y: 76, w:3, h:2, hp:100 },
    { kind:"house",     x:196, y: 80, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y: 90, w:3, h:2, hp:100 },
    { kind:"house",     x:196, y: 96, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y:104, w:3, h:2, hp:100 },
    { kind:"house",     x:190, y:112, w:3, h:2, hp:100 },
    // Boathouse at road end:
    { kind:"boathouse", x:184, y:120, w:4, h:3, hp:120 },
  ]);
}

// ---------------------------------------------------------------------------
// ANACLA / PACHENA BAY  (300 × 180 tiles)
//
// Real geography:
//   • Bamfield Main road arrives from the NORTH at x≈220.
//   • Anacla village sits on the NE shore of Pachena Bay, just off the road.
//   • Pachena Beach: long (~3 km) gently-curving sandy beach that sweeps
//     from the NE shore all the way around to the west. The tidal flat is huge.
//   • Keeha Beach: around the headland to the WEST, exposed open Pacific.
//     This is where the sea-crossing trigger zone is (sail north to Bamfield).
//   • Pachena River enters from the NE, meanders down to the bay mouth.
//   • Cape Beale (lighthouse) is at the southern tip — represented as rocky
//     headland at the very south edge of the map.
//   • Barkley Sound fills the deep south (y ≥ 160).
// ---------------------------------------------------------------------------
function generateAnaclaMap(): WorldMap {
  const W = MAP_WIDTH, H = MAP_HEIGHT;
  const tiles: Tile[] = fill(Tile.Grass);

  // --- PACHENA BAY (deep bay opening SOUTH; long beach at its head) ---
  // The bay is a basin between two headlands (E & W). Its north shore is a
  // gentle arc — that arc is the long Pachena Beach at the head of the bay.
  // South of y=152 it opens into the true Pacific (deep ocean tiers).
  const BAY_W0 = 48, BAY_W1 = 252;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y >= 152) { tiles[y * W + x] = Tile.Water; continue; } // open Pacific
      if (x >= BAY_W0 && x <= BAY_W1) {
        // north shore dips deepest (furthest north) at the bay centre
        const shore = 100 - 28 * Math.sin(Math.PI * (x - BAY_W0) / (BAY_W1 - BAY_W0));
        if (y > shore) tiles[y * W + x] = Tile.Water;
      }
    }
  }

  // --- PACHENA RIVER (enters from the north into the NE corner of the bay) ---
  // Lower Anacla sits on the EAST bank of this river.
  for (let y = 0; y < 92; y++) {
    const rx = 162 + Math.round(7 * Math.sin(y * 0.08));
    for (let x = rx - 2; x <= rx + 2; x++) if (x >= 0 && x < W) tiles[y * W + x] = Tile.Water;
  }

  // --- NATURAL LANDCOVER ---
  applyLandcover(tiles, W, H);

  // Lower Anacla village flat — clear the bench east of the river, by the bay.
  for (let y = 38; y <= 92; y++)
    for (let x = 172; x <= 224; x++)
      if (tiles[y * W + x] === Tile.Forest || tiles[y * W + x] === Tile.Hill)
        tiles[y * W + x] = Tile.Grass;

  // --- UPPER ANACLA (a hill bench ESE of the village, up a steep bank) ---
  // No road or trail climbs it — it reads as a plateau ringed by steep rock.
  rect(tiles, 234, 22, 288, 74, Tile.Hill);
  for (let x = 232; x <= 290; x++) {
    setTile(tiles, x, 20, Tile.Rock); setTile(tiles, x, 21, Tile.Rock);
    setTile(tiles, x, 75, Tile.Rock); setTile(tiles, x, 76, Tile.Rock);
  }
  for (let y = 20; y <= 76; y++) {
    setTile(tiles, 232, y, Tile.Rock); setTile(tiles, 233, y, Tile.Rock);
  }
  // Grass streets across the plateau top.
  for (let y = 26; y <= 70; y++)
    for (let x = 240; x <= 284; x++)
      tiles[y * W + x] = Tile.Grass;

  // --- LONG SANDY BEACH (Pachena Beach, all along the bay head) ---
  const dwBay = distanceToWater(tiles, W, H);
  for (let y = 58; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const t = tiles[i];
      if ((t === Tile.Grass || t === Tile.Forest) && dwBay[i] > 0 && dwBay[i] <= 16) {
        tiles[i] = Tile.Sand;
      }
    }
  }

  // --- THE ONE ROAD INTO LOWER ANACLA (arrives from the north) ---
  // This is the road players spawn on and walk/drive in along.
  const ROAD_X = 195;
  vLine(tiles, ROAD_X, 0, 72, Tile.Road);
  hLine(tiles, 176, 214, 60, Tile.Road); // short village street off the road
  clearRoadMargins(tiles, 2, W, H);

  // --- RIVER DOCK (boat landing on the river's east bank by the village) ---
  hLine(tiles, 158, 166, 66, Tile.Dock);
  hLine(tiles, 158, 166, 67, Tile.Dock);

  return worldMap(beachify(tiles));
}

function anaclaBuildings(): BuildingState[] {
  return mkBuildings("an", [
    // ==== LOWER ANACLA (the flat by the river & bay, off the one road) ====
    // The reopened gas bar — right beside a house, just as it used to be.
    { kind:"shop",      x:200, y: 46, w:4, h:3, hp:180, shop:SHOP_ANACLA_GAS },
    { kind:"house",     x:205, y: 46, w:3, h:2, hp:100 }, // the house beside the gas bar
    // A couple of streets of houses.
    { kind:"house",     x:178, y: 44, w:3, h:2, hp:100 },
    { kind:"house",     x:184, y: 44, w:3, h:2, hp:100 },
    { kind:"house",     x:178, y: 52, w:3, h:2, hp:100 },
    { kind:"house",     x:184, y: 52, w:3, h:2, hp:100 },
    // The fellow who sells food out of his house.
    { kind:"house",     x:178, y: 64, w:3, h:2, hp:100, shop:SHOP_ANACLA_HOME },
    { kind:"house",     x:184, y: 64, w:3, h:2, hp:100 },
    { kind:"house",     x:206, y: 64, w:3, h:2, hp:100 },
    { kind:"house",     x:212, y: 64, w:3, h:2, hp:100 },
    // Boat seller on the river's east bank, by the dock.
    { kind:"boathouse", x:168, y: 60, w:5, h:4, hp:160 },
    // ---- PACHENA BAY CAMPGROUND (above the high-tide line, west of village) ----
    { kind:"house",     x:120, y: 78, w:3, h:2, hp: 80 }, // shelter
    { kind:"house",     x:128, y: 78, w:3, h:2, hp: 80 },
    { kind:"boathouse", x:110, y: 80, w:4, h:3, hp:120 }, // boat launch

    // ==== UPPER ANACLA (the hill bench — government, gym, a few homes) ====
    // Huu-ay-aht government office.
    { kind:"shop",      x:246, y: 32, w:5, h:3, hp:220, shop:SHOP_ANACLA_GOV },
    // House of Huu-ay-aht — the big community hall / gym for sport & culture.
    { kind:"boathouse", x:256, y: 44, w:8, h:5, hp:300 },
    // A few houses down the street.
    { kind:"house",     x:270, y: 32, w:3, h:2, hp:100 },
    { kind:"house",     x:276, y: 32, w:3, h:2, hp:100 },
    { kind:"house",     x:246, y: 60, w:3, h:2, hp:100 },
    { kind:"house",     x:252, y: 60, w:3, h:2, hp:100 },
  ]);
}

// ---------------------------------------------------------------------------
// Region assembly helpers
// ---------------------------------------------------------------------------
function mkBuildings(
  prefix: string,
  defs: Array<{ kind: BuildingState["kind"]; x: number; y: number; w: number; h: number; hp: number; shop?: ShopDef }>,
): BuildingState[] {
  return defs.map((d, i) => ({
    id: `${prefix}${i}`,
    kind: d.kind, x: d.x, y: d.y, w: d.w, h: d.h, hp: d.hp, maxHp: d.hp,
    ...(d.shop ? { shop: d.shop } : {}),
  }));
}

// ---------------------------------------------------------------------------
// Shop definitions (the local economy)
// ---------------------------------------------------------------------------
const SHOP_MARKET: ShopDef = {
  name: "Bamfield General Store",
  buys: [
    { item: "berry", price: 3 },
    { item: "fish", price: 2 }, { item: "salmon", price: 5 },
    { item: "crabmeat", price: 2 },
    { item: "cookedfish", price: 6 }, { item: "cookedsalmon", price: 12 },
    { item: "cookedcrab", price: 6 },
  ],
  sells: [
    { item: "rod", price: 18 },
    { item: "plank", price: 5 },
  ],
};
const SHOP_BMSC: ShopDef = {
  name: "Marine Sciences Centre",
  // BMSC pays a research premium — especially for rare and deep-water specimens.
  buys: [
    { item: "fish",     price: 5  },
    { item: "liveFish", price: 8  },
    { item: "salmon",   price: 10 },
    { item: "lingcod",  price: 16 },
    { item: "halibut",  price: 28 },
    { item: "tuna",     price: 50 },
    { item: "crabmeat", price: 4  },
  ],
  sells: [
    { item: "rod", price: 15 },
  ],
};
const SHOP_BREAKERS: ShopDef = {
  name: "Breaker's Marine",
  buys: [
    { item: "scrap", price: 4 },
    { item: "iron", price: 3 },
  ],
  sells: [
    { item: "plank", price: 5 },
    { item: "rod", price: 16 },
    { item: "jerryCan", price: 15 },
  ],
};
const SHOP_OSTROMS: ShopDef = {
  name: "Ostrom's Gas Bar & Metal Shop",
  buys: [
    { item: "iron", price: 3 },
    { item: "stone", price: 2 },
    { item: "scrap", price: 4 },
  ],
  sells: [
    { item: "plank", price: 5 },
    { item: "jerryCan", price: 12 },
  ],
};
const SHOP_ANACLA_GAS: ShopDef = {
  name: "Anacla Gas Bar",
  buys: [
    { item: "berry", price: 3 },
    { item: "fish", price: 2 },
  ],
  sells: [
    { item: "plank", price: 5 },
    { item: "jerryCan", price: 12 },
  ],
};
const SHOP_ANACLA_HOME: ShopDef = {
  name: "Fresh Food (sold from the house)",
  buys: [
    { item: "berry", price: 4 }, // a good price for fresh-picked berries
    { item: "crabmeat", price: 3 },
    { item: "fish", price: 3 },
  ],
  sells: [
    { item: "cookedfish", price: 8 },
    { item: "cookedcrab", price: 8 },
    { item: "berry", price: 4 },
  ],
};
const SHOP_ANACLA_GOV: ShopDef = {
  name: "Huu-ay-aht Government Office",
  buys: [
    { item: "scrap", price: 5 },   // bounty on beach junk hauled up
    { item: "iron", price: 4 },
  ],
  sells: [
    { item: "plank", price: 4 },
    { item: "rod", price: 15 },
  ],
};

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
    spawn: { x: 183, y: 72 }, // East Bamfield, in front of the market
    travelNodes: [
      {
        id: "bf-bus", kind: "bus",
        x: 181, y: 72, w: 4, h: 2,
        label: "Catch the bus at the market to Anacla",
        toRegion: "anacla", toSpawn: { x: 195, y: 12 },
      },
      {
        id: "bf-gate", kind: "gate",
        x: 185, y: 4, w: 2, h: 1,
        label: "Drive the road out to Anacla",
        toRegion: "anacla", toSpawn: { x: 195, y: 6 },
      },
      {
        id: "bf-sea", kind: "sea",
        x: 40, y: 168, w: 200, h: 10,
        label: "Sail south out of the inlet round to Pachena Bay",
        toRegion: "anacla", toSpawn: { x: 145, y: 145 }, // inside Pachena Bay, not in the sea zone
      },
    ],
    vehicles: [
      { id: "bf-car-1",  kind: "car",  x: 187, y: 14  }, // north Bamfield Main
      { id: "bf-car-2",  kind: "car",  x: 187, y: 82  }, // south Bamfield Main
      { id: "bf-boat-1", kind: "boat", x: 163, y: 74  }, // inlet west bank, near West Bamfield
      { id: "bf-boat-2", kind: "boat", x: 175, y: 55  }, // near gov't wharf
      { id: "bf-boat-3", kind: "boat", x: 232, y: 52  }, // Grappler Inlet, BMSC
    ],
    resourceNodes: [
      // Forest trees on both sides of the inlet
      { id:"bf-t1",  kind:"tree",      x: 30, y: 20 },
      { id:"bf-t2",  kind:"tree",      x: 25, y: 45 },
      { id:"bf-t3",  kind:"tree",      x: 28, y: 70 },
      { id:"bf-t4",  kind:"tree",      x: 32, y:100 },
      { id:"bf-t5",  kind:"tree",      x: 28, y:130 },
      { id:"bf-t6",  kind:"tree",      x:110, y: 15 },
      { id:"bf-t7",  kind:"tree",      x:115, y: 40 },
      { id:"bf-t8",  kind:"tree",      x:112, y: 75 },
      { id:"bf-t9",  kind:"tree",      x:108, y:110 },
      { id:"bf-t10", kind:"tree",      x:240, y: 12 },
      { id:"bf-t11", kind:"tree",      x:245, y: 35 },
      { id:"bf-t12", kind:"tree",      x:242, y: 75 },
      // Ore in rocky hillsides
      { id:"bf-i1",  kind:"ironOre",   x:  8, y: 25 },
      { id:"bf-i2",  kind:"ironOre",   x: 10, y: 70 },
      { id:"bf-i3",  kind:"ironOre",   x: 10, y:120 },
      { id:"bf-s1",  kind:"stoneOre",  x:282, y: 20 },
      { id:"bf-s2",  kind:"stoneOre",  x:285, y: 60 },
      // Native berries along forest edges
      { id:"bf-b1",  kind:"berryBush", x: 45, y: 22, variety:"huckleberry" },
      { id:"bf-b2",  kind:"berryBush", x: 42, y: 55, variety:"salmonberry" },
      { id:"bf-b3",  kind:"berryBush", x: 48, y: 90, variety:"salal" },
      { id:"bf-b4",  kind:"berryBush", x:235, y: 18, variety:"thimbleberry" },
      { id:"bf-b5",  kind:"berryBush", x:232, y: 85, variety:"trailing blackberry" },
      { id:"bf-b6",  kind:"berryBush", x: 38, y:135, variety:"huckleberry" },
      // Arbutus trees — rocky coastal west side
      { id:"bf-arbutus-1", kind:"tree", x:158, y:22, variety:"arbutus" },
      { id:"bf-arbutus-2", kind:"tree", x:161, y:30, variety:"arbutus" },
      { id:"bf-arbutus-3", kind:"tree", x:155, y:38, variety:"arbutus" },
      { id:"bf-arbutus-4", kind:"tree", x:163, y:45, variety:"arbutus" },
      { id:"bf-arbutus-5", kind:"tree", x:157, y:50, variety:"arbutus" },
      { id:"bf-arbutus-6", kind:"tree", x:164, y:24, variety:"arbutus" },
    ],
    plants: [
      { id:"bf-inv1", kind:"scotchBroom",         x:230, y: 14 },
      { id:"bf-inv2", kind:"himalayanBlackberry",  x: 50, y: 85 },
      { id:"bf-inv3", kind:"foxglove",             x:226, y: 75 },
      { id:"bf-inv4", kind:"scotchBroom",          x:192, y:118 },
    ],
  };

  const anacla: RegionDef = {
    id: "anacla",
    name: "Anacla / Pachena Bay",
    map: generateAnaclaMap(),
    buildings: anaclaBuildings(),
    spawn: { x: 195, y: 6 }, // top of the one road into Lower Anacla
    travelNodes: [
      {
        id: "an-bus", kind: "bus",
        x: 193, y: 58, w: 4, h: 2,
        label: "Catch the bus back to Bamfield",
        toRegion: "bamfield", toSpawn: { x: 183, y: 72 },
      },
      {
        id: "an-gate", kind: "gate",
        x: 194, y: 0, w: 3, h: 1,
        label: "Drive the road back to Bamfield",
        toRegion: "bamfield", toSpawn: { x: 185, y: 8 },
      },
      {
        // Sea crossing: head out the bay mouth and round the coast to Bamfield.
        id: "an-sea", kind: "sea",
        x: 0, y: 158, w: 150, h: 22,
        label: "Sail out the bay and round the coast to Bamfield",
        toRegion: "bamfield", toSpawn: { x: 90, y: 155 }, // Barkley Sound, south of inlet
      },
    ],
    vehicles: [
      { id:"an-car-1",  kind:"car",  x:195, y: 20 }, // on the road in
      { id:"an-car-2",  kind:"car",  x:198, y: 50 }, // by the gas bar
      { id:"an-boat-1", kind:"boat", x:120, y:130 }, // Pachena Bay
      { id:"an-boat-2", kind:"boat", x:160, y:140 }, // bay, mid-water
      { id:"an-boat-3", kind:"boat", x: 60, y:160 }, // out toward the open coast
    ],
    resourceNodes: [
      { id:"an-t1",  kind:"tree",      x: 30, y: 30 },
      { id:"an-t2",  kind:"tree",      x: 28, y: 60 },
      { id:"an-t3",  kind:"tree",      x: 34, y: 95 },
      { id:"an-t4",  kind:"tree",      x:262, y: 90 },
      { id:"an-t5",  kind:"tree",      x:268, y:110 },
      { id:"an-t6",  kind:"tree",      x:150, y: 30 },
      { id:"an-i1",  kind:"ironOre",   x: 10, y: 40 },
      { id:"an-s1",  kind:"stoneOre",  x: 12, y: 70 },
      { id:"an-s2",  kind:"stoneOre",  x:288, y: 30 }, // upper bench rock
      { id:"an-b1",  kind:"berryBush", x: 45, y: 35, variety:"salmonberry" },
      { id:"an-b2",  kind:"berryBush", x:255, y: 95, variety:"huckleberry" },
      { id:"an-b3",  kind:"berryBush", x: 50, y: 75, variety:"thimbleberry" },
      { id:"an-b4",  kind:"berryBush", x:170, y: 95, variety:"salal" },
      { id:"an-b5",  kind:"berryBush", x:225, y: 90, variety:"trailing blackberry" },
      // Arbutus trees — rocky coastal spots & the upper bench
      { id:"an-arbutus-1", kind:"tree", x:240, y:28, variety:"arbutus" },
      { id:"an-arbutus-2", kind:"tree", x:284, y:50, variety:"arbutus" },
      { id:"an-arbutus-3", kind:"tree", x:243, y:66, variety:"arbutus" },
    ],
    plants: [
      { id:"an-inv1", kind:"scotchBroom",         x:210, y: 50 },
      { id:"an-inv2", kind:"foxglove",             x:180, y: 70 },
      { id:"an-inv3", kind:"himalayanBlackberry",  x:215, y: 70 },
    ],
  };

  return applyImported([bamfield, anacla]);
}

export const DEFAULT_REGION = "bamfield";
