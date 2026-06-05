import {
  Appearance,
  BuildingState,
  ClientMessage,
  CreatureKind,
  CreatureState,
  PlayerState,
  ServerMessage,
  Snapshot,
  Tile,
  WorldMap,
  TIDE_CYCLE_MS,
  WATERLINE_LOW,
  WATERLINE_HIGH,
  KING_TIDE_SURGE,
  TSUNAMI_SURGE,
  isSubmerged,
  phaseForTide,
} from "../shared/protocol";
import {
  MAP_HEIGHT,
  SPAWN,
  generateBamfieldMap,
  initialBuildings,
} from "../shared/map";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface Session {
  ws: WebSocket;
  playerId: string;
  // last input direction, normalized to length <= 1
  dx: number;
  dy: number;
}

const TICK_MS = 100; // server simulation step (10 Hz)
const PLAYER_SPEED = 4.0; // tiles per second
const PLAYER_MAX_HP = 100;
const ATTACK_RANGE = 1.4; // tiles
const ATTACK_DAMAGE = 18;
const REPAIR_RATE = 25; // hp per second
const CREATURE_CAP = 18;

export class GameRoom {
  private sessions = new Map<WebSocket, Session>();

  private map: WorldMap;
  private players = new Map<string, PlayerState>();
  private creatures = new Map<string, CreatureState>();
  private buildings: BuildingState[];

  private startedAt = Date.now();
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private nextSpawn = 0;
  private idCounter = 0;

  // Active special event window.
  private event: "none" | "king" | "tsunami" = "none";
  private eventUntil = 0;
  private nextEventCheck = Date.now() + 60_000;

  constructor(_state: DurableObjectState, _env: Env) {
    this.map = generateBamfieldMap();
    this.buildings = initialBuildings();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/ws") return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.onConnect(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // --- connection lifecycle -------------------------------------------------
  private onConnect(ws: WebSocket) {
    const playerId = `p${this.idCounter++}`;
    this.sessions.set(ws, { ws, playerId, dx: 0, dy: 0 });

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
    if (s) this.players.delete(s.playerId);
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
        const player: PlayerState = {
          id: s.playerId,
          name: (msg.name || "Settler").slice(0, 16),
          x: SPAWN.x,
          y: SPAWN.y,
          hp: PLAYER_MAX_HP,
          maxHp: PLAYER_MAX_HP,
          appearance: sanitizeAppearance(msg.appearance),
          dead: false,
        };
        this.players.set(s.playerId, player);
        this.send(ws, {
          t: "init",
          id: s.playerId,
          map: this.map,
          snapshot: this.snapshot(),
        });
        this.broadcastLog(`${player.name} washed ashore.`);
        break;
      }
      case "input": {
        const len = Math.hypot(msg.dx, msg.dy) || 1;
        s.dx = msg.dx / Math.max(1, len);
        s.dy = msg.dy / Math.max(1, len);
        break;
      }
      case "attack":
        this.doAttack(s.playerId);
        break;
      case "repair":
        this.doRepair(s.playerId);
        break;
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
    this.movePlayers(dt, waterline);
    this.updateCreatures(dt, now, waterline);
    this.maybeSpawn(now, waterline);

    this.broadcast({ t: "snapshot", snapshot: this.snapshot() });
  }

  // --- tide -----------------------------------------------------------------
  private tideLevel(now: number): number {
    // Smooth 0..1 cosine wave: 0 = low water, 1 = high water.
    const phase = ((now - this.startedAt) % TIDE_CYCLE_MS) / TIDE_CYCLE_MS;
    return 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  }

