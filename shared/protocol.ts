// Shared types and constants used by BOTH the client and the server.
// Keeping these in one place guarantees the wire format never drifts.

export const TILE_SIZE = 24; // pixels per tile on the client

// --- Tile types -------------------------------------------------------------
export enum Tile {
  Water = 0,      // salt water — the ocean & tidal inlets
  Sand = 1,
  Grass = 2,
  Forest = 3,
  Hill = 4,
  Rock = 5,
  Road = 6,
  Dock = 7,
  FreshWater = 8, // inland lakes / ponds — drinkable, not tidal salt
}

// Both ocean and lake tiles count as "water" for swimming, depth & rendering.
export function isWaterTile(t: Tile): boolean {
  return t === Tile.Water || t === Tile.FreshWater;
}

// Base elevation per tile type, used only as a seed/bump. The AUTHORITATIVE
// per-tile elevation lives in WorldMap.elevation (a sloped heightmap), so the
// tide can sweep gradually across a beach instead of toggling one tile.
export const TILE_ELEVATION: Record<Tile, number> = {
  [Tile.Water]: 4,
  [Tile.FreshWater]: 6,
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
// Real Bamfield tides swing high<->low about every 6 hours; we compress that
// to ~6 minutes each way, so a full low->high->low cycle is 12 minutes.
export const TIDE_CYCLE_MS = 720_000;
export const WATERLINE_LOW = 1; // elevation covered at lowest tide
export const WATERLINE_HIGH = 20; // elevation covered at highest tide
export const KING_TIDE_SURGE = 10; // extra waterline during a king tide
export const TSUNAMI_SURGE = 30; // extra waterline during a (rare) tsunami

export type TidePhase = "low" | "mid" | "high";

// --- Water depth tiers -------------------------------------------------------
// depth = waterline - tile_elevation (positive = underwater)
export const DEPTH_ANKLE  =  4; // ankle/knee — cars wade, crabs, octopus
export const DEPTH_SWIM   = 10; // waist/swim — player swimming, small boats
export const DEPTH_DEEP   = 30; // deep water — sharks, big boats
export const DEPTH_OCEAN  = 60; // open ocean — orca, whales, prawn zone

// --- World map --------------------------------------------------------------
export interface WorldMap {
  width: number;
  height: number;
  tiles: Tile[]; // length = width * height, row-major
  elevation: number[]; // per-tile height; tile is submerged when elevation < waterline
}

// --- Chunked map streaming --------------------------------------------------
// Big maps aren't shipped whole. The server streams CHUNK×CHUNK tile blocks
// around each player as they move, and sends a single downsampled OVERVIEW up
// front for the full-region minimap. Default (unloaded) tiles read as ocean.
export const CHUNK = 32;

// A low-res snapshot of the whole region for the map overlay. `scale` is how
// many real tiles each overview cell covers.
export interface OverviewMap {
  scale: number;
  width: number;  // overview cells across = ceil(mapWidth / scale)
  height: number;
  tiles: number[];
  elevation: number[];
}

// --- Entities ---------------------------------------------------------------
// Worn clothing & gear slots — which ItemId is in each slot. These drive
// appearance overrides (shirt/pants/hat color) and show in the equip panel.
export type WornSlot = "head" | "torso" | "legs" | "back" | "hand";
export type WornItems = Partial<Record<WornSlot, ItemId>>;

// Which items are equippable to which slot.
export const SLOT_FOR_ITEM: Partial<Record<string, WornSlot>> = {
  clothShirt: "torso", waxedJacket: "torso", rainCoat: "torso", woolSweater: "torso", wetsuitTop: "torso",
  clothPants: "legs", wetsuitBottom: "legs",
  snorkelMask: "head", divingTank: "back",
  // research tools → hand slot
  binoculars: "hand", butterflyNet: "hand", listeningDevice: "hand", fieldNotebook: "hand",
  // profession tools → hand slot
  pickaxe: "hand", fishingCage: "hand", surveyFlag: "hand",
  // weapons → hand slot (backed by the existing `equipped` field, kept in sync)
  stick: "hand", huntingKnife: "hand", bow: "hand", crossbow: "hand", speargun: "hand", rifle: "hand",
};

// Visual color override when a clothing item is worn.
export const CLOTHING_COLOR: Partial<Record<string, { shirt?: string; pants?: string; hat?: string }>> = {
  clothShirt:     { shirt: "#c8a97a" },
  clothPants:     { pants: "#7a6a4a" },
  waxedJacket:    { shirt: "#3d5228" },
  rainCoat:       { shirt: "#1565c0" },
  woolSweater:    { shirt: "#7b4f2e" },
  wetsuitTop:     { shirt: "#1a1a2e" },
  wetsuitBottom:  { pants: "#1a1a2e" },
  snorkelMask:    { hat:   "#222" },
  divingTank:     { hat:   "#556" },   // used as a back-piece tint hint
};

export interface Appearance {
  skin: string;
  hair: string;
  shirt: string;
  pants?: string; // leg colour (defaults to denim when absent)
  hat?: string;   // head covering colour (none when absent)
  hairStyle?: "short" | "medium" | "long";
  bodyBuild?: "slight" | "medium" | "sturdy";
  breastSize?: "non" | "modest" | "expressive";
  hipSize?: "narrow" | "medium" | "wide";
  worn?: WornItems; // currently equipped items by slot (serialized with appearance)
}

// The 3-way mode switch that organises the whole game.
export type PlayerMode = "combat" | "research" | "profession";
export type Stance = "high" | "low";

export type RegionId = string;

// --- Skills -----------------------------------------------------------------
// Level = floor(sqrt(rawXP)), so early gains come fast, mastery takes real
// time. Dying costs 25% of ALL raw XP — you can slide backwards, but never to
// zero. No hard total cap: specialising is rewarded by the square-root curve
// (being level 50 in one skill costs 2500 XP; being level 10 in five costs the
// same — the maths nudge you to pick a lane without forcing it).
export const SKILL_NAMES = [
  "combat", "woodcutting", "mining", "fishing", "gardening", "swimming", "boating", "driving",
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];
export type Skills = Record<SkillName, number>; // stores raw XP
export function skillLevel(xp: number): number { return Math.floor(Math.sqrt(xp)); }
export function defaultSkills(): Skills {
  return { combat: 0, woodcutting: 0, mining: 0, fishing: 0, gardening: 0, swimming: 0, boating: 0, driving: 0 };
}

// --- Inventory --------------------------------------------------------------
export const ITEM_IDS = [
  // generic wood (for crafting when species doesn't matter)
  "wood",
  // species-specific lumber — each tree drops its own kind
  "cedarwood", "sprucewood", "firwood", "hemwood", "pinewood",
  "yewwood", "alderwood", "mapwood",
  "iron", "stone", "plank", "scrap", "rod",
  "clay", "pottery",
  "crabmeat", "fish", "liveFish", "salmon", "lingcod", "halibut", "tuna",
  "venison", "poultry", "bearMeat", "sealMeat",
  "bones", "leather",
  "berry", "cookedcrab", "cookedfish", "cookedsalmon", "cookedlingcod",
  "cookedvenison", "cookedpoultry",
  "ironBar", "shinyLure", "jerryCan",
  // weapons
  "stick", "huntingKnife", "bow", "crossbow", "speargun", "rifle",
  // ammo
  "arrow", "bolt", "spear", "bullet",
  // clothing
  "clothShirt", "clothPants", "waxedJacket", "rainCoat", "woolSweater",
  "fabricDye", "seamstressKit", "snorkelMask", "divingTank", "wetsuitTop", "wetsuitBottom",
  // research tools
  "binoculars", "butterflyNet", "listeningDevice", "fieldNotebook",
  // profession tools
  "pickaxe", "fishingCage", "surveyFlag",
] as const;
export type ItemId = (typeof ITEM_IDS)[number];
export type Inventory = Partial<Record<ItemId, number>>;
export const ITEM_LABEL: Record<ItemId, string> = {
  wood: "Wood", iron: "Iron ore", stone: "Stone", plank: "Plank", scrap: "Scrap", rod: "Rod",
  clay: "Clay", pottery: "Pottery",
  cedarwood: "Cedar wood", sprucewood: "Spruce wood", firwood: "Fir wood",
  hemwood: "Hemlock wood", pinewood: "Shore pine wood", yewwood: "Yew wood",
  alderwood: "Alder wood", mapwood: "Maple wood",
  crabmeat: "Crab meat",
  fish: "Raw fish", liveFish: "Live fish",
  salmon: "Salmon", lingcod: "Lingcod", halibut: "Halibut", tuna: "Tuna",
  venison: "Venison", poultry: "Game bird", bearMeat: "Bear meat", sealMeat: "Seal meat",
  bones: "Bones", leather: "Leather",
  berry: "Berries",
  cookedcrab: "Cooked crab", cookedfish: "Cooked fish",
  cookedsalmon: "Cooked salmon", cookedlingcod: "Cooked lingcod",
  cookedvenison: "Roast venison", cookedpoultry: "Roast game bird",
  ironBar: "Iron Bar", shinyLure: "Shiny Lure", jerryCan: "Jerry can",
  stick: "Stick", huntingKnife: "Hunting Knife", bow: "Bow", crossbow: "Crossbow",
  speargun: "Speargun", rifle: "Rifle",
  arrow: "Arrow", bolt: "Bolt", spear: "Spear", bullet: "Bullet",
  clothShirt: "Cloth Shirt", clothPants: "Cloth Pants", waxedJacket: "Waxed Jacket",
  rainCoat: "Rain Coat", woolSweater: "Wool Sweater", fabricDye: "Fabric Dye",
  seamstressKit: "Seamstress Kit", snorkelMask: "Snorkel Mask", divingTank: "Diving Tank",
  wetsuitTop: "Wetsuit Top", wetsuitBottom: "Wetsuit Bottom",
  binoculars: "Binoculars", butterflyNet: "Butterfly Net",
  listeningDevice: "Listening Device", fieldNotebook: "Field Notebook",
  pickaxe: "Pickaxe", fishingCage: "Fishing Cage", surveyFlag: "Survey Flag",
};

// What eating an item restores.
export const FOOD_VALUE: Partial<Record<ItemId, { hunger: number; hp: number }>> = {
  crabmeat:      { hunger: 9,  hp: 3  },
  fish:          { hunger: 9,  hp: 3  },
  liveFish:      { hunger: 9,  hp: 3  },
  salmon:        { hunger: 14, hp: 5  },
  lingcod:       { hunger: 18, hp: 7  },
  halibut:       { hunger: 22, hp: 10 },
  tuna:          { hunger: 28, hp: 14 },
  venison:       { hunger: 16, hp: 6  },
  poultry:       { hunger: 10, hp: 4  },
  bearMeat:      { hunger: 20, hp: 8  },
  sealMeat:      { hunger: 18, hp: 7  },
  berry:         { hunger: 15, hp: 6  },
  cookedcrab:    { hunger: 36, hp: 20 },
  cookedfish:    { hunger: 42, hp: 24 },
  cookedsalmon:  { hunger: 50, hp: 30 },
  cookedlingcod: { hunger: 58, hp: 36 },
  cookedvenison: { hunger: 55, hp: 32 },
  cookedpoultry: { hunger: 38, hp: 22 },
};
export const COOK_MAP: Partial<Record<ItemId, ItemId>> = {
  crabmeat: "cookedcrab",
  fish:     "cookedfish",
  salmon:   "cookedsalmon",
  lingcod:  "cookedlingcod",
  venison:  "cookedvenison",
  poultry:  "cookedpoultry",
};

// --- Resource nodes ---------------------------------------------------------
// Trees, ore veins, and native berry bushes — all harvest-and-respawn.
export type ResourceKind = "tree" | "ironOre" | "stoneOre" | "clayDeposit" | "berryBush";
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
  variety?: string; // berry kind label, e.g. "huckleberry", "salmonberry"
}

