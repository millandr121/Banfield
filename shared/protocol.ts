// Shared types and constants used by BOTH the client and the server.
// Keeping these in one place guarantees the wire format never drifts.

export const TILE_SIZE = 24; // pixels per tile on the client

// --- Tile types -------------------------------------------------------------
export enum Tile {
  Water = 0,
  Sand = 1,
  Grass = 2,
  Forest = 3,
  Hill = 4,
  Rock = 5,
  Road = 6,
  Dock = 7,
}

// Base elevation per tile type, used only as a seed/bump. The AUTHORITATIVE
// per-tile elevation lives in WorldMap.elevation (a sloped heightmap), so the
// tide can sweep gradually across a beach instead of toggling one tile.
export const TILE_ELEVATION: Record<Tile, number> = {
  [Tile.Water]: 4,
  [Tile.Sand]: 18,
  [Tile.Dock]: 22,
  [Tile.Road]: 40,
  [Tile.Grass]: 46,
  [Tile.Forest]: 56,
  [Tile.Hill]: 80,
  [Tile.Rock]: 92,
};

// --- Tide model -------------------------------------------------------------
// Elevations now run on a gentle ~2-per-tile beach slope, so a wide waterline
// band makes the tide crawl across many tiles each cycle.
export const TIDE_CYCLE_MS = 900_000; // one full low->high->low cycle = 15 min
export const WATERLINE_LOW = 1; // elevation covered at lowest tide
export const WATERLINE_HIGH = 20; // elevation covered at highest tide
export const KING_TIDE_SURGE = 10; // extra waterline during a king tide
export const TSUNAMI_SURGE = 30; // extra waterline during a (rare) tsunami

export type TidePhase = "low" | "mid" | "high";

// --- World map --------------------------------------------------------------
export interface WorldMap {
  width: number;
  height: number;
  tiles: Tile[]; // length = width * height, row-major
  elevation: number[]; // per-tile height; tile is submerged when elevation < waterline
}

// --- Entities ---------------------------------------------------------------
export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
}

export type RegionId = string;

// --- Skills -----------------------------------------------------------------
// Level = floor(sqrt(rawXP)), so early gains come fast, mastery takes real
// time. Dying costs 25% of ALL raw XP — you can slide backwards, but never to
// zero. No hard total cap: specialising is rewarded by the square-root curve
// (being level 50 in one skill costs 2500 XP; being level 10 in five costs the
// same — the maths nudge you to pick a lane without forcing it).
export const SKILL_NAMES = [
  "combat", "woodcutting", "mining", "swimming", "boating", "driving",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];
export type Skills = Record<SkillName, number>; // stores raw XP
export function skillLevel(xp: number): number { return Math.floor(Math.sqrt(xp)); }
export function defaultSkills(): Skills {
  return { combat: 0, woodcutting: 0, mining: 0, swimming: 0, boating: 0, driving: 0 };
}

// --- Inventory --------------------------------------------------------------
export const ITEM_IDS = ["wood", "iron", "stone", "plank", "scrap"] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export type Inventory = Partial<Record<ItemId, number>>;
export const ITEM_LABEL: Record<ItemId, string> = {
  wood: "Wood", iron: "Iron", stone: "Stone", plank: "Plank", scrap: "Scrap",
};

// --- Resource nodes ---------------------------------------------------------
export type ResourceKind = "tree" | "ironOre" | "stoneOre";
export interface ResourceNode {
  id: string;
  kind: ResourceKind;
  region: RegionId;
  x: number; // tile coords
  y: number;
  hp: number; // 0 = depleted; hits to deplete: maxHp
  maxHp: number;
  depleted: boolean;
  respawnAt: number | null; // epoch ms when it regrows; null if healthy
}

// --- Crafting ---------------------------------------------------------------
export type CraftRecipeId = "plank" | "repairVehicle";

