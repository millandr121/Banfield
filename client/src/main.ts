import { Appearance } from "../../shared/protocol";
import { Game } from "./game";

// Login / register screen -> game bootstrap.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const nameInput = $<HTMLInputElement>("name");
const passInput = $<HTMLInputElement>("pass");
const emailInput = $<HTMLInputElement>("email");
const skinInput = $<HTMLInputElement>("skin");
const hairInput = $<HTMLInputElement>("hair");
const shirtInput = $<HTMLInputElement>("shirt");
const previewCanvas = $<HTMLCanvasElement>("preview");
const pctx = previewCanvas.getContext("2d")!;
const tabNew = $<HTMLButtonElement>("tab-new");
const tabReturn = $<HTMLButtonElement>("tab-return");
const designBox = $<HTMLDivElement>("design");
const playBtn = $<HTMLButtonElement>("play");
const nameStatus = $<HTMLSpanElement>("name-status");
const authError = $<HTMLDivElement>("auth-error");

let mode: "new" | "return" = "new";

// ── Chip selectors ────────────────────────────────────────────────────────────
type ChipField = "hairStyle" | "bodyBuild" | "breastSize" | "hipSize";
const chipValues: Record<ChipField, string> = {
  hairStyle: "short",
  bodyBuild: "slight",
  breastSize: "non",
  hipSize: "narrow",
};

function wireChipGroup(field: ChipField) {
  const group = document.getElementById(`chips-${field}`)!;
  group.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest(".chip") as HTMLElement | null;
    if (!chip) return;
    chipValues[field] = chip.dataset.val ?? chipValues[field];
    group.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
    chip.classList.add("selected");
    drawPreview();
  });
}

(["hairStyle", "bodyBuild", "breastSize", "hipSize"] as ChipField[]).forEach(wireChipGroup);

// ── Restore saved identity ────────────────────────────────────────────────────
const saved = JSON.parse(localStorage.getItem("bamfield-char") || "null");
if (saved) {
  nameInput.value = saved.name ?? "";
  skinInput.value = saved.appearance?.skin ?? skinInput.value;
  hairInput.value = saved.appearance?.hair ?? hairInput.value;
  shirtInput.value = saved.appearance?.shirt ?? shirtInput.value;
  // Restore chip selections if saved.
  for (const f of ["hairStyle", "bodyBuild", "breastSize", "hipSize"] as ChipField[]) {
    const v = saved.appearance?.[f];
    if (v) {
      chipValues[f] = v;
      const group = document.getElementById(`chips-${f}`)!;
      group.querySelectorAll(".chip").forEach((c) => {
        c.classList.toggle("selected", (c as HTMLElement).dataset.val === v);
      });
    }
  }
  if (saved.name) setMode("return");
}

function appearance(): Appearance {
  return {
    skin: skinInput.value,
    hair: hairInput.value,
    shirt: shirtInput.value,
    hairStyle: chipValues.hairStyle as Appearance["hairStyle"],
    bodyBuild: chipValues.bodyBuild as Appearance["bodyBuild"],
    breastSize: chipValues.breastSize as Appearance["breastSize"],
    hipSize: chipValues.hipSize as Appearance["hipSize"],
  };
}

