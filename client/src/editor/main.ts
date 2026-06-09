// Banfield Sprite Editor — a self-contained, layered pixel-art tool.
//
// Authors SpriteDoc files (see shared/sprite.ts): per-facing animation frames,
// each a stack of named layers (skin / hair / shirt / pants / accessory).
// Paint with pencil / eraser / fill / eyedropper, preview the walk cycle live,
// and save / export to JSON or a PNG sprite sheet.

import {
  Facing, FACINGS, SpriteDoc, SpriteFrame, DyeRole, DYE_ROLES, Tints,
  newSpriteDoc, emptyFrame, emptyPixels, compositeFrame, normalizeLayers, renderFrame,
} from "../../../shared/sprite";
import baseChar from "../assets/base-character.json";
import rawItemSheet from "../assets/item-sprites.json";
import npcLooksData from "../assets/npc-looks.json";
import rawTerrainData from "../assets/terrain-settings.json";
import { drawCharacterPixel } from "../pixelchar";
import type { Appearance } from "../../../shared/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Editor mode ───────────────────────────────────────────────────────────────
type EditorMode = "char" | "items" | "npcs" | "creatures" | "terrain";
let editorMode: EditorMode = "char";

// ── Terrain settings state ────────────────────────────────────────────────────
const TERRAIN_KEY = "banfield-terrain";
interface TerrainSettings { colors: Record<string, string>; }
const TERRAIN_DEFAULTS = (rawTerrainData as unknown as TerrainSettings).colors;
const TERRAIN_LABELS: Record<string, string> = {
  grass: "Grass", forest: "Forest", sand: "Sand", hill: "Hill",
  rock: "Rock", road: "Road", water: "Water (sea)", freshwater: "Fresh Water", dock: "Dock",
};
let terrainSettings: TerrainSettings = loadTerrainSettings();
function loadTerrainSettings(): TerrainSettings {
  try { const r = localStorage.getItem(TERRAIN_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
  return { colors: { ...TERRAIN_DEFAULTS } };
}
function saveTerrainSettings() { localStorage.setItem(TERRAIN_KEY, JSON.stringify(terrainSettings)); }

// ── Item sprites state ────────────────────────────────────────────────────────
interface ItemSheet { version: number; size: number; icons: Record<string, string[]>; }
const ITEM_SHEET_KEY = "banfield-item-sprites";
let itemSheet: ItemSheet = loadItemSheet();
let currentItemId = "";       // which icon is being edited
let itemPixels: string[] = []; // flat ITEM_SIZE×ITEM_SIZE editable copy
const ITEM_SIZE: number = (rawItemSheet as unknown as ItemSheet).size;

function loadItemSheet(): ItemSheet {
  try {
    const raw = localStorage.getItem(ITEM_SHEET_KEY);
    if (raw) return JSON.parse(raw) as ItemSheet;
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(rawItemSheet)) as ItemSheet;
}
function saveItemSheet() {
  localStorage.setItem(ITEM_SHEET_KEY, JSON.stringify(itemSheet));
}

// ── NPC state ─────────────────────────────────────────────────────────────────
const NPC_LOOKS_KEY = "banfield-npc-looks";
type NpcKind = keyof typeof npcLooksData;
const NPC_KINDS = Object.keys(npcLooksData) as NpcKind[];
const NPC_DISPLAY: Record<string, string> = {
  naturalist: "Naturalist", pirate: "Local Pirate", scientist: "Marine Scientist",
  westsider: "West Sider", eastsider: "East Sider", huuayaht: "Huu-ay-aht",
  mayor: "Mayor", historian: "Historian", boatdealer: "Boat Dealer",
  icevendor: "Ice Vendor", seamstress: "Seamstress", researcher2: "Field Researcher",
  marineBiologist: "Marine Biologist", snorkeler: "Snorkeler",
};
let npcLooks: Record<string, Appearance> = loadNpcLooks();
let currentNpcKind = "";

function loadNpcLooks(): Record<string, Appearance> {
  try {
    const raw = localStorage.getItem(NPC_LOOKS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(npcLooksData));
}
function saveNpcLooks() {
  localStorage.setItem(NPC_LOOKS_KEY, JSON.stringify(npcLooks));
}

// ── Creature kinds ────────────────────────────────────────────────────────────
const CREATURE_KINDS = [
  "seal", "sealLion", "seaOtter", "deer", "elk", "grouse", "bear", "cougar", "wolf",
  "crab", "octopus", "dogfish", "sixgill", "orca", "humpback", "greywhale",
];
const CREATURE_DISPLAY: Record<string, string> = {
  seal: "Seal", sealLion: "Sea Lion", seaOtter: "Sea Otter", deer: "Deer",
  elk: "Elk", grouse: "Grouse", bear: "Bear", cougar: "Cougar", wolf: "Wolf",
  crab: "Crab", octopus: "Octopus", dogfish: "Dogfish", sixgill: "Sixgill Shark",
  orca: "Orca", humpback: "Humpback Whale", greywhale: "Grey Whale",
};

// ── Editor state ──────────────────────────────────────────────────────────────
type Tool = "pencil" | "eraser" | "fill" | "pick";
const STORAGE_KEY = "banfield-sprite-doc";

// Sample dye colours for the live tint preview (don't change the painted art).
let tints: Tints = { skin: "#d8a870", hair: "#5a4632", shirt: "#3f8a44", pants: "#36507e", accent: "#ffd54f" };
let tintPreview = false;

let doc: SpriteDoc = loadFromStorage() ?? normalizeLayers(JSON.parse(JSON.stringify(baseChar)) as SpriteDoc);
let facing: Facing = "down";
let frameIdx = 0;
let layerIdx = 0;
let layerVisible: boolean[] = doc.layerNames.map(() => true);
let tool: Tool = "pencil";
let color = "#e0ac69";
let zoom = 14;
let showGrid = true;
let onion = false;
let playing = true;

// Eastward-leaning default palette — warm skins, hairs, cloth, and accents.
const PALETTE = [
  "#1a0e09", "#3a2418", "#5a4632", "#8a6038", "#caa472", "#e7c9a4", "#f4ddc0", "#ffffff",
  "#9a1f1f", "#c4582e", "#e0901f", "#ffd54f", "#88b040", "#3f6b34", "#1f5742", "#0d47a1",
  "#2e9bd6", "#7fd0c2", "#8b2252", "#d946a8", "#7b3fa0", "#4a148c", "#2a3a55", "#1a1410",
];

// ── Canvas refs ────────────────────────────────────────────────────────────────
const stage = $<HTMLCanvasElement>("stage");
const sctx = stage.getContext("2d")!;
const preview = $<HTMLCanvasElement>("preview");
const pctx = preview.getContext("2d")!;
const itemPreview = $<HTMLCanvasElement>("item-preview");
const ipctx = itemPreview.getContext("2d")!;
const npcPreviewCanvas = $<HTMLCanvasElement>("npc-preview");
const npcPctx = npcPreviewCanvas.getContext("2d")!;

// ── Helpers ────────────────────────────────────────────────────────────────────
function curFrame(): SpriteFrame { return doc.facings[facing][frameIdx]; }
function curLayer(): string[] { return curFrame().layers[layerIdx]; }
function idx(x: number, y: number) { return y * doc.w + x; }

function loadFromStorage(): SpriteDoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeLayers(JSON.parse(raw));
  } catch { return null; }
}
function saveToStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
}