// Native berry varieties, for flavour/labels on berry bushes.
export const BERRY_VARIETIES = [
  "huckleberry", "salmonberry", "salal", "thimbleberry", "trailing blackberry",
] as const;

// --- Invasive plants --------------------------------------------------------
// Scotch broom, Himalayan blackberry, foxglove. They colonise CLEARCUTS (where
// a tree was just felled) and cycle young -> flowering -> seeding. Seeding
// spreads new plants. The trick (true to the real removal advice): a plant only
// dies for GOOD if you pull it while it is FLOWERING — all its energy is in the
// flower then. Clear it young or seeding and the root survives to regrow.
export type InvasiveKind = "scotchBroom" | "himalayanBlackberry" | "foxglove";
export type PlantStage = "young" | "flowering" | "seeding";
export interface PlantState {
  id: string;
  kind: InvasiveKind;
  region: RegionId;
  x: number;
  y: number;
  stage: PlantStage;
  stageUntil: number; // epoch ms when it advances to the next stage
  dormantUntil: number | null; // if cleared-but-not-killed, hidden until this time
}
export const INVASIVE_LABEL: Record<InvasiveKind, string> = {
  scotchBroom: "Scotch broom",
  himalayanBlackberry: "Himalayan blackberry",
  foxglove: "foxglove",
};

