// Generates pixel-art inventory icons for every ItemId and writes them to
// client/src/assets/item-sprites.json. Each icon is a flat 16×16 colour-string
// array ("" = transparent), the same Pixels format the character sprites use,
// so the game blits them with nearest-neighbour scaling for crisp pixel art.
//
// Items are grouped by shape "family" (log, fish, ore, weapon, …) and tinted
// per item, so every id gets a recognisable icon cheaply. Run:
//   node tools/gen-item-sprites.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const S = 16;

// ── Pixel canvas helpers ──────────────────────────────────────────────────────
const make = () => new Array(S * S).fill("");
const inb = (x, y) => x >= 0 && y >= 0 && x < S && y < S;
const P = (g, x, y, c) => { if (c && inb(x | 0, y | 0)) g[(y | 0) * S + (x | 0)] = c; };
function rect(g, x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) P(g, x + i, y + j, c); }
function disc(g, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++)
    if (x * x + y * y <= r * r + r * 0.6) P(g, cx + x, cy + y, c);
}
function line(g, x0, y0, x1, y1, c) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    P(g, x0, y0, c);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Shade helpers (×factor on each channel).
const sh = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.max(0, Math.min(255, (v * f) | 0)).toString(16).padStart(2, "0");
  return "#" + c((n >> 16) & 255) + c((n >> 8) & 255) + c(n & 255);
};
const OL = "#160d08"; // warm outline, matches the character art

// Outline pass: any transparent pixel touching a solid one becomes outline.
function outline(g) {
  const out = g.slice();
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (g[y * S + x]) continue;
    const near =
      (inb(x - 1, y) && g[y * S + x - 1]) || (inb(x + 1, y) && g[y * S + x + 1]) ||
      (inb(x, y - 1) && g[(y - 1) * S + x]) || (inb(x, y + 1) && g[(y + 1) * S + x]);
    if (near) out[y * S + x] = OL;
  }
  return out;
}

// ── Shape families ────────────────────────────────────────────────────────────
// Each takes the base colour and returns a 16×16 grid (pre-outline).