// ── Full-body face-on standing character preview ──────────────────────────────
// Canvas is 80×160. Character centered at cx=40.
function drawPreview() {
  const a = appearance();
  const W = previewCanvas.width, H = previewCanvas.height;
  const cx = W / 2;
  pctx.clearRect(0, 0, W, H);

  // Proportions based on build chip.
  const buildScale = chipValues.bodyBuild === "sturdy" ? 1.18
    : chipValues.bodyBuild === "medium" ? 1.0 : 0.86;

  // Body geometry (all in canvas pixels, face-on).
  const headR = 11;
  const headCY = 26;
  const shoulderW = 18 * buildScale;
  const torsoH = 34;
  const torsoTopY = headCY + headR + 2;
  const torsoBottomY = torsoTopY + torsoH;
  const hipW = (chipValues.hipSize === "wide" ? 22 : chipValues.hipSize === "medium" ? 18 : 14) * buildScale;
  const legH = 44;
  const legW = 7 * buildScale;

  // ── Legs (pants = dark navy by default) ──
  const pantsColor = "#263c5a";
  const legTopY = torsoBottomY - 4;
  // Left leg
  pctx.fillStyle = pantsColor;
  pctx.beginPath();
  pctx.roundRect(cx - hipW * 0.55 - legW / 2, legTopY, legW, legH, 3);
  pctx.fill();
  // Right leg
  pctx.beginPath();
  pctx.roundRect(cx + hipW * 0.55 - legW / 2, legTopY, legW, legH, 3);
  pctx.fill();

  // ── Torso (shirt) ──
  pctx.fillStyle = a.shirt;
  pctx.beginPath();
  // trapezoid: shoulders narrower than hips
  pctx.moveTo(cx - shoulderW, torsoTopY);
  pctx.lineTo(cx + shoulderW, torsoTopY);
  pctx.lineTo(cx + hipW, torsoBottomY);
  pctx.lineTo(cx - hipW, torsoBottomY);
  pctx.closePath();
  pctx.fill();

  // ── Chest hint (breastSize) ──
  if (chipValues.breastSize !== "non") {
    const bustR = chipValues.breastSize === "expressive" ? 6 : 3.5;
    const bustY = torsoTopY + 12;
    pctx.fillStyle = shadeColor(a.shirt, -18);
    pctx.beginPath();
    pctx.ellipse(cx - shoulderW * 0.38, bustY, bustR, bustR * 0.7, 0, 0, Math.PI * 2);
    pctx.fill();
    pctx.beginPath();
    pctx.ellipse(cx + shoulderW * 0.38, bustY, bustR, bustR * 0.7, 0, 0, Math.PI * 2);
    pctx.fill();
  }

  // ── Arms ──
  const armW = 5 * buildScale;
  const armH = 28;
  const armTopY = torsoTopY + 4;
  pctx.fillStyle = a.skin;
  // Left arm
  pctx.beginPath();
  pctx.roundRect(cx - shoulderW - armW + 1, armTopY, armW, armH, 3);
  pctx.fill();
  // Right arm
  pctx.beginPath();
  pctx.roundRect(cx + shoulderW - 1, armTopY, armW, armH, 3);
  pctx.fill();

  // ── Head ──
  pctx.fillStyle = a.skin;
  pctx.beginPath();
  pctx.arc(cx, headCY, headR, 0, Math.PI * 2);
  pctx.fill();

  // ── Hair ──
  pctx.fillStyle = a.hair;
  if (chipValues.hairStyle === "long") {
    // Long: cap + flowing sides down past shoulders
    pctx.beginPath();
    pctx.arc(cx, headCY, headR, Math.PI, 0);
    pctx.fill();
    pctx.fillRect(cx - headR, headCY, headR * 0.7, torsoTopY - headCY + 6);
    pctx.fillRect(cx + headR * 0.3, headCY, headR * 0.7, torsoTopY - headCY + 6);
  } else if (chipValues.hairStyle === "medium") {
    // Medium: cap + short side tufts
    pctx.beginPath();
    pctx.arc(cx, headCY, headR, Math.PI, 0);
    pctx.fill();
    pctx.fillRect(cx - headR, headCY, headR * 0.55, 8);
    pctx.fillRect(cx + headR * 0.45, headCY, headR * 0.55, 8);
  } else {
    // Buzz/short: just the scalp cap
    pctx.beginPath();
    pctx.arc(cx, headCY, headR, Math.PI, 0);
    pctx.fill();
  }

  // ── Eyes (tiny dots) ──
  pctx.fillStyle = "#0b1d2a";
  pctx.beginPath();
  pctx.arc(cx - 4, headCY + 2, 1.5, 0, Math.PI * 2);
  pctx.fill();
  pctx.beginPath();
  pctx.arc(cx + 4, headCY + 2, 1.5, 0, Math.PI * 2);
  pctx.fill();
}