  private currentWaterline(now: number): number {
    const tide = this.tideLevel(now);
    let wl = WATERLINE_LOW + (WATERLINE_HIGH - WATERLINE_LOW) * tide;
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
      // Only surge near high tide, and rarely.
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
  private movePlayers(dt: number, waterline: number) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const s = this.sessionFor(p.id);
      if (!s) continue;
      const nx = p.x + s.dx * PLAYER_SPEED * dt;
      const ny = p.y + s.dy * PLAYER_SPEED * dt;
      // Players can't walk into submerged tiles (no boats yet).
      if (this.walkable(nx, p.y, waterline, false)) p.x = nx;
      if (this.walkable(p.x, ny, waterline, false)) p.y = ny;
    }
  }

  private doAttack(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    let best: CreatureState | null = null;
    let bestD = ATTACK_RANGE;
    for (const c of this.creatures.values()) {
      const d = Math.hypot(c.x - p.x, c.y - p.y);
      if (d <= bestD) {
        bestD = d;
        best = c;
      }
    }
    if (best) {
      best.hp -= ATTACK_DAMAGE;
      if (best.hp <= 0) this.creatures.delete(best.id);
    }
  }

  private doRepair(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    const b = this.nearestBuilding(p.x, p.y, 1.6);
    if (!b) return;
    b.hp = Math.min(b.maxHp, b.hp + REPAIR_RATE * (TICK_MS / 1000) * 4);
    if (b.kind === "rubble" && b.hp > b.maxHp * 0.5) {
      b.kind = (b as any).originalKind ?? "house";
    }
  }

  // --- creatures ------------------------------------------------------------
  private maybeSpawn(now: number, waterline: number) {
    if (now < this.nextSpawn) return;
    this.nextSpawn = now + 2500;
    if (this.creatures.size >= CREATURE_CAP) return;

    const phase = phaseForTide(this.tideLevel(now));
    const kind = pickKind(phase, this.event);
    if (!kind) return;

    const spot = this.findSpawnTile(kind, waterline);
    if (!spot) return;

    this.creatures.set(`c${this.idCounter++}`, {
      id: `c${this.idCounter}`,
      kind,
      x: spot.x,
      y: spot.y,
      hp: creatureHp(kind),
    });
  }

  private updateCreatures(dt: number, _now: number, waterline: number) {
    for (const c of this.creatures.values()) {
      if (isNeutral(c.kind)) {
        // Whales drift slowly through deep water, harmless.
        c.x += Math.sin(c.y + c.x) * 0.2 * dt;
        c.y += 0.4 * dt;
        if (c.y > MAP_HEIGHT) this.creatures.delete(c.id);
        continue;
      }

      const target = this.creatureTarget(c);
      if (!target) continue;
      const dirx = target.x - c.x;
      const diry = target.y - c.y;
      const dist = Math.hypot(dirx, diry) || 1;
      const spd = creatureSpeed(c.kind);
      const nx = c.x + (dirx / dist) * spd * dt;
      const ny = c.y + (diry / dist) * spd * dt;
      const swims = swimmer(c.kind);
      if (this.walkable(nx, c.y, waterline, swims)) c.x = nx;
      if (this.walkable(c.x, ny, waterline, swims)) c.y = ny;

      // Attack whatever we're touching.
      if (dist < 1.2) this.creatureAttack(c, target);
    }
  }

  private creatureTarget(
    c: CreatureState,
  ): { x: number; y: number; building?: BuildingState; player?: PlayerState } | null {
    // Prefer a nearby player, otherwise the nearest standing building.
    let best: { x: number; y: number; player?: PlayerState; building?: BuildingState } | null =
      null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < 6 && d < bestD) {
        bestD = d;
        best = { x: p.x, y: p.y, player: p };
      }
    }
    if (best) return best;
    const b = this.buildings
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
      target.player.hp -= dmg;
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
    this.broadcastLog(`${p.name} was dragged under.`);
    setTimeout(() => {
      p.dead = false;
      p.hp = p.maxHp;
      p.x = SPAWN.x;
      p.y = SPAWN.y;
    }, 4000);
  }

  // --- helpers --------------------------------------------------------------
  private walkable(x: number, y: number, waterline: number, swimmer: boolean): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return false;
    const tile = this.map.tiles[ty * this.map.width + tx] as Tile;
    const submerged = isSubmerged(tile, waterline) || tile === Tile.Water;
    return swimmer ? submerged : !submerged;
  }

  private findSpawnTile(kind: CreatureKind, waterline: number): { x: number; y: number } | null {
    const swims = swimmer(kind);
    for (let i = 0; i < 30; i++) {
      const x = Math.floor(Math.random() * this.map.width);
      const y = Math.floor(Math.random() * this.map.height);
      if (this.walkable(x + 0.5, y + 0.5, waterline, swims)) return { x: x + 0.5, y: y + 0.5 };
    }
    return null;
  }

  private nearestBuilding(x: number, y: number, range: number): BuildingState | null {
    let best: BuildingState | null = null;
    let bestD = range;
    for (const b of this.buildings) {
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

  private snapshot(): Snapshot {
    const now = Date.now();
    const tide = this.tideLevel(now);
    return {
      tide,
      waterline: this.currentWaterline(now),
      phase: phaseForTide(tide),
      event: this.event,
      players: [...this.players.values()],
      creatures: [...this.creatures.values()],
      buildings: this.buildings,
    };
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
  if (event === "tsunami") {
    return Math.random() < 0.5 ? "orca" : "sixgill";
  }
  if (phase === "low") {
    const r = Math.random();
    if (r < 0.8) return "crab";
    return "octopus";
  }
  if (phase === "high") {
    const r = Math.random();
    if (r < 0.4) return "dogfish";
    if (r < 0.6) return "sixgill";
    if (r < 0.72) return "orca";
    if (r < 0.85) return "octopus";
    return Math.random() < 0.5 ? "humpback" : "greywhale"; // neutral
  }
  // mid tide: a light mix
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
      return 200; // whales, but they're neutral so it rarely matters
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

function isNeutral(kind: CreatureKind): boolean {
  return kind === "humpback" || kind === "greywhale";
}

function swimmer(kind: CreatureKind): boolean {
  // Crabs scuttle on exposed land/sand; everything else here is aquatic.
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