function logIcon(c) { // a short log seen end-on, with growth rings
  const g = make();
  rect(g, 2, 5, 12, 6, c);
  rect(g, 2, 5, 12, 1, sh(c, 1.25));
  rect(g, 2, 10, 12, 1, sh(c, 0.7));
  // end face (left)
  disc(g, 4, 8, 3, sh(c, 1.1));
  disc(g, 4, 8, 2, sh(c, 0.85));
  P(g, 4, 8, sh(c, 1.3));
  // bark right cap
  rect(g, 13, 5, 1, 6, sh(c, 0.6));
  return g;
}
function plankIcon(c) {
  const g = make();
  rect(g, 1, 6, 14, 4, c);
  rect(g, 1, 6, 14, 1, sh(c, 1.2));
  rect(g, 1, 9, 14, 1, sh(c, 0.7));
  for (let x = 3; x < 14; x += 4) P(g, x, 8, sh(c, 0.8));
  return g;
}
function oreIcon(c) { // chunky rock/nugget
  const g = make();
  disc(g, 8, 9, 5, c);
  rect(g, 4, 8, 9, 4, c);
  disc(g, 6, 7, 2, sh(c, 1.25));
  disc(g, 10, 11, 2, sh(c, 0.7));
  return g;
}
function barIcon(c) { // metal ingot
  const g = make();
  // trapezoid bar
  for (let y = 7; y <= 11; y++) { const inset = y - 7; rect(g, 3 + inset, y, 11 - inset * 2, 1, c); }
  rect(g, 3, 7, 9, 1, sh(c, 1.4));
  return g;
}
function fishIcon(c) {
  const g = make();
  disc(g, 8, 8, 4, c);
  rect(g, 5, 6, 7, 5, c);
  // tail
  P(g, 13, 6, c); P(g, 14, 5, c); P(g, 13, 8, c); P(g, 14, 10, c); P(g, 13, 9, c);
  rect(g, 13, 7, 2, 2, c);
  // belly + back shading
  rect(g, 5, 9, 7, 1, sh(c, 0.75));
  rect(g, 5, 6, 6, 1, sh(c, 1.2));
  P(g, 5, 7, "#0b0b0b"); // eye
  P(g, 4, 7, sh(c, 1.1));
  return g;
}
function crabIcon(c) {
  const g = make();
  disc(g, 8, 9, 4, c);
  rect(g, 4, 8, 9, 3, c);
  // legs
  for (const dx of [-1, 1]) {
    line(g, 8, 10, 8 + dx * 6, 13, c);
    line(g, 8, 10, 8 + dx * 6, 11, c);
  }
  // claws
  P(g, 2, 7, c); P(g, 3, 7, c); P(g, 13, 7, c); P(g, 14, 7, c);
  disc(g, 8, 8, 3, sh(c, 1.12));
  P(g, 6, 8, "#0b0b0b"); P(g, 10, 8, "#0b0b0b"); // eyes
  return g;
}
function meatIcon(c) { // drumstick
  const g = make();
  disc(g, 6, 7, 4, c);
  rect(g, 4, 5, 6, 5, c);
  disc(g, 5, 6, 2, sh(c, 1.2));
  // bone
  line(g, 9, 9, 13, 13, "#efe6d2");
  disc(g, 13, 13, 1, "#fff7e6");
  disc(g, 8, 8, 1, sh(c, 0.7));
  return g;
}
function berryIcon(c) {
  const g = make();
  for (const [x, y] of [[6, 8], [9, 8], [7, 11], [10, 11], [8, 6]]) {
    disc(g, x, y, 2, c);
    P(g, x - 1, y - 1, sh(c, 1.4));
  }
  P(g, 8, 4, "#3a6b30"); P(g, 9, 4, "#3a6b30"); // stem leaf
  return g;
}
function bonesIcon() {
  const g = make();
  const c = "#e8e0cc";
  line(g, 3, 4, 12, 13, c); line(g, 4, 4, 13, 13, c);
  for (const [x, y] of [[3, 4], [12, 13]]) { disc(g, x, y, 1, "#fffaf0"); disc(g, x + 1, y, 1, "#fffaf0"); }
  line(g, 12, 4, 4, 12, sh(c, 0.85));
  return g;
}
function leatherIcon(c) {
  const g = make();
  // stretched hide
  for (let y = 3; y <= 12; y++) { const w = 10 - Math.abs(y - 7); rect(g, 8 - (w >> 1), y, w, 1, c); }
  rect(g, 5, 6, 6, 3, sh(c, 1.12));
  P(g, 6, 10, sh(c, 0.7)); P(g, 9, 5, sh(c, 0.7));
  return g;
}
function jerryIcon(c) {
  const g = make();
  rect(g, 4, 4, 8, 10, c);
  rect(g, 4, 4, 8, 1, sh(c, 1.25));
  rect(g, 4, 13, 8, 1, sh(c, 0.7));
  rect(g, 6, 2, 4, 2, sh(c, 0.8)); // cap
  rect(g, 5, 6, 1, 6, sh(c, 1.2));  // handle highlight
  P(g, 9, 7, "#1a1a1a"); P(g, 10, 7, "#1a1a1a"); // spout label
  return g;
}
function tankIcon(c) {
  const g = make();
  rect(g, 5, 4, 6, 9, c);
  disc(g, 8, 4, 3, c);
  rect(g, 5, 4, 2, 9, sh(c, 1.2));
  rect(g, 7, 2, 2, 2, "#9aa6ad"); // valve
  return g;
}
function shirtIcon(c) {
  const g = make();
  rect(g, 4, 5, 8, 8, c);
  rect(g, 1, 5, 3, 3, c); rect(g, 12, 5, 3, 3, c); // sleeves
  rect(g, 6, 4, 4, 2, sh(c, 0.8)); // collar
  rect(g, 4, 5, 8, 1, sh(c, 1.2));
  return g;
}
function pantsIcon(c) {
  const g = make();
  rect(g, 4, 4, 8, 3, c);
  rect(g, 4, 7, 3, 7, c); rect(g, 9, 7, 3, 7, c); // legs
  rect(g, 4, 4, 8, 1, sh(c, 1.2));
  rect(g, 7, 7, 2, 7, "");
  return g;
}
function jacketIcon(c) {
  const g = shirtIcon(c);
  // zipper
  for (let y = 6; y <= 12; y++) P(g, 8, y, sh(c, 1.4));
  return g;
}
function maskIcon(c) {
  const g = make();
  rect(g, 3, 6, 10, 5, c);
  rect(g, 4, 7, 8, 3, "#bfe6f2"); // lens
  rect(g, 7, 10, 2, 4, sh(c, 0.8)); // snorkel
  rect(g, 8, 4, 2, 6, sh(c, 0.8));
  return g;
}
function hatIcon(c) {
  // Wide-brimmed field hat: full brim, rounded crown, crease, inner shadow.
  const g = make();
  rect(g, 1, 10, 14, 2, sh(c, 0.8));  // brim shadow underside
  rect(g, 1,  9, 14, 2, c);            // brim top
  rect(g, 3,  4, 10, 6, c);            // crown
  rect(g, 4,  3,  8, 1, sh(c, 1.2));   // crown top highlight
  rect(g, 3,  4, 10, 1, sh(c, 1.15));  // crown front edge
  rect(g, 5,  6,  6, 1, sh(c, 0.75));  // crease line
  rect(g, 1,  9, 14, 1, sh(c, 1.2));   // brim top highlight
  return g;
}