export interface PlayerState {
  id: string;
  name: string;
  region: RegionId;
  x: number; // tile-space float
  y: number;
  dir: number; // facing angle in radians (for arms / directional attacks)
  hp: number;
  maxHp: number;
  stamina: number; // 0..maxStamina, spent on attacks & dodges
  maxStamina: number;
  skills: Skills;
  inventory: Inventory;
  appearance: Appearance;
  swimming: boolean;
  dodging: boolean; // brief lunge with i-frames (client renders a streak)
  vehicleId: string | null; // id of the vehicle being driven, else null
  dead: boolean;
}

export type CreatureKind =
  | "crab" // low tide, land, swarms structures
  | "octopus" // either tide
  | "dogfish" // high tide shark
  | "sixgill" // high tide bigger shark
  | "orca" // high tide apex
  | "humpback" // neutral
  | "greywhale"; // neutral

export interface CreatureState {
  id: string;
  kind: CreatureKind;
  region: RegionId;
  x: number;
  y: number;
  hp: number;
}

// --- Vehicles ---------------------------------------------------------------
// Driveable boats & cars. They are persistent world entities (not teleports):
// you walk up and BOARD one, then your movement keys steer it. Cars are quick
// on roads but can't enter deep water; boats only move on water. Leave one and
// it stays put (until the tide carries it off).
export type VehicleKind = "car" | "boat";

export interface VehicleState {
  id: string;
  kind: VehicleKind;
  region: RegionId;
  x: number;
  y: number;
  dir: number; // heading in radians
  hp: number;
  maxHp: number;
  driverId: string | null; // player currently driving, else null
}

export type BuildingKind = "house" | "shop" | "boathouse" | "dock" | "rubble";

export interface BuildingState {
  id: string;
  kind: BuildingKind;
  x: number; // top-left tile
  y: number;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
}

// --- Travel between regions -------------------------------------------------
// A travel node is a pad you stand on and activate to move *yourself* (on foot)
// to another region — vehicles stay behind. Catch the scheduled bus at the
// market, or walk through the gate at the road's end up Bamfield Main.
export interface TravelNode {
  id: string;
  kind: "bus" | "gate";
  x: number; // top-left tile
  y: number;
  w: number;
  h: number;
  label: string; // e.g. "Catch the bus to Anacla"
  toRegion: RegionId;
  toSpawn: { x: number; y: number };
}

// Static, per-region info the client needs once on entry.
export interface RegionInfo {
  id: RegionId;
  name: string;
  map: WorldMap;
  travelNodes: TravelNode[];
}

// --- Messages: client -> server --------------------------------------------
export type ClientMessage =
  | { t: "join"; name: string; appearance: Appearance }
  | { t: "input"; dx: number; dy: number } // intended direction, each -1..1
  | { t: "attack"; charge?: number } // charge 0..1 from how long Space was held
  | { t: "dodge" } // quick lunge + i-frames in the current heading
  | { t: "board" } // get in / out of the nearest vehicle
  | { t: "harvest" } // chop/mine nearest resource node
  | { t: "craft"; recipe: CraftRecipeId } // craft at an adjacent shop/boathouse
  | { t: "chat"; msg: string } // text message; / = global, // = team
  | { t: "repair" }
  | { t: "travel" };

// --- Messages: server -> client --------------------------------------------
export interface Snapshot {
  tide: number; // 0..1 (0 = low, 1 = high)
  waterline: number; // current elevation threshold
  phase: TidePhase;
  event: "none" | "king" | "tsunami";
  players: PlayerState[];
  creatures: CreatureState[];
  buildings: BuildingState[];
  vehicles: VehicleState[];
  resourceNodes: ResourceNode[];
}

export type ServerMessage =
  // Sent on join AND whenever the player changes region (the map swaps).
  | { t: "init"; id: string; region: RegionInfo; snapshot: Snapshot }
  | { t: "snapshot"; snapshot: Snapshot }
  | { t: "log"; msg: string }
  | { t: "chat"; from: string; msg: string; channel: "global" | "team" };

// Helper shared by both sides: a tile is under water when its (per-tile)
// elevation sits below the current waterline.
export function submergedAt(elevation: number, waterline: number): boolean {
  return elevation < waterline;
}

export function phaseForTide(tide: number): TidePhase {
  if (tide < 0.35) return "low";
  if (tide > 0.65) return "high";
  return "mid";
}
