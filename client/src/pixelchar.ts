// Pixel-art character renderer.
// Draws to a tiny OffscreenCanvas (SW×SH sprite pixels) then blits at 2× with
// imageSmoothingEnabled=false, producing a crisp SNES-era sprite at any zoom.

import { Appearance, ItemId, TILE_SIZE } from "../../shared/protocol";

export type Facing = "down" | "up" | "left" | "right";

// ── Sprite-space constants ────────────────────────────────────────────────────
const SW = 12;        // sprite width  (px)
const SH = 18;        // sprite height (px)
const CX = 6;         // sprite center-X

// Sprite row that lands on the character's ground contact point.
const FEET_ROW = 17;

// How many screen-canvas pixels equal one sprite pixel.
// TILE_SIZE=24 → BLT=2 (integer, perfectly crisp 2× zoom).
const BLT = TILE_SIZE / 12;

// Y offset (in screen-canvas px) from the tile-center (sy) to feet.
// Matches the existing character's feetY = sy + 9*u offset.
const FOOT_OFFSET = Math.round(TILE_SIZE * 0.375);

// ── Shared OffscreenCanvas ────────────────────────────────────────────────────
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
  phase:     number;          // stride accumulator (radians)
  moving:    boolean;
  running?:  boolean;         // sprint — wider swing, body lean, dust puffs
  submerge?: number;          // 0 (dry) … 1 (fully submerged)
  weapon?:   ItemId | null;
  attack?:   { phase: number; stance: "high" | "low" } | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Walk-cycle frame 0‥3 (0=passing, 1=contact-A, 2=passing, 3=contact-B).
function wf(phase: number): 0 | 1 | 2 | 3 {
  return (((phase / (Math.PI / 2)) % 4 + 4) % 4 | 0) as 0 | 1 | 2 | 3;
}

function dk(hex: string, f: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = Math.min(255, ((n >> 16) & 255) * f | 0);
  const g = Math.min(255, ((n >>  8) & 255) * f | 0);
  const b = Math.min(255, ( n        & 255) * f | 0);
  return `rgb(${r},${g},${b})`;
}

const fl = (b: B, c: string, x: number, y: number, w: number, h: number) => {
  if (w <= 0 || h <= 0) return;
  b.fillStyle = c;
  b.fillRect(x | 0, y | 0, w | 0, h | 0);
};

const ci = (b: B, c: string, cx: number, cy: number, r: number) => {
  b.fillStyle = c;
  b.beginPath();
  b.arc(cx | 0, cy | 0, r, 0, Math.PI * 2);
  b.fill();
};