// ── Stage rendering ──────────────────────────────────────────────────────────
function sizeStage() {
  const w = editorMode === "items" ? ITEM_SIZE : doc.w;
  const h = editorMode === "items" ? ITEM_SIZE : doc.h;
  stage.width  = w * zoom;
  stage.height = h * zoom;
  stage.style.width  = stage.width  + "px";
  stage.style.height = stage.height + "px";
}

function drawStage() {
  sctx.clearRect(0, 0, stage.width, stage.height);

  if (editorMode === "items") {
    // Items mode: paint the flat 16×16 pixel array directly.
    const W = ITEM_SIZE, H = ITEM_SIZE;
    paintPixels(sctx, itemPixels, zoom, ITEM_SIZE, ITEM_SIZE);
    if (showGrid && zoom >= 6) {
      sctx.strokeStyle = "rgba(255,255,255,0.09)";
      sctx.lineWidth = 1;
      for (let x = 0; x <= W; x++) {
        sctx.beginPath(); sctx.moveTo(x * zoom + .5, 0); sctx.lineTo(x * zoom + .5, stage.height); sctx.stroke();
      }
      for (let y = 0; y <= H; y++) {
        sctx.beginPath(); sctx.moveTo(0, y * zoom + .5); sctx.lineTo(stage.width, y * zoom + .5); sctx.stroke();
      }
    }
    // Update item preview (scaled up)
    ipctx.clearRect(0, 0, itemPreview.width, itemPreview.height);
    const sc = Math.floor(itemPreview.width / ITEM_SIZE);
    const ox2 = (itemPreview.width  - ITEM_SIZE * sc) / 2;
    const oy2 = (itemPreview.height - ITEM_SIZE * sc) / 2;
    ipctx.save(); ipctx.translate(ox2, oy2);
    paintPixels(ipctx, itemPixels, sc, ITEM_SIZE, ITEM_SIZE);
    ipctx.restore();
    return;
  }

  // Char mode: existing logic.
  if (onion) {
    const frames = doc.facings[facing];
    const prev = frames[(frameIdx - 1 + frames.length) % frames.length];
    if (prev !== curFrame()) {
      const comp = compositeFrame(prev, layerVisible, doc.w, doc.h);
      sctx.globalAlpha = 0.25;
      paintPixels(sctx, comp, zoom);
      sctx.globalAlpha = 1;
    }
  }

  const comp = tintPreview
    ? renderFrame(doc, facing, frameIdx, tints, layerVisible)
    : compositeFrame(curFrame(), layerVisible, doc.w, doc.h);
  paintPixels(sctx, comp, zoom);

  if (showGrid && zoom >= 8) {
    sctx.strokeStyle = "rgba(255,255,255,0.07)";
    sctx.lineWidth = 1;
    for (let x = 0; x <= doc.w; x++) {
      sctx.beginPath(); sctx.moveTo(x * zoom + .5, 0); sctx.lineTo(x * zoom + .5, stage.height); sctx.stroke();
    }
    for (let y = 0; y <= doc.h; y++) {
      sctx.beginPath(); sctx.moveTo(0, y * zoom + .5); sctx.lineTo(stage.width, y * zoom + .5); sctx.stroke();
    }
  }
}

