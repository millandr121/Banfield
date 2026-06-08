// Generates a layered, dyeable base-character SpriteDoc and writes it to
// client/src/assets/base-character.json. This is the starting art you load in
// the sprite editor and repaint over — clean fills per dye layer, with the dark
// outline derived automatically from the silhouette.
//
// Run:  node tools/gen-base-sprites.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 20, H = 26;
const FACINGS = ["down", "up", "left", "right"];

// Layer order, bottom → top. Dye role decides runtime tinting.
const LAYERS = [
  { name: "outline", dye: "none" },   // 0 — derived silhouette border
  { name: "pants",   dye: "pants" },  // 1
  { name: "skin",    dye: "skin" },   // 2 — head, neck, arms, hands
  { name: "shirt",   dye: "shirt" },  // 3 — torso + sleeves
  { name: "boots",   dye: "none" },   // 4
  { name: "hair",    dye: "hair" },   // 5
  { name: "face",    dye: "none" },   // 6 — eyes, mouth
];
const LI = Object.fromEntries(LAYERS.map((l, i) => [l.name, i]));

// Reference palette (real colours + 3-tone shading; re-tinted at runtime).
const C = {
  outline: "#140a06",
  skin:  { base: "#d8a870", hi: "#e8bb86", sh: "#b07c4e" },
  hair:  { base: "#5a4632", hi: "#6e5640", sh: "#3e2f1f" },
  shirt: { base: "#3f8a44", hi: "#54a85a", sh: "#2c6230" },
  pants: { base: "#36507e", hi: "#4a68a0", sh: "#283c5e" },
  boot:  { base: "#2a2018", hi: "#3a2e22", sh: "#1a130d" },
  eyeDark: "#101820", eyeWhite: "#ffffff", eyeGlint: "#3a6ea8",
  mouth: "#9a6a48", nose: "#b07c4e",
};

const emptyLayer = () => new Array(W * H).fill("");
const inb = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
function pset(layer, x, y, c) { if (inb(x | 0, y | 0)) layer[(y | 0) * W + (x | 0)] = c; }
function rect(layer, x, y, w, h, c) {
  for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) pset(layer, x + xx, y + yy, c);
}
function disc(layer, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
    if (x * x + y * y <= r * r + r * 0.5) pset(layer, cx + x, cy + y, c);
}

// Body landmarks (match the in-game proportions: big head, chunky body).
const HEAD_R = 5, HEAD_CY = 6, CX = 10;
const SHOU_Y = 13, BELT_Y = 18, HIP_Y = 19, KNEE_Y = 22, FEET_Y = 24;

