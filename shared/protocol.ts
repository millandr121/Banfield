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

// Base elevation per tile (0 = deep sea, 100 = mountain top). The current tide
// "waterline" is compared against this: any tile whose elevation is below the
// waterline is currently submerged.
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
export const TIDE_CYCLE_MS = 240_000; // one full low->high->low cycle = 4 min
export const WATERLINE_LOW = 10; // elevation covered at lowest tide
export const WATERLINE_HIGH = 30; // elevation covered at highest tide
export const KING_TIDE_SURGE = 12; // extra waterline during a king tide
export const TSUNAMI_SURGE = 34; // extra waterline during a (rare) tsunami

export type TidePhase = "low" | "mid" | "high";

// --- World map --------------------------------------------------------------
export interface WorldMap {
  width: number;
  height: number;
  tiles: Tile[]; // length = width * height, row-major
}

// --- Entities ---------------------------------------------------------------
export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
}

export type RegionId = string;

export interface PlayerState {
  id: string;
  name: string;
  region: RegionId;
  x: number; // tile-space float
  y: number;
  hp: number;
  maxHp: number;
  appearance: Appearance;
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
// A travel node is a pad you stand on and activate to move to another region:
// catch the bus at the market, drive from the road's end, or boat out the inlet.
export interface TravelNode {
  id: string;
  kind: "bus" | "car" | "boat";
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
  | { t: "attack" }
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
}

export type ServerMessage =
  // Sent on join AND whenever the player changes region (the map swaps).
  | { t: "init"; id: string; region: RegionInfo; snapshot: Snapshot }
  | { t: "snapshot"; snapshot: Snapshot }
  | { t: "log"; msg: string };

// Helper shared by both sides.
export function isSubmerged(tile: Tile, waterline: number): boolean {
  return TILE_ELEVATION[tile] < waterline;
}

export function phaseForTide(tide: number): TidePhase {
  if (tide < 0.35) return "low";
  if (tide > 0.65) return "high";
  return "mid";
}
