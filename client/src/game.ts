import {
  Appearance,
  BuildingState,
  CRAFT_RECIPES,
  CreatureState,
  ITEM_IDS,
  ITEM_LABEL,
  ItemId,
  PlayerState,
  ResourceNode,
  ServerMessage,
  SKILL_NAMES,
  Snapshot,
  TILE_SIZE,
  Tile,
  TravelNode,
  VehicleState,
  WorldMap,
  WATERLINE_HIGH,
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
  private chatLines: Array<{ from: string; msg: string; channel: "global" | "team"; ts: number }> = [];
  private chargeStart: number | null = null; // when Space went down (for charged swings)
  private chatOpen = false; // is the chat text box visible?
  private craftOpen = false; // is the crafting panel visible?
  private craftSelected = 0; // highlighted recipe index

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
          this.net.send({ t: "harvest" });
          this.net.send({ t: "repair" });
        } else if (k === "q") {
          this.net.send({ t: "eat" });
        } else if (k === "g") {
          this.net.send({ t: "fish" });
        } else if (k === "t") {
          this.net.send({ t: "travel" });
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
  }

  private sendInput() {
    let dx = 0;
    let dy = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    if (dx !== this.lastDir.x || dy !== this.lastDir.y) {
      this.lastDir = { x: dx, y: dy };
      this.net.send({ t: "input", dx, dy });
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
      const prefix = m.channel === "team" ? "[TEAM] " : "";
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
    this.drawTravelNodes();
    this.drawResourceNodes(this.snap.resourceNodes, me);
    this.drawBuildings(this.snap.buildings);
    this.drawVehicles(this.snap.vehicles);
    this.drawCreatures(this.snap.creatures);
    for (const p of this.snap.players) this.drawPlayer(p, p.id === this.myId);
    if (me) this.drawSelfOverlay(me);
    this.drawHud(this.snap, me);
    this.drawTravelPrompt(me);
    this.drawBoardPrompt(me);
    this.drawHarvestPrompt(this.snap.resourceNodes, me);
    this.drawFishPrompt(me);
    if (this.craftOpen) this.drawCraftPanel(me);
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
          // The water has actually risen over this tile. Deeper = darker.
          ctx.fillStyle = waterShade(depth);
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

  private drawTravelNodes() {
    const ctx = this.ctx;
    for (const n of this.travelNodes) {
      const { sx, sy } = this.toScreen(n.x, n.y);
      const w = n.w * TILE_SIZE;
      const h = n.h * TILE_SIZE;
      ctx.fillStyle = TRAVEL_COLOR[n.kind];
      ctx.globalAlpha = 0.55;
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

  private drawHarvestPrompt(nodes: ResourceNode[], me?: PlayerState) {
    if (!me) return;
    const near = nodes.find(
      (n) =>
        !n.depleted &&
        Math.hypot((n.x + 0.5 - me.x) * TILE_SIZE, (n.y + 0.5 - me.y) * TILE_SIZE) <= HARVEST_RANGE_PX,
    );
    if (!near) return;
    const label = near.kind === "tree" ? "Chop tree (E)" : near.kind === "ironOre" ? "Mine iron (E)" : "Mine stone (E)";
    const ctx = this.ctx;
    ctx.font = "15px system-ui";
    ctx.textAlign = "center";
    const w = ctx.measureText(label).width + 28;
    const x = this.canvas.width / 2;
    const y = this.canvas.height - 146;
    ctx.fillStyle = "rgba(7,19,28,0.85)";
    ctx.fillRect(x - w / 2, y - 22, w, 32);
    ctx.strokeStyle = near.kind === "tree" ? "#4caf50" : "#ff9800";
    ctx.strokeRect(x - w / 2, y - 22, w, 32);
    ctx.fillStyle = "#eaf2f8";
    ctx.fillText(label, x, y);
  }

  private drawCreatures(creatures: CreatureState[]) {
    for (const c of creatures) {
      const { sx, sy } = this.toScreen(c.x, c.y);
      drawCreatureSprite(this.ctx, c.kind, sx, sy);
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
    // Name.
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.7);
  }

  private drawHud(snap: Snapshot, me?: PlayerState) {
    const hud = document.getElementById("hud")!;
    const tidePct = Math.round(snap.tide * 100);
    const event = snap.event === "tsunami" ? " ⚠ TSUNAMI" : snap.event === "king" ? " ⚠ King tide" : "";
    const hp = me ? Math.max(0, Math.round(me.hp)) : 0;
    const stam = me ? Math.max(0, Math.round(me.stamina)) : 0;
    const skillsHtml = me
      ? SKILL_NAMES
          .filter((sk) => skillLevel(me.skills[sk]) > 0)
          .map((sk) => `${sk.slice(0, 3).toUpperCase()}:${skillLevel(me.skills[sk])}`)
          .join(" ") || "New settler — go earn some XP!"
      : "";
    const invItems = me
      ? (ITEM_IDS as readonly ItemId[])
          .filter((id) => (me.inventory[id] ?? 0) > 0)
          .map((id) => {
            const qty = me.inventory[id] ?? 0;
            const label = ITEM_LABEL[id];
            return id === "food" ? `<span style="color:#7ec8a0">${label}:${qty}</span>` : `${label}:${qty}`;
          })
          .join(" ")
      : "";
    hud.innerHTML =
      `<b>${this.regionName}</b><br />` +
      `<b>Tide:</b> ${snap.phase} (${tidePct}%)${event}<br />` +
      `<b>HP:</b> ${hp}/${me?.maxHp ?? 100} &nbsp; <b>Stam:</b> ${stam}/${me?.maxStamina ?? 100}<br />` +
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
};

const TRAVEL_ICON: Record<TravelNode["kind"], string> = {
  bus: "BUS",
  gate: "GATE",
};

// Deeper water renders darker (shallow teal -> deep navy).
function waterShade(depth: number): string {
  const t = Math.max(0, Math.min(1, depth / 30));
  const r = Math.round(47 + (10 - 47) * t);
  const g = Math.round(127 + (34 - 127) * t);
  const b = Math.round(168 + (54 - 168) * t);
  return `rgb(${r},${g},${b})`;
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

  if (n.kind === "tree") {
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
function drawCreatureSprite(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number) {
  switch (kind) {
    case "crab":
      return drawCrab(ctx, x, y);
    case "octopus":
      return drawOctopus(ctx, x, y);
    case "dogfish":
      return drawShark(ctx, x, y, 0.55, "#5a6b78", false);
    case "sixgill":
      return drawShark(ctx, x, y, 0.8, "#3b4a57", false);
    case "orca":
      return drawShark(ctx, x, y, 0.9, "#10141a", true);
    case "humpback":
      return drawWhale(ctx, x, y, "#33414b");
    case "greywhale":
      return drawWhale(ctx, x, y, "#6b7480");
  }
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
