import {
  Appearance,
  WornItems,
  SLOT_FOR_ITEM,
  CLOTHING_COLOR,
  WornSlot,
  BuildingState,
  CampfireState,
  FurnaceState,
  COOK_MAP,
  CRAFT_RECIPES,
  ClientMessage,
  CraftRecipeId,
  CreatureKind,
  CreatureState,
  FOOD_VALUE,
  INVASIVE_LABEL,
  ITEM_IDS,
  ITEM_LABEL,
  Inventory,
  InvasiveKind,
  ItemId,
  LootDrop,
  NpcState,
  PlantStage,
  PlantState,
  PlayerMode,
  PlayerState,
  RegionId,
  ResourceNode,
  ServerMessage,
  SKILL_NAMES,
  SkillName,
  Snapshot,
  LeaderboardData,
  Tile,
  TravelNode,
  VehicleState,
  WorldMap,
  OverviewMap,
  CHUNK,
  TIDE_CYCLE_MS,
  WATERLINE_LOW,
  WATERLINE_HIGH,
  KING_TIDE_SURGE,
  TSUNAMI_SURGE,
  STARTING_MONEY,
  DEPTH_ANKLE,
  DEPTH_SWIM,
  DEPTH_DEEP,
  DEPTH_OCEAN,
  defaultSkills,
  skillLevel,
  submergedAt,
  isWaterTile,
  phaseForTide,
  RoomDef,
  RoomTile,
} from "../shared/protocol";
import { DEFAULT_REGION, PlantDef, RegionDef, ResourceNodeDef, buildRegions } from "../shared/map";
import { SPECIES, resourceSpeciesKey } from "../shared/species";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  DB?: D1Database; // optional so the game still runs where D1 isn't bound
}

interface Session {
  ws: WebSocket;
  playerId: string;
  dx: number; // last input direction, normalized to length <= 1
  dy: number;
  lastAttack: number; // timestamp of last swing (for cooldown)
  lastDodge: number; // timestamp of last dodge (for cooldown)
  lastHarvest: number; // debounce resource harvesting
  iframeUntil: number; // dodge i-frames: no damage taken until this time
  travelCdUntil: number; // brief cooldown after a region change (stops ping-pong)
  sprint: boolean; // shift held — run faster but drain stamina / burn more fuel
  sentChunks: Set<string>; // map chunks already streamed to this connection
  chunkRegion: RegionId | null; // region those chunks belong to (reset on travel)
}

// Server-side vehicle adds rust tracking (not sent to clients).
interface VehicleRecord extends VehicleState {
  lastDriven: number; // epoch ms of last time a player drove this
}

// A region's live, mutable state (its static def lives in shared/map.ts).
interface Region {
  id: RegionId;
  name: string;
  map: WorldMap;
  buildings: BuildingState[];
  spawn: { x: number; y: number };
  travelNodes: TravelNode[];
}

const TICK_MS = 100; // server simulation step (10 Hz)
const PLAYER_SPEED = 4.5; // tiles per second on land
const SWIM_SPEED = 2.4; // tiles per second in water
const SPRINT_MULT = 1.85; // sprint speed multiplier (Shift key)
const SPRINT_STAMINA_DRAIN = 18; // stamina/sec drained while sprinting
const THROTTLE_MULT = 1.6; // boat/car throttle multiplier (Shift while driving)
const THROTTLE_FUEL_MULT = 2.2; // extra fuel burn when throttling
const PLAYER_MAX_HP = 100;

// Combat is stamina-gated so it rewards timing over button-mashing.
const ATTACK_ARC = Math.PI * 0.6; // melee: must be roughly facing the target
const ATTACK_KNOCKBACK = 5; // default impulse applied to a struck target
const CHARGE_BONUS = 1.6; // a full charge adds this fraction to dmg/range/kb

// --- Weapons ----------------------------------------------------------------
interface WeaponStat {
  melee: boolean;
  damage: number;
  range: number;        // tiles (melee reach / ranged max distance)
  cooldownMs: number;
  stamina: number;
  arc?: number;         // melee swing half-arc (radians)
  knockback?: number;
  ammo?: ItemId;        // ranged: item consumed per shot
  marineBonus?: number; // damage multiplier vs marine creatures (speargun)
}
const FIST: WeaponStat = { melee: true, damage: 6, range: 1.3, cooldownMs: 420, stamina: 5, arc: ATTACK_ARC, knockback: 4 };
// High stance = a quick punch; low stance = a slower, harder kick with shove.
const PUNCH: WeaponStat = { melee: true, damage: 7, range: 1.2, cooldownMs: 360, stamina: 5, arc: ATTACK_ARC, knockback: 5 };
const KICK:  WeaponStat = { melee: true, damage: 9, range: 1.5, cooldownMs: 560, stamina: 8, arc: ATTACK_ARC, knockback: 11 };
const WEAPONS: Partial<Record<ItemId, WeaponStat>> = {
  stick:        { melee: true,  damage: 9,  range: 1.6, cooldownMs: 360, stamina: 6,  arc: ATTACK_ARC,        knockback: 5 },
  huntingKnife: { melee: true,  damage: 18, range: 1.3, cooldownMs: 300, stamina: 7,  arc: Math.PI * 0.45,    knockback: 4 },
  speargun:     { melee: false, damage: 26, range: 7,   cooldownMs: 1100, stamina: 9,  ammo: "spear",  knockback: 6, marineBonus: 1.7 },
  bow:          { melee: false, damage: 20, range: 9,   cooldownMs: 780,  stamina: 8,  ammo: "arrow",  knockback: 4 },
  crossbow:     { melee: false, damage: 34, range: 10,  cooldownMs: 1400, stamina: 10, ammo: "bolt",   knockback: 6 },
  rifle:        { melee: false, damage: 55, range: 16,  cooldownMs: 1600, stamina: 6,  ammo: "bullet", knockback: 8 },
};
const WEAPON_ITEMS: ItemId[] = ["stick", "huntingKnife", "bow", "crossbow", "speargun", "rifle"];
const HIT_KNOCKBACK = 5; // impulse applied to a player who gets hit
const KB_FRICTION = 6; // how fast knockback decays per second
const MAX_STAMINA = 100;
const STAMINA_REGEN = 24; // per second
const DODGE_STAMINA = 34; // stamina a dodge costs
const DODGE_COOLDOWN_MS = 650;
const DODGE_IMPULSE = 14; // lunge speed (tiles/sec) at the start of a dodge
const DODGE_IFRAMES_MS = 360; // invulnerability window during a dodge
const REPAIR_RATE = 25; // hp per second
const CREATURE_CAP_PER_REGION = 10; // sparse — wildlife is rare, sightings are special
const SPAWN_INTERVAL_MS = 8000; // slower fill so the world feels alive but not crowded
const SPAWN_BATCH = 1; // one creature per pass — keeps density low
const VIEW_RADIUS = 55; // tiles: interest-management radius for dense entities

// Swimming & drowning --------------------------------------------------------
const SWIM_STAMINA_DRAIN = 9;   // stamina/sec while actively swimming in deep water
const SWIM_TIRED_MULT = 0.55;   // speed multiplier once stamina is gone
const FLOAT_GRACE_MS = 180_000; // you can float in deep water this long before drowning
const DROWN_DPS = 7;            // hp/sec lost once you've floated past the grace period
const DROWN_DPS_TIRED = 12;     // faster if you're also out of stamina

// Natural disaster rarity (seeded daily check) --------------------------------
// Uses a deterministic hash of the calendar day so events are reproducible and
// the server only rolls once per day rather than every 60 s.
// King tide: ~1/15 days = ~twice a month of server uptime.
// Tsunami:  ~1/365 days = ~once per real year (OSRS 3rd-age rare).
const KING_TIDE_DAILY_P = 1 / 15;
const TSUNAMI_DAILY_P   = 1 / 365;

// Vehicles -------------------------------------------------------------------
const CAR_SPEED = 7.5; // tiles/sec on a road
const CAR_OFFROAD_SPEED = 3.0; // sluggish on grass/sand
const BOAT_SPEED = 5.5; // tiles/sec on water
const VEHICLE_BOARD_RANGE = 1.6; // how close you must be to board
const VEHICLE_MAX_HP = 200;
const VEHICLE_FUEL_MAX = 100; // a full tank
const FUEL_DRAIN = 100 / (20 * 60); // empties in ~20 min of steady driving
const RUST_START_MS = 20 * 60 * 1000; // idle this long before rusting
const RUST_DPS = 200 / (40 * 60); // destroys a full-HP vehicle in ~40 min
const COLLISION_RANGE = 0.85; // tiles; how close before a moving vehicle hits
const COLLISION_MIN_SPEED = 2.0; // only dangerous above this tile/s threshold

// Resources & crafting -------------------------------------------------------
const HARVEST_RANGE = 1.8; // tiles from resource node centre
const HARVEST_COOLDOWN_MS = 700; // min time between harvest presses
const TREE_MAX_HP = 5; // hits to fell a tree (each gives wood)
const ORE_MAX_HP = 4; // hits to exhaust an ore vein
const BERRY_MAX_HP = 3; // pickings per berry bush before it's bare
const TREE_RESPAWN_MS = 3 * 60 * 1000; // 3 minutes
const ARBUTUS_RESPAWN_MS = 15 * 60 * 1000; // arbutus is slow-growing & rare
const ORE_RESPAWN_MS = 8 * 60 * 1000; // 8 minutes
const BERRY_RESPAWN_MS = 2 * 60 * 1000; // 2 minutes — berries come back fast
const MINING_LEVEL_REQ_IRON = 5; // need Mining 5 to extract iron
const COOK_RANGE = 2.0; // tiles from a campfire to cook
const CAMPFIRE_BURN_MS = 4 * 60 * 1000; // a campfire lasts 4 minutes

// Health scaling -------------------------------------------------------------
// Your max HP grows with who you ARE: social standing (Banfielder rank),
// toughness in a fight (combat), endurance (woodcutting+mining grind), and how
// strong a swimmer you are. A fresh settler has BASE_HP; a decorated local can
// have well over double.
const BASE_HP = 100;
const HP_PER_COMBAT = 3;
const HP_PER_SWIM = 2;
const HP_PER_ENDURANCE = 1; // per level of (woodcutting+mining)/2, the "grind"
const HP_MAYOR_BONUS = 50; // the unofficial mayor is the hardiest local
const HP_RANK_BONUS = [0, 50, 30, 20, 12, 8]; // by rank position (1-indexed)
const RANK_RECOMPUTE_MS = 5000;

// Sleeping by a fire to heal.
const SLEEP_HEAL_PS = 6; // hp/sec while resting by a fire
const SLEEP_FIRE_RANGE = 2.2;

// Hunger ---------------------------------------------------------------------
const MAX_HUNGER = 100;
const HUNGER_DECAY = 100 / (20 * 60); // empties in ~20 min standing still
const HUNGER_WORK_EXTRA = 0.04; // a little extra drain/sec while actively moving (~14 min if always running)
const STARVE_DPS = 1.5; // hp/sec lost at 0 hunger (you've got time to find food)

// Invasive plants ------------------------------------------------------------
const PLANT_CAP_PER_REGION = 14; // stop runaway spread
const PLANT_YOUNG_MS = 50 * 1000; // young -> flowering
const PLANT_FLOWER_MS = 35 * 1000; // flowering -> seeding
const PLANT_SEED_MS = 12 * 1000; // seeding -> back to young (and spreads)
const PLANT_REGROW_MS = 60 * 1000; // root regrows if cleared while not flowering
const CLEARCUT_INVASIVE_CHANCE = 0.45; // chance an invasive sprouts where a tree fell

// Banfielder localism points + gardening XP for plant control.
const PTS_KILL_FLOWERING = 10; // permanent kill while flowering — the good outcome
const PTS_CLEAR_OTHER = 1; // cutting it young/seeding only sets it back
const XP_GARDEN_KILL = 60;
const XP_GARDEN_CLEAR = 12;
const XP_FORAGE = 12; // per berry picked (gardening)

// XP awards ------------------------------------------------------------------
const XP_CHOP = 15; // per hit on a tree
const XP_MINE = 20; // per hit on an ore vein
const XP_KILL_PER_HP = 0.5; // per HP of killed creature
const XP_SWIM_PER_SEC = 0.4;
const XP_BOAT_PER_SEC = 0.6;
const XP_DRIVE_PER_SEC = 0.5;
const XP_FISH = 30; // per successful catch
const DEATH_XP_LOSS = 0.25; // base fraction of raw XP lost on death (randomized per skill)
const DEATH_PTS_LOSS = 0.35; // fraction of Banfielder points lost on death

// Fishing --------------------------------------------------------------------
const FISHING_TIME_MS = 5000; // base wait time; reduced by fishing level
const FISHING_ROD_REQUIRED = true;

// Map tree variety → species-specific wood item.
function treeWoodItem(variety?: string): ItemId {
  switch (variety) {
    case "redcedar":     return "cedarwood";
    case "sitkaspruce":  return "sprucewood";
    case "douglasfir":   return "firwood";
    case "hemlock":      return "hemwood";
    case "shorepine":    return "pinewood";
    case "yew":          return "yewwood";
    case "redalder":     return "alderwood";
    case "bigleafmaple": return "mapwood";
    default:             return "wood";
  }
}

// Loot table -----------------------------------------------------------------
function rollLoot(kind: CreatureKind): Array<{ item: ItemId; qty: number }> {
  const drops: Array<{ item: ItemId; qty: number }> = [];
  const r = Math.random;
  switch (kind) {
    case "crab":
      if (r() < 0.85) drops.push({ item: "crabmeat", qty: 1 });
      if (r() < 0.5)  drops.push({ item: "bones", qty: 1 });
      break;
    case "octopus":
      if (r() < 0.6)  drops.push({ item: "fish", qty: 1 });
      if (r() < 0.3)  drops.push({ item: "bones", qty: 1 });
      break;
    case "dogfish":
      drops.push({ item: "fish", qty: 1 + (r() < 0.6 ? 1 : 0) });
      if (r() < 0.5)  drops.push({ item: "bones", qty: 1 });
      if (r() < 0.4)  drops.push({ item: "leather", qty: 1 });
      break;
    case "sixgill":
      drops.push({ item: "lingcod", qty: 1 });
      drops.push({ item: "bones", qty: 1 + (r() < 0.5 ? 1 : 0) });
      if (r() < 0.55) drops.push({ item: "leather", qty: 1 });
      break;
    case "orca":
      drops.push({ item: "fish", qty: 2 });
      drops.push({ item: "sealMeat", qty: 1 });
      drops.push({ item: "bones", qty: 2 });
      if (r() < 0.7)  drops.push({ item: "leather", qty: 2 });
      break;
    case "seal":
      drops.push({ item: "sealMeat", qty: 1 + (r() < 0.5 ? 1 : 0) });
      if (r() < 0.6)  drops.push({ item: "bones", qty: 1 });
      if (r() < 0.7)  drops.push({ item: "leather", qty: 1 });
      break;
    case "sealLion":
      drops.push({ item: "sealMeat", qty: 2 });
      drops.push({ item: "bones", qty: 1 });
      if (r() < 0.8)  drops.push({ item: "leather", qty: 1 + (r() < 0.5 ? 1 : 0) });
      break;
    // Land prey
    case "deer":
      drops.push({ item: "venison", qty: 1 + (r() < 0.5 ? 1 : 0) });
      if (r() < 0.7)  drops.push({ item: "bones", qty: 1 });
      if (r() < 0.55) drops.push({ item: "leather", qty: 1 });
      break;
    case "elk":
      drops.push({ item: "venison", qty: 2 + (r() < 0.6 ? 1 : 0) });
      drops.push({ item: "bones", qty: 1 + (r() < 0.6 ? 1 : 0) });
      if (r() < 0.7)  drops.push({ item: "leather", qty: 1 + (r() < 0.4 ? 1 : 0) });
      break;
    case "grouse":
      drops.push({ item: "poultry", qty: 1 });
      if (r() < 0.6)  drops.push({ item: "bones", qty: 1 });
      break;
    case "bear":
      drops.push({ item: "bearMeat", qty: 2 + (r() < 0.5 ? 1 : 0) });
      drops.push({ item: "bones", qty: 1 + (r() < 0.6 ? 1 : 0) });
      drops.push({ item: "leather", qty: 1 + (r() < 0.5 ? 1 : 0) });
      break;
    case "cougar":
      drops.push({ item: "venison", qty: 1 });
      drops.push({ item: "bones", qty: 1 });
      if (r() < 0.8)  drops.push({ item: "leather", qty: 1 });
      break;
    case "wolf":
      if (r() < 0.6)  drops.push({ item: "venison", qty: 1 });
      drops.push({ item: "bones", qty: 1 });
      if (r() < 0.5)  drops.push({ item: "leather", qty: 1 });
      break;
    default: break; // neutrals (whales, seaOtter) — discourage killing
  }
  return drops;
}

export class GameRoom {
  private sessions = new Map<WebSocket, Session>();

  private regions = new Map<RegionId, Region>();
  private players = new Map<string, PlayerState>();
  private creatures = new Map<string, CreatureState>();
  private vehicles = new Map<string, VehicleRecord>();
  private resourceNodes = new Map<string, ResourceNode>();
  // Static spatial index of resource nodes (they never move), so the per-tick
  // snapshot only scans nodes near each viewer instead of all 50k+ of them.
  private nodeBuckets = new Map<string, ResourceNode[]>();
  // Only currently-depleted nodes that will regrow — the respawn loop scans
  // just these, not every node in the world.
  private depletedNodeIds = new Set<string>();
  private plants = new Map<string, PlantState>();
  private campfires = new Map<string, CampfireState>();
  private furnaces  = new Map<string, FurnaceState>();
  private npcs: NpcState[] = [];
  // playerId → timestamp when they cast their line (null = not fishing)
  private fishingStates = new Map<string, number>();
  // playerId → epoch ms a live fish was caught (dies → raw fish after 60s)
  private liveFishTimer = new Map<string, number>();
  // vehicleId → last time we warned the driver it's out of fuel (rate-limit)
  private lastFuelWarn = new Map<string, number>();
  // Transient knockback impulses by entity id (players + creatures).
  private kb = new Map<string, { x: number; y: number }>();
  // playerId → epoch ms they entered deep water (for the float/drown timer).
  private deepSince = new Map<string, number>();
  private lastDrink = new Map<string, number>(); // throttle freshwater sips
  private speedBoostUntil = new Map<string, number>(); // playerId → boost expiry ms
  private lootDrops = new Map<string, LootDrop>(); // ground loot waiting to be picked up
  // --- Hide / play-dead / jump / listen ---
  private hidingAt = new Map<string, { x: number; y: number }>(); // playerId → hiding pos
  private playDeadUntil = new Map<string, number>();               // auto-cancel timer
  private jumpUntil = new Map<string, number>();                   // jump arc end time
  private npcWander = new Map<string, { homeX: number; homeY: number; targetX: number; targetY: number; nextMoveAt: number; radius: number }>();
  // Training dummies: fake players spawned with /dummy. playerId → expiry epoch ms.
  private dummies = new Map<string, number>();
  // --- Modes & grappling timing (server-only) ---
  private baseAppearance = new Map<string, Appearance>();      // chosen colours per player
  private modeWardrobe = new Map<string, Partial<Record<PlayerMode, Appearance>>>(); // saved per-mode look
  private transformUntil = new Map<string, number>();          // mode-switch animation lock
  private grabCdUntil = new Map<string, number>();             // grab cooldown
  private knockoutUntil = new Map<string, number>();           // dizzy/down phase
  private blockUntil = new Map<string, number>();              // active block window
  private prevDx = new Map<string, number>();                  // last horizontal input (spin detection)
  // accountName → logbook: speciesKey → { count (encounters), firstAt }.
  private discoveries = new Map<string, Record<string, { count: number; firstAt: number }>>();
  // Role tallies, keyed by player name (live this session).
  private repairsBy = new Map<string, number>(); // building repairs → Fire Chief
  private healsBy = new Map<string, number>();    // heals given → Nurse / responders
  private chiefId: string | null = null;
  private presidentId: string | null = null;
  private nurseId: string | null = null;

  private startedAt = Date.now();
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private nextSpawn = 0;
  private idCounter = 0;

  private event: "none" | "king" | "tsunami" = "none";
  private eventUntil = 0;
  private nextEventCheck = Date.now() + 60_000;
  private lastEventDayKey = -1;
  private nextRankCheck = 0;
  private mayorId: string | null = null;
  private godPlayers = new Set<string>(); // admin god-mode (testing only)

  private env: Env;
  private nextSave = 0;                       // periodic autosave timer
  private savedNames = new Map<string, string>(); // playerId → db name (claimed account)
  // Interior rooms: one room per building, generated on first enter.
  private rooms = new Map<string, RoomDef>();  // buildingId → room definition
  private playerInRoom = new Map<string, string>(); // playerId → buildingId

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
    const now = Date.now();
    for (const def of buildRegions()) {
      this.regions.set(def.id, this.toRegion(def));
      for (const v of def.vehicles) {
        this.vehicles.set(v.id, {
          id: v.id, kind: v.kind, region: def.id,
          x: v.x + 0.5, y: v.y + 0.5, dir: 0,
          hp: VEHICLE_MAX_HP, maxHp: VEHICLE_MAX_HP,
          fuel: VEHICLE_FUEL_MAX, maxFuel: VEHICLE_FUEL_MAX,
          driverId: null, lastDriven: now,
        });
      }
      for (const n of def.resourceNodes) {
        const node = this.mkNode(n, def.id);
        this.resourceNodes.set(n.id, node);
        this.indexNode(node);
      }
      for (const pl of def.plants) {
        this.plants.set(pl.id, this.mkPlant(pl, def.id, now));
      }
    }
    // Forges live at the gas bars. Look the spots up by building so they track
    // the imported map at any scale (no more stale hand-typed coordinates).
    const bf = this.regions.get("bamfield");
    if (bf) {
      const gas = this.buildingAnchor(bf, "gas") ?? this.buildingAnchor(bf, "ostrom") ?? bf.spawn;
      this.furnaces.set("forge-ostroms", { id: "forge-ostroms", region: "bamfield", x: gas.x, y: gas.y });
      // It's one world now — Anacla is the SE corner of Bamfield. The second
      // forge sits by the Anacla bus stop.
      const an = this.anaclaAnchor();
      this.furnaces.set("forge-anacla", { id: "forge-anacla", region: "bamfield", x: an.x, y: an.y });
    }