function paintPixels(ctx: CanvasRenderingContext2D, px: string[], scale: number, W = doc.w, H = doc.h) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = px[y * W + x];
      if (!c) continue;
      ctx.fillStyle = c;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

// ── Preview animation ────────────────────────────────────────────────────────
let previewFrame = 0;
let lastTick = 0;
function previewLoop(t: number) {
  requestAnimationFrame(previewLoop);
  const frames = doc.facings[facing];
  if (playing && t - lastTick > 1000 / Math.max(1, doc.fps)) {
    previewFrame = (previewFrame + 1) % frames.length;
    lastTick = t;
  }
  const pf = playing ? previewFrame % frames.length : frameIdx;
  const comp = tintPreview
    ? renderFrame(doc, facing, pf, tints, layerVisible)
    : compositeFrame(frames[pf], layerVisible, doc.w, doc.h);
  const scale = Math.min(preview.width / doc.w, preview.height / doc.h) | 0;
  const ox = (preview.width - doc.w * scale) / 2;
  const oy = (preview.height - doc.h * scale) / 2;
  pctx.clearRect(0, 0, preview.width, preview.height);
  pctx.save();
  pctx.translate(ox, oy);
  paintPixels(pctx, comp, scale);
  pctx.restore();
}
requestAnimationFrame(previewLoop);

// ── Painting ─────────────────────────────────────────────────────────────────
function pointerToCell(e: PointerEvent): [number, number] | null {
  const r = stage.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / zoom);
  const y = Math.floor((e.clientY - r.top) / zoom);
  const W = editorMode === "items" ? ITEM_SIZE : doc.w;
  const H = editorMode === "items" ? ITEM_SIZE : doc.h;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  return [x, y];
}

function itemIdx(x: number, y: number) { return y * ITEM_SIZE + x; }

function applyTool(x: number, y: number) {
  if (editorMode === "items") {
    const i = itemIdx(x, y);
    if (tool === "pencil") itemPixels[i] = color;
    else if (tool === "eraser") itemPixels[i] = "";
    else if (tool === "pick") { const c = itemPixels[i]; if (c) setColor(c); return; }
    else if (tool === "fill") floodFill(itemPixels, x, y, itemPixels[i], color, ITEM_SIZE, ITEM_SIZE);
    drawStage();
    return;
  }
  const layer = curLayer();
  if (tool === "pencil") layer[idx(x, y)] = color;
  else if (tool === "eraser") layer[idx(x, y)] = "";
  else if (tool === "pick") {
    const comp = compositeFrame(curFrame(), layerVisible, doc.w, doc.h);
    const c = comp[idx(x, y)];
    if (c) setColor(c);
    return;
  } else if (tool === "fill") {
    floodFill(layer, x, y, layer[idx(x, y)], color, doc.w, doc.h);  // char
  }
  drawStage();
}

function floodFill(layer: string[], sx: number, sy: number, target: string, repl: string, W: number, H: number) {
  if (target === repl) return;
  const ii = (x: number, y: number) => y * W + x;
  const stack: [number, number][] = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (layer[ii(x, y)] !== target) continue;
    layer[ii(x, y)] = repl;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
}