// Weapons (side profile).
function stickIcon() { const g = make(); line(g, 3, 13, 12, 4, "#8d6e63"); line(g, 4, 13, 13, 4, "#7a5d50"); P(g, 12, 4, "#6b4f44"); return g; }
function knifeIcon() {
  const g = make();
  rect(g, 3, 11, 4, 2, "#5d4037"); // handle
  // blade
  for (let i = 0; i < 8; i++) { rect(g, 6 + i, 10 - i, 2, 2, "#cfd8dc"); }
  rect(g, 6, 9, 6, 1, "#eef3f5");
  return g;
}
function bowIcon() {
  const g = make();
  for (let y = 3; y <= 12; y++) { const x = 5 + Math.round(Math.sin((y - 3) / 9 * Math.PI) * 4); P(g, x, y, "#8d6e63"); P(g, x + 1, y, "#7a5d50"); }
  line(g, 6, 3, 6, 12, "#e8e8e8"); // string
  return g;
}
function crossbowIcon() {
  const g = make();
  rect(g, 7, 4, 2, 9, "#5d4037"); // stock
  rect(g, 2, 5, 12, 2, "#6d4c41"); // bow arms
  rect(g, 2, 5, 12, 1, "#7a5a4a");
  P(g, 8, 3, "#cfd8dc"); P(g, 8, 2, "#cfd8dc"); // bolt tip
  return g;
}
function speargunIcon() {
  const g = make();
  rect(g, 3, 9, 8, 2, "#455a64"); // body
  rect(g, 5, 11, 2, 3, "#37474f"); // grip
  line(g, 6, 8, 15, 4, "#90a4ae"); // spear shaft
  P(g, 15, 4, "#eceff1"); P(g, 14, 4, "#cfd8dc"); // tip
  return g;
}
function rifleIcon() {
  const g = make();
  rect(g, 2, 8, 12, 2, "#3e2723"); // stock/barrel
  rect(g, 2, 8, 12, 1, "#5a3a2a");
  rect(g, 11, 7, 4, 1, "#78909c"); // barrel tip
  rect(g, 5, 10, 2, 3, "#2a1a12"); // grip
  rect(g, 6, 10, 3, 2, "#2a1a12"); // trigger guard
  return g;
}
function ammoIcon(c, kind) {
  const g = make();
  if (kind === "bullet") { rect(g, 6, 5, 4, 7, c); disc(g, 8, 4, 2, sh(c, 1.3)); rect(g, 6, 11, 4, 2, "#b8860b"); }
  else { // arrow/bolt/spear shaft
    line(g, 3, 13, 12, 4, c); P(g, 12, 4, "#cfd8dc"); P(g, 13, 3, "#eceff1"); // head
    P(g, 3, 13, "#e8e8e8"); P(g, 4, 12, "#e8e8e8"); // fletch
  }
  return g;
}
function rodIcon(c) { const g = make(); line(g, 3, 12, 12, 3, c); line(g, 4, 12, 13, 3, sh(c, 1.2)); return g; }
function lureIcon(c) { const g = make(); disc(g, 8, 8, 3, c); P(g, 7, 7, "#ffffff"); line(g, 10, 10, 13, 13, "#9aa6ad"); P(g, 13, 13, "#cfd8dc"); return g; }
function potteryIcon(c) { const g = make(); disc(g, 8, 9, 5, c); rect(g, 5, 4, 6, 4, c); rect(g, 6, 3, 4, 1, sh(c, 0.8)); disc(g, 6, 8, 2, sh(c, 1.18)); return g; }
function clayIcon(c) { const g = make(); disc(g, 8, 10, 5, c); disc(g, 6, 8, 2, sh(c, 1.15)); return g; }
function scrapIcon(c) { const g = make(); rect(g, 3, 6, 6, 5, c); rect(g, 8, 8, 5, 5, sh(c, 0.85)); rect(g, 3, 6, 6, 1, sh(c, 1.3)); return g; }
function netIcon(c) {
  const g = make();
  disc(g, 6, 6, 4, ""); // ring
  for (let a = 0; a < 12; a++) { const x = 6 + Math.cos(a / 12 * 6.28) * 4, y = 6 + Math.sin(a / 12 * 6.28) * 4; P(g, x, y, c); }
  for (let x = 3; x <= 9; x += 2) line(g, x, 3, x, 9, sh(c, 1.2));
  line(g, 8, 8, 13, 13, "#8d6e63"); // handle
  return g;
}
function pickaxeIcon() {
  const g = make();
  line(g, 8, 3, 8, 13, "#8d6e63"); line(g, 9, 3, 9, 13, "#7a5d50"); // handle
  for (let x = 3; x <= 13; x++) { const y = 4 + Math.abs(x - 8) * 0.5; P(g, x, y | 0, "#9aa6ad"); P(g, x, (y | 0) + 1, "#7c878d"); }
  return g;
}
function binocIcon(c) { const g = make(); rect(g, 3, 6, 4, 6, c); rect(g, 9, 6, 4, 6, c); rect(g, 7, 7, 2, 2, sh(c, 0.7)); rect(g, 3, 6, 4, 1, sh(c, 1.3)); rect(g, 9, 6, 4, 1, sh(c, 1.3)); return g; }
function bookIcon(c) { const g = make(); rect(g, 3, 4, 10, 9, c); rect(g, 3, 4, 1, 9, sh(c, 0.6)); rect(g, 4, 5, 8, 1, "#f4ecd8"); rect(g, 4, 7, 8, 1, "#f4ecd8"); rect(g, 4, 9, 6, 1, "#f4ecd8"); return g; }
function deviceIcon(c) { const g = make(); rect(g, 5, 4, 6, 9, c); rect(g, 6, 5, 4, 3, "#9be8ff"); disc(g, 8, 10, 1, "#ff5252"); rect(g, 7, 2, 2, 2, "#9aa6ad"); return g; }
function flagIcon(c) { const g = make(); line(g, 5, 3, 5, 13, "#8d6e63"); rect(g, 6, 3, 6, 4, c); P(g, 12, 4, sh(c, 0.7)); return g; }
function cageIcon(c) { const g = make(); rect(g, 3, 5, 10, 8, ""); for (let x = 3; x <= 13; x += 2) line(g, x, 5, x, 12, c); for (let y = 5; y <= 12; y += 2) line(g, 3, y, 13, y, c); return g; }
function dyeIcon(c) { const g = make(); rect(g, 5, 5, 6, 8, c); rect(g, 6, 3, 4, 2, sh(c, 0.7)); disc(g, 8, 9, 2, sh(c, 1.4)); return g; }
function kitIcon(c) { const g = make(); rect(g, 3, 6, 10, 7, c); rect(g, 6, 4, 4, 2, sh(c, 0.8)); rect(g, 3, 8, 10, 1, sh(c, 1.2)); P(g, 8, 10, "#fff"); return g; }