// ── Character sprite renderer ─────────────────────────────────────────────────
function paint(a: Appearance, o: CharOpts) {
  const [, b] = getBuf();
  b.clearRect(0, 0, SW, SH);

  const f   = o.facing;
  const dn  = f === "down";
  const up  = f === "up";
  const lt  = f === "left";
  const rt  = f === "right";
  const prof = lt || rt;

  const frame  = o.moving ? wf(o.phase) : 0;
  const run    = o.running ?? false;
  const runF   = run ? 1.5 : 1.0;

  // Stride offsets: positive = forward in facing direction.
  const stride = (frame === 1 ? 2 : frame === 3 ? -2 : 0) * runF;
  const aswing = (frame === 1 ? 1 : frame === 3 ? -1 : 0) * runF;
  // Body lean when running (profile only).
  const lean   = run ? (lt ? -1 : rt ? 1 : 0) : 0;

  // Build scale (affects torso/hip width).
  const bw = a.bodyBuild === "sturdy" ? 1.2 : a.bodyBuild === "slight" ? 0.85 : 1.0;

  const pants = a.pants ?? "#39507a";
  const boot  = "#241809";
  const skin  = a.skin;
  const hair  = a.hair;
  const shirt = a.shirt;

  // Body landmark rows in sprite-pixel space (y axis downward).
  const HEAD_R  = 3;
  const HEAD_CY = 4;
  const SHOU_Y  = HEAD_CY + HEAD_R + 1; // 8
  const WAIST_Y = SHOU_Y + 4;           // 12
  const HIP_Y   = WAIST_Y + 1;          // 13
  const KNEE_Y  = HIP_Y  + 2;           // 15

  // Attack state.
  const atk      = o.attack;
  const atkT     = atk?.phase ?? 0;
  const punching = atk?.stance === "high" && atkT > 0.05;
  const kicking  = atk?.stance === "low"  && atkT > 0.05;

  // Water clipping: submerge=0 → all visible; submerge=1 → only head.
  const sub   = o.submerge ?? 0;
  const clipY = sub > 0
    ? Math.round(FEET_ROW * (1 - sub) + (HEAD_CY - HEAD_R) * sub)
    : SH;

  // ── Ground shadow (land only) ─────────────────────────────────────────────
  if (sub <= 0) {
    b.fillStyle = "rgba(0,0,0,0.28)";
    b.beginPath();
    b.ellipse(CX, FEET_ROW + 1, 4, 1.2, 0, 0, Math.PI * 2);
    b.fill();
  }

  // ── LEGS ─────────────────────────────────────────────────────────────────────
  if (clipY > HIP_Y) {
    if (prof) {
      const dir = rt ? 1 : -1;
      // Back leg (darker, opposite direction of stride for depth).
      const bKneeX = CX - Math.round(stride);
      fl(b, dk(pants, 0.68), CX - 1, HIP_Y, 2, Math.min(KNEE_Y, clipY) - HIP_Y);
      if (clipY > KNEE_Y)
        fl(b, dk(pants, 0.62), bKneeX - 1, KNEE_Y, 2, Math.min(FEET_ROW, clipY) - KNEE_Y);
      if (clipY >= FEET_ROW - 1)
        fl(b, dk(boot, 0.75), bKneeX - 1, FEET_ROW - 1, 3, 2);

      // Front leg.
      const fKneeX = CX + Math.round(stride);
      fl(b, pants, CX + dir - 1, HIP_Y, 2, Math.min(KNEE_Y, clipY) - HIP_Y);
      if (clipY > KNEE_Y && !kicking)
        fl(b, dk(pants, 0.85), fKneeX - 1, KNEE_Y, 2, Math.min(FEET_ROW, clipY) - KNEE_Y);
      if (clipY >= FEET_ROW - 1 && !kicking)
        fl(b, boot, fKneeX - 1, FEET_ROW - 1, 3, 2);
    } else {
      // Front/back: two legs side by side.
      const sp = Math.round(2 * bw);
      for (const side of [-1, 1] as const) {
        if (kicking && side === 1) continue;  // skip right leg; kick draws it separately
        const lx    = CX + side * sp;
        const kOff  = Math.round(stride * side * 0.5);
        fl(b, pants, lx - 1, HIP_Y, 2, Math.min(KNEE_Y, clipY) - HIP_Y);
        if (clipY > KNEE_Y)
          fl(b, dk(pants, 0.85), lx - 1 + kOff, KNEE_Y, 2, Math.min(FEET_ROW, clipY) - KNEE_Y);
        if (clipY >= FEET_ROW - 1)
          fl(b, boot, lx - 2 + kOff, FEET_ROW - 1, 4, 2);
      }
    }
  }

  // ── KICK OVERRIDE (replaces the thrust-leg resting pose) ─────────────────────
  if (kicking && clipY > KNEE_Y) {
    const dir   = prof ? (rt ? 1 : -1) : 1;
    const kOff  = Math.round(atkT * 5 * dir);
    fl(b, pants, CX + dir - 1 + kOff, HIP_Y, 2, FEET_ROW - HIP_Y);
    fl(b, boot,  CX + dir - 2 + kOff, FEET_ROW - 1, 4, 2);
    if (atkT > 0.55)
      fl(b, "#ffe082", CX + dir + kOff + dir, KNEE_Y, 2, 2);
  }

  // ── TORSO ────────────────────────────────────────────────────────────────────
  if (clipY > SHOU_Y) {
    const tw   = Math.round((prof ? 5 : 6) * bw);
    const tx   = (CX - (tw >> 1)) + lean;
    const tBot = Math.min(WAIST_Y + 2, clipY);
    fl(b, shirt, tx, SHOU_Y, tw, tBot - SHOU_Y);
    // Right-side shading.
    fl(b, dk(shirt, 0.82), tx + tw - 1, SHOU_Y, 1, tBot - SHOU_Y);
    // Lower-torso shadow.
    if (clipY > WAIST_Y)
      fl(b, dk(shirt, 0.88), tx, WAIST_Y, tw, Math.min(WAIST_Y + 2, clipY) - WAIST_Y);
  }

  // ── ARMS ─────────────────────────────────────────────────────────────────────
  if (clipY > SHOU_Y) {
    if (prof) {
      const dir = rt ? 1 : -1;
      // Back arm (drawn first; skip when punching to avoid ghost limb).
      if (!punching) {
        const bax  = CX - dir * 2 + lean;
        const bAOff = Math.round(-aswing);
        fl(b, dk(shirt, 0.72), bax - 1, SHOU_Y + 1, 2, 4);
        fl(b, dk(skin, 0.88),  bax - 1 + bAOff, SHOU_Y + 5, 2, 1);
      }
      // Front arm.
      const fax  = CX + dir * 2 + lean;
      const pOff = punching ? Math.round(atkT * 4 * dir) : 0;
      const aOff = punching ? 0 : Math.round(aswing);
      fl(b, dk(shirt, 0.9), fax - 1, SHOU_Y + 1, 2, 4);
      fl(b, skin, fax - 1 + aOff + pOff, SHOU_Y + 5, 2, 1);
      // Punch flash.
      if (punching && atkT > 0.55)
        fl(b, "#ffe082", fax + pOff + dir, SHOU_Y + 4, 2, 2);
    } else {
      // Front/back: both arms visible; skip the resting arm on the punch side.
      const sp    = Math.round(3.5 * bw);
      const pSide = dn ? -1 : 1;  // which side delivers the punch
      for (const side of [-1, 1] as const) {
        if (punching && side === pSide) continue;
        const ax   = CX + side * sp + lean;
        const aOff = Math.round(aswing * -side);
        fl(b, dk(shirt, 0.9), ax - 1, SHOU_Y + 1, 2, 4);
        fl(b, skin, ax - 1 + aOff, SHOU_Y + 5, 2, 1);
      }
      // Punch arm override.
      if (punching) {
        const pax  = CX + pSide * sp + lean;
        const pOff = Math.round(atkT * 5 * pSide);
        fl(b, dk(shirt, 0.9), pax - 1, SHOU_Y + 1, 2, 4);
        fl(b, skin, pax - 1 + pOff, SHOU_Y + 5, 2, 1);
        if (atkT > 0.55)
          fl(b, "#ffe082", pax + pOff, SHOU_Y + 4, 2, 2);
      }
    }
  }

  // ── HEAD ─────────────────────────────────────────────────────────────────────
  const hcx = CX + lean;
  ci(b, skin, hcx, HEAD_CY, HEAD_R);
  // Jaw shading.
  fl(b, dk(skin, 0.9), hcx - 2, HEAD_CY + 2, 4, 1);

  // ── HAIR ─────────────────────────────────────────────────────────────────────
  if (up) {
    // Facing away: full hair cap.
    ci(b, hair, hcx, HEAD_CY, HEAD_R);
  } else if (dn) {
    // Facing camera: fringe + side tufts.
    fl(b, hair, hcx - 3, HEAD_CY - 3, 6, 2);
    fl(b, hair, hcx - 3, HEAD_CY - 1, 1, 3);
    fl(b, hair, hcx + 2, HEAD_CY - 1, 1, 3);
  } else if (lt) {
    // Profile left: hair on the right-back half.
    fl(b, hair, hcx - 3, HEAD_CY - 3, 6, 2);
    fl(b, hair, hcx,     HEAD_CY - 1, 3, 4);
  } else {
    // Profile right: hair on the left-back half.
    fl(b, hair, hcx - 3, HEAD_CY - 3, 6, 2);
    fl(b, hair, hcx - 3, HEAD_CY - 1, 3, 4);
  }

  // Long hair: flowing locks down past the neck.
  if (a.hairStyle === "long" && clipY > SHOU_Y) {
    if (dn) {
      fl(b, hair, hcx - 3, HEAD_CY + HEAD_R, 1, 3);
      fl(b, hair, hcx + 2, HEAD_CY + HEAD_R, 1, 3);
    } else if (prof) {
      const backX = lt ? hcx + 1 : hcx - 2;
      fl(b, hair, backX, HEAD_CY + HEAD_R - 1, 2, 4);
    }
  }

  // Hat (any colour means a head covering).
  if (a.hat) {
    // Wide brim.
    fl(b, a.hat, hcx - HEAD_R - 1, HEAD_CY - HEAD_R, HEAD_R * 2 + 2, 1);
    // Crown.
    fl(b, dk(a.hat, 0.88), hcx - HEAD_R + 1, HEAD_CY - HEAD_R - 2, HEAD_R * 2 - 2, 3);
  }

  // ── EYES ─────────────────────────────────────────────────────────────────────
  if (dn) {
    fl(b, "#e0d8c8", hcx - 2, HEAD_CY, 1, 1);
    fl(b, "#e0d8c8", hcx + 1, HEAD_CY, 1, 1);
    fl(b, "#1a1a1a", hcx - 2, HEAD_CY + 1, 1, 1);
    fl(b, "#1a1a1a", hcx + 1, HEAD_CY + 1, 1, 1);
  } else if (lt) {
    fl(b, "#1a1a1a", hcx - 2, HEAD_CY + 1, 1, 1);
  } else if (rt) {
    fl(b, "#1a1a1a", hcx + 1, HEAD_CY + 1, 1, 1);
  }
  // "up" facing: back of head, no visible eyes.

  // ── WEAPON ────────────────────────────────────────────────────────────────────
  if (o.weapon && clipY > SHOU_Y)
    drawPxWeapon(b, o.weapon, f, hcx, SHOU_Y);

  // ── WATERLINE ─────────────────────────────────────────────────────────────────
  if (sub > 0 && clipY > 0 && clipY < SH) {
    b.fillStyle = "rgba(180,230,255,0.55)";
    b.beginPath();
    b.ellipse(CX, clipY, 5, 1.5, 0, 0, Math.PI * 2);
    b.fill();
  }
}

