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
  WATERLINE_HIGH,
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
    if (p.dead) ctx.globalAlpha = 0.3;

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

// Deeper water renders darker (shallow teal -> deep navy).
function waterShade(depth: number): string {
  const t = Math.max(0, Math.min(1, depth / 30));
  const r = Math.round(47 + (10 - 47) * t);
  const g = Math.round(127 + (34 - 127) * t);
  const b = Math.round(168 + (54 - 168) * t);
  return `rgb(${r},${g},${b})`;
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