let painting = false;
stage.addEventListener("pointerdown", (e) => {
  const cell = pointerToCell(e);
  if (!cell) return;
  painting = true;
  stage.setPointerCapture(e.pointerId);
  applyTool(cell[0], cell[1]);
});
stage.addEventListener("pointermove", (e) => {
  if (!painting) return;
  const cell = pointerToCell(e);
  if (cell && (tool === "pencil" || tool === "eraser")) applyTool(cell[0], cell[1]);
});
stage.addEventListener("pointerup", (e) => {
  painting = false;
  try { stage.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  saveToStorage();
});

// ── UI builders ──────────────────────────────────────────────────────────────
function setColor(c: string) {
  color = c;
  $<HTMLDivElement>("curcolor").style.background = c;
  ($("colorpick") as HTMLInputElement).value = c.length === 7 ? c : "#000000";
  for (const sw of document.querySelectorAll<HTMLElement>(".swatch"))
    sw.classList.toggle("sel", sw.dataset.c === c);
}

function buildPalette() {
  const wrap = $<HTMLDivElement>("palette");
  wrap.innerHTML = "";
  for (const c of PALETTE) {
    const d = document.createElement("div");
    d.className = "swatch" + (c === color ? " sel" : "");
    d.style.background = c;
    d.dataset.c = c;
    d.title = c;
    d.addEventListener("click", () => setColor(c));
    wrap.appendChild(d);
  }
}

function buildFacings() {
  const wrap = $<HTMLDivElement>("facings");
  wrap.innerHTML = "";
  const labels: Record<Facing, string> = {
    down: "↓", downright: "↘", right: "→", upright: "↗",
    up: "↑", upleft: "↖", left: "←", downleft: "↙",
  };
  for (const f of FACINGS) {
    const b = document.createElement("button");
    b.textContent = labels[f];
    b.className = f === facing ? "active" : "";
    b.addEventListener("click", () => {
      facing = f; frameIdx = 0; previewFrame = 0;
      buildFacings(); buildFrames(); drawStage();
    });
    wrap.appendChild(b);
  }
}

function buildFrames() {
  const wrap = $<HTMLDivElement>("frames");
  wrap.innerHTML = "";
  doc.facings[facing].forEach((_f, i) => {
    const b = document.createElement("button");
    b.textContent = String(i + 1);
    b.className = i === frameIdx ? "active" : "";
    b.addEventListener("click", () => { frameIdx = i; buildFrames(); drawStage(); });
    wrap.appendChild(b);
  });
}

function buildLayers() {
  const wrap = $<HTMLDivElement>("layers");
  wrap.innerHTML = "";
  // Draw top layer first in the list (reverse of paint order) for intuitive stacking.
  for (let li = doc.layerNames.length - 1; li >= 0; li--) {
    const row = document.createElement("div");
    row.className = "layer" + (li === layerIdx ? " sel" : "");
    const vis = document.createElement("span");
    vis.className = "vis";
    vis.textContent = layerVisible[li] ? "👁" : "🚫";
    vis.addEventListener("click", (e) => {
      e.stopPropagation();
      layerVisible[li] = !layerVisible[li];
      buildLayers(); drawStage();
    });
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = doc.layerNames[li];
    // Dye role selector — decides how this layer re-tints at runtime.
    const sel = document.createElement("select");
    sel.style.cssText = "font-size:10px;padding:2px;max-width:74px";
    for (const role of DYE_ROLES) {
      const opt = document.createElement("option");
      opt.value = role; opt.textContent = role;
      if ((doc.layerDye[li] ?? "none") === role) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", () => {
      doc.layerDye[li] = sel.value as DyeRole;
      doc.layerRefLum = undefined; // recompute on next tint
      saveToStorage(); drawStage();
    });
    row.appendChild(vis); row.appendChild(nm); row.appendChild(sel);
    row.addEventListener("click", () => { layerIdx = li; buildLayers(); });
    wrap.appendChild(row);
  }
}

// Live dye-preview panel: toggle tinting and sample each role's colour.
function buildDyePanel() {
  let g = document.getElementById("dyepanel");
  if (g) g.remove();
  g = document.createElement("div");
  g.className = "group";
  g.id = "dyepanel";
  const roles: (keyof Tints)[] = ["skin", "hair", "shirt", "pants", "accent"];
  g.innerHTML = `<h2>Dye preview</h2>
    <label style="display:flex;gap:6px;align-items:center;margin-bottom:7px">
      <input type="checkbox" id="tintToggle" ${tintPreview ? "checked" : ""}/> show dyed colours
    </label>`;
  for (const role of roles) {
    const row = document.createElement("div");
    row.className = "row";
    row.style.marginBottom = "4px";
    const input = document.createElement("input");
    input.type = "color";
    input.value = tints[role] ?? "#888888";
    input.addEventListener("input", () => {
      tints[role] = input.value;
      if (tintPreview) drawStage();
    });
    const lbl = document.createElement("span");
    lbl.textContent = role;
    lbl.style.cssText = "font-size:11px;color:var(--muted)";
    row.appendChild(input); row.appendChild(lbl);
    g.appendChild(row);
  }
  document.querySelector(".right")!.appendChild(g);
  $<HTMLInputElement>("tintToggle").addEventListener("change", (e) => {
    tintPreview = (e.target as HTMLInputElement).checked;
    drawStage();
  });
}

// ── Tool buttons ─────────────────────────────────────────────────────────────
for (const b of document.querySelectorAll<HTMLButtonElement>("#tools button")) {
  b.addEventListener("click", () => {
    tool = b.dataset.tool as Tool;
    for (const o of document.querySelectorAll("#tools button")) o.classList.remove("active");
    b.classList.add("active");
  });
}

// ── Controls ─────────────────────────────────────────────────────────────────
($("colorpick") as HTMLInputElement).addEventListener("input", (e) =>
  setColor((e.target as HTMLInputElement).value));

$<HTMLInputElement>("zoom").addEventListener("input", (e) => {
  zoom = +(e.target as HTMLInputElement).value;
  sizeStage(); drawStage();
});
$<HTMLInputElement>("grid").addEventListener("change", (e) => {
  showGrid = (e.target as HTMLInputElement).checked; drawStage();
});
$<HTMLInputElement>("onion").addEventListener("change", (e) => {
  onion = (e.target as HTMLInputElement).checked; drawStage();
});
$<HTMLInputElement>("fps").addEventListener("change", (e) => {
  doc.fps = Math.max(1, Math.min(24, +(e.target as HTMLInputElement).value));
  saveToStorage();
});
$<HTMLInputElement>("docname").addEventListener("input", (e) => {
  doc.name = (e.target as HTMLInputElement).value; saveToStorage();
});