/** Lighten (positive) or darken (negative) a hex colour by `amount`. */
function shadeColor(col: string, amount: number): string {
  const num = parseInt(col.replace("#", ""), 16);
  const r = Math.min(255, Math.max(0, (num >> 16) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0xff) + amount));
  const b = Math.min(255, Math.max(0, (num & 0xff) + amount));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

for (const el of [skinInput, hairInput, shirtInput]) {
  el.addEventListener("input", drawPreview);
}
drawPreview();

function setMode(m: "new" | "return") {
  mode = m;
  tabNew.classList.toggle("active", m === "new");
  tabReturn.classList.toggle("active", m === "return");
  designBox.classList.toggle("hidden", m === "return"); // returning players keep their look
  document.getElementById("email-row")!.classList.toggle("hidden", m === "return");
  playBtn.textContent = m === "new" ? "Wash ashore" : "Sign in";
  nameStatus.textContent = "";
  nameStatus.className = "status";
  authError.classList.add("hidden");
  if (m === "new") scheduleNameCheck();
}
tabNew.addEventListener("click", () => setMode("new"));
tabReturn.addEventListener("click", () => setMode("return"));

// --- wire the game socket early so we can check names before committing ------
const game = new Game($<HTMLCanvasElement>("game"));
game.connect();

game.onNameStatus = (name, taken) => {
  if (mode !== "new" || name !== nameInput.value.trim()) return;
  if (taken) {
    nameStatus.textContent = "· taken";
    nameStatus.className = "status taken";
  } else {
    nameStatus.textContent = "· available";
    nameStatus.className = "status free";
  }
};

game.onJoinDenied = (reason) => {
  authError.textContent = reason;
  authError.classList.remove("hidden");
  playBtn.disabled = false;
  playBtn.textContent = mode === "new" ? "Wash ashore" : "Sign in";
};

let checkTimer: number | undefined;
function scheduleNameCheck() {
  window.clearTimeout(checkTimer);
  const name = nameInput.value.trim();
  if (mode !== "new") { nameStatus.textContent = ""; return; }
  if (name.length < 2) { nameStatus.textContent = ""; nameStatus.className = "status"; return; }
  nameStatus.textContent = "· checking…";
  nameStatus.className = "status checking";
  checkTimer = window.setTimeout(() => game.checkName(name), 300);
}
nameInput.addEventListener("input", () => { authError.classList.add("hidden"); scheduleNameCheck(); });

function submit() {
  const name = nameInput.value.trim();
  const pass = passInput.value;
  authError.classList.add("hidden");
  if (name.length < 2) { showError("Pick a name (at least 2 characters)."); return; }
  if (pass.length < 4) { showError("Choose a password of at least 4 characters — it's how you log back in."); return; }
  if (mode === "new" && nameStatus.classList.contains("taken")) {
    showError("That name's taken. Pick another, or switch to “Returning”."); return;
  }
  const app = appearance();
  localStorage.setItem("bamfield-char", JSON.stringify({ name, appearance: app }));

  playBtn.disabled = true;
  playBtn.textContent = "Connecting…";
  game.start(name, app, pass, mode === "new", emailInput.value.trim() || undefined);

  // Reveal the HUD; if the join is denied, onJoinDenied re-enables the form.
  $("creator").classList.add("hidden");
  for (const id of ["hud", "help", "log"]) $(id).classList.remove("hidden");
}

function showError(msg: string) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

// A denied sign-in must bring the form back so they can retry.
const origDenied = game.onJoinDenied!;
game.onJoinDenied = (reason) => {
  $("creator").classList.remove("hidden");
  for (const id of ["hud", "help", "log"]) $(id).classList.add("hidden");
  origDenied(reason);
};

playBtn.addEventListener("click", submit);
for (const el of [nameInput, passInput]) {
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}
