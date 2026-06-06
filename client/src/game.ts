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
  ItemId,
  NpcState,
  PlantState,
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
  WATERLINE_HIGH,
  DEPTH_ANKLE,
  DEPTH_SWIM,
  DEPTH_DEEP,
  DEPTH_OCEAN,
  skillLevel,
} from "../../shared/protocol";
import { Net } from "./net";

const CHARGE_MAX_MS = 600; // hold Space this long for a full-power swing
const HARVEST_RANGE_PX = 1.8 * TILE_SIZE; // client-side prompt range (cosmetic only)

const TILE_COLORS: Record<Tile, string> = {
  [Tile.Water]: "#1c5f86",
  [Tile.Sand]: "#d8c98c",
  [Tile.Grass]: "#4f7d3a",
  [Tile.Forest]: "#2f5a28",
  [Tile.Hill]: "#6b6f57",
  [Tile.Rock]: "#7d7d7d",
  [Tile.Road]: "#5b524a",
  [Tile.Dock]: "#7a5a36",
};

export class Game {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private net: Net;

  private myId = "";
  private map: WorldMap | null = null;
  private regionName = "";
  private travelNodes: TravelNode[] = [];
  private snap: Snapshot | null = null;

  private keys = new Set<string>();
  private lastDir = { x: 0, y: 0 };
  private cam = { x: 0, y: 0 };
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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
    this.net = new Net((m) => this.onServer(m));
    this.resize();
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("keydown", (e) => this.onKey(e, true));
    window.addEventListener("keyup", (e) => this.onKey(e, false));
  }

  start(name: string, appearance: Appearance) {
    this.net.connect();
    this.net.send({ t: "join", name, appearance });
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
      } else if (!e.repeat) {
        if (k === "shift") {
          this.net.send({ t: "dodge" });
        } else if (k === "f") {
          this.net.send({ t: "board" });
        } else if (k === "e") {
          // Near an NPC? Talk instead of harvesting.
          const npc = this.nearbyNpc();
          if (npc) {
            this.npcOpen = this.npcOpen === npc.id ? null : npc.id;
          } else {
            this.net.send({ t: "harvest" });
            this.net.send({ t: "repair" });
          }
        } else if (k === "n") {
          const npc = this.nearbyNpc();
          if (npc) this.npcOpen = this.npcOpen === npc.id ? null : npc.id;
        } else if (k === "i") {
          this.invOpen = !this.invOpen;
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
          e.preventDefault();
        } else if (k === "b") {
          // Toggle the shop panel for the nearest shop building.
          if (this.shopId) {
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
      this.map = m.region.map;
      this.regionName = m.region.name;
      this.travelNodes = m.region.travelNodes;
      this.snap = m.snapshot;
    } else if (m.t === "snapshot") {
      this.snap = m.snapshot;
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
    if (me) {
      // Smoothly follow the player.
      this.cam.x += (me.x * TILE_SIZE - this.canvas.width / 2 - this.cam.x) * 0.15;
      this.cam.y += (me.y * TILE_SIZE - this.canvas.height / 2 - this.cam.y) * 0.15;
    }

    this.drawTiles();
    this.drawKelpBeds();
    this.drawTerrainWalls();
    this.drawTravelNodes();
    this.drawCampfires(this.snap.campfires);
    this.drawFurnaces(this.snap.furnaces);
    this.drawResourceNodes(this.snap.resourceNodes, me);
    this.drawPlants(this.snap.plants);
    this.drawBuildings(this.snap.buildings);
    this.drawNpcs(this.snap.npcs ?? [], me);
    this.drawVehicles(this.snap.vehicles);
    this.drawCreatures(this.snap.creatures);
    for (const p of this.snap.players) this.drawPlayer(p, p.id === this.myId);
    if (me) this.drawSelfOverlay(me);
    this.drawHud(this.snap, me);
    this.drawTravelPrompt(me);
    this.drawBoardPrompt(me);
    this.drawShopPrompt(me);
    this.drawNpcPrompt(me);
    this.drawRefuelPrompt(me);
    this.drawHarvestPrompt(this.snap.resourceNodes, this.snap.plants, me);
    this.drawFishPrompt(me);
    if (this.craftOpen) this.drawCraftPanel(me);
    if (this.shopId) this.drawShopPanel(me);
    if (this.invOpen) this.drawInventoryPanel(me);
    if (this.npcOpen) this.drawNpcDialogue(me);
    if (this.mapOpen) this.drawMapOverlay(me);
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

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const i = y * map.width + x;
        const tile = map.tiles[i] as Tile;
        const elev = map.elevation[i];
        const { sx, sy } = this.toScreen(x, y);
        const depth = snap.waterline - elev; // >0 means under water right now

        if (depth > 0) {
          // Colour by depth tier — ankle turquoise → abyss near-black.
          ctx.fillStyle = waterDepthColor(depth);
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
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

  private drawBuildings(buildings: BuildingState[]) {
    const ctx = this.ctx;
    for (const b of buildings) {
      const { sx, sy } = this.toScreen(b.x, b.y);
      const w = b.w * TILE_SIZE;
      const h = b.h * TILE_SIZE;
      if (b.kind === "rubble") {
        ctx.fillStyle = "#4a4038";
        ctx.fillRect(sx, sy, w, h);
        // scattered debris
        ctx.fillStyle = "#5e5347";
        for (let i = 0; i < 5; i++) {
          ctx.fillRect(sx + ((i * 7) % w), sy + ((i * 11) % h), 4, 4);
        }
        continue;
      }

      // Walls + a darker pitched-roof band along the top, plus a door.
      ctx.fillStyle = buildingColor(b.kind);
      ctx.fillRect(sx, sy, w, h);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fillRect(sx, sy, w, Math.max(5, h * 0.34)); // roof
      ctx.strokeStyle = "#15110d";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, w, h);
      // door
      ctx.fillStyle = "#2c2018";
      ctx.fillRect(sx + w / 2 - 3, sy + h - 9, 6, 9);
      // a small sign marking what it is
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "9px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(buildingLabel(b.kind), sx + w / 2, sy + h * 0.34 + 9);

      // HP bar.
      const frac = Math.max(0, b.hp / b.maxHp);
      ctx.fillStyle = "#222";
      ctx.fillRect(sx, sy - 6, w, 4);
      ctx.fillStyle = frac > 0.5 ? "#4caf50" : frac > 0.25 ? "#ffb300" : "#e53935";
      ctx.fillRect(sx, sy - 6, w * frac, 4);
    }
  }

  private drawVehicles(vehicles: VehicleState[]) {
    for (const v of vehicles) {
      const { sx, sy } = this.toScreen(v.x, v.y);
      drawVehicleSprite(this.ctx, v, sx, sy);
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

  private drawResourceNodes(nodes: ResourceNode[], _me?: PlayerState) {
    for (const n of nodes) {
      const { sx, sy } = this.toScreen(n.x + 0.5, n.y + 0.5);
      drawResourceSprite(this.ctx, n, sx, sy);
    }
  }

  private drawPlants(plants: PlantState[]) {
    for (const pl of plants) {
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
    if (!this.map) return;
    const ctx = this.ctx;
    const map = this.map;
    const mw = map.width;
    const mh = map.height;

    // Scale so the whole map fits inside 80% of the screen.
    const maxW = Math.floor(this.canvas.width  * 0.82);
    const maxH = Math.floor(this.canvas.height * 0.82);
    const scale = Math.min(Math.floor(maxW / mw), Math.floor(maxH / mh), 3) || 1;
    const pw = mw * scale;  // pixel width of drawn map
    const ph = mh * scale;  // pixel height
    const ox = Math.floor((this.canvas.width  - pw) / 2); // top-left corner
    const oy = Math.floor((this.canvas.height - ph) / 2);

    // Dim background.
    ctx.fillStyle = "rgba(5,15,25,0.88)";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw tiles.
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const tile = map.tiles[y * mw + x] as Tile;
        ctx.fillStyle = TILE_COLORS[tile] ?? "#333";
        ctx.fillRect(ox + x * scale, oy + y * scale, scale, scale);
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

  private drawNpcs(npcs: NpcState[], me?: PlayerState) {
    const ctx = this.ctx;
    for (const n of npcs) {
      const { sx, sy } = this.toScreen(n.x + 0.5, n.y + 0.5);
      const R = TILE_SIZE * 0.4;
      // Shadow
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.beginPath();
      ctx.ellipse(sx, sy + R * 0.8, R * 0.7, R * 0.28, 0, 0, Math.PI * 2);
      ctx.fill();
      // Body
      ctx.fillStyle = NPC_COLORS[n.kind] ?? "#607d8b";
      ctx.beginPath();
      ctx.arc(sx, sy, R, 0, Math.PI * 2);
      ctx.fill();
      // Head
      ctx.fillStyle = "#e0ac69";
      ctx.beginPath();
      ctx.arc(sx, sy - R * 0.15, R * 0.55, 0, Math.PI * 2);
      ctx.fill();
      // Role label
      ctx.fillStyle = "#eaf2f8";
      ctx.font = "10px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(NPC_NAME[n.kind] ?? "Local", sx, sy - TILE_SIZE * 0.7);
      // "talk" bubble when you're close
      const close = me && Math.hypot(n.x + 0.5 - me.x, n.y + 0.5 - me.y) <= 1.8;
      if (close) {
        ctx.fillStyle = "#fff3cf";
        ctx.beginPath();
        ctx.arc(sx + R, sy - R * 1.1, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#15384f";
        ctx.font = "bold 10px system-ui";
        ctx.fillText("?", sx + R, sy - R * 1.1 + 3.5);
      }
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

  private drawCreatures(creatures: CreatureState[]) {
    const me = this.snap?.players.find((p) => p.id === this.myId);
    for (const c of creatures) {
      const { sx, sy } = this.toScreen(c.x, c.y);
      const depth = this.clientDepthAt(c.x, c.y);
      const dist = me ? Math.hypot(c.x - me.x, c.y - me.y) : 999;
      drawCreatureSprite(this.ctx, c.kind, sx, sy, depth, dist);
    }
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

    // A faint wake ring when swimming.
    if (p.swimming) {
      ctx.strokeStyle = "rgba(220,240,255,0.45)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, R * 1.25, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Legs/feet — two rounded boots below the body, animated while on foot.
    if (!p.vehicleId && !p.swimming) {
      const legDir = p.dir + Math.PI; // feet trail behind the facing direction
      const t = performance.now() / 220;
      const legSwing = Math.sin(t) * 3; // simple walk cycle
      for (const [side, swing] of [[-1, legSwing], [1, -legSwing]] as const) {
        const perpA = legDir + (Math.PI / 2) * side;
        const lx = sx + Math.cos(legDir) * R * 0.55 + Math.cos(perpA) * R * 0.28;
        const ly = sy + Math.sin(legDir) * R * 0.55 + Math.sin(perpA) * R * 0.28 + swing;
        ctx.fillStyle = "#2c1a0a"; // trouser/boot
        ctx.beginPath();
        ctx.ellipse(lx, ly, R * 0.17, R * 0.24, legDir, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1a1008"; // toe of the boot
        ctx.beginPath();
        ctx.ellipse(lx + Math.cos(legDir) * 2, ly + Math.sin(legDir) * 2, R * 0.14, R * 0.12, legDir, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Arms reaching out to the sides of the facing direction.
    ctx.strokeStyle = p.appearance.skin;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (const off of [-1.1, 1.1]) {
      const a = p.dir + off;
      const hx = sx + Math.cos(a) * R * 1.15;
      const hy = sy + Math.sin(a) * R * 1.15;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(a) * R * 0.4, sy + Math.sin(a) * R * 0.4);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = p.appearance.skin;
      ctx.beginPath();
      ctx.arc(hx, hy, R * 0.16, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body (shirt).
    ctx.fillStyle = p.appearance.shirt;
    ctx.beginPath();
    ctx.arc(sx, sy, R, 0, Math.PI * 2);
    ctx.fill();
    // Head (skin) + hair cap on the back (away from facing).
    ctx.fillStyle = p.appearance.skin;
    ctx.beginPath();
    ctx.arc(sx, sy, R * 0.62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = p.appearance.hair;
    ctx.beginPath();
    ctx.arc(sx, sy, R * 0.62, p.dir + Math.PI / 2, p.dir + (Math.PI * 3) / 2);
    ctx.fill();

    // HP ring (green -> red), starting at the top and going clockwise.
    const frac = Math.max(0, Math.min(1, p.hp / p.maxHp));
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(sx, sy, R + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = hpColor(frac);
    ctx.beginPath();
    ctx.arc(sx, sy, R + 4, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.stroke();

    if (isMe) {
      ctx.strokeStyle = "rgba(255,255,255,0.8)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(sx, sy, R + 7, 0, Math.PI * 2);
      ctx.stroke();
      // Stamina arc just outside the HP ring (your own gauge only).
      const sfrac = Math.max(0, Math.min(1, p.stamina / p.maxStamina));
      if (sfrac < 1) {
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(sx, sy, R + 9, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = "#42c0ff";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(sx, sy, R + 9, -Math.PI / 2, -Math.PI / 2 + sfrac * Math.PI * 2);
      ctx.stroke();
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

    // Name (with a crown for the unofficial mayor).
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.7);
    if (p.isMayor) {
      ctx.fillStyle = "#ffd54f";
      ctx.font = "13px system-ui";
      ctx.fillText("♔", sx, sy - TILE_SIZE * 0.95);
    }
  }

  private drawHud(snap: Snapshot, me?: PlayerState) {
    const hud = document.getElementById("hud")!;
    const tidePct = Math.round(snap.tide * 100);
    const event = snap.event === "tsunami" ? " ⚠ TSUNAMI" : snap.event === "king" ? " ⚠ King tide" : "";
    const hp = me ? Math.max(0, Math.round(me.hp)) : 0;
    const stam = me ? Math.max(0, Math.round(me.stamina)) : 0;
    const hunger = me ? Math.max(0, Math.round(me.hunger)) : 0;
    const hungerLow = me ? me.hunger < me.maxHunger * 0.25 : false;
    const skillsHtml = me
      ? SKILL_NAMES
          .filter((sk) => skillLevel(me.skills[sk]) > 0)
          .map((sk) => `${sk.slice(0, 3).toUpperCase()}:${skillLevel(me.skills[sk])}`)
          .join(" ") || "New settler — go earn some XP!"
      : "";
    const isFood = (id: ItemId) => (FOOD_VALUE as Record<string, unknown>)[id] !== undefined;
    const invItems = me
      ? (ITEM_IDS as readonly ItemId[])
          .filter((id) => (me.inventory[id] ?? 0) > 0)
          .map((id) => {
            const qty = me.inventory[id] ?? 0;
            const label = ITEM_LABEL[id];
            return isFood(id) ? `<span style="color:#7ec8a0">${label}:${qty}</span>` : `${label}:${qty}`;
          })
          .join(" ")
      : "";
    const teamStr = me?.team ? ` &nbsp; <b>Team:</b> ${me.team}` : "";
    const rankStr = me
      ? me.isMayor
        ? `<span style="color:#ffd54f">★ MAYOR</span>`
        : me.rank > 0
          ? `#${me.rank}`
          : "unranked"
      : "";
    const sleepStr = me?.sleeping ? ` <span style="color:#7ec8a0">💤 resting</span>` : "";
    hud.innerHTML =
      `<b>${this.regionName}</b><br />` +
      `<b>Tide:</b> ${snap.phase} (${tidePct}%)${event}<br />` +
      `<b>HP:</b> ${hp}/${me?.maxHp ?? 100} &nbsp; <b>Stam:</b> ${stam}/${me?.maxStamina ?? 100}${sleepStr}<br />` +
      `<b>Hunger:</b> <span style="color:${hungerLow ? "#e57373" : "#cfe3ef"}">${hunger}/${me?.maxHunger ?? 100}${hungerLow ? " — EAT (Q)!" : ""}</span><br />` +
      `<b>Money:</b> <span style="color:#9fe6c0">$${me?.money ?? 0}</span> &nbsp; <b>Banfielder:</b> ${me?.banfielderPts ?? 0} pts (${rankStr})${teamStr}<br />` +
      (skillsHtml ? `<b>Skills:</b> <span style="font-size:11px">${skillsHtml}</span><br />` : "") +
      (invItems ? `<b>Inv:</b> <span style="font-size:11px">${invItems}</span><br />` : "") +
      `<b>Here:</b> ${snap.players.length}`;
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
  wood: "#6b4423", iron: "#8a6040", stone: "#8a8a8a", plank: "#a0783c",
  scrap: "#607d8b", rod: "#4a6a80", crabmeat: "#d4824a", fish: "#4a9abf",
  liveFish: "#2eafd4", berry: "#3a59c0", cookedcrab: "#e05c20", cookedfish: "#c8a040",
  ironBar: "#b0b0c0", shinyLure: "#ffd54f", jerryCan: "#e07020",
};

// NPC display name + body colour + dialogue, keyed by kind.
const NPC_NAME: Record<NpcState["kind"], string> = {
  naturalist: "Naturalist", pirate: "Local Pirate", scientist: "Marine Scientist",
  westsider: "West Sider", eastsider: "East Sider", huuayaht: "Huu-ay-aht Citizen",
  mayor: "Unofficial Mayor", historian: "Local Historian", boatdealer: "Boat Dealer",
  icevendor: "Ice Vendor",
};
const NPC_COLORS: Record<NpcState["kind"], string> = {
  naturalist: "#2e7d32", pirate: "#37474f", scientist: "#1565c0", westsider: "#00695c",
  eastsider: "#4a148c", huuayaht: "#b71c1c", mayor: "#f57f17", historian: "#6d4c41",
  boatdealer: "#0277bd", icevendor: "#00838f",
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

// --- resource node sprites --------------------------------------------------
function drawResourceSprite(ctx: CanvasRenderingContext2D, n: ResourceNode, x: number, y: number) {
  const R = TILE_SIZE * 0.44;
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
    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(x, y + R * 0.6, R * 0.85, R * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    // Trunk
    ctx.fillStyle = "#6b4423";
    ctx.fillRect(x - 3, y, 6, R * 0.7);
    // Canopy (layered circles for depth)
    for (const [ox, oy, r, col] of [
      [0, -R * 0.15, R, "#2d6e1e"],
      [-R * 0.3, -R * 0.2, R * 0.7, "#3a8c28"],
      [R * 0.3, -R * 0.15, R * 0.65, "#348a24"],
      [0, -R * 0.45, R * 0.78, "#4aac32"],
    ] as const) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
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

// --- creature sprites (top-down, recognizable silhouettes) ------------------
// Creatures hide in deep water: ripple → dorsal fin → full body as player nears.
function drawCreatureSprite(
  ctx: CanvasRenderingContext2D,
  kind: string,
  x: number,
  y: number,
  depth: number,
  distToPlayer: number,
) {
  const inWater = depth > 0;
  const closeEnough = distToPlayer < 5; // within 5 tiles → always show full
  const nearish = distToPlayer < 12;    // 5-12 tiles → fin only for big predators

  if (!inWater || closeEnough) {
    // On land or player right next to it — full sprite.
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
    return;
  }

  // In water, far away — show ripple or dorsal fin based on creature type.
  const bigPredator = kind === "dogfish" || kind === "sixgill" || kind === "orca";
  const whale = kind === "humpback" || kind === "greywhale";

  if (bigPredator && nearish) {
    // Dorsal fin breaks the surface — telltale sign of a predator.
    const orcaFin = kind === "orca";
    drawDorsalFin(ctx, x, y, orcaFin);
  } else if (whale && nearish) {
    // Whale blow: a gentle spout visible at range.
    drawWhaleBlow(ctx, x, y);
  } else {
    // Just a water ripple — something is moving under the surface.
    drawRipple(ctx, x, y);
  }
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
  const r = TILE_SIZE * 0.3;
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
  const r = TILE_SIZE * 0.38;
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
  const r = TILE_SIZE * 0.22;
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
  const r = TILE_SIZE * 0.4;
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
  const r = TILE_SIZE * 0.33;
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
  const r = TILE_SIZE * 0.32;
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
      return "#b5651d";
    case "shop":
      return "#9c6b3f";
    case "boathouse":
      return "#8a5a2b";
    case "dock":
      return "#7a5a36";
    default:
      return "#4a4038";
  }
}
