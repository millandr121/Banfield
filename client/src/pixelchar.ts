// Eastward-inspired pixel-art character renderer.
//
// Each character is painted into a 20×26 OffscreenCanvas and blitted at an
// exact 2× integer scale with imageSmoothingEnabled=false, giving the warm,
// chunky, outlined look of Eastward / Seiken Densetsu 3.
//
// Art rules (match the reference game):
//  • Every shape has a 1px warm-brown outline drawn first, then the fill.
//  • 3-tone shading: highlight (×1.10) | base | shadow (×0.75).
//  • Eyes are 2×2 with a 1-px white specular catch-light.
//  • Hair is a distinct cap that sits ON TOP of the head circle.
//  • During attacks the WHOLE limb (sleeve+forearm+hand) moves as one unit.

import { Appearance, ItemId, TILE_SIZE } from "../../shared/protocol";

export type Facing = "down" | "up" | "left" | "right";

// ── Sprite space constants ────────────────────────────────────────────────────
const SW        = 20;   // sprite width  (px)
const SH        = 26;   // sprite height (px)
const CX        = 10;   // sprite center-X
const FEET_ROW  = 24;   // row that lands on the ground contact point
const BLT       = 3;    // 3× blit → crisp 60×78 px — large enough for Eastward detail
const FOOT_OFF  = Math.round(TILE_SIZE * 0.375);  // screen-px offset below tile centre

// Eastward's signature warm outline
const OL = "#1a0e09";

// ── OffscreenCanvas ───────────────────────────────────────────────────────────
let _buf: OffscreenCanvas | null = null;
let _bctx: OffscreenCanvasRenderingContext2D | null = null;
type B = OffscreenCanvasRenderingContext2D;