// ── Item → drawer mapping ─────────────────────────────────────────────────────
const WOODS = { wood: "#7a5a36", cedarwood: "#8a5a32", sprucewood: "#9a7a4a", firwood: "#6f5a34",
  hemwood: "#5a7e50", pinewood: "#9a8a55", yewwood: "#7a3e2c", alderwood: "#a08a48", mapwood: "#b08a3a" };

const ICONS = {};
const add = (id, grid) => { ICONS[id] = outline(grid); };

for (const [id, c] of Object.entries(WOODS)) add(id, logIcon(c));
add("plank", plankIcon("#b08a4c"));
add("rod", rodIcon("#6a7a86"));
add("stick", stickIcon());

add("iron", oreIcon("#9a7a5a"));
add("stone", oreIcon("#9a9a92"));
add("ironBar", barIcon("#c2c2d0"));
add("scrap", scrapIcon("#78909c"));
add("clay", clayIcon("#b5651d"));
add("pottery", potteryIcon("#b06a3a"));

for (const id of ["fish", "liveFish", "salmon", "lingcod", "halibut", "tuna"]) add(id, fishIcon(
  id === "salmon" ? "#d36a4a" : id === "tuna" ? "#4a7aa0" : id === "halibut" ? "#9a9a86" : id === "lingcod" ? "#6a8a5a" : "#7fb0c8"));