// Paint one (facing, phase) into a fresh set of fill layers; returns layers[].
function paintFrame(facing, phase) {
  const L = LAYERS.map(emptyLayer);
  const prof = facing === "left" || facing === "right";
  const dir = facing === "right" ? 1 : -1; // profile forward direction
  const up = facing === "up";

  // Walk cycle: phase 0/2 = passing, 1 = step-A, 3 = step-B.
  const stride = phase === 1 ? 2 : phase === 3 ? -2 : 0;
  const swing = phase === 1 ? 1 : phase === 3 ? -1 : 0;

  // ── Legs (pants) + boots ──
  const legY0 = HIP_Y;
  if (prof) {
    // Back leg
    const bx = CX - Math.round(stride);
    rect(L[LI.pants], bx - 1, legY0, 3, KNEE_Y - legY0, C.pants.sh);
    rect(L[LI.pants], bx - 1, KNEE_Y, 3, FEET_Y - 1 - KNEE_Y, C.pants.sh);
    rect(L[LI.boots], bx - 2, FEET_Y - 2, 4, 3, C.boot.sh);
    // Front leg
    const fx = CX + Math.round(stride);
    rect(L[LI.pants], fx - 1, legY0, 3, KNEE_Y - legY0, C.pants.base);
    rect(L[LI.pants], fx - 1, KNEE_Y, 3, FEET_Y - 1 - KNEE_Y, C.pants.sh);
    rect(L[LI.boots], fx - 2, FEET_Y - 2, 5, 3, C.boot.base);
    rect(L[LI.boots], fx - 2, FEET_Y - 2, 5, 1, C.boot.hi);
  } else {
    for (const side of [-1, 1]) {
      const off = Math.round(stride * 0.5) * side;
      const lx = CX + side * 2;
      rect(L[LI.pants], lx - 1, legY0, 3, KNEE_Y - legY0, side < 0 ? C.pants.base : C.pants.sh);
      rect(L[LI.pants], lx - 1 + off, KNEE_Y, 3, FEET_Y - 1 - KNEE_Y, C.pants.sh);
      rect(L[LI.boots], lx - 2 + off, FEET_Y - 2, 5, 3, C.boot.base);
      rect(L[LI.boots], lx - 2 + off, FEET_Y - 2, 5, 1, C.boot.hi);
    }
  }

  // ── Torso (shirt) ──
  const tw = prof ? 7 : 9;
  const tx = CX - (tw >> 1);
  rect(L[LI.shirt], tx, SHOU_Y, tw, BELT_Y - SHOU_Y, C.shirt.base);
  rect(L[LI.shirt], tx + 1, SHOU_Y + 1, 2, BELT_Y - SHOU_Y - 2, C.shirt.hi);     // left highlight
  rect(L[LI.shirt], tx + tw - 2, SHOU_Y + 1, 2, BELT_Y - SHOU_Y - 1, C.shirt.sh); // right shadow
  // Belt / waistband (pants colour band)
  rect(L[LI.pants], tx, BELT_Y, tw, HIP_Y - BELT_Y + 1, C.pants.base);

  // ── Arms ──
  if (prof) {
    // Back arm (behind torso)
    const baX = CX - dir * 4;
    rect(L[LI.shirt], baX - 1, SHOU_Y + 1, 3, 5, C.shirt.sh);
    rect(L[LI.skin], baX - 1 - Math.round(swing), SHOU_Y + 6, 3, 2, C.skin.sh);
    // Front arm
    const faX = CX + dir * 4;
    rect(L[LI.shirt], faX - 1, SHOU_Y + 1, 3, 5, C.shirt.base);
    rect(L[LI.skin], faX - 1 + Math.round(swing), SHOU_Y + 6, 3, 2, C.skin.base);
  } else {
    for (const side of [-1, 1]) {
      const ax = CX + side * 5;
      const off = Math.round(swing * -side);
      rect(L[LI.shirt], ax - 1, SHOU_Y + 1, 3, 5, side < 0 ? C.shirt.base : C.shirt.sh);
      rect(L[LI.skin], ax - 1 + off, SHOU_Y + 6, 3, 2, C.skin.base);
    }
  }

  // ── Neck + Head (skin) ──
  rect(L[LI.skin], CX - 1, SHOU_Y - 2, 3, 2, C.skin.sh);
  disc(L[LI.skin], CX, HEAD_CY, HEAD_R, C.skin.base);
  // cheek shadow / chin highlight
  disc(L[LI.skin], CX + 2, HEAD_CY + 1, 2, C.skin.sh);
  rect(L[LI.skin], CX - 1, HEAD_CY - 3, 3, 1, C.skin.hi);

  // ── Hair ──
  if (up) {
    disc(L[LI.hair], CX, HEAD_CY, HEAD_R, C.hair.base);
    disc(L[LI.hair], CX, HEAD_CY + 1, HEAD_R - 1, C.hair.sh);
  } else {
    // Cap on top of the head.
    const capW = HEAD_R * 2 + 2, capH = HEAD_R - 1;
    rect(L[LI.hair], CX - (capW >> 1), 1, capW, capH, C.hair.base);
    rect(L[LI.hair], CX - 2, 1, 4, 1, C.hair.hi);
    rect(L[LI.hair], CX - (capW >> 1), capH, capW, 1, C.hair.sh);
    if (prof) {
      const hx = dir < 0 ? CX + 1 : CX - 3;
      rect(L[LI.hair], hx, HEAD_CY - HEAD_R + 1, 3, HEAD_R * 2, C.hair.base);
    } else {
      // side tufts
      rect(L[LI.hair], CX - HEAD_R, HEAD_CY - 2, 1, HEAD_R, C.hair.base);
      rect(L[LI.hair], CX + HEAD_R, HEAD_CY - 2, 1, HEAD_R, C.hair.base);
    }
  }

  // ── Face (eyes / nose / mouth) ──
  if (facing === "down") {
    for (const ex of [CX - 3, CX + 1]) {
      rect(L[LI.face], ex, HEAD_CY, 2, 2, C.eyeDark);
      pset(L[LI.face], ex, HEAD_CY, C.eyeWhite);
      pset(L[LI.face], ex + 1, HEAD_CY + 1, C.eyeGlint);
    }
    pset(L[LI.face], CX, HEAD_CY + 2, C.nose);
    rect(L[LI.face], CX - 1, HEAD_CY + 3, 3, 1, C.mouth);
  } else if (prof) {
    const ex = dir > 0 ? CX + 1 : CX - 3;
    rect(L[LI.face], ex, HEAD_CY, 2, 2, C.eyeDark);
    pset(L[LI.face], dir > 0 ? ex + 1 : ex, HEAD_CY, C.eyeWhite);
    pset(L[LI.face], CX + dir * (HEAD_R - 1), HEAD_CY + 1, C.nose);
    pset(L[LI.face], CX + dir * (HEAD_R - 1), HEAD_CY + 3, C.mouth);
  }

  // ── Derive the outline layer from the union silhouette ──
  const solid = new Array(W * H).fill(false);
  for (const name of ["pants", "skin", "shirt", "boots", "hair"]) {
    const layer = L[LI[name]];
    for (let i = 0; i < layer.length; i++) if (layer[i]) solid[i] = true;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (solid[y * W + x]) continue;
    // transparent pixel touching a solid pixel → outline
    const near =
      (inb(x - 1, y) && solid[y * W + x - 1]) ||
      (inb(x + 1, y) && solid[y * W + x + 1]) ||
      (inb(x, y - 1) && solid[(y - 1) * W + x]) ||
      (inb(x, y + 1) && solid[(y + 1) * W + x]);
    if (near) pset(L[LI.outline], x, y, C.outline);
  }

  return L;
}

// ── Assemble the doc ──
const doc = {
  version: 1,
  name: "base-character",
  w: W, h: H,
  layerNames: LAYERS.map((l) => l.name),
  layerDye: LAYERS.map((l) => l.dye),
  facings: {},
  fps: 6,
};
for (const f of FACINGS) {
  doc.facings[f] = [0, 1, 2, 3].map((phase) => ({ layers: paintFrame(f, phase) }));
}

// reference luminance per layer (avg of painted pixels)
const lum = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
};
doc.layerRefLum = LAYERS.map((_l, li) => {
  let s = 0, c = 0;
  for (const f of FACINGS) for (const fr of doc.facings[f])
    for (const px of fr.layers[li]) if (px) { s += lum(px); c++; }
  return c ? s / c : 200;
});

const outPath = resolve(__dirname, "../client/src/assets/base-character.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(doc));
console.log("wrote", outPath, "(" + JSON.stringify(doc).length + " bytes)");