$("btn-play").addEventListener("click", () => {
  playing = !playing;
  $("btn-play").textContent = playing ? "▶ Play" : "❚❚ Pause";
  $("btn-play").classList.toggle("active", playing);
});

$("btn-clear").addEventListener("click", () => {
  curFrame().layers[layerIdx] = emptyPixels(doc.w, doc.h);
  saveToStorage(); drawStage();
});

// Frame ops
$("frame-add").addEventListener("click", () => {
  doc.facings[facing].push(emptyFrame(doc.w, doc.h, doc.layerNames.length));
  frameIdx = doc.facings[facing].length - 1;
  saveToStorage(); buildFrames(); drawStage();
});
$("frame-dup").addEventListener("click", () => {
  const clone: SpriteFrame = { layers: curFrame().layers.map((l) => [...l]) };
  doc.facings[facing].splice(frameIdx + 1, 0, clone);
  frameIdx++;
  saveToStorage(); buildFrames(); drawStage();
});
$("frame-del").addEventListener("click", () => {
  if (doc.facings[facing].length <= 1) return;
  doc.facings[facing].splice(frameIdx, 1);
  frameIdx = Math.min(frameIdx, doc.facings[facing].length - 1);
  saveToStorage(); buildFrames(); drawStage();
});

// Doc ops
$("btn-new").addEventListener("click", () => {
  if (!confirm("Start a new sprite? Unsaved work in this slot is replaced.")) return;
  doc = newSpriteDoc($<HTMLInputElement>("docname").value || "character");
  facing = "down"; frameIdx = 0; layerIdx = 0;
  layerVisible = doc.layerNames.map(() => true);
  saveToStorage(); refreshAll();
});
$("btn-save").addEventListener("click", () => { saveToStorage(); flash("Character saved ✓"); });
$("btn-load").addEventListener("click", () => {
  const d = loadFromStorage();
  if (!d) return flash("Nothing saved yet");
  doc = d; facing = "down"; frameIdx = 0; layerIdx = 0;
  layerVisible = doc.layerNames.map(() => true);
  refreshAll();
});
$("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
  downloadBlob(blob, `${doc.name || "sprite"}.json`);
});
$("btn-import").addEventListener("click", () => $<HTMLInputElement>("file-import").click());
$<HTMLInputElement>("file-import").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    doc = normalizeLayers(JSON.parse(await file.text()));
    facing = "down"; frameIdx = 0; layerIdx = 0;
    layerVisible = doc.layerNames.map(() => true);
    saveToStorage(); refreshAll();
    flash("Imported ✓");
  } catch { flash("Bad file"); }
});

// Export a horizontal sprite sheet: rows = facings, columns = frames.
$("btn-png").addEventListener("click", () => {
  const maxFrames = Math.max(...FACINGS.map((f) => doc.facings[f].length));
  const sheet = document.createElement("canvas");
  sheet.width = doc.w * maxFrames;
  sheet.height = doc.h * FACINGS.length;
  const c = sheet.getContext("2d")!;
  FACINGS.forEach((f, row) => {
    doc.facings[f].forEach((frame, col) => {
      const comp = compositeFrame(frame, doc.layerNames.map(() => true), doc.w, doc.h);
      for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) {
        const px = comp[idx(x, y)];
        if (!px) continue;
        c.fillStyle = px;
        c.fillRect(col * doc.w + x, row * doc.h + y, 1, 1);
      }
    });
  });
  sheet.toBlob((b) => b && downloadBlob(b, `${doc.name || "sprite"}-sheet.png`));
});

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let flashTimer: number | undefined;
function flash(msg: string) {
  let el = document.getElementById("flash");
  if (!el) {
    el = document.createElement("div");
    el.id = "flash";
    el.style.cssText = "position:fixed;bottom:18px;left:50%;transform:translateX(-50%);" +
      "background:#1e3a4c;border:1px solid #2b5067;color:#eaf2f8;padding:8px 16px;" +
      "border-radius:7px;font-size:13px;z-index:50;box-shadow:0 4px 14px rgba(0,0,0,.4)";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = "1";
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => { el!.style.opacity = "0"; el!.style.transition = "opacity .4s"; }, 1400);
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  const map: Record<string, Tool> = { b: "pencil", e: "eraser", g: "fill", i: "pick" };
  if (map[e.key]) {
    tool = map[e.key];
    for (const o of document.querySelectorAll("#tools button")) o.classList.toggle("active",
      (o as HTMLElement).dataset.tool === tool);
  }
});

// ── Item browser ─────────────────────────────────────────────────────────────
function buildItemBrowser() {
  const wrap = $<HTMLDivElement>("item-browser");
  wrap.innerHTML = "";
  for (const [id, pixels] of Object.entries(itemSheet.icons)) {
    const c = document.createElement("canvas");
    c.className = "iicon" + (id === currentItemId ? " sel" : "");
    c.width  = ITEM_SIZE;
    c.height = ITEM_SIZE;
    c.title  = id;
    const cx2 = c.getContext("2d")!;
    for (let i = 0; i < pixels.length; i++) {
      const col = pixels[i];
      if (!col) continue;
      cx2.fillStyle = col;
      cx2.fillRect(i % ITEM_SIZE, i / ITEM_SIZE | 0, 1, 1);
    }
    c.addEventListener("click", () => selectItem(id));
    wrap.appendChild(c);
  }
}