for (const id of ["cookedfish", "cookedsalmon", "cookedlingcod"]) add(id, fishIcon("#caa050"));

add("crabmeat", crabIcon("#d4824a"));
add("cookedcrab", crabIcon("#e0521f"));

for (const [id, c] of [["venison", "#b03a2b"], ["bearMeat", "#7a2b1a"], ["sealMeat", "#8e5fa0"], ["poultry", "#d0a44a"],
  ["cookedvenison", "#9a4a30"], ["cookedpoultry", "#c88a30"]]) add(id, meatIcon(c));

add("berry", berryIcon("#5566d0"));
add("bones", bonesIcon());
add("leather", leatherIcon("#9a6e44"));
add("jerryCan", jerryIcon("#e07020"));
add("shinyLure", lureIcon("#ffd54f"));

add("huntingKnife", knifeIcon());
add("bow", bowIcon());
add("crossbow", crossbowIcon());
add("speargun", speargunIcon());
add("rifle", rifleIcon());
add("arrow", ammoIcon("#8d6e63", "arrow"));
add("bolt", ammoIcon("#78909c", "bolt"));
add("spear", ammoIcon("#9aa6ad", "spear"));
add("bullet", ammoIcon("#caa83a", "bullet"));

add("clothShirt", shirtIcon("#d98fb0"));
add("clothPants", pantsIcon("#7f9ad0"));
add("fieldHat",  hatIcon("#c2a35a"));
add("waxedJacket", jacketIcon("#6b7b3a"));
add("rainCoat", jacketIcon("#e8c43a"));
add("woolSweater", shirtIcon("#9a7a54"));
add("wetsuitTop", shirtIcon("#2a3a4a"));
add("wetsuitBottom", pantsIcon("#2a3a4a"));
add("snorkelMask", maskIcon("#2ea8c0"));
add("divingTank", tankIcon("#6a8a96"));
add("fabricDye", dyeIcon("#c040c0"));
add("seamstressKit", kitIcon("#e0a0c0"));

add("binoculars", binocIcon("#3a5a6a"));
add("butterflyNet", netIcon("#9bd0d8"));
add("listeningDevice", deviceIcon("#6a3a6a"));
add("fieldNotebook", bookIcon("#caa43a"));
add("pickaxe", pickaxeIcon());
add("fishingCage", cageIcon("#6a8a6a"));
add("surveyFlag", flagIcon("#d44a4a"));

const out = { version: 1, size: S, icons: ICONS };
const outPath = resolve(__dirname, "../client/src/assets/item-sprites.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(out));
console.log("wrote", outPath, "with", Object.keys(ICONS).length, "icons (" + JSON.stringify(out).length + " bytes)");
