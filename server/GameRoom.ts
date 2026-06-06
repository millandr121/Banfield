import {
  Appearance,
  BuildingState,
  CampfireState,
  COOK_MAP,
  CRAFT_RECIPES,
  ClientMessage,
  CraftRecipeId,
  CreatureKind,
  CreatureState,
  FOOD_VALUE,
  INVASIVE_LABEL,
  ITEM_LABEL,
  Inventory,
  InvasiveKind,
  ItemId,
  PlantStage,
  PlantState,
  PlayerState,
  RegionId,
  ResourceNode,
  ServerMessage,
  SkillName,
  Snapshot,
  Tile,
  TravelNode,
  VehicleState,
  WorldMap,
  TIDE_CYCLE_MS,
  WATERLINE_LOW,
  WATERLINE_HIGH,
  KING_TIDE_SURGE,
  TSUNAMI_SURGE,
  defaultSkills,
  skillLevel,
  submergedAt,
  phaseForTide,
} from "../shared/protocol";
import { DEFAULT_REGION, PlantDef, RegionDef, ResourceNodeDef, buildRegions } from "../shared/map";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
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
const PLAYER_MAX_HP = 100;

// Combat is stamina-gated so it rewards timing over button-mashing.
const ATTACK_RANGE = 1.5; // tiles (light swing); charged swings reach further
const ATTACK_ARC = Math.PI * 0.6; // must be roughly facing the target
const ATTACK_DAMAGE = 18; // base (light) damage; scales up with charge
const ATTACK_COOLDOWN_MS = 380; // skill: you can't just spam swings
const ATTACK_KNOCKBACK = 5; // impulse applied to a struck creature
const ATTACK_STAMINA = 18; // stamina a swing costs
const CHARGE_BONUS = 1.6; // a full charge adds this fraction to dmg/range/kb
const HIT_KNOCKBACK = 5; // impulse applied to a player who gets hit
const KB_FRICTION = 6; // how fast knockback decays per second
const MAX_STAMINA = 100;
const STAMINA_REGEN = 24; // per second
const DODGE_STAMINA = 34; // stamina a dodge costs
const DODGE_COOLDOWN_MS = 650;
const DODGE_IMPULSE = 14; // lunge speed (tiles/sec) at the start of a dodge
const DODGE_IFRAMES_MS = 360; // invulnerability window during a dodge
const REPAIR_RATE = 25; // hp per second
const CREATURE_CAP_PER_REGION = 7;
const SPAWN_INTERVAL_MS = 7000; // how often a region may gain one creature
const SINK_DEPTH = 7; // how far under the waterline counts as "deep"
const SINK_DPS = 12; // hp/sec lost while standing still in deep water

// Vehicles -------------------------------------------------------------------
const CAR_SPEED = 7.5; // tiles/sec on a road
const CAR_OFFROAD_SPEED = 3.0; // sluggish on grass/sand
const BOAT_SPEED = 5.5; // tiles/sec on water
const VEHICLE_BOARD_RANGE = 1.6; // how close you must be to board
const VEHICLE_MAX_HP = 200;
const TIDE_SWEEP = 1.4; // how fast a driverless boat/car drifts when afloat
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
const ORE_RESPAWN_MS = 8 * 60 * 1000; // 8 minutes
const BERRY_RESPAWN_MS = 2 * 60 * 1000; // 2 minutes — berries come back fast
const MINING_LEVEL_REQ_IRON = 5; // need Mining 5 to extract iron
const COOK_RANGE = 2.0; // tiles from a campfire to cook
const CAMPFIRE_BURN_MS = 4 * 60 * 1000; // a campfire lasts 4 minutes

// Hunger ---------------------------------------------------------------------
const MAX_HUNGER = 100;
const HUNGER_DECAY = 100 / (9 * 60); // empties in ~9 min of normal play
const HUNGER_WORK_EXTRA = 0.5; // extra drain/sec while actively moving
const STARVE_DPS = 2.5; // hp/sec lost at 0 hunger

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
const DEATH_XP_LOSS = 0.25; // fraction of raw XP lost on death