// --- Campfires --------------------------------------------------------------
export interface CampfireState {
  id: string;
  region: RegionId;
  x: number;
  y: number;
  expiresAt: number; // burns out at this time
}

// --- Furnaces ---------------------------------------------------------------
// Permanent stone forge — smelt iron ore into bars here.
export interface FurnaceState {
  id: string;
  region: RegionId;
  x: number;
  y: number;
}

// --- Crafting ---------------------------------------------------------------
export type CraftRecipeId =
  | "plank" | "rod" | "campfire" | "cook"
  | "smelt" | "furnace" | "shinyLure"
  | "repairVehicle" | "repairBuilding"
  | "pottery";

// Shared recipe data — used by server for logic AND by client for the craft panel.
export interface RecipeInfo {
  id: CraftRecipeId;
  name: string;
  needs: Partial<Record<ItemId, number>>;
  gives: Partial<Record<ItemId, number>>;
  note: string;
}

export const CRAFT_RECIPES: RecipeInfo[] = [
  { id: "plank",         name: "Plank",              needs: { wood: 3 },                gives: { plank: 1 },     note: "3 timber → 1 plank (any wood type)" },
  { id: "pottery",      name: "Pottery",             needs: { clay: 3 },                gives: { pottery: 1 },   note: "3 clay → 1 pottery vessel (fire in a furnace)" },
  { id: "rod",           name: "Fishing Rod",         needs: { wood: 3, iron: 2 },       gives: { rod: 1 },       note: "3 wood + 2 iron ore → fishing rod" },
  { id: "campfire",      name: "Campfire",             needs: { wood: 4 },                gives: {},               note: "4 wood — light a fire to cook on" },
  { id: "cook",          name: "Cook (at a fire)",     needs: {},                         gives: {},               note: "Cook raw meat/fish on a nearby fire" },
  { id: "furnace",       name: "Build Furnace",        needs: { stone: 6, iron: 2 },      gives: {},               note: "6 stone + 2 iron ore → permanent forge" },
  { id: "smelt",         name: "Smelt Iron (furnace)", needs: { iron: 2 },                gives: { ironBar: 1 },   note: "2 iron ore → 1 iron bar (stand at a furnace)" },
  { id: "shinyLure",     name: "Shiny Lure",           needs: { ironBar: 1 },             gives: { shinyLure: 1 }, note: "1 iron bar → 1 shiny lure (better fishing)" },
  { id: "repairVehicle", name: "Repair Vehicle",       needs: { plank: 2, scrap: 2 },     gives: {},               note: "2 plank + 2 scrap → +50 HP nearest vehicle" },
  { id: "repairBuilding",name: "Repair Building",      needs: { wood: 5, stone: 3 },      gives: {},               note: "5 wood + 3 stone → +80 HP nearest building" },
];

