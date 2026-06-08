import {
  Appearance,
  BuildingState,
  CampfireState,
  FurnaceState,
  CRAFT_RECIPES,
  CreatureState,
  FOOD_VALUE,
  INVASIVE_LABEL,
  ITEM_IDS,
  ITEM_LABEL,
  WornSlot,
  SLOT_FOR_ITEM,
  ItemId,
  LootDrop,
  NpcState,
  PlantState,
  PlayerMode,
  PlayerState,
  ResourceNode,
  ServerMessage,
  ShopDef,
  SKILL_NAMES,
  Snapshot,
  TILE_SIZE,
  Tile,
  TravelNode,
  VehicleState,
  WorldMap,
  OverviewMap,
  CHUNK,
  WATERLINE_HIGH,
  DEPTH_ANKLE,
  DEPTH_SWIM,
  DEPTH_DEEP,
  DEPTH_OCEAN,
  skillLevel,
} from "../../shared/protocol";
import { LogbookEntry, LeaderboardData } from "../../shared/protocol";
import { SPECIES, resourceSpeciesKey } from "../../shared/species";
import { Net } from "./net";
import { drawAvatar } from "./avatar";
import { drawCharacterPixel, type CharOpts as PixelCharOpts } from "./pixelchar";

const CHARGE_MAX_MS = 600; // hold Space this long for a full-power swing
const HARVEST_RANGE_PX = 1.8 * TILE_SIZE; // client-side prompt range (cosmetic only)

const TILE_COLORS: Record<Tile, string> = {
  [Tile.Water]: "#287ab0",
  [Tile.FreshWater]: "#2a8878",
  [Tile.Sand]: "#d4c070",
  [Tile.Grass]: "#88b040",   // warm yellow-green — Eastward vibe
  [Tile.Forest]: "#3a6228",
  [Tile.Hill]: "#8a7850",
  [Tile.Rock]: "#8a8278",
  [Tile.Road]: "#606050",
  [Tile.Dock]: "#8a6038",
};

// ── Eastward-style tile texture helpers ──────────────────────────────────────
// Deterministic per-tile hash — stable decoration, never flickers.
function tileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 1234567891) | 0;
  h ^= h >>> 13; h = Math.imul(h, 1540483477); h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}

// Grass: sunlit patches, individual blade clusters, stones, rare flowers.
function drawGrassTexture(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number) {
  const h1 = tileHash(tx, ty);
  const h2 = tileHash(tx + 97, ty + 13);
  const h3 = tileHash(tx * 3 + 1, ty * 5 + 7);
  const T = TILE_SIZE;

  // Sunlit patch (~35% of tiles) — bright warm area
  if (h1 > 0.65) {
    ctx.fillStyle = "#a0c848";
    const pw = (5 + h1 * 7) | 0;
    const ph = (3 + h2 * 5) | 0;
    ctx.fillRect(sx + (h2 * (T - pw - 2) | 0) + 1, sy + (h3 * (T - ph - 2) | 0) + 1, pw, ph);
  }

  // Shadow patch opposite corner (~30%)
  if (h2 > 0.7) {
    ctx.fillStyle = "#527830";
    ctx.fillRect(sx + (h3 * (T - 6) | 0), sy + (h1 * (T - 5) | 0), 5, 4);
  }

  // 2–3 grass blade clusters
  const blades = 2 + (h1 > 0.5 ? 1 : 0);
  for (let i = 0; i < blades; i++) {
    const bh = tileHash(tx * 7 + i * 3, ty + i * 11);
    const bh2 = tileHash(tx + i * 13, ty * 5 + i * 7);
    const gx = sx + 1 + (bh * (T - 5) | 0);
    const gy = sy + 2 + (bh2 * (T - 7) | 0);
    ctx.fillStyle = "#527830";
    ctx.fillRect(gx, gy, 1, 3);           // left blade
    ctx.fillRect(gx + 2, gy - 1, 1, 4);   // right blade
    ctx.fillRect(gx - 1, gy + 2, 4, 1);   // base spread
    ctx.fillStyle = "#90c040";
    ctx.fillRect(gx, gy, 1, 1);           // tip highlight
    ctx.fillRect(gx + 2, gy - 1, 1, 1);
  }

  // Stone (~20% of tiles) — round pebble with highlight
  if (h3 < 0.2) {
    const stx = sx + 2 + (h1 * (T - 8) | 0);
    const sty = sy + 3 + (h2 * (T - 7) | 0);
    ctx.fillStyle = "#8a8068"; ctx.fillRect(stx, sty + 1, 5, 2);  // shadow
    ctx.fillStyle = "#c8c0a8"; ctx.fillRect(stx, sty, 5, 2);      // body
    ctx.fillStyle = "#e0d8c0"; ctx.fillRect(stx + 1, sty, 2, 1);  // highlight
  }

  // Small clover/flower (~8% of tiles)
  if (h1 > 0.92) {
    const flx = sx + 3 + (h2 * (T - 7) | 0);
    const fly = sy + 3 + (h3 * (T - 7) | 0);
    ctx.fillStyle = "#d8e890";
    ctx.fillRect(flx, fly, 1, 1); ctx.fillRect(flx + 2, fly, 1, 1); ctx.fillRect(flx + 1, fly - 1, 1, 1);
    ctx.fillStyle = "#c0d860"; ctx.fillRect(flx + 1, fly + 1, 1, 1);
  }
}

// Forest floor: tree-shadow patches, dappled light, fallen leaves, root hints.
function drawForestTexture(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number) {
  const h1 = tileHash(tx, ty);
  const h2 = tileHash(tx + 31, ty + 71);
  const h3 = tileHash(tx * 5, ty * 3 + 17);
  const T = TILE_SIZE;

  // Dark canopy-shadow patch
  ctx.fillStyle = "#283a1e";
  ctx.fillRect(sx + (h1 * (T - 9) | 0), sy + (h2 * (T - 7) | 0), 8, 5);

  // Dappled-light ellipse (~60% of tiles)
  if (h1 > 0.4) {
    ctx.fillStyle = "#70a840";
    ctx.beginPath();
    ctx.ellipse(sx + 3 + (h2 * (T - 7) | 0), sy + 3 + (h3 * (T - 7) | 0), 4, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Fallen leaves — warm brown/orange
  if (h3 < 0.6) {
    ctx.fillStyle = "#6a4820"; ctx.fillRect(sx + (h1 * (T - 5) | 0), sy + (h2 * (T - 5) | 0), 3, 1);
    ctx.fillStyle = "#885028"; ctx.fillRect(sx + (h3 * (T - 4) | 0), sy + (h1 * (T - 4) | 0), 2, 1);
  }

  // Root hint (~35% of tiles)
  if (h2 < 0.35) {
    ctx.strokeStyle = "#3a2a14"; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sx + T / 2, sy + T - 3);
    ctx.quadraticCurveTo(sx + T / 2 + 4, sy + T - 5, sx + T - 2, sy + T - 2);
    ctx.stroke();
  }
}

// Sand: wavy drift lines, pebbles, shell highlights.
function drawSandTexture(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number) {
  const h1 = tileHash(tx, ty);
  const h2 = tileHash(tx + 17, ty + 43);
  const h3 = tileHash(tx * 7, ty * 11);
  const T = TILE_SIZE;

  ctx.strokeStyle = "#b0984a"; ctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    const wy = sy + 4 + (tileHash(tx + i, ty + i * 7) * (T - 8) | 0);
    ctx.beginPath();
    ctx.moveTo(sx + 1, wy);
    ctx.quadraticCurveTo(sx + T * 0.35, wy - 1, sx + T * 0.65, wy + 1);
    ctx.quadraticCurveTo(sx + T * 0.82, wy + 1, sx + T - 1, wy);
    ctx.stroke();
  }

  if (h1 < 0.3) { // pebble
    ctx.fillStyle = "#c0b070"; ctx.fillRect(sx + (h2 * (T - 5) | 0), sy + (h3 * (T - 4) | 0), 3, 2);
  }
  if (h2 > 0.8) { // shell / bright speck
    ctx.fillStyle = "#ece8d0"; ctx.fillRect(sx + (h1 * (T - 4) | 0), sy + (h2 * (T - 4) | 0), 2, 1);
  }
}

// Road: visible tyre-track pair + gravel scatter.
function drawRoadTexture(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number) {
  const T = TILE_SIZE;
  ctx.fillStyle = "#3e3028";
  ctx.fillRect(sx + 2, sy + (T * 0.3 | 0), T - 4, 1);
  ctx.fillRect(sx + 2, sy + (T * 0.7 | 0), T - 4, 1);
  ctx.fillStyle = "#706558";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(sx + (tileHash(tx + i, ty + i * 3) * (T - 2) | 0), sy + (tileHash(tx + i * 5, ty + i) * (T - 2) | 0), 1, 1);
  }
}

// Rock/Hill: highlight strip, shadow patch, crack line, pebble.
function drawRockTexture(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, tile: Tile) {
  const h1 = tileHash(tx, ty);
  const h2 = tileHash(tx + 19, ty + 83);
  const h3 = tileHash(tx * 11, ty * 7);
  const T = TILE_SIZE;
  const isRock = tile === Tile.Rock;

  ctx.fillStyle = isRock ? "#585048" : "#504838";
  ctx.fillRect(sx + (h1 * (T - 10) | 0), sy + T - 6, 8, 5); // shadow patch
  ctx.fillStyle = isRock ? "#b0a898" : "#a09880";
  ctx.fillRect(sx + 2, sy + 2, T - 4, 2);                    // top highlight

  ctx.strokeStyle = isRock ? "#484038" : "#504030"; ctx.lineWidth = 1;
  ctx.beginPath();
  const cx = sx + 3 + (h1 * (T - 8) | 0);
  const cy = sy + 5 + (h2 * (T - 12) | 0);
  ctx.moveTo(cx, cy); ctx.lineTo(cx + 3, cy + 4); ctx.lineTo(cx + 2, cy + 7); ctx.stroke();

  if (h3 > 0.6) {
    ctx.fillStyle = isRock ? "#888078" : "#807860";
    ctx.fillRect(sx + (h2 * (T - 5) | 0), sy + (h3 * (T - 5) | 0), 3, 2);
  }
}

