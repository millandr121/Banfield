import { Appearance } from "../../shared/protocol";

/** Lighten (+) or darken (−) a hex colour by `amount` (0–255). */
export function shade(col: string, amount: number): string {
  const n = parseInt(col.replace("#", ""), 16);
  const r = Math.min(255, Math.max(0, (n >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((n >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (n & 0xff) + amount));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Draw a face-on, full-body standing character into `ctx`, centred and scaled
 * to fit a `W`×`H` box. Shared by the character creator preview and the
 * in-panel equipment paper-doll so the look stays consistent.
 *
 * Body shape responds to:
 *   bodyBuild  — overall mass (slight / medium / sturdy)
 *   hipSize    — hip flare only, for an hourglass silhouette (narrow/medium/wide)
 *   breastSize — chest projection (non / modest / expressive)
 *   hairStyle  — short / medium / long
 */
export function drawAvatar(ctx: CanvasRenderingContext2D, a: Appearance, W: number, H: number) {
  ctx.clearRect(0, 0, W, H);

  const skin = a.skin || "#e0ac69";
  const hair = a.hair || "#3b2a1a";
  const shirt = a.shirt || "#2e7d32";
  const pants = "#2a3a55";
  const build = a.bodyBuild ?? "medium";
  const hipSz = a.hipSize ?? "medium";
  const bust = a.breastSize ?? "non";
  const hairStyle = a.hairStyle ?? "short";

  // Fit a 64-tall art unit into the box with a little headroom.
  const s = Math.min(W / 44, H / 168);
  const cx = W / 2;
  const top = (H - 156 * s) / 2 + 4 * s;
  const u = (n: number) => n * s; // shorthand: art-units → px

  // Mass multiplier from build (affects width, not the hip flare).
  const mass = build === "sturdy" ? 1.22 : build === "slight" ? 0.84 : 1.0;

  // ── Vertical anatomy (art units from `top`) ──
  const headCY = top + u(15);
  const headR = u(11);
  const neckY = headCY + headR - u(1);
  const shoulderY = neckY + u(5);
  const waistY = shoulderY + u(34); // narrowest point
  const hipY = waistY + u(12);      // widest point (hourglass)
  const legTopY = hipY + u(2);
  const legBottomY = legTopY + u(54);

  // ── Widths ──
  const shoulderW = u(15) * mass;
  const waistW = u(9.5) * mass;
  const hipFlare = hipSz === "wide" ? u(17) : hipSz === "medium" ? u(13) : u(10);
  const hipW = hipFlare * (0.85 + mass * 0.15);

  const outline = shade(skin, -70);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // ── Legs (pants) ──
  const inseam = u(1.5);
  const legW = (hipW - inseam) * 0.5;
  const drawLeg = (sign: number) => {
    const xOuter = cx + sign * hipW;
    const xInner = cx + sign * inseam;
    const ankleOuter = cx + sign * (legW * 0.8 + inseam);
    const ankleInner = cx + sign * inseam;
    ctx.beginPath();
    ctx.moveTo(xInner, legTopY);
    ctx.lineTo(xOuter, legTopY);
    ctx.lineTo(ankleOuter, legBottomY);
    ctx.lineTo(ankleInner, legBottomY);
    ctx.closePath();
    ctx.fillStyle = pants;
    ctx.fill();
    ctx.strokeStyle = shade(pants, -28);
    ctx.lineWidth = Math.max(1, u(1));
    ctx.stroke();
    // shading down the outer edge
    ctx.fillStyle = shade(pants, -16);
    ctx.beginPath();
    ctx.moveTo(cx + sign * (legW * 0.55 + inseam), legTopY + u(2));
    ctx.lineTo(xOuter, legTopY);
    ctx.lineTo(ankleOuter, legBottomY);
    ctx.lineTo(cx + sign * (legW * 0.45 + inseam), legBottomY);
    ctx.closePath();
    ctx.fill();
  };
  drawLeg(-1);
  drawLeg(1);

  // ── Shoes ──
  ctx.fillStyle = shade(pants, -40);
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + sign * (legW * 0.5 + inseam), legBottomY + u(1), legW * 0.7, u(3), 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Arms (skin) — hang at the sides, slightly bent ──
  const armW = u(4.5) * mass;
  const drawArm = (sign: number) => {
    const shX = cx + sign * shoulderW;
    const handY = waistY + u(6);
    ctx.beginPath();
    ctx.moveTo(shX, shoulderY + u(1));
    ctx.quadraticCurveTo(cx + sign * (shoulderW + armW * 0.6), waistY - u(4), cx + sign * (waistW + armW * 0.8), handY);
    ctx.lineWidth = armW;
    ctx.strokeStyle = skin;
    ctx.stroke();
    // hand
    ctx.beginPath();
    ctx.arc(cx + sign * (waistW + armW * 0.8), handY, armW * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
  };
  drawArm(-1);
  drawArm(1);

  // ── Torso (shirt) — shoulder → waist → hip hourglass ──
  ctx.beginPath();
  ctx.moveTo(cx - shoulderW, shoulderY);
  ctx.lineTo(cx + shoulderW, shoulderY);
  ctx.quadraticCurveTo(cx + waistW + u(2), (shoulderY + waistY) / 2, cx + waistW, waistY);
  ctx.quadraticCurveTo(cx + hipW * 0.9, hipY - u(2), cx + hipW * 0.82, hipY);
  ctx.lineTo(cx - hipW * 0.82, hipY);
  ctx.quadraticCurveTo(cx - hipW * 0.9, hipY - u(2), cx - waistW, waistY);
  ctx.quadraticCurveTo(cx - waistW - u(2), (shoulderY + waistY) / 2, cx - shoulderW, shoulderY);
  ctx.closePath();
  ctx.fillStyle = shirt;
  ctx.fill();
  ctx.strokeStyle = shade(shirt, -34);
  ctx.lineWidth = Math.max(1, u(1));
  ctx.stroke();
  // torso right-side shading
  ctx.save();
  ctx.clip();
  ctx.fillStyle = shade(shirt, -18);
  ctx.fillRect(cx + u(1), shoulderY, W, hipY - shoulderY);
  ctx.fillStyle = shade(shirt, 16);
  ctx.fillRect(cx - shoulderW, shoulderY, u(4), hipY - shoulderY);
  ctx.restore();

  // ── Chest projection (breastSize) ──
  if (bust !== "non") {
    const r = bust === "expressive" ? u(5.5) : u(3.4);
    const by = shoulderY + u(12);
    ctx.fillStyle = shade(shirt, -22);
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + sign * u(5), by, r, r * 0.82, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // subtle highlight
    ctx.fillStyle = shade(shirt, 12);
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + sign * u(5) - u(1), by - u(1), r * 0.45, r * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Neck ──
  ctx.fillStyle = shade(skin, -14);
  ctx.fillRect(cx - u(3), neckY - u(2), u(6), u(6));

  // ── Head ──
  ctx.beginPath();
  ctx.arc(cx, headCY, headR, 0, Math.PI * 2);
  ctx.fillStyle = skin;
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.lineWidth = Math.max(1, u(0.8));
  ctx.stroke();
  // cheek shading
  ctx.fillStyle = shade(skin, -16);
  ctx.beginPath();
  ctx.arc(cx + headR * 0.42, headCY + u(1), headR * 0.5, -0.7, 1.4);
  ctx.arc(cx, headCY, headR, 1.0, -0.4, true);
  ctx.fill();

  // ── Face ──
  ctx.fillStyle = "#20140c";
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + sign * u(3.6), headCY + u(0.5), u(1.2), u(1.5), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // brows
  ctx.strokeStyle = shade(hair, -10);
  ctx.lineWidth = Math.max(1, u(0.9));
  for (const sign of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(cx + sign * u(2.2), headCY - u(2.2));
    ctx.lineTo(cx + sign * u(5), headCY - u(1.8));
    ctx.stroke();
  }
  // nose + mouth
  ctx.strokeStyle = shade(skin, -40);
  ctx.lineWidth = Math.max(1, u(0.8));
  ctx.beginPath();
  ctx.moveTo(cx, headCY + u(1));
  ctx.lineTo(cx - u(1.2), headCY + u(3.2));
  ctx.lineTo(cx + u(0.6), headCY + u(3.4));
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - u(3), headCY + u(6));
  ctx.quadraticCurveTo(cx, headCY + u(7.4), cx + u(3), headCY + u(6));
  ctx.stroke();

  // ── Hair ──
  ctx.fillStyle = hair;
  const capTop = headCY - headR - u(1);
  if (hairStyle === "long") {
    // flowing sides past the shoulders
    ctx.beginPath();
    ctx.moveTo(cx - headR - u(1.5), headCY - u(2));
    ctx.quadraticCurveTo(cx - headR - u(3), shoulderY + u(8), cx - headR + u(1), shoulderY + u(12));
    ctx.lineTo(cx - headR + u(3), shoulderY + u(10));
    ctx.quadraticCurveTo(cx - headR, headCY, cx - headR + u(1), headCY - u(4));
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + headR + u(1.5), headCY - u(2));
    ctx.quadraticCurveTo(cx + headR + u(3), shoulderY + u(8), cx + headR - u(1), shoulderY + u(12));
    ctx.lineTo(cx + headR - u(3), shoulderY + u(10));
    ctx.quadraticCurveTo(cx + headR, headCY, cx + headR - u(1), headCY - u(4));
    ctx.closePath();
    ctx.fill();
  }
  // scalp cap (all styles)
  ctx.beginPath();
  ctx.arc(cx, headCY, headR + u(0.8), Math.PI * 1.04, Math.PI * 1.96);
  ctx.lineTo(cx + headR * 0.7, capTop + u(6));
  ctx.quadraticCurveTo(cx, capTop - u(1), cx - headR * 0.7, capTop + u(6));
  ctx.closePath();
  ctx.fill();
  if (hairStyle === "medium") {
    // short side tufts past the ears
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + sign * (headR - u(0.5)), headCY - u(4));
      ctx.quadraticCurveTo(cx + sign * (headR + u(2.5)), headCY + u(3), cx + sign * (headR - u(1)), headCY + u(5));
      ctx.lineTo(cx + sign * (headR - u(3)), headCY + u(2));
      ctx.closePath();
      ctx.fill();
    }
  }
  // hair sheen
  ctx.fillStyle = shade(hair, 26);
  ctx.beginPath();
  ctx.ellipse(cx - headR * 0.35, capTop + u(5), headR * 0.32, u(2.2), -0.4, 0, Math.PI * 2);
  ctx.fill();
}