// A loot item dropped on the ground after a creature death.
export interface LootDrop {
  id: string;
  region: RegionId;
  x: number;
  y: number;
  item: ItemId;
  qty: number;
}

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
  hunger: number; // 0..maxHunger; at 0 you start starving
  maxHunger: number;
  skills: Skills;
  banfielderPts: number; // localism score, earned tackling invasive plants etc.
  rank: number; // 1 = top Banfielder (the unofficial mayor); 0 = unranked
  isMayor: boolean; // the current highest-ranked Banfielder
  inventory: Inventory;
  money: number; // dollars, for buying & selling
  team: string | null; // team/crew name (null = none)
  appearance: Appearance;
  swimming: boolean;
  dodging: boolean; // brief lunge with i-frames (client renders a streak)
  fishing: boolean; // currently fishing (rod cast)
  sleeping: boolean; // resting by a fire to heal (vulnerable, can't move)
  vehicleId: string | null; // id of the vehicle being driven, else null
  dead: boolean;
  equipped: ItemId | null; // currently wielded weapon (null = bare hands)
  titles: string[]; // earned community roles (Mayor, BMSC President, Nurse, ...)
  speedBoosted: boolean; // /give wings active — 5× speed
  // --- Modes & grappling ---
  mode: PlayerMode;        // combat / research / profession
  stance: Stance;          // combat stance (high = punch, low = kick)
  transforming: boolean;   // mid mode-switch (2 s strip + re-clothe animation)
  grabbing: string | null; // id of the player/creature I'm currently holding
  grabbedBy: string | null;// id of whoever is holding me
  spin: number;            // 0..1 helicopter wind-up while holding someone
  knockedOut: boolean;     // dizzy/down phase after being thrown
  blocking: boolean;       // briefly raising a block
  hiding: boolean;         // hidden behind a tree/bush
  playingDead: boolean;    // playing dead (research mode vs bears)
  jumping: boolean;        // in the air
  jumpPhase: number;       // 0..1 arc
  listenMode: boolean;     // research "listen" posture active
}