function selectItem(id: string) {
  currentItemId = id;
  itemPixels = [...(itemSheet.icons[id] ?? Array(ITEM_SIZE * ITEM_SIZE).fill(""))];
  $("item-name").textContent = id;
  $("item-info").textContent = `Editing: ${id}  (${ITEM_SIZE}×${ITEM_SIZE})`;
  for (const c of document.querySelectorAll<HTMLElement>(".iicon"))
    c.classList.toggle("sel", c.title === id);
  sizeStage();
  drawStage();
}

// ── NPC grid and editor ───────────────────────────────────────────────────────
function buildNpcGrid() {
  const wrap = $<HTMLDivElement>("npc-grid");
  wrap.innerHTML = "";
  for (const kind of NPC_KINDS) {
    const card = document.createElement("div");
    card.className = "npc-card" + (kind === currentNpcKind ? " sel" : "");
    const c = document.createElement("canvas");
    c.width = 60; c.height = 78;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0c1820";
    cx2.fillRect(0, 0, 60, 78);
    const app = npcLooks[kind] ?? (npcLooksData as Record<string, Appearance>)[kind];
    drawCharacterPixel(cx2, 30, 58, app, { facing: "down", phase: 0, moving: false });
    const lbl = document.createElement("div");
    lbl.className = "npc-label";
    lbl.textContent = NPC_DISPLAY[kind] ?? kind;
    card.appendChild(c);
    card.appendChild(lbl);
    card.addEventListener("click", () => selectNpc(kind));
    wrap.appendChild(card);
  }
}

function selectNpc(kind: string) {
  currentNpcKind = kind;
  for (const c of document.querySelectorAll<HTMLElement>(".npc-card"))
    c.classList.toggle("sel", c.querySelector(".npc-label")?.textContent === (NPC_DISPLAY[kind] ?? kind));
  buildNpcAppEditor(kind);
  renderNpcPreview(kind);
}

function renderNpcPreview(kind: string) {
  npcPctx.clearRect(0, 0, npcPreviewCanvas.width, npcPreviewCanvas.height);
  npcPctx.fillStyle = "#0c1820";
  npcPctx.fillRect(0, 0, npcPreviewCanvas.width, npcPreviewCanvas.height);
  const app = npcLooks[kind] ?? (npcLooksData as Record<string, Appearance>)[kind];
  drawCharacterPixel(npcPctx, npcPreviewCanvas.width / 2, npcPreviewCanvas.height * 0.8, app, { facing: "down", phase: 0, moving: false });
}

function buildNpcAppEditor(kind: string) {
  const wrap = $("npc-app-editor");
  const app = { ...(npcLooks[kind] ?? (npcLooksData as Record<string, Appearance>)[kind]) };
  $("npc-editor-title").textContent = NPC_DISPLAY[kind] ?? kind;
  wrap.innerHTML = "";

  const fields: Array<{ key: keyof Appearance; label: string; type: "color" | "select"; options?: string[] }> = [
    { key: "skin",      label: "Skin",   type: "color" },
    { key: "hair",      label: "Hair",   type: "color" },
    { key: "shirt",     label: "Shirt",  type: "color" },
    { key: "pants",     label: "Pants",  type: "color" },
    { key: "hat",       label: "Hat",    type: "color" },
    { key: "hairStyle", label: "Style",  type: "select", options: ["short", "medium", "long"] },
    { key: "bodyBuild", label: "Build",  type: "select", options: ["slight", "medium", "sturdy"] },
  ];

  for (const f of fields) {
    const row = document.createElement("div");
    row.className = "app-row";
    const lbl = document.createElement("label");
    lbl.textContent = f.label;
    row.appendChild(lbl);
    if (f.type === "color") {
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = ((app as unknown as Record<string, string>)[f.key] ?? "#888888");
      inp.style.cssText = "width:34px;height:26px;padding:0;border:1px solid var(--border);border-radius:4px;cursor:pointer";
      inp.addEventListener("input", () => {
        (npcLooks[kind] as unknown as Record<string, string>)[f.key] = inp.value;
        buildNpcGrid();
        renderNpcPreview(kind);
      });
      row.appendChild(inp);
    } else {
      const sel = document.createElement("select");
      sel.style.cssText = "font-size:11px;padding:2px;flex:1";
      for (const opt of f.options ?? []) {
        const o = document.createElement("option");
        o.value = opt; o.textContent = opt;
        if ((app as unknown as Record<string, string>)[f.key] === opt) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        (npcLooks[kind] as unknown as Record<string, string>)[f.key] = sel.value;
        buildNpcGrid();
        renderNpcPreview(kind);
      });
      row.appendChild(sel);
    }
    wrap.appendChild(row);
  }
}

