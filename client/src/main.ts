import { Appearance } from "../../shared/protocol";
import { Game } from "./game";

// Character creator -> game bootstrap.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const nameInput = $<HTMLInputElement>("name");
const skinInput = $<HTMLInputElement>("skin");
const hairInput = $<HTMLInputElement>("hair");
const shirtInput = $<HTMLInputElement>("shirt");
const previewCanvas = $<HTMLCanvasElement>("preview");
const pctx = previewCanvas.getContext("2d")!;

// Restore last-used identity.
const saved = JSON.parse(localStorage.getItem("bamfield-char") || "null");
if (saved) {
  nameInput.value = saved.name ?? "";
  skinInput.value = saved.appearance?.skin ?? skinInput.value;
  hairInput.value = saved.appearance?.hair ?? hairInput.value;
  shirtInput.value = saved.appearance?.shirt ?? shirtInput.value;
}

function appearance(): Appearance {
  return { skin: skinInput.value, hair: hairInput.value, shirt: shirtInput.value };
}

function drawPreview() {
  const a = appearance();
  const c = 48;
  pctx.clearRect(0, 0, 96, 96);
  pctx.fillStyle = a.shirt;
  pctx.beginPath();
  pctx.arc(c, c, 34, 0, Math.PI * 2);
  pctx.fill();
  pctx.fillStyle = a.skin;
  pctx.beginPath();
  pctx.arc(c, c, 21, 0, Math.PI * 2);
  pctx.fill();
  pctx.fillStyle = a.hair;
  pctx.beginPath();
  pctx.arc(c, c, 21, Math.PI, Math.PI * 2);
  pctx.fill();
}

for (const el of [skinInput, hairInput, shirtInput]) {
  el.addEventListener("input", drawPreview);
}
drawPreview();

$<HTMLButtonElement>("play").addEventListener("click", () => {
  const name = nameInput.value.trim() || "Settler";
  const app = appearance();
  localStorage.setItem("bamfield-char", JSON.stringify({ name, appearance: app }));

  $("creator").classList.add("hidden");
  for (const id of ["hud", "help", "log"]) $(id).classList.remove("hidden");

  const game = new Game($<HTMLCanvasElement>("game"));
  game.start(name, app);
});