export type CreatureKind =
  // --- marine ---
  | "crab"       // low tide, land, swarms structures
  | "octopus"    // either tide
  | "dogfish"    // high tide shark
  | "sixgill"    // high tide bigger shark
  | "orca"       // high tide apex — very rare, sometimes in pods
  | "humpback"   // neutral whale
  | "greywhale"  // neutral whale
  | "seal"       // common, friendly, follows slow swimmers
  | "sealLion"   // common, playful, hauls out on rocks
  | "seaOtter"   // rare, curious, hides when approached
  // --- land ---
  | "deer"       // prey, flees from players
  | "elk"        // prey, large, flees
  | "grouse"     // prey bird, spooks at close range
  | "bear"       // dangerous, attacks if provoked or surprised
  | "cougar"     // stealth predator, dangerous
  | "wolf";      // pack hunter, bold

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
  fuel: number;
  maxFuel: number;
  driverId: string | null; // player currently driving, else null
}

// --- Economy ----------------------------------------------------------------
// A shop is attached to a building. `buys` lists what the shop will pay you for
// (per unit), `sells` lists what you can buy (per unit). Prices are in dollars.
export interface ShopOffer {
  item: ItemId;
  price: number;
}
export interface ShopDef {
  name: string;
  buys: ShopOffer[];
  sells: ShopOffer[];
}

export const STARTING_MONEY = 20;

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
  shop?: ShopDef; // present if you can trade here
  name?: string;  // real-world name from OSM (e.g. "Flora's Restaurant")
}

// --- NPCs -------------------------------------------------------------------
export type NpcKind = "naturalist" | "pirate" | "scientist" | "westsider" | "eastsider" | "huuayaht" | "mayor" | "historian" | "boatdealer" | "icevendor" | "seamstress" | "researcher2" | "marineBiologist" | "snorkeler";

export interface NpcState {
  id: string;
  kind: NpcKind;
  region: RegionId;
  x: number;
  y: number;
}

// --- Travel between regions -------------------------------------------------
// A travel node is a pad you stand on and activate to move *yourself* (on foot)
// to another region — vehicles stay behind. Catch the scheduled bus at the
// market, or walk through the gate at the road's end up Bamfield Main.
// Kinds: bus (foot), gate (foot), sea (a stretch of open water — drive a boat
// into it to cross to the neighbouring region, boat and all).
export interface TravelNode {
  id: string;
  kind: "bus" | "gate" | "sea";
  x: number; // top-left tile
  y: number;
  w: number;
  h: number;
  label: string; // e.g. "Catch the bus to Anacla"
  toRegion: RegionId;
  toSpawn: { x: number; y: number };
  fare?: number; // dollars charged to ride (bus only); omitted/0 = free
}

// Static, per-region info the client needs once on entry.
export interface RegionInfo {
  id: RegionId;
  name: string;
  width: number;
  height: number;
  overview: OverviewMap;   // downsampled whole map for the minimap
  travelNodes: TravelNode[];
}

// --- Messages: client -> server --------------------------------------------
// One logged species in a player's BMSC logbook.
export interface LogbookEntry { key: string; count: number; firstAt: number }