// ── Creature grid ─────────────────────────────────────────────────────────────
function buildCreatureGrid() {
  const wrap = $<HTMLDivElement>("creature-grid");
  wrap.innerHTML = "";
  for (const kind of CREATURE_KINDS) {
    const card = document.createElement("div");
    card.className = "creature-card";
    const c = document.createElement("canvas");
    c.width = 72; c.height = 72;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e2030";
    cx2.fillRect(0, 0, 72, 72);
    // placeholder: write creature name (drawing requires game.ts internals)
    cx2.fillStyle = "#5a8a40";
    cx2.font = "bold 9px system-ui";
    cx2.textAlign = "center";
    cx2.fillText("◆", 36, 36);
    cx2.fillStyle = "#8fbbdd";
    cx2.font = "8px system-ui";
    cx2.fillText(CREATURE_DISPLAY[kind] ?? kind, 36, 52);
    const lbl = document.createElement("div");
    lbl.className = "npc-label";
    lbl.textContent = CREATURE_DISPLAY[kind] ?? kind;
    card.appendChild(c);
    card.appendChild(lbl);
    wrap.appendChild(card);
  }
}

// ── Editor mode switching ─────────────────────────────────────────────────────
function show(id: string, val: boolean, display = "block") {
  const el = document.getElementById(id);
  if (el) el.style.display = val ? display : "none";
}

function setEditorMode(m: EditorMode) {
  editorMode = m;
  const ALL: EditorMode[] = ["char","items","npcs","creatures","terrain"];
  for (const v of ALL) {
    const btn = document.getElementById(`tab-${v}`);
    if (btn) btn.classList.toggle("active", m === v);
  }

  // Header
  show("docname",   m === "char");
  show("item-name", m === "items");
  show("char-ops",    m === "char",     "flex");
  show("item-ops",    m === "items",    "flex");
  show("npc-ops",     m === "npcs",     "flex");
  show("creature-ops",m === "creatures","flex");
  show("terrain-ops", m === "terrain",  "flex");

  // Left panels (hide tools + palette for terrain/npc/creature)
  show("tools-panel",  m === "char" || m === "items");
  show("colour-panel", m === "char" || m === "items");
  show("canvas-panel", m === "char" || m === "items");
  show("item-browser-panel",  m === "items",    "flex");
  show("npc-grid-panel",      m === "npcs",     "flex");
  show("creature-grid-panel", m === "creatures","flex");
  show("terrain-panel",       m === "terrain",  "flex");

  // Center
  stage.style.display = (m === "char" || m === "items") ? "" : "none";
  show("center-hint",         m === "char" || m === "items");
  show("char-preview-wrap",   m === "char");
  show("item-preview-wrap",   m === "items");
  show("npc-preview-wrap",    m === "npcs");
  show("creature-preview-wrap", m === "creatures");
  show("terrain-preview-wrap",  m === "terrain");

  // Right panels
  ($("char-right-panels") as HTMLElement).style.display = m === "char" ? "contents" : "none";
  show("item-right-panels",     m === "items");
  show("npc-right-panels",      m === "npcs");
  show("creature-right-panels", m === "creatures");
  show("terrain-right-panels",  m === "terrain");

  if (m === "items") {
    buildItemBrowser();
    if (!currentItemId && Object.keys(itemSheet.icons).length > 0) selectItem(Object.keys(itemSheet.icons)[0]);
    else if (currentItemId) { sizeStage(); drawStage(); }
  } else if (m === "npcs") {
    buildNpcGrid();
    if (!currentNpcKind && NPC_KINDS.length > 0) selectNpc(NPC_KINDS[0]);
  } else if (m === "creatures") {
    buildCreatureGrid();
  } else if (m === "terrain") {
    buildTerrainRows();
  } else {
    sizeStage(); drawStage();
  }
}

$("tab-char").addEventListener("click",  () => setEditorMode("char"));
$("tab-items").addEventListener("click", () => setEditorMode("items"));
$("tab-npcs").addEventListener("click", () => setEditorMode("npcs" as EditorMode));
$("tab-creatures").addEventListener("click", () => setEditorMode("creatures" as EditorMode));

// ── Item save / export / import ───────────────────────────────────────────────
$("btn-item-save").addEventListener("click", async () => {
  if (!currentItemId) return flash("Select an item first");
  itemSheet.icons[currentItemId] = [...itemPixels];
  saveItemSheet();
  buildItemBrowser();
  // Also write to actual asset file in dev mode
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "item-sprites.json", data: itemSheet }),
    });
    flash(`Saved ${currentItemId} to game ✓`);
  } catch {
    flash(`Saved icon: ${currentItemId} (localStorage only)`);
  }
});

$("btn-item-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(itemSheet, null, 2)], { type: "application/json" });
  downloadBlob(blob, "item-sprites.json");
  flash("Exported item-sprites.json ✓");
});

