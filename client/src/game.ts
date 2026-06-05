import {
  Appearance,
  BuildingState,
  CreatureState,
  PlayerState,
  ServerMessage,
  Snapshot,
  TILE_SIZE,
  Tile,
  TravelNode,
  WorldMap,
  TILE_ELEVATION,
} from "../../shared/protocol";
import { Net } from "./net";

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

const CREATURE_STYLE: Record<string, { color: string; r: number }> = {
  crab: { color: "#c0392b", r: 0.35 },
  octopus: { color: "#8e44ad", r: 0.45 },
  dogfish: { color: "#566573", r: 0.5 },
  sixgill: { color: "#34495e", r: 0.7 },
  orca: { color: "#11151a", r: 0.85 },
  humpback: { color: "#3a4750", r: 1.1 },
  greywhale: { color: "#69707a", r: 1.1 },
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
  }

  private resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const k = e.key.toLowerCase();
    if (down) {
      if (k === " ") this.net.send({ t: "attack" });
      if (k === "e") this.net.send({ t: "repair" });
      if (k === "t") this.net.send({ t: "travel" });
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
    this.drawBuildings(this.snap.buildings);
    this.drawCreatures(this.snap.creatures);
    for (const p of this.snap.players) this.drawPlayer(p, p.id === this.myId);
    this.drawHud(this.snap, me);
    this.drawTravelPrompt(me);
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
        const tile = map.tiles[y * map.width + x] as Tile;
        const { sx, sy } = this.toScreen(x, y);
        ctx.fillStyle = TILE_COLORS[tile];
        ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
        // Tiles currently under the tide get a translucent water overlay.
        if (tile !== Tile.Water && TILE_ELEVATION[tile] < snap.waterline) {
          ctx.fillStyle = "rgba(28,95,134,0.55)";
          ctx.fillRect(sx, sy, TILE_SIZE, TILE_SIZE);
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
      } else {
        ctx.fillStyle = buildingColor(b.kind);
        ctx.fillRect(sx, sy, w, h);
        ctx.strokeStyle = "#1a1a1a";
        ctx.strokeRect(sx, sy, w, h);
        // HP bar.
        const frac = Math.max(0, b.hp / b.maxHp);
        ctx.fillStyle = "#222";
        ctx.fillRect(sx, sy - 6, w, 4);
        ctx.fillStyle = frac > 0.5 ? "#4caf50" : frac > 0.25 ? "#ffb300" : "#e53935";
        ctx.fillRect(sx, sy - 6, w * frac, 4);
      }
    }
  }

  private drawCreatures(creatures: CreatureState[]) {
    const ctx = this.ctx;
    for (const c of creatures) {
      const style = CREATURE_STYLE[c.kind] ?? { color: "#fff", r: 0.4 };
      const { sx, sy } = this.toScreen(c.x, c.y);
      ctx.fillStyle = style.color;
      ctx.beginPath();
      ctx.arc(sx, sy, style.r * TILE_SIZE, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawPlayer(p: PlayerState, isMe: boolean) {
    const ctx = this.ctx;
    const { sx, sy } = this.toScreen(p.x, p.y);
    if (p.dead) {
      ctx.globalAlpha = 0.3;
    }
    // Body (shirt).
    ctx.fillStyle = p.appearance.shirt;
    ctx.beginPath();
    ctx.arc(sx, sy, TILE_SIZE * 0.42, 0, Math.PI * 2);
    ctx.fill();
    // Head (skin).
    ctx.fillStyle = p.appearance.skin;
    ctx.beginPath();
    ctx.arc(sx, sy, TILE_SIZE * 0.26, 0, Math.PI * 2);
    ctx.fill();
    // Hair cap.
    ctx.fillStyle = p.appearance.hair;
    ctx.beginPath();
    ctx.arc(sx, sy, TILE_SIZE * 0.26, Math.PI, Math.PI * 2);
    ctx.fill();
    // Outline for self.
    if (isMe) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, TILE_SIZE * 0.46, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Name.
    ctx.fillStyle = "#eaf2f8";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText(p.name, sx, sy - TILE_SIZE * 0.6);
  }

  private drawHud(snap: Snapshot, me?: PlayerState) {
    const hud = document.getElementById("hud")!;
    const tidePct = Math.round(snap.tide * 100);
    const event = snap.event === "tsunami" ? " ⚠ TSUNAMI" : snap.event === "king" ? " ⚠ King tide" : "";
    const hp = me ? Math.max(0, Math.round(me.hp)) : 0;
    hud.innerHTML =
      `<b>${this.regionName}</b><br />` +
      `<b>Tide:</b> ${snap.phase} (${tidePct}%)${event}<br />` +
      `<b>HP:</b> ${hp}/${me?.maxHp ?? 100}<br />` +
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
  car: "#4285f4",
  boat: "#00acc1",
};

const TRAVEL_ICON: Record<TravelNode["kind"], string> = {
  bus: "BUS",
  car: "CAR",
  boat: "BOAT",
};

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