// Town leaderboard / current title holders.
export interface LeaderboardData {
  mayor: string | null;       // unofficial mayor (top Banfielder points)
  president: string | null;   // BMSC President (most species logged)
  chief: string | null;       // Fire Chief (most building repairs)
  nurse: string | null;       // Nurse (top first responder)
  responders: string[];       // other first responders (max 5)
  topBanfielders: Array<{ name: string; pts: number }>;
}

export type ClientMessage =
  | { t: "join"; name: string; appearance: Appearance; secret?: string; register?: boolean; email?: string }
  | { t: "checkName"; name: string } // login screen: is this name already taken?
  | { t: "scan" } // fire the discovery radius — log nearby species
  | { t: "equip"; item: ItemId | null } // wield a weapon (null = bare hands)
  | { t: "wear"; slot: WornSlot; item: ItemId | null } // put on / take off a clothing or tool item
  | { t: "heal" } // patch up the nearest hurt player (uses cooked food)
  | { t: "input"; dx: number; dy: number; sprint?: boolean } // intended direction, each -1..1
  | { t: "attack"; charge?: number } // charge 0..1 from how long Space was held
  | { t: "dodge" } // quick lunge + i-frames in the current heading
  | { t: "setMode"; mode: PlayerMode } // switch combat/research/profession (2 s transform)
  | { t: "setStance"; stance: Stance } // combat: high (punch) / low (kick)
  | { t: "grab" } // lunge to seize a target ahead (combat mode)
  | { t: "throwGrab" } // release + fling whoever you're holding
  | { t: "block" } // momentary block (break a grab in high stance; soften strikes)
  | { t: "board" } // get in / out of the nearest vehicle
  | { t: "harvest" } // chop/mine/forage nearest resource node, or pull invasive plant
  | { t: "craft"; recipe: CraftRecipeId } // craft (recipe validated server-side)
  | { t: "fish" } // toggle fishing on/off (needs rod in inventory)
  | { t: "eat"; item?: ItemId } // consume food (specific item, else best) for hunger/HP
  | { t: "drop"; item: ItemId; all?: boolean } // drop 1 (or all) of an item on the ground
  | { t: "drink" } // sip from an adjacent freshwater lake (a little hunger back)
  | { t: "sleep" } // toggle resting by a fire to heal
  | { t: "chat"; msg: string } // text; / global, // team, ///name private
  | { t: "repair" }
  | { t: "trade"; buildingId: string; kind: "buy" | "sell"; item: ItemId; qty: number }
  | { t: "travel" }
  | { t: "refuel" }
  | { t: "hide" }         // toggle hiding behind a tree/bush
  | { t: "playDead" }     // toggle play dead (research only)
  | { t: "jump" }         // jump
  | { t: "listen" };      // research listen mode toggle

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
  plants: PlantState[];
  campfires: CampfireState[];
  furnaces: FurnaceState[];
  npcs: NpcState[];
  lootDrops: LootDrop[];
}

export type ServerMessage =
  // Sent on join AND whenever the player changes region (the map swaps).
  | { t: "init"; id: string; region: RegionInfo; snapshot: Snapshot }
  | { t: "snapshot"; snapshot: Snapshot }
  // A streamed map block: tiles/elevation for chunk (cx,cy), w×h tiles, with
  // top-left at (cx*CHUNK, cy*CHUNK). `region` lets the client drop stale
  // chunks that arrive after a region change.
  | { t: "chunk"; region: RegionId; cx: number; cy: number; w: number; h: number; tiles: number[]; elevation: number[] }
  | { t: "log"; msg: string }
  | { t: "logbook"; entries: LogbookEntry[] } // your BMSC logbook contents
  | { t: "leaderboard"; data: LeaderboardData } // current town title holders
  // A transient visual effect (e.g. a ranged-shot tracer) for clients to draw.
  | { t: "fx"; kind: "tracer"; region: RegionId; x1: number; y1: number; x2: number; y2: number; weapon: string }
  // A melee swing — clients animate the attacker's arm/leg thrust for ~250 ms.
  | { t: "fx"; kind: "melee"; region: RegionId; id: string; stance: Stance; weapon: string | null }
  // Login screen support: live name-availability + a rejected sign-in.
  | { t: "nameStatus"; name: string; taken: boolean }
  | { t: "joinDenied"; reason: string }
  | { t: "chat"; from: string; msg: string; channel: "global" | "team" | "private" };

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