// Water: bright animated ripple stripes + dark wave troughs — visible shimmer.
function drawWaterShimmer(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, now: number, col: string) {
  const T = TILE_SIZE;
  const r1 = parseInt(col.slice(1, 3), 16);
  const g1 = parseInt(col.slice(3, 5), 16);
  const b1 = parseInt(col.slice(5, 7), 16);

  const p1 = (now * 0.9 + tx * 0.6 + ty * 0.8) % 1;
  const p2 = (now * 0.7 + tx * 1.1 + ty * 0.4 + 0.5) % 1;
  const row1 = sy + (p1 * T | 0);
  const row2 = sy + (p2 * T | 0);
  const w1 = 5 + (tileHash(tx * 7, ty * 3) * 8 | 0);
  const w2 = 4 + (tileHash(tx + 3, ty * 9) * 7 | 0);
  const x1 = sx + 1 + (tileHash(tx + 1, ty) * (T - w1 - 2) | 0);
  const x2 = sx + 1 + (tileHash(tx, ty + 1) * (T - w2 - 2) | 0);

  ctx.fillStyle = `rgba(${Math.min(255, r1 + 80)},${Math.min(255, g1 + 80)},${Math.min(255, b1 + 80)},0.65)`;
  ctx.fillRect(x1, row1, w1, 1);
  ctx.fillStyle = `rgba(${Math.min(255, r1 + 50)},${Math.min(255, g1 + 50)},${Math.min(255, b1 + 50)},0.45)`;
  ctx.fillRect(x2, row2, w2, 1);
  ctx.fillStyle = `rgba(${Math.max(0, r1 - 30)},${Math.max(0, g1 - 30)},${Math.max(0, b1 - 30)},0.3)`;
  ctx.fillRect(sx + 2, sy + ((p1 + 0.3) % 1 * T | 0), T - 4, 1);
}

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private net: Net;

  private myId = "";
  private map: WorldMap | null = null;
  private regionId = "";
  private overview: OverviewMap | null = null; // downsampled full map for the minimap
  private regionName = "";
  private travelNodes: TravelNode[] = [];
  private snap: Snapshot | null = null;

  private keys = new Set<string>();
  private lastDir = { x: 0, y: 0 };
  private cam = { x: 0, y: 0 };
  private zoom = 1.6; // pushed-in camera so you see the person & their moves up close
  private logLines: string[] = [];
  private chatLines: Array<{ from: string; msg: string; channel: "global" | "team" | "private"; ts: number }> = [];
  private chargeStart: number | null = null; // when Space went down (for charged swings)
  private chatOpen = false; // is the chat text box visible?
  private craftOpen = false; // is the crafting panel visible?
  private craftSelected = 0; // highlighted recipe index
  private mapOpen = false;   // is the full-region map overlay open?
  private shopId: string | null = null; // building id of the open shop, else null
  private invOpen = false;   // is the inventory bag panel open?
  private npcOpen: string | null = null; // id of the NPC whose dialogue is showing
  private logbook: LogbookEntry[] = []; // BMSC discovery logbook (from server)
  private logbookOpen = false;          // is the logbook panel open?
  private inspectKey: string | null = null; // species key of the inspected thing
  private scanAt = 0;                    // perf.now() of last discovery scan (ring anim)
  private tracers: Array<{ x1: number; y1: number; x2: number; y2: number; at: number; weapon: string }> = [];
  private leaderboard: LeaderboardData | null = null;
  private leaderboardOpen = false;

  // Per-entity walk tracking: last seen tile pos + a phase accumulator, so the
  // oblique character's legs only stride while actually moving.
  private gait = new Map<string, { x: number; y: number; phase: number; moving: number; speed: number }>();
  // Transient melee-swing animation per player id (set from a "melee" fx or local Space release).
  private attackAnim = new Map<string, { at: number; stance: "high" | "low" }>();

  // Side panel (OSRS-style right panel)
  private panelTab: "inv" | "equip" | "skills" | "log" | "map" | "help" = "inv";
  private panelLastUpdate = 0;
  private minimapCtx: CanvasRenderingContext2D | null = null;
  static readonly PANEL_W = 200; // px — must match #side-panel width in CSS

  // Login-screen hooks (main.ts wires these before the game proper starts).
  onNameStatus?: (name: string, taken: boolean) => void;
  onJoinDenied?: (reason: string) => void;
  private started = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.net = new Net((m) => this.onServer(m));
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
  }

  // Open the socket early so the login screen can check name availability
  // before the player commits. Idempotent.
  connect() {
    this.net.connect();
  }

  // Ask the server whether a name is already registered (login screen).
  checkName(name: string) {
    this.net.send({ t: "checkName", name });
  }

  // Submit a sign-in / registration. `secret` is the player's passphrase, which
  // doubles as the cross-device account claim (email is optional, stored for recovery).
  start(name: string, appearance: Appearance, secret: string, register = false, email?: string) {
    this.net.connect();
    this.net.send({ t: "join", name, appearance, secret, register, email });
    if (this.started) return; // a retry after a denied sign-in — loop already runs
    this.started = true;

    // Show the right panel and wire up tab buttons.
    const panel = document.getElementById("side-panel")!;
    panel.classList.remove("hidden");
    const minimapEl = document.getElementById("minimap-canvas") as HTMLCanvasElement;
    this.minimapCtx = minimapEl.getContext("2d")!;
    for (const tab of ["inv", "equip", "skills", "log", "map", "help"] as const) {
      document.getElementById(`ptab-${tab}`)?.addEventListener("click", () => {
        this.panelTab = tab;
        document.querySelectorAll(".ptab").forEach((b) => b.classList.remove("active"));
        document.getElementById(`ptab-${tab}`)?.classList.add("active");
      });
    }
    // Mode switch buttons (combat / research / profession).
    for (const mode of ["combat", "research", "profession"] as const) {
      document.getElementById(`mode-${mode}`)?.addEventListener("click", () => this.setMode(mode));
    }

    // Click delegation for inventory / equip cells -> item context menu.
    document.getElementById("panel-content")?.addEventListener("click", (e) => {
      const cell = (e.target as HTMLElement).closest("[data-item]") as HTMLElement | null;
      if (!cell) return;
      const item = cell.dataset.item as ItemId | undefined;
      const slot = cell.dataset.slot; // present on equip paper-doll hand slot
      if (slot === "hand") { this.net.send({ t: "equip", item: null }); this.closeItemMenu(); return; }
      if (item) this.openItemMenu(item, e.clientX, e.clientY);
    });
    // Any outside click / Escape closes the item menu.
    document.addEventListener("click", (e) => {
      const m = document.getElementById("item-menu");
      if (m && !m.classList.contains("hidden") &&
          !m.contains(e.target as Node) &&
          !(e.target as HTMLElement).closest("[data-item]")) this.closeItemMenu();
    });

    requestAnimationFrame(() => this.frame());

    // Chat input box — wired up once.
    const chatInput = document.getElementById("chat-input") as HTMLInputElement;
    chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation(); // prevent WASD etc. from firing while typing
      if (e.key === "Enter") {
        const raw = chatInput.value.trim();
        if (raw) this.net.send({ t: "chat", msg: raw });
        chatInput.value = "";
        this.closeChatInput();
      } else if (e.key === "Escape") {
        chatInput.value = "";
        this.closeChatInput();
      }
    });
  }

  private openChatInput() {
    this.chatOpen = true;
    const el = document.getElementById("chat-input")!;
    el.classList.remove("hidden");
    el.focus();
  }

  private closeChatInput() {
    this.chatOpen = false;
    document.getElementById("chat-input")!.classList.add("hidden");
    (document.getElementById("game") as HTMLCanvasElement).focus();
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    // Until the player has washed ashore, the login form owns the keyboard —
    // never let game bindings swallow keystrokes (fixes password typing).
    if (!this.started) return;
    // Never intercept keys while focus is inside a text input (login form, etc.)
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
    // While the chat box is open, let it handle all input.
    if (this.chatOpen) return;
    const k = e.key.toLowerCase();
    if (down) {
      if (k === "enter") {
        this.openChatInput();
        e.preventDefault();
        return;
      }
      if (k === " ") {
        // Start charging on first press; the swing fires on release.
        if (this.chargeStart === null) this.chargeStart = performance.now();
        e.preventDefault();
      } else if (k === "tab") {
        this.cycleMode();
        e.preventDefault();
      } else if (k === "alt") {
        // Toggle combat stance (high punch ↔ low kick).
        const cur = this.me?.stance ?? "high";
        this.net.send({ t: "setStance", stance: cur === "high" ? "low" : "high" });
        e.preventDefault();
      } else if (k === "/") {
        // Grab a target ahead — or, if already holding, throw them.
        this.net.send({ t: "grab" });
        e.preventDefault();
      } else if (!e.repeat) {
        if (k === "f") {
          this.net.send({ t: "board" });
        } else if (k === "e") {
          // Near an NPC? Talk instead of harvesting.
          const npc = this.nearbyNpc();
          if (npc) {
            this.npcOpen = this.npcOpen === npc.id ? null : npc.id;
          } else {
            this.net.send({ t: "harvest" });
            this.net.send({ t: "repair" });
            this.net.send({ t: "drink" }); // sip from fresh water if beside a lake
          }
        } else if (k === "n") {
          const npc = this.nearbyNpc();
          if (npc) this.npcOpen = this.npcOpen === npc.id ? null : npc.id;
        } else if (k === "i") {
          this.invOpen = !this.invOpen;
          e.preventDefault();
        } else if (k === "l") {
          this.logbookOpen = !this.logbookOpen;
          e.preventDefault();
        } else if (k === "k") {
          this.leaderboardOpen = !this.leaderboardOpen;
          e.preventDefault();
        } else if (k === "h") {
          // Context-sensitive: research mode = hide, combat/profession = heal.
          if (this.me?.mode === "research") {
            this.net.send({ t: "hide" });
          } else {
            this.net.send({ t: "heal" }); // first aid to nearest hurt player
          }
          e.preventDefault();
        } else if (k === "j") {
          this.net.send({ t: "jump" });
          e.preventDefault();
        } else if (k === "p" && this.me?.mode === "research") {
          this.net.send({ t: "playDead" });
          e.preventDefault();
        } else if (k === "v" && this.me?.mode === "research") {
          this.net.send({ t: "listen" });
          e.preventDefault();
        } else if (k === "r") {
          this.net.send({ t: "scan" });        // discovery radius
          this.scanAt = performance.now();
          e.preventDefault();
        } else if (k === "x") {
          this.inspectKey = this.inspectKey ? null : this.nearestSpeciesKey();
          e.preventDefault();
        } else if (!this.shopId && !this.craftOpen && k >= "1" && k <= "6") {
          this.selectWeapon(parseInt(k) - 1); // wield weapon slot
          e.preventDefault();
        } else if (!this.shopId && !this.craftOpen && k === "0") {
          this.net.send({ t: "equip", item: null }); // bare hands
          e.preventDefault();
        } else if (k === "q") {
          this.net.send({ t: "eat" });
        } else if (k === "g") {
          this.net.send({ t: "fish" });
        } else if (k === "z") {
          this.net.send({ t: "sleep" });
        } else if (k === "t") {
          this.net.send({ t: "travel" });
        } else if (k === "m") {
          this.mapOpen = !this.mapOpen;
          e.preventDefault();
        } else if (k === "escape") {
          this.mapOpen = false;
          this.craftOpen = false;
          this.shopId = null;
          this.invOpen = false;
          this.npcOpen = null;
          this.logbookOpen = false;
          this.leaderboardOpen = false;
          this.inspectKey = null;
          e.preventDefault();
        } else if (k === "b") {
          // In combat mode, B is BLOCK (break a grab in high stance / soften hits).
          // Otherwise it toggles the nearest shop.
          if (this.me?.mode === "combat" && !this.shopId) {
            this.net.send({ t: "block" });
          } else if (this.shopId) {
            this.shopId = null;
          } else {
            const shop = this.nearbyShop();
            if (shop) { this.shopId = shop.id; this.craftOpen = false; }
          }
          e.preventDefault();
        } else if (this.shopId && k >= "1" && k <= "9") {
          this.tradeLine(parseInt(k) - 1);
          e.preventDefault();
        } else if (this.shopId && k === "escape") {
          this.shopId = null;
          e.preventDefault();
        } else if (k === "c") {
          this.craftOpen = !this.craftOpen;
          this.craftSelected = 0;
          e.preventDefault();
        } else if (this.craftOpen && k >= "1" && k <= "9") {
          const idx = parseInt(k) - 1;
          if (idx < CRAFT_RECIPES.length) {
            this.craftSelected = idx;
            this.net.send({ t: "craft", recipe: CRAFT_RECIPES[idx].id });
          }
          e.preventDefault();
        } else if (this.craftOpen && k === "escape") {
          this.craftOpen = false;
          e.preventDefault();
        }
      }
    } else if (k === " ") {
      if (this.chargeStart !== null) {
        const held = performance.now() - this.chargeStart;
        this.chargeStart = null;
        const charge = Math.max(0, Math.min(1, held / CHARGE_MAX_MS));
        this.net.send({ t: "attack", charge });
        // Immediately start a local attack animation so the swing feels responsive.
        this.attackAnim.set(this.myId, { at: performance.now(), stance: this.me?.stance ?? "high" });
        e.preventDefault();
      }
    }
    if (
      ["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)
    ) {
      if (down) this.keys.add(k);
      else this.keys.delete(k);
      e.preventDefault();
    }
    if (e.key === "Shift") {
      if (down) this.keys.add("shift");
      else this.keys.delete("shift");
      e.preventDefault();
    }
  }

  private lastSprint = false;

  private get me(): PlayerState | undefined {
    return this.snap?.players.find((p) => p.id === this.myId);
  }

  private sendInput() {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    const sprint = this.keys.has("shift");
    if (dx !== this.lastDir.x || dy !== this.lastDir.y || sprint !== this.lastSprint) {
      this.lastDir = { x: dx, y: dy };
      this.lastSprint = sprint;
      this.net.send({ t: "input", dx, dy, sprint });
    }
  }

  private onServer(m: ServerMessage) {
    if (m.t === "init") {
      this.myId = m.id;
      // Big maps stream in as chunks. Allocate the full grid up front (defaults
      // read as ocean) and patch chunks in as they arrive; all the renderer's
      // tiles[idx]/elevation[idx] lookups keep working unchanged.
      const w = m.region.width, h = m.region.height;
      this.map = {
        width: w, height: h,
        tiles: new Array(w * h).fill(Tile.Water),
        elevation: new Array(w * h).fill(0),
      };
      this.regionId = m.region.id;
      this.overview = m.region.overview;
      this.regionName = m.region.name;
      this.travelNodes = m.region.travelNodes;
      this.snap = m.snapshot;
    } else if (m.t === "chunk") {
      if (this.map && m.region === this.regionId) {
        const mw = this.map.width;
        for (let yy = 0; yy < m.h; yy++) {
          const dst = (m.cy * CHUNK + yy) * mw + m.cx * CHUNK;
          const src = yy * m.w;
          for (let xx = 0; xx < m.w; xx++) {
            this.map.tiles[dst + xx] = m.tiles[src + xx];
            this.map.elevation[dst + xx] = m.elevation[src + xx];
          }
        }
      }
    } else if (m.t === "nameStatus") {
      this.onNameStatus?.(m.name, m.taken);
    } else if (m.t === "joinDenied") {
      this.onJoinDenied?.(m.reason);
    } else if (m.t === "snapshot") {
      this.snap = m.snapshot;
    } else if (m.t === "logbook") {
      this.logbook = m.entries;
    } else if (m.t === "leaderboard") {
      this.leaderboard = m.data;
    } else if (m.t === "fx") {
      if (m.kind === "tracer") this.tracers.push({ x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, at: performance.now(), weapon: m.weapon });
      if (m.kind === "melee") this.attackAnim.set(m.id, { at: performance.now(), stance: m.stance });
      if (this.tracers.length > 40) this.tracers.shift();
    } else if (m.t === "log") {
      this.logLines.push(m.msg);
      if (this.logLines.length > 6) this.logLines.shift();
      this.renderLog();
    } else if (m.t === "chat") {
      const prefix = m.channel === "team" ? "[TEAM] " : m.channel === "private" ? "[PM] " : "";
      this.chatLines.push({ from: m.from, msg: m.msg, channel: m.channel, ts: Date.now() });
      if (this.chatLines.length > 30) this.chatLines.shift();
      this.logLines.push(`${prefix}${m.from}: ${m.msg}`);
      if (this.logLines.length > 6) this.logLines.shift();
      this.renderLog();
    }
  }

  private frame() {
    this.sendInput();
    this.render();
    requestAnimationFrame(() => this.frame());
  }

  // --- rendering ------------------------------------------------------------
  private render() {
    const ctx = this.ctx;
    ctx.fillStyle = "#07131c";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map || !this.snap) return;

    const me = this.snap.players.find((p) => p.id === this.myId);
    const z = this.zoom;
    if (me) {
      // Centre player in the visible area (left of the right panel), accounting
      // for the zoom so the camera frames the same world point however far in.
      const visW = (this.canvas.width - Game.PANEL_W) / z;
      const visH = this.canvas.height / z;
      this.cam.x += (me.x * TILE_SIZE - visW / 2 - this.cam.x) * 0.15;
      this.cam.y += (me.y * TILE_SIZE - visH / 2 - this.cam.y) * 0.15;
    }

    // === World pass: drawn under a zoom transform (everything via toScreen) ===
    ctx.save();
    ctx.scale(z, z);

    // --- Ground layer (flat, always beneath the standing world) ---
    this.drawTiles();
    this.drawKelpBeds();
    this.drawTerrainWalls();
    this.drawTravelNodes();
    this.drawCampfires(this.snap.campfires);
    this.drawFurnaces(this.snap.furnaces);
    this.drawPlants(this.snap.plants);
    this.drawMarineCreatures(this.snap.creatures, me);

    // --- Upright layer, painted back-to-front by ground Y so taller things in
    //     front correctly overlap things behind them (the oblique illusion). ---
    this.drawSortedEntities(me);

    this.drawTracers();
    if (me) this.drawSelfOverlay(me);
    if (me) this.drawScanRing(me);
    this.drawTravelPrompt(me);
    this.drawBoardPrompt(me);
    this.drawShopPrompt(me);
    this.drawNpcPrompt(me);
    this.drawRefuelPrompt(me);
    this.drawHarvestPrompt(this.snap.resourceNodes, this.snap.plants, me);
    this.drawFishPrompt(me);

    ctx.restore();
    // === Screen pass: HUD & modals at 1:1 (unscaled) ===

    this.drawHud(this.snap, me);
    this.updateSidePanel(me);
    if (this.craftOpen) this.drawCraftPanel(me);
    if (this.shopId) this.drawShopPanel(me);
    if (this.invOpen) this.drawInventoryPanel(me);
    if (this.npcOpen) this.drawNpcDialogue(me);
    if (this.mapOpen) this.drawMapOverlay(me);
    if (this.inspectKey) this.drawInspectCard();
    if (this.logbookOpen) this.drawLogbook();
    if (this.leaderboardOpen) this.drawLeaderboard();
  }

  // Town leaderboard / current title holders (K).
  private drawLeaderboard() {
    const ctx = this.ctx;
    const W = Math.min(440, this.canvas.width - 60);
    const H = Math.min(440, this.canvas.height - 60);
    const x = (this.canvas.width - W) / 2, y = (this.canvas.height - H) / 2;
    ctx.fillStyle = "rgba(6,16,24,0.95)";
    roundRect(ctx, x, y, W, H, 12); ctx.fill();
    ctx.strokeStyle = "#ffd54f"; ctx.lineWidth = 2;
    roundRect(ctx, x, y, W, H, 12); ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = "#fff4d6"; ctx.font = "bold 18px system-ui";
    ctx.fillText("Bamfield Standings", x + 18, y + 30);
    const lb = this.leaderboard;
    let ry = y + 58;
    const row = (label: string, who: string | null, col = "#eafff7") => {
      ctx.fillStyle = "#9fd9cd"; ctx.font = "12px system-ui";
      ctx.fillText(label, x + 18, ry);
      ctx.fillStyle = who ? col : "rgba(150,170,175,0.5)"; ctx.font = "bold 13px system-ui";
      ctx.fillText(who ?? "—", x + 170, ry);
      ry += 24;
    };
    if (!lb) { ctx.fillStyle = "#9fd9cd"; ctx.font = "13px system-ui"; ctx.fillText("Loading…", x + 18, ry); return; }
    row("★ Unofficial Mayor", lb.mayor, "#ffd54f");
    row("BMSC President", lb.president, "#7fd0ff");
    row("Fire Chief", lb.chief, "#ff9d6b");
    row("Nurse", lb.nurse, "#9affc0");
    if (lb.responders.length) row("First Responders", lb.responders.join(", "));
    ry += 6;
    ctx.fillStyle = "#7fd0c2"; ctx.font = "bold 13px system-ui";
    ctx.fillText("Top Banfielders", x + 18, ry); ry += 20;
    ctx.font = "12px system-ui";
    lb.topBanfielders.forEach((e, i) => {
      ctx.fillStyle = "#eafff7";
      ctx.fillText(`${i + 1}. ${e.name}`, x + 28, ry);
      ctx.textAlign = "right"; ctx.fillStyle = "#9fe6c0";
      ctx.fillText(`${e.pts} pts`, x + W - 22, ry); ctx.textAlign = "left";
      ry += 17;
    });
    ctx.fillStyle = "#8aa"; ctx.font = "10px system-ui";
    ctx.fillText("K close · H first aid · R scan · L logbook · X inspect", x + 18, y + H - 12);
  }

  // Nearest inspectable thing (creature / plant / resource) to the player.
  private nearestSpeciesKey(): string | null {
    if (!this.snap) return null;
    const me = this.snap.players.find((p) => p.id === this.myId);
    if (!me) return null;
    let best: string | null = null, bestD = 6;
    const consider = (x: number, y: number, key: string) => {
      const d = Math.hypot(x - me.x, y - me.y);
      if (d < bestD && SPECIES[key]) { bestD = d; best = key; }
    };
    for (const c of this.snap.creatures) consider(c.x, c.y, c.kind);
    for (const pl of this.snap.plants) consider(pl.x + 0.5, pl.y + 0.5, pl.kind);
    for (const n of this.snap.resourceNodes) consider(n.x + 0.5, n.y + 0.5, resourceSpeciesKey(n.kind, n.variety));
    return best;
  }

  // Wield weapon slot idx (1-6 → WEAPON_ORDER) if you own it.
  private selectWeapon(idx: number) {
    const item = WEAPON_ORDER[idx];
    if (!item) return;
    const me = this.snap?.players.find((p) => p.id === this.myId);
    if (me && (me.inventory[item] ?? 0) > 0) this.net.send({ t: "equip", item });
  }

  // --- Item context menu (inventory / equip) --------------------------------
  private openItemMenu(item: ItemId, x: number, y: number) {
    const menu = document.getElementById("item-menu")!;
    const me = this.me;
    const qty = me?.inventory[item] ?? 0;
    if (!me || qty <= 0) { this.closeItemMenu(); return; }
    const isWeapon = (WEAPON_ORDER as ItemId[]).includes(item);
    const isFood = !!(FOOD_VALUE as Record<string, unknown>)[item];
    const slot = SLOT_FOR_ITEM[item] as WornSlot | undefined;
    const equipped = me.equipped === item;
    const worn = me.appearance?.worn ?? {};
    const isWorn = slot ? worn[slot] === item : false;

    const actions: Array<{ label: string; run: () => void }> = [];
    if (isWeapon || slot === "hand") {
      if (equipped) actions.push({ label: "Put away", run: () => this.net.send({ t: "equip", item: null }) });
      else actions.push({ label: me.mode === "combat" ? "Wield" : "Use", run: () => this.net.send({ t: "equip", item }) });
    }
    if (slot && slot !== "hand") {
      if (isWorn) actions.push({ label: "Take off", run: () => this.net.send({ t: "wear", slot: slot!, item: null }) });
      else actions.push({ label: "Wear", run: () => this.net.send({ t: "wear", slot: slot!, item }) });
    }
    if (isFood) actions.push({ label: "Eat", run: () => this.net.send({ t: "eat", item }) });
    actions.push({ label: "Drop", run: () => this.net.send({ t: "drop", item }) });
    if (qty > 1) actions.push({ label: `Drop all (${qty})`, run: () => this.net.send({ t: "drop", item, all: true }) });

    menu.innerHTML =
      `<div class="im-title">${ITEM_LABEL[item] ?? item}</div>` +
      actions.map((_, i) => `<button data-act="${i}">${actions[i].label}</button>`).join("");
    menu.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const i = parseInt((b as HTMLElement).dataset.act!);
        actions[i]?.run();
        this.closeItemMenu();
      });
    });
    // Position, clamped to viewport.
    menu.classList.remove("hidden");
    const r = menu.getBoundingClientRect();
    const px = Math.min(x, window.innerWidth - r.width - 8);
    const py = Math.min(y, window.innerHeight - r.height - 8);
    menu.style.left = `${Math.max(8, px)}px`;
    menu.style.top = `${Math.max(8, py)}px`;
  }

  private closeItemMenu() {
    document.getElementById("item-menu")?.classList.add("hidden");
  }

  // Cycle combat → research → profession → combat (2 s transform server-side).
  private cycleMode() {
    const order: PlayerMode[] = ["combat", "research", "profession"];
    const cur = this.me?.mode ?? "combat";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.net.send({ t: "setMode", mode: next });
  }

  // Switch directly to a mode (panel buttons).
  setMode(mode: PlayerMode) {
    if (this.me?.mode !== mode) this.net.send({ t: "setMode", mode });
  }

  // Brief tracer streaks for ranged shots.
  private drawTracers() {
    const now = performance.now();
    this.tracers = this.tracers.filter((t) => now - t.at < 160);
    const ctx = this.ctx;
    for (const t of this.tracers) {
      const a = 1 - (now - t.at) / 160;
      const s1 = this.toScreen(t.x1, t.y1), s2 = this.toScreen(t.x2, t.y2);
      ctx.strokeStyle = t.weapon === "rifle" ? `rgba(255,240,180,${a.toFixed(3)})` : `rgba(230,250,255,${(a * 0.9).toFixed(3)})`;
      ctx.lineWidth = t.weapon === "rifle" ? 2.2 : 1.6;
      ctx.beginPath(); ctx.moveTo(s1.sx, s1.sy); ctx.lineTo(s2.sx, s2.sy); ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(s2.sx, s2.sy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Expanding teal ring when you fire the discovery scan (R).
  private drawScanRing(me: PlayerState) {
    const t = (performance.now() - this.scanAt) / 900;
    if (t < 0 || t > 1) return;
    const { sx, sy } = this.toScreen(me.x, me.y);
    const ctx = this.ctx;
    ctx.strokeStyle = `rgba(120,230,200,${((1 - t) * 0.7).toFixed(3)})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, t * 9 * TILE_SIZE, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Minimalist field-guide card for the inspected species (X).
  private drawInspectCard() {
    const info = this.inspectKey ? SPECIES[this.inspectKey] : null;
    const ctx = this.ctx;
    if (!info) {
      // Nothing nearby to inspect — brief hint.
      ctx.fillStyle = "rgba(7,19,28,0.85)";
      const msg = "Nothing close to inspect — get nearer.";
      ctx.font = "13px system-ui"; ctx.textAlign = "center";
      const w = ctx.measureText(msg).width + 24;
      const x = this.canvas.width / 2, y = this.canvas.height - 150;
      ctx.fillRect(x - w / 2, y - 20, w, 28);
      ctx.fillStyle = "#cfe"; ctx.fillText(msg, x, y);
      return;
    }
    const W = 340, H = 116;
    const x = this.canvas.width / 2 - W / 2;
    const y = this.canvas.height - H - 96;
    ctx.fillStyle = "rgba(7,19,28,0.92)";
    roundRect(ctx, x, y, W, H, 10); ctx.fill();
    ctx.strokeStyle = "#2bb9a6"; ctx.lineWidth = 2;
    roundRect(ctx, x, y, W, H, 10); ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = "#eafff7"; ctx.font = "bold 16px system-ui";
    ctx.fillText(info.common, x + 14, y + 26);
    ctx.fillStyle = "#9fd9cd"; ctx.font = "italic 12px system-ui";
    ctx.fillText(info.scientific, x + 14, y + 43);
    if (info.rarity) {
      ctx.fillStyle = RARITY_COLOR[info.rarity] ?? "#cfe";
      ctx.font = "11px system-ui"; ctx.textAlign = "right";
      ctx.fillText(info.rarity.toUpperCase(), x + W - 14, y + 26);
      ctx.textAlign = "left";
    }
    ctx.fillStyle = "#d8e6e2"; ctx.font = "12px system-ui";
    wrapText(ctx, info.blurb, x + 14, y + 62, W - 28, 15);
    if (info.uses) {
      ctx.fillStyle = "#ffd98a"; ctx.font = "11px system-ui";
      wrapText(ctx, "▸ " + info.uses, x + 14, y + H - 16, W - 28, 14);
    }
  }

  // The BMSC logbook panel (L) — everything you've scanned, grouped.
  // Cache of 48×48 OffscreenCanvas portraits for logbook creature entries.
  private readonly logPortraitCache = new Map<string, OffscreenCanvas>();

  private getLogPortrait(kind: string): OffscreenCanvas {
    let oc = this.logPortraitCache.get(kind);
    if (!oc) {
      oc = new OffscreenCanvas(48, 48);
      const pctx = oc.getContext("2d")!;
      pctx.fillStyle = "#0a1c29";
      pctx.fillRect(0, 0, 48, 48);
      pctx.save();
      // drawFullCreature expects canvas coords — center the creature in the 48×48 tile.
      drawFullCreature(pctx as unknown as CanvasRenderingContext2D, kind, 24, 24);
      pctx.restore();
      this.logPortraitCache.set(kind, oc);
    }
    return oc;
  }

  private drawLogbook() {
    const ctx = this.ctx;
    const W = Math.min(600, this.canvas.width - 60);
    const H = Math.min(540, this.canvas.height - 60);
    const x = (this.canvas.width - W) / 2, y = (this.canvas.height - H) / 2;
    ctx.fillStyle = "rgba(6,16,24,0.95)";
    roundRect(ctx, x, y, W, H, 12); ctx.fill();
    ctx.strokeStyle = "#2bb9a6"; ctx.lineWidth = 2;
    roundRect(ctx, x, y, W, H, 12); ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillStyle = "#eafff7"; ctx.font = "bold 18px system-ui";
    ctx.fillText("BMSC Field Logbook", x + 18, y + 30);
    const total = Object.keys(SPECIES).length;
    ctx.fillStyle = "#9fd9cd"; ctx.font = "12px system-ui";
    ctx.fillText(`${this.logbook.length} / ${total} species   ·   R=scan  X=inspect  L=close`, x + 18, y + 50);

    const byKey = new Map(this.logbook.map((e) => [e.key, e]));
    let ry = y + 74;
    const groups: Array<[string, string]> = [
      ["marine", "Marine"], ["land", "Land mammals"], ["bird", "Birds"],
      ["plant", "Plants"], ["tree", "Trees"], ["mineral", "Minerals"],
    ];

    // Two-column layout: left column starts at x+18, right column at x+18+col_w.
    const COL_W = Math.floor((W - 36) / 2);
    const PORTRAIT = 48;
    const ENTRY_H = PORTRAIT + 6;
    let col = 0; // 0=left, 1=right

    const nextEntry = () => {
      if (col === 1) { col = 0; ry += ENTRY_H + 4; }
      else col = 1;
    };

    for (const [g, label] of groups) {
      const keys = Object.keys(SPECIES).filter((k) => SPECIES[k].group === g);
      if (!keys.length) continue;
      // Group header spans both columns.
      if (col === 1) { col = 0; ry += ENTRY_H + 4; }
      ctx.fillStyle = "#7fd0c2"; ctx.font = "bold 12px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(label, x + 18, ry);
      ry += 16;

      for (const k of keys) {
        const found = byKey.get(k);
        const info = SPECIES[k];
        const cx = x + 18 + col * COL_W;
        const cy = ry;
        if (cy + ENTRY_H > y + H - 8) return;

        // Portrait box.
        ctx.fillStyle = found ? "#07131c" : "#060e14";
        roundRect(ctx, cx, cy, PORTRAIT, PORTRAIT, 4); ctx.fill();
        ctx.strokeStyle = found ? "#2bb9a6" : "#1d3040";
        ctx.lineWidth = 1;
        roundRect(ctx, cx, cy, PORTRAIT, PORTRAIT, 4); ctx.stroke();

        if (found) {
          // Draw the creature portrait from the cache.
          const portrait = this.getLogPortrait(k);
          ctx.drawImage(portrait, cx, cy);
        } else {
          // Unknown — draw a "?" silhouette.
          ctx.fillStyle = "rgba(40,80,90,0.6)";
          ctx.font = "bold 22px system-ui"; ctx.textAlign = "center";
          ctx.fillText("?", cx + PORTRAIT / 2, cy + PORTRAIT / 2 + 8);
        }

        // Text to the right of the portrait.
        const tx = cx + PORTRAIT + 5;
        const tw = COL_W - PORTRAIT - 10;
        ctx.textAlign = "left";
        ctx.fillStyle = found ? "#eafff7" : "rgba(150,170,175,0.5)";
        ctx.font = "bold 11px system-ui";
        // Clip name to available width.
        let nm = info.common;
        while (nm.length > 3 && ctx.measureText(nm).width > tw) nm = nm.slice(0, -1);
        if (nm !== info.common) nm += "…";
        ctx.fillText(nm, tx, cy + 14);
        if (found) {
          ctx.fillStyle = "#9fd9cd"; ctx.font = "10px system-ui";
          ctx.fillText(`×${found.count}`, tx, cy + 28);
        }

        nextEntry();
      }
      // End group: force new row.
      if (col === 1) { col = 0; ry += ENTRY_H + 4; }
      ry += 6;
    }
  }

  // Collect every "standing" object, sort by its ground-contact Y, then paint
  // back-to-front. This is the heart of the oblique look: a player south of a
  // tree (larger Y) draws over its trunk; north of it, behind the canopy.
  private drawSortedEntities(me?: PlayerState) {
    if (!this.snap) return;
    type Item = { baseY: number; z: number; draw: () => void };
    const items: Item[] = [];

    for (const b of this.snap.buildings)
      items.push({ baseY: b.y + b.h, z: 0, draw: () => this.drawBuilding(b) });

    for (const n of this.snap.resourceNodes) {
      const { sx, sy } = this.toScreen(n.x + 0.5, n.y + 0.5);
      const tall = n.kind === "tree";
      items.push({ baseY: n.y + (tall ? 0.8 : 0.6), z: 1, draw: () => drawResourceSprite(this.ctx, n, sx, sy) });
    }

    for (const v of this.snap.vehicles) {
      const { sx, sy } = this.toScreen(v.x, v.y);
      items.push({ baseY: v.y + 0.5, z: 1, draw: () => drawVehicleSprite(this.ctx, v, sx, sy) });
    }

    for (const c of this.snap.creatures) {
      if (MARINE_KINDS.has(c.kind)) continue; // marine handled in the ground pass
      items.push({ baseY: c.y + 0.5, z: 1, draw: () => this.drawLandCreature(c, me) });
    }

    for (const n of this.snap.npcs ?? [])
      items.push({ baseY: n.y + 0.875, z: 2, draw: () => this.drawNpc(n, me) });

    for (const p of this.snap.players)
      items.push({ baseY: p.y + 0.375, z: 3, draw: () => this.drawPlayer(p, p.id === this.myId) });

    for (const d of this.snap.lootDrops ?? []) {
      const { sx, sy } = this.toScreen(d.x, d.y);
      items.push({ baseY: d.y, z: 0, draw: () => drawLootDrop(this.ctx, d, sx, sy) });
    }

    items.sort((a, b) => a.baseY - b.baseY || a.z - b.z);
    for (const it of items) it.draw();
  }

  // Charge meter under your feet while you wind up a swing.
  private drawSelfOverlay(me: PlayerState) {
    if (this.chargeStart === null || me.vehicleId) return;
    const ctx = this.ctx;
    const { sx, sy } = this.toScreen(me.x, me.y);
    const charge = Math.max(0, Math.min(1, (performance.now() - this.chargeStart) / CHARGE_MAX_MS));
    const r = TILE_SIZE * 0.4 + 11;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = charge >= 1 ? "#ffd54f" : "#ff8a3d";
    ctx.beginPath();
    ctx.arc(sx, sy, r, -Math.PI / 2, -Math.PI / 2 + charge * Math.PI * 2);
    ctx.stroke();
  }

  private toScreen(tx: number, ty: number) {
    return { sx: tx * TILE_SIZE - this.cam.x, sy: ty * TILE_SIZE - this.cam.y };
  }

  private drawTiles() {
    const map = this.map!;
    const snap = this.snap!;
    const ctx = this.ctx;
    const startX = Math.max(0, Math.floor(this.cam.x / TILE_SIZE));
    const startY = Math.max(0, Math.floor(this.cam.y / TILE_SIZE));
    const endX = Math.min(map.width, startX + Math.ceil(this.canvas.width / TILE_SIZE) + 1);
    const endY = Math.min(map.height, startY + Math.ceil(this.canvas.height / TILE_SIZE) + 1);
    const now = performance.now() / 1000;

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const i = y * map.width + x;
        const tile = map.tiles[i] as Tile;
        const elev = map.elevation[i];
        const { sx, sy } = this.toScreen(x, y);
        const depth = snap.waterline - elev; // >0 means under water right now

        if (tile === Tile.FreshWater) {
          // Inland lake: a calm teal-green, lightly shaded by depth — clearly
          // not the same body as the salt inlet. Always wet (never mudflat).
          ctx.fillStyle = freshWaterColor(Math.max(2, depth));
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          drawWaterShimmer(ctx, sx, sy, x, y, now, "#7dd4c4");
        } else if (depth > 0) {
          // Colour by depth tier — ankle turquoise → abyss near-black.
          ctx.fillStyle = waterDepthColor(depth);
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          drawWaterShimmer(ctx, sx, sy, x, y, now, "#7fcfe8");
        } else if (tile === Tile.Water) {
          // Seabed the tide has receded from: exposed wet mudflat at low tide.
          ctx.fillStyle = "#6c5b3e";
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        } else {
          ctx.fillStyle = TILE_COLORS[tile];
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          // Brown high-tide line: dry ground the tide still reaches looks wet.
          if (elev < WATERLINE_HIGH) {
            const wet = (WATERLINE_HIGH - elev) / WATERLINE_HIGH;
            ctx.fillStyle = `rgba(86,58,33,${(0.1 + 0.3 * wet).toFixed(3)})`;
            ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
          }
          // Eastward-style tile textures.
          if (tile === Tile.Grass) drawGrassTexture(ctx, sx, sy, x, y);
          else if (tile === Tile.Forest) drawForestTexture(ctx, sx, sy, x, y);
          else if (tile === Tile.Sand) drawSandTexture(ctx, sx, sy, x, y);
          else if (tile === Tile.Road) drawRoadTexture(ctx, sx, sy, x, y);
          else if (tile === Tile.Rock || tile === Tile.Hill) drawRockTexture(ctx, sx, sy, x, y, tile);
        }
      }
    }
  }

  // Wall-face terrain rendering — Stardew Valley technique: after all base tiles
  // are drawn, paint a solid cliff face below each elevated tile, topped with a
  // rim highlight and fading into a gradient shadow. Gives real 3-D depth to
  // Hill/Rock edges without needing an isometric projection.
  private drawTerrainWalls() {
    const map = this.map!;
    const ctx = this.ctx;
    const startX = Math.max(0, Math.floor(this.cam.x / TILE_SIZE));
    const startY = Math.max(0, Math.floor(this.cam.y / TILE_SIZE));
    const endX = Math.min(map.width - 1, Math.ceil((this.cam.x + this.canvas.width) / TILE_SIZE));
    const endY = Math.min(map.height - 2, Math.ceil((this.cam.y + this.canvas.height) / TILE_SIZE));

    const isElevated = (t: Tile) => t === Tile.Hill || t === Tile.Rock || t === Tile.Forest;

    ctx.save();
    for (let y = startY; y <= endY; y++) {
      for (let x = startX; x <= endX; x++) {
        const tile = map.tiles[y * map.width + x] as Tile;
        if (!isElevated(tile)) continue;
        const { sx, sy } = this.toScreen(x, y);

        // South face — where terrain drops below this tile.
        const belowTile = map.tiles[(y + 1) * map.width + x] as Tile;
        if (!isElevated(belowTile)) {
          const faceH = tile === Tile.Rock ? 11 : tile === Tile.Forest ? 7 : 6;
          const faceColor  = tile === Tile.Rock ? "#38322c" : tile === Tile.Forest ? "#243820" : "#7a5c38";
          const rimColor   = tile === Tile.Rock ? "#58524c" : tile === Tile.Forest ? "#3d5a38" : "#a07848";
          const shadowAlpha = tile === Tile.Rock ? 0.6 : 0.42;

          // Bright rim — top edge of cliff face catches the sun.
          ctx.fillStyle = rimColor;
          ctx.fillRect(sx, sy + TILE_SIZE - 1, TILE_SIZE, 2);

          // Solid cliff face.
          ctx.fillStyle = faceColor;
          ctx.fillRect(sx, sy + TILE_SIZE + 1, TILE_SIZE, faceH);

          // Gradient shadow below the face — contact shadow blends into ground.
          const shadowH = 10;
          const grd = ctx.createLinearGradient(sx, sy + TILE_SIZE + faceH, sx, sy + TILE_SIZE + faceH + shadowH);
          grd.addColorStop(0, `rgba(0,0,0,${shadowAlpha})`);
          grd.addColorStop(1, "rgba(0,0,0,0)");
          ctx.fillStyle = grd;
          ctx.fillRect(sx, sy + TILE_SIZE + faceH, TILE_SIZE, shadowH);
        }

        // East lateral face — cliff drops to the right.
        if (x + 1 <= endX) {
          const rightTile = map.tiles[y * map.width + x + 1] as Tile;
          if (!isElevated(rightTile)) {
            const grd = ctx.createLinearGradient(sx + TILE_SIZE, sy, sx + TILE_SIZE + 6, sy);
            grd.addColorStop(0, "rgba(0,0,0,0.35)");
            grd.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = grd;
            ctx.fillRect(sx + TILE_SIZE, sy, 6, TILE_SIZE);
          }
        }
      }
    }
    ctx.restore();
  }

  // Kelp bed overlay — drawn on ankle-depth water tiles after tiles but before
  // creatures/players, using deterministic per-tile randomness so the fronds
  // stay still relative to the map (only the gentle wave is animated).
  private drawKelpBeds() {
    const map = this.map!;
    const snap = this.snap!;
    const ctx = this.ctx;
    const startX = Math.max(0, Math.floor(this.cam.x / TILE_SIZE));
    const startY = Math.max(0, Math.floor(this.cam.y / TILE_SIZE));
    const endX = Math.min(map.width, startX + Math.ceil(this.canvas.width / TILE_SIZE) + 1);
    const endY = Math.min(map.height, startY + Math.ceil(this.canvas.height / TILE_SIZE) + 1);
    const now = Date.now();

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const i = y * map.width + x;
        const depth = snap.waterline - map.elevation[i];
        if (depth <= 0 || depth > DEPTH_ANKLE + 3) continue;

        // Deterministic hash for this tile.
        const h = Math.abs(((x * 374761393 + y * 1160490541) ^ (x * 13 ^ y * 7)) | 0);
        if (h % 100 >= 38) continue; // ~38 % of ankle-deep tiles get kelp

        const { sx, sy } = this.toScreen(x, y);
        const fronds = 2 + (h % 3);

        for (let f = 0; f < fronds; f++) {
          const hf = Math.abs((h * (f + 3) * 137) | 0);
          const fx = sx + 3 + (hf % (TILE_SIZE - 6));
          const fy = sy + 3 + ((hf >> 4) % (TILE_SIZE - 6));
          const wave = Math.sin(now / 1800 + f * 1.1 + x * 0.4 + y * 0.3) * 2.5;

          // Stalk
          ctx.strokeStyle = "rgba(55,85,28,0.75)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(fx, fy + 5);
          ctx.quadraticCurveTo(fx + wave * 0.5, fy + 2, fx + wave, fy - 4);
          ctx.stroke();

          // Blade
          ctx.save();
          ctx.translate(fx + wave, fy - 4);
          ctx.rotate(wave * 0.2 + f * 0.7);
          ctx.fillStyle = "rgba(42,75,22,0.62)";
          ctx.beginPath();
          ctx.ellipse(0, -2.5, 2, 5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    }
  }


  private drawTravelNodes() {
    const ctx = this.ctx;
    for (const n of this.travelNodes) {
      const { sx, sy } = this.toScreen(n.x, n.y);
      const w = n.w * TILE_SIZE;
      const h = n.h * TILE_SIZE;
      ctx.fillStyle = TRAVEL_COLOR[n.kind];
      ctx.globalAlpha = n.kind === "sea" ? 0.16 : 0.55; // sea border is a big subtle zone
      ctx.fillRect(sx, sy, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#f1f1f1";
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(sx, sy, w, h);
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      ctx.font = "12px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(TRAVEL_ICON[n.kind], sx + w / 2, sy + h / 2 + 4);
    }
  }

  private nodeUnder(me?: PlayerState): TravelNode | undefined {
    if (!me) return undefined;
    return this.travelNodes.find(
      (n) =>
        me.x >= n.x - 0.6 &&
        me.x <= n.x + n.w + 0.6 &&
        me.y >= n.y - 0.6 &&
        me.y <= n.y + n.h + 0.6,
    );
  }

  private drawTravelPrompt(me?: PlayerState) {
    const node = this.nodeUnder(me);
    if (!node) return;
    const ctx = this.ctx;
    const text = `Press T — ${node.label}`;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 70;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = "#1e88e5";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(text, x, y);
  }

  // One oblique building: a wall facade with a pitched, overhanging roof so it
  // reads as a structure standing up off the ground (Eastward/Stardew style).
  private drawBuilding(b: BuildingState) {
    const ctx = this.ctx;
    const { sx, sy } = this.toScreen(b.x, b.y);
    const w = b.w * TILE_SIZE;
    const h = b.h * TILE_SIZE;

    if (b.kind === "rubble") {
      ctx.fillStyle = "#4a4038";
      ctx.fillRect(sx, sy, w, h);
      ctx.fillStyle = "#5e5347";
      for (let i = 0; i < 5; i++) ctx.fillRect(sx + ((i * 7) % w), sy + ((i * 11) % h), 4, 4);
      return;
    }

    if (b.kind === "dock") {
      // Flat wooden deck — planks running across, no roof.
      ctx.fillStyle = "#7a5a36";
      ctx.fillRect(sx, sy, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      for (let px = sx; px < sx + w; px += 6) {
        ctx.beginPath(); ctx.moveTo(px, sy); ctx.lineTo(px, sy + h); ctx.stroke();
      }
      return;
    }

    const wall = buildingColor(b.kind);
    const dark = (hex: string, f: number) => {
      const n = parseInt(hex.slice(1), 16);
      return `rgb(${(((n >> 16) & 255) * f) | 0},${(((n >> 8) & 255) * f) | 0},${((n & 255) * f) | 0})`;
    };
    const roofH = Math.min(TILE_SIZE * 1.6, h * 0.6 + 12);
    const eave = 3;

    // Ground shadow cast to the SE.
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(sx + w / 2 + 4, sy + h, w * 0.55, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- Wall facade ---
    ctx.fillStyle = wall;
    ctx.fillRect(sx, sy, w, h);
    // Horizontal siding lines.
    ctx.strokeStyle = dark(wall, 0.82);
    ctx.lineWidth = 1;
    for (let ly = sy + 5; ly < sy + h - 2; ly += 5) {
      ctx.beginPath(); ctx.moveTo(sx, ly); ctx.lineTo(sx + w, ly); ctx.stroke();
    }
    // Right-side shading for form.
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.fillRect(sx + w * 0.72, sy, w * 0.28, h);

    // --- Windows (warm lit) ---
    const winCols = Math.max(1, Math.floor(b.w));
    const winY = sy + h * 0.42;
    const winW = 6, winH = 6;
    ctx.fillStyle = "#ffd98a";
    for (let c = 0; c < winCols; c++) {
      const cxw = sx + (c + 0.5) * (w / winCols) - winW / 2;
      if (Math.abs(cxw + winW / 2 - (sx + w / 2)) < 7) continue; // leave room for the door
      ctx.fillRect(cxw, winY, winW, winH);
      ctx.strokeStyle = dark(wall, 0.5);
      ctx.strokeRect(cxw, winY, winW, winH);
    }

    // --- Door ---
    ctx.fillStyle = "#2c2018";
    ctx.fillRect(sx + w / 2 - 4, sy + h - 11, 8, 11);
    ctx.fillStyle = "#c9a24b"; // knob
    ctx.fillRect(sx + w / 2 + 1, sy + h - 6, 1.5, 1.5);

    // --- Pitched roof, overhanging the walls ---
    const roofCol = ROOF_COLORS[b.kind] ?? "#6b4a39";
    const ridgeInset = Math.min(w * 0.28, 14);
    const roofTop = sy - roofH;
    ctx.fillStyle = roofCol;
    ctx.beginPath();
    ctx.moveTo(sx - eave, sy + 2);
    ctx.lineTo(sx + w + eave, sy + 2);
    ctx.lineTo(sx + w - ridgeInset, roofTop);
    ctx.lineTo(sx + ridgeInset, roofTop);
    ctx.closePath();
    ctx.fill();
    // Eave shadow under the overhang.
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(sx - eave, sy + 1, w + eave * 2, 2);
    // Ridge highlight.
    ctx.strokeStyle = dark(roofCol, 1.25);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx + ridgeInset, roofTop + 1);
    ctx.lineTo(sx + w - ridgeInset, roofTop + 1);
    ctx.stroke();

    // Name plaque — real OSM name when we have one, else only label the
    // tradeable/landmark kinds. Plain houses stay unlabelled to cut clutter.
    const label = b.name ?? (b.shop ? buildingLabel(b.kind) : "");
    if (label) {
      ctx.font = "9px system-ui";
      ctx.textAlign = "center";
      const tw = ctx.measureText(label).width;
      const px = sx + w / 2, py = roofTop - 4;
      ctx.fillStyle = "rgba(10,16,22,0.8)";          // sign board
      roundRect(ctx, px - tw / 2 - 4, py - 11, tw + 8, 13, 3);
      ctx.fill();
      ctx.fillStyle = "#ffe9b0";
      ctx.fillText(label, px, py - 1);
    }

    // HP bar (only when damaged) — sits above the name plaque.
    const frac = Math.max(0, b.hp / b.maxHp);
    if (frac < 1) {
      const hy = roofTop - (label ? 22 : 6);
      ctx.fillStyle = "#222";
      ctx.fillRect(sx, hy, w, 4);
      ctx.fillStyle = frac > 0.5 ? "#4caf50" : frac > 0.25 ? "#ffb300" : "#e53935";
      ctx.fillRect(sx, hy, w * frac, 4);
    }
  }

  private vehicleNear(me?: PlayerState): VehicleState | undefined {
    if (!me || !this.snap) return undefined;
    let best: VehicleState | undefined;
    let bestD = 1.6;
    for (const v of this.snap.vehicles) {
      if (v.driverId) continue;
      const d = Math.hypot(v.x - me.x, v.y - me.y);
      if (d <= bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  private drawBoardPrompt(me?: PlayerState) {
    if (!me) return;
    let text: string | null = null;
    if (me.vehicleId) {
      text = "Press F — step out";
    } else {
      const v = this.vehicleNear(me);
      if (v) text = `Press F — board the ${v.kind}`;
    }
    if (!text) return;
    const ctx = this.ctx;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 108;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = "#00acc1";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(text, x, y);
  }

  private drawPlants(plants: PlantState[]) {
    for (const pl of plants) {
      if (this.clientDepthAt(pl.x, pl.y) > 0) continue; // don't render submerged plants
      const { sx, sy } = this.toScreen(pl.x + 0.5, pl.y + 0.5);
      drawPlantSprite(this.ctx, pl, sx, sy);
    }
  }

  private drawCampfires(fires: CampfireState[]) {
    for (const f of fires) {
      const { sx, sy } = this.toScreen(f.x + 0.5, f.y + 0.5);
      drawCampfireSprite(this.ctx, sx, sy);
    }
  }

  private drawFurnaces(furnaces: FurnaceState[]) {
    for (const f of furnaces) {
      const { sx, sy } = this.toScreen(f.x + 0.5, f.y + 0.5);
      drawFurnaceSprite(this.ctx, sx, sy);
    }
  }

  private drawCraftPanel(me?: PlayerState) {
    const ctx = this.ctx;
    const PW = 310;
    const lineH = 40;
    const PH = 60 + CRAFT_RECIPES.length * lineH;
    const px = this.canvas.width / 2 - PW / 2;
    const py = this.canvas.height / 2 - PH / 2;

    // Background
    ctx.fillStyle = "rgba(5,15,24,0.95)";
    roundRect(ctx, px, py, PW, PH, 10);
    ctx.fill();
    ctx.strokeStyle = "#1e88e5";
    ctx.lineWidth = 1.5;
    roundRect(ctx, px, py, PW, PH, 10);
    ctx.stroke();

    ctx.fillStyle = "#b8d4e3";
    ctx.font = "bold 14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("CRAFTING  [C] close  [1-5] select", px + PW / 2, py + 22);
    ctx.fillStyle = "#456a80";
    ctx.fillRect(px + 10, py + 30, PW - 20, 1);

    for (let i = 0; i < CRAFT_RECIPES.length; i++) {
      const r = CRAFT_RECIPES[i];
      const ry = py + 44 + i * lineH;
      const canAfford = me
        ? Object.entries(r.needs).every(([item, qty]) => (me.inventory[item as ItemId] ?? 0) >= (qty as number))
        : false;
      const selected = i === this.craftSelected;

      if (selected) {
        ctx.fillStyle = "rgba(30,136,229,0.22)";
        ctx.fillRect(px + 6, ry - 2, PW - 12, lineH - 4);
      }
      ctx.fillStyle = canAfford ? "#eaf2f8" : "#4a6278";
      ctx.font = `bold 13px system-ui`;
      ctx.textAlign = "left";
      ctx.fillText(`[${i + 1}] ${r.name}`, px + 16, ry + 14);

      // Ingredients
      const needsStr = Object.entries(r.needs)
        .map(([item, qty]) => {
          const have = me?.inventory[item as ItemId] ?? 0;
          const col = have >= (qty as number) ? "#7ec8a0" : "#e57373";
          return `<${col}>${qty} ${ITEM_LABEL[item as ItemId]}</${col}>`;
        })
        .join("  ");
      // Plain text fallback (canvas can't render HTML, so we do it manually)
      let nx = px + 16;
      const ny = ry + 30;
      ctx.font = "11px system-ui";
      for (const [item, qty] of Object.entries(r.needs) as [ItemId, number][]) {
        const have = me?.inventory[item] ?? 0;
        ctx.fillStyle = have >= qty ? "#7ec8a0" : "#e57373";
        const txt = `${qty} ${ITEM_LABEL[item]}  `;
        ctx.textAlign = "left";
        ctx.fillText(txt, nx, ny);
        nx += ctx.measureText(txt).width;
      }
      if (Object.keys(r.gives).length > 0) {
        ctx.fillStyle = "#5a7a8a";
        ctx.fillText("→", nx, ny);
        nx += ctx.measureText("→ ").width;
        for (const [item, qty] of Object.entries(r.gives) as [ItemId, number][]) {
          ctx.fillStyle = "#a0c8e0";
          ctx.fillText(`${qty} ${ITEM_LABEL[item]}`, nx, ny);
        }
      }
      void needsStr; // suppress unused
    }
  }

  // Full-region map overlay — press M to open/close.
  private drawMapOverlay(me?: PlayerState) {
    if (!this.map || !this.overview) return;
    const ctx = this.ctx;
    const ov = this.overview;

    // Scale the downsampled overview to fit inside ~82% of the screen.
    const maxW = Math.floor(this.canvas.width  * 0.82);
    const maxH = Math.floor(this.canvas.height * 0.82);
    const cell = Math.max(1, Math.min(maxW / ov.width, maxH / ov.height)); // px per overview cell
    const scale = cell / ov.scale;  // px per real tile (for entity placement)
    const pw = ov.width * cell;
    const ph = ov.height * cell;
    const ox = Math.floor((this.canvas.width  - pw) / 2); // top-left corner
    const oy = Math.floor((this.canvas.height - ph) / 2);

    // Dim background.
    ctx.fillStyle = "rgba(5,15,25,0.88)";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw the downsampled overview tiles.
    for (let y = 0; y < ov.height; y++) {
      for (let x = 0; x < ov.width; x++) {
        const tile = ov.tiles[y * ov.width + x] as Tile;
        ctx.fillStyle = TILE_COLORS[tile] ?? "#333";
        ctx.fillRect(ox + x * cell, oy + y * cell, Math.ceil(cell), Math.ceil(cell));
      }
    }

    // Buildings — small white squares.
    if (this.snap) {
      ctx.fillStyle = "#e0d8c8";
      for (const b of this.snap.buildings) {
        ctx.fillRect(ox + b.x * scale, oy + b.y * scale,
          Math.max(scale, b.w * scale), Math.max(scale, b.h * scale));
      }

      // Travel nodes — coloured marks.
      for (const n of this.travelNodes) {
        ctx.fillStyle = n.kind === "sea" ? "#00bcd4" : n.kind === "bus" ? "#ff9800" : "#8bc34a";
        ctx.fillRect(ox + n.x * scale - 1, oy + n.y * scale - 1, n.w * scale + 2, Math.max(2, n.h * scale + 2));
      }

      // Other players — cyan dots.
      ctx.fillStyle = "#00e5ff";
      for (const p of this.snap.players) {
        if (p.id === this.myId) continue;
        ctx.fillRect(ox + Math.round(p.x) * scale - 1, oy + Math.round(p.y) * scale - 1, scale + 2, scale + 2);
      }
    }

    // Player position — bright white cross.
    if (me) {
      const px = ox + Math.round(me.x) * scale;
      const py = oy + Math.round(me.y) * scale;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(px - 1, py - scale, 3, scale * 3);
      ctx.fillRect(px - scale, py - 1, scale * 3, 3);
    }

    // Border.
    ctx.strokeStyle = "#00acc1";
    ctx.lineWidth = 2;
    ctx.strokeRect(ox - 1, oy - 1, pw + 2, ph + 2);

    // Title and hint.
    ctx.font = "bold 16px system-ui";
    ctx.textAlign = "center";
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(this.regionName, this.canvas.width / 2, oy - 10);

    // Legend strip below map.
    const legendY = oy + ph + 18;
    ctx.font = "12px system-ui";
    ctx.fillStyle = "#aabbcc";
    ctx.fillText("■ You   ■ Buildings   ■ Bus stop   ■ Sea route   ■ Gate   — Press M or Esc to close", this.canvas.width / 2, legendY);
  }

  // --- shops ----------------------------------------------------------------
  private nearbyShop(): BuildingState | undefined {
    if (!this.snap) return undefined;
    const me = this.snap.players.find((p) => p.id === this.myId);
    if (!me) return undefined;
    let best: BuildingState | undefined;
    let bestD = 3.0;
    for (const b of this.snap.buildings) {
      if (!b.shop) continue;
      const d = Math.hypot(b.x + b.w / 2 - me.x, b.y + b.h / 2 - me.y);
      if (d <= bestD) { bestD = d; best = b; }
    }
    return best;
  }

  private openShop(): BuildingState | undefined {
    if (!this.shopId || !this.snap) return undefined;
    return this.snap.buildings.find((b) => b.id === this.shopId);
  }

  // The numbered lines in the shop panel: SELL lines first, then BUY lines.
  private shopLines(shop: ShopDef): Array<{ kind: "sell" | "buy"; item: ItemId; price: number }> {
    return [
      ...shop.buys.map((o) => ({ kind: "sell" as const, item: o.item, price: o.price })),
      ...shop.sells.map((o) => ({ kind: "buy" as const, item: o.item, price: o.price })),
    ];
  }

  private tradeLine(idx: number) {
    const b = this.openShop();
    if (!b || !b.shop) return;
    const lines = this.shopLines(b.shop);
    const line = lines[idx];
    if (!line) return;
    this.net.send({ t: "trade", buildingId: b.id, kind: line.kind, item: line.item, qty: 1 });
  }

  private drawShopPrompt(me?: PlayerState) {
    if (!me || me.vehicleId || this.shopId) return;
    const shop = this.nearbyShop();
    if (!shop || !shop.shop) return;
    const ctx = this.ctx;
    const text = `Press B — trade at ${shop.shop.name}`;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 146;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = "#ffb300";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#ffe9b0";
    ctx.fillText(text, x, y);
  }

  private drawShopPanel(me?: PlayerState) {
    const b = this.openShop();
    if (!b || !b.shop) { this.shopId = null; return; }
    const ctx = this.ctx;
    const lines = this.shopLines(b.shop);
    const inv = me?.inventory ?? {};

    const pw = 380;
    const ph = 90 + lines.length * 26 + 30;
    const px = this.canvas.width / 2 - pw / 2;
    const py = this.canvas.height / 2 - ph / 2;

    ctx.fillStyle = "rgba(7,19,28,0.94)";
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 2;
    ctx.strokeRect(px, py, pw, ph);

    ctx.textAlign = "left";
    ctx.font = "bold 17px system-ui";
    ctx.fillStyle = "#ffe9b0";
    ctx.fillText(b.shop.name, px + 18, py + 30);

    ctx.font = "14px system-ui";
    ctx.fillStyle = "#9fe6c0";
    ctx.textAlign = "right";
    ctx.fillText(`Your money: $${me?.money ?? 0}`, px + pw - 18, py + 30);
    ctx.textAlign = "left";

    let y = py + 60;
    let lastKind = "";
    lines.forEach((ln, i) => {
      if (ln.kind !== lastKind) {
        ctx.font = "bold 13px system-ui";
        ctx.fillStyle = "#7fa8c8";
        ctx.fillText(ln.kind === "sell" ? "SELL — they buy from you:" : "BUY — they sell to you:", px + 18, y);
        y += 22;
        lastKind = ln.kind;
      }
      ctx.font = "15px system-ui";
      ctx.fillStyle = "#eaf2f8";
      const label = ITEM_LABEL[ln.item];
      const held = inv[ln.item] ?? 0;
      const extra = ln.kind === "sell" ? `  (you have ${held})` : "";
      ctx.fillText(`${i + 1}.  ${label}`, px + 28, y);
      ctx.textAlign = "right";
      ctx.fillStyle = ln.kind === "sell" ? "#9fe6c0" : "#ffd08a";
      ctx.fillText(`$${ln.price} ea${extra}`, px + pw - 18, y);
      ctx.textAlign = "left";
      y += 26;
    });

    ctx.font = "13px system-ui";
    ctx.fillStyle = "#7fa8c8";
    ctx.fillText("Press a number to trade 1 • B or Esc to close", px + 18, py + ph - 16);
  }

  // --- inventory bag --------------------------------------------------------
  private drawInventoryPanel(me?: PlayerState) {
    const ctx = this.ctx;
    const cols = 4;
    const cellW = 84, cellH = 64;
    const pad = 18;
    const pw = cols * cellW + pad * 2;
    const items = me
      ? (ITEM_IDS as readonly ItemId[]).filter((id) => (me.inventory[id] ?? 0) > 0)
      : [];
    const rows = Math.max(1, Math.ceil(items.length / cols));
    const ph = 56 + rows * cellH + 40;
    const px = this.canvas.width / 2 - pw / 2;
    const py = this.canvas.height / 2 - ph / 2;

    ctx.fillStyle = "rgba(7,19,28,0.95)";
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.fill();
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 2;
    roundRect(ctx, px, py, pw, ph, 10);
    ctx.stroke();

    ctx.fillStyle = "#ffe9b0";
    ctx.font = "bold 16px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("INVENTORY", px + pad, py + 30);
    ctx.fillStyle = "#7fa8c8";
    ctx.font = "13px system-ui";
    ctx.textAlign = "right";
    ctx.fillText("[I] or Esc to close", px + pw - pad, py + 30);

    if (items.length === 0) {
      ctx.fillStyle = "#5a7f96";
      ctx.font = "14px system-ui";
      ctx.textAlign = "center";
      ctx.fillText("Your bag is empty — go gather, hunt, or fish.", px + pw / 2, py + ph / 2);
    }

    items.forEach((id, i) => {
      const cx = px + pad + (i % cols) * cellW;
      const cy = py + 48 + Math.floor(i / cols) * cellH;
      // Item swatch
      ctx.fillStyle = ITEM_COLORS[id] ?? "#888";
      roundRect(ctx, cx + 6, cy + 6, cellW - 18, 30, 5);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 1;
      roundRect(ctx, cx + 6, cy + 6, cellW - 18, 30, 5);
      ctx.stroke();
      // Quantity badge
      ctx.fillStyle = "#0b1d2a";
      ctx.font = "bold 14px system-ui";
      ctx.textAlign = "right";
      ctx.fillText(`×${me!.inventory[id] ?? 0}`, cx + cellW - 16, cy + 26);
      // Label
      ctx.fillStyle = "#cfe3ef";
      ctx.font = "11px system-ui";
      ctx.textAlign = "left";
      ctx.fillText(ITEM_LABEL[id], cx + 6, cy + 50);
    });

    ctx.fillStyle = "#9fe6c0";
    ctx.font = "13px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(`Money: $${me?.money ?? 0}`, px + pad, py + ph - 16);
    ctx.textAlign = "right";
    ctx.fillStyle = me && me.hunger < me.maxHunger * 0.25 ? "#e57373" : "#cfe3ef";
    ctx.fillText(`Hunger: ${Math.round(me?.hunger ?? 0)}/${me?.maxHunger ?? 100}`, px + pw - pad, py + ph - 16);
  }

  // --- NPCs -----------------------------------------------------------------
  private nearbyNpc(): NpcState | undefined {
    if (!this.snap) return undefined;
    const me = this.snap.players.find((p) => p.id === this.myId);
    if (!me) return undefined;
    let best: NpcState | undefined;
    let bestD = 1.8;
    for (const n of this.snap.npcs ?? []) {
      const d = Math.hypot(n.x + 0.5 - me.x, n.y + 0.5 - me.y);
      if (d <= bestD) { bestD = d; best = n; }
    }
    return best;
  }

  private drawNpc(n: NpcState, me?: PlayerState) {
    const ctx = this.ctx;
    const { sx, sy } = this.toScreen(n.x + 0.5, n.y + 0.5);
    const R = TILE_SIZE * 0.4;
    // Face toward the nearby player so locals "notice" you; else face down.
    let facing: Facing = "down";
    if (me) {
      const dx = me.x - (n.x + 0.5), dy = me.y - (n.y + 0.5);
      if (Math.hypot(dx, dy) < 4) facing = facingFromDir(Math.atan2(dy, dx));
    }
    const gait = this.gaitFor("npc-" + n.id, n.x, n.y);

    // Per-kind distinctive appearance.
    const npcAppearance = (() => {
      switch (n.kind) {
        case "seamstress":      return { skin: "#c88040", hair: "#8b2252", shirt: "#d946a8" };
        case "researcher2":     return { skin: "#d4b896", hair: "#bfa060", shirt: "#7b3fa0" };
        case "marineBiologist": return { skin: "#b8d4e0", hair: "#2a5a80", shirt: "#0d47a1" };
        case "snorkeler":       return { skin: "#c0d8d0", hair: "#1a3a2a", shirt: "#00838f" };
        default: return { skin: "#e0ac69", hair: "#3a2a18", shirt: NPC_COLORS[n.kind] ?? "#607d8b" };
      }
    })();

    drawCharacter(ctx, sx, sy, npcAppearance, { facing, phase: gait.phase, moving: gait.moving });

    // Role label
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "10px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(NPC_NAME[n.kind] ?? "Local", sx, sy - TILE_SIZE * 1.15);
    // "talk" bubble when you're close
    const close = me && Math.hypot(n.x + 0.5 - me.x, n.y + 0.5 - me.y) <= 1.8;
    if (close) {
      ctx.fillStyle = "#fff3cf";
      ctx.beginPath();
      ctx.arc(sx + R, sy - TILE_SIZE * 1.0, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#15384f";
      ctx.font = "bold 10px system-ui";
      ctx.fillText("?", sx + R, sy - TILE_SIZE * 1.0 + 3.5);
    }
  }

  private drawNpcPrompt(me?: PlayerState) {
    if (!me || me.vehicleId || this.npcOpen) return;
    const npc = this.nearbyNpc();
    if (!npc) return;
    const ctx = this.ctx;
    const text = `Press E or N — talk to ${NPC_NAME[npc.kind] ?? "the local"}`;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 146;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = "#ce93d8";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#f3e5f5";
    ctx.fillText(text, x, y);
  }

  private drawNpcDialogue(_me?: PlayerState) {
    if (!this.snap || !this.npcOpen) return;
    const npc = (this.snap.npcs ?? []).find((n) => n.id === this.npcOpen);
    if (!npc) { this.npcOpen = null; return; }
    const lines = NPC_DIALOGUE[npc.kind] ?? ["…"];
    // Rotate the line every 30s so repeat visits feel alive (deterministic).
    const idx = Math.floor(Date.now() / 30000) % lines.length;
    const text = lines[idx];

    const ctx = this.ctx;
    const pw = 440, ph = 170;
    const px = this.canvas.width / 2 - pw / 2;
    const py = this.canvas.height - ph - 90;

    ctx.fillStyle = "rgba(10,22,34,0.96)";
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fill();
    ctx.strokeStyle = NPC_COLORS[npc.kind] ?? "#ce93d8";
    ctx.lineWidth = 2;
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.stroke();

    ctx.fillStyle = NPC_COLORS[npc.kind] ?? "#ce93d8";
    ctx.font = "bold 17px system-ui";
    ctx.textAlign = "left";
    ctx.fillText(NPC_NAME[npc.kind] ?? "Local", px + 20, py + 30);

    // Word-wrapped body.
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "15px system-ui";
    this.wrapText(text, px + 20, py + 60, pw - 40, 22);

    ctx.fillStyle = "#7fa8c8";
    ctx.font = "13px system-ui";
    ctx.fillText("Press E, N, or Esc to close", px + 20, py + ph - 16);
  }

  // Simple canvas word-wrap helper.
  private wrapText(text: string, x: number, y: number, maxW: number, lineH: number) {
    const ctx = this.ctx;
    const words = text.split(" ");
    let line = "";
    let cy = y;
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, cy);
        line = w;
        cy += lineH;
      } else {
        line = test;
      }
    }
    if (line) ctx.fillText(line, x, cy);
  }

  // --- refuel prompt --------------------------------------------------------
  private drawRefuelPrompt(me?: PlayerState) {
    if (!me || me.vehicleId || !this.snap) return;
    const cans = me.inventory.jerryCan ?? 0;
    if (cans <= 0) return;
    let target: VehicleState | undefined;
    let bestD = 1.6;
    for (const v of this.snap.vehicles) {
      if (v.fuel >= v.maxFuel) continue;
      const d = Math.hypot(v.x - me.x, v.y - me.y);
      if (d <= bestD) { bestD = d; target = v; }
    }
    if (!target) return;
    const ctx = this.ctx;
    const text = `Press E — refuel the ${target.kind} (⛽ ${Math.round(target.fuel)}/${target.maxFuel})`;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 184;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = "#ff9800";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#ffd9a0";
    ctx.fillText(text, x, y);
  }

  private drawFishPrompt(me?: PlayerState) {
    if (!me || !this.snap) return;
    const nearWater = me.swimming || (() => {
      // Check if any adjacent tile in the snap is under water (approximate).
      return this.snap!.waterline > 5; // roughly "tidal area" — just use swimming flag
    })();
    if (!nearWater && !me.fishing) return;

    if (me.fishing) {
      // Show "fishing…" status.
      const ctx = this.ctx;
      const text = "Fishing… (G to cancel)";
      ctx.font = "15px system-ui";
      ctx.textAlign = "center";
      const w = ctx.measureText(text).width + 28;
      const x = this.canvas.width / 2;
      const y = this.canvas.height / 2 + 80;
      ctx.fillStyle = "rgba(7,19,28,0.85)";
      ctx.fillRect(x - w / 2, y - 22, w, 32);
      ctx.strokeStyle = "#00acc1";
      ctx.strokeRect(x - w / 2, y - 22, w, 32);
      ctx.fillStyle = "#eaf2f8";
      ctx.fillText(text, x, y);
      return;
    }
    if (!me.swimming) return; // only prompt when in/near water
    const ctx = this.ctx;
    const hasRod = (me.inventory.rod ?? 0) > 0;
    const text = hasRod ? "G — cast fishing line" : "G — fish (need a rod)";
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(text).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 184;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = hasRod ? "#00bcd4" : "#607d8b";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(text, x, y);
  }

  private drawHarvestPrompt(nodes: ResourceNode[], plants: PlantState[], me?: PlayerState) {
    if (!me) return;
    const range = HARVEST_RANGE_PX;
    let label: string | null = null;
    let color = "#4caf50";

    // Nearest resource node within reach.
    let bestD = Infinity;
    for (const n of nodes) {
      if (n.depleted) continue;
      const d = Math.hypot((n.x + 0.5 - me.x) * TILE_SIZE, (n.y + 0.5 - me.y) * TILE_SIZE);
      if (d <= range && d < bestD) {
        bestD = d;
        if (n.kind === "tree") { label = "Chop tree (E)"; color = "#4caf50"; }
        else if (n.kind === "ironOre") { label = "Mine iron (E)"; color = "#ff9800"; }
        else if (n.kind === "stoneOre") { label = "Mine stone (E)"; color = "#ff9800"; }
        else { label = `Pick ${n.variety ?? "berries"} (E)`; color = "#c2185b"; }
      }
    }
    // Invasive plant takes priority if closer.
    for (const pl of plants) {
      const d = Math.hypot((pl.x + 0.5 - me.x) * TILE_SIZE, (pl.y + 0.5 - me.y) * TILE_SIZE);
      if (d <= range && d < bestD) {
        bestD = d;
        const flowering = pl.stage === "flowering";
        label = flowering
          ? `Pull flowering ${INVASIVE_LABEL[pl.kind]} — KILL it! (E)`
          : `Cut ${INVASIVE_LABEL[pl.kind]} (E) — wait for flower to kill`;
        color = flowering ? "#ffd54f" : "#9c6f3a";
      }
    }
    if (!label) return;

    const ctx = this.ctx;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(label).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 146;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = color;
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(label, x, y);
  }

  private clientDepthAt(wx: number, wy: number): number {
    if (!this.map || !this.snap) return 0;
    const tx = Math.floor(wx), ty = Math.floor(wy);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return 0;
    return Math.max(0, this.snap.waterline - this.map.elevation[ty * this.map.width + tx]);
  }

  // Marine creatures live on/under the water surface — drawn beneath the
  // upright (Y-sorted) layer so a dorsal fin never floats over a dock or boat.
  private drawMarineCreatures(creatures: CreatureState[], me?: PlayerState) {
    for (const c of creatures) {
      if (!MARINE_KINDS.has(c.kind)) continue;
      const { sx, sy } = this.toScreen(c.x, c.y);
      const depth = this.clientDepthAt(c.x, c.y);
      const dist = me ? Math.hypot(c.x - me.x, c.y - me.y) : 999;
      drawCreatureSprite(this.ctx, c.kind, sx, sy, depth, dist);
    }
  }

  private drawLandCreature(c: CreatureState, me?: PlayerState) {
    const { sx, sy } = this.toScreen(c.x, c.y);
    const depth = this.clientDepthAt(c.x, c.y);
    const dist = me ? Math.hypot(c.x - me.x, c.y - me.y) : 999;
    drawCreatureSprite(this.ctx, c.kind, sx, sy, depth, dist);
  }

  // Track whether an entity is moving and advance its walk-cycle phase. Returns
  // the current phase (radians) and a moving flag for the oblique leg stride.
  private gaitFor(id: string, x: number, y: number): { phase: number; moving: boolean; running: boolean; speed: number } {
    const dt = 1 / 60;
    let g = this.gait.get(id);
    if (!g) { g = { x, y, phase: 0, moving: 0, speed: 0 }; this.gait.set(id, g); }
    const moved = Math.hypot(x - g.x, y - g.y);
    // Instantaneous tiles/sec, smoothed so it doesn't jitter between snapshots.
    const instSpeed = moved / dt;
    g.speed += (instSpeed - g.speed) * 0.2;
    const target = moved > 0.002 ? 1 : 0;
    g.moving += (target - g.moving) * 0.25;
    // Stride tempo scales with actual ground speed — a run cycles the legs faster.
    if (g.moving > 0.05) g.phase += dt * (5 + Math.min(g.speed, 10) * 0.95);
    g.x = x; g.y = y;
    // Walk speed ~4.5 tiles/s; sprint pushes well past 6.
    return { phase: g.phase, moving: g.moving > 0.15, running: g.speed > 6, speed: g.speed };
  }

  private drawPlayer(p: PlayerState, isMe: boolean) {
    const ctx = this.ctx;
    const { sx, sy } = this.toScreen(p.x, p.y);
    const R = TILE_SIZE * 0.4;

    // While driving, the vehicle sprite represents you — just float your name.
    if (p.vehicleId) {
      ctx.fillStyle = "#eaf2f8";
      ctx.font = "11px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.95);
      return;
    }

    if (p.dead) ctx.globalAlpha = 0.3;

    // Fishing rod line cast toward the water.
    if (p.fishing) {
      const rodLen = TILE_SIZE * 2.2;
      ctx.strokeStyle = "rgba(200,220,240,0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      const floatX = sx + Math.cos(p.dir) * rodLen;
      const floatY = sy + Math.sin(p.dir) * rodLen;
      ctx.lineTo(floatX, floatY);
      ctx.stroke();
      ctx.setLineDash([]);
      // Float bob
      ctx.fillStyle = "#ff6b6b";
      ctx.beginPath();
      ctx.arc(floatX, floatY + Math.sin(performance.now() / 400) * 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // A motion streak behind a dodging player (i-frames active).
    if (p.dodging) {
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = R * 1.1;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx - Math.cos(p.dir) * R * 1.6, sy - Math.sin(p.dir) * R * 1.6);
      ctx.lineTo(sx, sy);
      ctx.stroke();
    }

    // --- Knockout: thrown & dizzy, sitting on their butt with spinning stars ---
    if (p.knockedOut) {
      this.drawKnockout(p, sx, sy, R);
      ctx.globalAlpha = 1;
      // still draw the name below
      ctx.fillStyle = "#eaf2f8"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
      ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.9);
      return;
    }

    // --- The character body (oblique 3/4 view), sunk by real water depth ---
    // ankle-deep in shallow → waist-deep mid → head-only when swimming/deep.
    const depth = this.clientDepthAt(p.x, p.y);
    let submerge = 0;
    if (p.swimming) submerge = 0.82;             // deep: head & shoulders only
    else if (depth >= DEPTH_SWIM) submerge = 0.82;
    else if (depth >= DEPTH_ANKLE) submerge = 0.46; // waist-deep
    else if (depth > 0) submerge = 0.16;            // ankle-deep
    const gait = this.gaitFor(p.id, p.x, p.y);

    // --- Transform: 2 s strip-and-re-clothe spin (squash horizontally) ---
    if (p.transforming) {
      const t = performance.now() / 90;
      const squash = Math.abs(Math.cos(t)) * 0.85 + 0.15; // 0.15..1 horizontal spin
      ctx.save();
      ctx.translate(sx, 0);
      ctx.scale(squash, 1);
      ctx.translate(-sx, 0);
      drawCharacterPixel(ctx, sx, sy, p.appearance, {
        facing: "down", phase: t, moving: true, submerge, weapon: null,
      });
      ctx.restore();
      // sparkle poof
      for (let i = 0; i < 5; i++) {
        const a = t * 0.6 + i * 1.3;
        ctx.fillStyle = `hsla(${(t * 4 + i * 60) % 360},90%,80%,0.9)`;
        ctx.beginPath();
        ctx.arc(sx + Math.cos(a) * R * 1.4, sy - R + Math.sin(a) * R * 1.2, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = "#eaf2f8"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
      ctx.fillText(p.name, sx, sy - TILE_SIZE * 1.15);
      return;
    }

    // --- Play dead: slumped body + ZZZ, no stars (research mode mechanic) ---
    if (p.playingDead) {
      // ground shadow
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.beginPath();
      ctx.ellipse(sx, sy + R * 0.5, R * 1.1, R * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      // slumped body (shirt)
      ctx.fillStyle = p.appearance.shirt;
      ctx.beginPath();
      ctx.ellipse(sx, sy + R * 0.15, R * 0.7, R * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // head lolled to the side
      ctx.fillStyle = p.appearance.skin;
      ctx.beginPath();
      ctx.arc(sx + R * 0.15, sy - R * 0.35, R * 0.42, 0, Math.PI * 2);
      ctx.fill();
      // ZZZ floating gently upward (no stars)
      ctx.fillStyle = "rgba(180,220,255,0.9)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "left";
      const ztd = Math.floor(performance.now() / 600) % 3;
      ctx.fillText("z".repeat(ztd + 1), sx + R * 0.8, sy - R * 0.8);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#eaf2f8"; ctx.font = "11px system-ui"; ctx.textAlign = "center";
      ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.9);
      return;
    }

    // --- Hide: melt into the surroundings (near-invisible shimmer to others) ---
    if (p.hiding) {
      const shimmer = 0.06 * Math.sin(performance.now() / 220 + p.x * 2.3);
      ctx.globalAlpha = (isMe ? 0.4 : 0.12) + shimmer;
    }

    // --- Jump: parabolic arc offset + shrinking ground shadow ---
    const jumpOffset = p.jumping ? -Math.sin((p.jumpPhase ?? 0) * Math.PI) * TILE_SIZE * 0.8 : 0;
    if (p.jumping) {
      const shadowScale = 1 - (p.jumpPhase ?? 0) * 0.5;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * 0.25;
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.ellipse(sx, sy + 4, TILE_SIZE * 0.4 * shadowScale, TILE_SIZE * 0.15 * shadowScale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Combat-ready shuffle: a subtle side-to-side sway when stood in combat mode.
    let swayX = 0;
    if (p.mode === "combat" && !gait.moving && !p.swimming) {
      swayX = Math.sin(performance.now() / 260 + p.x * 3.1) * 1.6;
    }

    // Research mode gait: bouncier vertical bob when moving.
    const researchBob = (p.mode === "research" && gait.moving)
      ? Math.abs(Math.sin(gait.phase * 2)) * 2
      : 0;

    // Active melee swing → thrust animation over ~260 ms (server-triggered for other
    // players; set locally for self on Space-release for immediate feel).
    const ATTACK_MS = 260;
    const aa = this.attackAnim.get(p.id);
    let attack: { phase: number; stance: "high" | "low" } | null = null;
    if (aa) {
      const t = (performance.now() - aa.at) / ATTACK_MS;
      if (t >= 1) this.attackAnim.delete(p.id);
      else attack = { phase: t, stance: aa.stance };
    }

    // Running kicks up dust behind the feet (land only, not while swimming).
    const running = gait.running && gait.moving && !p.swimming && depth <= 0 && !p.jumping;
    if (running) {
      const t = performance.now();
      for (let i = 0; i < 2; i++) {
        const age = ((t / 130 + i * 0.5) % 1);
        const puffX = sx - Math.cos(p.dir) * (TILE_SIZE * 0.3 + age * TILE_SIZE * 0.5);
        const puffY = sy + TILE_SIZE * 0.32 - Math.sin(p.dir) * age * TILE_SIZE * 0.2;
        ctx.fillStyle = `rgba(180,165,135,${(0.32 * (1 - age)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(puffX, puffY, (1.5 + age * 3) * (TILE_SIZE / 24), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const pixelOpts: PixelCharOpts = {
      facing: facingFromDir(p.dir) as PixelCharOpts["facing"],
      phase: gait.phase,
      moving: gait.moving,
      running,
      submerge,
      weapon: p.equipped,
      attack,
    };
    drawCharacterPixel(ctx, sx + swayX, sy + jumpOffset - researchBob, p.appearance, pixelOpts);

    // Leaf shimmer overlay when hiding (environment-blend effect).
    if (p.hiding) {
      const leafAlpha = isMe ? 0.25 : 0.55;
      ctx.save();
      ctx.globalAlpha = leafAlpha;
      for (let i = 0; i < 5; i++) {
        const ang = i * 1.26 + performance.now() / 2200;
        const lx = sx + Math.cos(ang) * R * 1.1;
        const ly = sy - R * 0.4 + Math.sin(ang) * R * 0.7;
        ctx.fillStyle = i % 2 === 0 ? "#2e7d32" : "#43a047";
        ctx.beginPath();
        ctx.ellipse(lx, ly, 3.5, 2, ang + 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    // Always restore globalAlpha before drawing UI elements.
    ctx.globalAlpha = 1;

    // HP / stamina bar floating above the head (oblique-friendly, not a ring).
    const frac = Math.max(0, Math.min(1, p.hp / p.maxHp));
    const barW = TILE_SIZE * 0.9, barH = 3;
    const barX = sx - barW / 2, barY = sy - TILE_SIZE * 0.95;
    if (frac < 1 || isMe) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);
      ctx.fillStyle = hpColor(frac);
      ctx.fillRect(barX, barY, barW * frac, barH);
    }
    if (isMe) {
      const sfrac = Math.max(0, Math.min(1, p.stamina / p.maxStamina));
      if (sfrac < 1) {
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.fillRect(barX - 1, barY + barH + 1, barW + 2, 2 + 2);
        ctx.fillStyle = "#42c0ff";
        ctx.fillRect(barX, barY + barH + 2, barW * sfrac, 2);
      }
    }
    ctx.globalAlpha = 1;

    // Sleeping zzz.
    if (p.sleeping) {
      ctx.fillStyle = "rgba(180,220,255,0.9)";
      ctx.font = "12px system-ui";
      ctx.textAlign = "left";
      const zt = Math.floor(performance.now() / 400) % 3;
      ctx.fillText("z".repeat(zt + 1), sx + R, sy - R);
    }

    // Wings speed boost — streaky trail + feather glints.
    if (p.speedBoosted) {
      const t = performance.now();
      for (let i = 0; i < 4; i++) {
        const ang = (i / 4) * Math.PI * 2 + t / 120;
        const r2 = R * (0.9 + 0.4 * Math.sin(t / 200 + i));
        ctx.beginPath();
        ctx.arc(sx + Math.cos(ang) * r2, sy + Math.sin(ang) * r2 * 0.55, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${(t / 8 + i * 60) % 360},90%,80%,0.8)`;
        ctx.fill();
      }
    }

    // Name (with a title tag for role-holders).
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(p.name, sx, sy - TILE_SIZE * 1.15);
    if (p.titles && p.titles.length) {
      ctx.fillStyle = "#ffd54f";
      ctx.font = "9px system-ui";
      ctx.fillText(p.titles[0], sx, sy - TILE_SIZE * 1.4);
    }
  }

  // A thrown player slumped on the ground, dizzy, with spinning stars overhead.
  private drawKnockout(p: PlayerState, sx: number, sy: number, R: number) {
    const ctx = this.ctx;
    const a = p.appearance;
    // ground shadow
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(sx, sy + R * 0.5, R * 1.1, R * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    // slumped body (shirt) + head sitting on their butt
    ctx.fillStyle = a.shirt;
    ctx.beginPath();
    ctx.ellipse(sx, sy + R * 0.15, R * 0.7, R * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = a.skin;
    ctx.beginPath();
    ctx.arc(sx + R * 0.15, sy - R * 0.35, R * 0.42, 0, Math.PI * 2);
    ctx.fill();
    // spinning dizzy stars
    const t = performance.now() / 300;
    for (let i = 0; i < 3; i++) {
      const ang = t + (i / 3) * Math.PI * 2;
      const stx = sx + Math.cos(ang) * R * 0.7;
      const sty = sy - R * 0.9 + Math.sin(ang) * R * 0.3;
      ctx.fillStyle = "#ffd54f";
      ctx.font = "10px system-ui"; ctx.textAlign = "center";
      ctx.fillText("✦", stx, sty);
    }
  }

  // ─── Side panel (OSRS-style right HUD) ─────────────────────────────────────
  private updateSidePanel(me?: PlayerState) {
    const now = performance.now();
    if (now - this.panelLastUpdate < 120) return; // cap at ~8fps for HTML writes
    this.panelLastUpdate = now;

    this.renderPanelStats(me);

    const content = document.getElementById("panel-content")!;
    const mmCanvas = document.getElementById("minimap-canvas")!;
    if (this.panelTab === "map") {
      content.innerHTML = "";
      mmCanvas.classList.remove("hidden");
      this.drawMinimapPanel(me);
    } else {
      mmCanvas.classList.add("hidden");
      if (this.panelTab === "inv")         content.innerHTML = this.panelInvHTML(me);
      else if (this.panelTab === "equip") {
        content.innerHTML = this.panelEquipHTML(me);
        // Paint the paper-doll figure into the freshly-rendered canvas.
        const dc = document.getElementById("doll-canvas") as HTMLCanvasElement | null;
        if (dc && me) drawAvatar(dc.getContext("2d")!, me.appearance, dc.width, dc.height);
      }
      else if (this.panelTab === "skills") content.innerHTML = this.panelSkillsHTML(me);
      else if (this.panelTab === "log")    content.innerHTML = this.panelLogbookHTML();
      else if (this.panelTab === "help")   content.innerHTML = this.panelHelpHTML();
    }
  }

  private renderPanelStats(me?: PlayerState) {
    if (!me || !this.snap) return;
    const hpPct  = Math.min(100, Math.round(me.hp / me.maxHp * 100));
    const stPct  = Math.min(100, Math.round(me.stamina / me.maxStamina * 100));
    const hnPct  = Math.min(100, Math.round(me.hunger / me.maxHunger * 100));
    const hungerLow = hnPct < 25;
    const event = this.snap.event === "tsunami"
      ? `<span style="color:#e57373">⚠ TSUNAMI</span>`
      : this.snap.event === "king"
        ? `<span style="color:#ffb74d">⚠ King tide</span>`
        : `${this.snap.phase}`;
    const eq = me.equipped;
    let weapLine = "";
    if (eq) {
      const ammoId = WEAPON_AMMO[eq];
      const ammoStr = ammoId ? ` <span style="color:${(me.inventory[ammoId]??0)>0?"#9fe6c0":"#e57373"}">[${me.inventory[ammoId]??0}]</span>` : "";
      weapLine = `<div class="panel-info"><span style="color:#ffd98a">${ITEM_LABEL[eq]}</span>${ammoStr}</div>`;
    }
    const titlesStr = me.titles?.length ? `<div style="color:#ce93d8;font-size:10px">${me.titles.join(" · ")}</div>` : "";
    // Highlight the active mode button + show combat stance.
    for (const m of ["combat", "research", "profession"] as const) {
      document.getElementById(`mode-${m}`)?.classList.toggle("active", me.mode === m);
    }
    let modeLine = "";
    if (me.mode === "combat") {
      const st = me.stance === "low" ? "LOW · kick" : "HIGH · punch";
      modeLine = `<div class="panel-info" style="color:#ff9d6b;font-size:10px">Stance: ${st} (Alt) &nbsp;·&nbsp; / grab · B block</div>`;
    } else if (me.mode === "research") {
      modeLine = `<div class="panel-info" style="color:#7fd0ff;font-size:10px">Research · R scan · X inspect</div>`;
    } else {
      modeLine = `<div class="panel-info" style="color:#9fe6c0;font-size:10px">Profession · E use tool · C craft</div>`;
    }
    document.getElementById("panel-stats")!.innerHTML = `
      <div class="stat-row"><span class="stat-label">HP</span><div class="stat-bar"><div class="stat-fill hp-fill" style="width:${hpPct}%"></div></div><span class="stat-val">${Math.round(me.hp)}</span></div>
      <div class="stat-row"><span class="stat-label">Stam</span><div class="stat-bar"><div class="stat-fill stam-fill" style="width:${stPct}%"></div></div><span class="stat-val">${Math.round(me.stamina)}</span></div>
      <div class="stat-row"><span class="stat-label" style="color:${hungerLow?"#e57373":"#8fb4c9"}">Food</span><div class="stat-bar"><div class="stat-fill hun-fill" style="width:${hnPct}%;background:${hungerLow?"#e53935":hnPct<50?"#f9a825":"#43a047"}"></div></div><span class="stat-val" style="color:${hungerLow?"#e57373":"inherit"}">${Math.round(me.hunger)}</span></div>
      ${weapLine}
      <div class="panel-info"><span style="color:#9fe6c0">$${me.money}</span> &nbsp;·&nbsp; <span style="color:#ffd54f">${me.banfielderPts}pts</span>${me.isMayor?' &nbsp;<span style="color:#ffd54f">★</span>':''}</div>
      ${titlesStr}
      ${modeLine}
      <div class="panel-info" style="color:#6a9ab5;font-size:10px">Tide: ${event} &nbsp;·&nbsp; ${this.snap.players.length} here</div>
    `;
  }

  private panelInvHTML(me?: PlayerState): string {
    if (!me) return '<p class="panel-empty">Not joined yet.</p>';
    const items = (ITEM_IDS as readonly ItemId[]).filter(id => (me.inventory[id] ?? 0) > 0);
    if (!items.length) return '<p class="panel-empty">Bag empty — go gather!</p>';
    const cells = items.map(id => {
      const col = (ITEM_COLORS as Record<string, string>)[id] ?? "#3a5a6a";
      const equipped = me.equipped === id;
      return `<div class="inv-cell" data-item="${id}" title="${ITEM_LABEL[id]} — click for options">
        <div class="inv-swatch" style="background:${col};${equipped ? "outline:2px solid #ffd54f;outline-offset:-2px;" : ""}"></div>
        <div class="inv-qty">×${me.inventory[id]}</div>
        <div class="inv-name">${ITEM_LABEL[id]}</div>
      </div>`;
    }).join("");
    return `<div class="inv-grid">${cells}</div>
      <div class="panel-info" style="font-size:10px;color:#5a7f96;margin-top:6px;">Click an item for options · ⚔ in hand has a yellow ring</div>`;
  }

  private panelEquipHTML(me?: PlayerState): string {
    if (!me) return '<p class="panel-empty">Not joined yet.</p>';
    const worn = me.appearance?.worn ?? {};
    const handLabel = me.mode === "combat" ? "Hand (weapon)" : me.mode === "research" ? "Hand (tool)" : "Hand (gear)";

    const slotRow = (slot: WornSlot, label: string) => {
      const itemId = worn[slot];
      if (itemId) {
        const col = (ITEM_COLORS as Record<string, string>)[itemId] ?? "#7a6a4a";
        return `<div class="slot-row">
          <span class="slot-label">${label}</span>
          <div class="slot-box filled" data-item="${itemId}" title="${ITEM_LABEL[itemId] ?? itemId} — click for options">
            <span class="slot-swatch" style="background:${col}"></span>${ITEM_LABEL[itemId] ?? itemId}
          </div></div>`;
      }
      return `<div class="slot-row">
        <span class="slot-label">${label}</span>
        <div class="slot-box empty">— empty</div></div>`;
    };

    // Items in inventory that fit each slot (excluding current weapon/hand).
    const CLOTHING_IDS: ItemId[] = [
      "clothShirt", "clothPants", "waxedJacket", "rainCoat", "woolSweater",
      "wetsuitTop", "wetsuitBottom", "snorkelMask", "divingTank",
    ] as ItemId[];
    const RESEARCH_TOOLS: ItemId[] = ["binoculars", "butterflyNet", "listeningDevice", "fieldNotebook"] as ItemId[];
    const PROF_TOOLS: ItemId[] = ["pickaxe", "fishingCage", "surveyFlag"] as ItemId[];

    const availableClothing = CLOTHING_IDS.filter(id => (me.inventory[id] ?? 0) > 0);
    const availableHand = (me.mode === "combat" ? (WEAPON_ORDER as ItemId[]) :
      me.mode === "research" ? RESEARCH_TOOLS : PROF_TOOLS
    ).filter(id => (me.inventory[id] ?? 0) > 0);

    const wardrobeGrid = availableClothing.length
      ? `<div style="font-size:10px;color:#7fd0c2;margin:6px 0 3px;font-weight:700">In your bag — click to wear/wield</div>
         <div class="inv-grid">${availableClothing.map(id => {
           const col = (ITEM_COLORS as Record<string, string>)[id] ?? "#7a6a4a";
           const sl = SLOT_FOR_ITEM[id] as WornSlot;
           const isOn = sl && worn[sl] === id;
           return `<div class="inv-cell" data-item="${id}" title="${ITEM_LABEL[id]}">
             <div class="inv-swatch" style="background:${col};${isOn?"outline:2px solid #ffd54f;outline-offset:-2px;":""}"></div>
             <div class="inv-name">${ITEM_LABEL[id]}</div></div>`;
         }).join("")}</div>` : "";

    const handGrid = availableHand.length
      ? `<div style="font-size:10px;color:#7fd0c2;margin:6px 0 3px;font-weight:700">Available ${me.mode === "combat" ? "weapons" : "tools"}</div>
         <div class="inv-grid">${availableHand.map(id => {
           const col = (ITEM_COLORS as Record<string, string>)[id] ?? "#3a5a6a";
           const isOn = me.equipped === id;
           return `<div class="inv-cell" data-item="${id}" title="${ITEM_LABEL[id]}">
             <div class="inv-swatch" style="background:${col};${isOn?"outline:2px solid #ffd54f;outline-offset:-2px;":""}"></div>
             <div class="inv-name">${ITEM_LABEL[id]}</div></div>`;
         }).join("")}</div>` : `<div style="font-size:10px;color:#4a6b7c;margin-top:4px;">No ${me.mode==="combat"?"weapons":"tools"} in bag.</div>`;

    return `
      <div class="doll-wrap">
        <canvas id="doll-canvas" width="92" height="150"></canvas>
      </div>
      ${slotRow("head", "Head")}
      ${slotRow("torso", "Torso")}
      ${slotRow("legs", "Legs")}
      ${slotRow("back", "Back")}
      ${slotRow("hand", handLabel)}
      <div style="border-top:1px solid #1d4a66;margin:8px 0 6px"></div>
      ${wardrobeGrid}
      ${handGrid}
      <div class="panel-info" style="font-size:10px;color:#5a7f96;margin-top:8px;">Click a slot or bag item for options · clothing from Seamstress</div>
    `;
  }

  private panelSkillsHTML(me?: PlayerState): string {
    if (!me) return '<p class="panel-empty">Not joined yet.</p>';
    const rankStr = me.isMayor ? "★ Mayor" : me.rank > 0 ? `#${me.rank}` : "unranked";
    const rows = SKILL_NAMES.map(sk => {
      const xp = me.skills[sk], lv = skillLevel(xp);
      const nextXp = (lv+1)*(lv+1), thisXp = lv*lv;
      const pct = lv === 0 ? 0 : Math.round((xp-thisXp)/(nextXp-thisXp)*100);
      return `<div class="skill-row">
        <span class="skill-name">${sk}</span><span class="skill-lv">Lv ${lv}</span>
        <div class="skill-bar"><div class="skill-fill" style="width:${Math.min(100,pct)}%"></div></div>
      </div>`;
    }).join("");
    return `<div class="stats-header">
      <div style="color:#ffd54f;font-size:12px">${rankStr}</div>
      <div style="color:#9fe6c0;font-size:11px">${me.banfielderPts} Banfielder pts</div>
    </div><div class="skill-list">${rows}</div>`;
  }

  private panelLogbookHTML(): string {
    const total = Object.keys(SPECIES).length;
    const byKey = new Map(this.logbook.map(e => [e.key, e]));
    const groups: Array<[string, string]> = [
      ["marine","Marine"], ["land","Land"], ["bird","Birds"],
      ["plant","Plants"], ["tree","Trees"], ["mineral","Minerals"],
    ];
    let html = `<div class="log-header">${this.logbook.length} / ${total} species</div>`;
    for (const [g, label] of groups) {
      const keys = Object.keys(SPECIES).filter(k => SPECIES[k].group === g);
      if (!keys.length) continue;
      html += `<div class="log-group">${label}</div>`;
      for (const k of keys) {
        const e = byKey.get(k), info = SPECIES[k];
        const col = e ? "#eafff7" : "rgba(150,175,180,0.38)";
        html += `<div class="log-entry" style="color:${col}">• ${info.common}${e?` ×${e.count}`:""}</div>`;
      }
    }
    return html;
  }

  private panelHelpHTML(): string {
    return `<div class="controls-section">
      <b>Move:</b> WASD &nbsp; <b>Run:</b> hold Shift<br/>
      <b style="color:#ffe7a8">Mode:</b> Tab (or buttons up top)<br/>
      <span style="color:#6a9ab5">⚔ Combat · 🔬 Research · 🛠 Pro</span><br/>
      <span style="color:#6a9ab5">You can only fight in Combat mode.</span><br/>
      <b>Items:</b> click in your bag for options<br/>
      <span style="color:#6a9ab5">(wield · eat · drop)</span><br/><br/>
      <b style="color:#ff9d6b">⚔ Combat:</b><br/>
      <b>Stance:</b> Alt (high=punch / low=kick)<br/>
      <b>Punch/Kick:</b> Space<br/>
      <b>Grab:</b> /  &nbsp;then jink ← → to spin<br/>
      <b>Throw:</b> / again (fling 'em!)<br/>
      <b>Block / break grab:</b> B (high stance)<br/><br/>
      <b style="color:#7fd0ff">🔬 Research:</b><br/>
      <b>H</b> = hide near trees<br/>
      <b>P</b> = play dead (bears ignore you!)<br/>
      <b>V</b> = listen (ambient clues)<br/><br/>
      <b>J</b> = jump (any mode)<br/><br/>
      <b>Talk:</b> E or N near an NPC<br/>
      <b>Chop/mine/pick:</b> E<br/>
      <b>Drink (lake):</b> E &nbsp; <b>Eat:</b> Q<br/>
      <b>Fish:</b> G &nbsp; <b>Sleep at fire:</b> Z<br/>
      <b>Board vehicle:</b> F<br/>
      <b>Bus (Anacla $3):</b> T<br/>
      <b>Craft:</b> C &nbsp; <b>Shop:</b> B (non-combat)<br/>
      <b>Map:</b> M<br/>
      <b>H (combat/pro):</b> First aid &nbsp; <b>Scan:</b> R<br/>
      <b>Inspect:</b> X &nbsp; <b>Leaderboard:</b> K<br/>
      <b>Weapons 1-6:</b> switch slot<br/>
      <b>Chat:</b> Enter<br/>
      <span style="color:#6a9ab5">/ global &nbsp; // team<br/> ///Name private</span><br/><br/>
      <b style="color:#ffb74d">Admin:</b><br/>
      <span style="color:#6a9ab5">/give [n] [item] &nbsp; /give wings<br/>
      /remove [item|wings]<br/>
      /money [n] &nbsp; /tp [x] [y]<br/>
      /god &nbsp; /heal &nbsp; /kill<br/>
      /tide [tsunami|king|none]<br/>
      /spawn [creature|car|boat]<br/>
      /where</span>
    </div>`;
  }

  // Cached base minimap image (just tiles, no player dot).
  // Rebuilt only when the overview changes — never on every frame.
  private minimapCache: OffscreenCanvas | null = null;
  private minimapCacheKey = "";

  private drawMinimapPanel(me?: PlayerState) {
    const mctx = this.minimapCtx;
    if (!mctx || !this.overview) return;
    const mw = 184, mh = 150;
    const ov = this.overview;

    const cacheKey = `${ov.width}x${ov.height}`;
    if (this.minimapCacheKey !== cacheKey || !this.minimapCache) {
      this.minimapCacheKey = cacheKey;
      const ofc = new OffscreenCanvas(mw, mh);
      const octx = ofc.getContext("2d")!;
      octx.fillStyle = "#0a1c29";
      octx.fillRect(0, 0, mw, mh);
      const sx = mw / ov.width, sy = mh / ov.height;
      for (let y = 0; y < ov.height; y++) {
        for (let x = 0; x < ov.width; x++) {
          const tile = ov.tiles[y * ov.width + x] as Tile;
          octx.fillStyle = (TILE_COLORS as Record<number, string>)[tile] ?? "#1c5f86";
          octx.fillRect(Math.floor(x * sx), Math.floor(y * sy), Math.ceil(sx) + 1, Math.ceil(sy) + 1);
        }
      }
      this.minimapCache = ofc;
    }

    mctx.drawImage(this.minimapCache, 0, 0);
    if (me && this.map) {
      const px = (me.x / this.map.width) * mw;
      const py = (me.y / this.map.height) * mh;
      mctx.fillStyle = "rgba(255,255,255,0.22)";
      mctx.beginPath();
      mctx.arc(px, py, 5, 0, Math.PI * 2);
      mctx.fill();
      mctx.fillStyle = "#fff";
      mctx.beginPath();
      mctx.arc(px, py, 2.5, 0, Math.PI * 2);
      mctx.fill();
    }
    mctx.strokeStyle = "#1d4a66";
    mctx.lineWidth = 1;
    mctx.strokeRect(0, 0, mw, mh);
  }

  private drawHud(snap: Snapshot, me?: PlayerState) {
    const hud = document.getElementById("hud")!;
    const tidePct = Math.round(snap.tide * 100);
    const event = snap.event === "tsunami" ? " ⚠ TSUNAMI" : snap.event === "king" ? " ⚠ King tide" : "";
    const sleepStr = me?.sleeping ? ` 💤` : "";
    const teamStr = me?.team ? ` · <b>Team:</b> ${me.team}` : "";
    hud.innerHTML =
      `<b>${this.regionName}</b> · <b>Tide:</b> ${snap.phase} (${tidePct}%)${event}${sleepStr}${teamStr}<br />` +
      `<b>Here:</b> ${snap.players.length} players`;
  }

  private renderLog() {
    document.getElementById("log")!.innerHTML = this.logLines
      .map((l) => `• ${l}`)
      .join("<br />");
  }
}

const TRAVEL_COLOR: Record<TravelNode["kind"], string> = {
  bus: "#f4b400",
  gate: "#7e57c2",
  sea: "#13b6c4",
};

// Inventory swatch colours, by item.
const ITEM_COLORS: Record<string, string> = {
  wood: "#6b4423", cedarwood: "#5c3a1e", sprucewood: "#4a7a3a", firwood: "#3d6a30",
  hemwood: "#5a7e50", pinewood: "#7a8a45", yewwood: "#4a2e20", alderwood: "#8a7a38", mapwood: "#9a7820",
  iron: "#8a6040", stone: "#8a8a8a", plank: "#a0783c", clay: "#b5651d", pottery: "#a0522d",
  scrap: "#607d8b", rod: "#4a6a80", crabmeat: "#d4824a", fish: "#4a9abf",
  liveFish: "#2eafd4", berry: "#3a59c0", cookedcrab: "#e05c20", cookedfish: "#c8a040",
  venison: "#c0392b", bearMeat: "#6d2b1a", sealMeat: "#8e5fa0", poultry: "#d4a52a",
  bones: "#c8d0d4", leather: "#8d6e50",
  ironBar: "#b0b0c0", shinyLure: "#ffd54f", jerryCan: "#e07020",
  stick: "#8d6e63", huntingKnife: "#cfd8dc", bow: "#8d6e63", crossbow: "#5d4037",
  speargun: "#455a64", rifle: "#3e2723",
  arrow: "#8d6e63", bolt: "#78909c", spear: "#607d8b", bullet: "#90a4ae",
  clothShirt: "#e3b0c0", clothPants: "#b0c3e3", waxedJacket: "#6b7b3a", rainCoat: "#e8d04a",
  woolSweater: "#8b6e4e", fabricDye: "#c040c0", seamstressKit: "#e891b8",
  snorkelMask: "#2ea8c0", divingTank: "#607d8b", wetsuitTop: "#1a2a3a", wetsuitBottom: "#1a2a3a",
  // research tools
  binoculars: "#3a5a6a", butterflyNet: "#7cb8c0", listeningDevice: "#6a3a6a", fieldNotebook: "#d4b44a",
  // profession tools
  pickaxe: "#8a8a9a", fishingCage: "#5a7a5a", surveyFlag: "#d44a4a",
};

// NPC display name + body colour + dialogue, keyed by kind.
const NPC_NAME: Record<NpcState["kind"], string> = {
  naturalist: "Naturalist", pirate: "Local Pirate", scientist: "Marine Scientist",
  westsider: "West Sider", eastsider: "East Sider", huuayaht: "Huu-ay-aht Citizen",
  mayor: "Unofficial Mayor", historian: "Local Historian", boatdealer: "Boat Dealer",
  icevendor: "Ice Vendor", seamstress: "Seamstress", researcher2: "Field Researcher",
  marineBiologist: "Marine Biologist", snorkeler: "Snorkeler",
};
const NPC_COLORS: Record<NpcState["kind"], string> = {
  naturalist: "#2e7d32", pirate: "#37474f", scientist: "#1565c0", westsider: "#00695c",
  eastsider: "#4a148c", huuayaht: "#b71c1c", mayor: "#f57f17", historian: "#6d4c41",
  boatdealer: "#0277bd", icevendor: "#00838f", seamstress: "#ad1457",
  researcher2: "#00838f", marineBiologist: "#006064", snorkeler: "#00838f",
};
const NPC_DIALOGUE: Record<NpcState["kind"], string[]> = {
  naturalist: [
    "Those Scotch broom patches choke out the native salal. Pull them when they FLOWER — that's the only time it kills the root for good.",
    "The arbutus trees only grow along the rocky shoreline here. Very rare on the coast — slow to grow back, so don't fell them lightly.",
    "High tide brings the sixgills in close. Stay out of the deep water when the tide's up.",
  ],
  pirate: [
    "I ain't sayin' where the good crab pots are. Figure it out yourself, landlubber.",
    "Best fishing's off the drop past Brady's Beach at low tide. Don't tell a soul.",
    "Got scrap to trade? I know a fella up the inlet who pays fair.",
  ],
  scientist: [
    "We're tagging humpbacks this season. The BMSC pays top dollar for LIVE specimens — get the fish there before it dies!",
    "The sixgill sharks venturing this shallow is remarkable. They rarely do that elsewhere in the world.",
    "Find arbutus on the west side? Note the spot. We're mapping their range.",
  ],
  historian: [
    "Bamfield Cable Station was the first trans-Pacific cable landing in Canada — 1902.",
    "The Huu-ay-aht fished Pachena Bay for thousands of years before any road was built.",
    "West Bamfield has never had a road. Everything comes by water or along the boardwalk.",
  ],
  eastsider: [
    "Road only reaches the east side. West-siders haul everything by boat, poor souls.",
    "Ostrom's is the only gas in town. Don't run your tank dry out on the water.",
    "Breakers is just up the inlet — good food, warm fire.",
  ],
  westsider: [
    "We like it over here. No cars, no through-traffic. Just the boardwalk and the inlet.",
    "The McKay Bay Lodge is down the end of the boardwalk. Worth the walk.",
    "You can walk the boardwalk clear around from the wharf. Mind the gaps at high tide.",
  ],
  huuayaht: [
    "Welcome to Anacla. The Huu-ay-aht Nation has been here since time immemorial.",
    "Pachena Beach runs all the way to Keeha — kilometres of sand at low tide.",
    "The trail to Cape Beale starts on the east side. Long walk. Pack food.",
  ],
  boatdealer: [
    "Got a couple boats along the river bank. Fair price, fair boat.",
    "River boats are shallow-draft — good in the inlet, not so much in open water.",
    "Want to cross Barkley Sound? You'll need a bigger boat than mine.",
  ],
  icevendor: [
    "Fresh ice, straight from the freezer. Essential if you're running live fish to the BMSC.",
    "Buy ice, keep your catch alive longer on the way over.",
  ],
  mayor: [
    "I'm not the OFFICIAL mayor. There is no official mayor. But somebody's got to keep an eye on things.",
    "Pull the Himalayan blackberry before it swallows the riverbank — same as broom, get it while it flowers.",
  ],
  seamstress: [
    "I can sew you something to wear — waxed jacket for the rain, wool sweater for the cold nights. I take cloth and coin.",
    "Fabric dye? Got a few colours left. Bring me the cloth and I'll dye it any shade you like.",
    "I wander east side to west — you'll find me most days along the waterfront. Knock if the light's on.",
  ],
  researcher2: [
    "I've been tracking the wolf pack on the ridge for three seasons now. They're more cautious than people think.",
    "Saw a cougar kill near the old logging road this morning. Keep your eyes up when you're in the trees.",
    "The elk herd is moving earlier this year. Could be the broom spreading up the hillside.",
  ],
  marineBiologist: [
    "Out here studying tidal flow patterns around Barkley Sound. The kelp beds shift every season.",
    "I've got oxygen tanks — enough for a proper dive. The reefs past the headland are worth it.",
    "Saw a Pacific white-sided dolphin pod this morning. Still rare in these waters.",
  ],
  snorkeler: [
    "The shallows off the west dock are incredible at low tide — nudibranch, hermit crabs, the lot.",
    "Got a snorkel mask if you want one. Salt water is harder on gear than people think — rinse it after every dive.",
    "Sea otters are back in the kelp past the point. Stay slow and quiet and they'll let you watch.",
  ],
};

const TRAVEL_ICON: Record<TravelNode["kind"], string> = {
  bus: "BUS",
  gate: "GATE",
  sea: "~ SEA ~",
};

// Tiered water colour matching the DEPTH_* constants from protocol.
function waterDepthColor(depth: number): string {
  if (depth < DEPTH_ANKLE) return "#7ad4e2"; // ankle — very light turquoise
  if (depth < DEPTH_SWIM)  return "#3aadbe"; // knee — teal
  if (depth < DEPTH_DEEP)  return "#1c7fa8"; // waist/swim — medium blue
  if (depth < DEPTH_OCEAN) return "#0f5278"; // deep — dark blue
  if (depth < DEPTH_OCEAN * 1.5) return "#082e50"; // ocean — near-navy
  return "#040f22";                              // abyss — near-black
}

// Fresh water reads green-teal (tannin-stained coastal lake), distinct from the
// blue salt ocean, and only mildly darkens with depth so a lake never looks
// like the deep sea.
function freshWaterColor(depth: number): string {
  if (depth < DEPTH_ANKLE) return "#5fae90"; // shallow lake edge
  if (depth < DEPTH_SWIM)  return "#3f8f78"; // mid
  return "#2c6f62";                          // deeper centre
}

// --- resource node sprites --------------------------------------------------
// Deterministic 0..1 hash from a node's tile coords (stable per tree).
function nodeHash(n: ResourceNode, salt = 0): number {
  const v = Math.sin(n.x * 12.9898 + n.y * 78.233 + salt * 37.719) * 43758.5453;
  return v - Math.floor(v);
}

// NW-coast tree species: trunk + canopy palette, crown shape, and a base size.
// `giant` species can grow into old-growth monsters (size varies per tree).
type ConShape = "broad" | "column" | "cone" | "droop" | "scrub" | "dense";
interface TreeSpec {
  type: "conifer" | "broadleaf";
  trunk: string;
  canopy: string[]; // dark → light
  base: number;     // base size multiplier
  vary: number;     // extra size from per-tree hash (old-growth spread)
  shape?: ConShape;
}
const TREE_SPECS: Record<string, TreeSpec> = {
  redcedar:    { type:"conifer", trunk:"#6b4a2b", canopy:["#2c6230","#367a35","#49923f"], base:1.80, vary:1.10, shape:"broad" },
  sitkaspruce: { type:"conifer", trunk:"#5e4a34", canopy:["#1f5742","#27684e","#368063"], base:1.90, vary:1.10, shape:"column" },
  douglasfir:  { type:"conifer", trunk:"#5a3f28", canopy:["#234b25","#2d5d2d","#3c7339"], base:1.70, vary:0.95, shape:"cone" },
  hemlock:     { type:"conifer", trunk:"#5a4632", canopy:["#356b3a","#418347","#57a55e"], base:1.30, vary:0.55, shape:"droop" },
  shorepine:   { type:"conifer", trunk:"#6b5436", canopy:["#4f6f33","#5f8038","#74974a"], base:1.10, vary:0.45, shape:"scrub" },
  yew:         { type:"conifer", trunk:"#7a3b2a", canopy:["#1b3d29","#244e33","#2f6040"], base:1.00, vary:0.40, shape:"dense" },
  redalder:    { type:"broadleaf", trunk:"#8a8170", canopy:["#4a7d3a","#5b9146","#73a857"], base:1.40, vary:0.60 },
  bigleafmaple:{ type:"broadleaf", trunk:"#7a6b54", canopy:["#5a8a32","#6fa23e","#88b955"], base:1.70, vary:0.85 },
};

// A layered conifer: trunk + stacked tiers of foliage tapering to a crown.
function drawConifer(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, spec: TreeSpec) {
  const shape = spec.shape ?? "cone";
  const wide = shape === "broad" ? 1.15 : shape === "scrub" ? 1.2 : shape === "column" ? 0.75 : shape === "dense" ? 1.0 : 0.95;
  const tall = shape === "column" ? 1.35 : shape === "scrub" ? 0.7 : shape === "dense" ? 0.8 : 1.1;
  // shadow
  ctx.fillStyle = "rgba(0,0,0,0.20)";
  ctx.beginPath();
  ctx.ellipse(x, y + R * 0.78, R * 0.85 * wide, R * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  // trunk
  const trunkH = R * 0.9;
  const tw = Math.max(2, R * 0.16);
  ctx.fillStyle = spec.trunk;
  ctx.fillRect(x - tw / 2, y, tw, trunkH);
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(x + tw * 0.1, y, tw * 0.4, trunkH);
  // foliage tiers (bottom widest), drawn as triangles, dark→light up the tree
  const tiers = shape === "scrub" ? 2 : 4;
  const topY = y - R * (0.35 + tall * 0.5);
  const botY = y + R * 0.18;
  const halfW = R * 0.95 * wide;
  for (let i = 0; i < tiers; i++) {
    const f = i / tiers;
    const cy = botY + (topY - botY) * f;
    const w = halfW * (1 - f * 0.78);
    const h = (botY - topY) / tiers * 1.5;
    ctx.fillStyle = spec.canopy[Math.min(spec.canopy.length - 1, Math.floor(f * spec.canopy.length))];
    ctx.beginPath();
    ctx.moveTo(x, cy - h);
    ctx.lineTo(x - w, cy + h * 0.5);
    ctx.lineTo(x + w, cy + h * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  // sunlit crown tip
  ctx.fillStyle = spec.canopy[spec.canopy.length - 1];
  ctx.beginPath();
  ctx.arc(x, topY, R * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

// A rounded broadleaf (alder/maple): trunk + clustered blob crown.
function drawBroadleaf(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, spec: TreeSpec) {
  ctx.fillStyle = "rgba(0,0,0,0.20)";
  ctx.beginPath();
  ctx.ellipse(x, y + R * 0.78, R * 0.85, R * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  const trunkH = R * 0.85;
  const tw = Math.max(2, R * 0.16);
  ctx.fillStyle = spec.trunk;
  ctx.fillRect(x - tw / 2, y, tw, trunkH);
  const top = y - R * 0.55;
  for (const [ox, oy, r, ci] of [
    [0, 0, R * 1.0, 0], [-R * 0.45, -R * 0.1, R * 0.66, 1], [R * 0.45, -R * 0.05, R * 0.62, 1],
    [-R * 0.15, -R * 0.5, R * 0.66, 2], [R * 0.22, -R * 0.42, R * 0.56, 2],
  ] as const) {
    ctx.fillStyle = spec.canopy[ci];
    ctx.beginPath();
    ctx.arc(x + ox, top + oy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawResourceSprite(ctx: CanvasRenderingContext2D, n: ResourceNode, x: number, y: number) {
  // Trees stand taller than ground resources, for a proper forest canopy.
  // Per-tree size: species base × old-growth spread (giants tower over saplings).
  const spec = n.kind === "tree" ? TREE_SPECS[n.variety ?? ""] : undefined;
  const treeScale = spec ? spec.base + nodeHash(n, 4) * spec.vary : 1;
  const R = n.kind === "tree" ? TILE_SIZE * 0.6 * treeScale : TILE_SIZE * 0.44;
  if (n.depleted) {
    // Ghost outline: stump or empty pit.
    ctx.strokeStyle = n.kind === "tree" ? "#3a5c28" : "#5a4e3a";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, R * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  if (n.kind === "tree" && n.variety === "arbutus") {
    // Arbutus: distinctive reddish-orange peeling trunk, glossy compact canopy.
    ctx.fillStyle = "#c4582e";
    ctx.fillRect(x - 3, y, 6, R * 0.65);
    // Bark flecks
    ctx.fillStyle = "#9c3d1e";
    ctx.fillRect(x - 2, y + 4, 2, 4);
    ctx.fillRect(x + 1, y + 9, 2, 3);
    for (const [ox, oy, r, col] of [
      [0, -R * 0.1, R * 0.75, "#1e5c3a"],
      [-R * 0.25, -R * 0.15, R * 0.55, "#265e40"],
      [R * 0.25, -R * 0.1, R * 0.5, "#245c3c"],
      [0, -R * 0.35, R * 0.6, "#2a7048"],
    ] as const) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Warm sun-glint on the glossy leaves.
    ctx.fillStyle = "rgba(255,200,100,0.18)";
    ctx.beginPath();
    ctx.arc(x - R * 0.2, y - R * 0.4, R * 0.35, 0, Math.PI * 2);
    ctx.fill();
  } else if (n.kind === "tree") {
    // Real NW-coast species, each drawn to its own silhouette & palette.
    const s = spec ?? TREE_SPECS.hemlock;
    if (s.type === "conifer") drawConifer(ctx, x, y, R, s);
    else drawBroadleaf(ctx, x, y, R, s);
  } else if (n.kind === "berryBush") {
    // Low leafy bush dotted with berries; colour hints at the variety.
    const v = n.variety ?? "";
    const berryCol = v.includes("salmon") ? "#e8714f"
      : v.includes("thimble") ? "#d6453f"
      : v.includes("salal") ? "#2b3a55"
      : v.includes("blackberry") ? "#26121f"
      : "#3a59c0"; // huckleberry blue default
    ctx.fillStyle = "#2f6b34";
    for (const [ox, oy, r] of [
      [0, R * 0.1, R * 0.85],
      [-R * 0.4, 0, R * 0.55],
      [R * 0.4, 0.02, R * 0.55],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = berryCol;
    for (const [ox, oy] of [[-4, 0], [3, -2], [0, 4], [6, 3], [-6, 4]] as const) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (n.kind === "clayDeposit") {
    // Clay deposit: earthy reddish mound near water.
    ctx.fillStyle = "#b5651d";
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.2, R * 1.0, R * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#cd8a40";
    ctx.beginPath();
    ctx.ellipse(x - R * 0.2, y - R * 0.1, R * 0.5, R * 0.3, 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#a0522d";
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    // Ore vein: rough rock cluster
    const col = n.kind === "ironOre" ? "#8a6040" : "#8a8a8a";
    const hi = n.kind === "ironOre" ? "#d4824a" : "#b8b8b8";
    ctx.fillStyle = col;
    for (const [ox, oy, r] of [
      [0, 0, R],
      [-R * 0.45, -R * 0.2, R * 0.6],
      [R * 0.4, -R * 0.15, R * 0.55],
      [0, -R * 0.4, R * 0.5],
    ] as const) {
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    // Ore sparkles
    ctx.fillStyle = hi;
    for (const [ox, oy] of [[-3, -8], [5, -3], [-6, 2], [3, 6]] as const) {
      ctx.fillRect(x + ox, y + oy, 2, 2);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.stroke();
  }

  // HP notches (dashes around the base to show how many hits are left).
  const frac = n.hp / n.maxHp;
  if (frac < 1) {
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y, R + 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();
  }
}

// --- invasive plant sprites -------------------------------------------------
function drawPlantSprite(ctx: CanvasRenderingContext2D, pl: PlantState, x: number, y: number) {
  const R = TILE_SIZE * 0.42;
  const flowering = pl.stage === "flowering";
  const seeding = pl.stage === "seeding";

  if (pl.kind === "scotchBroom") {
    // Spindly broom: green whips, yellow pea-flowers when flowering.
    ctx.strokeStyle = "#3f6b2e";
    ctx.lineWidth = 2;
    for (const a of [-0.5, -0.18, 0.15, 0.5]) {
      ctx.beginPath();
      ctx.moveTo(x, y + R * 0.6);
      ctx.lineTo(x + Math.sin(a) * R * 1.1, y - R);
      ctx.stroke();
    }
    if (flowering) {
      ctx.fillStyle = "#ffd21f";
      for (const [ox, oy] of [[-6, -8], [0, -12], [6, -7], [-3, -2], [4, -1]] as const) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (pl.kind === "himalayanBlackberry") {
    // Dense arching bramble; dark berries when seeding.
    ctx.strokeStyle = "#4a6b3a";
    ctx.lineWidth = 3;
    for (const a of [-0.8, -0.3, 0.3, 0.8]) {
      ctx.beginPath();
      ctx.arc(x, y + R * 0.4, R, Math.PI + a, Math.PI * 2 - a);
      ctx.stroke();
    }
    ctx.fillStyle = "#355a2a";
    ctx.beginPath();
    ctx.arc(x, y, R * 0.5, 0, Math.PI * 2);
    ctx.fill();
    if (flowering) {
      ctx.fillStyle = "#f3e1ec";
      for (const [ox, oy] of [[-5, -5], [5, -4], [0, -7]] as const) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (seeding) {
      ctx.fillStyle = "#1c0d18";
      for (const [ox, oy] of [[-5, -3], [4, -4], [0, 2]] as const) {
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else {
    // Foxglove: a tall spire of purple bells when flowering — pretty but invasive.
    ctx.strokeStyle = "#2f6b34";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y + R * 0.7);
    ctx.lineTo(x, y - R * 1.1);
    ctx.stroke();
    // basal leaves
    ctx.fillStyle = "#357a3a";
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.6, R * 0.7, R * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    if (flowering) {
      ctx.fillStyle = "#b061c9";
      for (let i = 0; i < 5; i++) {
        const by = y - R * 1.0 + i * R * 0.4;
        ctx.beginPath();
        ctx.ellipse(x + (i % 2 ? 4 : -4), by, 3.4, 4.6, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Flowering = your window to KILL it for good: pulsing golden halo.
  if (flowering) {
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
    ctx.strokeStyle = `rgba(255,213,79,${(0.35 + 0.45 * pulse).toFixed(2)})`;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, R + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawCampfireSprite(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const t = performance.now() / 140;
  // Log ring
  ctx.strokeStyle = "#5b3a1e";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y + 3, TILE_SIZE * 0.34, 0, Math.PI * 2);
  ctx.stroke();
  // Flames
  for (const [ox, h, col] of [
    [0, 16, "#ff6a00"],
    [-4, 11, "#ffb028"],
    [4, 12, "#ffce4a"],
  ] as const) {
    const flick = Math.sin(t + ox) * 2;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(x + ox - 4, y + 4);
    ctx.quadraticCurveTo(x + ox + flick, y - h, x + ox + 4, y + 4);
    ctx.closePath();
    ctx.fill();
  }
  // Glow
  ctx.fillStyle = "rgba(255,150,40,0.12)";
  ctx.beginPath();
  ctx.arc(x, y, TILE_SIZE * 0.7, 0, Math.PI * 2);
  ctx.fill();
}

function drawFurnaceSprite(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const T = TILE_SIZE;
  const hw = T * 0.44;
  const hh = T * 0.40;
  // Stone body
  ctx.fillStyle = "#4a4a4a";
  ctx.fillRect(x - hw, y - hh, hw * 2, hh * 2);
  // Darker stone face
  ctx.fillStyle = "#333";
  ctx.fillRect(x - hw + 2, y - hh + 2, hw * 2 - 4, hh * 2 - 4);
  // Glowing aperture
  const glow = Math.sin(performance.now() / 300) * 0.15 + 0.85;
  const grad = ctx.createRadialGradient(x, y + 2, 1, x, y + 2, T * 0.25);
  grad.addColorStop(0, `rgba(255,200,60,${glow})`);
  grad.addColorStop(0.5, `rgba(255,100,20,${glow * 0.7})`);
  grad.addColorStop(1, "rgba(80,20,0,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.ellipse(x, y + 2, T * 0.22, T * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // Smoke wisps
  const t = performance.now() / 600;
  for (const [ox, phase] of [[-3, 0], [0, 1.2], [3, 2.4]] as const) {
    const drift = Math.sin(t + phase) * 2;
    const alpha = 0.15 + Math.abs(Math.sin(t + phase)) * 0.1;
    ctx.strokeStyle = `rgba(200,200,200,${alpha})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x + ox, y - hh);
    ctx.quadraticCurveTo(x + ox + drift, y - hh - 5, x + ox + drift * 1.5, y - hh - 10);
    ctx.stroke();
  }
}

// --- ground loot drop --------------------------------------------------------
const LOOT_COLORS: Partial<Record<string, string>> = {
  venison: "#c0392b", bearMeat: "#6d2b1a", sealMeat: "#8e5fa0", poultry: "#d4a52a",
  fish: "#3498db", salmon: "#e67e22", lingcod: "#2ecc71", halibut: "#1abc9c",
  crabmeat: "#e74c3c", bones: "#ecf0f1", leather: "#795548",
  wood: "#8d6e63", cedarwood: "#6d4c41", sprucewood: "#5d8a4e", firwood: "#4e7a3d",
  hemwood: "#7b9a6d", pinewood: "#9e9e6a", yewwood: "#5c4033", alderwood: "#a8a055", mapwood: "#b8860b",
  arrow: "#8d6e63", bolt: "#78909c", spear: "#607d8b", bullet: "#90a4ae",
  clay: "#b5651d", pottery: "#a0522d",
  iron: "#607d8b", stone: "#9e9e9e",
};
function drawLootDrop(ctx: CanvasRenderingContext2D, drop: LootDrop, x: number, y: number) {
  const bob = Math.sin(performance.now() / 500 + drop.x * 7.3 + drop.y * 3.1) * 2;
  const r = TILE_SIZE * 0.22;
  // Glow
  const pulse = 0.4 + 0.3 * Math.abs(Math.sin(performance.now() / 700));
  ctx.save();
  ctx.globalAlpha = pulse;
  ctx.beginPath();
  ctx.arc(x, y + bob, r * 1.8, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.restore();
  // Item circle
  ctx.beginPath();
  ctx.arc(x, y + bob, r, 0, Math.PI * 2);
  ctx.fillStyle = LOOT_COLORS[drop.item] ?? "#aaa";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.stroke();
  // Qty label if >1
  if (drop.qty > 1) {
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(7, r * 0.9)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(drop.qty), x, y + bob);
  }
  ctx.textBaseline = "alphabetic";
}

// --- vehicle sprites (top-down) ---------------------------------------------
function drawVehicleSprite(ctx: CanvasRenderingContext2D, v: VehicleState, x: number, y: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(v.dir);
  if (v.kind === "car") drawCar(ctx);
  else drawBoat(ctx);
  ctx.restore();

  // Shared damage bar above the hull when it's taken a beating.
  const frac = Math.max(0, v.hp / v.maxHp);
  if (frac < 1) {
    const w = TILE_SIZE * 1.4;
    ctx.fillStyle = "#222";
    ctx.fillRect(x - w / 2, y - TILE_SIZE, w, 3);
    ctx.fillStyle = frac > 0.5 ? "#4caf50" : frac > 0.25 ? "#ffb300" : "#e53935";
    ctx.fillRect(x - w / 2, y - TILE_SIZE, w * frac, 3);
  }

  // Fuel gauge just below the damage bar (only when it's not a full tank).
  const ffrac = Math.max(0, v.fuel / v.maxFuel);
  if (ffrac < 1) {
    const w = TILE_SIZE * 1.4;
    const fy = y - TILE_SIZE + 5;
    ctx.fillStyle = "#222";
    ctx.fillRect(x - w / 2, fy, w, 3);
    ctx.fillStyle = ffrac > 0.3 ? "#ff9800" : "#e53935";
    ctx.fillRect(x - w / 2, fy, w * ffrac, 3);
    ctx.fillStyle = "#ffd9a0";
    ctx.font = "8px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("⛽", x - w / 2 - 10, fy + 4);
  }
}

function drawCar(ctx: CanvasRenderingContext2D) {
  const L = TILE_SIZE * 1.5; // length (along heading)
  const W = TILE_SIZE * 0.82; // width
  // body
  ctx.fillStyle = "#c0392b";
  roundRect(ctx, -L / 2, -W / 2, L, W, 5);
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.5)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // cabin / windshield (toward the front = +x)
  ctx.fillStyle = "#1c2a33";
  roundRect(ctx, -L * 0.05, -W * 0.34, L * 0.34, W * 0.68, 3);
  ctx.fill();
  // headlights at the nose
  ctx.fillStyle = "#ffe082";
  ctx.beginPath();
  ctx.arc(L / 2 - 3, -W * 0.28, 2.2, 0, Math.PI * 2);
  ctx.arc(L / 2 - 3, W * 0.28, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

function drawBoat(ctx: CanvasRenderingContext2D) {
  const L = TILE_SIZE * 1.7;
  const W = TILE_SIZE * 0.78;
  // pointed hull (bow toward +x)
  ctx.fillStyle = "#e8e2d0";
  ctx.beginPath();
  ctx.moveTo(L / 2, 0); // bow
  ctx.lineTo(L * 0.05, -W / 2);
  ctx.lineTo(-L / 2, -W * 0.36);
  ctx.lineTo(-L / 2, W * 0.36);
  ctx.lineTo(L * 0.05, W / 2);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#7a6f53";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // open cockpit / inner well
  ctx.fillStyle = "#3a5a6a";
  roundRect(ctx, -L * 0.32, -W * 0.26, L * 0.5, W * 0.52, 3);
  ctx.fill();
  // little outboard motor at the stern
  ctx.fillStyle = "#222";
  ctx.fillRect(-L / 2 - 3, -3, 5, 6);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const RARITY_COLOR: Record<string, string> = {
  common: "#9fb3ad", uncommon: "#7ec96b", rare: "#5aa9ff",
  "very rare": "#c98bff", legendary: "#ffd24a",
};

// Weapon slots 1-6 and the ammo each ranged weapon uses.
const WEAPON_ORDER: ItemId[] = ["stick", "huntingKnife", "bow", "crossbow", "speargun", "rifle"];
const WEAPON_AMMO: Partial<Record<ItemId, ItemId>> = {
  bow: "arrow", crossbow: "bolt", speargun: "spear", rifle: "bullet",
};

// Word-wrap helper for the info/logbook cards.
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string, x: number, y: number, maxW: number, lineH: number,
) {
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y);
      line = w; y += lineH;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y);
}

// ---------------------------------------------------------------------------
// Oblique 3/4-view humanoid — the shared body for players and NPCs.
//
// Drawn in the style of Eastward / Stardew: the camera looks down, but every
// character is rendered standing UP so you read head, torso, arms and legs.
// Anchored near the feet at (sx, sy); the body rises above so taller things
// naturally overlap shorter ones in a Y-sorted scene.
// ---------------------------------------------------------------------------
type Facing = "down" | "up" | "left" | "right";

function facingFromDir(dir: number): Facing {
  const dx = Math.cos(dir), dy = Math.sin(dir);
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

interface CharLook { skin: string; hair: string; shirt: string; pants?: string; hat?: string }

function drawWeaponInHand(ctx: CanvasRenderingContext2D, weapon: ItemId, hx: number, hy: number, side: -1 | 1, u: number) {
  const ang = side === 1 ? -Math.PI * 0.3 : Math.PI * 0.3; // tilt away from body
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(ang);
  switch (weapon) {
    case "stick": {
      ctx.strokeStyle = "#8d6e63"; ctx.lineWidth = 1.4 * u; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -9 * u); ctx.stroke();
      break;
    }
    case "huntingKnife": {
      // Handle
      ctx.fillStyle = "#5d4037"; ctx.fillRect(-0.8 * u, 0, 1.6 * u, 3 * u);
      // Blade
      ctx.fillStyle = "#cfd8dc";
      ctx.beginPath(); ctx.moveTo(-0.9 * u, -6 * u); ctx.lineTo(0.9 * u, 0); ctx.lineTo(-0.9 * u, 0); ctx.closePath(); ctx.fill();
      break;
    }
    case "bow": {
      ctx.strokeStyle = "#8d6e63"; ctx.lineWidth = 1.2 * u; ctx.lineCap = "round";
      ctx.beginPath(); ctx.arc(0, -4 * u, 5 * u, Math.PI * 0.55, Math.PI * 1.45); ctx.stroke();
      ctx.strokeStyle = "rgba(200,220,240,0.8)"; ctx.lineWidth = 0.5 * u;
      ctx.beginPath(); ctx.moveTo(-4.8 * u, -7.2 * u); ctx.lineTo(-4.8 * u, -0.8 * u); ctx.stroke();
      break;
    }
    case "crossbow": {
      ctx.strokeStyle = "#5d4037"; ctx.lineWidth = 1.5 * u; ctx.lineCap = "square";
      ctx.beginPath(); ctx.moveTo(0, 1 * u); ctx.lineTo(0, -7 * u); ctx.stroke();
      ctx.strokeStyle = "#78909c"; ctx.lineWidth = 1.2 * u;
      ctx.beginPath(); ctx.moveTo(-5 * u, -5 * u); ctx.lineTo(5 * u, -5 * u); ctx.stroke();
      break;
    }
    case "speargun": {
      ctx.strokeStyle = "#455a64"; ctx.lineWidth = 1.6 * u; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(0, 2 * u); ctx.lineTo(0, -8 * u); ctx.stroke();
      ctx.fillStyle = "#cfd8dc"; // tip
      ctx.beginPath(); ctx.moveTo(-1 * u, -8 * u); ctx.lineTo(1 * u, -8 * u); ctx.lineTo(0, -11 * u); ctx.closePath(); ctx.fill();
      break;
    }
    case "rifle": {
      ctx.strokeStyle = "#3e2723"; ctx.lineWidth = 1.8 * u; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-1 * u, 2 * u); ctx.lineTo(0, -9 * u); ctx.stroke();
      ctx.strokeStyle = "#78909c"; ctx.lineWidth = 1.2 * u;
      ctx.beginPath(); ctx.moveTo(-1 * u, -3 * u); ctx.lineTo(-4 * u, -3 * u); ctx.stroke(); // mag
      break;
    }
  }
  ctx.restore();
}

function drawCharacter(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  look: CharLook,
  o: { facing: Facing; phase: number; moving: boolean; running?: boolean; submerge?: number; weapon?: ItemId | null;
       attack?: { phase: number; stance: "high" | "low" } },
) {
  const u = TILE_SIZE / 24;                    // scale unit (1 at 24px tiles)
  const face = o.facing;
  const pants = look.pants ?? "#39507a";        // denim
  const run = !!o.running;
  // A run swings the limbs wider than a walk for clear, snappy locomotion.
  const swing = o.moving ? Math.sin(o.phase) * (run ? 1.4 : 1) : 0;
  // Facing direction as a screen vector, for punch/kick thrusts.
  const dirX = face === "left" ? -1 : face === "right" ? 1 : 0;
  const dirY = face === "up" ? -1 : face === "down" ? 1 : 0;
  const frontSide: -1 | 1 = face === "right" ? -1 : 1;

  // Which limbs an active swing replaces, so we don't double them up.
  const punching = !!o.attack && o.attack.stance === "high";
  const kicking  = !!o.attack && o.attack.stance === "low";

  // Upper-body bob: feet stay planted while the torso/head bounce on each step.
  // A run bounces higher; a lean tips the body into the direction of travel.
  const bob  = o.moving ? -Math.abs(Math.sin(o.phase)) * (run ? 1.9 : 1.0) * u : 0;
  const lean = run ? dirX * 1.4 * u : 0;

  const feetY  = sy + 9 * u;
  const hipY   = sy + 3 * u + bob;
  const shoY   = sy - 5 * u + bob;               // shoulder line
  const headCY = sy - 11 * u + bob;
  const headR  = 5.2 * u;
  const bodyW  = 11 * u;

  // Water submersion 0..1 (fraction of the body the water covers). Drives how
  // much of the body shows: ankle-deep → ~0.12, waist → ~0.45, head-only → ~0.8.
  const sub = o.submerge ?? 0;
  const bodyTop = headCY - headR, bodyBot = feetY;
  const waterY = sub > 0 ? bodyBot - sub * (bodyBot - bodyTop) : Infinity;
  const showLegs  = waterY >= hipY - 1 * u;      // water still below the hips
  const showTorso = waterY >= shoY + 1 * u;      // water below the shoulders

  // darker shade of a hex colour, for simple shadowing
  const shade = (hex: string, f: number) => {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.max(0, ((n >> 16) & 255) * f) | 0;
    const g = Math.max(0, ((n >> 8) & 255) * f) | 0;
    const b = Math.max(0, (n & 255) * f) | 0;
    return `rgb(${r},${g},${b})`;
  };

  // ---- ground shadow (only on land) ----
  if (sub <= 0) {
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.beginPath();
    ctx.ellipse(sx, feetY + 1.5 * u, 8 * u, 2.8 * u, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ---- legs (stride only while moving; hidden once waist-deep) ----
  if (showLegs) {
    const legSpread = 2.8 * u;
    for (const side of [-1, 1] as const) {
      // The kicking leg is drawn by the thrust block below — don't double it.
      if (kicking && side === frontSide) continue;
      const sw = (side === -1 ? swing : -swing) * 2.2 * u;
      const lx = sx + side * legSpread + sw;
      const ly = feetY;
      ctx.strokeStyle = pants;
      ctx.lineWidth = 3.6 * u;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx + side * legSpread * 0.7, hipY);
      ctx.lineTo(lx, ly);
      ctx.stroke();
      // boot
      ctx.fillStyle = "#241809";
      ctx.beginPath();
      ctx.ellipse(lx + (face === "left" ? -1 : face === "right" ? 1 : 0) * u, ly + 1 * u, 2.5 * u, 1.6 * u, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- arms + torso (hidden once head-deep) ----
  // Arms counter-swing the legs; a run pumps them harder.
  const armPhase = o.moving ? Math.sin(o.phase + Math.PI) * 2.2 * u * (run ? 1.4 : 1) : 0;
  const lx0 = sx + lean;                    // upper-body x origin, tipped when running
  const drawArm = (side: -1 | 1) => {
    const ax = lx0 + side * (bodyW / 2 - 0.5 * u);
    const handY = hipY + (side === -1 ? armPhase : -armPhase);
    ctx.strokeStyle = shade(look.shirt, 0.82);
    ctx.lineWidth = 2.9 * u;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(ax, shoY + 1.5 * u);
    ctx.lineTo(ax + side * 1.5 * u, handY);
    ctx.stroke();
    ctx.fillStyle = look.skin;            // hand
    ctx.beginPath();
    ctx.arc(ax + side * 1.5 * u, handY, 1.9 * u, 0, Math.PI * 2);
    ctx.fill();
  };

  if (showTorso) {
    drawArm(face === "right" ? 1 : -1);     // far arm first
    ctx.fillStyle = look.shirt;             // torso
    roundRect(ctx, lx0 - bodyW / 2, shoY, bodyW, hipY - shoY + 2.5 * u, 3 * u);
    ctx.fill();
    ctx.fillStyle = shade(look.shirt, 0.8); // lower-torso shading
    roundRect(ctx, lx0 - bodyW / 2, hipY - 1 * u, bodyW, 4 * u, 2.5 * u);
    ctx.fill();
    // Front arm — but a punch replaces it with the thrust below, so skip it then.
    if (!punching) {
      drawArm(frontSide);
      if (o.weapon) {                       // weapon held in the front hand
        const ax = lx0 + frontSide * (bodyW / 2 - 0.5 * u);
        const handY = hipY + (frontSide === -1 ? armPhase : -armPhase);
        drawWeaponInHand(ctx, o.weapon, ax + frontSide * 1.5 * u, handY, frontSide, u);
      }
    }
  }

  // ---- punch / kick thrust (transient, from a melee fx) ----
  if (o.attack) {
    const t = Math.sin(Math.max(0, Math.min(1, o.attack.phase)) * Math.PI); // 0→1→0
    // For up/down facings there's no horizontal lean, so throw the limb downward
    // toward the camera so the swing still reads clearly.
    const ux = dirX !== 0 ? dirX : 0;
    const uy = dirX !== 0 ? 0 : (dirY !== 0 ? dirY : 1);
    if (o.attack.stance === "high") {
      // Punch: front arm shoots out, fist leading.
      const reach = 9 * u * t;
      const ox = lx0 + ux * reach, oy = shoY + 1 * u + uy * reach * 0.6;
      ctx.strokeStyle = shade(look.shirt, 0.82);
      ctx.lineWidth = 3 * u;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(lx0 + ux * (bodyW / 2), shoY + 1 * u);
      ctx.lineTo(ox, oy);
      ctx.stroke();
      ctx.fillStyle = look.skin;             // fist
      ctx.beginPath();
      ctx.arc(ox, oy, 2.4 * u, 0, Math.PI * 2);
      ctx.fill();
      if (t > 0.5) {                          // impact spark at full extension
        ctx.strokeStyle = "rgba(255,236,150,0.9)";
        ctx.lineWidth = 1.2 * u;
        for (let i = 0; i < 4; i++) {
          const a = i * 1.57 + 0.4;
          ctx.beginPath();
          ctx.moveTo(ox + Math.cos(a) * 2.6 * u, oy + Math.sin(a) * 2.6 * u);
          ctx.lineTo(ox + Math.cos(a) * 4.4 * u, oy + Math.sin(a) * 4.4 * u);
          ctx.stroke();
        }
      }
    } else {
      // Kick: front leg snaps out, boot leading.
      const reach = 11 * u * t;
      const ox = sx + ux * reach, oy = hipY + 3 * u + uy * reach * 0.5;
      ctx.strokeStyle = pants;
      ctx.lineWidth = 3.6 * u;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx + ux * (bodyW * 0.3), hipY + 1 * u);
      ctx.lineTo(ox, oy);
      ctx.stroke();
      ctx.fillStyle = "#241809";             // boot
      ctx.beginPath();
      ctx.ellipse(ox + ux * 1.2 * u, oy, 2.7 * u, 1.7 * u, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ---- head (shifts slightly toward the facing side for a clearer profile) ----
  const headDX = face === "left" ? -1.2 * u : face === "right" ? 1.2 * u : 0;
  const hx = lx0 + headDX;
  ctx.fillStyle = look.skin;
  ctx.beginPath();
  ctx.arc(hx, headCY, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shade(look.skin, 0.92);   // jaw shading
  ctx.beginPath();
  ctx.ellipse(hx, headCY + headR * 0.45, headR * 0.85, headR * 0.5, 0, 0, Math.PI);
  ctx.fill();

  // ---- hair (covers the BACK of the head — opposite the facing side) ----
  ctx.fillStyle = look.hair;
  if (face === "up") {
    ctx.beginPath();                        // facing away → full hair
    ctx.arc(hx, headCY, headR, 0, Math.PI * 2);
    ctx.fill();
  } else if (face === "down") {
    ctx.beginPath();                        // facing camera → top fringe only
    ctx.arc(hx, headCY, headR, Math.PI * 0.92, Math.PI * 2.08);
    ctx.fill();
  } else {
    // Profile: hair on the back half (right half when facing left, vice-versa).
    const a0 = face === "left" ? -Math.PI / 2 : Math.PI / 2;
    ctx.beginPath();
    ctx.arc(hx, headCY, headR, a0, a0 + Math.PI);
    ctx.fill();
    ctx.beginPath();                        // top sweep
    ctx.arc(hx, headCY, headR, Math.PI, Math.PI * 2);
    ctx.fill();
  }

  // ---- eyes (on the facing side) ----
  ctx.fillStyle = "#1a1a1a";
  const eye = (ex: number) => {
    ctx.beginPath();
    ctx.arc(hx + ex, headCY + 0.5 * u, 0.9 * u, 0, Math.PI * 2);
    ctx.fill();
  };
  if (face === "down") { eye(-2 * u); eye(2 * u); }
  else if (face === "left")  eye(-2.2 * u);
  else if (face === "right") eye(2.2 * u);

  // ---- hat (research sun hat etc.): a brim + crown over the head ----
  if (look.hat) {
    ctx.fillStyle = look.hat;
    // wide brim
    ctx.beginPath();
    ctx.ellipse(hx, headCY - headR * 0.55, headR * 1.7, headR * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    // crown
    ctx.fillStyle = shade(look.hat, 0.88);
    ctx.beginPath();
    ctx.ellipse(hx, headCY - headR * 0.9, headR * 0.8, headR * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // band
    ctx.strokeStyle = shade(look.hat, 0.7);
    ctx.lineWidth = 1.4 * u;
    ctx.beginPath();
    ctx.ellipse(hx, headCY - headR * 0.6, headR * 1.0, headR * 0.32, 0, Math.PI, Math.PI * 2);
    ctx.stroke();
  }

  // ---- waterline: a bright ellipse + soft wake where the body meets the water ----
  if (sub > 0 && Number.isFinite(waterY)) {
    const wlW = (showLegs ? 7 : showTorso ? 8 : 6) * u;
    ctx.fillStyle = "rgba(210,235,255,0.45)";
    ctx.beginPath();
    ctx.ellipse(sx, waterY, wlW, 2.2 * u, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(sx, waterY + 1.5 * u, wlW * 1.25, 3 * u, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// --- creature sprites (top-down, recognizable silhouettes) ------------------
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

const MARINE_KINDS = new Set([
  "crab", "octopus", "dogfish", "sixgill", "orca",
  "humpback", "greywhale", "seal", "sealLion", "seaOtter",
]);

function drawFullCreature(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number) {
  switch (kind) {
    case "crab":      return drawCrab(ctx, x, y);
    case "octopus":   return drawOctopus(ctx, x, y);
    case "dogfish":   return drawShark(ctx, x, y, 0.55, "#5a6b78", false);
    case "sixgill":   return drawShark(ctx, x, y, 0.8,  "#3b4a57", false);
    case "orca":      return drawShark(ctx, x, y, 0.9,  "#10141a", true);
    case "humpback":  return drawWhale(ctx, x, y, "#33414b");
    case "greywhale": return drawWhale(ctx, x, y, "#6b7480");
    case "seal":      return drawSeal(ctx, x, y);
    case "sealLion":  return drawSealLion(ctx, x, y);
    case "seaOtter":  return drawSeaOtter(ctx, x, y);
    case "deer":      return drawDeer(ctx, x, y);
    case "elk":       return drawElk(ctx, x, y);
    case "grouse":    return drawGrouse(ctx, x, y);
    case "bear":      return drawBear(ctx, x, y);
    case "cougar":    return drawCougar(ctx, x, y);
    case "wolf":      return drawWolf(ctx, x, y);
  }
}

// Marine creatures live under the surface. Rather than popping the whole sprite
// in, we reveal them the way a top-down game does it: a faint, water-tinted
// silhouette gliding below, with only the part that breaks the surface (dorsal
// fin, whale back + blow, otter head) drawn solid on top. How much of the body
// shows is driven by the real water DEPTH — shallow water reveals nearly the
// whole animal, deep water hides all but the fin.
function drawCreatureSprite(
  ctx: CanvasRenderingContext2D,
  kind: string,
  x: number,
  y: number,
  depth: number,
  distToPlayer: number,
) {
  // Land animals (and beached crabs at low tide) always draw their full sprite.
  if (depth <= 0 || !MARINE_KINDS.has(kind)) {
    drawFullCreature(ctx, kind, x, y);
    return;
  }

  const bigPredator = kind === "dogfish" || kind === "sixgill" || kind === "orca";
  const whale = kind === "humpback" || kind === "greywhale";

  // Submersion 0..1: shallow (ankle) → 0, deep → 1.
  const sub = clamp01((depth - DEPTH_ANKLE) / (DEPTH_DEEP - DEPTH_ANKLE));

  // The single thing that breaks the surface — fin, blow, or just a ripple.
  const surface = () => {
    if (bigPredator) drawDorsalFin(ctx, x, y, kind === "orca");
    else if (whale) drawWhaleBlow(ctx, x, y);
    else drawRipple(ctx, x, y);
  };

  // Swimming depth or deeper: ONLY the surface telltale, no body visible.
  // Shallow/wading water (< DEPTH_SWIM): you can see the animal beneath.
  if (distToPlayer > 13 || depth >= DEPTH_SWIM) {
    surface();
    return;
  }

  // Close + shallow/clear water: you can see the body gliding under the surface,
  // fading as it gets deeper, with the surface telltale drawn solid on top.
  ctx.save();
  ctx.globalAlpha = 0.85 - sub * 0.5; // 0.85 in the shallows → ~0.55 at the cutoff
  drawFullCreature(ctx, kind, x, y);
  ctx.restore();
  surface();
}

// Expanding ring ripple — creature beneath the surface.
function drawRipple(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const t = (Date.now() % 1200) / 1200; // 0..1 over 1.2 s
  const r1 = 3 + t * 7;
  const r2 = 3 + ((t + 0.4) % 1) * 7;
  const alpha = (v: number) => (0.55 - v * 0.55).toFixed(3);
  ctx.strokeStyle = `rgba(255,255,255,${alpha(t)})`;
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(x, y, r1, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = `rgba(255,255,255,${alpha((t + 0.4) % 1)})`;
  ctx.beginPath(); ctx.arc(x, y, r2, 0, Math.PI * 2); ctx.stroke();
}

// Shark/orca dorsal fin slicing through the surface.
function drawDorsalFin(ctx: CanvasRenderingContext2D, x: number, y: number, orca: boolean) {
  const h = orca ? TILE_SIZE * 0.75 : TILE_SIZE * 0.45;
  const w = orca ? TILE_SIZE * 0.35 : TILE_SIZE * 0.22;
  const col = orca ? "#10141a" : "#3b4a57";
  // Tiny wake ripple behind the fin.
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - w * 0.8, y + 2);
  ctx.lineTo(x - w * 2.5, y + 4);
  ctx.stroke();
  // The fin itself.
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(x, y);            // tip of fin at water surface
  ctx.lineTo(x - w, y + h);   // trailing edge
  ctx.lineTo(x + w * 0.6, y + h * 0.7); // leading edge
  ctx.closePath();
  ctx.fill();
}

// Whale blow spout visible at range.
function drawWhaleBlow(ctx: CanvasRenderingContext2D, x: number, y: number) {
  ctx.strokeStyle = "rgba(200,230,245,0.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 4, y - 14);
  ctx.lineTo(x + 2, y - 22);
  ctx.stroke();
  // Mist cloud at top.
  ctx.fillStyle = "rgba(200,230,245,0.3)";
  ctx.beginPath();
  ctx.ellipse(x + 2, y - 24, 6, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Hint of back above the water.
  ctx.fillStyle = "rgba(100,120,130,0.5)";
  ctx.beginPath();
  ctx.ellipse(x, y + 4, 10, 4, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawSeal(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.3;
  // Body — torpedo shape, warm grey
  ctx.fillStyle = "#8a9ba8";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.35, r * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  // Belly patch
  ctx.fillStyle = "#c8d8e0";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.2, y, r * 0.72, r * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // Flippers
  ctx.fillStyle = "#6c7f8a";
  ctx.beginPath(); ctx.ellipse(x - r * 0.85, y - r * 0.5, r * 0.55, r * 0.2, -0.4, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x - r * 0.85, y + r * 0.5, r * 0.55, r * 0.2,  0.4, 0, Math.PI * 2); ctx.fill();
  // Eye — big and dark, characteristic seal look
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(x + r * 0.78, y - r * 0.22, r * 0.18, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.arc(x + r * 0.84, y - r * 0.27, r * 0.07, 0, Math.PI * 2); ctx.fill();
  // Whiskers
  ctx.strokeStyle = "rgba(255,255,255,0.65)";
  ctx.lineWidth = 0.8;
  for (const [ox, oy] of [[r*0.95, -r*0.08],[r*0.98, -r*0.02],[r*0.96, r*0.06]] as const) {
    ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + r * 0.6, y + oy); ctx.stroke();
  }
}

function drawSealLion(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.36;
  ctx.fillStyle = "#7a6040";
  ctx.beginPath(); ctx.ellipse(x, y, r * 1.4, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  // Slightly lighter chest
  ctx.fillStyle = "#9a8060";
  ctx.beginPath(); ctx.ellipse(x + r * 0.25, y, r * 0.65, r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // Thick neck & head (heavier-set than a seal)
  ctx.fillStyle = "#7a6040";
  ctx.beginPath(); ctx.ellipse(x + r * 1.0, y - r * 0.15, r * 0.55, r * 0.45, 0.3, 0, Math.PI * 2); ctx.fill();
  // Ear nubs (distinguishes sea lion from seal)
  ctx.fillStyle = "#5a4428";
  ctx.beginPath(); ctx.ellipse(x + r * 1.3, y - r * 0.45, r * 0.12, r * 0.08, -0.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(x + r * 1.18, y - r * 0.25, r * 0.14, 0, Math.PI * 2); ctx.fill();
}

function drawSeaOtter(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.28;
  // Body — floating on back, round and fluffy
  ctx.fillStyle = "#6b4c2a";
  ctx.beginPath(); ctx.ellipse(x, y, r * 1.2, r * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  // Pale chest / belly patch
  ctx.fillStyle = "#c8a87a";
  ctx.beginPath(); ctx.ellipse(x + r * 0.05, y + r * 0.1, r * 0.65, r * 0.42, 0, 0, Math.PI * 2); ctx.fill();
  // Round head
  ctx.fillStyle = "#5a3c20";
  ctx.beginPath(); ctx.arc(x + r * 1.05, y - r * 0.08, r * 0.52, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#c8a87a";
  ctx.beginPath(); ctx.ellipse(x + r * 1.12, y + r * 0.18, r * 0.28, r * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  // Tiny paws raised (holding a rock/shellfish)
  ctx.fillStyle = "#3d2810";
  ctx.beginPath(); ctx.ellipse(x + r * 0.55, y - r * 0.5, r * 0.2, r * 0.12, -0.8, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(x + r * 0.35, y - r * 0.55, r * 0.2, r * 0.12, -1.0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath(); ctx.arc(x + r * 1.25, y - r * 0.18, r * 0.12, 0, Math.PI * 2); ctx.fill();
}

function drawCrab(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.3;
  ctx.strokeStyle = "#7b241c";
  ctx.lineWidth = 2;
  for (const sgn of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const yy = y - r * 0.5 + i * r * 0.55;
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + sgn * r * 1.7, yy - r * 0.25 + i * r * 0.25);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.2, r * 0.95, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#a93226";
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + sgn * r * 1.35, y - r * 0.9, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#fff";
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + sgn * r * 0.4, y - r * 0.5, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawOctopus(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.34;
  ctx.strokeStyle = "#7d3c98";
  ctx.lineWidth = 3;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI * 0.15 + (i / 5) * Math.PI * 0.7;
    ctx.beginPath();
    ctx.moveTo(x, y + r * 0.3);
    ctx.quadraticCurveTo(
      x + Math.cos(a) * r * 1.2,
      y + r * 1.0,
      x + Math.cos(a) * r * 1.8,
      y + Math.sin(a) * r * 1.4,
    );
    ctx.stroke();
  }
  ctx.fillStyle = "#8e44ad";
  ctx.beginPath();
  ctx.arc(x, y - r * 0.2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + sgn * r * 0.4, y - r * 0.25, r * 0.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#1a1a1a";
  for (const sgn of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(x + sgn * r * 0.4, y - r * 0.25, r * 0.09, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
  color: string,
  orca: boolean,
) {
  const L = TILE_SIZE * scale;
  ctx.fillStyle = color;
  // tail fluke
  ctx.beginPath();
  ctx.moveTo(x - L, y);
  ctx.lineTo(x - L * 1.5, y - L * 0.5);
  ctx.lineTo(x - L * 1.35, y);
  ctx.lineTo(x - L * 1.5, y + L * 0.5);
  ctx.closePath();
  ctx.fill();
  // body
  ctx.beginPath();
  ctx.ellipse(x, y, L, L * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  // dorsal fin
  ctx.beginPath();
  ctx.moveTo(x, y - L * 0.4);
  ctx.lineTo(x - L * 0.2, y - L * 0.95);
  ctx.lineTo(x + L * 0.18, y - L * 0.4);
  ctx.closePath();
  ctx.fill();
  if (orca) {
    ctx.fillStyle = "#f2f2f2";
    ctx.beginPath();
    ctx.ellipse(x - L * 0.1, y + L * 0.18, L * 0.6, L * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + L * 0.5, y - L * 0.12, L * 0.18, L * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(x + L * 0.62, y - L * 0.08, L * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function drawWhale(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  const L = TILE_SIZE * 1.15;
  ctx.fillStyle = color;
  // fluke
  ctx.beginPath();
  ctx.moveTo(x - L, y);
  ctx.lineTo(x - L * 1.4, y - L * 0.55);
  ctx.lineTo(x - L * 1.4, y + L * 0.55);
  ctx.closePath();
  ctx.fill();
  // body
  ctx.beginPath();
  ctx.ellipse(x, y, L, L * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // blow spout
  ctx.strokeStyle = "rgba(220,235,245,0.7)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + L * 0.45, y - L * 0.5);
  ctx.lineTo(x + L * 0.45, y - L * 0.95);
  ctx.stroke();
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(x + L * 0.6, y - L * 0.1, L * 0.07, 0, Math.PI * 2);
  ctx.fill();
}

function drawDeer(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.52;
  // Body — slender golden tan
  ctx.fillStyle = "#c08848";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.2, r * 0.65, 0, 0, Math.PI * 2);
  ctx.fill();
  // Rump — slightly paler
  ctx.fillStyle = "#d4a868";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.6, y, r * 0.55, r * 0.48, 0, 0, Math.PI * 2);
  ctx.fill();
  // White tail
  ctx.fillStyle = "#eeeeee";
  ctx.beginPath();
  ctx.ellipse(x - r * 1.05, y, r * 0.2, r * 0.28, 0.3, 0, Math.PI * 2);
  ctx.fill();
  // Head
  ctx.fillStyle = "#b07838";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.0, y - r * 0.12, r * 0.4, r * 0.32, -0.2, 0, Math.PI * 2);
  ctx.fill();
  // Ears — tall, pointed
  ctx.fillStyle = "#b07838";
  for (const oy of [-0.42, -0.22]) {
    ctx.beginPath();
    ctx.moveTo(x + r * 1.12, y + r * oy);
    ctx.lineTo(x + r * 1.35, y + r * (oy - 0.38));
    ctx.lineTo(x + r * 1.22, y + r * oy);
    ctx.closePath();
    ctx.fill();
  }
  // Eye
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.2, y - r * 0.2, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  // Thin legs as dark lines
  ctx.strokeStyle = "#8a5c28";
  ctx.lineWidth = 1.5;
  for (const [ox, leg] of [[-0.2, 0.72], [0.1, 0.75], [-0.5, 0.7], [-0.8, 0.68]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + r * ox, y + r * 0.48);
    ctx.lineTo(x + r * ox, y + r * leg);
    ctx.stroke();
  }
}

function drawElk(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.70;
  // Body — large dark brown
  ctx.fillStyle = "#5a3a1a";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.3, r * 0.72, 0, 0, Math.PI * 2);
  ctx.fill();
  // Pale rump and neck mane
  ctx.fillStyle = "#c8a040";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.7, y + r * 0.05, r * 0.5, r * 0.38, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c8a040";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.85, y - r * 0.15, r * 0.32, r * 0.48, 0.4, 0, Math.PI * 2);
  ctx.fill();
  // Head
  ctx.fillStyle = "#4a2a10";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.18, y - r * 0.18, r * 0.42, r * 0.3, -0.15, 0, Math.PI * 2);
  ctx.fill();
  // Dark muzzle
  ctx.fillStyle = "#3a2010";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.48, y - r * 0.1, r * 0.18, r * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  // Antler rack (top view — two branching lines)
  ctx.strokeStyle = "#6a4820";
  ctx.lineWidth = 2;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(x + r * 1.12, y - r * 0.35);
    ctx.lineTo(x + r * 1.12 + side * r * 0.25, y - r * 0.78);
    ctx.lineTo(x + r * 1.12 + side * r * 0.42, y - r * 0.62);
    ctx.moveTo(x + r * 1.12 + side * r * 0.25, y - r * 0.78);
    ctx.lineTo(x + r * 1.12 + side * r * 0.55, y - r * 0.95);
    ctx.stroke();
  }
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.32, y - r * 0.25, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  // Legs
  ctx.strokeStyle = "#3a2010";
  ctx.lineWidth = 2;
  for (const [ox, leg] of [[-0.1, 0.68], [0.2, 0.72], [-0.55, 0.65], [-0.85, 0.62]] as const) {
    ctx.beginPath();
    ctx.moveTo(x + r * ox, y + r * 0.52);
    ctx.lineTo(x + r * ox, y + r * leg);
    ctx.stroke();
  }
}

function drawGrouse(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.38;
  // Round body — speckled brown
  ctx.fillStyle = "#7a6038";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.1, r * 0.88, 0, 0, Math.PI * 2);
  ctx.fill();
  // Speckle pattern
  ctx.fillStyle = "rgba(200,170,100,0.45)";
  for (const [ox, oy] of [[-0.4,-0.2],[0.1,-0.4],[0.35,0.1],[-0.1,0.3],[0.5,-0.15]] as const) {
    ctx.beginPath();
    ctx.ellipse(x + r * ox, y + r * oy, r * 0.18, r * 0.12, ox * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = "rgba(40,25,10,0.3)";
  for (const [ox, oy] of [[0.3,-0.3],[-0.3,0.2],[0.0,-0.1],[0.45,0.25]] as const) {
    ctx.beginPath();
    ctx.ellipse(x + r * ox, y + r * oy, r * 0.15, r * 0.1, ox * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  // Small head
  ctx.fillStyle = "#6a5028";
  ctx.beginPath();
  ctx.arc(x + r * 0.9, y - r * 0.35, r * 0.42, 0, Math.PI * 2);
  ctx.fill();
  // Red eyebrow comb
  ctx.fillStyle = "#c23020";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.08, y - r * 0.58, r * 0.22, r * 0.1, -0.3, 0, Math.PI * 2);
  ctx.fill();
  // Eye
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.05, y - r * 0.45, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  // Short tail
  ctx.fillStyle = "#5a4828";
  ctx.beginPath();
  ctx.moveTo(x - r * 0.85, y - r * 0.1);
  ctx.lineTo(x - r * 1.42, y - r * 0.35);
  ctx.lineTo(x - r * 1.38, y + r * 0.2);
  ctx.closePath();
  ctx.fill();
}

function drawBear(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.72;
  // Massive body — very dark brown
  ctx.fillStyle = "#251810";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.28, r * 0.9, 0, 0, Math.PI * 2);
  ctx.fill();
  // Slightly lighter underbelly
  ctx.fillStyle = "#3a2a1a";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.1, y + r * 0.15, r * 0.7, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  // Broad round head
  ctx.fillStyle = "#251810";
  ctx.beginPath();
  ctx.arc(x + r * 1.1, y - r * 0.05, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  // Muzzle — tan snout
  ctx.fillStyle = "#7a5530";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.5, y + r * 0.08, r * 0.28, r * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // Nose
  ctx.fillStyle = "#1a1010";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.65, y + r * 0.05, r * 0.12, r * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  // Small round ears
  ctx.fillStyle = "#251810";
  for (const oy of [-0.48, -0.62]) {
    ctx.beginPath();
    ctx.arc(x + r * 0.95, y + r * oy, r * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
  // Eye
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.22, y - r * 0.22, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  // Eye shine
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.arc(x + r * 1.25, y - r * 0.25, r * 0.05, 0, Math.PI * 2);
  ctx.fill();
  // Thick paws
  ctx.fillStyle = "#1a1008";
  for (const [ox, oy] of [[-0.82,0.72],[0.15,0.82],[-0.42,0.8],[0.55,0.72]] as const) {
    ctx.beginPath();
    ctx.ellipse(x + r * ox, y + r * oy, r * 0.28, r * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawCougar(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.58;
  // Sleek elongated tawny body
  ctx.fillStyle = "#c88040";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.45, r * 0.58, 0, 0, Math.PI * 2);
  ctx.fill();
  // Lighter belly
  ctx.fillStyle = "#e8c088";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.1, y + r * 0.1, r * 0.8, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  // Head
  ctx.fillStyle = "#c07838";
  ctx.beginPath();
  ctx.arc(x + r * 1.3, y - r * 0.1, r * 0.45, 0, Math.PI * 2);
  ctx.fill();
  // Pale muzzle
  ctx.fillStyle = "#e8d0a0";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.6, y + r * 0.05, r * 0.22, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // Pointy ears
  ctx.fillStyle = "#b06828";
  for (const oy of [-0.4, -0.58]) {
    ctx.beginPath();
    ctx.moveTo(x + r * 1.18, y + r * oy);
    ctx.lineTo(x + r * 1.32, y + r * (oy - 0.3));
    ctx.lineTo(x + r * 1.42, y + r * oy);
    ctx.closePath();
    ctx.fill();
  }
  // Dark nose & eye
  ctx.fillStyle = "#2a1808";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.72, y + r * 0.02, r * 0.09, r * 0.07, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.48, y - r * 0.18, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  // Long thin tail curves back
  ctx.strokeStyle = "#b07030";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x - r * 1.28, y);
  ctx.quadraticCurveTo(x - r * 1.7, y - r * 0.6, x - r * 1.5, y - r * 1.0);
  ctx.stroke();
  // Dark tail tip
  ctx.strokeStyle = "#2a1808";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x - r * 1.58, y - r * 0.88);
  ctx.lineTo(x - r * 1.5, y - r * 1.0);
  ctx.stroke();
}

function drawWolf(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const r = TILE_SIZE * 0.55;
  // Body — medium grey with darker back saddle
  ctx.fillStyle = "#8a8878";
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.35, r * 0.68, 0, 0, Math.PI * 2);
  ctx.fill();
  // Dark dorsal saddle
  ctx.fillStyle = "#4a4840";
  ctx.beginPath();
  ctx.ellipse(x - r * 0.1, y - r * 0.15, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  // Pale underside
  ctx.fillStyle = "#c8c0a8";
  ctx.beginPath();
  ctx.ellipse(x + r * 0.15, y + r * 0.18, r * 0.72, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  // Angular head
  ctx.fillStyle = "#7a7868";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.15, y - r * 0.12, r * 0.48, r * 0.37, -0.1, 0, Math.PI * 2);
  ctx.fill();
  // Long narrow muzzle
  ctx.fillStyle = "#6a6858";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.5, y + r * 0.02, r * 0.28, r * 0.18, 0, 0, Math.PI * 2);
  ctx.fill();
  // Tall pointed ears
  ctx.fillStyle = "#6a6858";
  for (const ey of [-0.44, -0.65]) {
    ctx.beginPath();
    ctx.moveTo(x + r * 1.0, y + r * ey);
    ctx.lineTo(x + r * 1.18, y + r * (ey - 0.4));
    ctx.lineTo(x + r * 1.3, y + r * ey);
    ctx.closePath();
    ctx.fill();
  }
  // Inner ear pink
  ctx.fillStyle = "rgba(200,120,100,0.55)";
  for (const ey of [-0.44, -0.65]) {
    ctx.beginPath();
    ctx.moveTo(x + r * 1.05, y + r * ey);
    ctx.lineTo(x + r * 1.18, y + r * (ey - 0.28));
    ctx.lineTo(x + r * 1.25, y + r * ey);
    ctx.closePath();
    ctx.fill();
  }
  // Yellow eye
  ctx.fillStyle = "#d4a820";
  ctx.beginPath();
  ctx.arc(x + r * 1.28, y - r * 0.2, r * 0.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#111";
  ctx.beginPath();
  ctx.arc(x + r * 1.28, y - r * 0.2, r * 0.07, 0, Math.PI * 2);
  ctx.fill();
  // Nose
  ctx.fillStyle = "#1a1010";
  ctx.beginPath();
  ctx.ellipse(x + r * 1.68, y - r * 0.02, r * 0.1, r * 0.08, 0, 0, Math.PI * 2);
  ctx.fill();
  // Bushy tail
  ctx.fillStyle = "#7a7868";
  ctx.beginPath();
  ctx.moveTo(x - r * 1.18, y - r * 0.08);
  ctx.quadraticCurveTo(x - r * 1.55, y - r * 0.5, x - r * 1.4, y - r * 0.85);
  const grd2 = ctx.createLinearGradient(x - r * 1.18, y, x - r * 1.4, y - r * 0.85);
  grd2.addColorStop(0, "#7a7868");
  grd2.addColorStop(1, "#c8c0a8");
  ctx.strokeStyle = grd2;
  ctx.lineWidth = r * 0.4;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

function hpColor(frac: number): string {
  const r = Math.round(235 * (1 - frac));
  const g = Math.round(190 * frac + 20);
  return `rgb(${r},${g},60)`;
}

function buildingLabel(kind: BuildingState["kind"]): string {
  switch (kind) {
    case "shop":
      return "MARKET";
    case "boathouse":
      return "BOATS";
    case "dock":
      return "DOCK";
    default:
      return "";
  }
}

function buildingColor(kind: BuildingState["kind"]): string {
  switch (kind) {
    case "house":
      return "#c08a52";  // warm cedar siding
    case "shop":
      return "#b09068";  // weathered storefront
    case "boathouse":
      return "#8a6a42";  // dark stained timber
    case "dock":
      return "#7a5a36";
    default:
      return "#4a4038";
  }
}

const ROOF_COLORS: Record<string, string> = {
  house:     "#7a3b2e", // red shingle
  shop:      "#3f5d6b", // blue-grey metal
  boathouse: "#4a5a3a", // mossy green
};
