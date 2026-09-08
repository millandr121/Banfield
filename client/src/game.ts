import {
  Appearance,
  BuildingState,
  CRAFT_RECIPES,
  FOOD_VALUE,
  INVASIVE_LABEL,
  ITEM_IDS,
  ITEM_LABEL,
  WornSlot,
  SLOT_FOR_ITEM,
  ItemId,
  NpcState,
  PlantState,
  PlayerMode,
  PlayerState,
  ResourceNode,
  RoomDef,
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
  DEPTH_SWIM,
  isWaterTile,
  skillLevel,
} from "../../shared/protocol";
import { LogbookEntry, LeaderboardData } from "../../shared/protocol";
import { SPECIES, resourceSpeciesKey } from "../../shared/species";
import { Net } from "./net";
import terrainData from "./assets/terrain-settings.json";
import { drawItemIcon } from "./itemicon";
import { drawFullCreature, setCreatureDocProvider } from "./creatures";
import creatureSpriteData from "./assets/creature-sprites.json";
import playerSpriteData from "./assets/player-sprite.json";
import terrainSpritesData from "./assets/terrain-sprites.json";
import { SpriteDoc, normalizeLayers, docHasPaint, compositeFrame } from "../../shared/sprite";
import { Renderer3D, type PlayerView } from "./render3d";

// The editor saves painted sprites to localStorage (same origin as the game)
// AND writes the JSON asset files. localStorage is the live source of truth:
// reading it here means paint → save in the editor → reload the game shows the
// change instantly, without waiting on a file write / rebuild. The bundled JSON
// is the committed fallback when no local edits exist.
function loadDocs(bundled: unknown, lsKey: string): Record<string, SpriteDoc> {
  const out: Record<string, SpriteDoc> = {};
  const take = (src: unknown) => {
    const docs = (src as { docs?: Record<string, SpriteDoc> })?.docs ?? {};
    for (const [k, raw] of Object.entries(docs)) {
      const d = normalizeLayers(JSON.parse(JSON.stringify(raw)) as SpriteDoc);
      if (docHasPaint(d)) out[k] = d;
    }
  };
  take(bundled);
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) take(JSON.parse(raw)); // local edits override bundled
  } catch { /* ignore */ }
  return out;
}


// Painted creature sprite-docs (authored in the editor). Empty docs fall back
// to the procedural vector art. Each kind animates through its "down" frames.
const PAINTED_CREATURES = new Map<string, SpriteDoc>(
  Object.entries(loadDocs(creatureSpriteData, "banfield-creature-sprites")));
setCreatureDocProvider((kind) => {
  const doc = PAINTED_CREATURES.get(kind);
  if (!doc) return null;
  const clip = doc.animations.walk ? "walk" : doc.defaultClip;
  const frames = doc.animations[clip]?.facings.down?.length ?? 1;
  const frameIdx = Math.floor(performance.now() / 180) % Math.max(1, frames);
  return { doc, frameIdx, clip };
});

// Painted player sprites — all authored characters, keyed by id.
// `activePlayerCharId` tracks which one is currently shown for the local player.
// Cycle through them with [ / ] keys.
const ALL_PLAYER_SPRITES = new Map<string, SpriteDoc>(
  Object.entries(loadDocs(playerSpriteData, "banfield-player-sheet")));
let activePlayerCharId = (playerSpriteData as { active?: string }).active ?? "player";
{
  // Prefer the active id the editor last saved to localStorage.
  try {
    const raw = localStorage.getItem("banfield-player-sheet");
    if (raw) activePlayerCharId = (JSON.parse(raw) as { active?: string }).active ?? activePlayerCharId;
  } catch { /* ignore */ }
  // Fall back to first available if active key has no painted doc
  if (!ALL_PLAYER_SPRITES.has(activePlayerCharId)) {
    activePlayerCharId = ALL_PLAYER_SPRITES.keys().next().value ?? "player";
  }
}
let PLAYER_SPRITE: SpriteDoc | null = ALL_PLAYER_SPRITES.get(activePlayerCharId) ?? null;

// Terrain tiles pre-rendered to OffscreenCanvas for fast drawImage per-tile.
const TERRAIN_SPRITE_CACHE = new Map<string, OffscreenCanvas>();
{
  const docs = loadDocs(terrainSpritesData, "banfield-terrain-sprites");
  for (const [key, doc] of Object.entries(docs)) {
    const frame = doc.animations[doc.defaultClip]?.facings.down?.[0];
    if (!frame) continue;
    const px = compositeFrame(frame, doc.layerNames.map(() => true), doc.w, doc.h);
    const oc = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
    const octx = oc.getContext("2d")!;
    const scale = TILE_SIZE / doc.w;
    for (let ty = 0; ty < doc.h; ty++) {
      for (let tx = 0; tx < doc.w; tx++) {
        const c = px[ty * doc.w + tx];
        if (!c) continue;
        octx.fillStyle = c;
        octx.fillRect(Math.floor(tx * scale), Math.floor(ty * scale), Math.ceil(scale), Math.ceil(scale));
      }
    }
    TERRAIN_SPRITE_CACHE.set(key, oc);
  }
}

const CHARGE_MAX_MS = 600; // hold Space this long for a full-power swing
const HARVEST_RANGE_PX = 1.8 * TILE_SIZE; // client-side prompt range (cosmetic only)

const tc = (terrainData as { colors: Record<string, string> }).colors;
const TILE_COLORS: Record<Tile, string> = {
  [Tile.Water]:      tc.water      ?? "#287ab0",
  [Tile.FreshWater]: tc.freshwater ?? "#2a8878",
  [Tile.Sand]:       tc.sand       ?? "#d4c070",
  [Tile.Grass]:      tc.grass      ?? "#88b040",
  [Tile.Forest]:     tc.forest     ?? "#3a6228",
  [Tile.Hill]:       tc.hill       ?? "#8a7850",
  [Tile.Rock]:       tc.rock       ?? "#8a8278",
  [Tile.Road]:       tc.road       ?? "#606050",
  [Tile.Dock]:       tc.dock       ?? "#8a6038",
};