function drawPxWeapon(b: B, w: ItemId, f: Facing, hcx: number, shoY: number) {
  const lt = f === "left";
  const wx = lt ? hcx - 7 : hcx + 4;
  const wy = shoY + 2;
  switch (w) {
    case "stick":
      fl(b, "#8d6e63", wx, wy, 1, 7);
      break;
    case "huntingKnife":
      fl(b, "#5d4037", wx, wy + 3, 1, 2);
      fl(b, "#cfd8dc", wx, wy,     1, 3);
      break;
    case "bow":
      fl(b, "#8d6e63", wx, wy, 1, 7);
      fl(b, "#a0c4ce", wx + (lt ? 1 : -1), wy,     1, 1);
      fl(b, "#a0c4ce", wx + (lt ? 1 : -1), wy + 6, 1, 1);
      break;
    case "crossbow":
      fl(b, "#5d4037", wx, wy,     1, 7);
      fl(b, "#78909c", wx - 2, wy + 2, 5, 1);
      break;
    case "speargun":
      fl(b, "#455a64", wx, wy - 1, 1, 9);
      fl(b, "#cfd8dc", wx, wy - 1, 1, 1);
      break;
    case "rifle":
      fl(b, "#3e2723", wx, wy, 1, 7);
      fl(b, "#78909c", wx - 2, wy + 3, 3, 1);
      break;
  }
}

// ── Public blit ───────────────────────────────────────────────────────────────
export function drawCharacterPixel(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  look: Appearance,
  o: CharOpts,
) {
  paint(look, o);
  const [b] = getBuf();

  const dw  = SW * BLT;
  const dh  = SH * BLT;
  const dx  = sx - dw / 2;
  const dy  = sy + FOOT_OFFSET - FEET_ROW * BLT;  // feet row lands at sy+FOOT_OFFSET

  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(b, dx, dy, dw, dh);
  ctx.imageSmoothingEnabled = prev;
}
