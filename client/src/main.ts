import { Appearance } from "../../shared/protocol";
import { Game } from "./game";
import { drawCharacterPixel, type CharOpts as PixelCharOpts } from "./pixelchar";

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

// ── Full-body pixel-art character preview ─────────────────────────────────────
function drawPreview() {
  const app = appearance();
  pctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  pctx.fillStyle = "#0a1c29";
  pctx.fillRect(0, 0, previewCanvas.width, previewCanvas.height);
  const cx = previewCanvas.width / 2;
  const cy = previewCanvas.height * 0.6;
  const opts: PixelCharOpts = { facing: "down", phase: 0, moving: false };
  drawCharacterPixel(pctx, cx, cy, app, opts);
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

  // Reveal the HUD & chat log; if the join is denied, onJoinDenied re-enables the form.
  // (Help lives in the side-panel "?" tab now — there is no #help element.)
  $("creator").classList.add("hidden");
  for (const id of ["hud", "log"]) $(id).classList.remove("hidden");
}

function showError(msg: string) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

// A denied sign-in must bring the form back so they can retry.
const origDenied = game.onJoinDenied!;
game.onJoinDenied = (reason) => {
  $("creator").classList.remove("hidden");
  for (const id of ["hud", "log"]) $(id).classList.add("hidden");
  origDenied(reason);
};

playBtn.addEventListener("click", submit);
for (const el of [nameInput, passInput]) {
  el.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}
