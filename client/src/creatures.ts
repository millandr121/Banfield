// Creature sprite renderers — shared by the game and the sprite editor.
//
// Each creature is hand-drawn with vector primitives (no sprite sheet) at a
// scale relative to TILE_SIZE. `drawFullCreature` dispatches by kind; the game
// also uses `drawCreatureSprite` to reveal marine animals through the water
// surface by depth. These functions are pure: they only touch the passed ctx.

import { TILE_SIZE, DEPTH_ANKLE, DEPTH_SWIM, DEPTH_DEEP } from "../../shared/protocol";
import { SpriteDoc, compositeFrame, clipFrames } from "../../shared/sprite";

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ── Authored sprite docs override the vector art ────────────────────────────
// The game (and editor) register a provider that returns a painted SpriteDoc +
// current walk-cycle frame for a creature kind. When present, drawFullCreature
// blits the pixel sprite instead of drawing the procedural vector silhouette,
// so authored creature art flows through every existing call site unchanged
// (land animals, marine surface-reveal, minimap thumbnails).
interface CreatureDocHit { doc: SpriteDoc; frameIdx: number; clip?: string }
let creatureDocProvider: ((kind: string) => CreatureDocHit | null) | null = null;
export function setCreatureDocProvider(
  fn: ((kind: string) => CreatureDocHit | null) | null,
) { creatureDocProvider = fn; }

function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) => v.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

/** Blit a composited creature sprite-doc frame, centered on (x, y). */
export function drawCreatureDoc(
  ctx: CanvasRenderingContext2D,
  doc: SpriteDoc,
  frameIdx: number,
  x: number,
  y: number,
  scale = 1,
  clip?: string,
) {
  const frames = clipFrames(doc, clip, "down");
  if (frames.length === 0) return;
  const frame = frames[((frameIdx % frames.length) + frames.length) % frames.length];
  const comp = compositeFrame(frame, doc.layerNames.map(() => true), doc.w, doc.h);
  const ox = Math.round(x - (doc.w * scale) / 2);
  const oy = Math.round(y - (doc.h * scale) / 2);
  for (let py = 0; py < doc.h; py++) {
    for (let px = 0; px < doc.w; px++) {
      const col = comp[py * doc.w + px];
      if (!col) continue;
      ctx.fillStyle = col;
      ctx.fillRect(ox + px * scale, oy + py * scale, scale, scale);
    }
  }
}

/**
 * Rasterize the procedural vector art for a creature into a flat pixel buffer of
 * size w×h, bounding-box-fit and centered — a starting point the artist can then
 * refine in the editor. Browser-only (uses OffscreenCanvas).
 */
export function rasterizeCreatureToPixels(kind: string, w: number, h: number): string[] {
  const out = new Array(w * h).fill("");
  const S = 96;
  let img: Uint8ClampedArray;
  try {
    const cv = new OffscreenCanvas(S, S);
    const c = cv.getContext("2d")!;
    drawCreatureVector(c as unknown as CanvasRenderingContext2D, kind, S / 2, S / 2);
    img = c.getImageData(0, 0, S, S).data;
  } catch { return out; }

  let minX = S, minY = S, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (img[(y * S + x) * 4 + 3] > 20) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) return out;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const scale = Math.min((w - 2) / bw, (h - 2) / bh);
  const dw = bw * scale, dh = bh * scale;
  const offX = (w - dw) / 2, offY = (h - dh) / 2;
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const sx = minX + (tx + 0.5 - offX) / scale;
      const sy = minY + (ty + 0.5 - offY) / scale;
      if (sx < minX || sx > maxX || sy < minY || sy > maxY) continue;
      const i = (((sy | 0) * S) + (sx | 0)) * 4;
      if (img[i + 3] < 40) continue;
      out[ty * w + tx] = rgbToHex(img[i], img[i + 1], img[i + 2]);
    }
  }
  return out;
}

export const MARINE_KINDS = new Set([
  "crab", "octopus", "dogfish", "sixgill", "orca",
  "humpback", "greywhale", "seal", "sealLion", "seaOtter",
]);

export function drawFullCreature(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number) {
  // Authored pixel sprite takes precedence over the procedural vector art.
  if (creatureDocProvider) {
    const r = creatureDocProvider(kind);
    if (r) { drawCreatureDoc(ctx, r.doc, r.frameIdx, x, y, 1, r.clip); return; }
  }
  drawCreatureVector(ctx, kind, x, y);
}

// The procedural vector silhouette, always — used as the fallback and as the
// seed for rasterization (so it never recurses into an authored sprite).
export function drawCreatureVector(ctx: CanvasRenderingContext2D, kind: string, x: number, y: number) {
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
export function drawCreatureSprite(
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