// ── Eastward-style tile texture helpers ──────────────────────────────────────
// Deterministic per-tile hash — stable decoration, never flickers.
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

  // Side panel (OSRS-style right panel) — now a click-to-open canvas drawer.
  private panelTab: "equip" | "skills" = "equip";
  private panelOpen = false;          // drawer hidden until a corner icon opens it

  // Canvas HUD hit-regions, rebuilt each frame (corner icons + quick-keys).
  private hudHits: Array<{ x: number; y: number; w: number; h: number; act: () => void }> = [];
  // Inventory-bag cell hit-regions (item id per cell) + the panel's bounds, so
  // a click can open the equip/drop menu at the pointer.
  private invHits: Array<{ x: number; y: number; w: number; h: number; id: ItemId }> = [];
  private invBounds: { x: number; y: number; w: number; h: number } | null = null;

  // Paint-wand tile overrides — persisted to localStorage.
  private tileOverrides = new Map<string, Tile>(); // "x,y" -> tile type
  private wandPanel: { tx: number; ty: number; scrollIdx: number } | null = null;
  private static readonly TILE_OVERRIDE_KEY = "banfield-tile-overrides";

  // Interior room state
  private room: RoomDef | null = null;
  private roomX = 0; // player tile position inside room
  private roomY = 0;

  // Login-screen hooks (main.ts wires these before the game proper starts).
  onNameStatus?: (name: string, taken: boolean) => void;
  onJoinDenied?: (reason: string) => void;
  private started = false;

  // Client-side prediction state
  private predX = 0;
  private predY = 0;
  private predVx = 0;       // horizontal velocity for accel/decel
  private predVy = 0;       // vertical velocity for accel/decel
  private predInitialized = false;
  private lastFrameMs = 0;

  // Jump physics (client-side visual — server still authoritative for position)
  private jumpVy = 0;       // upward velocity (negative = going up)
  private jumpOff = 0;      // current pixel offset above ground
  private jumpGrounded = true;

  // Smooth animation state
  private animSpeed = 0;    // smoothed speed for animation decisions
  private animState: "idle" | "walk" | "run" | "jump" | "fall" | "swim" = "idle";
  private predSwimming = false; // client-predicted swimming (matches predX/predY tile depth)

  private r3d: Renderer3D | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.net = new Net((m) => this.onServer(m));
    this.r3d = new Renderer3D(canvas, TILE_COLORS);
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
    this.canvas.addEventListener("mousedown", (e) => this.onCanvasMouseDown(e));
    this.canvas.addEventListener("mouseup", (e) => {
      if (e.button === 0 && this.chargeStart !== null && !this.chatOpen) {
        const held = performance.now() - this.chargeStart;
        this.chargeStart = null;
        const charge = Math.max(0, Math.min(1, held / CHARGE_MAX_MS));
        this.net.send({ t: "attack", charge });
        this.attackAnim.set(this.myId, { at: performance.now(), stance: this.me?.stance ?? "high" });
      }
    });
    this.canvas.addEventListener("wheel", (e) => this.onCanvasWheel(e), { passive: false });
    // Restore saved tile overrides
    try {
      const raw = localStorage.getItem(Game.TILE_OVERRIDE_KEY);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, number>;
        for (const [k, v] of Object.entries(obj)) this.tileOverrides.set(k, v as Tile);
      }
    } catch { /* ignore */ }
  }

  // HUD clicks: corner icons (bottom-right), quick-key belt, and the top-right
  // compass. Returns true if the click hit a HUD control (so it isn't treated
  // as a world click). Only the left button drives the HUD.
  private onCanvasMouseDown(e: MouseEvent) {
    if (!this.started || e.button !== 0) return;
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    // Open bag: click a cell for the equip/drop/eat menu (at the pointer);
    // clicks elsewhere on the panel are swallowed.
    if (this.invOpen && this.invBounds) {
      for (const h of this.invHits) {
        if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
          this.openItemMenu(h.id, e.clientX, e.clientY);
          e.preventDefault();
          return;
        }
      }
      const b = this.invBounds;
      if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
        this.closeItemMenu();
        e.preventDefault();
        return;
      }
    }
    // Compass (top-right circle) — click anywhere inside it opens the full map.
    const c = this.compassHit;
    if (c && Math.hypot(mx - c.cx, my - c.cy) <= c.r) {
      this.mapOpen = !this.mapOpen;
      e.preventDefault();
      return;
    }
    for (const h of this.hudHits) {
      if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
        h.act();
        e.preventDefault();
        return;
      }
    }
    // Wand panel click — dismiss or select a tile type
    if (this.wandPanel && this.wandHits.length) {
      for (const h of this.wandHits) {
        if (mx >= h.x && mx <= h.x + h.w && my >= h.y && my <= h.y + h.h) {
          h.act(mx, my);
          e.preventDefault();
          return;
        }
      }
      this.wandPanel = null;
      return;
    }
    // Paint-wand world click — open tile picker at clicked tile
    const me = this.snap?.players.find((p) => p.id === this.myId);
    if (me?.equipped === "paintWand" && this.map) {
      const z = this.zoom;
      const tx = Math.floor((mx / z + this.cam.x) / TILE_SIZE);
      const ty = Math.floor((my / z + this.cam.y) / TILE_SIZE);
      if (tx >= 0 && ty >= 0 && tx < this.map.width && ty < this.map.height) {
        const key = `${tx},${ty}`;
        const curTile = (this.tileOverrides.get(key) ?? this.map.tiles[ty * this.map.width + tx]) as Tile;
        const opts = this.wandOptions(tx, ty);
        // Start scroll at the current tile type if found
        let startIdx = opts.findIndex(([t]) => t === curTile);
        if (startIdx < 0) startIdx = 0;
        this.wandPanel = { tx, ty, scrollIdx: startIdx };
        e.preventDefault();
        return;
      }
    }
    // Left click on world = start attack charge. Middle/right belong to the
    // camera orbit and must never trigger a swing.
    if (e.button === 0 && !this.chatOpen && this.chargeStart === null) {
      this.chargeStart = performance.now();
    }
  }

  private onCanvasWheel(e: WheelEvent) {
    if (this.wandPanel) {
      const opts = this.wandOptions(this.wandPanel.tx, this.wandPanel.ty);
      const dir = e.deltaY > 0 ? 1 : -1;
      this.wandPanel.scrollIdx = (this.wandPanel.scrollIdx + dir + opts.length) % opts.length;
      e.preventDefault();
      return;
    }
    const cam = this.r3d?.camera;
    if (cam) {
      cam.zoomBy(Math.sign(e.deltaY) * 1.6);
      e.preventDefault();
    }
  }

  private compassHit: { cx: number; cy: number; r: number } | null = null;
  private wandHits: Array<{ x: number; y: number; w: number; h: number; act: (mx: number, my: number) => void }> = [];

  // Open the drawer at a given tab; clicking the active tab's icon closes it.
  private togglePanel(tab: typeof this.panelTab) {
    if (this.panelOpen && this.panelTab === tab) {
      this.panelOpen = false;
    } else {
      this.panelOpen = true;
      this.panelTab = tab;
    }
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
    this.r3d?.resize(window.innerWidth, window.innerHeight);
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
        if (this.jumpGrounded && !this.predSwimming) {
          this.jumpGrounded = false;
          this.jumpVy = 0;
          this.jumpOff = 0.1; // tiny lift to start
          this.net.send({ t: "jump" });
        }
        e.preventDefault();
        return;
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
          // Inside a room? E exits it.
          if (this.room) {
            this.net.send({ t: "exit-building" });
          } else {
            // Near an NPC? Talk instead of harvesting.
            const npc = this.nearbyNpc();
            if (npc) {
              this.npcOpen = this.npcOpen === npc.id ? null : npc.id;
            } else {
              // Near a building with a door? Enter it.
              const bld = this.nearbyBuilding();
              if (bld) {
                this.net.send({ t: "enter-building", buildingId: bld.id });
              } else {
                this.net.send({ t: "harvest" });
                this.net.send({ t: "repair" });
                this.net.send({ t: "drink" }); // sip from fresh water if beside a lake
              }
            }
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
        } else if (k === "[" || k === "]") {
          const ids = [...ALL_PLAYER_SPRITES.keys()];
          if (ids.length > 1) {
            const cur = ids.indexOf(activePlayerCharId);
            activePlayerCharId = ids[(cur + (k === "]" ? 1 : -1) + ids.length) % ids.length];
            PLAYER_SPRITE = ALL_PLAYER_SPRITES.get(activePlayerCharId) ?? null;
          }
          e.preventDefault();
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
          this.wandPanel = null;
          this.room = null;
          e.preventDefault();
        } else if (this.wandPanel && (k === "a" || k === "arrowleft")) {
          const opts = this.wandOptions(this.wandPanel.tx, this.wandPanel.ty);
          this.wandPanel.scrollIdx = (this.wandPanel.scrollIdx - 1 + opts.length) % opts.length;
          e.preventDefault();
        } else if (this.wandPanel && (k === "d" || k === "arrowright")) {
          const opts = this.wandOptions(this.wandPanel.tx, this.wandPanel.ty);
          this.wandPanel.scrollIdx = (this.wandPanel.scrollIdx + 1) % opts.length;
          e.preventDefault();
        } else if (this.wandPanel && k === "enter") {
          this.applyWandSelection();
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

  private roomMoveTimer = 0;
  private sendInput() {
    // Room movement is local — no server input needed
    if (this.room) {
      const now = performance.now();
      if (now - this.roomMoveTimer > 180) {
        let rx = 0, ry = 0;
        if (this.keys.has("w") || this.keys.has("arrowup")) ry -= 1;
        if (this.keys.has("s") || this.keys.has("arrowdown")) ry += 1;
        // Don't intercept A/D for room movement when wand panel is open
        if (!this.wandPanel) {
          if (this.keys.has("a") || this.keys.has("arrowleft")) rx -= 1;
          if (this.keys.has("d") || this.keys.has("arrowright")) rx += 1;
        }
        if (rx !== 0 || ry !== 0) {
          this.roomMoveTimer = now;
          const nx = this.roomX + rx, ny = this.roomY + ry;
          if (nx >= 0 && ny >= 0 && nx < this.room.width && ny < this.room.height) {
            const tile = this.room.tiles[ny * this.room.width + nx];
            if (tile.kind !== "wall") {
              this.roomX = nx; this.roomY = ny;
              // Standing on the door tile exits the room
              if (tile.kind === "door") this.net.send({ t: "exit-building" });
            }
          }
        }
      }
      return;
    }
    const { ix: dx, iy: dy } = this.moveInput();
    const sprint = this.keys.has("shift");
    // Camera-relative input varies continuously as the view orbits, so resend
    // on a small delta rather than only on an exact change.
    const moved = Math.abs(dx - this.lastDir.x) + Math.abs(dy - this.lastDir.y) > 0.02;
    if (moved || sprint !== this.lastSprint) {
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
      this.r3d?.setMap(this.map, this.tileOverrides);
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
        this.r3d?.invalidateTiles(m.cx * CHUNK, m.cy * CHUNK, m.w, m.h);
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
    } else if (m.t === "room") {
      this.room = m.def;
      this.roomX = m.playerX;
      this.roomY = m.playerY;
    } else if (m.t === "room-exit") {
      this.room = null;
    }
  }

  private frame() {
    const now = performance.now();
    const dt = this.lastFrameMs === 0 ? 0.016 : Math.min((now - this.lastFrameMs) / 1000, 0.05);
    this.lastFrameMs = now;
    this.tickPrediction(dt);
    this.sendInput();
    this.render(dt);
    requestAnimationFrame(() => this.frame());
  }

  private tickPrediction(dt: number) {
    const me = this.me;
    if (!me || !this.map) return;
    const map = this.map;

    // One-time init from server position
    if (!this.predInitialized) {
      this.predX = me.x;
      this.predY = me.y;
      this.predInitialized = true;
    }

    // Client-side tile helpers — mirrors server logic for same-frame response
    const tileAt = (px: number, py: number): Tile => {
      const tx = Math.floor(px + 0.5);
      const ty = Math.floor(py + 0.5);
      if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return Tile.Water;
      return (this.tileOverrides.get(`${tx},${ty}`) ?? map.tiles[ty * map.width + tx]) as Tile;
    };
    const isSolid = (px: number, py: number): boolean => tileAt(px, py) === Tile.Rock;

    // Client-side swimming: predict depth from local waterline so water entry/exit
    // responds in the same frame as movement, not 100 ms later from the server.
    const waterline = this.snap?.waterline ?? 0;
    const etx = Math.max(0, Math.min(map.width - 1, Math.floor(this.predX + 0.5)));
    const ety = Math.max(0, Math.min(map.height - 1, Math.floor(this.predY + 0.5)));
    const elev = map.elevation[ety * map.width + etx] ?? 0;
    const predSwimming = isWaterTile(tileAt(this.predX, this.predY)) || (waterline - elev) >= DEPTH_SWIM;
    this.predSwimming = predSwimming;

    const { ix, iy } = this.moveInput();
    const sprint = this.keys.has("shift") && !predSwimming;
    const baseSpeed = predSwimming ? 2.4 : sprint ? 4.5 * 1.85 : 4.5;
    const targetVx = ix * baseSpeed;
    const targetVy = iy * baseSpeed;

    // Smooth acceleration / deceleration
    const blend = Math.min(1, 14 * dt);
    this.predVx += (targetVx - this.predVx) * blend;
    this.predVy += (targetVy - this.predVy) * blend;

    // Axis-separated solid tile collision — mirrors server movePlayers()
    const nextX = this.predX + this.predVx * dt;
    const nextY = this.predY + this.predVy * dt;
    if (!isSolid(nextX, this.predY)) { this.predX = nextX; } else { this.predVx = 0; }
    if (!isSolid(this.predX, nextY)) { this.predY = nextY; } else { this.predVy = 0; }

    // Reconcile with server position — smooth pull toward server, snap if too far
    const errX = me.x - this.predX;
    const errY = me.y - this.predY;
    const dist = Math.hypot(errX, errY);
    if (dist > 2.5) {
      this.predX = me.x;
      this.predY = me.y;
    } else {
      const pull = Math.min(1, 7 * dt);
      this.predX += errX * pull;
      this.predY += errY * pull;
    }

    // Jump physics — client-side only (server still tracks jumpPhase for other players)
    const GRAVITY = 36;
    if (!this.jumpGrounded) {
      this.jumpVy += GRAVITY * dt;
      this.jumpOff -= this.jumpVy * dt * TILE_SIZE;
      if (this.jumpOff <= 0 || predSwimming) {
        // Land normally, or splash-land immediately when entering water
        this.jumpOff = 0;
        this.jumpVy = 0;
        this.jumpGrounded = true;
      }
    }

    // Animation state
    const speed = Math.hypot(this.predVx, this.predVy);
    this.animSpeed += (speed - this.animSpeed) * Math.min(1, 10 * dt);

    if (predSwimming) {
      this.animState = "swim";
    } else if (!this.jumpGrounded && this.jumpVy < 0) {
      this.animState = "jump";
    } else if (!this.jumpGrounded && this.jumpVy > 0) {
      this.animState = "fall";
    } else if (this.animSpeed > 5.5) {
      this.animState = "run";
    } else if (this.animSpeed > 0.3) {
      this.animState = "walk";
    } else {
      this.animState = "idle";
    }

    // The 3D orbit camera follows the player in Renderer3D.render(); arrow keys
    // steer it OSRS-style rather than moving the character.
    this.tickCameraKeys(dt);
  }

  /** Arrow keys orbit the camera (OSRS convention); WASD moves the character. */
  private tickCameraKeys(dt: number) {
    const cam = this.r3d?.camera;
    if (!cam) return;
    const rate = 2.1 * dt;
    if (this.keys.has("arrowleft"))  cam.yawBy(rate);
    if (this.keys.has("arrowright")) cam.yawBy(-rate);
    if (this.keys.has("arrowup"))    cam.pitchBy(rate * 0.7);
    if (this.keys.has("arrowdown"))  cam.pitchBy(-rate * 0.7);
  }

  /**
   * WASD is interpreted in camera space and rotated into world space, so "W"
   * always means "away from the camera" no matter how the view is orbited.
   * Prediction and the input sent to the server both go through here so they
   * can never disagree about which way the player is walking.
   */
  private moveInput(): { ix: number; iy: number } {
    let fwd = 0, strafe = 0;
    if (this.keys.has("w")) fwd += 1;
    if (this.keys.has("s")) fwd -= 1;
    if (this.keys.has("d")) strafe += 1;
    if (this.keys.has("a")) strafe -= 1;
    const len = Math.hypot(fwd, strafe);
    if (len === 0) return { ix: 0, iy: 0 };
    fwd /= len; strafe /= len;
    const b = this.r3d?.basis() ?? { fx: 0, fy: -1, rx: 1, ry: 0 };
    return { ix: b.fx * fwd + b.rx * strafe, iy: b.fy * fwd + b.ry * strafe };
  }

  // --- rendering ------------------------------------------------------------
  private render(dt = 0) {
    const ctx = this.ctx;
    // The 3D canvas sits behind this one and paints the sky, so the HUD layer
    // must stay transparent rather than filling a background.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map || !this.snap) return;

    const me = this.snap.players.find((p) => p.id === this.myId);

    // === World pass: 3D scene ===
    if (this.r3d) {
      const fx = this.predInitialized ? this.predX : (me?.x ?? 0);
      const fy = this.predInitialized ? this.predY : (me?.y ?? 0);
      this.r3d.setWaterline(this.snap.waterline);
      this.r3d.syncPlayers(this.playerViews(), dt);
      this.r3d.render(dt, fx, fy, this.elevAtTile(fx, fy));
    }

    // === World-anchored UI: projected through the 3D camera, in screen px ===
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

    // === Screen pass: HUD & modals at 1:1 (unscaled) ===

    this.drawHud(this.snap, me);
    this.drawCornerHud(me);
    if (this.panelOpen && this.panelTab === "equip") this.drawEquipPanel(me);
    if (this.panelOpen && this.panelTab === "skills") this.drawSkillsPanel(me);
    if (this.craftOpen) this.drawCraftPanel(me);
    if (this.room) this.drawRoom();
    if (this.shopId) this.drawShopPanel(me);
    if (this.invOpen) this.drawInventoryPanel(me);
    if (this.npcOpen) this.drawNpcDialogue(me);
    if (this.mapOpen) this.drawMapOverlay(me);
    if (this.wandPanel) this.drawWandPanel(me);
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
    if (this.r3d) {
      const p = this.r3d.project(tx, ty, this.elevAtTile(tx, ty));
      return { sx: p.sx, sy: p.sy };
    }
    return { sx: tx * TILE_SIZE - this.cam.x, sy: ty * TILE_SIZE - this.cam.y };
  }

  private elevAtTile(tx: number, ty: number): number {
    const m = this.map;
    if (!m) return 0;
    const x = Math.max(0, Math.min(m.width - 1, Math.floor(tx + 0.5)));
    const y = Math.max(0, Math.min(m.height - 1, Math.floor(ty + 0.5)));
    return m.elevation[y * m.width + x] ?? 0;
  }

  /** Snapshot players → 3D rig views. Self uses the predicted position. */
  private playerViews(): PlayerView[] {
    const snap = this.snap;
    if (!snap) return [];
    const out: PlayerView[] = [];
    for (const p of snap.players) {
      if (p.dead || p.vehicleId) continue;
      const isMe = p.id === this.myId;
      const x = isMe && this.predInitialized ? this.predX : p.x;
      const y = isMe && this.predInitialized ? this.predY : p.y;

      let state: PlayerView["state"];
      let speed: number;
      if (isMe) {
        state = this.animState;
        speed = this.animSpeed;
      } else {
        const gait = this.gaitFor(p.id, p.x, p.y);
        state = p.swimming ? "swim" : p.jumping ? "jump"
          : gait.running && gait.moving ? "run" : gait.moving ? "walk" : "idle";
        speed = gait.moving ? (gait.running ? 8 : 4) : 0;
      }

      // jumpOff is tracked in pixels by the predictor; the scene works in tiles.
      const lift = isMe
        ? this.jumpOff / TILE_SIZE
        : (p.jumping ? Math.sin((p.jumpPhase ?? 0) * Math.PI) * 0.8 : 0);

      const a = p.appearance;
      out.push({
        id: p.id, x, y,
        elevation: this.elevAtTile(x, y),
        heading: p.dir,
        state, speed, lift,
        colors: { skin: a?.skin, hair: a?.hair, shirt: a?.shirt, pants: a?.pants },
      });
    }
    return out;
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

      // Ingredients — colored icon swatch + quantity + label
      const swatchSize = 10;
      let nx = px + 16;
      const ny = ry + 30;
      ctx.font = "11px system-ui";
      for (const [item, qty] of Object.entries(r.needs) as [ItemId, number][]) {
        const have = me?.inventory[item] ?? 0;
        const okColor = have >= qty ? "#7ec8a0" : "#e57373";
        // Colored swatch
        const swatchCol = (ITEM_COLORS as Record<string, string>)[item] ?? "#888";
        ctx.fillStyle = swatchCol;
        roundRect(ctx, nx, ny - swatchSize + 1, swatchSize, swatchSize, 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.4)";
        ctx.lineWidth = 0.5;
        roundRect(ctx, nx, ny - swatchSize + 1, swatchSize, swatchSize, 2);
        ctx.stroke();
        nx += swatchSize + 2;
        ctx.fillStyle = okColor;
        const txt = `${qty} ${ITEM_LABEL[item]}  `;
        ctx.textAlign = "left";
        ctx.fillText(txt, nx, ny);
        nx += ctx.measureText(txt).width;
      }
      if (Object.keys(r.gives).length > 0) {
        ctx.fillStyle = "#5a7a8a";
        ctx.fillText("→", nx, ny);
        nx += ctx.measureText("→  ").width;
        for (const [item, qty] of Object.entries(r.gives) as [ItemId, number][]) {
          const swatchCol = (ITEM_COLORS as Record<string, string>)[item] ?? "#888";
          ctx.fillStyle = swatchCol;
          roundRect(ctx, nx, ny - swatchSize + 1, swatchSize, swatchSize, 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.4)";
          ctx.lineWidth = 0.5;
          roundRect(ctx, nx, ny - swatchSize + 1, swatchSize, swatchSize, 2);
          ctx.stroke();
          nx += swatchSize + 2;
          ctx.fillStyle = "#a0c8e0";
          ctx.fillText(`${qty} ${ITEM_LABEL[item]}`, nx, ny);
        }
      }
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

    // Player position — animated amber beacon, hard to miss.
    if (me) {
      const px = ox + Math.round(me.x) * scale;
      const py = oy + Math.round(me.y) * scale;
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 350);
      const rOuter = 5 + pulse * 4;
      // Drop shadow so it reads on any tile colour
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.beginPath(); ctx.arc(px + 1, py + 1, rOuter + 1.5, 0, Math.PI * 2); ctx.fill();
      // Pulsing outer ring
      ctx.strokeStyle = `rgba(255,215,0,${0.45 + 0.5 * pulse})`;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(px, py, rOuter, 0, Math.PI * 2); ctx.stroke();
      // Inner ring
      ctx.strokeStyle = "rgba(255,255,180,0.85)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.stroke();
      // Solid amber fill
      ctx.fillStyle = "#ffca28";
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
      // White hot centre
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(px, py, 1.8, 0, Math.PI * 2); ctx.fill();
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

  // --- interior room renderer -----------------------------------------------
  private drawRoom() {
    if (!this.room) return;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const R = this.room;
    const TS = 40; // room tile size in pixels
    const offX = Math.floor(W / 2 - this.roomX * TS - TS / 2);
    const offY = Math.floor(H / 2 - this.roomY * TS - TS / 2);

    // Black overlay
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fillRect(0, 0, W, H);

    // Draw room tiles
    for (let ry = 0; ry < R.height; ry++) {
      for (let rx = 0; rx < R.width; rx++) {
        const tile = R.tiles[ry * R.width + rx];
        const sx = offX + rx * TS, sy = offY + ry * TS;
        // Tile base colour
        switch (tile.kind) {
          case "wall":    ctx.fillStyle = (tile.variant ?? 0) % 2 === 0 ? "#5c4a3a" : "#6b5848"; break;
          case "floor":   ctx.fillStyle = (tile.variant ?? 0) % 2 === 0 ? "#c8b89a" : "#bfae8f"; break;
          case "door":    ctx.fillStyle = "#8b5e3c"; break;
          case "window":  ctx.fillStyle = "#4a8aaa"; break;
          case "rug":     ctx.fillStyle = "#7a4a8c"; break;
          case "stairs":  ctx.fillStyle = "#a09070"; break;
          default:        ctx.fillStyle = "#888";
        }
        ctx.fillRect(sx, sy, TS, TS);
        // Tile border
        ctx.strokeStyle = "rgba(0,0,0,0.25)"; ctx.lineWidth = 1;
        ctx.strokeRect(sx, sy, TS, TS);
        // Door marker
        if (tile.kind === "door") {
          ctx.font = "18px serif"; ctx.textAlign = "center";
          ctx.fillStyle = "#f5deb3";
          ctx.fillText("🚪", sx + TS / 2, sy + TS / 2 + 6);
        }
        // Window detail
        if (tile.kind === "window") {
          ctx.strokeStyle = "#9dd8f0"; ctx.lineWidth = 1.5;
          ctx.strokeRect(sx + 6, sy + 6, TS - 12, TS - 12);
        }
        // Rug pattern
        if (tile.kind === "rug") {
          ctx.strokeStyle = "#a06cc0"; ctx.lineWidth = 2;
          ctx.strokeRect(sx + 5, sy + 5, TS - 10, TS - 10);
        }
      }
    }

    // Player avatar (simple circle)
    const px = offX + this.roomX * TS + TS / 2;
    const py2 = offY + this.roomY * TS + TS / 2;
    ctx.fillStyle = "#ffd54f";
    ctx.beginPath(); ctx.arc(px, py2, 10, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py2, 10, 0, Math.PI * 2); ctx.stroke();

    // HUD: building name + exit hint
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    ctx.fillRect(0, 0, W, 32);
    ctx.font = "bold 14px system-ui"; ctx.textAlign = "center";
    ctx.fillStyle = "#ffd54f";
    ctx.fillText("Interior  ·  Walk to door or press E to exit", W / 2, 21);
  }

  // --- paint-wand tile picker -----------------------------------------------
  private saveTileOverrides() {
    const obj: Record<string, number> = {};
    for (const [k, v] of this.tileOverrides) obj[k] = v;
    localStorage.setItem(Game.TILE_OVERRIDE_KEY, JSON.stringify(obj));
  }

  // Returns the tile options compatible with the tile at (tx,ty).
  // Land tiles can only be swapped with land, water with water.
  private wandOptions(tx: number, ty: number): [Tile, string][] {
    const LAND: [Tile, string][] = [
      [Tile.Grass, "Grass"], [Tile.Forest, "Forest"], [Tile.Sand, "Sand"],
      [Tile.Hill, "Hill"], [Tile.Rock, "Rock"], [Tile.Road, "Road"],
    ];
    const WATER: [Tile, string][] = [
      [Tile.Water, "Ocean"], [Tile.FreshWater, "Fresh Water"], [Tile.Dock, "Dock"],
    ];
    if (!this.map) return LAND;
    const t = (this.tileOverrides.get(`${tx},${ty}`) ?? this.map.tiles[ty * this.map.width + tx]) as Tile;
    return (t === Tile.Water || t === Tile.FreshWater || t === Tile.Dock) ? WATER : LAND;
  }

  // Draw the scrollable bottom-bar wand picker.
  private drawWandPanel(_me?: PlayerState) {
    if (!this.wandPanel || !this.map) return;
    const ctx = this.ctx;
    const { tx, ty, scrollIdx } = this.wandPanel;
    const key = `${tx},${ty}`;
    const curTile = (this.tileOverrides.get(key) ?? this.map.tiles[ty * this.map.width + tx]) as Tile;
    const opts = this.wandOptions(tx, ty);

    this.wandHits = [];
    const W = this.canvas.width, H = this.canvas.height;

    // ── Apply-mode buttons row (above the swatch bar) ──────────────────────
    const BTN_H = 22, BTN_Y = H - 88;
    const MODES: Array<{ label: string; key: string; act: () => void }> = [
      { label: "This tile [Enter]", key: "single",
        act: () => this.applyTileOverride(tx, ty, curTile, "single") },
      { label: "All similar", key: "all",
        act: () => this.applyTileOverride(tx, ty, curTile, "all") },
      { label: "Radius 5", key: "radius",
        act: () => this.applyTileOverride(tx, ty, curTile, "radius") },
      { label: "Clear tile", key: "clear",
        act: () => { this.tileOverrides.delete(key); this.saveTileOverrides(); this.wandPanel = null; } },
      { label: "✕ Cancel", key: "close",
        act: () => { this.wandPanel = null; } },
    ];
    const totalBW = W - 40, bW = Math.floor(totalBW / MODES.length) - 4;
    for (let i = 0; i < MODES.length; i++) {
      const bx = 20 + i * (bW + 4);
      const isClear = MODES[i].key === "clear" || MODES[i].key === "close";
      ctx.fillStyle = isClear ? "rgba(100,30,30,0.8)" : "rgba(0,80,110,0.9)";
      ctx.fillRect(bx, BTN_Y, bW, BTN_H);
      ctx.strokeStyle = isClear ? "#a05050" : "#0098b8"; ctx.lineWidth = 1;
      ctx.strokeRect(bx, BTN_Y, bW, BTN_H);
      ctx.font = "11px system-ui"; ctx.textAlign = "center";
      ctx.fillStyle = "#d8eef5";
      ctx.fillText(MODES[i].label, bx + bW / 2, BTN_Y + 15);
      const act = MODES[i].act;
      this.wandHits.push({ x: bx, y: BTN_Y, w: bW, h: BTN_H, act: () => act() });
    }

    // ── Scrollable swatch row ───────────────────────────────────────────────
    const CELL = 60, VISIBLE = Math.min(opts.length, Math.floor((W - 80) / CELL));
    const BAR_H = 60, BAR_Y = H - BAR_H;
    const totalW = VISIBLE * CELL;
    const startX = Math.floor(W / 2 - totalW / 2);

    // Dark bar background
    ctx.fillStyle = "rgba(6,18,28,0.95)";
    ctx.fillRect(0, BAR_Y - 2, W, BAR_H + 2);
    ctx.strokeStyle = "#007b94"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, BAR_Y - 2); ctx.lineTo(W, BAR_Y - 2); ctx.stroke();

    // Label above bar
    ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = "#ffd54f";
    ctx.fillText(`✦ Paint Wand  ·  (${tx},${ty})  ·  current: ${Tile[curTile] ?? curTile}  ·  ◄ A/D or scroll ►  ·  Enter to apply`, W / 2, BAR_Y - 6);

    // Draw the center ± half visible slots
    const half = Math.floor(VISIBLE / 2);
    for (let slot = 0; slot < VISIBLE; slot++) {
      const optIdx = ((scrollIdx - half + slot) % opts.length + opts.length) % opts.length;
      const [tileType, name] = opts[optIdx];
      const isCenter = slot === half;
      const cx2 = startX + slot * CELL;
      const cy2 = BAR_Y + 2;
      const cw = CELL - 4, ch = BAR_H - 8;

      // Highlight center
      if (isCenter) {
        ctx.fillStyle = "rgba(0,188,212,0.3)";
        ctx.fillRect(cx2 - 2, cy2 - 2, cw + 4, ch + 4);
        ctx.strokeStyle = "#00bcd4"; ctx.lineWidth = 2;
        ctx.strokeRect(cx2 - 2, cy2 - 2, cw + 4, ch + 4);
      }

      // Colour swatch
      ctx.fillStyle = TILE_COLORS[tileType] ?? "#555";
      ctx.fillRect(cx2 + 4, cy2 + 4, cw - 8, cw - 8);
      ctx.strokeStyle = isCenter ? "#00e5ff" : "rgba(0,0,0,0.5)"; ctx.lineWidth = 1;
      ctx.strokeRect(cx2 + 4, cy2 + 4, cw - 8, cw - 8);

      // Name
      ctx.font = isCenter ? "bold 10px system-ui" : "10px system-ui";
      ctx.textAlign = "center";
      ctx.fillStyle = isCenter ? "#ffffff" : "#8fb4c9";
      ctx.fillText(name, cx2 + cw / 2, cy2 + ch - 4);

      // Click → scroll to this option
      const capturedOptIdx = optIdx;
      this.wandHits.push({ x: cx2, y: cy2, w: cw, h: ch, act: () => {
        this.wandPanel!.scrollIdx = capturedOptIdx;
      }});
    }

    // Scroll arrow hints
    ctx.font = "18px system-ui"; ctx.fillStyle = "rgba(0,188,212,0.7)";
    ctx.textAlign = "center";
    ctx.fillText("◄", startX - 16, BAR_Y + BAR_H / 2);
    ctx.fillText("►", startX + totalW + 16, BAR_Y + BAR_H / 2);
  }

  private applyWandSelection() {
    if (!this.wandPanel || !this.map) return;
    const { tx, ty, scrollIdx } = this.wandPanel;
    const opts = this.wandOptions(tx, ty);
    const [tileType] = opts[scrollIdx % opts.length];
    this.tileOverrides.set(`${tx},${ty}`, tileType);
    this.saveTileOverrides();
    this.wandPanel = null;
  }

  private applyTileOverride(tx: number, ty: number, _fromTile: Tile, mode: "single" | "all" | "radius") {
    if (!this.wandPanel || !this.map) return;
    const opts = this.wandOptions(tx, ty);
    const [newTile] = opts[this.wandPanel.scrollIdx % opts.length];
    this.tileOverrides.set(`${tx},${ty}`, newTile);
    if (mode === "all") {
      const srcTile = this.map.tiles[ty * this.map.width + tx] as Tile;
      for (let y = 0; y < this.map.height; y++) {
        for (let x = 0; x < this.map.width; x++) {
          const t = this.map.tiles[y * this.map.width + x] as Tile;
          if (t === srcTile) this.tileOverrides.set(`${x},${y}`, newTile);
        }
      }
    } else if (mode === "radius") {
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
        if (dx * dx + dy * dy > 25) continue;
        const nx = tx + dx, ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= this.map.width || ny >= this.map.height) continue;
        const t = this.map.tiles[ny * this.map.width + nx] as Tile;
        if (t === (this.map.tiles[ty * this.map.width + tx] as Tile)) {
          this.tileOverrides.set(`${nx},${ny}`, newTile);
        }
      }
    }
    this.saveTileOverrides();
    this.wandPanel = null;
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
      // Colored icon swatch
      const swatchCol = (ITEM_COLORS as Record<string, string>)[ln.item] ?? "#888";
      ctx.fillStyle = swatchCol;
      roundRect(ctx, px + 28, y - 11, 12, 12, 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 0.5;
      roundRect(ctx, px + 28, y - 11, 12, 12, 2);
      ctx.stroke();
      ctx.fillStyle = "#eaf2f8";
      ctx.fillText(`${i + 1}.  ${label}`, px + 44, y);
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
    this.invHits = [];
    const cols = 5;
    const cell = 72, gap = 6;
    const pad = 18;
    const pw = cols * cell + (cols - 1) * gap + pad * 2;
    const items = me
      ? (ITEM_IDS as readonly ItemId[]).filter((id) => (me.inventory[id] ?? 0) > 0)
      : [];
    const rows = Math.max(1, Math.ceil(items.length / cols));
    const ph = 54 + rows * (cell + gap) + 34;
    const px = this.canvas.width / 2 - pw / 2;
    const py = this.canvas.height / 2 - ph / 2;
    this.invBounds = { x: px, y: py, w: pw, h: ph };

    ctx.fillStyle = "rgba(7,19,28,0.96)";
    roundRect(ctx, px, py, pw, ph, 12); ctx.fill();
    ctx.strokeStyle = "#ffb300"; ctx.lineWidth = 2;
    roundRect(ctx, px, py, pw, ph, 12); ctx.stroke();

    ctx.fillStyle = "#ffe9b0"; ctx.font = "bold 16px system-ui"; ctx.textAlign = "left";
    ctx.fillText("🎒 BAG", px + pad, py + 30);
    ctx.fillStyle = "#7fa8c8"; ctx.font = "12px system-ui"; ctx.textAlign = "right";
    ctx.fillText("Click an item for options · [I]/Esc close", px + pw - pad, py + 30);

    if (items.length === 0) {
      ctx.fillStyle = "#5a7f96"; ctx.font = "14px system-ui"; ctx.textAlign = "center";
      ctx.fillText("Your bag is empty — go gather, hunt, or fish.", px + pw / 2, py + ph / 2);
    }

    items.forEach((id, i) => {
      const cx = px + pad + (i % cols) * (cell + gap);
      const cy = py + 46 + Math.floor(i / cols) * (cell + gap);
      const equipped = me!.equipped === id || Object.values(me!.appearance?.worn ?? {}).includes(id);
      // Slot
      ctx.fillStyle = "rgba(10,28,41,0.85)";
      roundRect(ctx, cx, cy, cell, cell, 8); ctx.fill();
      ctx.strokeStyle = equipped ? "#ffd54f" : "rgba(120,180,220,0.22)";
      ctx.lineWidth = equipped ? 2 : 1;
      roundRect(ctx, cx, cy, cell, cell, 8); ctx.stroke();
      // Icon (big, centred) with colour-swatch fallback.
      const isz = 44;
      if (!drawItemIcon(ctx, id, cx + (cell - isz) / 2, cy + 6, isz)) {
        ctx.fillStyle = (ITEM_COLORS as Record<string, string>)[id] ?? "#888";
        roundRect(ctx, cx + 16, cy + 12, cell - 32, 32, 6); ctx.fill();
      }
      // Quantity badge, top-right corner.
      const qty = me!.inventory[id] ?? 0;
      if (qty > 1) {
        ctx.font = "bold 12px system-ui"; ctx.textAlign = "right";
        const txt = `${qty}`;
        const bw = ctx.measureText(txt).width + 8;
        ctx.fillStyle = "rgba(6,14,20,0.9)";
        roundRect(ctx, cx + cell - bw - 3, cy + 3, bw, 16, 5); ctx.fill();
        ctx.fillStyle = "#ffe9a0";
        ctx.fillText(txt, cx + cell - 6, cy + 15);
      }
      // Label, bottom.
      ctx.fillStyle = equipped ? "#ffe9a0" : "#9fc2d6"; ctx.font = "9px system-ui"; ctx.textAlign = "center";
      const lbl = ITEM_LABEL[id];
      ctx.fillText(lbl.length > 12 ? lbl.slice(0, 11) + "…" : lbl, cx + cell / 2, cy + cell - 6);
      this.invHits.push({ x: cx, y: cy, w: cell, h: cell, id });
    });

    ctx.fillStyle = "#9fe6c0"; ctx.font = "13px system-ui"; ctx.textAlign = "left";
    ctx.fillText(`$${me?.money ?? 0}`, px + pad, py + ph - 14);
    ctx.textAlign = "right";
    ctx.fillStyle = me && me.hunger < me.maxHunger * 0.25 ? "#e57373" : "#cfe3ef";
    ctx.fillText(`Hunger ${Math.round(me?.hunger ?? 0)}/${me?.maxHunger ?? 100}`, px + pw - pad, py + ph - 14);
  }

  // --- NPCs -----------------------------------------------------------------
  private nearbyBuilding(): BuildingState | undefined {
    if (!this.snap) return undefined;
    const me = this.snap.players.find((p) => p.id === this.myId);
    if (!me) return undefined;
    let best: BuildingState | undefined;
    let bestD = 6;
    for (const b of this.snap.buildings ?? []) {
      const d = Math.hypot(b.x + b.w / 2 - me.x, b.y + b.h / 2 - me.y);
      if (d <= bestD) { bestD = d; best = b; }
    }
    return best;
  }

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
    // Nearby building entry prompt (shows if no harvest prompt)
    if (!label) {
      const bld = this.nearbyBuilding();
      if (bld) {
        const bName = bld.name ?? "building";
        if (bld.locked && bld.ownerId) {
          label = `${bld.ownerName ? `${bld.ownerName}'s` : "This"} ${bName} is locked`;
          color = "#f44336";
        } else {
          label = `Press E — enter ${bName}`;
          color = "#a0c8e0";
        }
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

  // ─── Canvas equip panel ────────────────────────────────────────────────────
  private drawEquipPanel(me?: PlayerState) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const pw = 220, ph = H;
    const px = W - pw;
    const pad = 12;

    // Background
    ctx.fillStyle = "rgba(6,14,22,0.96)";
    ctx.fillRect(px, 0, pw, ph);
    ctx.strokeStyle = "#1d4a66";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ph); ctx.stroke();

    // Title + close
    ctx.fillStyle = "#ffd54f";
    ctx.font = "bold 14px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("EQUIPMENT", px + pad, 28);
    ctx.fillStyle = "#4a7a9b";
    ctx.font = "bold 16px system-ui";
    ctx.textAlign = "right";
    ctx.fillText("×", W - pad, 28);
    this.hudHits.push({ x: W - 28, y: 8, w: 20, h: 22, act: () => { this.panelOpen = false; } });

    if (!me) return;
    const worn = me.appearance?.worn ?? {};

    // Paper-doll slots
    const slotW = pw - pad * 2, slotH = 42;
    const slots: Array<[WornSlot, string]> = [
      ["head", "Head"],
      ["torso", "Torso"],
      ["legs", "Legs"],
      ["back", "Back"],
    ];
    const handLabel = me.mode === "combat" ? "Weapon" : me.mode === "research" ? "Tool" : "Gear";

    let sy = 44;
    for (const [slot, label] of slots) {
      const itemId = worn[slot] as ItemId | undefined;
      this.drawEquipSlotRow(ctx, px + pad, sy, slotW, slotH, label, itemId, me);
      if (itemId) {
        const capturedId = itemId;
        const cx = px + pad + slotW / 2, cy = sy + slotH / 2;
        this.hudHits.push({ x: px + pad, y: sy, w: slotW, h: slotH, act: () => this.openItemMenu(capturedId, cx, cy) });
      }
      sy += slotH + 4;
    }
    // Hand (equipped weapon/tool)
    const handItem = me.equipped as ItemId | undefined;
    this.drawEquipSlotRow(ctx, px + pad, sy, slotW, slotH, handLabel, handItem, me);
    if (handItem) {
      const capturedId = handItem;
      const cx = px + pad + slotW / 2, cy = sy + slotH / 2;
      this.hudHits.push({ x: px + pad, y: sy, w: slotW, h: slotH, act: () => this.openItemMenu(capturedId, cx, cy) });
    }
    sy += slotH + 10;

    // Separator
    ctx.strokeStyle = "#1d4a66"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + pad, sy); ctx.lineTo(W - pad, sy); ctx.stroke();
    sy += 10;

    // Wardrobe: wearable clothing in bag
    const CLOTHING_IDS: ItemId[] = [
      "clothShirt", "clothPants", "waxedJacket", "rainCoat", "woolSweater",
      "wetsuitTop", "wetsuitBottom", "snorkelMask", "divingTank",
    ] as ItemId[];
    const available = CLOTHING_IDS.filter(id => (me.inventory[id] ?? 0) > 0);
    if (available.length > 0) {
      ctx.fillStyle = "#7fd0c2";
      ctx.font = "bold 10px system-ui";
      ctx.textAlign = "left";
      ctx.fillText("WARDROBE", px + pad, sy + 10);
      sy += 16;
      const cellS = 44, cellGap = 4;
      const cols = Math.floor((pw - pad * 2 + cellGap) / (cellS + cellGap));
      available.forEach((id, i) => {
        const col = i % cols, row = Math.floor(i / cols);
        const cx2 = px + pad + col * (cellS + cellGap);
        const cy2 = sy + row * (cellS + cellGap);
        const isOn = (SLOT_FOR_ITEM[id] && worn[SLOT_FOR_ITEM[id] as WornSlot] === id);
        this.drawSlotBox(ctx, cx2, cy2, cellS, cellS, !!isOn);
        drawItemIcon(ctx, id, cx2 + 4, cy2 + 4, cellS - 8);
        if (isOn) {
          ctx.strokeStyle = "#ffd54f"; ctx.lineWidth = 2;
          roundRect(ctx, cx2, cy2, cellS, cellS, 6); ctx.stroke();
        }
        const capturedId = id;
        const midX = cx2 + cellS / 2, midY = cy2 + cellS / 2;
        this.hudHits.push({ x: cx2, y: cy2, w: cellS, h: cellS, act: () => this.openItemMenu(capturedId, midX, midY) });
      });
    }

    // Stats footer
    const footY = H - 60;
    ctx.strokeStyle = "#1d4a66"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + pad, footY); ctx.lineTo(W - pad, footY); ctx.stroke();
    ctx.fillStyle = "#9fc8de"; ctx.font = "11px system-ui"; ctx.textAlign = "left";
    ctx.fillText(`$${me.money}  ·  ${me.banfielderPts} pts`, px + pad, footY + 18);
    if (me.titles?.length) {
      ctx.fillStyle = "#ce93d8"; ctx.font = "10px system-ui";
      ctx.fillText(me.titles.join(" · "), px + pad, footY + 32);
    }
  }

  private drawEquipSlotRow(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, w: number, h: number,
    label: string, itemId: ItemId | undefined, _me: PlayerState
  ) {
    const iconS = h - 8;
    // Background
    ctx.fillStyle = itemId ? "rgba(20,40,60,0.8)" : "rgba(10,20,30,0.6)";
    roundRect(ctx, x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = itemId ? "#ffd54f" : "rgba(100,160,200,0.2)";
    ctx.lineWidth = itemId ? 1.5 : 1;
    roundRect(ctx, x, y, w, h, 6); ctx.stroke();
    // Label
    ctx.fillStyle = "#6a9ab5"; ctx.font = "9px system-ui"; ctx.textAlign = "left";
    ctx.fillText(label.toUpperCase(), x + 6, y + 11);
    if (itemId) {
      // Icon
      if (!drawItemIcon(ctx, itemId, x + 4, y + (h - iconS) / 2, iconS)) {
        ctx.fillStyle = (ITEM_COLORS as Record<string, string>)[itemId] ?? "#3a5a6a";
        roundRect(ctx, x + 4, y + 4, iconS, iconS, 4); ctx.fill();
      }
      // Name
      ctx.fillStyle = "#eaf2f8"; ctx.font = "bold 11px system-ui"; ctx.textAlign = "left";
      const lbl = ITEM_LABEL[itemId] ?? itemId;
      ctx.fillText(lbl, x + iconS + 10, y + h / 2 + 4);
    } else {
      ctx.fillStyle = "#2a4a60"; ctx.font = "italic 11px system-ui"; ctx.textAlign = "left";
      ctx.fillText("— empty", x + 8, y + h / 2 + 4);
    }
  }

  // ─── Canvas skills panel ───────────────────────────────────────────────────
  private drawSkillsPanel(me?: PlayerState) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const pw = 220, ph = H;
    const px = W - pw;
    const pad = 12;

    // Background
    ctx.fillStyle = "rgba(6,14,22,0.96)";
    ctx.fillRect(px, 0, pw, ph);
    ctx.strokeStyle = "#1d4a66";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, ph); ctx.stroke();

    // Title + close
    ctx.fillStyle = "#ffd54f";
    ctx.font = "bold 14px system-ui";
    ctx.textAlign = "left";
    ctx.fillText("SKILLS", px + pad, 28);
    ctx.fillStyle = "#4a7a9b";
    ctx.font = "bold 16px system-ui";
    ctx.textAlign = "right";
    ctx.fillText("×", W - pad, 28);
    this.hudHits.push({ x: W - 28, y: 8, w: 20, h: 22, act: () => { this.panelOpen = false; } });

    if (!me) return;
    const rankStr = me.isMayor ? "★ Mayor" : me.rank > 0 ? `#${me.rank}` : "unranked";

    ctx.fillStyle = "#9fe6c0"; ctx.font = "12px system-ui"; ctx.textAlign = "left";
    ctx.fillText(`${me.banfielderPts} pts  ·  ${rankStr}`, px + pad, 46);

    // Separator
    ctx.strokeStyle = "#1d4a66"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px + pad, 54); ctx.lineTo(W - pad, 54); ctx.stroke();

    // Skill rows
    const barW = pw - pad * 2, rowH = 30;
    let sy = 62;
    for (const sk of SKILL_NAMES) {
      const xp = me.skills[sk] ?? 0;
      const lv = skillLevel(xp);
      const nextXp = (lv + 1) * (lv + 1), thisXp = lv * lv;
      const pct = lv === 0 ? 0 : Math.min(1, (xp - thisXp) / (nextXp - thisXp));

      // Skill name
      ctx.fillStyle = "#9fc2d6"; ctx.font = "11px system-ui"; ctx.textAlign = "left";
      ctx.fillText(sk.charAt(0).toUpperCase() + sk.slice(1), px + pad, sy + 13);
      // Level badge
      ctx.fillStyle = "#ffd54f"; ctx.font = "bold 12px system-ui"; ctx.textAlign = "right";
      ctx.fillText(`${lv}`, W - pad, sy + 13);
      // XP bar
      const barH = 5, barY = sy + 18;
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      roundRect(ctx, px + pad, barY, barW, barH, 3); ctx.fill();
      if (pct > 0) {
        const grad = ctx.createLinearGradient(px + pad, 0, px + pad + barW, 0);
        grad.addColorStop(0, "#1565c0"); grad.addColorStop(1, "#42a5f5");
        ctx.fillStyle = grad;
        roundRect(ctx, px + pad, barY, Math.max(3, barW * pct), barH, 3); ctx.fill();
      }
      sy += rowH;
      if (sy + rowH > H - 20) break; // don't overflow
    }
  }

  private drawHud(snap: Snapshot, me?: PlayerState) {
    const hud = document.getElementById("hud")!;
    const tidePct = Math.round(snap.tide * 100);
    const event = snap.event === "tsunami" ? " ⚠ TSUNAMI" : snap.event === "king" ? " ⚠ King tide" : "";
    const sleepStr = me?.sleeping ? ` 💤` : "";
    const teamStr = me?.team ? ` · <b>Team:</b> ${me.team}` : "";
    const charCount = ALL_PLAYER_SPRITES.size;
    const charStr = (PLAYER_SPRITE && charCount > 1)
      ? ` · <b>Character:</b> ${PLAYER_SPRITE.name ?? activePlayerCharId} <span style="color:#8fb4c9;font-size:11px">[ / ]</span>`
      : "";
    hud.innerHTML =
      `<b>${this.regionName}</b> · <b>Tide:</b> ${snap.phase} (${tidePct}%)${event}${sleepStr}${teamStr}${charStr}<br />` +
      `<b>Here:</b> ${snap.players.length} players`;
  }

  // ─── Canvas corner HUD ─────────────────────────────────────────────────────
  // Hearts + stamina + equipped/quick-keys bottom-left, clickable backpack /
  // body / gear bottom-right, and a circular compass-minimap top-right.
  private drawCornerHud(me?: PlayerState) {
    this.hudHits = [];
    this.compassHit = null;
    if (!me) return;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const pad = 16;
    const now = performance.now();

    // ── Bottom-left: hearts, stamina, equipped item + quick-keys ──────────────
    const beltH = 46;
    const beltTop = H - pad - beltH;

    // Equipped item slot.
    const slotS = beltH;
    this.drawSlotBox(ctx, pad, beltTop, slotS, slotS);
    const eq = me.equipped;
    if (eq) {
      const isz = slotS - 14;
      if (!drawItemIcon(ctx, eq, pad + 7, beltTop + 4, isz)) {
        ctx.fillStyle = (ITEM_COLORS as Record<string, string>)[eq] ?? "#3a5a6a";
        roundRect(ctx, pad + 8, beltTop + 8, slotS - 16, slotS - 22, 4); ctx.fill();
      }
      ctx.fillStyle = "#eaf2f8"; ctx.font = "8px system-ui"; ctx.textAlign = "center";
      const lbl = ITEM_LABEL[eq] ?? eq;
      ctx.fillText(lbl.length > 9 ? lbl.slice(0, 8) + "…" : lbl, pad + slotS / 2, beltTop + slotS - 4);
      const ammoId = WEAPON_AMMO[eq];
      if (ammoId) {
        const n = me.inventory[ammoId] ?? 0;
        ctx.fillStyle = n > 0 ? "#9fe6c0" : "#e57373";
        ctx.font = "bold 9px system-ui"; ctx.textAlign = "right";
        ctx.fillText(`${n}`, pad + slotS - 5, beltTop + 12);
      }
    } else {
      ctx.fillStyle = "#3a5a6a"; ctx.font = "9px system-ui"; ctx.textAlign = "center";
      ctx.fillText("fists", pad + slotS / 2, beltTop + slotS / 2 + 3);
    }
    this.hudHits.push({ x: pad, y: beltTop, w: slotS, h: slotS, act: () => { this.invOpen = !this.invOpen; } });

    // Quick-key belt (weapons 1–6) to the right of the equipped slot.
    const qkS = 28, qkGap = 4;
    let qx = pad + slotS + 10;
    const qy = beltTop + (slotS - qkS);
    WEAPON_ORDER.forEach((item, i) => {
      const owned = (me.inventory[item] ?? 0) > 0;
      const on = me.equipped === item;
      this.drawSlotBox(ctx, qx, qy, qkS, qkS, on);
      if (owned) {
        ctx.save();
        if (!on) ctx.globalAlpha = 0.85;
        if (!drawItemIcon(ctx, item, qx + 2, qy + 1, qkS - 4)) {
          ctx.fillStyle = (ITEM_COLORS as Record<string, string>)[item] ?? "#3a5a6a";
          roundRect(ctx, qx + 4, qy + 4, qkS - 8, qkS - 11, 3); ctx.fill();
        }
        ctx.restore();
      }
      ctx.fillStyle = owned ? "#ffe9a0" : "#41606f";
      ctx.font = "bold 9px system-ui"; ctx.textAlign = "left";
      ctx.fillText(`${i + 1}`, qx + 3, qy + qkS - 3);
      const idx = i;
      this.hudHits.push({ x: qx, y: qy, w: qkS, h: qkS, act: () => this.selectWeapon(idx) });
      qx += qkS + qkGap;
    });

    // Stamina bar above the belt.
    const barW = slotS + 10 + WEAPON_ORDER.length * (qkS + qkGap) - qkGap;
    const sfrac = Math.max(0, Math.min(1, me.stamina / me.maxStamina));
    const staH = 8, staY = beltTop - 12 - staH;
    ctx.fillStyle = "rgba(7,19,28,0.7)"; roundRect(ctx, pad, staY, barW, staH, 4); ctx.fill();
    ctx.fillStyle = "#1b6e3a"; // base
    const grad = ctx.createLinearGradient(pad, 0, pad + barW, 0);
    grad.addColorStop(0, "#e65100"); grad.addColorStop(1, "#f9a825");
    ctx.fillStyle = grad;
    roundRect(ctx, pad, staY, Math.max(2, barW * sfrac), staH, 4); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
    roundRect(ctx, pad, staY, barW, staH, 4); ctx.stroke();

    // Hearts above the stamina bar.
    const heartS = 18, heartGap = 2;
    const maxHearts = Math.max(1, Math.min(12, Math.round(me.maxHp / 20)));
    const hpPerHeart = me.maxHp / maxHearts;
    const heartY = staY - 6 - heartS;
    const critical = me.hp / me.maxHp < 0.10;
    const pulse = critical ? 0.55 + 0.45 * Math.abs(Math.sin(now / 180)) : 1;
    for (let i = 0; i < maxHearts; i++) {
      const hx = pad + i * (heartS + heartGap);
      const frac = Math.max(0, Math.min(1, (me.hp - i * hpPerHeart) / hpPerHeart));
      const state = frac >= 0.75 ? 2 : frac >= 0.25 ? 1 : 0;
      this.drawHeart(ctx, hx, heartY, heartS, state, critical ? pulse : 1);
    }

    // ── Top-right: circular compass / minimap ─────────────────────────────────
    const R = 52;
    const cx = W - pad - R;
    const cy = pad + R;
    this.drawCompass(ctx, cx, cy, R, me);
    this.compassHit = { cx, cy, r: R };

    // ── Bottom-right: backpack / body / gear icons ────────────────────────────
    const iS = 50, iGap = 8;
    const rightEdge = W - pad;
    const iy = H - pad - iS;
    const gx = rightEdge - iS;
    const sx2 = gx - iGap - iS;
    const bx = sx2 - iGap - iS;
    this.drawHudIcon(ctx, bx, iy, iS, "backpack", this.invOpen);
    this.drawHudIcon(ctx, sx2, iy, iS, "body", this.panelOpen && this.panelTab === "equip");
    this.drawHudIcon(ctx, gx, iy, iS, "gear", this.panelOpen && this.panelTab === "skills");
    this.hudHits.push({ x: bx, y: iy, w: iS, h: iS, act: () => { this.invOpen = !this.invOpen; } });
    this.hudHits.push({ x: sx2, y: iy, w: iS, h: iS, act: () => this.togglePanel("equip") });
    this.hudHits.push({ x: gx, y: iy, w: iS, h: iS, act: () => this.togglePanel("skills") });
  }

  // A rounded HUD cell with subtle inner shading; gold ring when active.
  private drawSlotBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, active = false) {
    ctx.fillStyle = "rgba(7,19,28,0.78)";
    roundRect(ctx, x, y, w, h, 6); ctx.fill();
    ctx.strokeStyle = active ? "#ffd54f" : "rgba(120,180,220,0.25)";
    ctx.lineWidth = active ? 2 : 1;
    roundRect(ctx, x, y, w, h, 6); ctx.stroke();
  }

  // Pixel-art-ish heart: state 0 empty, 1 half, 2 full. `bright` pulses it red.
  private drawHeart(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, state: number, bright: number) {
    const r = s * 0.27;
    const cxL = x + r, cxR = x + s - r, topY = y + r * 0.9;
    const path = () => {
      ctx.beginPath();
      ctx.arc(cxL, topY, r, Math.PI, 0);
      ctx.arc(cxR, topY, r, Math.PI, 0);
      ctx.lineTo(x + s / 2, y + s);
      ctx.closePath();
    };
    // Empty socket.
    path(); ctx.fillStyle = "rgba(20,8,8,0.55)"; ctx.fill();
    if (state > 0) {
      ctx.save();
      if (state === 1) { ctx.beginPath(); ctx.rect(x, y, s / 2, s + 2); ctx.clip(); }
      path();
      const red = state === 2 ? `rgba(${(229 * bright) | 0},${(40 * bright) | 0},${(45 * bright) | 0},1)` : "#e53935";
      ctx.fillStyle = red; ctx.fill();
      // top-left glint
      ctx.fillStyle = "rgba(255,180,180,0.7)";
      ctx.beginPath(); ctx.arc(cxL, topY - r * 0.2, r * 0.32, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    path(); ctx.strokeStyle = "rgba(10,4,4,0.85)"; ctx.lineWidth = 1.4; ctx.stroke();
  }

  // Bottom-right clickable icon button (backpack / body silhouette / gear).
  private drawHudIcon(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, kind: "backpack" | "body" | "gear", active: boolean) {
    ctx.fillStyle = active ? "rgba(30,80,120,0.85)" : "rgba(7,19,28,0.8)";
    roundRect(ctx, x, y, s, s, 9); ctx.fill();
    ctx.strokeStyle = active ? "#ffd54f" : "rgba(120,180,220,0.3)";
    ctx.lineWidth = active ? 2 : 1;
    roundRect(ctx, x, y, s, s, 9); ctx.stroke();
    const cx = x + s / 2, cy = y + s / 2;
    ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
    const accent = active ? "#ffe9a0" : "#bcd6ea";
    if (kind === "backpack") {
      ctx.fillStyle = "#7a5a3a"; roundRect(ctx, cx - 11, cy - 7, 22, 19, 5); ctx.fill();
      ctx.fillStyle = "#9a744c"; roundRect(ctx, cx - 11, cy - 12, 22, 9, 5); ctx.fill(); // flap
      ctx.strokeStyle = "#5a3f28"; ctx.beginPath(); ctx.moveTo(cx, cy - 3); ctx.lineTo(cx, cy + 9); ctx.stroke();
      ctx.fillStyle = "#caa46e"; roundRect(ctx, cx - 4, cy + 1, 8, 6, 2); ctx.fill(); // pocket
    } else if (kind === "body") {
      ctx.fillStyle = accent;
      ctx.beginPath(); ctx.arc(cx, cy - 7, 5, 0, Math.PI * 2); ctx.fill();   // head
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy + 12); ctx.quadraticCurveTo(cx - 9, cy - 1, cx, cy - 1);
      ctx.quadraticCurveTo(cx + 9, cy - 1, cx + 9, cy + 12); ctx.closePath(); ctx.fill(); // torso
    } else {
      // Gear / cog.
      ctx.fillStyle = accent;
      const teeth = 8, rO = 11, rI = 7;
      ctx.beginPath();
      for (let i = 0; i < teeth * 2; i++) {
        const a = (i / (teeth * 2)) * Math.PI * 2;
        const rr = i % 2 === 0 ? rO : rO - 3;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = active ? "rgba(30,80,120,0.95)" : "rgba(7,19,28,0.95)";
      ctx.beginPath(); ctx.arc(cx, cy, rI - 3, 0, Math.PI * 2); ctx.fill();
    }
  }

  // The circular compass-minimap (top-right). Zoomed view centred on the player.
  private drawCompass(ctx: CanvasRenderingContext2D, cx: number, cy: number, R: number, me: PlayerState) {
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = "#0a1c29"; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    const ov = this.overview;
    if (ov) {
      const zoomCells = 30;                 // overview cells spanning the diameter
      const cell = (R * 2) / zoomCells;
      const pcx = me.x / ov.scale, pcy = me.y / ov.scale;
      const half = zoomCells / 2 + 1;
      const x0 = Math.max(0, Math.floor(pcx - half)), x1 = Math.min(ov.width - 1, Math.ceil(pcx + half));
      const y0 = Math.max(0, Math.floor(pcy - half)), y1 = Math.min(ov.height - 1, Math.ceil(pcy + half));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const tile = ov.tiles[y * ov.width + x] as Tile;
          ctx.fillStyle = (TILE_COLORS as Record<number, string>)[tile] ?? "#1c5f86";
          const sxp = cx + (x - pcx) * cell, syp = cy + (y - pcy) * cell;
          ctx.fillRect(sxp, syp, cell + 1, cell + 1);
        }
      }
    }
    ctx.restore();

    // Player marker — bright dot + a facing wedge.
    ctx.fillStyle = "#fff";
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(me.dir) * 9, cy + Math.sin(me.dir) * 9);
    ctx.lineTo(cx + Math.cos(me.dir + 2.5) * 4, cy + Math.sin(me.dir + 2.5) * 4);
    ctx.lineTo(cx + Math.cos(me.dir - 2.5) * 4, cy + Math.sin(me.dir - 2.5) * 4);
    ctx.closePath(); ctx.fill();

    // Bezel + N tick.
    ctx.strokeStyle = "rgba(10,20,28,0.9)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "rgba(150,200,235,0.55)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = "#ffd54f"; ctx.font = "bold 11px system-ui"; ctx.textAlign = "center";
    ctx.fillText("N", cx, cy - R + 12);
    ctx.fillStyle = "rgba(180,212,236,0.7)"; ctx.font = "8px system-ui";
    ctx.fillText("map", cx, cy + R - 5);
  }

  private renderLog() {
    document.getElementById("log")!.innerHTML = this.logLines
      .map((l) => `• ${l}`)
      .join("<br />");
  }
}

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
  clothShirt: "#e3b0c0", clothPants: "#b0c3e3", fieldHat: "#c2a35a", waxedJacket: "#6b7b3a", rainCoat: "#e8d04a",
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

