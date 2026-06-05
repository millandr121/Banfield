import {
  Appearance,
  BuildingState,
  ClientMessage,
  CreatureKind,
  CreatureState,
  PlayerState,
  RegionId,
  ServerMessage,
  Snapshot,
  Tile,
  TravelNode,
  WorldMap,
  TILE_ELEVATION,
  TIDE_CYCLE_MS,
  WATERLINE_LOW,
  WATERLINE_HIGH,
  KING_TIDE_SURGE,
  TSUNAMI_SURGE,
  isSubmerged,
  phaseForTide,
} from "../shared/protocol";
import { DEFAULT_REGION, RegionDef, buildRegions } from "../shared/map";

interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

interface Session {
  ws: WebSocket;
  playerId: string;
  dx: number; // last input direction, normalized to length <= 1
  dy: number;
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
const PLAYER_SPEED = 4.0; // tiles per second
const PLAYER_MAX_HP = 100;
const ATTACK_RANGE = 1.4; // tiles
const ATTACK_DAMAGE = 18;
const REPAIR_RATE = 25; // hp per second
const CREATURE_CAP_PER_REGION = 7;
const SPAWN_INTERVAL_MS = 7000; // how often a region may gain one creature
const SINK_DEPTH = 8; // how far under the waterline counts as "deep"
const SINK_DPS = 14; // hp/sec lost while standing still in deep water

export class GameRoom {
  private sessions = new Map<WebSocket, Session>();

  private regions = new Map<RegionId, Region>();
  private players = new Map<string, PlayerState>();
  private creatures = new Map<string, CreatureState>();

  private startedAt = Date.now();
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private nextSpawn = 0;
  private idCounter = 0;

  private event: "none" | "king" | "tsunami" = "none";
  private eventUntil = 0;
  private nextEventCheck = Date.now() + 60_000;

  constructor(_state: DurableObjectState, _env: Env) {
    for (const def of buildRegions()) this.regions.set(def.id, this.toRegion(def));
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
        const region = this.regions.get(DEFAULT_REGION)!;
        const spawn = this.landSpawn(region, region.spawn.x, region.spawn.y);
        const player: PlayerState = {
          id: s.playerId,
          name: (msg.name || "Settler").slice(0, 16),
          region: region.id,
          x: spawn.x,
          y: spawn.y,
          hp: PLAYER_MAX_HP,
          maxHp: PLAYER_MAX_HP,
          appearance: sanitizeAppearance(msg.appearance),
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
        break;
      }
      case "attack":
        this.doAttack(s.playerId);
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
    this.movePlayers(dt, waterline);
    this.updateCreatures(dt, waterline);
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
  private movePlayers(dt: number, waterline: number) {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const s = this.sessionFor(p.id);
      const region = this.regions.get(p.region);
      if (!s || !region) continue;
      const nx = p.x + s.dx * PLAYER_SPEED * dt;
      const ny = p.y + s.dy * PLAYER_SPEED * dt;
      let moved = false;
      if (this.walkable(region.map, nx, p.y, waterline, false)) {
        if (nx !== p.x) moved = true;
        p.x = nx;
      }
      if (this.walkable(region.map, p.x, ny, waterline, false)) {
        if (ny !== p.y) moved = true;
        p.y = ny;
      }

      // Tides: if the rising water has caught you in DEEP water and you stand
      // still, you start to sink. Keep moving (toward land) to stay afloat.
      const tx = Math.floor(p.x);
      const ty = Math.floor(p.y);
      if (tx >= 0 && ty >= 0 && tx < region.map.width && ty < region.map.height) {
        const tile = region.map.tiles[ty * region.map.width + tx] as Tile;
        const depth = waterline - TILE_ELEVATION[tile];
        const submerged = tile === Tile.Water || depth > 0;
        if (submerged && depth > SINK_DEPTH && !moved) {
          p.hp -= SINK_DPS * dt;
          if (p.hp <= 0 && !p.dead) this.killPlayer(p);
        }
      }
    }
  }

  private doAttack(playerId: string) {
    const p = this.players.get(playerId);
    if (!p || p.dead) return;
    let best: CreatureState | null = null;
    let bestD = ATTACK_RANGE;
    for (const c of this.creatures.values()) {
      if (c.region !== p.region) continue;
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
    if (!p || p.dead) return;
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

  private updateCreatures(dt: number, waterline: number) {
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

      const target = this.creatureTarget(region, c);
      if (!target) continue;
      const dirx = target.x - c.x;
      const diry = target.y - c.y;
      const dist = Math.hypot(dirx, diry) || 1;
      const spd = creatureSpeed(c.kind);
      const swims = swimmer(c.kind);
      const nx = c.x + (dirx / dist) * spd * dt;
      const ny = c.y + (diry / dist) * spd * dt;
      if (this.walkable(region.map, nx, c.y, waterline, swims)) c.x = nx;
      if (this.walkable(region.map, c.x, ny, waterline, swims)) c.y = ny;
      if (dist < 1.2) this.creatureAttack(c, target);
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
      const region = this.regions.get(p.region);
      p.dead = false;
      p.hp = p.maxHp;
      if (region) {
        const sp = this.landSpawn(region, region.spawn.x, region.spawn.y);
        p.x = sp.x;
        p.y = sp.y;
      }
    }, 4000);
  }

  // --- helpers --------------------------------------------------------------
  private walkable(map: WorldMap, x: number, y: number, waterline: number, swimmer: boolean): boolean {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return false;
    const tile = map.tiles[ty * map.width + tx] as Tile;
    const submerged = isSubmerged(tile, waterline) || tile === Tile.Water;
    return swimmer ? submerged : !submerged;
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
