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

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

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
  stage.width = doc.w * zoom;
  stage.height = doc.h * zoom;
  stage.style.width = stage.width + "px";
  stage.style.height = stage.height + "px";
}

function drawStage() {
  sctx.clearRect(0, 0, stage.width, stage.height);

  // Onion skin: faint previous frame of this facing.
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

  // Composite all visible layers of the current frame (tinted when previewing dyes).
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

function paintPixels(ctx: CanvasRenderingContext2D, px: string[], scale: number) {
  for (let y = 0; y < doc.h; y++) {
    for (let x = 0; x < doc.w; x++) {
      const c = px[idx(x, y)];
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
  if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) return null;
  return [x, y];
}

function applyTool(x: number, y: number) {
  const layer = curLayer();
  if (tool === "pencil") layer[idx(x, y)] = color;
  else if (tool === "eraser") layer[idx(x, y)] = "";
  else if (tool === "pick") {
    const comp = compositeFrame(curFrame(), layerVisible, doc.w, doc.h);
    const c = comp[idx(x, y)];
    if (c) setColor(c);
    return;
  } else if (tool === "fill") {
    floodFill(layer, x, y, layer[idx(x, y)], color);
  }
  drawStage();
}

function floodFill(layer: string[], sx: number, sy: number, target: string, repl: string) {
  if (target === repl) return;
  const stack: [number, number][] = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= doc.w || y >= doc.h) continue;
    if (layer[idx(x, y)] !== target) continue;
    layer[idx(x, y)] = repl;
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
  const labels: Record<Facing, string> = { down: "↓ Down", up: "↑ Up", left: "← Left", right: "→ Right" };
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
$("btn-save").addEventListener("click", () => { saveToStorage(); flash("Saved to browser ✓"); });
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

// ── Init ─────────────────────────────────────────────────────────────────────
function refreshAll() {
  $<HTMLInputElement>("docname").value = doc.name;
  $<HTMLInputElement>("fps").value = String(doc.fps);
  sizeStage();
  buildPalette(); buildFacings(); buildFrames(); buildLayers(); buildDyePanel();
  setColor(color);
  drawStage();
}
refreshAll();