function getBuf(): [OffscreenCanvas, B] {
  if (!_buf) {
    _buf  = new OffscreenCanvas(SW, SH);
    _bctx = _buf.getContext("2d")!;
    (_bctx as unknown as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled = false;
  }
  return [_buf, _bctx!];
}

// ── Public options ────────────────────────────────────────────────────────────
export interface CharOpts {
  facing:    Facing;
  phase:     number;
  moving:    boolean;
  running?:  boolean;
  submerge?: number;
  weapon?:   ItemId | null;
  attack?:   { phase: number; stance: "high" | "low" } | null;
}

// ── Colour helpers ────────────────────────────────────────────────────────────
function dk(hex: string, f: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${Math.min(255,((n>>16)&255)*f|0)},${Math.min(255,((n>>8)&255)*f|0)},${Math.min(255,(n&255)*f|0)})`;
}

// ── Drawing primitives ────────────────────────────────────────────────────────
const F = (b: B, c: string, x: number, y: number, w: number, h: number) => {
  if (w <= 0 || h <= 0) return;
  b.fillStyle = c;
  b.fillRect(x|0, y|0, w|0, h|0);
};

// Outlined rect: dark border, then coloured fill.
const OF = (b: B, col: string, x: number, y: number, w: number, h: number) => {
  if (w <= 0 || h <= 0) return;
  F(b, OL, x-1, y-1, w+2, h+2);
  F(b, col, x, y, w, h);
};

const C = (b: B, col: string, cx: number, cy: number, r: number) => {
  b.fillStyle = col;
  b.beginPath();
  b.arc(cx|0, cy|0, r, 0, Math.PI*2);
  b.fill();
};

// Outlined circle.
const OC = (b: B, col: string, cx: number, cy: number, r: number) => {
  C(b, OL, cx, cy, r + 0.9);
  C(b, col, cx, cy, r);
};

// ── Walk-cycle frame 0‥3 ─────────────────────────────────────────────────────
function wf(phase: number): 0 | 1 | 2 | 3 {
  return (((phase / (Math.PI / 2)) % 4 + 4) % 4 | 0) as 0 | 1 | 2 | 3;
}

// ── Character paint ───────────────────────────────────────────────────────────
function paint(a: Appearance, o: CharOpts) {
  const [, b] = getBuf();
  b.clearRect(0, 0, SW, SH);

  const f   = o.facing;
  const dn  = f === "down";
  const up  = f === "up";
  const lt  = f === "left";
  const rt  = f === "right";
  const prof = lt || rt;

  const fr   = wf(o.phase);
  const run  = o.running ?? false;
  const runF = run ? 1.6 : 1.0;
  const lean = run ? (lt ? -1 : rt ? 1 : 0) : 0;

  // Stride offsets: positive = forward in the facing direction.
  const stride = (fr === 1 ? 2 : fr === 3 ? -2 : 0) * runF;
  const aswing = (fr === 1 ? 1 : fr === 3 ? -1 : 0) * runF;

  // Build-scale affects body width but not height.
  const bw = a.bodyBuild === "sturdy" ? 1.15 : a.bodyBuild === "slight" ? 0.88 : 1.0;

  const skin  = a.skin;
  const hair  = a.hair;
  const shirt = a.shirt;
  const pants = a.pants ?? "#2e4268";
  const boot  = "#1a1410"; // dark chunky boots, signature Eastward

  // ── Body Y landmarks ─────────────────────────────────────────────────────────
  const HEAD_R  = 5;   // bigger head — ~38% of sprite height at 3× blit (Eastward proportion)
  const HEAD_CY = 6;
  const SHOU_Y  = HEAD_CY + HEAD_R + 2;  // 13 — shoulder line
  const BELT_Y  = SHOU_Y + 5;            // 18 — belt / waist
  const HIP_Y   = BELT_Y + 1;            // 19
  const KNEE_Y  = HIP_Y  + 3;            // 22
  const FEET_R  = FEET_ROW;              // 24

  // ── Attack state ─────────────────────────────────────────────────────────────
  const atk      = o.attack;
  const atkT     = atk?.phase ?? 0;
  const punching = atk?.stance === "high" && atkT > 0.05;
  const kicking  = atk?.stance === "low"  && atkT > 0.05;

  // ── Water clipping ────────────────────────────────────────────────────────────
  const sub   = o.submerge ?? 0;
  const clipY = sub > 0
    ? Math.round(FEET_R * (1 - sub) + (HEAD_CY - HEAD_R) * sub)
    : SH;

  // ── Ground shadow (land only) ────────────────────────────────────────────────
  if (sub <= 0) {
    b.fillStyle = "rgba(0,0,0,0.28)";
    b.beginPath();
    b.ellipse(CX, FEET_R + 1, 5, 1.5, 0, 0, Math.PI * 2);
    b.fill();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // DRAW BACK/FAR ELEMENTS FIRST for correct depth layering
  // ─────────────────────────────────────────────────────────────────────────────

  // ── Back leg (profile view) ──────────────────────────────────────────────────
  if (clipY > HIP_Y && prof) {
    const bKneeX = CX - Math.round(stride);
    // Thigh
    F(b, dk(pants, 0.6), CX - 1, HIP_Y, 3, Math.min(KNEE_Y, clipY) - HIP_Y);
    // Shin
    if (clipY > KNEE_Y)
      F(b, dk(pants, 0.55), bKneeX - 1, KNEE_Y, 3, Math.min(FEET_R - 1, clipY) - KNEE_Y);
    // Boot
    if (clipY >= FEET_R - 1)
      F(b, dk(boot, 0.7), bKneeX - 1, FEET_R - 2, 4, 3);
  }

  // ── Back arm (profile, skip when punching to avoid ghost limb) ───────────────
  if (clipY > SHOU_Y && prof && !punching) {
    const dir   = rt ? 1 : -1;
    const backX = CX - dir * 4 + lean;
    const aOff  = Math.round(-aswing);
    // Upper arm (sleeve)
    F(b, dk(shirt, 0.68), backX - 1, SHOU_Y + 1, 3, 5);
    // Forearm + hand as unit
    F(b, dk(skin, 0.8), backX - 1 + aOff, SHOU_Y + 6, 3, 2);
  }

  // ── Left leg (front view, drawn before right for depth) ─────────────────────
  if (clipY > HIP_Y && !prof && !(kicking)) {
    const lx   = CX - Math.round(2.5 * bw);
    const kOff = Math.round(stride * -0.5);
    OF(b, dk(pants, 0.85), lx - 1, HIP_Y, 3, Math.min(KNEE_Y, clipY) - HIP_Y);
    if (clipY > KNEE_Y)
      F(b, dk(pants, 0.8), lx - 1 + kOff, KNEE_Y, 3, Math.min(FEET_R - 1, clipY) - KNEE_Y);
    if (clipY >= FEET_R - 1)
      OF(b, boot, lx - 2 + kOff, FEET_R - 2, 5, 3);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TORSO
  // ─────────────────────────────────────────────────────────────────────────────
  if (clipY > SHOU_Y) {
    const tw   = Math.round((prof ? 7 : 9) * bw);
    const tx   = (CX - (tw >> 1)) + lean;
    const tBot = Math.min(BELT_Y, clipY);

    // Shirt body with outline
    OF(b, shirt, tx, SHOU_Y, tw, tBot - SHOU_Y);
    // Left highlight
    F(b, dk(shirt, 1.08), tx + 1, SHOU_Y + 1, 2, tBot - SHOU_Y - 2);
    // Right shadow
    F(b, dk(shirt, 0.78), tx + tw - 2, SHOU_Y + 1, 2, tBot - SHOU_Y - 1);
    // Collar (facing-forward detail)
    if (dn || prof) F(b, dk(shirt, 1.05), CX - 2 + lean, SHOU_Y, 4, 1);
    // Belt line (pants waistband)
    if (clipY > BELT_Y - 1) {
      F(b, OL, tx, BELT_Y - 1, tw, 1);
      F(b, dk(pants, 0.95), tx, BELT_Y, tw, Math.min(HIP_Y + 1, clipY) - BELT_Y);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FRONT / PROFILE ARMS
  // ─────────────────────────────────────────────────────────────────────────────
  if (clipY > SHOU_Y) {
    if (prof) {
      const dir = rt ? 1 : -1;
      const fax = CX + dir * 4 + lean;

      if (!punching) {
        // Resting / walking arm — whole arm swings together.
        const aOff = Math.round(aswing);
        OF(b, dk(shirt, 0.92), fax - 1, SHOU_Y + 1, 3, 5);         // sleeve
        F(b, skin, fax - 1 + aOff, SHOU_Y + 6, 3, 2);              // forearm+hand
        F(b, OL, fax - 2 + aOff, SHOU_Y + 7, 5, 1);                // hand outline
      } else {
        // PUNCH — entire arm shifts forward as one unit.
        const pOff = Math.round(atkT * 6 * dir);
        OF(b, dk(shirt, 0.92), fax - 1 + pOff, SHOU_Y + 1, 3, 5);  // sleeve
        F(b, skin, fax - 1 + pOff, SHOU_Y + 6, 3, 2);              // forearm+hand
        F(b, OL, fax - 2 + pOff, SHOU_Y + 7, 5, 1);
        // Impact flash
        if (atkT > 0.55) {
          F(b, "#ffe082", fax + pOff + dir, SHOU_Y + 4, 3, 3);
          F(b, "#fffde7", fax + pOff + dir + dir, SHOU_Y + 5, 2, 1);
        }
      }
    } else {
      // Front / back view — both arms at sides, skip punch-side when attacking.
      const sp    = Math.round(4.5 * bw);
      const pSide = dn ? -1 : 1;

      for (const side of [-1, 1] as const) {
        if (punching && side === pSide) continue;  // skip so we draw only the punch arm
        const ax   = CX + side * sp + lean;
        const aOff = Math.round(aswing * -side);
        OF(b, dk(shirt, 0.92), ax - 1, SHOU_Y + 1, 3, 5);
        F(b, skin, ax - 1 + aOff, SHOU_Y + 6, 3, 2);
      }

      // Punch arm — whole arm moves.
      if (punching) {
        const pax  = CX + pSide * sp + lean;
        const pOff = Math.round(atkT * 7 * pSide);
        OF(b, dk(shirt, 0.92), pax - 1 + pOff, SHOU_Y + 1, 3, 5);
        F(b, skin, pax - 1 + pOff, SHOU_Y + 6, 3, 2);
        if (atkT > 0.55) F(b, "#ffe082", pax + pOff + pSide, SHOU_Y + 4, 3, 3);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FRONT LEG / RIGHT LEG
  // ─────────────────────────────────────────────────────────────────────────────
  if (clipY > HIP_Y) {
    if (prof) {
      const dir    = rt ? 1 : -1;
      const fKneeX = CX + Math.round(stride);

      if (!kicking) {
        // Normal front leg — three segments move in sync.
        OF(b, pants, CX + dir - 1, HIP_Y, 3, Math.min(KNEE_Y, clipY) - HIP_Y);
        if (clipY > KNEE_Y)
          F(b, dk(pants, 0.88), fKneeX - 1, KNEE_Y, 3, Math.min(FEET_R - 1, clipY) - KNEE_Y);
        if (clipY >= FEET_R - 1)
          OF(b, boot, fKneeX - 2, FEET_R - 2, 5, 3);
      } else {
        // KICK — all three leg segments shift forward as one unit.
        const kOff = Math.round(atkT * 7 * dir);
        OF(b, pants, CX + dir - 1 + kOff, HIP_Y, 3, KNEE_Y - HIP_Y);
        F(b, dk(pants, 0.88), CX + dir - 1 + kOff, KNEE_Y, 3, FEET_R - 1 - KNEE_Y);
        OF(b, boot, CX + dir - 2 + kOff, FEET_R - 2, 5, 3);
        if (atkT > 0.55) F(b, "#ffe082", CX + dir + kOff + dir * 2, KNEE_Y - 1, 3, 3);
      }
    } else if (!kicking) {
      // Front/back right leg (normal).
      const rx   = CX + Math.round(2.5 * bw);
      const kOff = Math.round(stride * 0.5);
      OF(b, pants, rx - 1, HIP_Y, 3, Math.min(KNEE_Y, clipY) - HIP_Y);
      if (clipY > KNEE_Y)
        F(b, dk(pants, 0.82), rx - 1 + kOff, KNEE_Y, 3, Math.min(FEET_R - 1, clipY) - KNEE_Y);
      if (clipY >= FEET_R - 1)
        OF(b, boot, rx - 2 + kOff, FEET_R - 2, 5, 3);
    } else {
      // KICK front/back — whole right leg.
      const rx      = CX + Math.round(2.5 * bw);
      const kickOff = Math.round(atkT * 8);
      OF(b, pants, rx - 1 + kickOff, HIP_Y, 3, KNEE_Y - HIP_Y);
      F(b, dk(pants, 0.82), rx - 1 + kickOff, KNEE_Y, 3, FEET_R - 1 - KNEE_Y);
      OF(b, boot, rx - 2 + kickOff, FEET_R - 2, 5, 3);
      if (atkT > 0.55) F(b, "#ffe082", rx + kickOff + 2, KNEE_Y - 1, 3, 3);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // HEAD
  // ─────────────────────────────────────────────────────────────────────────────
  const hcx = CX + lean;
  OC(b, skin, hcx, HEAD_CY, HEAD_R);
  // Right-cheek shadow
  C(b, dk(skin, 0.86), hcx + 2, HEAD_CY + 1, 2.2);
  // Chin highlight
  F(b, dk(skin, 1.04), hcx - 1, HEAD_CY - 2, 3, 1);

  // ─────────────────────────────────────────────────────────────────────────────
  // HAIR  — drawn over the head circle
  // ─────────────────────────────────────────────────────────────────────────────
  const hairStyle = a.hairStyle ?? "short";

  if (up) {
    // Back of head: full hair visible.
    OC(b, hair, hcx, HEAD_CY, HEAD_R);
    if (hairStyle === "long") {
      OF(b, dk(hair, 0.88), hcx - 3, HEAD_CY + 2, 7, 4);
    }
  } else {
    // Hair cap sitting on top of the head — Eastward style: thick, distinct shape.
    const capW = HEAD_R * 2 + 2;
    const capH = HEAD_R - 1;
    // Outline first, then fill
    F(b, OL, hcx - capW/2 - 1, 0, capW + 2, capH + 2);
    F(b, hair, hcx - capW/2, 1, capW, capH);
    // Cap highlight
    F(b, dk(hair, 1.12), hcx - 2, 1, 4, 1);
    // Cap shadow at bottom edge
    F(b, dk(hair, 0.8), hcx - capW/2, capH, capW, 1);

    if (dn) {
      // Side tufts framing the face
      F(b, OL, hcx - HEAD_R - 1, HEAD_CY - 2, 2, HEAD_R + 1);
      F(b, hair, hcx - HEAD_R, HEAD_CY - 2, 1, HEAD_R);
      F(b, OL, hcx + HEAD_R, HEAD_CY - 2, 2, HEAD_R + 1);
      F(b, hair, hcx + HEAD_R, HEAD_CY - 2, 1, HEAD_R);
      if (hairStyle === "long") {
        OF(b, dk(hair, 0.9), hcx - HEAD_R - 1, HEAD_CY + 1, 2, 4);
        OF(b, dk(hair, 0.9), hcx + HEAD_R,     HEAD_CY + 1, 2, 4);
      }
    } else if (lt) {
      // Profile left: hair bulk on right (back of head).
      OF(b, hair, hcx + 1, HEAD_CY - HEAD_R + 1, 3, HEAD_R * 2);
      if (hairStyle !== "short") {
        F(b, dk(hair, 0.82), hcx + 1, HEAD_CY + 1, 3, 3);
      }
    } else {
      // Profile right: hair bulk on left.
      OF(b, hair, hcx - 3, HEAD_CY - HEAD_R + 1, 3, HEAD_R * 2);
      if (hairStyle !== "short") {
        F(b, dk(hair, 0.82), hcx - 3, HEAD_CY + 1, 3, 3);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FACE DETAILS
  // ─────────────────────────────────────────────────────────────────────────────
  if (dn) {
    // Two 2×2 eyes with white specular — the signature Eastward look.
    for (const ex of [hcx - 3, hcx + 1]) {
      F(b, OL, ex - 1, HEAD_CY - 1, 4, 4);          // eye socket outline
      F(b, "#0d1a2a", ex, HEAD_CY, 2, 2);            // dark iris
      F(b, "#ffffff", ex, HEAD_CY, 1, 1);            // specular catch-light
      F(b, "#3a6ea8", ex + 1, HEAD_CY + 1, 1, 1);   // iris colour glint
    }
    // Nose: tiny 1px shadow dot
    F(b, dk(skin, 0.84), hcx, HEAD_CY + 2, 1, 1);
    // Mouth: subtle 3-px line
    F(b, dk(skin, 0.76), hcx - 1, HEAD_CY + 3, 3, 1);
  } else if (lt) {
    // Profile left eye
    F(b, OL, hcx - 3, HEAD_CY - 1, 4, 4);
    F(b, "#0d1a2a", hcx - 3, HEAD_CY, 2, 2);
    F(b, "#ffffff", hcx - 3, HEAD_CY, 1, 1);
    // Nose bump
    F(b, dk(skin, 0.8), hcx - HEAD_R + 1, HEAD_CY + 1, 1, 1);
    // Mouth
    F(b, dk(skin, 0.76), hcx - HEAD_R + 1, HEAD_CY + 3, 1, 1);
  } else if (rt) {
    // Profile right eye
    F(b, OL, hcx + 1, HEAD_CY - 1, 4, 4);
    F(b, "#0d1a2a", hcx + 1, HEAD_CY, 2, 2);
    F(b, "#ffffff", hcx + 2, HEAD_CY, 1, 1);
    // Nose bump
    F(b, dk(skin, 0.8), hcx + HEAD_R - 1, HEAD_CY + 1, 1, 1);
    F(b, dk(skin, 0.76), hcx + HEAD_R - 1, HEAD_CY + 3, 1, 1);
  }
  // "up" facing: back of head — no face drawn.

  // ─────────────────────────────────────────────────────────────────────────────
  // WEAPON
  // ─────────────────────────────────────────────────────────────────────────────
  if (o.weapon && clipY > SHOU_Y) {
    // Derive hand position based on front arm
    const dir = prof ? (rt ? 1 : -1) : (dn ? -1 : 1);
    const sp  = prof ? 4 : Math.round(4.5);
    const handX = CX + dir * sp + lean;
    const handY = SHOU_Y + 6;
    drawPxWeapon(b, o.weapon, f, handX, handY);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WATERLINE
  // ─────────────────────────────────────────────────────────────────────────────
  if (sub > 0 && clipY > 0 && clipY < SH) {
    b.fillStyle = "rgba(180,230,255,0.55)";
    b.beginPath();
    b.ellipse(CX, clipY, 6, 2, 0, 0, Math.PI * 2);
    b.fill();
  }
}

function drawPxWeapon(b: B, w: ItemId, f: Facing, hx: number, hy: number) {
  const lt = f === "left";
  const wx = lt ? hx - 6 : hx + 3;
  switch (w) {
    case "stick":
      OF(b, "#8d6e63", wx, hy - 6, 2, 9);
      break;
    case "huntingKnife":
      F(b, "#5d4037", wx, hy - 1, 2, 3);
      OF(b, "#cfd8dc", wx, hy - 5, 2, 4);
      break;
    case "bow":
      F(b, "#8d6e63", wx, hy - 7, 2, 10);
      F(b, "#a0c4ce", wx + (lt ? 2 : -1), hy - 7, 1, 1);
      F(b, "#a0c4ce", wx + (lt ? 2 : -1), hy + 2,  1, 1);
      break;
    case "crossbow":
      OF(b, "#5d4037", wx, hy - 6, 2, 8);
      F(b, "#78909c", wx - 2, hy - 2, 6, 2);
      break;
    case "speargun":
      OF(b, "#455a64", wx, hy - 8, 2, 11);
      F(b, "#cfd8dc", wx, hy - 8, 2, 2);
      break;
    case "rifle":
      OF(b, "#3e2723", wx, hy - 7, 2, 9);
      F(b, "#78909c", wx - 3, hy - 2, 4, 2);
      break;
  }
}

// ── Public blit ───────────────────────────────────────────────────────────────
export function drawCharacterPixel(
  ctx: CanvasRenderingContext2D,
  sx: number, sy: number,
  look: Appearance,
  o: CharOpts,
) {
  paint(look, o);
  const [buf] = getBuf();

  const dw  = SW * BLT;
  const dh  = SH * BLT;
  const dx  = sx - dw / 2;
  const dy  = sy + FOOT_OFF - FEET_ROW * BLT;

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = prev;
}