$("btn-item-import").addEventListener("click", () => $<HTMLInputElement>("file-item-import").click());
$<HTMLInputElement>("file-item-import").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    itemSheet = JSON.parse(await file.text()) as ItemSheet;
    saveItemSheet();
    currentItemId = "";
    buildItemBrowser();
    if (Object.keys(itemSheet.icons).length > 0) selectItem(Object.keys(itemSheet.icons)[0]);
    flash("Item sprites imported ✓");
  } catch { flash("Bad item-sprites.json file"); }
});

// ── NPC save / reset ──────────────────────────────────────────────────────────
$("btn-npc-save").addEventListener("click", async () => {
  saveNpcLooks();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "npc-looks.json", data: npcLooks }),
    });
    flash("NPC appearances saved to game ✓");
  } catch {
    flash("NPC appearances saved (localStorage only)");
  }
});

$("btn-npc-reset").addEventListener("click", () => {
  if (!confirm("Reset all NPC appearances to defaults?")) return;
  npcLooks = JSON.parse(JSON.stringify(npcLooksData));
  saveNpcLooks();
  buildNpcGrid();
  if (currentNpcKind) { buildNpcAppEditor(currentNpcKind); renderNpcPreview(currentNpcKind); }
  flash("Reset to defaults ✓");
});

// ── Terrain tab ──────────────────────────────────────────────────────────────
const terrainCanvas = $<HTMLCanvasElement>("terrain-preview");
const terrainPctx = terrainCanvas?.getContext("2d");

function buildTerrainRows() {
  const wrap = $("terrain-rows");
  wrap.innerHTML = "";
  for (const [key, label] of Object.entries(TERRAIN_LABELS)) {
    const row = document.createElement("div");
    row.className = "terrain-row";
    const swatch = document.createElement("div");
    swatch.className = "tswatch";
    swatch.style.background = terrainSettings.colors[key] ?? TERRAIN_DEFAULTS[key] ?? "#888";
    const lbl = document.createElement("span");
    lbl.className = "tlabel";
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = terrainSettings.colors[key] ?? TERRAIN_DEFAULTS[key] ?? "#888888";
    inp.addEventListener("input", () => {
      terrainSettings.colors[key] = inp.value;
      swatch.style.background = inp.value;
      renderTerrainPreview();
    });
    row.appendChild(swatch); row.appendChild(lbl); row.appendChild(inp);
    wrap.appendChild(row);
  }
  renderTerrainPreview();
}

function renderTerrainPreview() {
  if (!terrainPctx) return;
  const c = terrainCanvas;
  terrainPctx.clearRect(0, 0, c.width, c.height);
  const keys = Object.keys(TERRAIN_LABELS);
  const cellW = c.width / 3, cellH = c.height / 3;
  for (let i = 0; i < Math.min(9, keys.length); i++) {
    const col = terrainSettings.colors[keys[i]] ?? "#888";
    terrainPctx.fillStyle = col;
    terrainPctx.fillRect((i % 3) * cellW, Math.floor(i / 3) * cellH, cellW, cellH);
    terrainPctx.font = "bold 10px system-ui";
    terrainPctx.fillStyle = "rgba(0,0,0,0.5)";
    terrainPctx.fillText(TERRAIN_LABELS[keys[i]], (i % 3) * cellW + 4, Math.floor(i / 3) * cellH + 13);
  }
}

$("btn-terrain-save")?.addEventListener("click", async () => {
  saveTerrainSettings();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "terrain-settings.json", data: terrainSettings }),
    });
    flash("Terrain colours saved to game ✓");
  } catch { flash("Terrain saved (localStorage only)"); }
});

$("btn-terrain-reset")?.addEventListener("click", () => {
  terrainSettings = { colors: { ...TERRAIN_DEFAULTS } };
  saveTerrainSettings();
  buildTerrainRows();
  flash("Terrain reset to defaults ✓");
});

// ── New sprite file ────────────────────────────────────────────────────────────
$("btn-new-sprite")?.addEventListener("click", () => {
  const name = ($<HTMLInputElement>("new-sprite-name")).value.trim();
  if (!name) return flash("Enter a sprite file name first");
  const cat = ($("new-sprite-category") as unknown as HTMLSelectElement).value;
  if (cat === "items") {
    if (itemSheet.icons[name]) return flash(`Item "${name}" already exists — select it in the Items tab`);
    itemSheet.icons[name] = Array(ITEM_SIZE * ITEM_SIZE).fill("");
    saveItemSheet();
    flash(`Created item icon "${name}" ✓ — switch to Items tab to paint it`);
  } else {
    doc = newSpriteDoc(name);
    layerVisible = doc.layerNames.map(() => true);
    saveToStorage();
    flash(`Created character sprite "${name}" ✓`);
    setEditorMode("char");
  }
  ($<HTMLInputElement>("new-sprite-name")).value = "";
});

$("tab-terrain").addEventListener("click", () => setEditorMode("terrain"));

// ── Init ─────────────────────────────────────────────────────────────────────
function refreshAll() {
  $<HTMLInputElement>("docname").value = doc.name;
  $<HTMLInputElement>("fps").value = String(doc.fps);
  buildPalette(); buildFacings(); buildFrames(); buildLayers(); buildDyePanel();
  setColor(color);
  setEditorMode(editorMode);  // properly initialise all panel states
}
refreshAll();