// Fishing --------------------------------------------------------------------
const FISHING_TIME_MS = 5000; // base wait time; reduced by fishing level
const FISHING_ROD_REQUIRED = true;

// Loot table -----------------------------------------------------------------
// Crabs give crab meat; fish-eaters give raw fish; everything gives scrap.
function rollLoot(kind: CreatureKind): Array<{ item: ItemId; qty: number }> {
  const drops: Array<{ item: ItemId; qty: number }> = [];
  const r = Math.random;
  switch (kind) {
    case "crab":
      if (r() < 0.85) drops.push({ item: "crabmeat", qty: 1 });
      if (r() < 0.4) drops.push({ item: "scrap", qty: 1 });
      break;
    case "octopus":
      if (r() < 0.6) drops.push({ item: "fish", qty: 1 });
      if (r() < 0.5) drops.push({ item: "scrap", qty: 1 });
      break;
    case "dogfish":
      if (r() < 0.9) drops.push({ item: "fish", qty: 2 });
      if (r() < 0.7) drops.push({ item: "scrap", qty: 1 });
      break;
    case "sixgill":
      drops.push({ item: "fish", qty: 2 });
      if (r() < 1.0) drops.push({ item: "scrap", qty: 2 });
      break;
    case "orca":
      drops.push({ item: "fish", qty: 3 });
      drops.push({ item: "scrap", qty: 2 + Math.floor(r() * 2) });
      break;
    default: // neutrals (humpback, greywhale) — not killable but here for completeness
      break;
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
  private plants = new Map<string, PlantState>();
  private campfires = new Map<string, CampfireState>();
  // playerId → timestamp when they cast their line (null = not fishing)
  private fishingStates = new Map<string, number>();
  // Transient knockback impulses by entity id (players + creatures).
  private kb = new Map<string, { x: number; y: number }>();

  private startedAt = Date.now();
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private nextSpawn = 0;
  private idCounter = 0;

  private event: "none" | "king" | "tsunami" = "none";
  private eventUntil = 0;
  private nextEventCheck = Date.now() + 60_000;

  constructor(_state: DurableObjectState, _env: Env) {
    const now = Date.now();
    for (const def of buildRegions()) {
      this.regions.set(def.id, this.toRegion(def));
      for (const v of def.vehicles) {
        this.vehicles.set(v.id, {
          id: v.id, kind: v.kind, region: def.id,
          x: v.x + 0.5, y: v.y + 0.5, dir: 0,
          hp: VEHICLE_MAX_HP, maxHp: VEHICLE_MAX_HP,
          driverId: null, lastDriven: now,
        });
      }
      for (const n of def.resourceNodes) {
        this.resourceNodes.set(n.id, this.mkNode(n, def.id));
      }
      for (const pl of def.plants) {
        this.plants.set(pl.id, this.mkPlant(pl, def.id, now));
      }
    }
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
    this.sessions.set(ws, { ws, playerId, dx: 0, dy: 0, lastAttack: 0, lastDodge: 0, lastHarvest: 0, iframeUntil: 0 });
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
      this.players.delete(s.playerId);
      this.kb.delete(s.playerId);
      this.fishingStates.delete(s.playerId);
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
        const region = this.regions.get(DEFAULT_REGION)!;
        const spawn = this.landSpawn(region, region.spawn.x, region.spawn.y);
        const player: PlayerState = {
          id: s.playerId,
          name: (msg.name || "Settler").slice(0, 16),
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
          inventory: {},
          team: null,
          appearance: sanitizeAppearance(msg.appearance),
          swimming: false,
          dodging: false,
          fishing: false,
          vehicleId: null,
          dead: false,
        };
        this.players.set(s.playerId, player);
        this.sendInit(ws, player);
        this.broadcastLog(`${player.name} washed ashore in ${region.name}.`);
        break;
      }
      case "input": {
        const len = Math.hypot(msg.dx, msg.dy);
        s.dx = len > 1 ? msg.dx / len : msg.dx;
        s.dy = len > 1 ? msg.dy / len : msg.dy;
        const p = this.players.get(s.playerId);
        if (p && (msg.dx !== 0 || msg.dy !== 0)) {
          p.dir = Math.atan2(msg.dy, msg.dx);
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
        this.doEat(s.playerId);
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
      case "travel":
        this.doTravel(ws, s.playerId);
        break;
    }
  }

  private sendInit(ws: WebSocket, player: PlayerState) {
    const region = this.regions.get(player.region)!;
    this.send(ws, {
      t: "init",
      id: player.id,
      region: {
        id: region.id,
        name: region.name,
        map: region.map,
        travelNodes: region.travelNodes,
      },
      snapshot: this.snapshot(region.id),
    });
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
    this.updateResourceRespawn(now);
    this.updateVehicleRust(dt, waterline, now);
    this.updateFishing(now);
    this.updateHunger(dt);
    this.updatePlants(now);
    this.updateCampfires(now);
    this.maybeSpawn(now, waterline);

    // Each player only sees their own region; cache one snapshot per region.
    const cache = new Map<RegionId, Snapshot>();
    for (const s of this.sessions.values()) {
      const p = this.players.get(s.playerId);
      if (!p) continue;
      let snap = cache.get(p.region);
      if (!snap) {
        snap = this.snapshot(p.region);
        cache.set(p.region, snap);
      }
      this.send(s.ws, { t: "snapshot", snapshot: snap });
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
        this.event === "tsunami" ? "The tsunami recedes." : "The king tide eases.",
      );
      this.event = "none";
    }
    if (now > this.nextEventCheck) {
      this.nextEventCheck = now + 60_000;
      if (this.tideLevel(now) > 0.6) {
        const roll = Math.random();
        if (roll < 0.04) {
          this.event = "tsunami";
          this.eventUntil = now + 20_000;
          this.broadcastLog("TSUNAMI INCOMING — get to high ground!");
        } else if (roll < 0.2) {
          this.event = "king";
          this.eventUntil = now + 40_000;
          this.broadcastLog("A king tide is rolling in.");
        }
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

      // Stamina trickles back when you're not spending it.
      p.stamina = Math.min(p.maxStamina, p.stamina + STAMINA_REGEN * dt);
      p.dodging = now < s.iframeUntil;

      // While driving, the vehicle carries you — moveVehicles set our position.
      if (p.vehicleId) {
        p.swimming = false;
        continue;
      }

      // You can now swim, but the water is slower than dry land.
      p.swimming = this.depthAt(region.map, p.x, p.y, waterline) > 0;
      if (p.swimming && (s.dx !== 0 || s.dy !== 0)) {
        this.giveXP(p, "swimming", XP_SWIM_PER_SEC * dt);
      }
      const swimBonus = 1 + skillLevel(p.skills.swimming) * 0.003;
      const speed = p.swimming ? SWIM_SPEED * swimBonus : PLAYER_SPEED;
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

      // Tides: caught in DEEP water and standing still -> you sink. Keep moving
      // (toward land) to stay afloat.
      const depth = this.depthAt(region.map, p.x, p.y, waterline);
      const movingInput = s.dx !== 0 || s.dy !== 0;
      if (depth > SINK_DEPTH && !movingInput && !moved) {
        p.hp -= SINK_DPS * dt;
        if (p.hp <= 0 && !p.dead) this.killPlayer(p);
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
          const onRoad = this.tileAt(region.map, v.x, v.y) === Tile.Road;
          const skillBonus =
            v.kind === "car"
              ? 1 + skillLevel(driver.skills.driving) * 0.003
              : 1 + skillLevel(driver.skills.boating) * 0.002;
          const base =
            v.kind === "car"
              ? (onRoad ? CAR_SPEED : CAR_OFFROAD_SPEED) * skillBonus
              : BOAT_SPEED * skillBonus;
          activeSpeed = base;
          const nx = v.x + s.dx * base * dt;
          const ny = v.y + s.dy * base * dt;
          if (this.vehicleCanGo(v, region.map, nx, v.y, waterline)) { v.x = nx; movedThisTick = true; }
          if (this.vehicleCanGo(v, region.map, v.x, ny, waterline)) { v.y = ny; movedThisTick = true; }
          v.dir = Math.atan2(s.dy, s.dx);
          v.lastDriven = now;
          // Skill XP for the driver.
          if (v.kind === "car") this.giveXP(driver, "driving", XP_DRIVE_PER_SEC * dt);
          else this.giveXP(driver, "boating", XP_BOAT_PER_SEC * dt);
        }
        // The driver rides along.
        driver.x = v.x;
        driver.y = v.y;
        driver.dir = v.dir;
      } else {
        // Driverless: a boat (or a car the tide has reached) drifts on the swell.
        if (this.depthAt(region.map, v.x, v.y, waterline) > 1) {
          const nx = v.x + Math.sin(now / 1700 + v.y) * TIDE_SWEEP * dt;
          const ny = v.y + TIDE_SWEEP * 0.5 * dt;
          if (this.vehicleCanGo(v, region.map, nx, v.y, waterline)) v.x = nx;
          if (this.vehicleCanGo(v, region.map, v.x, ny, waterline)) v.y = ny;
        }
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
      if (v.driverId) continue; // driven vehicles don't rust
      if (now - v.lastDriven < RUST_START_MS) continue;
      // Vehicles in deep water rust faster (salt damage + submersion).
      const depth = this.depthAt(this.regions.get(v.region)?.map ?? { width: 0, height: 0, tiles: [], elevation: [] } as WorldMap, v.x, v.y, waterline);
      const rate = RUST_DPS * (depth > 2 ? 3 : 1);
      v.hp -= rate * dt;
      if (v.hp <= 0) {
        // Gone for good — log once then delete.
        this.broadcastLog(`A ${v.kind} has rusted away.`);
        this.vehicles.delete(id);
      }
    }
  }

  // Cars ride land (and roads); boats ride water. Neither leaves the map.
  private vehicleCanGo(v: VehicleState, map: WorldMap, x: number, y: number, waterline: number): boolean {
    if (!this.inBounds(map, x, y)) return false;
    const submerged = this.depthAt(map, x, y, waterline) > 0;
    return v.kind === "boat" ? submerged : !submerged;
  }

  // --- resources & crafting -------------------------------------------------
  private doHarvest(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return;
    const s = this.sessionFor(p.id);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastHarvest < HARVEST_COOLDOWN_MS) return;

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
      this.addItem(p.inventory, "wood", 1);
      this.giveXP(p, "woodcutting", XP_CHOP);
      respawnMs = TREE_RESPAWN_MS;
    } else if (bestNode.kind === "berryBush") {
      this.addItem(p.inventory, "berry", 1);
      this.giveXP(p, "gardening", XP_FORAGE);
      respawnMs = BERRY_RESPAWN_MS;
    } else if (bestNode.kind === "ironOre") {
      this.addItem(p.inventory, "iron", 1);
      this.giveXP(p, "mining", XP_MINE);
    } else {
      this.addItem(p.inventory, "stone", 1);
      this.giveXP(p, "mining", XP_MINE);
    }

    if (bestNode.hp <= 0) {
      bestNode.depleted = true;
      bestNode.hp = 0;
      bestNode.respawnAt = now + respawnMs;
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
    // Don't sprout in the sea.
    if (this.tileAt(region.map, ox + 0.5, oy + 0.5) === Tile.Water) return;
    const kinds: InvasiveKind[] = ["scotchBroom", "himalayanBlackberry", "foxglove"];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const id = `inv${this.idCounter++}`;
    this.plants.set(id, {
      id, kind, region: regionId, x: ox, y: oy,
      stage: "young", stageUntil: now + PLANT_YOUNG_MS, dormantUntil: null,
    });
  }

  private updatePlants(now: number) {
    for (const pl of this.plants.values()) {
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
      const s = this.sessionFor(p.id);
      const working = s ? s.dx !== 0 || s.dy !== 0 : false;
      const decay = HUNGER_DECAY + (working ? HUNGER_WORK_EXTRA : 0);
      p.hunger = Math.max(0, p.hunger - decay * dt);
      if (p.hunger <= 0) {
        p.hp -= STARVE_DPS * dt;
        if (p.hp <= 0 && !p.dead) this.killPlayer(p);
      }
    }
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
  private doEat(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    // Pick the food item that restores the most hunger and that we actually have.
    let chosen: ItemId | null = null;
    let bestHunger = -1;
    for (const [item, val] of Object.entries(FOOD_VALUE) as [ItemId, { hunger: number; hp: number }][]) {
      if ((p.inventory[item] ?? 0) > 0 && val.hunger > bestHunger) {
        bestHunger = val.hunger;
        chosen = item;
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
    // Must be near water (swimming or adjacent to a water tile).
    const region = this.regions.get(p.region);
    if (!region) return;
    const waterline = this.currentWaterline(Date.now());
    const nearWater = this.depthAt(region.map, p.x, p.y, waterline) > -1;
    if (!nearWater) {
      const s = this.sessionFor(p.id);
      if (s) this.send(s.ws, { t: "log", msg: "Need to be near the water to fish." });
      return;
    }
    const fishingLevel = skillLevel(p.skills.fishing);
    const waitMs = Math.max(2000, FISHING_TIME_MS - fishingLevel * 50); // faster at higher level
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
      const catchChance = 0.55 + fishingLevel * 0.01; // 55% + 1% per level
      if (Math.random() < catchChance) {
        this.addItem(p.inventory, "fish", 1 + (fishingLevel >= 20 ? 1 : 0));
        this.giveXP(p, "fishing", XP_FISH);
        this.tell(p, "You caught a fish! (cook it on a fire to eat well)");
      } else {
        this.tell(p, "The fish got away…");
      }
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

  private updateResourceRespawn(now: number) {
    for (const n of this.resourceNodes.values()) {
      if (!n.depleted) continue;
      if (n.respawnAt !== null && now >= n.respawnAt) {
        n.depleted = false;
        n.hp = n.maxHp;
        n.respawnAt = null;
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
    const s = this.sessionFor(p.id);
    if (!s) return;
    const now = Date.now();
    if (now - s.lastAttack < ATTACK_COOLDOWN_MS) return; // skill: respect cooldown
    if (p.stamina < ATTACK_STAMINA) return; // too winded to swing
    s.lastAttack = now;
    p.stamina -= ATTACK_STAMINA;

    // A held (charged) swing hits harder, reaches further, and knocks back more.
    // Combat skill adds a passive bonus on top.
    const ch = Math.max(0, Math.min(1, charge));
    const combatBonus = 1 + skillLevel(p.skills.combat) * 0.005;
    const scale = (1 + CHARGE_BONUS * ch) * combatBonus;
    const range = ATTACK_RANGE * (1 + 0.4 * ch);
    const damage = ATTACK_DAMAGE * scale;
    const knockback = ATTACK_KNOCKBACK * scale;

    // Hit the nearest creature that's in range AND roughly in front of you.
    let best: CreatureState | null = null;
    let bestD = range;
    for (const c of this.creatures.values()) {
      if (c.region !== p.region) continue;
      const dx = c.x - p.x;
      const dy = c.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > bestD) continue;
      let diff = Math.abs(Math.atan2(dy, dx) - p.dir);
      if (diff > Math.PI) diff = Math.PI * 2 - diff;
      if (diff > ATTACK_ARC) continue;
      bestD = d;
      best = c;
    }
    if (best) {
      best.hp -= damage;
      this.applyKnockback(best.id, best.x - p.x, best.y - p.y, knockback);
      if (best.hp <= 0) {
        // Combat XP proportional to the creature's max HP (harder kills = more XP).
        this.giveXP(p, "combat", creatureHp(best.kind) * XP_KILL_PER_HP);
        // Loot drops go straight into inventory.
        for (const drop of rollLoot(best.kind)) {
          this.addItem(p.inventory, drop.item, drop.qty);
        }
        this.creatures.delete(best.id);
        this.kb.delete(best.id);
      }
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
    if (!b) return;
    b.hp = Math.min(b.maxHp, b.hp + REPAIR_RATE * (TICK_MS / 1000) * 4);
    if (b.kind === "rubble" && b.hp > b.maxHp * 0.5) {
      b.kind = (b as any).originalKind ?? "house";
    }
  }

  private doTravel(ws: WebSocket, playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead || p.vehicleId) return; // vehicles stay behind — travel on foot
    const region = this.regions.get(p.region);
    if (!region) return;
    const node = region.travelNodes.find(
      (n) => p.x >= n.x - 0.6 && p.x <= n.x + n.w + 0.6 && p.y >= n.y - 0.6 && p.y <= n.y + n.h + 0.6,
    );
    if (!node) return;
    const dest = this.regions.get(node.toRegion);
    if (!dest) return;
    const arrive = this.landSpawn(dest, node.toSpawn.x, node.toSpawn.y);
    p.region = dest.id;
    p.x = arrive.x;
    p.y = arrive.y;
    this.sendInit(ws, p);
    this.broadcastLog(`${p.name} arrived in ${dest.name}.`);
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
      const count = [...this.creatures.values()].filter((c) => c.region === regionId).length;
      if (count >= CREATURE_CAP_PER_REGION) continue;
      const kind = pickKind(phase, this.event);
      if (!kind) continue;
      const spot = this.findSpawnTile(region, kind, waterline);
      if (!spot) continue;
      const id = `c${this.idCounter++}`;
      this.creatures.set(id, { id, kind, region: regionId, x: spot.x, y: spot.y, hp: creatureHp(kind) });
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
      if (isNeutral(c.kind)) {
        c.x += Math.sin(c.y + c.x) * 0.2 * dt;
        c.y += 0.4 * dt;
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
    let best: { x: number; y: number; player?: PlayerState } | null = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead || p.region !== region.id) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < 6 && d < bestD) {
        bestD = d;
        best = { x: p.x, y: p.y, player: p };
      }
    }
    if (best) return best;
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
    if (p.vehicleId) {
      const v = this.vehicles.get(p.vehicleId);
      if (v) v.driverId = null;
      p.vehicleId = null;
    }
    p.fishing = false;
    this.fishingStates.delete(p.id);
    // Death penalty: lose 25% of raw XP in every skill. You can slide back
    // but never to zero — keeps the stakes real without being punishing.
    for (const sk of Object.keys(p.skills) as SkillName[]) {
      p.skills[sk] = Math.max(0, p.skills[sk] * (1 - DEATH_XP_LOSS));
    }
    // Drop half your inventory on death (items just vanish for now — future: loot crate).
    for (const item of Object.keys(p.inventory) as ItemId[]) {
      p.inventory[item] = Math.floor((p.inventory[item] ?? 0) / 2);
    }
    this.broadcastLog(`${p.name} was dragged under. Skills took a hit.`);
    setTimeout(() => {
      const region = this.regions.get(p.region);
      p.dead = false;
      p.hp = p.maxHp;
      p.stamina = p.maxStamina;
      p.hunger = p.maxHunger;
      if (region) {
        const sp = this.landSpawn(region, region.spawn.x, region.spawn.y);
        p.x = sp.x;
        p.y = sp.y;
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
    const submerged = submergedAt(map.elevation[ty * map.width + tx], waterline) || tile === Tile.Water;
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
    for (let i = 0; i < 30; i++) {
      const x = Math.floor(Math.random() * region.map.width);
      const y = Math.floor(Math.random() * region.map.height);
      if (this.walkable(region.map, x + 0.5, y + 0.5, waterline, swims)) {
        return { x: x + 0.5, y: y + 0.5 };
      }
    }
    return null;
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

  private snapshot(regionId: RegionId): Snapshot {
    const now = Date.now();
    const tide = this.tideLevel(now);
    const region = this.regions.get(regionId)!;
    return {
      tide,
      waterline: this.currentWaterline(now),
      phase: phaseForTide(tide),
      event: this.event,
      players: [...this.players.values()].filter((p) => p.region === regionId),
      creatures: [...this.creatures.values()].filter((c) => c.region === regionId),
      buildings: region.buildings,
      vehicles: [...this.vehicles.values()].filter((v) => v.region === regionId),
      resourceNodes: [...this.resourceNodes.values()].filter((n) => n.region === regionId),
      plants: [...this.plants.values()].filter((pl) => pl.region === regionId && pl.dormantUntil === null),
      campfires: [...this.campfires.values()].filter((f) => f.region === regionId),
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
}

// --- creature tuning (module-level, pure) -----------------------------------
function pickKind(
  phase: ReturnType<typeof phaseForTide>,
  event: "none" | "king" | "tsunami",
): CreatureKind | null {
  if (event === "tsunami") return Math.random() < 0.5 ? "orca" : "sixgill";
  if (phase === "low") return Math.random() < 0.8 ? "crab" : "octopus";
  if (phase === "high") {
    const r = Math.random();
    if (r < 0.4) return "dogfish";
    if (r < 0.6) return "sixgill";
    if (r < 0.72) return "orca";
    if (r < 0.85) return "octopus";
    return Math.random() < 0.5 ? "humpback" : "greywhale";
  }
  return Math.random() < 0.5 ? "crab" : "octopus";
}

function creatureHp(kind: CreatureKind): number {
  switch (kind) {
    case "crab":
      return 20;
    case "octopus":
      return 45;
    case "dogfish":
      return 60;
    case "sixgill":
      return 110;
    case "orca":
      return 160;
    default:
      return 200;
  }
}

function creatureSpeed(kind: CreatureKind): number {
  switch (kind) {
    case "crab":
      return 1.6;
    case "octopus":
      return 2.0;
    case "dogfish":
      return 3.2;
    case "sixgill":
      return 2.6;
    case "orca":
      return 3.6;
    default:
      return 1.0;
  }
}

function creatureDamage(kind: CreatureKind): number {
  switch (kind) {
    case "crab":
      return 6;
    case "octopus":
      return 14;
    case "dogfish":
      return 20;
    case "sixgill":
      return 30;
    case "orca":
      return 45;
    default:
      return 0;
  }
}

function nextStage(stage: PlantStage): PlantStage {
  if (stage === "young") return "flowering";
  if (stage === "flowering") return "seeding";
  return "young"; // seeding cycles back
}

function isNeutral(kind: CreatureKind): boolean {
  return kind === "humpback" || kind === "greywhale";
}

function swimmer(kind: CreatureKind): boolean {
  return kind !== "crab";
}

function sanitizeAppearance(a: Appearance | undefined): Appearance {
  const hex = (v: string | undefined, fallback: string) =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  return {
    skin: hex(a?.skin, "#e0ac69"),
    hair: hex(a?.hair, "#3b2a1a"),
    shirt: hex(a?.shirt, "#2e7d32"),
  };
}