    // Static townsfolk — flavour, lore, and local hints. They don't move.
    this.placeNpcs();
  }

  // Place locals next to the real landmarks they belong to, so they land in the
  // populated town no matter how the imported map is shaped (positions are
  // looked up from building names, with a fall-back to the region spawn).
  private placeNpcs() {
    // `near` is a building name/id substring; `atAnacla` pins the NPC by the
    // Anacla bus stop (it's the SE corner of the one big Bamfield world now).
    const cfg: Array<{ id: string; kind: NpcState["kind"]; region: RegionId; near?: string; atAnacla?: boolean }> = [
      { id: "npc-naturalist",  kind: "naturalist",     region: "bamfield", near: "Marine Sciences" },
      { id: "npc-scientist",   kind: "scientist",      region: "bamfield", near: "Whale Lab" },
      { id: "npc-historian",   kind: "historian",      region: "bamfield", near: "Mercantile" },
      { id: "npc-pirate",      kind: "pirate",         region: "bamfield", near: "Breakers" },
      { id: "npc-boatdealer",  kind: "boatdealer",     region: "bamfield", near: "Breakers" },
      { id: "npc-eastsider",   kind: "eastsider",      region: "bamfield", near: "East Dock" },
      { id: "npc-westsider",   kind: "westsider",      region: "bamfield", near: "West Dock" },
      { id: "npc-mayor",       kind: "mayor",          region: "bamfield", atAnacla: true },
      { id: "npc-huuayaht",    kind: "huuayaht",       region: "bamfield", near: "Huu-ay-aht" },
      { id: "npc-icevendor",   kind: "icevendor",      region: "bamfield", atAnacla: true },
      { id: "npc-seamstress",  kind: "seamstress",     region: "bamfield", near: "East Dock" },
      { id: "npc-researcher2", kind: "researcher2",    region: "bamfield", near: "Marine Sciences" },
      { id: "npc-marinebio",   kind: "marineBiologist",region: "bamfield" },
      { id: "npc-snorkeler",   kind: "snorkeler",      region: "bamfield", near: "West Dock" },
    ];
    this.npcs = [];
    for (let i = 0; i < cfg.length; i++) {
      const c = cfg[i];
      const region = this.regions.get(c.region);
      if (!region) continue;
      let tx = region.spawn.x, ty = region.spawn.y;
      if (c.atAnacla) {
        const a = this.anaclaAnchor();
        tx = a.x; ty = a.y;
      } else if (c.near) {
        const a = this.buildingAnchor(region, c.near);
        if (a) { tx = a.x; ty = a.y; }
      }
      const spot = this.landSpawn(region, tx + ((i % 3) - 1), ty + (i % 2));
      const nx = Math.floor(spot.x), ny = Math.floor(spot.y);
      this.npcs.push({ id: c.id, kind: c.kind, region: c.region, x: nx, y: ny });
      // Set up wandering zone for this NPC.
      const wanderRadius: Record<string, number> = {
        naturalist: 8, scientist: 6, historian: 5, pirate: 12, boatdealer: 6,
        eastsider: 10, westsider: 12, mayor: 40, huuayaht: 8, icevendor: 5,
        seamstress: 25, researcher2: 30, marineBiologist: 20, snorkeler: 15,
      };
      const radius = wanderRadius[c.kind] ?? 8;
      this.npcWander.set(c.id, { homeX: nx, homeY: ny, targetX: nx, targetY: ny, nextMoveAt: Date.now() + Math.random() * 5000 + 3000, radius });
    }
  }

  // A walkable tile just off a building matched by name/id substring.
  private buildingAnchor(region: Region, key: string): { x: number; y: number } | null {
    const k = key.toLowerCase();
    const b = region.buildings.find(
      (b) => (b.name || "").toLowerCase().includes(k) || b.id.toLowerCase().includes(k),
    );
    if (!b) return null;
    return { x: b.x + Math.floor(b.w / 2), y: b.y + b.h + 1 };
  }

  // The Anacla end of the bus line, in the big Bamfield map. Falls back to the
  // gas bar, then the map centre.
  private anaclaAnchor(): { x: number; y: number } {
    const bf = this.regions.get("bamfield");
    if (bf) {
      const bus = bf.travelNodes.find((n) => n.id === "bf-bus-anacla");
      if (bus) return { x: bus.toSpawn.x, y: bus.toSpawn.y };
      return { x: Math.floor(bf.map.width / 2), y: Math.floor(bf.map.height / 2) };
    }
    return { x: 0, y: 0 };
  }

  // --- resource-node spatial index (16-tile buckets) ------------------------
  private static readonly NODE_BUCKET = 16;
  private nodeBucketKey(region: string, x: number, y: number): string {
    const b = GameRoom.NODE_BUCKET;
    return region + "|" + Math.floor(x / b) + "|" + Math.floor(y / b);
  }
  private indexNode(n: ResourceNode) {
    const k = this.nodeBucketKey(n.region, n.x, n.y);
    let arr = this.nodeBuckets.get(k);
    if (!arr) { arr = []; this.nodeBuckets.set(k, arr); }
    arr.push(n);
  }
  private nodesNear(region: string, x: number, y: number, radius: number): ResourceNode[] {
    const b = GameRoom.NODE_BUCKET;
    const out: ResourceNode[] = [];
    const minbx = Math.floor((x - radius) / b), maxbx = Math.floor((x + radius) / b);
    const minby = Math.floor((y - radius) / b), maxby = Math.floor((y + radius) / b);
    const r2 = radius * radius;
    for (let bx = minbx; bx <= maxbx; bx++) {
      for (let by = minby; by <= maxby; by++) {
        const arr = this.nodeBuckets.get(region + "|" + bx + "|" + by);
        if (!arr) continue;
        for (const n of arr) if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r2) out.push(n);
      }
    }
    return out;
  }

  private mkNode(def: ResourceNodeDef, regionId: string): ResourceNode {
    const maxHp =
      def.kind === "tree" ? TREE_MAX_HP : def.kind === "berryBush" ? BERRY_MAX_HP : ORE_MAX_HP;
    return {
      id: def.id, kind: def.kind, region: regionId,
      x: def.x, y: def.y, hp: maxHp, maxHp, depleted: false, respawnAt: null,
      variety: def.variety,
    };
  }

  private mkPlant(def: PlantDef, regionId: string, now: number): PlantState {
    return {
      id: def.id, kind: def.kind, region: regionId,
      x: def.x, y: def.y, stage: "young",
      stageUntil: now + PLANT_YOUNG_MS, dormantUntil: null,
    };
  }

  private toRegion(def: RegionDef): Region {
    return {
      id: def.id,
      name: def.name,
      map: def.map,
      buildings: def.buildings,
      spawn: def.spawn,
      travelNodes: def.travelNodes,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    pair[1].accept();
    this.onConnect(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // --- connection lifecycle -------------------------------------------------
  private onConnect(ws: WebSocket) {
    const playerId = `p${this.idCounter++}`;
    this.sessions.set(ws, { ws, playerId, dx: 0, dy: 0, lastAttack: 0, lastDodge: 0, lastHarvest: 0, iframeUntil: 0, travelCdUntil: 0, sprint: false, sentChunks: new Set(), chunkRegion: null });
    ws.addEventListener("message", (ev) => {
      try {
        this.onMessage(ws, JSON.parse(ev.data as string) as ClientMessage);
      } catch {
        /* ignore malformed frames */
      }
    });
    const drop = () => this.onDisconnect(ws);
    ws.addEventListener("close", drop);
    ws.addEventListener("error", drop);
    this.ensureLoop();
  }

  private onDisconnect(ws: WebSocket) {
    const s = this.sessions.get(ws);
    if (s) {
      const p = this.players.get(s.playerId);
      if (p?.vehicleId) {
        const v = this.vehicles.get(p.vehicleId);
        if (v) v.driverId = null;
      }
      if (p) { this.releaseGrab(p); void this.savePlayer(p, null); } // free grapples + persist
      this.savedNames.delete(s.playerId);
      this.players.delete(s.playerId);
      this.kb.delete(s.playerId);
      this.deepSince.delete(s.playerId);
      this.fishingStates.delete(s.playerId);
      this.liveFishTimer.delete(s.playerId);
      this.transformUntil.delete(s.playerId);
      this.knockoutUntil.delete(s.playerId);
      this.grabCdUntil.delete(s.playerId);
      this.blockUntil.delete(s.playerId);
      this.prevDx.delete(s.playerId);
      this.baseAppearance.delete(s.playerId);
      this.modeWardrobe.delete(s.playerId);
      this.hidingAt.delete(s.playerId);
      this.playDeadUntil.delete(s.playerId);
      this.jumpUntil.delete(s.playerId);
    }
    this.sessions.delete(ws);
    if (this.sessions.size === 0 && this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
  }

  private onMessage(ws: WebSocket, msg: ClientMessage) {
    const s = this.sessions.get(ws);
    if (!s) return;
    switch (msg.t) {
      case "join": {
        void this.handleJoin(ws, s, msg);
        break;
      }
      case "checkName": {
        void this.handleCheckName(ws, msg.name);
        break;
      }
      case "input": {
        const len = Math.hypot(msg.dx, msg.dy);
        s.dx = len > 1 ? msg.dx / len : msg.dx;
        s.dy = len > 1 ? msg.dy / len : msg.dy;
        s.sprint = msg.sprint ?? false;
        const p = this.players.get(s.playerId);
        if (p && (msg.dx !== 0 || msg.dy !== 0)) {
          // While holding someone, left/right jinks wind the spin — don't re-aim,
          // so your throw flies the way you faced when you grabbed.
          if (!p.grabbing) p.dir = Math.atan2(msg.dy, msg.dx);
          // Moving cancels fishing.
          if (p.fishing) {
            p.fishing = false;
            this.fishingStates.delete(p.id);
          }
        }
        break;
      }
      case "attack":
        this.doAttack(s.playerId, typeof msg.charge === "number" ? msg.charge : 0);
        break;
      case "dodge":
        this.doDodge(s.playerId);
        break;
      case "board":
        this.doBoard(s.playerId);
        break;
      case "harvest":
        this.doHarvest(s.playerId);
        break;
      case "fish":
        this.doFishToggle(s.playerId);
        break;
      case "eat":
        this.doEat(s.playerId, msg.item);
        break;
      case "drop":
        this.doDrop(s.playerId, msg.item, msg.all === true);
        break;
      case "sleep":
        this.doSleep(s.playerId);
        break;
      case "craft":
        this.doCraft(s.playerId, msg.recipe);
        break;
      case "chat":
        this.doChat(s.playerId, msg.msg);
        break;
      case "repair":
        this.doRepair(s.playerId);
        break;
      case "trade":
        this.doTrade(s.playerId, msg.buildingId, msg.kind, msg.item, msg.qty);
        break;
      case "refuel":
        this.doHarvest(s.playerId); // harvest doubles as the refuel action
        break;
      case "drink":
        this.doDrink(s.playerId);
        break;
      case "travel":
        this.doTravel(ws, s.playerId);
        break;
      case "scan":
        this.doScan(ws, s.playerId);
        break;
      case "equip":
        this.doEquip(s.playerId, msg.item);
        break;
      case "wear":
        this.doWear(s.playerId, msg.slot, msg.item);
        break;
      case "heal":
        this.doHeal(s.playerId);
        break;
      case "setMode":
        this.doSetMode(s.playerId, msg.mode);
        break;
      case "setStance": {
        const p = this.players.get(s.playerId);
        if (p && p.mode === "combat") p.stance = msg.stance;
        break;
      }
      case "grab":
        this.doGrab(s.playerId);
        break;
      case "throwGrab":
        this.doThrow(s.playerId);
        break;
      case "block":
        this.doBlock(s.playerId);
        break;
      case "hide":
        this.doHide(s.playerId);
        break;
      case "playDead":
        this.doPlayDead(s.playerId);
        break;
      case "jump":
        this.doJump(s.playerId);
        break;
      case "listen":
        this.doListen(s.playerId);
        break;
      case "enter-building":
        this.doEnterBuilding(ws, s.playerId, msg.buildingId);
        break;
      case "exit-building":
        this.doExitBuilding(ws, s.playerId);
        break;
    }
  }

  // --- Modes ----------------------------------------------------------------
  private doSetMode(playerId: string, mode: PlayerMode) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.mode === mode) return;
    const now = Date.now();
    if ((this.transformUntil.get(playerId) ?? 0) > now) return; // already transforming
    // Release any grapple before transforming.
    this.releaseGrab(p);
    // Save the look you're leaving so it persists for the session.
    const ward = this.modeWardrobe.get(playerId) ?? {};
    ward[p.mode] = p.appearance;
    this.modeWardrobe.set(playerId, ward);
    const base = this.baseAppearance.get(playerId) ?? sanitizeAppearance(p.appearance);
    p.mode = mode;
    // First time entering research or profession: give basic starter clothes.
    if (!ward[mode] && mode !== "combat") {
      if (!p.inventory["clothShirt"]) p.inventory["clothShirt"] = 1;
      if (!p.inventory["clothPants"]) p.inventory["clothPants"] = 1;
      if (mode === "research" && !p.inventory["fieldHat"]) p.inventory["fieldHat"] = 1;
    }
    p.appearance = ward[mode] ?? defaultOutfit(mode, base);
    p.transforming = true;
    this.transformUntil.set(playerId, now + 2000); // 2 s strip + re-clothe
    this.tell(p, `Transforming into ${mode} mode…`);
  }

  // --- Grappling ------------------------------------------------------------
  private doGrab(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.mode !== "combat" || p.vehicleId) return;
    const now = Date.now();
    if (p.transforming || (this.knockoutUntil.get(playerId) ?? 0) > now) return;
    if ((this.grabCdUntil.get(playerId) ?? 0) > now) return;
    if (p.grabbing) { this.doThrow(playerId); return; } // grab again = throw

    const reach = 1.5, cos = Math.cos(p.dir), sin = Math.sin(p.dir);
    // Prefer a player straight ahead; else a light creature.
    let target: PlayerState | null = null, bestD = reach;
    for (const t of this.players.values()) {
      if (t.id === p.id || t.region !== p.region || t.dead || t.grabbedBy) continue;
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy);
      if (d > reach) continue;
      if (dx * cos + dy * sin < d * 0.3) continue; // must be roughly ahead
      if (d < bestD) { bestD = d; target = t; }
    }
    if (target) {
      p.grabbing = target.id;
      target.grabbedBy = p.id;
      p.spin = 0;
      this.grabCdUntil.set(playerId, now + 1200);
      this.tell(p, `Grabbed ${target.name}! Jink left/right to spin, ${"/"} to throw.`);
      this.tell(target, `${p.name} grabbed you! Block (B) in HIGH stance to break free.`);
      return;
    }
    // No player — try a light creature.
    let cTarget: CreatureState | null = null; let cd = reach;
    for (const c of this.creatures.values()) {
      if (c.region !== p.region || !GRABBABLE_CREATURES.has(c.kind)) continue;
      const dx = c.x - p.x, dy = c.y - p.y, d = Math.hypot(dx, dy);
      if (d > reach) continue;
      if (dx * cos + dy * sin < d * 0.3) continue;
      if (d < cd) { cd = d; cTarget = c; }
    }
    if (cTarget) {
      p.grabbing = cTarget.id;
      p.spin = 0;
      this.grabCdUntil.set(playerId, now + 1200);
      this.tell(p, `Grabbed a ${cTarget.kind}! Spin and throw it.`);
    } else {
      // Whiffed — if a heavy beast is in front, hint at the real tactic.
      this.grabCdUntil.set(playerId, now + 500);
    }
  }

  private doThrow(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || !p.grabbing) return;
    const now = Date.now();
    const power = Math.max(0.25, p.spin);          // even a weak fling goes a little
    const dist = 3 + power * 7;                      // 3 → 10 tiles
    const dmg = Math.round(2 + power * 8);           // up to ~10 hp
    const cos = Math.cos(p.dir), sin = Math.sin(p.dir);
    const target = this.players.get(p.grabbing);
    if (target) {
      target.grabbedBy = null;
      this.applyKnockback(target.id, cos, sin, dist * 6);
      if (!this.godPlayers.has(target.id)) target.hp = Math.max(0, target.hp - dmg);
      this.knockoutUntil.set(target.id, now + 1500);
      target.knockedOut = true;
      this.giveXP(p, "combat", dmg * 0.4);
      this.tell(target, `${p.name} threw you ${Math.round(dist)} tiles!`);
      if (target.hp <= 0 && !target.dead) this.killPlayer(target);
    } else {
      const c = this.creatures.get(p.grabbing);
      if (c) {
        this.applyKnockback(c.id, cos, sin, dist * 6);
        c.hp -= dmg;
        this.giveXP(p, "combat", dmg * 0.4);
        if (c.hp <= 0) { this.creatures.delete(c.id); this.kb.delete(c.id); }
      }
    }
    p.grabbing = null;
    p.spin = 0;
    this.grabCdUntil.set(playerId, now + 1000);
  }

  private doBlock(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const now = Date.now();
    this.blockUntil.set(playerId, now + 500);
    p.blocking = true;
    // If I'm being held and I'm in high stance, blocking breaks the grab early
    // (before the spinning really winds up) and shoves the grabber back.
    if (p.grabbedBy && p.stance === "high") {
      const grabber = this.players.get(p.grabbedBy);
      if (grabber && grabber.spin < 0.55) {
        grabber.grabbing = null;
        grabber.spin = 0;
        p.grabbedBy = null;
        const dx = grabber.x - p.x, dy = grabber.y - p.y;
        this.applyKnockback(grabber.id, dx, dy, 18);
        this.grabCdUntil.set(grabber.id, now + 1500);
        this.tell(p, "You broke free and shoved them back!");
        this.tell(grabber, `${p.name} blocked and broke your grab!`);
      }
    }
  }

  // Cleanly drop any grapple this player is part of (death / disconnect / mode).
  private releaseGrab(p: PlayerState) {
    if (p.grabbing) {
      const t = this.players.get(p.grabbing);
      if (t) t.grabbedBy = null;
      p.grabbing = null;
      p.spin = 0;
    }
    if (p.grabbedBy) {
      const g = this.players.get(p.grabbedBy);
      if (g) { g.grabbing = null; g.spin = 0; }
      p.grabbedBy = null;
    }
  }

  // First-responder action: patch up the nearest hurt player using cooked food.
  private doHeal(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const COOKED: ItemId[] = ["cookedcrab", "cookedfish", "cookedsalmon", "cookedlingcod", "cookedvenison", "cookedpoultry"];
    const food = COOKED.find((f) => (p.inventory[f] ?? 0) > 0);
    if (!food) { this.tell(p, "You need cooked food to patch someone up."); return; }
    // Nearest other living, hurt player within reach.
    let target: PlayerState | null = null, best = 2.6;
    for (const t of this.players.values()) {
      if (t.id === p.id || t.region !== p.region || t.dead || t.hp >= t.maxHp) continue;
      const d = Math.hypot(t.x - p.x, t.y - p.y);
      if (d < best) { best = d; target = t; }
    }
    if (!target) { this.tell(p, "No one nearby needs first aid."); return; }
    p.inventory[food] = (p.inventory[food] ?? 0) - 1;
    target.hp = Math.min(target.maxHp, target.hp + 35);
    const n = (this.healsBy.get(p.name) ?? 0) + 1;
    this.healsBy.set(p.name, n);
    p.banfielderPts += 3; // community service
    this.tell(p, `You patched up ${target.name}. (+3 Banfielder)`);
    this.tell(target, `${p.name} gave you first aid.`);
  }

  // --- discovery logbook ----------------------------------------------------
  private doScan(ws: WebSocket, playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const RAD = 9; // tiles
    const now = Date.now();
    const log = this.discoveries.get(p.name) ?? {};
    this.discoveries.set(p.name, log);

    // Collect distinct species within the radius this scan.
    const seen = new Set<string>();
    const inRange = (x: number, y: number) => Math.hypot(x - p.x, y - p.y) <= RAD;
    for (const c of this.creatures.values())
      if (c.region === p.region && inRange(c.x, c.y) && SPECIES[c.kind]) seen.add(c.kind);
    for (const pl of this.plants.values())
      if (pl.region === p.region && inRange(pl.x, pl.y) && SPECIES[pl.kind]) seen.add(pl.kind);
    for (const n of this.resourceNodes.values()) {
      if (n.region !== p.region || n.depleted || !inRange(n.x, n.y)) continue;
      const k = resourceSpeciesKey(n.kind, n.variety);
      if (SPECIES[k]) seen.add(k);
    }

    const fresh: string[] = [];
    for (const key of seen) {
      const e = log[key] ?? { count: 0, firstAt: now };
      if (e.count === 0) fresh.push(SPECIES[key].common);
      e.count++;
      log[key] = e;
    }
    if (fresh.length) {
      this.tell(p, `🔬 Logbook — new: ${fresh.join(", ")}`);
      this.giveXP(p, "fishing", fresh.length * 4); // naturalist effort rewards a little XP
    } else if (seen.size) {
      this.tell(p, "Scan complete — all already logged.");
    } else {
      this.tell(p, "Scan complete — nothing in range.");
    }
    this.sendLogbook(ws, p);
  }

  private sendLogbook(ws: WebSocket, p: PlayerState) {
    const log = this.discoveries.get(p.name) ?? {};
    const entries = Object.entries(log).map(([key, v]) => ({ key, count: v.count, firstAt: v.firstAt }));
    this.send(ws, { t: "logbook", entries });
  }

  // Join = create a fresh settler, then overlay any saved D1 account on top.
  private async handleJoin(ws: WebSocket, s: Session, msg: Extract<ClientMessage, { t: "join" }>) {
    const region = this.regions.get(DEFAULT_REGION)!;
    // New players wash up on the beach; returning players restore their saved position.
    const beachPos = this.beachSpawn(region, region.spawn.x, region.spawn.y);
    const spawn = beachPos;
    const name = (msg.name || "Settler").slice(0, 16);
    const player: PlayerState = {
      id: s.playerId,
      name,
      region: region.id,
      x: spawn.x,
      y: spawn.y,
      dir: 0,
      hp: PLAYER_MAX_HP,
      maxHp: PLAYER_MAX_HP,
      stamina: MAX_STAMINA,
      maxStamina: MAX_STAMINA,
      hunger: MAX_HUNGER,
      maxHunger: MAX_HUNGER,
      skills: defaultSkills(),
      banfielderPts: 0,
      rank: 0,
      isMayor: false,
      inventory: {}, // a fresh settler washes ashore naked & empty-handed
      money: STARTING_MONEY,
      team: null,
      appearance: combatOutfit(sanitizeAppearance(msg.appearance)), // naked combat look
      swimming: false,
      dodging: false,
      fishing: false,
      sleeping: false,
      vehicleId: null,
      dead: false,
      equipped: null,
      titles: [],
      speedBoosted: false,
      mode: "combat",
      stance: "high",
      transforming: false,
      grabbing: null,
      grabbedBy: null,
      spin: 0,
      knockedOut: false,
      blocking: false,
      hiding: false,
      playingDead: false,
      jumping: false,
      jumpPhase: 0,
      listenMode: false,
    };
    // Remember the player's chosen base colours so each mode's outfit keeps them.
    this.baseAppearance.set(s.playerId, sanitizeAppearance(msg.appearance));

    // Account flow. The `secret` is now the player's chosen passphrase, so an
    // account follows them across devices (real login, no email needed yet).
    //   • Returning to a claimed name → the passphrase MUST match, else denied.
    //   • Registering / a never-claimed name → claim it with this passphrase.
    // Best-effort — if the DB is down we just play in-memory.
    let restored = false;
    try {
      const row = await this.loadPlayer(name);
      if (row) {
        const claimed = (row.secret as string | null) || "";
        if (claimed && claimed !== (msg.secret ?? "")) {
          // Wrong password for an existing account — refuse the sign-in.
          this.send(ws, {
            t: "joinDenied",
            reason: `"${name}" is already registered. Wrong password — try again, or pick a new name.`,
          });
          return;
        }
        this.applySave(player, row);
        this.savedNames.set(s.playerId, name);
        restored = true;
        if (!claimed && msg.secret) await this.savePlayer(player, msg.secret, msg.email); // claim a legacy unclaimed name
      } else {
        this.savedNames.set(s.playerId, name);
        await this.savePlayer(player, msg.secret ?? null, msg.email); // register & claim the name now
      }
    } catch { /* DB unavailable — play in-memory only */ }

    // Everyone (new or returning) wakes up in combat mode, naked on the beach.
    // Keep the saved/chosen colours as the wardrobe base for all three modes.
    const base = sanitizeAppearance(player.appearance);
    this.baseAppearance.set(s.playerId, base);
    player.mode = "combat";
    player.appearance = combatOutfit(base);
    player.equipped = null;

    this.players.set(s.playerId, player);
    this.sendInit(ws, player);
    this.broadcastLog(
      restored ? `${player.name} returned to ${region.name}.`
               : `${player.name} washed ashore in ${region.name}.`,
    );
  }

  // --- D1 persistence -------------------------------------------------------
  private async loadPlayer(name: string): Promise<Record<string, unknown> | null> {
    if (!this.env.DB) return null;
    return await this.env.DB.prepare("SELECT * FROM players WHERE name = ?").bind(name).first();
  }

  // Login screen: report whether a name is already registered. A name that
  // exists but was never claimed (no secret) still counts as "taken" so two
  // people don't collide. Also treats a name currently online as taken.
  private async handleCheckName(ws: WebSocket, rawName: string) {
    const name = (rawName || "").trim().slice(0, 16);
    if (!name) { this.send(ws, { t: "nameStatus", name: rawName, taken: false }); return; }
    let taken = [...this.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (!taken) {
      try { taken = !!(await this.loadPlayer(name)); } catch { /* DB down — treat as free */ }
    }
    this.send(ws, { t: "nameStatus", name, taken });
  }

  private applySave(p: PlayerState, row: Record<string, unknown>) {
    const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);
    const json = <T,>(v: unknown, d: T): T => {
      try { return v ? JSON.parse(v as string) as T : d; } catch { return d; }
    };
    if (typeof row.region === "string" && this.regions.has(row.region)) p.region = row.region;
    p.x = num(row.x, p.x); p.y = num(row.y, p.y);
    p.money = num(row.money, p.money);
    p.banfielderPts = num(row.banfielder_pts, p.banfielderPts);
    p.maxHp = num(row.max_hp, p.maxHp);
    p.hp = Math.min(p.maxHp, num(row.hp, p.hp));
    p.hunger = num(row.hunger, p.hunger);
    p.skills = { ...p.skills, ...json(row.skills, {}) };
    p.inventory = json(row.inventory, p.inventory);
    p.appearance = sanitizeAppearance(json(row.appearance, p.appearance));
    this.discoveries.set(p.name, json(row.discoveries, {} as Record<string, { count: number; firstAt: number }>));
    // Restore per-mode wardrobe (research/profession outfits).
    const savedWardrobe = json(row.mode_wardrobe, {} as Partial<Record<PlayerMode, Appearance>>);
    const sanitizedWardrobe: Partial<Record<PlayerMode, Appearance>> = {};
    for (const mode of ["combat", "research", "profession"] as PlayerMode[]) {
      if (savedWardrobe[mode]) sanitizedWardrobe[mode] = sanitizeAppearance(savedWardrobe[mode]!);
    }
    this.modeWardrobe.set(p.name, sanitizedWardrobe);
    // Apply current-mode outfit if one was saved.
    if (sanitizedWardrobe[p.mode]) p.appearance = sanitizedWardrobe[p.mode]!;
    // Re-equip a weapon they actually still own (saved inventory may differ).
    if (!p.equipped || (p.inventory[p.equipped] ?? 0) <= 0) {
      p.equipped = WEAPON_ITEMS.find((w) => (p.inventory[w] ?? 0) > 0) ?? null;
    }
  }

  private async savePlayer(p: PlayerState, secret: string | null, email?: string) {
    if (!this.env.DB) return;
    const now = Date.now();
    try {
      const discoveries   = JSON.stringify(this.discoveries.get(p.name) ?? {});
      const modeWardrobe  = JSON.stringify(this.modeWardrobe.get(p.name) ?? {});
      await this.env.DB.prepare(
        `INSERT INTO players
           (name, secret, email, region, x, y, money, banfielder_pts, hp, max_hp, hunger,
            skills, inventory, appearance, discoveries, mode_wardrobe, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET
           secret=COALESCE(players.secret, excluded.secret),
           email=COALESCE(excluded.email, players.email),
           region=excluded.region, x=excluded.x, y=excluded.y,
           money=excluded.money, banfielder_pts=excluded.banfielder_pts,
           hp=excluded.hp, max_hp=excluded.max_hp, hunger=excluded.hunger,
           skills=excluded.skills, inventory=excluded.inventory,
           appearance=excluded.appearance, discoveries=excluded.discoveries,
           mode_wardrobe=excluded.mode_wardrobe,
           updated_at=excluded.updated_at`,
      ).bind(
        p.name, secret, email ?? null, p.region, p.x, p.y, p.money, p.banfielderPts,
        p.hp, p.maxHp, p.hunger,
        JSON.stringify(p.skills), JSON.stringify(p.inventory), JSON.stringify(p.appearance),
        discoveries, modeWardrobe, now, now,
      ).run();
    } catch { /* swallow — never crash the tick on a write */ }
  }

  // Persist everyone currently connected (autosave + on shutdown).
  private saveAll() {
    if (!this.env.DB) return;
    for (const [pid, name] of this.savedNames) {
      const p = this.players.get(pid);
      if (p) { p.name = p.name || name; void this.savePlayer(p, null); }
    }
  }

  private sendInit(ws: WebSocket, player: PlayerState) {
    const region = this.regions.get(player.region)!;
    const s = this.sessions.get(ws);
    if (s) { s.sentChunks = new Set(); s.chunkRegion = region.id; } // fresh map → restream
    this.send(ws, {
      t: "init",
      id: player.id,
      region: {
        id: region.id,
        name: region.name,
        width: region.map.width,
        height: region.map.height,
        overview: this.overviewFor(region.id),
        travelNodes: region.travelNodes,
      },
      snapshot: this.snapshot(region.id, player),
    });
    if (s) this.streamChunks(ws, s, player); // push the spawn-area chunks now
    this.sendLogbook(ws, player);            // and their discovery logbook
  }

  // --- Chunked map streaming ------------------------------------------------
  private overviews = new Map<RegionId, OverviewMap>();

  // A downsampled whole-map snapshot for the minimap. Built once per region.
  private overviewFor(regionId: RegionId): OverviewMap {
    const cached = this.overviews.get(regionId);
    if (cached) return cached;
    const { width: w, height: h, tiles, elevation } = this.regions.get(regionId)!.map;
    const scale = 4;
    const ow = Math.ceil(w / scale), oh = Math.ceil(h / scale);
    const ot: number[] = new Array(ow * oh);
    const oe: number[] = new Array(ow * oh);
    for (let oy = 0; oy < oh; oy++) {
      for (let ox = 0; ox < ow; ox++) {
        const sx = Math.min(w - 1, ox * scale), sy = Math.min(h - 1, oy * scale);
        const i = sy * w + sx;
        ot[oy * ow + ox] = tiles[i];
        oe[oy * ow + ox] = elevation[i];
      }
    }
    const ov: OverviewMap = { scale, width: ow, height: oh, tiles: ot, elevation: oe };
    this.overviews.set(regionId, ov);
    return ov;
  }

  // Stream any map chunks within a radius of the player that we haven't sent to
  // this connection yet. Capped per call so a fresh join spreads over a few ticks.
  private streamChunks(ws: WebSocket, s: Session, player: PlayerState) {
    const region = this.regions.get(player.region);
    if (!region) return;
    if (s.chunkRegion !== player.region) { s.sentChunks = new Set(); s.chunkRegion = player.region; }
    const { width: w, height: h, tiles, elevation } = region.map;
    const chunksX = Math.ceil(w / CHUNK), chunksY = Math.ceil(h / CHUNK);
    const pcx = Math.floor(player.x / CHUNK), pcy = Math.floor(player.y / CHUNK);
    const RAD = 3;                 // chunks in each direction (~96 tiles)
    const MAX_PER_CALL = 16;       // smooth the burst over a few ticks
    let sent = 0;
    // Nearest-first so the screen fills from the player outward.
    for (let r = 0; r <= RAD && sent < MAX_PER_CALL; r++) {
      for (let cy = pcy - r; cy <= pcy + r && sent < MAX_PER_CALL; cy++) {
        for (let cx = pcx - r; cx <= pcx + r && sent < MAX_PER_CALL; cx++) {
          if (Math.max(Math.abs(cx - pcx), Math.abs(cy - pcy)) !== r) continue; // ring r only
          if (cx < 0 || cy < 0 || cx >= chunksX || cy >= chunksY) continue;
          const key = cx + "," + cy;
          if (s.sentChunks.has(key)) continue;
          s.sentChunks.add(key);
          const x0 = cx * CHUNK, y0 = cy * CHUNK;
          const cw = Math.min(CHUNK, w - x0), ch = Math.min(CHUNK, h - y0);
          const ct: number[] = new Array(cw * ch), ce: number[] = new Array(cw * ch);
          for (let yy = 0; yy < ch; yy++) {
            const srcRow = (y0 + yy) * w + x0, dstRow = yy * cw;
            for (let xx = 0; xx < cw; xx++) {
              ct[dstRow + xx] = tiles[srcRow + xx];
              ce[dstRow + xx] = elevation[srcRow + xx];
            }
          }
          this.send(ws, { t: "chunk", region: player.region, cx, cy, w: cw, h: ch, tiles: ct, elevation: ce });
          sent++;
        }
      }
    }
  }

  // --- main loop ------------------------------------------------------------
  private ensureLoop() {
    if (this.loop) return;
    this.lastTick = Date.now();
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    const waterline = this.currentWaterline(now);
    this.updateEvents(now);
    this.moveVehicles(dt, waterline, now);
    this.movePlayers(dt, waterline, now);
    this.updateCreatures(dt, waterline, now);
    this.updateNpcWander(dt, waterline, now);
    this.updateDummies(now);
    this.updateResourceRespawn(now);
    this.updateVehicleRust(dt, waterline, now);
    this.updateFishing(now);
    this.updateLiveFish(now);
    this.updateHunger(dt);
    this.updateSleep(dt);
    this.updatePlants(now, waterline);
    this.updateCampfires(now);
    this.recomputeRanks(now);
    this.maybeSpawn(now, waterline);

    // Autosave every 30s so progress survives a Durable Object eviction.
    if (now > this.nextSave) { this.nextSave = now + 30_000; this.saveAll(); }

    // Each player gets a snapshot culled to what's near them (interest mgmt).
    for (const s of this.sessions.values()) {
      const p = this.players.get(s.playerId);
      if (!p) continue;
      this.send(s.ws, { t: "snapshot", snapshot: this.snapshot(p.region, p) });
      this.streamChunks(s.ws, s, p); // feed in map chunks as they walk/sail
    }
  }

  // --- tide -----------------------------------------------------------------
  private tideLevel(now: number): number {
    const phase = ((now - this.startedAt) % TIDE_CYCLE_MS) / TIDE_CYCLE_MS;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  }

  private currentWaterline(now: number): number {
    let wl = WATERLINE_LOW + (WATERLINE_HIGH - WATERLINE_LOW) * this.tideLevel(now);
    if (this.event === "king") wl += KING_TIDE_SURGE;
    if (this.event === "tsunami") wl += TSUNAMI_SURGE;
    return wl;
  }

  private updateEvents(now: number) {
    if (this.event !== "none" && now > this.eventUntil) {
      this.broadcastLog(
        this.event === "tsunami" ? "The tsunami recedes. (Banfielder pts awarded to all survivors online!)" : "The king tide eases.",
      );
      // Award Banfielder pts to all online players for surviving a natural disaster.
      if (this.event === "tsunami" || this.event === "king") {
        const bonus = this.event === "tsunami" ? 50 : 10;
        for (const p of this.players.values()) {
          if (!p.dead) {
            p.banfielderPts += bonus;
            this.tell(p, `You survived a ${this.event === "tsunami" ? "tsunami" : "king tide"}! +${bonus} Banfielder pts.`);
          }
        }
      }
      this.event = "none";
    }
    if (now > this.nextEventCheck) {
      this.nextEventCheck = now + 60_000;
      if (this.event !== "none") return; // already an active event

      // Seeded daily roll: the same calendar day always rolls the same result,
      // so restarts don't double-trigger. One event maximum per day.
      const dayKey = Math.floor(now / 86_400_000);
      if (dayKey === this.lastEventDayKey) return;
      this.lastEventDayKey = dayKey;

      const r1 = seededHash(dayKey);
      const r2 = seededHash(dayKey ^ 0xDEAD_BEEF);
      if (r1 < TSUNAMI_DAILY_P) {
        this.event = "tsunami";
        this.eventUntil = now + 60_000; // 1 minute to get to high ground
        this.broadcastLog("⚠ TSUNAMI INCOMING — get to high ground immediately!");
      } else if (r2 < KING_TIDE_DAILY_P) {
        this.event = "king";
        this.eventUntil = now + 600_000; // 10-minute king tide
        this.broadcastLog("A king tide is rolling in — watch the inlet!");
      }
    }
  }

  // --- players --------------------------------------------------------------
  private movePlayers(dt: number, waterline: number, now: number) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const s = this.sessionFor(p.id);
      const region = this.regions.get(p.region);
      if (!s || !region) continue;

      p.dodging = now < s.iframeUntil;

      // While driving, the vehicle carries you — moveVehicles set our position.
      if (p.vehicleId) {
        p.swimming = false;
        this.deepSince.delete(p.id);
        p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
        continue;
      }

      // --- Mode transform & block windows ---
      p.transforming = (this.transformUntil.get(p.id) ?? 0) > now;
      p.blocking = (this.blockUntil.get(p.id) ?? 0) > now;

      // --- Knockout: dizzy on the ground after being thrown. Can't act, but the
      //     throw's momentum still carries them flying through the air. ---
      if ((this.knockoutUntil.get(p.id) ?? 0) > now) {
        p.knockedOut = true;
        p.swimming = false;
        const imp = this.kb.get(p.id);
        if (imp) {
          const nx = p.x + imp.x * dt, ny = p.y + imp.y * dt;
          if (this.inBounds(region.map, nx, p.y)) p.x = nx;
          if (this.inBounds(region.map, p.x, ny)) p.y = ny;
        }
        p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
        continue;
      }
      p.knockedOut = false;

      // --- Mid-transform: frozen while stripping & re-clothing ---
      if (p.transforming) {
        p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
        continue;
      }

      // --- Being held: the grabber owns your position (set below) ---
      if (p.grabbedBy) {
        const g = this.players.get(p.grabbedBy);
        if (!g || g.dead || g.grabbing !== p.id) this.releaseGrab(p);
        else continue;
      }

      // --- Holding someone: jink left/right to wind up the helicopter spin ---
      if (p.grabbing) {
        const held = this.players.get(p.grabbing) ?? null;
        const heldC = held ? null : this.creatures.get(p.grabbing) ?? null;
        if (!held && !heldC) { p.grabbing = null; p.spin = 0; }
        else {
          const prev = this.prevDx.get(p.id) ?? 0;
          if (Math.abs(s.dx) > 0.3 && prev !== 0 && Math.sign(s.dx) !== Math.sign(prev)) {
            p.spin = Math.min(1, p.spin + 0.12);          // a clean reversal — big wind-up
          } else if (Math.abs(s.dx) > 0.3) {
            p.spin = Math.min(1, p.spin + 1.2 * dt);       // holding a direction — slow build
          } else {
            p.spin = Math.max(0, p.spin - 0.15 * dt);      // not jinking — bleed off
          }
          this.prevDx.set(p.id, s.dx);
          const rad = 0.7 + p.spin * 0.6;
          const ang = (now / 1000) * (2 + p.spin * 16);
          const hx = p.x + Math.cos(ang) * rad, hy = p.y + Math.sin(ang) * rad;
          if (held) { held.x = hx; held.y = hy; held.dir = ang; }
          else if (heldC) { heldC.x = hx; heldC.y = hy; }
          p.stamina = Math.max(0, p.stamina - 6 * dt);
          continue; // rooted while spinning
        }
      }

      const movingInput = s.dx !== 0 || s.dy !== 0;
      const depth0 = this.depthAt(region.map, p.x, p.y, waterline);
      p.swimming = depth0 >= DEPTH_SWIM;            // deep water = swimming; shallow = wading
      const swimBonus = 1 + skillLevel(p.skills.swimming) * 0.003;
      const sprinting = s.sprint && !p.swimming && p.stamina > 0 && movingInput;
      const swimStroke = p.swimming && movingInput;

      // Spend stamina sprinting on land or stroking in deep water; otherwise it
      // recovers. (Swimming now tires you out, just like running.)
      if (sprinting)       p.stamina = Math.max(0, p.stamina - SPRINT_STAMINA_DRAIN * dt);
      else if (swimStroke) p.stamina = Math.max(0, p.stamina - SWIM_STAMINA_DRAIN * dt);
      else                 p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
      if (swimStroke) this.giveXP(p, "swimming", XP_SWIM_PER_SEC * dt);

      const tired = p.swimming && p.stamina <= 0;
      const wingsActive = (this.speedBoostUntil.get(p.id) ?? 0) > now;
      p.speedBoosted = wingsActive;
      const wingsMult = wingsActive ? 5 : 1;
      const speed = (p.swimming ? SWIM_SPEED * swimBonus * (tired ? SWIM_TIRED_MULT : 1)
                               : sprinting ? PLAYER_SPEED * SPRINT_MULT : PLAYER_SPEED) * wingsMult;
      const imp = this.kb.get(p.id);
      const nx = p.x + (s.dx * speed + (imp?.x ?? 0)) * dt;
      const ny = p.y + (s.dy * speed + (imp?.y ?? 0)) * dt;
      let moved = false;
      if (this.inBounds(region.map, nx, p.y)) {
        if (nx !== p.x) moved = true;
        p.x = nx;
      }
      if (this.inBounds(region.map, p.x, ny)) {
        if (ny !== p.y) moved = true;
        p.y = ny;
      }

      // Drowning: you float fine in deep water for 3 min, but if you
      // don't reach the shallows in time you start to go under — faster if your
      // stamina is spent. Not easy to drown, but you must swim for shore.
      if (p.swimming) {
        if (!this.deepSince.has(p.id)) this.deepSince.set(p.id, now);
        const floated = now - (this.deepSince.get(p.id) ?? now);
        if (floated > FLOAT_GRACE_MS && !this.godPlayers.has(p.id)) {
          if (floated - dt * 1000 <= FLOAT_GRACE_MS) this.tell(p, "You're going under — swim to shore!");
          p.hp -= (p.stamina <= 0 ? DROWN_DPS_TIRED : DROWN_DPS) * dt;
          if (p.hp <= 0 && !p.dead) this.killPlayer(p);
        }
      } else {
        this.deepSince.delete(p.id); // reached the shallows — catch your breath
      }

      // Walk onto a road gate at the map edge and you cross to the next region.
      if (moved) this.autoTravelOnFoot(p);

      // --- Jump arc update ---
      const jumpEnd = this.jumpUntil.get(p.id);
      if (jumpEnd) {
        const elapsed = 400 - Math.max(0, jumpEnd - now);
        p.jumpPhase = Math.min(1, elapsed / 400);
        if (now >= jumpEnd) {
          p.jumping = false;
          p.jumpPhase = 0;
          this.jumpUntil.delete(p.id);
        }
      }

      // --- Auto-cancel play-dead if moved ---
      if (p.playingDead) {
        const deadUntil = this.playDeadUntil.get(p.id) ?? 0;
        if (now >= deadUntil || moved) {
          p.playingDead = false;
          this.playDeadUntil.delete(p.id);
          if (moved) this.tell(p, "You got up — play dead cancelled.");
        }
      }

      // --- Auto-cancel hide if moved too far ---
      if (p.hiding && moved) {
        const hidePos = this.hidingAt.get(p.id);
        if (hidePos && Math.hypot(p.x - hidePos.x, p.y - hidePos.y) > 0.3) {
          p.hiding = false;
          this.hidingAt.delete(p.id);
          this.tell(p, "You moved — hiding broken.");
        }
      }

      // --- Auto-cancel listen mode if moved ---
      if (p.listenMode && moved) {
        p.listenMode = false;
        this.tell(p, "Listen mode cancelled (you moved).");
      }

      // --- Listen mode flavour messages ---
      if (p.listenMode && Math.random() < 0.002) {
        const msgs = [
          "You hear rustling in the undergrowth…",
          "Somewhere nearby, a branch snaps.",
          "The forest goes very quiet.",
          "Distant splashing from the inlet.",
          "A grouse calls somewhere overhead.",
          "You catch the scent of something large upwind.",
        ];
        this.tell(p, msgs[Math.floor(Math.random() * msgs.length)]);
      }

      // Pick up ground loot by walking over it (within 1.2 tiles).
      for (const drop of this.lootDrops.values()) {
        if (drop.region !== p.region) continue;
        const dx = drop.x - p.x, dy = drop.y - p.y;
        if (dx * dx + dy * dy > 1.44) continue; // 1.2 tile radius
        this.addItem(p.inventory, drop.item, drop.qty);
        this.tell(p, `Picked up ${drop.qty}× ${ITEM_LABEL[drop.item]}.`);
        this.lootDrops.delete(drop.id);
      }
    }
    this.decayKnockback(dt);
  }

  // --- vehicles -------------------------------------------------------------
  private moveVehicles(dt: number, waterline: number, now: number) {
    for (const v of this.vehicles.values()) {
      const region = this.regions.get(v.region);
      if (!region) continue;
      const driver = v.driverId ? this.players.get(v.driverId) : null;

      let movedThisTick = false;
      let activeSpeed = 0;

      if (driver && !driver.dead) {
        const s = this.sessionFor(driver.id);
        if (s && (s.dx !== 0 || s.dy !== 0)) {
          if (v.fuel <= 0) {
            // Dry tank — won't budge. Nudge them to refuel (E with a jerry can).
            if (now - (this.lastFuelWarn.get(v.id) ?? 0) > 3000) {
              this.lastFuelWarn.set(v.id, now);
              this.tell(driver, `The ${v.kind} is out of fuel! Refuel with a jerry can (E key beside it).`);
            }
          } else {
            const onRoad = this.tileAt(region.map, v.x, v.y) === Tile.Road;
            const skillBonus =
              v.kind === "car"
                ? 1 + skillLevel(driver.skills.driving) * 0.003
                : 1 + skillLevel(driver.skills.boating) * 0.002;
            const base =
              v.kind === "car"
                ? (onRoad ? CAR_SPEED : CAR_OFFROAD_SPEED) * skillBonus
                : BOAT_SPEED * skillBonus;
            // Throttle (Shift): more speed, more fuel burn.
            const throttle = s.sprint && v.fuel > 0;
            activeSpeed = throttle ? base * THROTTLE_MULT : base;
            const nx = v.x + s.dx * activeSpeed * dt;
            const ny = v.y + s.dy * activeSpeed * dt;
            if (this.vehicleCanGo(v, region.map, nx, v.y, waterline)) { v.x = nx; movedThisTick = true; }
            if (this.vehicleCanGo(v, region.map, v.x, ny, waterline)) { v.y = ny; movedThisTick = true; }
            v.dir = Math.atan2(s.dy, s.dx);
            v.lastDriven = now;
            const fuelRate = throttle ? FUEL_DRAIN * THROTTLE_FUEL_MULT : FUEL_DRAIN;
            v.fuel = Math.max(0, v.fuel - fuelRate * dt);
            // Skill XP for the driver.
            if (v.kind === "car") this.giveXP(driver, "driving", XP_DRIVE_PER_SEC * dt);
            else this.giveXP(driver, "boating", XP_BOAT_PER_SEC * dt);
          }
        }
        // The driver rides along.
        driver.x = v.x;
        driver.y = v.y;
        driver.dir = v.dir;

        // Sail a boat into an open-water "sea" border and it carries you (and
        // the boat) across to the neighbouring region.
        const s2 = this.sessionFor(driver.id);
        const offCd = !s2 || now >= s2.travelCdUntil;
        if (v.kind === "boat" && offCd) {
          const sea = region.travelNodes.find(
            (n) => n.kind === "sea" &&
              v.x >= n.x && v.x <= n.x + n.w && v.y >= n.y && v.y <= n.y + n.h,
          );
          if (sea) { this.transferVehicle(v, driver, sea.toRegion, sea.toSpawn); continue; }
        }
        // Drive a car onto a road gate and it carries you across by road.
        if (v.kind === "car" && offCd) {
          const gate = region.travelNodes.find(
            (n) => n.kind === "gate" &&
              v.x >= n.x - 0.5 && v.x <= n.x + n.w + 0.5 && v.y >= n.y - 0.5 && v.y <= n.y + n.h + 0.5,
          );
          if (gate) { this.transferVehicle(v, driver, gate.toRegion, gate.toSpawn); continue; }
        }
      } else {
        // Driverless boats stay put — they're moored, not adrift.
      }

      // Collision: a moving vehicle above the danger threshold can hurt players.
      if (movedThisTick && activeSpeed >= COLLISION_MIN_SPEED) {
        for (const p of this.players.values()) {
          if (!driver || p.id === driver.id || p.region !== v.region || p.dead) continue;
          if (p.vehicleId) continue; // passengers are safe (future: separate seats)
          const d = Math.hypot(p.x - v.x, p.y - v.y);
          if (d < COLLISION_RANGE) {
            const ts = this.sessionFor(p.id);
            if (ts && now < ts.iframeUntil) continue; // dodging = you leaped clear
            if (this.godPlayers.has(p.id)) continue; // god mode: immune
            const dmg = activeSpeed * 6;
            p.hp -= dmg;
            this.applyKnockback(p.id, p.x - v.x, p.y - v.y, activeSpeed * 1.5);
            v.hp -= dmg * 0.15; // vehicle takes minor impact damage too
            this.broadcastLog(`${p.name} was hit by a ${v.kind}!`);
            if (p.hp <= 0 && !p.dead) this.killPlayer(p);
          }
        }
      }
    }
  }

  private updateVehicleRust(dt: number, waterline: number, now: number) {
    for (const [id, v] of this.vehicles) {
      const region = this.regions.get(v.region);
      const depth = region ? this.depthAt(region.map, v.x, v.y, waterline) : 0;

      // Car in deeper-than-ankle water: warn the driver, then sink after 4s.
      if (v.kind === "car" && depth > DEPTH_ANKLE) {
        const driver = v.driverId ? this.players.get(v.driverId) : null;
        if (driver) {
          // Warn the driver and eject them.
          const s = this.sessionFor(driver.id);
          if (s) this.send(s.ws, { t: "log", msg: "Your car is flooding! Bailing out…" });
          driver.vehicleId = null;
          v.driverId = null;
          if (region) {
            const shore = this.landSpawn(region, Math.round(v.x), Math.round(v.y));
            driver.x = shore.x; driver.y = shore.y;
          }
        }
        // Sink immediately (tide took the car).
        this.broadcastLog(`A car was swallowed by the tide.`);
        this.vehicles.delete(id);
        continue;
      }

      if (v.driverId) continue; // driven vehicles don't rust
      if (now - v.lastDriven < RUST_START_MS) continue;
      const rate = RUST_DPS * (depth > 2 ? 3 : 1);
      v.hp -= rate * dt;
      if (v.hp <= 0) {
        this.broadcastLog(`A ${v.kind} has rusted away.`);
        this.vehicles.delete(id);
      }
    }
  }

  // Cars ride land and ankle-deep water; boats need real water depth.
  private vehicleCanGo(v: VehicleState, map: WorldMap, x: number, y: number, waterline: number): boolean {
    if (!this.inBounds(map, x, y)) return false;
    const depth = this.depthAt(map, x, y, waterline);
    if (v.kind === "boat") return depth > 0;
    // Cars can splash through ankle/knee water but sink in anything deeper.
    return depth <= DEPTH_ANKLE;
  }

  // --- resources & crafting -------------------------------------------------
  private doHarvest(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    const s = this.sessionFor(p.id);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastHarvest < HARVEST_COOLDOWN_MS) return;

    // Refuel check first: if you carry a jerry can and there's a thirsty vehicle
    // within reach, top it up instead of harvesting.
    for (const v of this.vehicles.values()) {
      if (v.region !== p.region) continue;
      if (Math.hypot(v.x - p.x, v.y - p.y) > VEHICLE_BOARD_RANGE) continue;
      if (v.fuel >= v.maxFuel) continue;
      const cans = p.inventory["jerryCan"] ?? 0;
      if (cans <= 0) continue;
      p.inventory["jerryCan"] = cans - 1;
      v.fuel = Math.min(v.maxFuel, v.fuel + 50);
      v.lastDriven = now;
      s.lastHarvest = now;
      this.tell(p, `Refuelled the ${v.kind} (+50 fuel, now ${v.fuel.toFixed(0)}/${v.maxFuel}).`);
      return;
    }

    // Consider both resource nodes and invasive plants — act on the nearest.
    let bestNode: ResourceNode | null = null;
    let bestPlant: PlantState | null = null;
    let bestD = HARVEST_RANGE;
    for (const n of this.resourceNodes.values()) {
      if (n.region !== p.region || n.depleted) continue;
      const d = Math.hypot(n.x + 0.5 - p.x, n.y + 0.5 - p.y);
      if (d <= bestD) { bestD = d; bestNode = n; bestPlant = null; }
    }
    for (const pl of this.plants.values()) {
      if (pl.region !== p.region || pl.dormantUntil !== null) continue;
      const d = Math.hypot(pl.x + 0.5 - p.x, pl.y + 0.5 - p.y);
      if (d <= bestD) { bestD = d; bestPlant = pl; bestNode = null; }
    }

    if (bestPlant) {
      s.lastHarvest = now;
      this.clearPlant(p, bestPlant, now);
      return;
    }
    if (!bestNode) return;
    s.lastHarvest = now;

    // Skill-level gate for iron ore.
    if (bestNode.kind === "ironOre" && skillLevel(p.skills.mining) < MINING_LEVEL_REQ_IRON) {
      this.tell(p, `Need Mining level ${MINING_LEVEL_REQ_IRON} to extract iron.`);
      return;
    }

    bestNode.hp -= 1;
    let respawnMs = ORE_RESPAWN_MS;
    if (bestNode.kind === "tree") {
      const woodType = treeWoodItem(bestNode.variety);
      this.addItem(p.inventory, woodType, 1);
      this.giveXP(p, "woodcutting", XP_CHOP);
      respawnMs = bestNode.variety === "arbutus" ? ARBUTUS_RESPAWN_MS : TREE_RESPAWN_MS;
    } else if (bestNode.kind === "berryBush") {
      this.addItem(p.inventory, "berry", 1);
      this.giveXP(p, "gardening", XP_FORAGE);
      respawnMs = BERRY_RESPAWN_MS;
    } else if (bestNode.kind === "ironOre") {
      this.addItem(p.inventory, "iron", 1);
      this.giveXP(p, "mining", XP_MINE);
    } else if (bestNode.kind === "clayDeposit") {
      this.addItem(p.inventory, "clay", 1);
      this.giveXP(p, "mining", XP_MINE);
    } else {
      this.addItem(p.inventory, "stone", 1);
      this.giveXP(p, "mining", XP_MINE);
    }

    if (bestNode.hp <= 0) {
      bestNode.depleted = true;
      bestNode.hp = 0;
      // Arbutus is dead for good once felled — it does not regrow (respawnAt
      // stays null so updateResourceRespawn never revives it). A real loss.
      const permanent = bestNode.kind === "tree" && bestNode.variety === "arbutus";
      bestNode.respawnAt = permanent ? null : now + respawnMs;
      if (permanent) this.tell(p, "You felled an arbutus — that one's gone for good.");
      else this.depletedNodeIds.add(bestNode.id); // only regrowable nodes get tracked
      // Felling a tree opens a clearcut — invasives love disturbed ground.
      if (bestNode.kind === "tree" && Math.random() < CLEARCUT_INVASIVE_CHANCE) {
        this.spawnInvasiveNear(bestNode.region, bestNode.x, bestNode.y, now);
      }
    }
  }

  // Tackle an invasive plant. The science-true twist: it only dies for GOOD if
  // it's FLOWERING (all its energy is up top). Clear it young or seeding and the
  // root survives to regrow later.
  private clearPlant(p: PlayerState, plant: PlantState, now: number) {
    if (plant.stage === "flowering") {
      this.plants.delete(plant.id);
      p.banfielderPts += PTS_KILL_FLOWERING;
      this.giveXP(p, "gardening", XP_GARDEN_KILL);
      this.tell(p, `Pulled the flowering ${INVASIVE_LABEL[plant.kind]} — killed for good! +${PTS_KILL_FLOWERING} Banfielder pts`);
    } else {
      // Cut back, but the root lives. It lies dormant, then regrows young.
      plant.dormantUntil = now + PLANT_REGROW_MS;
      plant.stage = "young";
      plant.stageUntil = now + PLANT_REGROW_MS + PLANT_YOUNG_MS;
      p.banfielderPts += PTS_CLEAR_OTHER;
      this.giveXP(p, "gardening", XP_GARDEN_CLEAR);
      this.tell(p, `Cut back the ${INVASIVE_LABEL[plant.kind]} — but the root survives. Get it while it FLOWERS to kill it.`);
    }
  }

  private spawnInvasiveNear(regionId: RegionId, x: number, y: number, now: number) {
    const count = [...this.plants.values()].filter((pl) => pl.region === regionId).length;
    if (count >= PLANT_CAP_PER_REGION) return;
    const region = this.regions.get(regionId);
    if (!region) return;
    const ox = x + Math.round((Math.random() - 0.5) * 4);
    const oy = y + Math.round((Math.random() - 0.5) * 4);
    if (!this.inBounds(region.map, ox + 0.5, oy + 0.5)) return;
    // Don't sprout in the sea (or a lake).
    if (isWaterTile(this.tileAt(region.map, ox + 0.5, oy + 0.5) ?? Tile.Grass)) return;
    const kinds: InvasiveKind[] = ["scotchBroom", "himalayanBlackberry", "foxglove"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const id = `inv${this.idCounter++}`;
    this.plants.set(id, {
      id, kind, region: regionId, x: ox, y: oy,
      stage: "young", stageUntil: now + PLANT_YOUNG_MS, dormantUntil: null,
    });
  }

  private updatePlants(now: number, waterline: number) {
    for (const pl of this.plants.values()) {
      // Plants can't survive submerged — high tide kills them.
      const plRegion = this.regions.get(pl.region);
      if (plRegion && this.depthAt(plRegion.map, pl.x, pl.y, waterline) > 0) {
        this.plants.delete(pl.id);
        continue;
      }
      // Dormant (recently cut-back) plants wait, then re-emerge.
      if (pl.dormantUntil !== null) {
        if (now >= pl.dormantUntil) {
          pl.dormantUntil = null;
          pl.stage = "young";
          pl.stageUntil = now + PLANT_YOUNG_MS;
        }
        continue;
      }
      if (now < pl.stageUntil) continue;
      const next = nextStage(pl.stage);
      pl.stage = next;
      if (next === "young") {
        pl.stageUntil = now + PLANT_YOUNG_MS;
      } else if (next === "flowering") {
        pl.stageUntil = now + PLANT_FLOWER_MS;
      } else {
        // Seeding: spread to new ground, then reset to young next cycle.
        pl.stageUntil = now + PLANT_SEED_MS;
        // Scotch broom is the aggressive spreader.
        const spreadChance = pl.kind === "scotchBroom" ? 0.9 : 0.5;
        if (Math.random() < spreadChance) {
          this.spawnInvasiveNear(pl.region, pl.x, pl.y, now);
        }
      }
    }
  }

  private updateCampfires(now: number) {
    for (const [id, f] of this.campfires) {
      if (now >= f.expiresAt) this.campfires.delete(id);
    }
  }

  private updateHunger(dt: number) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (this.godPlayers.has(p.id)) {
        p.hunger = p.maxHunger; // god mode: no hunger drain
        p.hp = p.maxHp;
        this.recomputeMaxHp(p);
        continue;
      }
      const s = this.sessionFor(p.id);
      const working = s ? s.dx !== 0 || s.dy !== 0 : false;
      const decay = HUNGER_DECAY + (working ? HUNGER_WORK_EXTRA : 0);
      p.hunger = Math.max(0, p.hunger - decay * dt);
      if (p.hunger <= 0) {
        p.hp -= STARVE_DPS * dt;
        if (p.hp <= 0 && !p.dead) this.killPlayer(p);
      }
      // Keep max HP in sync with who they've become.
      this.recomputeMaxHp(p);
    }
  }

  // Max HP is derived from social standing + combat + endurance + swimming.
  private recomputeMaxHp(p: PlayerState) {
    const combat = skillLevel(p.skills.combat);
    const swim = skillLevel(p.skills.swimming);
    const endurance = Math.floor((skillLevel(p.skills.woodcutting) + skillLevel(p.skills.mining)) / 2);
    let hp = BASE_HP + combat * HP_PER_COMBAT + swim * HP_PER_SWIM + endurance * HP_PER_ENDURANCE;
    if (p.rank >= 1 && p.rank < HP_RANK_BONUS.length) hp += HP_RANK_BONUS[p.rank];
    if (p.isMayor) hp += HP_MAYOR_BONUS;
    p.maxHp = Math.round(hp);
    if (p.hp > p.maxHp) p.hp = p.maxHp;
  }

  private doSleep(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    if (p.sleeping) { p.sleeping = false; this.tell(p, "You wake up."); return; }
    // Must be next to a lit campfire (homes/beds come with interiors later).
    const fire = [...this.campfires.values()].find(
      (f) => f.region === p.region && Math.hypot(f.x + 0.5 - p.x, f.y + 0.5 - p.y) <= SLEEP_FIRE_RANGE,
    );
    if (!fire) { this.tell(p, "Rest by a campfire to sleep (craft one with 4 wood)."); return; }
    p.sleeping = true;
    this.tell(p, "You curl up by the fire to rest… (move or press Z to wake)");
  }

  private updateSleep(dt: number) {
    for (const p of this.players.values()) {
      if (!p.sleeping) continue;
      const s = this.sessionFor(p.id);
      // Moving (or being dead) wakes you.
      if (p.dead || (s && (s.dx !== 0 || s.dy !== 0))) { p.sleeping = false; continue; }
      // Still near a fire?
      const fire = [...this.campfires.values()].find(
        (f) => f.region === p.region && Math.hypot(f.x + 0.5 - p.x, f.y + 0.5 - p.y) <= SLEEP_FIRE_RANGE,
      );
      if (!fire) { p.sleeping = false; continue; }
      p.hp = Math.min(p.maxHp, p.hp + SLEEP_HEAL_PS * dt);
      p.stamina = Math.min(p.maxStamina, p.stamina + SLEEP_HEAL_PS * dt);
    }
  }

  // Periodically rank everyone by Banfielder points and crown the top local as
  // the unofficial mayor. When the crown changes hands, everyone hears about it.
  private recomputeRanks(now: number) {
    if (now < this.nextRankCheck) return;
    this.nextRankCheck = now + RANK_RECOMPUTE_MS;
    const ranked = [...this.players.values()].sort((a, b) => b.banfielderPts - a.banfielderPts);
    let i = 0;
    for (const p of ranked) {
      p.rank = p.banfielderPts > 0 ? i + 1 : 0;
      p.isMayor = false;
      i++;
    }
    const top = ranked[0];
    const newMayorId = top && top.banfielderPts > 0 ? top.id : null;
    if (newMayorId && newMayorId !== this.mayorId) {
      const prev = this.mayorId ? this.players.get(this.mayorId) : null;
      const mayor = this.players.get(newMayorId)!;
      mayor.isMayor = true;
      this.broadcastLog(
        prev
          ? `📣 ${mayor.name} has unseated ${prev.name} as Bamfield's unofficial mayor!`
          : `📣 ${mayor.name} is Bamfield's unofficial mayor!`,
      );
      this.mayorId = newMayorId;
    } else if (newMayorId) {
      this.players.get(newMayorId)!.isMayor = true;
    } else {
      this.mayorId = null;
    }
    for (const p of this.players.values()) this.recomputeMaxHp(p);
    this.recomputeTitles();
  }

  // Award community roles and broadcast the leaderboard. A title can be unseated
  // by anyone who tops the relevant metric, just like the unofficial mayor.
  private recomputeTitles() {
    const players = [...this.players.values()];
    const best = (score: (p: PlayerState) => number) => {
      let top: PlayerState | null = null, s = 0;
      for (const p of players) { const v = score(p); if (v > s) { s = v; top = p; } }
      return top;
    };
    const speciesCount = (p: PlayerState) => Object.keys(this.discoveries.get(p.name) ?? {}).length;
    const president = best(speciesCount);
    const chief = best((p) => this.repairsBy.get(p.name) ?? 0);
    const responders = players
      .filter((p) => (this.healsBy.get(p.name) ?? 0) > 0)
      .sort((a, b) => (this.healsBy.get(b.name) ?? 0) - (this.healsBy.get(a.name) ?? 0))
      .slice(0, 6);
    const nurse = responders[0] ?? null;

    const announce = (role: string, who: PlayerState | null, prevId: string | null, set: (id: string | null) => void) => {
      const id = who?.id ?? null;
      if (id && id !== prevId) this.broadcastLog(`📣 ${who!.name} is now ${role}!`);
      set(id);
    };
    announce("BMSC President", president, this.presidentId, (id) => (this.presidentId = id));
    announce("Fire Chief", chief, this.chiefId, (id) => (this.chiefId = id));
    announce("the Nurse", nurse, this.nurseId, (id) => (this.nurseId = id));

    // Stamp titles onto each player for the HUD/leaderboard.
    for (const p of players) {
      const titles: string[] = [];
      if (p.isMayor) titles.push("Mayor");
      if (p.id === this.presidentId) titles.push("BMSC President");
      if (p.id === this.chiefId) titles.push("Fire Chief");
      if (nurse && p.id === nurse.id) titles.push("Nurse");
      else if (responders.some((r) => r.id === p.id)) titles.push("First Responder");
      p.titles = titles;
    }

    const data: LeaderboardData = {
      mayor: this.mayorId ? this.players.get(this.mayorId)?.name ?? null : null,
      president: president?.name ?? null,
      chief: chief?.name ?? null,
      nurse: nurse?.name ?? null,
      responders: responders.slice(1).map((r) => r.name),
      topBanfielders: players
        .filter((p) => p.banfielderPts > 0)
        .sort((a, b) => b.banfielderPts - a.banfielderPts)
        .slice(0, 8)
        .map((p) => ({ name: p.name, pts: p.banfielderPts })),
    };
    this.broadcast({ t: "leaderboard", data });
  }

  private doCraft(playerId: string, recipeId: CraftRecipeId) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const recipe = CRAFT_RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return;
    const s = this.sessionFor(p.id);

    // Cooking is special: it needs a nearby fire and consumes whatever raw
    // food you have, rather than fixed ingredients. Handle before the cost check.
    if (recipeId === "cook") {
      this.doCook(p);
      return;
    }

    // Plank can be crafted from ANY wood species (3 pieces = 1 plank).
    if (recipeId === "plank") {
      const woodIds: ItemId[] = ["wood","cedarwood","sprucewood","firwood","hemwood","pinewood","yewwood","alderwood","mapwood"];
      let need = 3;
      for (const wid of woodIds) {
        const have = p.inventory[wid] ?? 0;
        if (have <= 0) continue;
        const use = Math.min(have, need);
        p.inventory[wid] = have - use;
        if (p.inventory[wid] === 0) delete p.inventory[wid];
        need -= use;
        if (need <= 0) break;
      }
      if (need > 0) { this.tell(p, `Need 3 wood total (any species) to make a plank.`); return; }
      this.addItem(p.inventory, "plank", 1);
      this.giveXP(p, "woodcutting", 12);
      this.tell(p, "Crafted 1 plank.");
      return;
    }

    // Check and consume ingredients.
    for (const [item, qty] of Object.entries(recipe.needs) as [ItemId, number][]) {
      if ((p.inventory[item] ?? 0) < qty) {
        this.tell(p, `Need ${qty} ${ITEM_LABEL[item]} to craft.`);
        return;
      }
    }
    for (const [item, qty] of Object.entries(recipe.needs) as [ItemId, number][]) {
      p.inventory[item] = (p.inventory[item] ?? 0) - qty;
    }

    if (recipeId === "campfire") {
      const id = `fire${this.idCounter++}`;
      this.campfires.set(id, {
        id, region: p.region,
        x: Math.round(p.x), y: Math.round(p.y),
        expiresAt: Date.now() + CAMPFIRE_BURN_MS,
      });
      this.broadcastLog(`${p.name} lit a campfire.`);
      return;
    }

    if (recipeId === "furnace") {
      const id = `forge${this.idCounter++}`;
      this.furnaces.set(id, { id, region: p.region, x: Math.round(p.x), y: Math.round(p.y) });
      this.broadcastLog(`${p.name} built a furnace.`);
      return;
    }

    if (recipeId === "smelt") {
      const furnace = [...this.furnaces.values()].find(
        (f) => f.region === p.region && Math.hypot(f.x + 0.5 - p.x, f.y + 0.5 - p.y) <= 2.5,
      );
      if (!furnace) {
        this.tell(p, "Stand next to a furnace to smelt (build one: 6 stone + 2 iron ore).");
        // Refund consumed ingredients.
        for (const [item, qty] of Object.entries(recipe.needs) as [ItemId, number][]) {
          this.addItem(p.inventory, item, qty);
        }
        return;
      }
      this.addItem(p.inventory, "ironBar", 1);
      this.tell(p, "Smelted 2 iron ore → 1 iron bar. (Craft shiny lures from iron bars!)");
      return;
    }

    // Special-case recipes that do world actions rather than produce items.
    if (recipeId === "repairVehicle") {
      let best: VehicleRecord | null = null;
      let bestD = VEHICLE_BOARD_RANGE * 2;
      for (const v of this.vehicles.values()) {
        if (v.region !== p.region) continue;
        const d = Math.hypot(v.x - p.x, v.y - p.y);
        if (d <= bestD) { bestD = d; best = v; }
      }
      if (best) {
        best.hp = Math.min(best.maxHp, best.hp + 50);
        best.lastDriven = Date.now();
        this.tell(p, `Repaired the ${best.kind} (+50 HP).`);
      } else {
        this.tell(p, "No vehicle nearby to repair.");
        // Refund if no target found.
        for (const [item, qty] of Object.entries(recipe.needs) as [ItemId, number][]) {
          this.addItem(p.inventory, item, qty);
        }
      }
      return;
    }

    if (recipeId === "repairBuilding") {
      const region = this.regions.get(p.region);
      const b = region ? this.nearestBuilding(region, p.x, p.y, 2.5) : null;
      if (b) {
        b.hp = Math.min(b.maxHp, b.hp + 80);
        if (b.kind === "rubble" && b.hp > b.maxHp * 0.5) {
          b.kind = (b as any).originalKind ?? "house";
        }
        this.tell(p, `Repaired building (+80 HP).`);
      } else {
        this.tell(p, "No building nearby to repair.");
        for (const [item, qty] of Object.entries(recipe.needs) as [ItemId, number][]) {
          this.addItem(p.inventory, item, qty);
        }
      }
      return;
    }

    // Regular item output.
    for (const [item, qty] of Object.entries(recipe.gives) as [ItemId, number][]) {
      this.addItem(p.inventory, item, qty);
    }
    this.tell(p, `Crafted: ${recipe.name}.`);
    void s;
  }

  // Buy or sell at a shop building you're standing next to.
  private doTrade(
    playerId: string,
    buildingId: string,
    kind: "buy" | "sell",
    item: ItemId,
    qty: number,
  ) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    const b = region.buildings.find((bb) => bb.id === buildingId);
    if (!b || !b.shop) return;
    // Must be within reach of the shop.
    const d = Math.hypot(b.x + b.w / 2 - p.x, b.y + b.h / 2 - p.y);
    if (d > Math.max(b.w, b.h) / 2 + 2.5) {
      this.tell(p, "Step up to the counter to trade.");
      return;
    }
    const n = Math.max(1, Math.min(999, Math.floor(qty)));

    if (kind === "sell") {
      const offer = b.shop.buys.find((o) => o.item === item);
      if (!offer) { this.tell(p, `${b.shop.name} isn't buying that.`); return; }
      const have = p.inventory[item] ?? 0;
      const sellN = Math.min(n, have);
      if (sellN <= 0) { this.tell(p, `You have no ${ITEM_LABEL[item]} to sell.`); return; }
      p.inventory[item] = have - sellN;
      const earned = sellN * offer.price;
      p.money += earned;
      this.tell(p, `Sold ${sellN}× ${ITEM_LABEL[item]} for $${earned}. (You have $${p.money})`);
    } else {
      const offer = b.shop.sells.find((o) => o.item === item);
      if (!offer) { this.tell(p, `${b.shop.name} doesn't sell that.`); return; }
      const affordable = Math.min(n, Math.floor(p.money / offer.price));
      if (affordable <= 0) { this.tell(p, `Not enough money — ${ITEM_LABEL[item]} is $${offer.price}.`); return; }
      p.money -= affordable * offer.price;
      this.addItem(p.inventory, item, affordable);
      this.tell(p, `Bought ${affordable}× ${ITEM_LABEL[item]} for $${affordable * offer.price}. (You have $${p.money})`);
    }
  }

  // Cook all raw meat/fish on a nearby campfire.
  private doCook(p: PlayerState) {
    const fire = [...this.campfires.values()].find(
      (f) => f.region === p.region && Math.hypot(f.x + 0.5 - p.x, f.y + 0.5 - p.y) <= COOK_RANGE,
    );
    if (!fire) {
      this.tell(p, "Stand by a campfire to cook (craft one with 4 wood).");
      return;
    }
    let cooked = 0;
    for (const [raw, done] of Object.entries(COOK_MAP) as [ItemId, ItemId][]) {
      const n = p.inventory[raw] ?? 0;
      if (n > 0) {
        p.inventory[raw] = 0;
        this.addItem(p.inventory, done, n);
        cooked += n;
      }
    }
    this.tell(p, cooked > 0 ? `Cooked ${cooked} item(s) over the fire.` : "Nothing raw to cook.");
  }

  // Eat the most-filling food you carry; restores hunger (and a little HP).
  private doEat(playerId: string, item?: ItemId) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    let chosen: ItemId | null = null;
    if (item && FOOD_VALUE[item] && (p.inventory[item] ?? 0) > 0) {
      // Eat the exact item the player chose from their bag.
      chosen = item;
    } else {
      // Otherwise pick the food that restores the most hunger and that we have.
      let bestHunger = -1;
      for (const [it, val] of Object.entries(FOOD_VALUE) as [ItemId, { hunger: number; hp: number }][]) {
        if ((p.inventory[it] ?? 0) > 0 && val.hunger > bestHunger) {
          bestHunger = val.hunger;
          chosen = it;
        }
      }
    }
    if (!chosen) {
      this.tell(p, "No food to eat. Hunt crabs, fish, or pick berries.");
      return;
    }
    p.inventory[chosen] = (p.inventory[chosen] ?? 0) - 1;
    const val = FOOD_VALUE[chosen]!;
    p.hunger = Math.min(p.maxHunger, p.hunger + val.hunger);
    const gainedHp = Math.min(val.hp, p.maxHp - p.hp);
    p.hp += gainedHp;
    this.tell(p, `Ate ${ITEM_LABEL[chosen]} (+${val.hunger} food${gainedHp > 0 ? `, +${Math.round(gainedHp)} HP` : ""}).`);
  }

  // Drop 1 (or all) of an item onto the ground as a pickup-able loot drop.
  private doDrop(playerId: string, item: ItemId, all: boolean) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const have = p.inventory[item] ?? 0;
    if (have <= 0) return;
    const qty = all ? have : 1;
    p.inventory[item] = have - qty;
    if (p.inventory[item]! <= 0) delete p.inventory[item];
    if (p.equipped === item && (p.inventory[item] ?? 0) <= 0) p.equipped = null;
    // Place it just in front of the player so it doesn't instantly re-pickup.
    const id = `drop-${++this.idCounter}`;
    this.lootDrops.set(id, {
      id, region: p.region,
      x: p.x + Math.cos(p.dir) * 0.8,
      y: p.y + Math.sin(p.dir) * 0.8,
      item, qty,
    });
    this.tell(p, `Dropped ${qty}× ${ITEM_LABEL[item] ?? item}.`);
  }

  // Drink from an adjacent freshwater lake. Takes the edge off hunger but can't
  // fill you up — fresh water only tops you back to a "thirst-quenched" ceiling,
  // never to full. Salt water (the ocean) isn't drinkable.
  private doDrink(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    let fresh = false, salt = false;
    for (const [dx, dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]] as const) {
      const t = this.tileAt(region.map, px + dx + 0.5, py + dy + 0.5);
      if (t === Tile.FreshWater) fresh = true;
      else if (t === Tile.Water) salt = true;
    }
    if (!fresh) {
      this.tell(p, salt ? "That's salt water — you can't drink the ocean." : "Find a freshwater lake to drink from.");
      return;
    }
    const now = Date.now();
    if (now - (this.lastDrink.get(p.id) ?? 0) < 2500) return; // sip throttle
    this.lastDrink.set(p.id, now);
    const CEILING = p.maxHunger * 0.6; // water alone only gets you ~60% full
    if (p.hunger >= CEILING) {
      this.tell(p, "You drink your fill — but water won't fill an empty belly. Find food.");
      return;
    }
    p.hunger = Math.min(CEILING, p.hunger + 8);
    this.tell(p, "You drink the cool fresh water. (+hunger — but you still need real food.)");
  }

  private doFishToggle(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;

    if (this.fishingStates.has(playerId)) {
      // Cancel fishing.
      this.fishingStates.delete(playerId);
      p.fishing = false;
      return;
    }
    if (FISHING_ROD_REQUIRED && (p.inventory.rod ?? 0) < 1) {
      const s = this.sessionFor(p.id);
      if (s) this.send(s.ws, { t: "log", msg: "Need a fishing rod. Craft one: 3 wood + 2 iron." });
      return;
    }
    // Must be within 1 tile of water — standing on the shore, not swimming out.
    const region = this.regions.get(p.region);
    if (!region) return;
    const waterline = this.currentWaterline(Date.now());
    const { width: mw, height: mh, tiles, elevation } = region.map;
    const px = Math.floor(p.x), py = Math.floor(p.y);
    const nearWater = [[0,0],[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => {
      const nx = px + dx, ny = py + dy;
      if (nx < 0 || ny < 0 || nx >= mw || ny >= mh) return false;
      const i = ny * mw + nx;
      return isWaterTile(tiles[i] as Tile) || waterline > elevation[i];
    });
    if (!nearWater) {
      const s = this.sessionFor(p.id);
      if (s) this.send(s.ws, { t: "log", msg: "Cast from the shore — stand next to the water to fish." });
      return;
    }
    const fishingLevel = skillLevel(p.skills.fishing);
    const hasLure = (p.inventory.shinyLure ?? 0) > 0;
    const lureBonus = hasLure ? 0.75 : 1.0; // lure cuts wait time by 25%
    const waitMs = Math.max(1500, Math.round((FISHING_TIME_MS - fishingLevel * 50) * lureBonus));
    this.fishingStates.set(playerId, Date.now() + waitMs);
    p.fishing = true;
    const s = this.sessionFor(p.id);
    if (s) this.send(s.ws, { t: "log", msg: "Line cast… (press G again to cancel)" });
  }

  private updateFishing(now: number) {
    for (const [playerId, readyAt] of this.fishingStates) {
      if (now < readyAt) continue;
      this.fishingStates.delete(playerId);
      const p = this.players.get(playerId);
      if (!p || p.dead) continue;
      p.fishing = false;
      const fishingLevel = skillLevel(p.skills.fishing);
      const hasLure = (p.inventory.shinyLure ?? 0) > 0;
      const catchChance = Math.min(0.95, (0.55 + fishingLevel * 0.01) + (hasLure ? 0.20 : 0));
      if (Math.random() < catchChance) {
        const region = this.regions.get(p.region)!;
        const waterline = this.currentWaterline(now);
        const depth = this.depthAt(region.map, p.x, p.y, waterline);
        const caught = pickFish(depth, hasLure, fishingLevel);
        const bonus = (fishingLevel >= 20 || hasLure) && Math.random() < 0.3 ? 1 : 0;
        this.addItem(p.inventory, caught, 1 + bonus);
        // Small "live fish" freshness mechanic only for basic fish.
        if (caught === "fish") this.liveFishTimer.set(p.id, now);
        this.giveXP(p, "fishing", XP_FISH);
        const lureMsg = hasLure ? " (shiny lure!)" : "";
        const depthHint = depth >= DEPTH_OCEAN ? " (deep-sea catch!)" : depth >= DEPTH_DEEP ? " (deep water!)" : "";
        this.tell(p, `Caught ${1 + bonus}× ${ITEM_LABEL[caught]}!${lureMsg}${depthHint}`);
      } else {
        this.tell(p, "The fish got away…");
      }
    }
  }

  // Live fish suffocate after a minute out of water, turning into raw fish.
  private updateLiveFish(now: number) {
    for (const [pid, caughtAt] of this.liveFishTimer) {
      if (now - caughtAt < 60_000) continue;
      const p = this.players.get(pid);
      this.liveFishTimer.delete(pid);
      if (!p) continue;
      const count = p.inventory["liveFish"] ?? 0;
      if (count <= 0) continue;
      p.inventory["liveFish"] = 0;
      this.addItem(p.inventory, "fish", count);
      this.tell(p, "Your live fish died — now just raw fish. Get to the BMSC quicker next time!");
    }
  }

  private doChat(playerId: string, rawMsg: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const msg = rawMsg.slice(0, 160).trim();
    if (!msg) return;

    // Commands first (so "/team ..." isn't read as global chat).
    if (msg.startsWith("/team")) {
      const name = msg.slice(5).trim().slice(0, 20);
      if (!name) {
        if (p.team) this.tell(p, `You left team "${p.team}".`);
        p.team = null;
      } else {
        p.team = name;
        this.tell(p, `You joined team "${name}". Use // to talk to your team.`);
      }
      return;
    }
    if (msg.startsWith("/who")) {
      const here = [...this.players.values()].filter((q) => !q.dead).map((q) => q.name + (q.team ? `(${q.team})` : "")).join(", ");
      this.tell(p, `Online: ${here}`);
      return;
    }

    // ---- Admin/testing commands (open to all for now) -----------------------
    if (msg.startsWith("/give ")) {
      const parts = msg.slice(6).trim().split(/\s+/);
      let qty = 1, target = "";
      if (parts.length >= 2) {
        const n0 = parseInt(parts[0]), n1 = parseInt(parts[1]);
        if (!isNaN(n0)) { qty = n0; target = parts[1] ?? ""; }
        else { target = parts[0]; qty = isNaN(n1) ? 1 : n1; }
      } else { target = parts[0] ?? ""; }
      let sk = target.toLowerCase();
      if (sk === "wand") sk = "paintwand"; // alias
      if (sk === "wings") {
        const secs = isNaN(qty) ? 30 : Math.min(qty, 600);
        this.speedBoostUntil.set(p.id, Date.now() + secs * 1000);
        this.tell(p, `Wings active for ${secs}s — 5× speed!`);
        return;
      }
      const matchSkill = SKILL_NAMES.find((s) => s.toLowerCase() === sk);
      const matchItem = ITEM_IDS.find((id) => id.toLowerCase() === sk);
      if (matchSkill) {
        p.skills[matchSkill] = qty * qty; // qty = desired level, xp = level²
        this.tell(p, `Skill ${matchSkill} → level ${qty} (${qty * qty} XP).`);
      } else if (matchItem) {
        this.addItem(p.inventory, matchItem, qty);
        this.tell(p, `Gave ${qty}× ${ITEM_LABEL[matchItem]}.`);
      } else {
        this.tell(p, `Unknown: "${target}". Items: ${ITEM_IDS.join(" ")} | Skills: ${SKILL_NAMES.join(" ")} | wings`);
      }
      return;
    }
    if (msg.startsWith("/remove ")) {
      const target = msg.slice(8).trim().toLowerCase();
      if (target === "wings") {
        this.speedBoostUntil.delete(p.id);
        p.speedBoosted = false;
        this.tell(p, "Wings removed.");
      } else {
        const matchItem = ITEM_IDS.find((id) => id.toLowerCase() === target);
        if (matchItem) {
          const had = p.inventory[matchItem] ?? 0;
          delete p.inventory[matchItem];
          this.tell(p, `Removed ${had}× ${ITEM_LABEL[matchItem]} from inventory.`);
        } else {
          this.tell(p, `Unknown target: "${target}". Try /remove wings or /remove [item].`);
        }
      }
      return;
    }
    if (msg.startsWith("/money ")) {
      const n = parseInt(msg.slice(7).trim());
      if (isNaN(n)) { this.tell(p, "Usage: /money [amount]"); return; }
      p.money += n;
      this.tell(p, `Added $${n}. Balance: $${p.money}.`);
      return;
    }
    if (msg.startsWith("/tp ")) {
      const [, , rawX, rawY] = msg.split(/\s+/);
      const tx = parseFloat(rawX ?? ""), ty = parseFloat(rawY ?? "");
      if (isNaN(tx) || isNaN(ty)) { this.tell(p, "Usage: /tp [x] [y]"); return; }
      p.x = tx; p.y = ty;
      this.tell(p, `Teleported to (${tx}, ${ty}).`);
      return;
    }
    if (msg.startsWith("/god")) {
      if (this.godPlayers.has(p.id)) {
        this.godPlayers.delete(p.id);
        this.tell(p, "God mode OFF.");
      } else {
        this.godPlayers.add(p.id);
        p.hp = p.maxHp; p.hunger = p.maxHunger; p.stamina = p.maxStamina;
        this.tell(p, "God mode ON — immune to all damage, hunger, and drowning.");
      }
      return;
    }
    if (msg.startsWith("/tide ")) {
      const arg = msg.slice(6).trim().toLowerCase();
      const now = Date.now();
      if (arg === "tsunami") {
        this.event = "tsunami"; this.eventUntil = now + 60_000;
        this.broadcastLog("⚠ TSUNAMI INCOMING — get to high ground immediately!");
      } else if (arg === "king") {
        this.event = "king"; this.eventUntil = now + 600_000;
        this.broadcastLog("A king tide is rolling in — watch the inlet!");
      } else if (arg === "none" || arg === "low" || arg === "normal") {
        this.event = "none";
        this.tell(p, "Tide event cleared.");
      } else {
        this.tell(p, "Usage: /tide [tsunami|king|none]");
      }
      return;
    }
    if (msg.startsWith("/spawn ")) {
      const kind = msg.slice(7).trim().toLowerCase();
      const region = this.regions.get(p.region);
      if (!region) return;
      // Spawn vehicle (car or boat) right in front of the player.
      if (kind === "car" || kind === "boat") {
        const fwd = kind === "boat" ? 3 : 2;
        const vx = p.x + Math.cos(p.dir) * fwd;
        const vy = p.y + Math.sin(p.dir) * fwd;
        const vid = `spawn-${kind}-${++this.idCounter}`;
        this.vehicles.set(vid, {
          id: vid, kind, region: p.region,
          x: vx, y: vy, dir: p.dir,
          hp: 100, maxHp: 100,
          fuel: 100, maxFuel: 100,
          driverId: null,
          lastDriven: Date.now(),
        });
        this.tell(p, `Spawned a ${kind} in front of you. Press E to board.`);
        return;
      }
      const id = `spawn-${kind}-${++this.idCounter}`;
      this.creatures.set(id, { id, kind: kind as CreatureKind, region: p.region, x: p.x + 2, y: p.y + 2, hp: creatureHp(kind as CreatureKind) });
      this.tell(p, `Spawned a ${kind} at (${Math.round(p.x + 2)}, ${Math.round(p.y + 2)}).`);
      return;
    }
    if (msg.startsWith("/dummy")) {
      // Spawn a training dummy that can be grabbed and thrown. Auto-removes after 60 s.
      const region = this.regions.get(p.region);
      if (!region) return;
      const DUMMY_LIFETIME_MS = 60_000;
      const did = `dummy-${++this.idCounter}`;
      const dx = p.x + Math.cos(p.dir) * 2.5;
      const dy = p.y + Math.sin(p.dir) * 2.5;
      const dummySpot = this.landSpawn(region, Math.round(dx), Math.round(dy));
      const dummy: PlayerState = {
        id: did, name: "Training Dummy", region: p.region,
        x: dummySpot.x, y: dummySpot.y, dir: 0,
        hp: 100, maxHp: 100, stamina: 100, maxStamina: 100,
        hunger: 100, maxHunger: 100,
        skills: defaultSkills(), banfielderPts: 0, rank: 0, isMayor: false,
        inventory: {}, money: 0, team: null,
        appearance: { skin: "#c4a35a", hair: "#5a3c1a", shirt: "#8d6e4c" },
        swimming: false, dodging: false, fishing: false, sleeping: false,
        vehicleId: null, dead: false, equipped: null, titles: [],
        speedBoosted: false, mode: "combat", stance: "high",
        transforming: false, grabbing: null, grabbedBy: null,
        spin: 0, knockedOut: false, blocking: false,
        hiding: false, playingDead: false, jumping: false, jumpPhase: 0, listenMode: false,
      };
      this.players.set(did, dummy);
      this.dummies.set(did, Date.now() + DUMMY_LIFETIME_MS);
      this.tell(p, `Training dummy spawned! It auto-removes in 60 s. (You can grab and throw it!)`);
      return;
    }
    if (msg === "/kill") {
      this.killPlayer(p);
      return;
    }
    if (msg === "/heal") {
      p.hp = p.maxHp; p.hunger = p.maxHunger; p.stamina = p.maxStamina;
      this.tell(p, "Fully healed.");
      return;
    }
    if (msg.startsWith("/where") || msg.startsWith("/pos")) {
      this.tell(p, `(${Math.round(p.x)}, ${Math.round(p.y)}) in ${p.region} | HP: ${Math.round(p.hp)}/${p.maxHp} | $${p.money}`);
      return;
    }
    if (msg === "/setspawn" || msg === "/sethome") {
      p.homeRegion = p.region;
      p.homeX = Math.round(p.x);
      p.homeY = Math.round(p.y);
      this.tell(p, `Home spawn set to (${p.homeX}, ${p.homeY}) in ${p.region}. You'll respawn here after death.`);
      return;
    }
    if (msg === "/delhome" || msg === "/clearspawn") {
      delete p.homeRegion; delete p.homeX; delete p.homeY;
      this.tell(p, "Home spawn cleared — you'll respawn at the default beach.");
      return;
    }
    if (msg === "/claim") {
      const region = this.regions.get(p.region);
      const b = region ? this.nearestBuilding(region, p.x, p.y, 6) : null;
      if (!b) { this.tell(p, "No building nearby to claim. Walk up to one first."); return; }
      if (b.ownerId && b.ownerId !== p.id) {
        this.tell(p, `Already claimed by ${b.ownerName ?? "another player"}.`);
        return;
      }
      b.ownerId = p.id; b.ownerName = p.name;
      this.tell(p, `You claimed "${b.name ?? "this building"}" as your property! Use /lock and /unlock to control access.`);
      return;
    }
    if (msg === "/unclaim") {
      const region = this.regions.get(p.region);
      const b = region ? this.nearestBuilding(region, p.x, p.y, 6) : null;
      if (!b || b.ownerId !== p.id) { this.tell(p, "You don't own a building nearby."); return; }
      delete b.ownerId; delete b.ownerName; b.locked = false;
      this.tell(p, "Property released.");
      return;
    }
    if (msg === "/lock") {
      const region = this.regions.get(p.region);
      const b = region ? this.nearestBuilding(region, p.x, p.y, 6) : null;
      if (!b || b.ownerId !== p.id) { this.tell(p, "You don't own a building nearby."); return; }
      b.locked = true;
      this.tell(p, `${b.name ?? "Building"} locked. Only you can enter.`);
      return;
    }
    if (msg === "/unlock") {
      const region = this.regions.get(p.region);
      const b = region ? this.nearestBuilding(region, p.x, p.y, 6) : null;
      if (!b || b.ownerId !== p.id) { this.tell(p, "You don't own a building nearby."); return; }
      b.locked = false;
      this.tell(p, `${b.name ?? "Building"} unlocked. Anyone can enter.`);
      return;
    }
    if (msg === "/help" || msg === "/commands") {
      this.tell(p, "Commands: /give [qty] [item|skill|wings] | /remove [item|wings] | /money [n] | /tp [x] [y] | /god | /tide [tsunami|king|none] | /spawn [creature|car|boat] | /kill | /heal | /where | /who | /team [name] | /setspawn | /claim | /unclaim | /lock | /unlock");
      return;
    }
    // ---- End admin commands -------------------------------------------------

    // Channels: /// private (to a named player), // team, / or plain = global.
    if (msg.startsWith("///")) {
      const rest = msg.slice(3).trim();
      const sp = rest.indexOf(" ");
      if (sp < 1) { this.tell(p, "Usage: ///Name your message"); return; }
      const targetName = rest.slice(0, sp);
      const text = rest.slice(sp + 1).trim();
      if (!text) return;
      const target = [...this.players.values()].find(
        (q) => q.name.toLowerCase() === targetName.toLowerCase(),
      );
      if (!target) { this.tell(p, `No player named "${targetName}" online.`); return; }
      const ts = this.sessionFor(target.id);
      if (ts) this.send(ts.ws, { t: "chat", from: p.name, msg: text, channel: "private" });
      this.tell(p, `→ ${target.name} (private): ${text}`);
      return;
    }
    if (msg.startsWith("//")) {
      const text = msg.slice(2).trim();
      if (!text) return;
      if (!p.team) { this.tell(p, "Join a team first: /team <name>"); return; }
      for (const s of this.sessions.values()) {
        const sp = this.players.get(s.playerId);
        if (!sp || sp.team !== p.team) continue;
        this.send(s.ws, { t: "chat", from: p.name, msg: text, channel: "team" });
      }
      return;
    }
    // Global — everyone, both regions.
    const text = msg.startsWith("/") ? msg.slice(1).trim() : msg;
    if (!text) return;
    for (const s of this.sessions.values()) {
      this.send(s.ws, { t: "chat", from: p.name, msg: text, channel: "global" });
    }
  }

  // --- skill helpers --------------------------------------------------------
  private giveXP(p: PlayerState, skill: SkillName, amount: number) {
    p.skills[skill] = p.skills[skill] + amount;
  }

  private addItem(inv: Inventory, item: ItemId, qty: number) {
    inv[item] = (inv[item] ?? 0) + qty;
  }

  private updateDummies(now: number) {
    for (const [id, expires] of this.dummies) {
      if (now > expires) {
        this.dummies.delete(id);
        this.players.delete(id);
        this.releaseGrab(this.players.get(id) ?? { id, grabbing: null, grabbedBy: null } as PlayerState);
      }
    }
  }

  private updateResourceRespawn(now: number) {
    // Scan only the handful of depleted nodes, not every node in the world.
    for (const id of this.depletedNodeIds) {
      const n = this.resourceNodes.get(id);
      if (!n || !n.depleted) { this.depletedNodeIds.delete(id); continue; }
      if (n.respawnAt !== null && now >= n.respawnAt) {
        n.depleted = false;
        n.hp = n.maxHp;
        n.respawnAt = null;
        this.depletedNodeIds.delete(id);
      }
    }
  }

  private doBoard(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;

    // Already driving? Step out onto the nearest safe tile.
    if (p.vehicleId) {
      const v = this.vehicles.get(p.vehicleId);
      if (v) v.driverId = null;
      p.vehicleId = null;
      const region = this.regions.get(p.region);
      if (region) {
        // Boats drop you on the nearest land so you don't instantly drown.
        const spot = this.landSpawn(region, Math.round(p.x), Math.round(p.y));
        p.x = spot.x;
        p.y = spot.y;
      }
      return;
    }

    // Otherwise board the closest free vehicle in this region within reach.
    let best: VehicleState | null = null;
    let bestD = VEHICLE_BOARD_RANGE;
    for (const v of this.vehicles.values()) {
      if (v.region !== p.region || v.driverId) continue;
      const d = Math.hypot(v.x - p.x, v.y - p.y);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    if (best) {
      best.driverId = p.id;
      p.vehicleId = best.id;
      this.kb.delete(p.id);
    }
  }

  private doAttack(playerId: string, charge: number) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return; // no swinging from the driver's seat
    if (p.transforming || p.knockedOut || p.grabbing || p.grabbedBy) return; // busy
    // You can only fight in combat mode — researchers and professionals are
    // peaceful, so anyone visibly in combat mode is the one to watch.
    if (p.mode !== "combat") {
      this.tell(p, "You can only fight in Combat mode. Press Tab to switch.");
      return;
    }
    p.sleeping = false;
    const s = this.sessionFor(p.id);
    if (!s) return;
    const now = Date.now();
    // Bare-handed in combat mode: stance picks punch (high) vs kick (low).
    const fist = p.mode === "combat" ? (p.stance === "low" ? KICK : PUNCH) : FIST;
    const wpn = (p.equipped && WEAPONS[p.equipped]) || fist;
    if (now - s.lastAttack < wpn.cooldownMs) return; // weapon-specific cooldown
    if (p.stamina < wpn.stamina) return;             // too winded
    const combatBonus = 1 + skillLevel(p.skills.combat) * 0.006;
    if (wpn.melee) this.meleeAttack(p, s, wpn, charge, combatBonus, now);
    else this.rangedAttack(p, s, wpn, combatBonus, now);
  }

  // Apply a hit to a creature: damage, knockback, loot + XP on kill.
  private hitCreature(p: PlayerState, c: CreatureState, damage: number, knockback: number) {
    c.hp -= damage;
    this.applyKnockback(c.id, c.x - p.x, c.y - p.y, knockback);
    if (c.hp <= 0) {
      this.giveXP(p, "combat", creatureHp(c.kind) * XP_KILL_PER_HP);
      const drops = rollLoot(c.kind);
      if (drops.length > 0) {
        // Scatter drops around the creature's death position.
        const angle0 = Math.random() * Math.PI * 2;
        for (let i = 0; i < drops.length; i++) {
          const ang = angle0 + (i / drops.length) * Math.PI * 2;
          const dist = 0.5 + Math.random() * 0.8;
          const id = `drop-${++this.idCounter}`;
          this.lootDrops.set(id, {
            id, region: c.region,
            x: c.x + Math.cos(ang) * dist,
            y: c.y + Math.sin(ang) * dist,
            item: drops[i].item,
            qty: drops[i].qty,
          });
        }
      }
      this.creatures.delete(c.id);
      this.kb.delete(c.id);
    }
  }

  // Apply a hit to another player (PvP), respecting their dodge i-frames.
  private hitPlayer(attacker: PlayerState, target: PlayerState, damage: number, knockback: number) {
    if (target.dead) return;
    const ts = this.sessionFor(target.id);
    if (ts && Date.now() < ts.iframeUntil) return; // dodged
    if (this.godPlayers.has(target.id)) return; // god mode: immune
    // A raised block soaks most of the blow (and the shove).
    if (target.blocking) { damage *= 0.25; knockback *= 0.4; }
    target.hp -= damage;
    this.applyKnockback(target.id, target.x - attacker.x, target.y - attacker.y, knockback);
    this.giveXP(attacker, "combat", damage * 0.15);
    if (target.hp <= 0 && !target.dead) this.killPlayer(target);
  }

  private meleeAttack(p: PlayerState, s: Session, wpn: WeaponStat, charge: number, combatBonus: number, now: number) {
    s.lastAttack = now;
    p.stamina -= wpn.stamina;
    // Tell everyone in the region to play this attacker's swing animation.
    this.broadcastToRegion(p.region, { t: "fx", kind: "melee", region: p.region, id: p.id, stance: p.stance, weapon: p.equipped });
    const ch = Math.max(0, Math.min(1, charge));
    const scale = (1 + CHARGE_BONUS * ch) * combatBonus;
    const range = wpn.range * (1 + 0.3 * ch);
    const damage = wpn.damage * scale;
    const knockback = (wpn.knockback ?? ATTACK_KNOCKBACK) * scale;
    const arc = wpn.arc ?? ATTACK_ARC;
    const inArc = (dx: number, dy: number, d: number) => {
      if (d > range) return false;
      let diff = Math.abs(Math.atan2(dy, dx) - p.dir);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      return diff <= arc;
    };
    // Nearest creature in the swing arc.
    let bestC: CreatureState | null = null, bestD = range;
    for (const c of this.creatures.values()) {
      if (c.region !== p.region) continue;
      const dx = c.x - p.x, dy = c.y - p.y, d = Math.hypot(dx, dy);
      if (inArc(dx, dy, d) && d <= bestD) { bestD = d; bestC = c; }
    }
    if (bestC) { this.hitCreature(p, bestC, damage, knockback); return; }
    // Otherwise a player in the arc (PvP).
    for (const t of this.players.values()) {
      if (t.id === p.id || t.region !== p.region) continue;
      const dx = t.x - p.x, dy = t.y - p.y, d = Math.hypot(dx, dy);
      if (inArc(dx, dy, d)) { this.hitPlayer(p, t, damage, knockback); return; }
    }
  }

  private rangedAttack(p: PlayerState, s: Session, wpn: WeaponStat, combatBonus: number, now: number) {
    const ammo = wpn.ammo!;
    if ((p.inventory[ammo] ?? 0) <= 0) {
      this.tell(p, `Out of ${ITEM_LABEL[ammo].toLowerCase()}!`);
      return;
    }
    s.lastAttack = now;
    p.stamina -= wpn.stamina;
    p.inventory[ammo] = (p.inventory[ammo] ?? 0) - 1;

    // Hitscan along the facing direction, within a narrow corridor.
    const dirx = Math.cos(p.dir), diry = Math.sin(p.dir);
    const damage = wpn.damage * combatBonus;
    const kb = wpn.knockback ?? 5;
    let endX = p.x + dirx * wpn.range, endY = p.y + diry * wpn.range;

    let hitC: CreatureState | null = null, hitT: PlayerState | null = null, hitDist = wpn.range;
    const corridor = (ex: number, ey: number): number | null => {
      const rx = ex - p.x, ry = ey - p.y;
      const along = rx * dirx + ry * diry;            // distance along the shot
      if (along < 0 || along > wpn.range) return null;
      const perp = Math.abs(rx * diry - ry * dirx);   // distance off the line
      return perp < 0.8 ? along : null;
    };
    for (const c of this.creatures.values()) {
      if (c.region !== p.region) continue;
      const along = corridor(c.x, c.y);
      if (along !== null && along < hitDist) { hitDist = along; hitC = c; hitT = null; }
    }
    for (const t of this.players.values()) {
      if (t.id === p.id || t.region !== p.region || t.dead) continue;
      const along = corridor(t.x, t.y);
      if (along !== null && along < hitDist) { hitDist = along; hitT = t; hitC = null; }
    }
    if (hitC) { endX = hitC.x; endY = hitC.y; const dmg = damage * (wpn.marineBonus && swimmer(hitC.kind) ? wpn.marineBonus : 1); this.hitCreature(p, hitC, dmg, kb); }
    else if (hitT) { endX = hitT.x; endY = hitT.y; this.hitPlayer(p, hitT, damage, kb); }

    // Tracer for everyone in the region to see.
    this.broadcastToRegion(p.region, { t: "fx", kind: "tracer", region: p.region, x1: p.x, y1: p.y, x2: endX, y2: endY, weapon: p.equipped ?? "bow" });
  }

  private doEquip(playerId: string, item: ItemId | null) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (item === null) {
      p.equipped = null;
      if (p.appearance.worn) delete p.appearance.worn["hand"];
      return;
    }
    const isWeapon = !!WEAPONS[item];
    const isModeTool = SLOT_FOR_ITEM[item] === "hand";
    if (!isWeapon && !isModeTool) return;
    if ((p.inventory[item] ?? 0) <= 0) return;
    p.equipped = item;
    if (!p.appearance.worn) p.appearance.worn = {};
    p.appearance.worn["hand"] = item;
  }

  // Put on or take off a clothing / gear / tool item in a specific slot.
  private doWear(playerId: string, slot: WornSlot, item: ItemId | null) {
    const p = this.players.get(playerId);
    if (!p) return;
    if (!p.appearance.worn) p.appearance.worn = {};

    if (item === null) {
      // Unequip: remove from slot, revert appearance override.
      delete p.appearance.worn[slot];
      this.applyWornAppearance(p);
      return;
    }
    // Validate the item can go into this slot.
    const targetSlot = SLOT_FOR_ITEM[item];
    if (!targetSlot || targetSlot !== slot) {
      this.tell(p, `${item} doesn't go in the ${slot} slot.`);
      return;
    }
    // Must actually own the item (except hand slot handled by doEquip).
    if (slot !== "hand" && (p.inventory[item] ?? 0) <= 0) return;
    // For the hand slot, delegate to the weapon/tool equip logic.
    if (slot === "hand") { this.doEquip(playerId, item); return; }

    // Take off whatever was there before.
    delete p.appearance.worn[slot];
    p.appearance.worn[slot] = item;
    this.applyWornAppearance(p);
    this.tell(p, `Wearing ${ITEM_LABEL[item] ?? item}.`);
  }

  // Recompute shirt/pants/hat appearance from the worn[] map so the world sees
  // the correct colors without a separate "outfit" object.
  private applyWornAppearance(p: PlayerState) {
    const base = this.baseAppearance.get(p.id) ?? p.appearance;
    // Start from their base skin/hair colours.
    p.appearance.shirt = base.shirt;
    p.appearance.pants = base.pants;
    p.appearance.hat = base.hat;
    if (!p.appearance.worn) return;
    for (const item of Object.values(p.appearance.worn)) {
      if (!item) continue;
      const cc = CLOTHING_COLOR[item];
      if (!cc) continue;
      if (cc.shirt) p.appearance.shirt = cc.shirt;
      if (cc.pants) p.appearance.pants = cc.pants;
      if (cc.hat)   p.appearance.hat   = cc.hat;
    }
  }

  private doDodge(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    const s = this.sessionFor(p.id);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastDodge < DODGE_COOLDOWN_MS) return;
    if (p.stamina < DODGE_STAMINA) return;
    s.lastDodge = now;
    s.iframeUntil = now + DODGE_IFRAMES_MS;
    p.stamina -= DODGE_STAMINA;
    p.dodging = true;
    // Lunge: prefer the current input direction, fall back to facing.
    let dx = s.dx;
    let dy = s.dy;
    if (dx === 0 && dy === 0) {
      dx = Math.cos(p.dir);
      dy = Math.sin(p.dir);
    }
    this.applyKnockback(p.id, dx, dy, DODGE_IMPULSE);
  }

  private doRepair(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    const b = this.nearestBuilding(region, p.x, p.y, 1.6);
    if (!b || b.hp >= b.maxHp) return;
    b.hp = Math.min(b.maxHp, b.hp + REPAIR_RATE * (TICK_MS / 1000) * 4);
    this.repairsBy.set(p.name, (this.repairsBy.get(p.name) ?? 0) + 1); // → Fire Chief
    if (b.kind === "rubble" && b.hp > b.maxHp * 0.5) {
      b.kind = (b as any).originalKind ?? "house";
    }
  }

  // Pressing T: catch the bus from anywhere standing on a bus/gate pad.
  private doTravel(ws: WebSocket, playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return; // vehicles stay behind — travel on foot
    const region = this.regions.get(p.region);
    if (!region) return;
    const node = region.travelNodes.find(
      (n) => n.kind !== "sea" && // sea routes are for boats, not foot
        p.x >= n.x - 0.6 && p.x <= n.x + n.w + 0.6 && p.y >= n.y - 0.6 && p.y <= n.y + n.h + 0.6,
    );
    if (!node) return;
    this.footTravel(ws, p, node);
  }

  // Shared foot-travel: move the player to the destination region & resync map.
  private footTravel(ws: WebSocket, p: PlayerState, node: TravelNode) {
    const dest = this.regions.get(node.toRegion);
    if (!dest) return;
    // Bus fare: charge the rider (can't afford it = no ride).
    if (node.fare && node.fare > 0) {
      if (p.money < node.fare) { this.tell(p, `The bus is $${node.fare}. You're short.`); return; }
      p.money -= node.fare;
    }
    const arrive = this.landSpawn(dest, node.toSpawn.x, node.toSpawn.y);
    const sameRegion = p.region === dest.id;
    p.region = dest.id;
    p.x = arrive.x;
    p.y = arrive.y;
    const s = this.sessionFor(p.id);
    if (s) s.travelCdUntil = Date.now() + 1500; // grace so you don't bounce back
    this.sendInit(ws, p);
    if (node.fare) this.tell(p, `You rode the bus${node.fare > 0 ? ` (-$${node.fare})` : ""}.`);
    // Only shout a region change to everyone; an in-world hop is the rider's business.
    if (!sameRegion) this.broadcastLog(`${p.name} arrived in ${dest.name}.`);
  }

  // Auto-travel on foot: just WALK onto a road gate and you cross over — no key.
  // (Bus pads stay manual: catching a scheduled bus is a deliberate T press.)
  private autoTravelOnFoot(p: PlayerState) {
    const s = this.sessionFor(p.id);
    if (!s || Date.now() < s.travelCdUntil) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    const node = region.travelNodes.find(
      (n) => n.kind === "gate" &&
        p.x >= n.x - 0.2 && p.x <= n.x + n.w + 0.2 && p.y >= n.y - 0.2 && p.y <= n.y + n.h + 0.2,
    );
    if (node) this.footTravel(s.ws, p, node);
  }

  // --- NPC wandering --------------------------------------------------------
  private updateNpcWander(dt: number, waterline: number, now: number) {
    const SPEED = 1.2; // tiles/sec
    for (const npc of this.npcs) {
      const w = this.npcWander.get(npc.id);
      if (!w) continue;
      const region = this.regions.get(npc.region);
      if (!region) continue;
      // Time to pick a new target?
      if (now >= w.nextMoveAt) {
        const ang = Math.random() * Math.PI * 2;
        const dist = Math.random() * w.radius;
        const tx = Math.round(w.homeX + Math.cos(ang) * dist);
        const ty = Math.round(w.homeY + Math.sin(ang) * dist);
        // marineBiologist wanders water; others need land.
        const isMarine = npc.kind === "marineBiologist";
        const isWalkable = isMarine
          ? this.depthAt(region.map, tx + 0.5, ty + 0.5, waterline) > 0
          : this.walkable(region.map, tx + 0.5, ty + 0.5, WATERLINE_HIGH, false);
        if (isWalkable) {
          w.targetX = tx; w.targetY = ty;
        }
        w.nextMoveAt = now + 3000 + Math.random() * 5000;
      }
      // Move toward target.
      const dx = w.targetX + 0.5 - npc.x, dy = w.targetY + 0.5 - npc.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.4) {
        const step = SPEED * dt;
        npc.x += (dx / dist) * step;
        npc.y += (dy / dist) * step;
      }
    }
  }

  // --- Hide behind trees ----------------------------------------------------
  private doHide(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    // Must be near a tree.
    const nearTree = this.nodesNear(p.region, p.x, p.y, 1.5).some(
      (n) => n.kind === "tree" && !n.depleted,
    );
    if (!nearTree && !p.hiding) {
      this.tell(p, "Stand near a tree to hide behind it.");
      return;
    }
    p.hiding = !p.hiding;
    if (p.hiding) {
      this.hidingAt.set(playerId, { x: p.x, y: p.y });
      this.tell(p, "You duck behind a tree. Stay still to remain hidden.");
    } else {
      this.hidingAt.delete(playerId);
      this.tell(p, "You step out of hiding.");
    }
  }

  // --- Play dead ------------------------------------------------------------
  private doPlayDead(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    if (p.mode !== "research") { this.tell(p, "Play dead only works in research mode."); return; }
    p.playingDead = !p.playingDead;
    if (p.playingDead) {
      this.playDeadUntil.set(playerId, Date.now() + 15000);
      this.tell(p, "You play dead… Bears won't attack for 15 seconds. Don't move!");
    } else {
      this.playDeadUntil.delete(playerId);
      this.tell(p, "You get back up.");
    }
  }

  // --- Jump -----------------------------------------------------------------
  private doJump(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId || p.jumping) return;
    p.jumping = true;
    p.jumpPhase = 0;
    this.jumpUntil.set(playerId, Date.now() + 400);
  }

  // --- Listen mode ----------------------------------------------------------
  private doListen(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    if (p.mode !== "research") { this.tell(p, "Listen mode only works in research mode."); return; }
    p.listenMode = !p.listenMode;
    if (p.listenMode) {
      this.tell(p, "You go quiet and listen to the forest… (V to cancel, move to cancel)");
    } else {
      this.tell(p, "You stop listening.");
    }
  }

  // --- creatures ------------------------------------------------------------
  private maybeSpawn(now: number, waterline: number) {
    if (now < this.nextSpawn) return;
    this.nextSpawn = now + SPAWN_INTERVAL_MS;
    const phase = phaseForTide(this.tideLevel(now));

    // Only populate regions that currently have players.
    const active = new Set<RegionId>();
    for (const p of this.players.values()) active.add(p.region);

    for (const regionId of active) {
      const region = this.regions.get(regionId)!;
      let count = [...this.creatures.values()].filter((c) => c.region === regionId).length;
      for (let n = 0; n < SPAWN_BATCH && count < CREATURE_CAP_PER_REGION; n++) {
        const kind = pickKind(phase, this.event);
        if (!kind) break;
        const spot = this.findSpawnTile(region, kind, waterline);
        if (!spot) continue;
        const id = `c${this.idCounter++}`;
        this.creatures.set(id, { id, kind, region: regionId, x: spot.x, y: spot.y, hp: creatureHp(kind) });
        count++;

        // Orca spawn in pods (2-5 individuals spread close together).
        if (kind === "orca") {
          if (Math.random() < 0.65) {
            const podSize = 1 + Math.floor(Math.random() * 3); // 1-3 more
            for (let p = 0; p < podSize && count < CREATURE_CAP_PER_REGION; p++) {
              const ox = spot.x + (Math.random() - 0.5) * 8;
              const oy = spot.y + (Math.random() - 0.5) * 8;
              const pid = `c${this.idCounter++}`;
              this.creatures.set(pid, { id: pid, kind, region: regionId, x: ox, y: oy, hp: creatureHp(kind) });
              count++;
            }
          }
          // A spectacle — a local shouts it across the whole region.
          this.broadcastLog("📣 ORCAS in the inlet! A pod's come through — get to the water!");
        }
      }
    }
  }

  private updateCreatures(dt: number, waterline: number, now: number) {
    // When the tide comes in, crabs scuttle back to the sea before they drown
    // on land — they head for the water and vanish into it.
    const crabsRetreat = phaseForTide(this.tideLevel(now)) === "high";
    for (const c of this.creatures.values()) {
      const region = this.regions.get(c.region);
      if (!region) {
        this.creatures.delete(c.id);
        continue;
      }

      // Cougars are elusive — they never hunt players. If anyone comes near they
      // slink off and melt into the forest. A real, fleeting sighting.
      if (c.kind === "cougar") {
        let nearest = Infinity, fx = 0, fy = 0;
        for (const p of this.players.values()) {
          if (p.dead || p.region !== region.id) continue;
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (d < nearest) { nearest = d; fx = c.x - p.x; fy = c.y - p.y; }
        }
        if (nearest < 11) {
          const l = Math.hypot(fx, fy) || 1;
          const sp = creatureSpeed("cougar") * 1.3;
          if (this.walkable(region.map, c.x + (fx / l) * sp * dt, c.y, waterline, false)) c.x += (fx / l) * sp * dt;
          if (this.walkable(region.map, c.x, c.y + (fy / l) * sp * dt, waterline, false)) c.y += (fy / l) * sp * dt;
          if (nearest > 5 && this.tileAt(region.map, c.x, c.y) === Tile.Forest) this.creatures.delete(c.id);
          continue;
        }
        c.x += Math.sin(c.y * 0.5 + now * 0.0005) * 0.5 * dt; // lurk, watching
        c.y += Math.cos(c.x * 0.5 + now * 0.0005) * 0.5 * dt;
        continue;
      }

      if (isNeutral(c.kind)) {
        // Sea otter: shy. Dive and vanish if a player gets too close.
        if (c.kind === "seaOtter") {
          let fled = false;
          for (const p of this.players.values()) {
            if (p.dead || p.region !== region.id) continue;
            const d = Math.hypot(p.x - c.x, p.y - c.y);
            if (d < 4) {
              const dx = c.x - p.x, dy = c.y - p.y, l = Math.hypot(dx, dy) || 1;
              c.x += (dx / l) * 3 * dt;
              c.y += (dy / l) * 3 * dt;
              if (this.depthAt(region.map, c.x, c.y, waterline) > DEPTH_SWIM) {
                this.creatures.delete(c.id); fled = true; // dove under
              }
              break;
            }
          }
          if (fled) continue;
          // Gentle float when undisturbed (bobbing in kelp zone).
          c.x += Math.sin(c.y * 0.9 + now * 0.0009) * 0.6 * dt;
          c.y += Math.cos(c.x * 0.7 + now * 0.0007) * 0.6 * dt;
          continue;
        }

        // Seals/sea lions: follow slow swimmers, wander otherwise.
        if (c.kind === "seal" || c.kind === "sealLion") {
          let target: PlayerState | null = null;
          let tDist = Infinity;
          for (const p of this.players.values()) {
            if (p.dead || p.region !== region.id) continue;
            const d = Math.hypot(p.x - c.x, p.y - c.y);
            if (d < 8 && d < tDist) { target = p; tDist = d; }
          }
          if (target) {
            const s = this.sessionFor(target.id);
            const playerMovingFast = s && s.sprint && (Math.abs(s.dx) > 0.3 || Math.abs(s.dy) > 0.3);
            if (!playerMovingFast && tDist > 1.8) {
              // Drift toward the curious player.
              const dx = target.x - c.x, dy = target.y - c.y, l = Math.hypot(dx, dy) || 1;
              c.x += (dx / l) * 1.4 * dt;
              c.y += (dy / l) * 1.4 * dt;
            } else {
              // Player is moving fast — give them space.
              c.x += Math.sin(c.x + now * 0.001) * 0.6 * dt;
              c.y += Math.cos(c.y + now * 0.001) * 0.6 * dt;
            }
          } else {
            // Wander slowly near shore or water surface.
            c.x += Math.sin(c.y + now * 0.0008) * 0.9 * dt;
            c.y += Math.cos(c.x + now * 0.0006) * 0.9 * dt;
          }
          if (c.y > region.map.height) this.creatures.delete(c.id);
          continue;
        }

        // Prey (deer, elk, grouse): flee from any player within range.
        if (isPrey(c.kind)) {
          const fleeRange = c.kind === "grouse" ? 5 : 9;
          let threat: PlayerState | null = null;
          let threatDist = Infinity;
          for (const p of this.players.values()) {
            if (p.dead || p.region !== region.id) continue;
            const d = Math.hypot(p.x - c.x, p.y - c.y);
            if (d < fleeRange && d < threatDist) { threat = p; threatDist = d; }
          }
          if (threat) {
            const dx = c.x - threat.x, dy = c.y - threat.y, l = Math.hypot(dx, dy) || 1;
            const nx = c.x + (dx / l) * creatureSpeed(c.kind) * dt;
            const ny = c.y + (dy / l) * creatureSpeed(c.kind) * dt;
            if (this.walkable(region.map, nx, c.y, waterline, false)) c.x = nx;
            if (this.walkable(region.map, c.x, ny, waterline, false)) c.y = ny;
          } else {
            // Wander slowly when safe
            const wx = c.x + Math.sin(c.y * 0.7 + now * 0.0004) * 0.8 * dt;
            const wy = c.y + Math.cos(c.x * 0.5 + now * 0.0003) * 0.8 * dt;
            if (this.walkable(region.map, wx, c.y, waterline, false)) c.x = wx;
            if (this.walkable(region.map, c.x, wy, waterline, false)) c.y = wy;
          }
          continue;
        }

        // Orca: curious, stay in deep water, rare capsize.
        if (c.kind === "orca") {
          const depth = this.depthAt(region.map, c.x, c.y, waterline);
          if (depth < DEPTH_DEEP) {
            // Too shallow — steer back toward deeper water (south/center).
            c.y += 0.8 * dt;
            c.x += (region.map.width * 0.5 - c.x) * 0.05 * dt;
          } else {
            // Look for the nearest boat within curious range.
            let nearBoat: import("../shared/protocol").VehicleState | null = null;
            let nearDist = Infinity;
            for (const v of this.vehicles.values()) {
              if (v.kind !== "boat" || v.region !== c.region) continue;
              const d = Math.hypot(v.x - c.x, v.y - c.y);
              if (d < 22 && d < nearDist) { nearBoat = v; nearDist = d; }
            }
            if (nearBoat && nearDist > 5) {
              // Drift toward the boat slowly — curious approach.
              const dx = nearBoat.x - c.x, dy = nearBoat.y - c.y, l = Math.hypot(dx, dy) || 1;
              c.x += (dx / l) * 1.0 * dt;
              c.y += (dy / l) * 1.0 * dt;
            } else if (nearBoat && nearDist <= 5) {
              // Very close — very rare capsize chance (~0.3% per second).
              if (Math.random() < 0.003 * dt) {
                const driver = nearBoat.driverId ? this.players.get(nearBoat.driverId) : null;
                const s2 = driver ? this.sessionFor(driver.id) : null;
                if (s2) this.send(s2.ws, { t: "log", msg: "An orca surfaced under your boat and capsized it!" });
                if (driver) {
                  driver.vehicleId = null;
                  driver.x = nearBoat.x + (Math.random() - 0.5) * 5;
                  driver.y = nearBoat.y + (Math.random() - 0.5) * 5;
                }
                nearBoat.driverId = null;
                nearBoat.hp = Math.max(0, nearBoat.hp - 120);
                this.broadcastLog(`An orca capsized a boat in the ${region.name}!`);
              }
              // Wander nearby.
              c.x += Math.sin(c.y * 0.6 + now * 0.0006) * 1.2 * dt;
              c.y += Math.cos(c.x * 0.5 + now * 0.0005) * 1.2 * dt;
            } else {
              // No boats in range — gentle patrol.
              c.x += Math.sin(c.y * 0.5 + now * 0.0004) * 1.5 * dt;
              c.y += Math.cos(c.x * 0.4 + now * 0.0003) * 1.2 * dt;
            }
          }
          if (c.y > region.map.height || c.y < 0) this.creatures.delete(c.id);
          continue;
        }

        // Whales: drift slowly, exit off the south edge.
        c.x += Math.sin(c.y + c.x) * 0.15 * dt;
        c.y += 0.35 * dt;
        if (c.y > region.map.height) this.creatures.delete(c.id);
        continue;
      }

      // Crabs flee to the water when the tide comes in (gradient-descend the
      // heightmap toward the sea, then vanish once they reach it).
      if (c.kind === "crab" && crabsRetreat) {
        if (
          this.depthAt(region.map, c.x, c.y, waterline) > 0 ||
          this.tileAt(region.map, c.x, c.y) === Tile.Water
        ) {
          this.creatures.delete(c.id); // made it back to the sea
          this.kb.delete(c.id);
          continue;
        }
        const grad = this.downhill(region.map, c.x, c.y);
        const spd = creatureSpeed(c.kind) * 1.4; // a little urgency
        const imp = this.kb.get(c.id);
        const vx = grad.x * spd + (imp?.x ?? 0);
        const vy = grad.y * spd + (imp?.y ?? 0);
        // Heading shoreward, a crab may cross the wet flats it normally avoids.
        if (this.inBounds(region.map, c.x + vx * dt, c.y)) c.x += vx * dt;
        if (this.inBounds(region.map, c.x, c.y + vy * dt)) c.y += vy * dt;
        continue;
      }

      const target = this.creatureTarget(region, c);
      const imp = this.kb.get(c.id);
      const swims = swimmer(c.kind);
      if (target) {
        const dirx = target.x - c.x;
        const diry = target.y - c.y;
        const dist = Math.hypot(dirx, diry) || 1;
        const spd = creatureSpeed(c.kind);
        const vx = (dirx / dist) * spd + (imp?.x ?? 0);
        const vy = (diry / dist) * spd + (imp?.y ?? 0);
        if (this.walkable(region.map, c.x + vx * dt, c.y, waterline, swims)) c.x += vx * dt;
        if (this.walkable(region.map, c.x, c.y + vy * dt, waterline, swims)) c.y += vy * dt;
        if (dist < 1.2) this.creatureAttack(c, target);
      } else if (imp) {
        if (this.walkable(region.map, c.x + imp.x * dt, c.y, waterline, swims)) c.x += imp.x * dt;
        if (this.walkable(region.map, c.x, c.y + imp.y * dt, waterline, swims)) c.y += imp.y * dt;
      }
    }
  }

  private creatureTarget(
    region: Region,
    c: CreatureState,
  ): { x: number; y: number; building?: BuildingState; player?: PlayerState } | null {
    // Neutral creatures (whales, seals, otters) never attack.
    if (isNeutral(c.kind)) return null;
    const waterline = this.currentWaterline(Date.now());
    // Sharks only pursue players in water deep enough for them.
    const deepPredator = c.kind === "dogfish" || c.kind === "sixgill";
    const landPred = isLandPredator(c.kind);
    const creatureDepth = this.depthAt(region.map, c.x, c.y, waterline);
    // Cougars are stealthy — longer detection range but only charge at very close range.
    const detectionRange = c.kind === "cougar" ? 10 : c.kind === "wolf" ? 8 : 6;
    let best: { x: number; y: number; player?: PlayerState } | null = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead || p.region !== region.id) continue;
      // Bears ignore players who are playing dead (research mode mechanic).
      if (p.playingDead && c.kind === "bear") continue;
      const pd = this.depthAt(region.map, p.x, p.y, waterline);
      if (deepPredator && pd <= DEPTH_ANKLE) continue;
      if (landPred && pd > 0) continue; // land predators stay on dry land
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      const range = landPred ? detectionRange : 6;
      if (d < range && d < bestD) {
        if (deepPredator && creatureDepth <= DEPTH_ANKLE) continue;
        bestD = d;
        best = { x: p.x, y: p.y, player: p };
      }
    }
    if (best) return best;
    // Land predators don't attack buildings; only marine/crab do.
    if (landPred) return null;
    const b = region.buildings
      .filter((b) => b.kind !== "rubble")
      .map((b) => ({ b, d: Math.hypot(b.x + b.w / 2 - c.x, b.y + b.h / 2 - c.y) }))
      .sort((a, z) => a.d - z.d)[0];
    if (b) return { x: b.b.x + b.b.w / 2, y: b.b.y + b.b.h / 2, building: b.b };
    return null;
  }

  private creatureAttack(
    c: CreatureState,
    target: { player?: PlayerState; building?: BuildingState },
  ) {
    const dmg = creatureDamage(c.kind) * (TICK_MS / 1000);
    if (target.player) {
      // A well-timed dodge phases you through the hit entirely.
      const ts = this.sessionFor(target.player.id);
      if (ts && Date.now() < ts.iframeUntil) return;
      if (this.godPlayers.has(target.player.id)) return; // god mode: immune
      target.player.hp -= dmg;
      // Shove the player away from the attacker (bounce-back).
      this.applyKnockback(target.player.id, target.player.x - c.x, target.player.y - c.y, HIT_KNOCKBACK);
      if (target.player.hp <= 0 && !target.player.dead) this.killPlayer(target.player);
    } else if (target.building && target.building.kind !== "rubble") {
      target.building.hp -= dmg;
      if (target.building.hp <= 0) {
        (target.building as any).originalKind = target.building.kind;
        target.building.kind = "rubble";
        target.building.hp = 0;
        this.broadcastLog("A structure was reduced to rubble.");
      }
    }
  }

  private killPlayer(p: PlayerState) {
    p.dead = true;
    p.hp = 0;
    this.releaseGrab(p); // drop anyone we held / break free if held
    this.knockoutUntil.delete(p.id);
    this.transformUntil.delete(p.id);
    p.knockedOut = false;
    p.transforming = false;
    if (p.vehicleId) {
      const v = this.vehicles.get(p.vehicleId);
      if (v) v.driverId = null;
      p.vehicleId = null;
    }
    p.fishing = false;
    this.fishingStates.delete(p.id);
    this.deepSince.delete(p.id);
    // Death penalty. Lose a big chunk of Banfielder standing, and take a
    // randomized XP hit per skill (some skills bruise worse than others) so
    // death actually sets you back — but never wipes you to zero.
    p.banfielderPts = Math.max(0, Math.round(p.banfielderPts * (1 - DEATH_PTS_LOSS)));
    for (const sk of Object.keys(p.skills) as SkillName[]) {
      const hit = DEATH_XP_LOSS * (0.6 + Math.random() * 0.9); // ~0.6×–1.5× the base
      p.skills[sk] = Math.max(0, p.skills[sk] * (1 - Math.min(0.6, hit)));
    }
    // Drop half your inventory on death (items just vanish for now — future: loot crate).
    for (const item of Object.keys(p.inventory) as ItemId[]) {
      p.inventory[item] = Math.floor((p.inventory[item] ?? 0) / 2);
    }
    this.broadcastLog(`${p.name} was dragged under. Skills and standing took a hit.`);
    setTimeout(() => {
      p.dead = false;
      p.hp = p.maxHp;
      p.stamina = p.maxStamina;
      p.hunger = p.maxHunger;
      // Use custom home spawn if set and in a valid region, else default beach
      const homeRegion = p.homeRegion && this.regions.has(p.homeRegion) ? this.regions.get(p.homeRegion)! : null;
      const fallbackRegion = this.regions.get(p.region);
      if (homeRegion && p.homeX !== undefined && p.homeY !== undefined) {
        p.region = homeRegion.id;
        const sp = this.landSpawn(homeRegion, p.homeX, p.homeY);
        p.x = sp.x; p.y = sp.y;
      } else if (fallbackRegion) {
        const sp = this.landSpawn(fallbackRegion, fallbackRegion.spawn.x, fallbackRegion.spawn.y);
        p.x = sp.x; p.y = sp.y;
      }
    }, 4000);
  }

  // --- helpers --------------------------------------------------------------
  private inBounds(map: WorldMap, x: number, y: number): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    return tx >= 0 && ty >= 0 && tx < map.width && ty < map.height;
  }

  private tileAt(map: WorldMap, x: number, y: number): Tile | null {
    if (!this.inBounds(map, x, y)) return null;
    return map.tiles[Math.floor(y) * map.width + Math.floor(x)] as Tile;
  }

  // Unit vector toward the lowest-elevation 8-neighbour — i.e. downhill toward
  // the sea. Used so crabs can find the water without a full pathfind.
  private downhill(map: WorldMap, x: number, y: number): { x: number; y: number } {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const here = map.elevation[ty * map.width + tx];
    let bx = 0;
    let by = 0;
    let bestDrop = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
        const drop = here - map.elevation[ny * map.width + nx];
        if (drop > bestDrop) {
          bestDrop = drop;
          bx = dx;
          by = dy;
        }
      }
    }
    const len = Math.hypot(bx, by) || 1;
    return { x: bx / len, y: by / len };
  }

  // How far the given point is under water (>0 means submerged).
  private depthAt(map: WorldMap, x: number, y: number, waterline: number): number {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (!this.inBounds(map, x, y)) return 0;
    return waterline - map.elevation[ty * map.width + tx];
  }

  // Creatures still respect land/water boundaries (players can swim freely).
  private walkable(map: WorldMap, x: number, y: number, waterline: number, swimmer: boolean): boolean {
    if (!this.inBounds(map, x, y)) return false;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    const tile = map.tiles[ty * map.width + tx] as Tile;
    const submerged = submergedAt(map.elevation[ty * map.width + tx], waterline) || isWaterTile(tile);
    return swimmer ? submerged : !submerged;
  }

  private applyKnockback(id: string, dx: number, dy: number, strength: number) {
    const len = Math.hypot(dx, dy) || 1;
    this.kb.set(id, { x: (dx / len) * strength, y: (dy / len) * strength });
  }

  private decayKnockback(dt: number) {
    for (const [id, v] of this.kb) {
      const f = Math.max(0, 1 - KB_FRICTION * dt);
      v.x *= f;
      v.y *= f;
      if (Math.hypot(v.x, v.y) < 0.05) this.kb.delete(id);
    }
  }

  private findSpawnTile(
    region: Region,
    kind: CreatureKind,
    waterline: number,
  ): { x: number; y: number } | null {
    const swims = swimmer(kind);
    // Depth constraints keep each creature in its ecological niche.
    const minDepth =
      (kind === "orca" || kind === "humpback" || kind === "greywhale") ? DEPTH_OCEAN * 0.5
      : kind === "sixgill"  ? DEPTH_DEEP * 0.6
      : kind === "dogfish"  ? DEPTH_SWIM
      : kind === "seal"     ? 0
      : kind === "seaOtter" ? DEPTH_ANKLE
      : kind === "sealLion" ? 0
      : 0; // land creatures: depth=0 (on dry land)
    const maxDepth =
        kind === "crab"      ? DEPTH_DEEP
      : kind === "seaOtter"  ? DEPTH_SWIM
      : kind === "sealLion"  ? DEPTH_SWIM
      // Land creatures spawn on dry land — maxDepth keeps them off the water
      : (isPrey(kind) || isLandPredator(kind)) ? 0
      : Infinity;
    for (let i = 0; i < 60; i++) {
      const x = Math.floor(Math.random() * region.map.width);
      const y = Math.floor(Math.random() * region.map.height);
      if (!this.walkable(region.map, x + 0.5, y + 0.5, waterline, swims)) continue;
      const d = this.depthAt(region.map, x + 0.5, y + 0.5, waterline);
      if (d < minDepth || d > maxDepth) continue;
      return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }

  // Find a beach (Sand) tile at the water's edge near sx,sy — used to give
  // first-time players a "wash ashore" feel (spawn in ankle-deep water).
  private beachSpawn(region: Region, sx: number, sy: number): { x: number; y: number } {
    const cx = Math.floor(sx), cy = Math.floor(sy);
    for (let r = 0; r < Math.max(region.map.width, region.map.height); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const tx = cx + dx, ty = cy + dy;
          const tile = this.tileAt(region.map, tx + 0.5, ty + 0.5);
          if (tile !== Tile.Sand) continue;
          // Check that at least one adjacent tile is water (true beach edge).
          const adjTile = (ddx: number, ddy: number) => this.tileAt(region.map, tx + ddx + 0.5, ty + ddy + 0.5);
          const hasWater = [[1,0],[-1,0],[0,1],[0,-1]].some(([ddx, ddy]) => {
            const t = adjTile(ddx, ddy); return t !== null && isWaterTile(t);
          });
          if (!hasWater) continue;
          // Place player half a tile into the water side.
          const waterDir = [[1,0],[-1,0],[0,1],[0,-1]].find(([ddx, ddy]) => {
            const t = adjTile(ddx, ddy); return t !== null && isWaterTile(t);
          }) ?? [0, 0];
          return {
            x: tx + 0.5 + waterDir[0] * 0.5,
            y: ty + 0.5 + waterDir[1] * 0.5,
          };
        }
      }
    }
    return this.landSpawn(region, sx, sy); // fallback
  }

  // Snap a desired spawn to the nearest tile that stays DRY even at high tide,
  // so players never spawn (and get stuck) in the inlet.
  private landSpawn(region: Region, sx: number, sy: number): { x: number; y: number } {
    const dry = (x: number, y: number) =>
      this.walkable(region.map, x + 0.5, y + 0.5, WATERLINE_HIGH, false);
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    if (dry(cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
    const maxR = Math.max(region.map.width, region.map.height);
    for (let r = 1; r < maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (dry(cx + dx, cy + dy)) return { x: cx + dx + 0.5, y: cy + dy + 0.5 };
        }
      }
    }
    return { x: sx, y: sy };
  }

  // Nearest tile that is open water even at LOW tide, so an arriving boat
  // (and its skipper) land afloat rather than beached.
  private seaSpawn(region: Region, sx: number, sy: number): { x: number; y: number } {
    const wet = (x: number, y: number) =>
      this.inBounds(region.map, x + 0.5, y + 0.5) &&
      this.depthAt(region.map, x + 0.5, y + 0.5, WATERLINE_LOW) > 0;
    const cx = Math.floor(sx);
    const cy = Math.floor(sy);
    if (wet(cx, cy)) return { x: cx + 0.5, y: cy + 0.5 };
    const maxR = Math.max(region.map.width, region.map.height);
    for (let r = 1; r < maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (wet(cx + dx, cy + dy)) return { x: cx + dx + 0.5, y: cy + dy + 0.5 };
        }
      }
    }
    return { x: sx, y: sy };
  }

  // Move a driven vehicle (and its driver) to another region. Boats land in
  // water on the far side; cars land on the road/dry ground.
  private transferVehicle(v: VehicleRecord, driver: PlayerState, toRegion: RegionId, toSpawn: { x: number; y: number }) {
    const dest = this.regions.get(toRegion);
    if (!dest) return;
    const arrive = v.kind === "boat"
      ? this.seaSpawn(dest, toSpawn.x, toSpawn.y)
      : this.landSpawn(dest, toSpawn.x, toSpawn.y);
    v.region = toRegion;
    v.x = arrive.x;
    v.y = arrive.y;
    driver.region = toRegion;
    driver.x = arrive.x;
    driver.y = arrive.y;
    const s = this.sessionFor(driver.id);
    if (s) {
      s.travelCdUntil = Date.now() + 1500; // grace so you don't bounce back
      this.sendInit(s.ws, driver); // swap their map to the new region
    }
    this.broadcastLog(
      v.kind === "boat" ? `${driver.name} sailed into ${dest.name}.`
                        : `${driver.name} drove into ${dest.name}.`,
    );
  }

  // --- Interior rooms -------------------------------------------------------
  private generateRoom(b: BuildingState): RoomDef {
    const W = Math.max(8, Math.min(16, b.w + 2));
    const H = Math.max(6, Math.min(12, b.h + 2));
    const tiles: RoomTile[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const isEdge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
        // Window every 3 tiles on side walls
        const isWindow = isEdge && !( y === 0 || y === H-1 ) && x % 3 === 1;
        // Door at bottom center
        const isDoor = y === H - 1 && x === Math.floor(W / 2);
        // Rug in the center area
        const cx = Math.floor(W / 2), cy = Math.floor(H / 2);
        const isRug = !isEdge && Math.abs(x - cx) <= 1 && Math.abs(y - cy) <= 1;
        if (isDoor) tiles.push({ kind: "door" });
        else if (isWindow) tiles.push({ kind: "window" });
        else if (isEdge) tiles.push({ kind: "wall", variant: (x + y) % 3 });
        else if (isRug) tiles.push({ kind: "rug", variant: 0 });
        else tiles.push({ kind: "floor", variant: (x * 3 + y * 7) % 4 });
      }
    }
    return {
      id: b.id,
      width: W, height: H, tiles,
      doorX: Math.floor(W / 2), doorY: H - 1,
      spawnX: Math.floor(W / 2), spawnY: H - 2,
    };
  }

  private doEnterBuilding(ws: WebSocket, playerId: string, buildingId: string) {
    const p = this.players.get(playerId);
    if (!p) return;
    const region = this.regions.get(p.region);
    if (!region) return;
    const b = region.buildings.find((bb) => bb.id === buildingId);
    if (!b) return;
    // Range check: must be within 4 tiles of the building
    const dist = Math.hypot(b.x + b.w / 2 - p.x, b.y + b.h / 2 - p.y);
    if (dist > 6) { this.tell(p, "You need to be closer to enter."); return; }
    // Lock check
    if (b.locked && b.ownerId && b.ownerId !== playerId) {
      this.tell(p, `${b.ownerName ? `${b.ownerName}'s` : "This"} property is locked.`);
      return;
    }
    let room = this.rooms.get(buildingId);
    if (!room) {
      room = this.generateRoom(b);
      this.rooms.set(buildingId, room);
      b.hasRoom = true;
    }
    this.playerInRoom.set(playerId, buildingId);
    p.inRoom = buildingId;
    this.send(ws, { t: "room", def: room, playerX: room.spawnX, playerY: room.spawnY });
  }

  private doExitBuilding(ws: WebSocket, playerId: string) {
    const p = this.players.get(playerId);
    if (!p) return;
    this.playerInRoom.delete(playerId);
    p.inRoom = null;
    this.send(ws, { t: "room-exit" });
  }

  private nearestBuilding(region: Region, x: number, y: number, range: number): BuildingState | null {
    let best: BuildingState | null = null;
    let bestD = range;
    for (const b of region.buildings) {
      const d = Math.hypot(b.x + b.w / 2 - x, b.y + b.h / 2 - y);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  private sessionFor(playerId: string): Session | undefined {
    for (const s of this.sessions.values()) if (s.playerId === playerId) return s;
    return undefined;
  }

  // Interest management: on big maps we only send the dense, frequently-changing
  // entities (resource nodes, creatures) that are near the viewer. Buildings,
  // NPCs, vehicles, plants and fires are few, so they're always sent.
  private snapshot(regionId: RegionId, viewer?: PlayerState): Snapshot {
    const now = Date.now();
    const tide = this.tideLevel(now);
    const region = this.regions.get(regionId)!;
    const R2 = VIEW_RADIUS * VIEW_RADIUS;
    const near = (x: number, y: number) =>
      !viewer || (x - viewer.x) ** 2 + (y - viewer.y) ** 2 <= R2;
    return {
      tide,
      waterline: this.currentWaterline(now),
      phase: phaseForTide(tide),
      event: this.event,
      players: [...this.players.values()].filter((p) => p.region === regionId),
      creatures: [...this.creatures.values()].filter((c) => c.region === regionId && near(c.x, c.y)),
      buildings: region.buildings,
      vehicles: [...this.vehicles.values()].filter((v) => v.region === regionId),
      resourceNodes: viewer
        ? this.nodesNear(regionId, viewer.x, viewer.y, VIEW_RADIUS)
        : [...this.resourceNodes.values()].filter((n) => n.region === regionId),
      plants: [...this.plants.values()].filter((pl) => pl.region === regionId && pl.dormantUntil === null),
      campfires: [...this.campfires.values()].filter((f) => f.region === regionId),
      furnaces:  [...this.furnaces.values()].filter((f) => f.region === regionId),
      npcs: this.npcs.filter((n) => n.region === regionId),
      lootDrops: [...this.lootDrops.values()].filter((d) => d.region === regionId && near(d.x, d.y)),
    };
  }

  // Send a one-off log line to a single player.
  private tell(p: PlayerState, msg: string) {
    const s = this.sessionFor(p.id);
    if (s) this.send(s.ws, { t: "log", msg });
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket gone */
    }
  }

  private broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.sessions.keys()) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }

  private broadcastLog(msg: string) {
    this.broadcast({ t: "log", msg });
  }

  // Send only to players currently in a given region (for localised fx).
  private broadcastToRegion(regionId: RegionId, msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const [ws, s] of this.sessions) {
      const p = this.players.get(s.playerId);
      if (!p || p.region !== regionId) continue;
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

// --- creature tuning (module-level, pure) -----------------------------------
function pickKind(
  phase: ReturnType<typeof phaseForTide>,
  event: "none" | "king" | "tsunami",
): CreatureKind | null {
  const r = Math.random();
  if (event === "tsunami") {
    return r < 0.5 ? "sixgill" : r < 0.75 ? "dogfish" : "orca";
  }
  // 30% of spawns are always land creatures (tide-independent).
  if (r < 0.30) {
    const lr = Math.random();
    if (lr < 0.30) return "deer";   // black-tailed deer — genuinely common here
    if (lr < 0.52) return "grouse";
    if (lr < 0.70) return "elk";
    if (lr < 0.84) return "wolf";
    if (lr < 0.985) return "bear";
    return "cougar"; // ~1.5% — a very rare, fleeting sighting
  }
  const w = Math.random(); // water creature pick
  // Sea otters are SUPER rare here (kelp beds, out in the ocean) — gate hard.
  if (phase === "low") {
    if (w < 0.48) return "crab";
    if (w < 0.68) return "octopus";
    if (w < 0.85) return "seal";
    if (w < 0.97) return "sealLion";
    if (w < 0.975) return "seaOtter"; // ~0.5%
    return null;
  }
  if (phase === "high") {
    if (w < 0.27) return "seal";
    if (w < 0.43) return "dogfish";
    if (w < 0.54) return "octopus";
    if (w < 0.63) return "sealLion";
    if (w < 0.70) return "sixgill";
    if (w < 0.79) return "humpback";
    if (w < 0.88) return "greywhale";
    if (w < 0.883) return "seaOtter"; // ~0.3%
    if (w < 0.905) return "orca";     // ~2% — a real event
    return null;
  }
  if (w < 0.38) return "crab";
  if (w < 0.60) return "seal";
  if (w < 0.76) return "octopus";
  if (w < 0.92) return "sealLion";
  if (w < 0.925) return "seaOtter"; // ~0.5%
  return null;
}

function pickFish(depth: number, hasLure: boolean, level: number): ItemId {
  const bonus = (hasLure ? 0.15 : 0) + (level >= 15 ? 0.10 : 0);
  const r = Math.random() + bonus * 0.5;
  if (depth >= DEPTH_OCEAN * 1.5) {
    // Abyss: tuna territory
    return r < 0.40 ? "tuna" : r < 0.72 ? "halibut" : "lingcod";
  }
  if (depth >= DEPTH_OCEAN) {
    // Open ocean: halibut, lingcod, rare tuna
    return r < 0.30 ? "halibut" : r < 0.62 ? "lingcod" : r < 0.88 ? "salmon" : "tuna";
  }
  if (depth >= DEPTH_DEEP) {
    // Deep: lingcod, salmon, halibut
    return r < 0.38 ? "lingcod" : r < 0.72 ? "salmon" : r < 0.92 ? "halibut" : "fish";
  }
  if (depth >= DEPTH_SWIM) {
    // Waist-deep: salmon, small fish
    return r < 0.52 ? "salmon" : r < 0.88 ? "fish" : "lingcod";
  }
  return "fish"; // shore — small fry
}

// Deterministic hash of an integer → float in [0, 1). Used for seeded daily
// event rolls so the same day always produces the same disaster outcome even
// across server restarts.
function seededHash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function creatureHp(kind: CreatureKind): number {
  switch (kind) {
    case "crab":      return 20;
    case "octopus":   return 45;
    case "dogfish":   return 60;
    case "sixgill":   return 110;
    case "orca":      return 200;
    case "seal":      return 50;
    case "sealLion":  return 70;
    case "seaOtter":  return 30;
    // Land prey
    case "deer":      return 40;
    case "elk":       return 80;
    case "grouse":    return 12;
    // Land predators
    case "bear":      return 150;
    case "cougar":    return 90;
    case "wolf":      return 60;
    default:          return 250; // whales
  }
}

function creatureSpeed(kind: CreatureKind): number {
  switch (kind) {
    case "crab":      return 1.6;
    case "octopus":   return 2.0;
    case "dogfish":   return 3.2;
    case "sixgill":   return 2.6;
    case "orca":      return 3.8;
    case "seal":      return 2.8;
    case "sealLion":  return 2.2;
    case "seaOtter":  return 2.0;
    // Land prey flee speed
    case "grouse":    return 5.5;
    case "deer":      return 4.8;
    case "elk":       return 4.2;
    // Land predator chase speed
    case "cougar":    return 4.5;
    case "wolf":      return 3.8;
    case "bear":      return 3.0;
    default:          return 1.0;
  }
}

function creatureDamage(kind: CreatureKind): number {
  switch (kind) {
    case "crab":     return 1.5;
    case "octopus":  return 14;
    case "dogfish":  return 20;
    case "sixgill":  return 32;
    case "orca":     return 48;
    case "bear":     return 36;
    case "cougar":   return 28;
    case "wolf":     return 18;
    default:         return 0;
  }
}

function isPrey(kind: CreatureKind): boolean {
  return kind === "deer" || kind === "elk" || kind === "grouse";
}

function isLandPredator(kind: CreatureKind): boolean {
  return kind === "bear" || kind === "cougar" || kind === "wolf";
}

function nextStage(stage: PlantStage): PlantStage {
  if (stage === "young") return "flowering";
  if (stage === "flowering") return "seeding";
  return "young"; // seeding cycles back
}

function isNeutral(kind: CreatureKind): boolean {
  return kind === "humpback" || kind === "greywhale" || kind === "orca"
      || kind === "seal" || kind === "sealLion" || kind === "seaOtter"
      || kind === "deer" || kind === "elk" || kind === "grouse";
}

function swimmer(kind: CreatureKind): boolean {
  // Land creatures and sea lions don't swim
  return kind !== "crab" && kind !== "sealLion"
      && kind !== "deer" && kind !== "elk" && kind !== "grouse"
      && kind !== "bear" && kind !== "cougar" && kind !== "wolf";
}

function sanitizeAppearance(a: Appearance | undefined): Appearance {
  const hex = (v: string | undefined, fallback: string) =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  const hairStyles = ["short", "medium", "long"] as const;
  const bodyBuilds = ["slight", "medium", "sturdy"] as const;
  const breastSizes = ["non", "modest", "expressive"] as const;
  const hipSizes = ["narrow", "medium", "wide"] as const;
  return {
    skin: hex(a?.skin, "#e0ac69"),
    hair: hex(a?.hair, "#3b2a1a"),
    shirt: hex(a?.shirt, "#2e7d32"),
    pants: a?.pants && /^#[0-9a-fA-F]{6}$/.test(a.pants) ? a.pants : undefined,
    hat: a?.hat && /^#[0-9a-fA-F]{6}$/.test(a.hat) ? a.hat : undefined,
    hairStyle: hairStyles.includes(a?.hairStyle as typeof hairStyles[number]) ? a!.hairStyle : undefined,
    bodyBuild: bodyBuilds.includes(a?.bodyBuild as typeof bodyBuilds[number]) ? a!.bodyBuild : undefined,
    breastSize: breastSizes.includes(a?.breastSize as typeof breastSizes[number]) ? a!.breastSize : undefined,
    hipSize: hipSizes.includes(a?.hipSize as typeof hipSizes[number]) ? a!.hipSize : undefined,
    worn: a?.worn && typeof a.worn === "object" ? (a.worn as WornItems) : undefined,
  };
}

// Default starter outfits per mode (keep the player's chosen skin & hair).
function combatOutfit(base: Appearance): Appearance {
  // Naked: bare chest (torso = skin tone), simple sandy shorts, no hat.
  return { skin: base.skin, hair: base.hair, shirt: base.skin, pants: "#8a6a3c", hat: undefined };
}
function researchOutfit(base: Appearance): Appearance {
  // Indiana-Jones field kit: cloth shirt + pants + tan field hat.
  return { skin: base.skin, hair: base.hair, shirt: "#cdbf9a", pants: "#b8a982", hat: "#c2a35a",
    worn: { torso: "clothShirt", legs: "clothPants", head: "fieldHat" } };
}
function professionOutfit(base: Appearance): Appearance {
  // Work clothes — shirt + sturdy pants.
  return { skin: base.skin, hair: base.hair, shirt: base.shirt, pants: "#39507a", hat: undefined,
    worn: { torso: "clothShirt", legs: "clothPants" } };
}
function defaultOutfit(mode: PlayerMode, base: Appearance): Appearance {
  return mode === "combat" ? combatOutfit(base)
       : mode === "research" ? researchOutfit(base)
       : professionOutfit(base);
}

// Which creatures are light enough to grab & throw (small mammals/birds).
const GRABBABLE_CREATURES = new Set(["grouse", "crab", "octopus", "seaOtter"]);
