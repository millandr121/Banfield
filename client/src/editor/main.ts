// Banfield Sprite Editor — a self-contained, layered pixel-art tool.
//
// Authors SpriteDoc files (see shared/sprite.ts): per-facing animation frames,
// each a stack of named layers (skin / hair / shirt / pants / accessory).
// Paint with pencil / eraser / fill / eyedropper, preview the walk cycle live,
// and save / export to JSON or a PNG sprite sheet.

import {
  Facing, FACINGS, SpriteDoc, SpriteFrame, AnimationClip, DyeRole, DYE_ROLES, Tints,
  newSpriteDoc, newCreatureDoc, emptyFrame, emptyPixels, compositeFrame, normalizeLayers, renderFrame,
  docHasPaint, CREATURE_W, CREATURE_H, getClip, listClips, addClip, deleteClip,
  CHAR_CLIPS, CREATURE_CLIPS, PROP_CLIPS, DEFAULT_DYES,
} from "../../../shared/sprite";
import baseChar from "../assets/base-character.json";
import rawItemSheet from "../assets/item-sprites.json";
import npcLooksData from "../assets/npc-looks.json";
import rawTerrainData from "../assets/terrain-settings.json";
import rawCreatureSheet from "../assets/creature-sprites.json";
import rawClothingSheet from "../assets/clothing-sprites.json";
import rawObjectSheet from "../assets/object-sprites.json";
import rawNpcSheet from "../assets/npc-sprites.json";
import rawTerrainSprites from "../assets/terrain-sprites.json";
import { drawCharacterPixel, rasterizeCharacterToPixels } from "../pixelchar";
import { drawFullCreature, rasterizeCreatureToPixels, setCreatureDocProvider } from "../creatures";
import type { Appearance } from "../../../shared/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Category / mode ────────────────────────────────────────────────────────────
type Category = "characters" | "creatures" | "clothing" | "objects" | "items" | "terrain";
let category: Category = "characters";
let charSubject = ""; // will be set to playerSheet.active once playerSheet is loaded

function isSpriteMode(): boolean {
  // Everything except flat items is a paintable sprite.
  return category !== "items";
}

// ── Terrain settings state ────────────────────────────────────────────────────
const TERRAIN_KEY = "banfield-terrain";
interface TerrainSettings { colors: Record<string, string>; }
const TERRAIN_DEFAULTS = (rawTerrainData as unknown as TerrainSettings).colors;
const TERRAIN_LABELS: Record<string, string> = {
  grass: "Grass", forest: "Forest", sand: "Sand", hill: "Hill",
  rock: "Rock", road: "Road", water: "Water (sea)", freshwater: "Fresh Water", dock: "Dock",
};
let terrainSettings: TerrainSettings = loadTerrainSettings();
function loadTerrainSettings(): TerrainSettings {
  try { const r = localStorage.getItem(TERRAIN_KEY); if (r) return JSON.parse(r); } catch { /* ignore */ }
  return { colors: { ...TERRAIN_DEFAULTS } };
}
function saveTerrainSettings() { localStorage.setItem(TERRAIN_KEY, JSON.stringify(terrainSettings)); }

// ── Terrain sprite sheet (pixel art per tile type) ─────────────────────────
interface TerrainSpriteSheet { version: number; tileSize: number; docs: Record<string, SpriteDoc>; }
const TERRAIN_SPRITES_KEY = "banfield-terrain-sprites";
const TERRAIN_TILE_SIZE = 24; // art pixels per tile
const TERRAIN_TILE_TYPES = ["grass", "forest", "sand", "hill", "rock", "road", "water", "freshwater", "dock"];
const TERRAIN_TILE_LABELS: Record<string, string> = {
  grass: "Grass", forest: "Forest", sand: "Sand", hill: "Hill",
  rock: "Rock", road: "Road", water: "Ocean Water", freshwater: "Fresh Water", dock: "Dock",
};
let terrainSpriteSheet: TerrainSpriteSheet = loadTerrainSpriteSheet();
let editingTerrainTile: string | null = null;

function loadTerrainSpriteSheet(): TerrainSpriteSheet {
  let base = JSON.parse(JSON.stringify(rawTerrainSprites)) as TerrainSpriteSheet;
  try {
    const raw = localStorage.getItem(TERRAIN_SPRITES_KEY);
    if (raw) base = JSON.parse(raw) as TerrainSpriteSheet;
  } catch { /* ignore */ }
  if (!base.docs) base.docs = {};
  if (!base.tileSize) base.tileSize = TERRAIN_TILE_SIZE;
  for (const k of Object.keys(base.docs)) base.docs[k] = normalizeLayers(base.docs[k]);
  return base;
}
function saveTerrainSpriteSheet() { localStorage.setItem(TERRAIN_SPRITES_KEY, JSON.stringify(terrainSpriteSheet)); }

function terrainTileDocFor(tileKey: string): SpriteDoc {
  if (!terrainSpriteSheet.docs[tileKey]) {
    const T = terrainSpriteSheet.tileSize ?? TERRAIN_TILE_SIZE;
    terrainSpriteSheet.docs[tileKey] = newSpriteDoc(TERRAIN_TILE_LABELS[tileKey] ?? tileKey, T, T, ["base", "overlay"], ["none", "none"], ["idle"]);
  }
  return terrainSpriteSheet.docs[tileKey];
}

function selectTerrainTile(tileKey: string) {
  editingTerrainTile = tileKey;
  editingCreature = null; editingClothing = null; editingObject = null; editingNpc = null;
  doc = terrainTileDocFor(tileKey);
  currentClip = doc.defaultClip;
  facing = "down"; frameIdx = 0; layerIdx = 0; previewFrame = 0;
  layerVisible = doc.layerNames.map(() => true);
  onionRefPixels = null;
  buildSubjectGrid();
  updateUI();
}

// ── Item sprites state ────────────────────────────────────────────────────────
interface ItemSheet { version: number; size: number; icons: Record<string, string[]>; }
const ITEM_SHEET_KEY = "banfield-item-sprites";
let itemSheet: ItemSheet = loadItemSheet();
let currentItemId = "";       // which icon is being edited
let itemPixels: string[] = []; // flat ITEM_SIZE×ITEM_SIZE editable copy
const ITEM_SIZE: number = (rawItemSheet as unknown as ItemSheet).size;

function loadItemSheet(): ItemSheet {
  try {
    const raw = localStorage.getItem(ITEM_SHEET_KEY);
    if (raw) return JSON.parse(raw) as ItemSheet;
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(rawItemSheet)) as ItemSheet;
}
function saveItemSheet() {
  localStorage.setItem(ITEM_SHEET_KEY, JSON.stringify(itemSheet));
}

// ── NPC state ─────────────────────────────────────────────────────────────────
const NPC_LOOKS_KEY = "banfield-npc-looks";
type NpcKind = keyof typeof npcLooksData;
const NPC_KINDS = Object.keys(npcLooksData) as NpcKind[];
const NPC_DISPLAY: Record<string, string> = {
  naturalist: "Naturalist", pirate: "Local Pirate", scientist: "Marine Scientist",
  westsider: "West Sider", eastsider: "East Sider", huuayaht: "Huu-ay-aht",
  mayor: "Mayor", historian: "Historian", boatdealer: "Boat Dealer",
  icevendor: "Ice Vendor", seamstress: "Seamstress", researcher2: "Field Researcher",
  marineBiologist: "Marine Biologist", snorkeler: "Snorkeler",
};
let npcLooks: Record<string, Appearance> = loadNpcLooks();

function loadNpcLooks(): Record<string, Appearance> {
  try {
    const raw = localStorage.getItem(NPC_LOOKS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return JSON.parse(JSON.stringify(npcLooksData));
}

// ── NPC paintable sprite sheet ────────────────────────────────────────────────
// NPCs are editable as full sprites just like the player: we seed a SpriteDoc
// from their procedural appearance (all 8 facings) and let you repaint pixels.
interface NpcSheet { version: number; docs: Record<string, SpriteDoc>; }
const NPC_SPRITES_KEY = "banfield-npc-sprites";
let npcSheet: NpcSheet = loadNpcSheet();
function loadNpcSheet(): NpcSheet {
  let base = JSON.parse(JSON.stringify(rawNpcSheet)) as NpcSheet;
  try { const raw = localStorage.getItem(NPC_SPRITES_KEY); if (raw) base = JSON.parse(raw) as NpcSheet; } catch { /* ignore */ }
  if (!base.docs) base.docs = {};
  for (const k of Object.keys(base.docs)) base.docs[k] = normalizeLayers(base.docs[k]);
  return base;
}
function saveNpcSheet() { localStorage.setItem(NPC_SPRITES_KEY, JSON.stringify(npcSheet)); }

/** Get (or seed) an NPC's paintable doc, rasterizing the procedural look. */
function npcDocFor(kind: string): SpriteDoc {
  if (!npcSheet.docs[kind]) npcSheet.docs[kind] = seedNpcDoc(kind);
  return npcSheet.docs[kind];
}
function seedNpcDoc(kind: string): SpriteDoc {
  const d = newSpriteDoc(NPC_DISPLAY[kind] ?? kind, 20, 26,
    ["skin", "hair", "shirt", "pants", "accessory"], DEFAULT_DYES, ["idle"]);
  const app = npcLooks[kind] ?? (npcLooksData as Record<string, Appearance>)[kind];
  const clip = d.animations.idle;
  for (const f of FACINGS) {
    const px = rasterizeCharacterToPixels(app, f);
    // Whole rasterized look goes on the skin (base) layer; user splits it onto
    // hair/shirt/pants by repainting as desired.
    clip.facings[f] = [{ layers: [px, emptyPixels(20, 26), emptyPixels(20, 26), emptyPixels(20, 26), emptyPixels(20, 26)] }];
  }
  return d;
}

// ── Player characters sheet ────────────────────────────────────────────────────
// Multiple authored characters; `active` is the one the game currently uses.
interface PlayerSheet { version: number; active: string; docs: Record<string, SpriteDoc>; }
const PLAYER_SHEET_KEY = "banfield-player-sheet";
let playerSheet: PlayerSheet = loadPlayerSheet();

function loadPlayerSheet(): PlayerSheet {
  try {
    const raw = localStorage.getItem(PLAYER_SHEET_KEY);
    if (raw) {
      const s = JSON.parse(raw) as PlayerSheet;
      if (!s.docs) s.docs = {};
      for (const k of Object.keys(s.docs)) s.docs[k] = normalizeLayers(s.docs[k]);
      if (!s.active || !s.docs[s.active]) s.active = Object.keys(s.docs)[0] ?? "player";
      if (!s.docs[s.active]) s.docs[s.active] = normalizeLayers(JSON.parse(JSON.stringify(baseChar)) as SpriteDoc);
      return s;
    }
  } catch { /* ignore */ }
  // Migrate from old single-doc STORAGE_KEY
  const base: PlayerSheet = { version: 1, active: "player", docs: {} };
  try {
    const oldRaw = localStorage.getItem("banfield-sprite-doc");
    if (oldRaw) { base.docs["player"] = normalizeLayers(JSON.parse(oldRaw)); return base; }
  } catch { /* ignore */ }
  base.docs["player"] = normalizeLayers(JSON.parse(JSON.stringify(baseChar)) as SpriteDoc);
  return base;
}
function savePlayerSheet() { localStorage.setItem(PLAYER_SHEET_KEY, JSON.stringify(playerSheet)); }

// ── Creature kinds ────────────────────────────────────────────────────────────
const CREATURE_KINDS = [
  "seal", "sealLion", "seaOtter", "deer", "elk", "grouse", "bear", "cougar", "wolf",
  "crab", "octopus", "dogfish", "sixgill", "orca", "humpback", "greywhale",
];
const CREATURE_DISPLAY: Record<string, string> = {
  seal: "Seal", sealLion: "Sea Lion", seaOtter: "Sea Otter", deer: "Deer",
  elk: "Elk", grouse: "Grouse", bear: "Bear", cougar: "Cougar", wolf: "Wolf",
  crab: "Crab", octopus: "Octopus", dogfish: "Dogfish", sixgill: "Sixgill Shark",
  orca: "Orca", humpback: "Humpback Whale", greywhale: "Grey Whale",
};

// ── Clothing items ────────────────────────────────────────────────────────────
const CLOTHING_ITEMS = [
  "clothShirt", "clothPants", "fieldHat",
  "waxedJacket", "rainCoat", "woolSweater",
  "wetsuitTop", "wetsuitBottom", "snorkelMask", "divingTank",
] as const;
const CLOTHING_DISPLAY: Record<string, string> = {
  clothShirt: "Cloth Shirt", clothPants: "Cloth Pants", fieldHat: "Field Hat",
  waxedJacket: "Waxed Jacket", rainCoat: "Rain Coat", woolSweater: "Wool Sweater",
  wetsuitTop: "Wetsuit Top", wetsuitBottom: "Wetsuit Bottom",
  snorkelMask: "Snorkel Mask", divingTank: "Diving Tank",
};
const CLOTHING_DYE: Record<string, DyeRole[]> = {
  clothShirt: ["shirt", "none"], waxedJacket: ["shirt", "none"],
  rainCoat: ["shirt", "none"], woolSweater: ["shirt", "none"],
  wetsuitTop: ["shirt", "none"], clothPants: ["pants", "none"],
  wetsuitBottom: ["pants", "none"], fieldHat: ["accent", "none"],
  snorkelMask: ["none", "none"], divingTank: ["none", "none"],
};

// ── Environment objects ───────────────────────────────────────────────────────
const OBJECT_KINDS = [
  "campfire", "furnace", "tree_oak", "tree_pine", "tree_cedar",
  "boulder", "barrel", "chest", "door", "fence_post", "dock_post", "boat_small",
] as const;
const OBJECT_DISPLAY: Record<string, string> = {
  campfire: "Campfire", furnace: "Furnace",
  tree_oak: "Oak Tree", tree_pine: "Pine Tree", tree_cedar: "Cedar Tree",
  boulder: "Boulder", barrel: "Barrel", chest: "Chest", door: "Door",
  fence_post: "Fence Post", dock_post: "Dock Post", boat_small: "Small Boat",
};
const OBJECT_W = 32, OBJECT_H = 32;

// ── Clothing sprite sheet ─────────────────────────────────────────────────────
interface ClothingSheet { version: number; docs: Record<string, SpriteDoc>; }
const CLOTHING_SHEET_KEY = "banfield-clothing-sprites";
let clothingSheet: ClothingSheet = loadClothingSheet();
function loadClothingSheet(): ClothingSheet {
  let base = JSON.parse(JSON.stringify(rawClothingSheet)) as ClothingSheet;
  try {
    const raw = localStorage.getItem(CLOTHING_SHEET_KEY);
    if (raw) base = JSON.parse(raw) as ClothingSheet;
  } catch { /* ignore */ }
  if (!base.docs) base.docs = {};
  for (const k of Object.keys(base.docs)) base.docs[k] = normalizeLayers(base.docs[k]);
  return base;
}
function saveClothingSheet() { localStorage.setItem(CLOTHING_SHEET_KEY, JSON.stringify(clothingSheet)); }
function clothingDocFor(itemId: string): SpriteDoc {
  if (!clothingSheet.docs[itemId]) {
    const dyes = CLOTHING_DYE[itemId] ?? ["shirt", "none"];
    clothingSheet.docs[itemId] = newSpriteDoc(itemId, 20, 26, ["base", "detail"], dyes, ["idle", "walk"]);
  }
  return clothingSheet.docs[itemId];
}

// ── Object sprite sheet ───────────────────────────────────────────────────────
interface ObjectSheet { version: number; docs: Record<string, SpriteDoc>; }
const OBJECT_SHEET_KEY = "banfield-object-sprites";
let objectSheet: ObjectSheet = loadObjectSheet();
function loadObjectSheet(): ObjectSheet {
  let base = JSON.parse(JSON.stringify(rawObjectSheet)) as ObjectSheet;
  try {
    const raw = localStorage.getItem(OBJECT_SHEET_KEY);
    if (raw) base = JSON.parse(raw) as ObjectSheet;
  } catch { /* ignore */ }
  if (!base.docs) base.docs = {};
  for (const k of Object.keys(base.docs)) base.docs[k] = normalizeLayers(base.docs[k]);
  return base;
}
function saveObjectSheet() { localStorage.setItem(OBJECT_SHEET_KEY, JSON.stringify(objectSheet)); }
function objectDocFor(kind: string): SpriteDoc {
  if (!objectSheet.docs[kind]) {
    objectSheet.docs[kind] = newSpriteDoc(kind, OBJECT_W, OBJECT_H, ["base", "shade", "glow"], ["none", "none", "none"], PROP_CLIPS);
  }
  return objectSheet.docs[kind];
}

// ── Creature sprite docs ──────────────────────────────────────────────────────
interface CreatureSheet { version: number; w: number; h: number; layers: string[]; docs: Record<string, SpriteDoc>; }
const CREATURE_SHEET_KEY = "banfield-creature-sprites";
let creatureSheet: CreatureSheet = loadCreatureSheet();
function loadCreatureSheet(): CreatureSheet {
  let base = JSON.parse(JSON.stringify(rawCreatureSheet)) as CreatureSheet;
  try {
    const raw = localStorage.getItem(CREATURE_SHEET_KEY);
    if (raw) base = JSON.parse(raw) as CreatureSheet;
  } catch { /* ignore */ }
  if (!base.docs) base.docs = {};
  for (const k of Object.keys(base.docs)) base.docs[k] = normalizeLayers(base.docs[k]);
  return base;
}
function saveCreatureSheet() { localStorage.setItem(CREATURE_SHEET_KEY, JSON.stringify(creatureSheet)); }
function creatureDocFor(kind: string): SpriteDoc {
  if (!creatureSheet.docs[kind]) {
    creatureSheet.docs[kind] = newCreatureDoc(kind, creatureSheet.w ?? CREATURE_W, creatureSheet.h ?? CREATURE_H);
  }
  return creatureSheet.docs[kind];
}

// Editor-side sprite provider
setCreatureDocProvider((kind) => {
  const d = creatureSheet.docs[kind];
  if (!d || !docHasPaint(d)) return null;
  const clip = d.animations.walk ? "walk" : d.defaultClip;
  const frames = d.animations[clip]?.facings.down?.length ?? 1;
  return { doc: d, frameIdx: Math.floor(performance.now() / 180) % Math.max(1, frames), clip };
});

// ── Editor state ──────────────────────────────────────────────────────────────
type Tool = "pencil" | "eraser" | "fill" | "pick";

let tints: Tints = { skin: "#d8a870", hair: "#5a4632", shirt: "#3f8a44", pants: "#36507e", accent: "#ffd54f" };
let tintPreview = false;

let charDoc: SpriteDoc = playerSheet.docs[playerSheet.active];
let doc: SpriteDoc = charDoc;
charSubject = playerSheet.active; // sync after playerSheet is ready
let editingCreature: string | null = null;
let editingClothing: string | null = null;
let editingObject: string | null = null;
let editingNpc: string | null = null;
let currentClothingId = "";
let currentObjectId = "";
let currentCreatureKind = "";
let facing: Facing = "down";
let currentClip = doc.defaultClip;
let frameIdx = 0;
let layerIdx = 0;
let layerVisible: boolean[] = doc.layerNames.map(() => true);
let tool: Tool = "pencil";
let color = "#e0ac69";
let zoom = 14;
let showGrid = true;
let onion = false;
let playing = true;
let onionRefPixels: string[] | null = null;

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
const itemPreview = $<HTMLCanvasElement>("item-preview");
const ipctx = itemPreview.getContext("2d")!;

// ── Helpers ────────────────────────────────────────────────────────────────────
function curClip(): AnimationClip { return getClip(doc, currentClip); }
function curFrames(): SpriteFrame[] { return curClip().facings[facing]; }
function curFrame(): SpriteFrame { return curFrames()[frameIdx]; }
function curLayer(): string[] { return curFrame().layers[layerIdx]; }
function idx(x: number, y: number) { return y * doc.w + x; }
function ensureClip() {
  if (!doc.animations[currentClip]) currentClip = doc.defaultClip;
  const frames = curClip().facings[facing] ?? [];
  if (frameIdx >= frames.length) frameIdx = Math.max(0, frames.length - 1);
}

function saveToStorage() {
  if (editingTerrainTile) { saveTerrainSpriteSheet(); return; }
  if (editingCreature) { saveCreatureSheet(); return; }
  if (editingClothing) { saveClothingSheet(); return; }
  if (editingObject) { saveObjectSheet(); return; }
  if (editingNpc) { saveNpcSheet(); return; }
  playerSheet.docs[playerSheet.active] = charDoc;
  savePlayerSheet();
}

// ── Stage rendering ──────────────────────────────────────────────────────────
function sizeStage() {
  const w = category === "items" ? ITEM_SIZE : doc.w;
  const h = category === "items" ? ITEM_SIZE : doc.h;
  stage.width  = w * zoom;
  stage.height = h * zoom;
  stage.style.width  = stage.width  + "px";
  stage.style.height = stage.height + "px";
}

function drawStage() {
  sctx.clearRect(0, 0, stage.width, stage.height);

  if (category === "items") {
    const W = ITEM_SIZE, H = ITEM_SIZE;
    paintPixels(sctx, itemPixels, zoom, ITEM_SIZE, ITEM_SIZE);
    if (showGrid && zoom >= 6) {
      sctx.strokeStyle = "rgba(255,255,255,0.09)";
      sctx.lineWidth = 1;
      for (let x = 0; x <= W; x++) {
        sctx.beginPath(); sctx.moveTo(x * zoom + .5, 0); sctx.lineTo(x * zoom + .5, stage.height); sctx.stroke();
      }
      for (let y = 0; y <= H; y++) {
        sctx.beginPath(); sctx.moveTo(0, y * zoom + .5); sctx.lineTo(stage.width, y * zoom + .5); sctx.stroke();
      }
    }
    ipctx.clearRect(0, 0, itemPreview.width, itemPreview.height);
    const sc = Math.floor(itemPreview.width / ITEM_SIZE);
    const ox2 = (itemPreview.width  - ITEM_SIZE * sc) / 2;
    const oy2 = (itemPreview.height - ITEM_SIZE * sc) / 2;
    ipctx.save(); ipctx.translate(ox2, oy2);
    paintPixels(ipctx, itemPixels, sc, ITEM_SIZE, ITEM_SIZE);
    ipctx.restore();
    return;
  }

  ensureClip();
  if (onionRefPixels) {
    sctx.globalAlpha = 0.3;
    paintPixels(sctx, onionRefPixels, zoom);
    sctx.globalAlpha = 1;
  }
  if (onion) {
    const frames = curFrames();
    const prev = frames[(frameIdx - 1 + frames.length) % frames.length];
    if (prev !== curFrame()) {
      const comp = compositeFrame(prev, layerVisible, doc.w, doc.h);
      sctx.globalAlpha = 0.25;
      paintPixels(sctx, comp, zoom);
      sctx.globalAlpha = 1;
    }
  }

  const comp = tintPreview
    ? renderFrame(doc, currentClip, facing, frameIdx, tints, layerVisible)
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

function paintPixels(ctx: CanvasRenderingContext2D, px: string[], scale: number, W = doc.w, H = doc.h) {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = px[y * W + x];
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
  if (!isSpriteMode()) return;
  const clip = curClip();
  const frames = clip.facings[facing];
  if (!frames || frames.length === 0) return;
  if (playing && t - lastTick > 1000 / Math.max(1, clip.fps)) {
    previewFrame = (previewFrame + 1) % frames.length;
    lastTick = t;
  }
  const pf = playing ? previewFrame % frames.length : Math.min(frameIdx, frames.length - 1);
  const comp = tintPreview
    ? renderFrame(doc, currentClip, facing, pf, tints, layerVisible)
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
  const W = category === "items" ? ITEM_SIZE : doc.w;
  const H = category === "items" ? ITEM_SIZE : doc.h;
  if (x < 0 || y < 0 || x >= W || y >= H) return null;
  return [x, y];
}

function itemIdx(x: number, y: number) { return y * ITEM_SIZE + x; }

function applyTool(x: number, y: number) {
  if (category === "items") {
    const i = itemIdx(x, y);
    if (tool === "pencil") itemPixels[i] = color;
    else if (tool === "eraser") itemPixels[i] = "";
    else if (tool === "pick") { const c = itemPixels[i]; if (c) setColor(c); return; }
    else if (tool === "fill") floodFill(itemPixels, x, y, itemPixels[i], color, ITEM_SIZE, ITEM_SIZE);
    drawStage();
    return;
  }
  const layer = curLayer();
  if (tool === "pencil") layer[idx(x, y)] = color;
  else if (tool === "eraser") layer[idx(x, y)] = "";
  else if (tool === "pick") {
    const comp = compositeFrame(curFrame(), layerVisible, doc.w, doc.h);
    const c = comp[idx(x, y)];
    if (c) setColor(c);
    return;
  } else if (tool === "fill") {
    floodFill(layer, x, y, layer[idx(x, y)], color, doc.w, doc.h);
  }
  drawStage();
}

function floodFill(layer: string[], sx: number, sy: number, target: string, repl: string, W: number, H: number) {
  if (target === repl) return;
  const ii = (x: number, y: number) => y * W + x;
  const stack: [number, number][] = [[sx, sy]];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    if (layer[ii(x, y)] !== target) continue;
    layer[ii(x, y)] = repl;
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
  // Keep the left-sidebar subject thumbnails in sync with what was just painted
  // (terrain tile cards, character cards, etc. otherwise show stale art).
  if (category === "terrain") refreshTerrainCard();
});

// ── UI helper ─────────────────────────────────────────────────────────────────
function show(id: string, val: boolean, display = "block") {
  const el = document.getElementById(id);
  if (el) el.style.display = val ? display : "none";
}

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

function buildTimeline() {
  if (!isSpriteMode()) {
    show("timeline", false);
    return;
  }
  show("timeline", true);

  // Clips row
  const clipsWrap = $<HTMLDivElement>("tl-clips");
  clipsWrap.innerHTML = "";
  for (const name of listClips(doc)) {
    const b = document.createElement("button");
    b.textContent = name + (name === doc.defaultClip ? " ★" : "");
    b.className = name === currentClip ? "active" : "";
    b.style.cssText = "font-size:10px;padding:2px 6px";
    b.addEventListener("click", () => {
      currentClip = name; frameIdx = 0; previewFrame = 0;
      ($("fps") as HTMLInputElement).value = String(curClip().fps);
      ($("clip-loop") as HTMLInputElement).checked = curClip().loop;
      buildTimeline(); drawStage();
    });
    clipsWrap.appendChild(b);
  }
  ($("fps") as HTMLInputElement).value = String(curClip().fps);
  ($("clip-loop") as HTMLInputElement).checked = curClip().loop;

  // Facings row
  const facingsWrap = $<HTMLDivElement>("tl-facings");
  facingsWrap.innerHTML = "";
  const flabels: Record<Facing, string> = {
    down: "↓", downright: "↘", right: "→", upright: "↗",
    up: "↑", upleft: "↖", left: "←", downleft: "↙",
  };
  for (const f of FACINGS) {
    const b = document.createElement("button");
    b.textContent = flabels[f];
    b.className = f === facing ? "active" : "";
    b.style.cssText = "min-width:22px;padding:2px 3px;font-size:12px";
    b.addEventListener("click", () => { facing = f; frameIdx = 0; previewFrame = 0; buildTimeline(); drawStage(); });
    facingsWrap.appendChild(b);
  }

  // Frame thumbnails
  const framesWrap = $<HTMLDivElement>("tl-frames");
  framesWrap.innerHTML = "";
  ensureClip();
  const frames = curFrames();
  const maxDim = Math.max(doc.w, doc.h);
  const thumbScale = maxDim <= 20 ? 2 : 1;
  const thumbW = doc.w * thumbScale;
  const thumbH = doc.h * thumbScale;
  frames.forEach((frame, i) => {
    const c = document.createElement("canvas");
    c.className = "frame-thumb" + (i === frameIdx ? " sel" : "");
    c.width = thumbW; c.height = thumbH;
    c.style.width = thumbW + "px"; c.style.height = thumbH + "px";
    c.title = `Frame ${i + 1}`;
    const cx2 = c.getContext("2d")!;
    const px = compositeFrame(frame, layerVisible, doc.w, doc.h);
    paintPixels(cx2, px, thumbScale, doc.w, doc.h);
    c.addEventListener("click", () => { frameIdx = i; buildTimeline(); drawStage(); });
    framesWrap.appendChild(c);
  });
}

function buildLayers() {
  const wrap = $<HTMLDivElement>("layers");
  wrap.innerHTML = "";
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
      doc.layerRefLum = undefined;
      saveToStorage(); drawStage();
    });
    row.appendChild(vis); row.appendChild(nm); row.appendChild(sel);
    row.addEventListener("click", () => { layerIdx = li; buildLayers(); });
    wrap.appendChild(row);
  }
}

function buildDyeRows() {
  const wrap = document.getElementById("dye-rows");
  if (!wrap) return;
  wrap.innerHTML = "";
  const roles: (keyof Tints)[] = ["skin", "hair", "shirt", "pants", "accent"];
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
    wrap.appendChild(row);
  }
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
  curClip().fps = Math.max(1, Math.min(24, +(e.target as HTMLInputElement).value));
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
  curFrames().push(emptyFrame(doc.w, doc.h, doc.layerNames.length));
  frameIdx = curFrames().length - 1;
  saveToStorage(); buildTimeline(); drawStage();
});
$("frame-dup").addEventListener("click", () => {
  const clone: SpriteFrame = { layers: curFrame().layers.map((l) => [...l]) };
  curFrames().splice(frameIdx + 1, 0, clone);
  frameIdx++;
  saveToStorage(); buildTimeline(); drawStage();
});
$("frame-del").addEventListener("click", () => {
  if (curFrames().length <= 1) return;
  curFrames().splice(frameIdx, 1);
  frameIdx = Math.min(frameIdx, curFrames().length - 1);
  saveToStorage(); buildTimeline(); drawStage();
});

// Frame clipboard — copy a frame's layers and paste into any frame/facing/clip,
// so you can build the next pose by tweaking the previous instead of redrawing.
let frameClipboard: { w: number; h: number; layers: string[][] } | null = null;
$("frame-copy")?.addEventListener("click", () => {
  frameClipboard = { w: doc.w, h: doc.h, layers: curFrame().layers.map((l) => [...l]) };
  flash("Frame copied ⧉ — Paste into any frame");
});
$("frame-paste")?.addEventListener("click", () => {
  if (!frameClipboard) { flash("Nothing copied yet"); return; }
  if (frameClipboard.w !== doc.w || frameClipboard.h !== doc.h) {
    flash("Can't paste — different sprite size"); return;
  }
  const f = curFrame();
  for (let li = 0; li < f.layers.length; li++) {
    f.layers[li] = frameClipboard.layers[li] ? [...frameClipboard.layers[li]] : emptyPixels(doc.w, doc.h);
  }
  saveToStorage(); buildTimeline(); drawStage();
  flash("Pasted ⧉");
});

// ── Layer add / rename / delete ───────────────────────────────────────────────
$("layer-add")?.addEventListener("click", () => {
  const name = prompt("New layer name (e.g. shoes, hat, glasses):", "extra")?.trim();
  if (!name) return;
  if (doc.layerNames.includes(name)) { flash(`Layer "${name}" already exists`); return; }
  doc.layerNames.push(name);
  doc.layerDye.push("none");
  doc.layerRefLum = undefined;
  // Add an empty pixel buffer for this layer to every frame of every clip/facing.
  for (const clip of Object.values(doc.animations)) {
    for (const f of FACINGS) for (const fr of clip.facings[f] ?? []) fr.layers.push(emptyPixels(doc.w, doc.h));
  }
  layerVisible.push(true);
  layerIdx = doc.layerNames.length - 1;
  saveToStorage(); buildLayers(); drawStage();
  flash(`Added layer "${name}"`);
});
$("layer-rename")?.addEventListener("click", () => {
  const cur = doc.layerNames[layerIdx];
  const name = prompt("Rename layer:", cur)?.trim();
  if (!name || name === cur) return;
  doc.layerNames[layerIdx] = name;
  saveToStorage(); buildLayers();
});
$("layer-del")?.addEventListener("click", () => {
  if (doc.layerNames.length <= 1) { flash("Need at least one layer"); return; }
  if (!confirm(`Delete layer "${doc.layerNames[layerIdx]}"? Its pixels are lost.`)) return;
  const li = layerIdx;
  doc.layerNames.splice(li, 1);
  doc.layerDye.splice(li, 1);
  doc.layerRefLum = undefined;
  for (const clip of Object.values(doc.animations)) {
    for (const f of FACINGS) for (const fr of clip.facings[f] ?? []) fr.layers.splice(li, 1);
  }
  layerVisible.splice(li, 1);
  layerIdx = Math.min(layerIdx, doc.layerNames.length - 1);
  saveToStorage(); buildLayers(); drawStage();
});

// Animation clip catalog
function clipCatalog(): readonly string[] {
  if (editingCreature) return CREATURE_CLIPS;
  if (editingObject) return PROP_CLIPS;
  return CHAR_CLIPS;
}

// Clip ops
document.getElementById("clip-add")?.addEventListener("click", () => {
  const have = new Set(listClips(doc));
  const suggest = clipCatalog().filter((c) => !have.has(c))[0] ?? "custom";
  const name = prompt("New animation name (e.g. walk, punch, dance):", suggest)?.trim();
  if (!name) return;
  if (have.has(name)) { flash(`"${name}" already exists`); return; }
  addClip(doc, name);
  saveToStorage(); selectClip(name); flash(`Added animation "${name}"`);
});
document.getElementById("clip-del")?.addEventListener("click", () => {
  if (listClips(doc).length <= 1) { flash("Keep at least one animation"); return; }
  if (!confirm(`Delete animation "${currentClip}"?`)) return;
  deleteClip(doc, currentClip);
  currentClip = doc.defaultClip;
  saveToStorage(); selectClip(currentClip); flash("Animation deleted");
});
document.getElementById("clip-default")?.addEventListener("click", () => {
  doc.defaultClip = currentClip; saveToStorage(); buildTimeline();
  flash(`"${currentClip}" is now the default clip`);
});
document.getElementById("clip-loop")?.addEventListener("change", (e) => {
  curClip().loop = (e.target as HTMLInputElement).checked; saveToStorage();
});

function selectClip(name: string) {
  if (!doc.animations[name]) return;
  currentClip = name;
  frameIdx = 0; previewFrame = 0;
  const fpsEl = document.getElementById("fps") as HTMLInputElement | null;
  if (fpsEl) fpsEl.value = String(curClip().fps);
  const loopEl = document.getElementById("clip-loop") as HTMLInputElement | null;
  if (loopEl) loopEl.checked = curClip().loop;
  buildTimeline(); drawStage();
}

// Doc ops
$("btn-new").addEventListener("click", () => {
  addNewPlayerChar();
});
$("btn-save").addEventListener("click", async () => {
  saveToStorage();
  if (!editingCreature && !editingClothing && !editingObject && !editingNpc) {
    try {
      const paintedDocs: Record<string, SpriteDoc> = {};
      for (const [k, d] of Object.entries(playerSheet.docs)) if (docHasPaint(d)) paintedDocs[k] = d;
      await fetch("/api/save-asset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: "player-sprite.json", data: { version: 2, active: playerSheet.active, docs: paintedDocs } }),
      });
      const activeName = playerSheet.docs[playerSheet.active]?.name ?? playerSheet.active;
      flash(`Characters saved to game ✓ — active: "${activeName}" (reload game)`);
      return;
    } catch { /* fall through */ }
  }
  flash("Saved ✓");
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
    const imported = normalizeLayers(JSON.parse(await file.text()));
    const id = (imported.name || "imported").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `import-${Date.now()}`;
    playerSheet.docs[id] = imported;
    playerSheet.active = id;
    charDoc = imported;
    doc = charDoc;
    facing = "down"; frameIdx = 0; layerIdx = 0;
    layerVisible = doc.layerNames.map(() => true);
    saveToStorage(); refreshAll();
    flash(`Imported "${imported.name || id}" ✓`);
  } catch { flash("Bad file"); }
});

$("btn-char-delete")?.addEventListener("click", () => {
  if (editingNpc || editingCreature || editingClothing || editingObject) return;
  deletePlayerChar(playerSheet.active);
});

$("btn-png").addEventListener("click", () => {
  const clip = curClip();
  const maxFrames = Math.max(...FACINGS.map((f) => clip.facings[f].length));
  const sheet = document.createElement("canvas");
  sheet.width = doc.w * maxFrames;
  sheet.height = doc.h * FACINGS.length;
  const c = sheet.getContext("2d")!;
  FACINGS.forEach((f, row) => {
    clip.facings[f].forEach((frame, col) => {
      const comp = compositeFrame(frame, doc.layerNames.map(() => true), doc.w, doc.h);
      for (let y = 0; y < doc.h; y++) for (let x = 0; x < doc.w; x++) {
        const px = comp[idx(x, y)];
        if (!px) continue;
        c.fillStyle = px;
        c.fillRect(col * doc.w + x, row * doc.h + y, 1, 1);
      }
    });
  });
  sheet.toBlob((b) => b && downloadBlob(b, `${doc.name || "sprite"}-${currentClip}-sheet.png`));
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

// ── Subject grid ──────────────────────────────────────────────────────────────
function buildSubjectGrid() {
  const wrap = $("subject-scroll");
  wrap.innerHTML = "";
  wrap.classList.toggle("single-col", category === "terrain");
  if (category === "characters") buildCharSubjectGrid(wrap);
  else if (category === "creatures") buildCreatureGrid(wrap);
  else if (category === "clothing") buildClothingGrid(wrap);
  else if (category === "objects") buildObjectGrid(wrap);
  else if (category === "items") buildItemGrid(wrap);
  else if (category === "terrain") buildTerrainRows();
}

function buildCharSubjectGrid(wrap: HTMLElement) {
  // ── "New Character" card ──────────────────────────────────────────────────
  const newCard = document.createElement("div");
  newCard.className = "subj-card";
  newCard.style.cursor = "pointer";
  newCard.innerHTML = `<div style="font-size:22px;color:var(--accent);line-height:1.1">+</div><div class="subj-label">New Character</div>`;
  newCard.addEventListener("click", () => addNewPlayerChar());
  wrap.appendChild(newCard);

  // ── Player character cards (one per doc in playerSheet) ──────────────────
  for (const [id, cd] of Object.entries(playerSheet.docs)) {
    const isActive = id === playerSheet.active;
    const isSel = charSubject === id;
    const card = document.createElement("div");
    card.className = "subj-card" + (isSel ? " sel" : "");
    if (isActive && !isSel) card.style.outline = "2px solid var(--gold)";
    const c = document.createElement("canvas");
    c.width = 60; c.height = 78;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e2030";
    cx2.fillRect(0, 0, 60, 78);
    if (docHasPaint(cd)) {
      const frame = cd.animations[cd.defaultClip]?.facings.down?.[0];
      if (frame) {
        const px = compositeFrame(frame, cd.layerNames.map(() => true), cd.w, cd.h);
        const sc = Math.min(Math.floor(60 / cd.w), Math.floor(78 / cd.h));
        const ox = (60 - cd.w * sc) / 2, oy = (78 - cd.h * sc) / 2;
        cx2.save(); cx2.translate(ox, oy);
        paintPixels(cx2, px, sc, cd.w, cd.h);
        cx2.restore();
      }
    } else {
      cx2.fillStyle = "#2a4060";
      cx2.fillRect(22, 12, 16, 16); cx2.fillRect(18, 28, 24, 22);
      cx2.fillRect(18, 50, 9, 18); cx2.fillRect(33, 50, 9, 18);
    }
    if (isActive) {
      cx2.fillStyle = "var(--gold)"; cx2.font = "bold 9px system-ui"; cx2.textAlign = "right";
      cx2.fillText("★", 58, 10);
    }
    const lbl = document.createElement("div");
    lbl.className = "subj-label";
    lbl.textContent = (isActive ? "★ " : "") + (cd.name && cd.name !== "untitled" ? cd.name : id);
    card.appendChild(c); card.appendChild(lbl);
    card.addEventListener("click", () => setCharSubject(id));
    wrap.appendChild(card);
  }

  // NPC cards
  for (const kind of NPC_KINDS) {
    const card = document.createElement("div");
    card.className = "subj-card" + (charSubject === kind ? " sel" : "");
    const c = document.createElement("canvas");
    c.width = 60; c.height = 78;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e2030";
    cx2.fillRect(0, 0, 60, 78);
    const app = npcLooks[kind] ?? (npcLooksData as Record<string, Appearance>)[kind];
    try { drawCharacterPixel(cx2, 30, 62, app, { facing: "down", phase: 0, moving: false }); } catch { /* ignore */ }
    const lbl = document.createElement("div");
    lbl.className = "subj-label";
    lbl.textContent = NPC_DISPLAY[kind] ?? kind;
    card.appendChild(c); card.appendChild(lbl);
    card.addEventListener("click", () => setCharSubject(kind));
    wrap.appendChild(card);
  }
}

function addNewPlayerChar() {
  const name = prompt("New character name:", "character")?.trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `char-${Date.now()}`;
  if (playerSheet.docs[id]) { flash(`"${id}" already exists`); return; }
  playerSheet.docs[id] = newSpriteDoc(name);
  playerSheet.active = id;
  charDoc = playerSheet.docs[id];
  savePlayerSheet();
  setCharSubject(id);
  flash(`Created "${name}" — paint away!`);
}

function deletePlayerChar(id: string) {
  if (!playerSheet.docs[id]) return;
  if (Object.keys(playerSheet.docs).length <= 1) { flash("Keep at least one character"); return; }
  if (!confirm(`Delete character "${playerSheet.docs[id].name || id}"? This cannot be undone.`)) return;
  delete playerSheet.docs[id];
  if (playerSheet.active === id) playerSheet.active = Object.keys(playerSheet.docs)[0];
  charDoc = playerSheet.docs[playerSheet.active];
  savePlayerSheet();
  setCharSubject(playerSheet.active);
  flash("Character deleted");
}

function setCharSubject(id: string) {
  charSubject = id;
  editingCreature = null; editingClothing = null; editingObject = null;
  if (playerSheet.docs[id]) {
    // It's a player character
    editingNpc = null;
    playerSheet.active = id;
    charDoc = playerSheet.docs[id];
    doc = charDoc;
  } else {
    // It's an NPC kind
    editingNpc = id;
    doc = npcDocFor(id);
  }
  currentClip = doc.defaultClip;
  facing = "down"; frameIdx = 0; layerIdx = 0; previewFrame = 0;
  layerVisible = doc.layerNames.map(() => true);
  onionRefPixels = null;
  ($("fps") as HTMLInputElement).value = String(curClip().fps);
  buildSubjectGrid();
  updateUI();
}

function buildCreatureGrid(wrap: HTMLElement) {
  for (const kind of CREATURE_KINDS) {
    const card = document.createElement("div");
    card.className = "subj-card" + (kind === currentCreatureKind ? " sel" : "");
    const c = document.createElement("canvas");
    c.width = 80; c.height = 80;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e2030";
    cx2.fillRect(0, 0, 80, 80);
    cx2.save();
    cx2.translate(40, 52);
    cx2.scale(1.6, 1.6);
    try { drawFullCreature(cx2 as unknown as CanvasRenderingContext2D, kind, 0, 0); } catch { /* ignore */ }
    cx2.restore();
    const painted = creatureSheet.docs[kind] && docHasPaint(creatureSheet.docs[kind]);
    if (painted) {
      cx2.fillStyle = "#ffd54f"; cx2.font = "8px system-ui"; cx2.textAlign = "right";
      cx2.fillText("✎", 78, 10);
    }
    const lbl = document.createElement("div");
    lbl.className = "subj-label";
    lbl.textContent = CREATURE_DISPLAY[kind] ?? kind;
    card.style.cursor = "pointer";
    card.appendChild(c); card.appendChild(lbl);
    card.addEventListener("click", () => selectCreature(kind));
    wrap.appendChild(card);
  }
}

function buildClothingGrid(wrap: HTMLElement) {
  for (const itemId of CLOTHING_ITEMS) {
    const card = document.createElement("div");
    card.className = "subj-card" + (itemId === currentClothingId ? " sel" : "");
    const c = document.createElement("canvas");
    c.width = 60; c.height = 78;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e1e2c";
    cx2.fillRect(0, 0, 60, 78);
    const d = clothingSheet.docs[itemId];
    if (d && docHasPaint(d)) {
      const frame = d.animations[d.defaultClip]?.facings.down?.[0];
      if (frame) {
        const px = compositeFrame(frame, d.layerNames.map(() => true), d.w, d.h);
        paintPixels(cx2, px, 3, d.w, d.h);
      }
      cx2.fillStyle = "#ffd54f"; cx2.font = "8px system-ui"; cx2.textAlign = "right";
      cx2.fillText("✎", 58, 10);
    }
    const lbl = document.createElement("div");
    lbl.className = "subj-label";
    lbl.textContent = CLOTHING_DISPLAY[itemId] ?? itemId;
    card.style.cursor = "pointer";
    card.appendChild(c); card.appendChild(lbl);
    card.addEventListener("click", () => selectClothing(itemId));
    wrap.appendChild(card);
  }
}

function buildObjectGrid(wrap: HTMLElement) {
  for (const kind of OBJECT_KINDS) {
    const card = document.createElement("div");
    card.className = "subj-card" + (kind === currentObjectId ? " sel" : "");
    const c = document.createElement("canvas");
    c.width = 72; c.height = 72;
    const cx2 = c.getContext("2d")!;
    cx2.fillStyle = "#0e2030";
    cx2.fillRect(0, 0, 72, 72);
    const d = objectSheet.docs[kind];
    if (d && docHasPaint(d)) {
      const scale = Math.floor(72 / Math.max(d.w, d.h));
      const frame = d.animations[d.defaultClip]?.facings.down?.[0];
      if (frame) {
        const px = compositeFrame(frame, d.layerNames.map(() => true), d.w, d.h);
        cx2.save(); cx2.translate((72 - d.w * scale) / 2, (72 - d.h * scale) / 2);
        paintPixels(cx2, px, scale, d.w, d.h);
        cx2.restore();
      }
      cx2.fillStyle = "#ffd54f"; cx2.font = "8px system-ui"; cx2.textAlign = "right";
      cx2.fillText("✎", 70, 10);
    }
    const lbl = document.createElement("div");
    lbl.className = "subj-label";
    lbl.textContent = OBJECT_DISPLAY[kind] ?? kind;
    card.style.cursor = "pointer";
    card.appendChild(c); card.appendChild(lbl);
    card.addEventListener("click", () => selectObject(kind));
    wrap.appendChild(card);
  }
}

function buildItemGrid(wrap: HTMLElement) {
  for (const [id, pixels] of Object.entries(itemSheet.icons)) {
    const c = document.createElement("canvas");
    c.className = "iicon" + (id === currentItemId ? " sel" : "");
    c.width = ITEM_SIZE; c.height = ITEM_SIZE;
    c.title = id;
    const cx2 = c.getContext("2d")!;
    for (let i = 0; i < pixels.length; i++) {
      const col = pixels[i];
      if (!col) continue;
      cx2.fillStyle = col;
      cx2.fillRect(i % ITEM_SIZE, i / ITEM_SIZE | 0, 1, 1);
    }
    c.addEventListener("click", () => selectItem(id));
    wrap.appendChild(c);
  }
}

function selectItem(id: string) {
  currentItemId = id;
  itemPixels = [...(itemSheet.icons[id] ?? Array(ITEM_SIZE * ITEM_SIZE).fill(""))];
  const nameEl = document.getElementById("item-name");
  if (nameEl) nameEl.textContent = id;
  const infoEl = document.getElementById("item-info");
  if (infoEl) infoEl.textContent = `Editing: ${id}  (${ITEM_SIZE}×${ITEM_SIZE})`;
  for (const c of document.querySelectorAll<HTMLElement>(".iicon"))
    c.classList.toggle("sel", c.title === id);
  sizeStage();
  drawStage();
}

// ── NPC editor ────────────────────────────────────────────────────────────────
// ── Creature editor ────────────────────────────────────────────────────────────
function selectCreature(kind: string) {
  currentCreatureKind = kind;
  charSubject = "player"; // reset char subject since we're in creatures category
  editingCreature = kind; editingClothing = null; editingObject = null; editingNpc = null;
  onionRefPixels = null;
  doc = creatureDocFor(kind);
  // Seed the canvas from the built-in vector art so the creature is visible and
  // immediately paintable, instead of opening to a blank grid.
  if (!docHasPaint(doc)) {
    const bodyIdx = Math.max(0, doc.layerNames.indexOf("body"));
    for (const f of FACINGS) {
      const px = rasterizeCreatureToPixels(kind, doc.w, doc.h);
      const frame = doc.animations[doc.defaultClip].facings[f]?.[0];
      if (frame) frame.layers[bodyIdx] = px;
    }
    saveToStorage();
  }
  currentClip = doc.defaultClip;
  facing = "down"; frameIdx = 0; layerIdx = 0; previewFrame = 0;
  layerVisible = doc.layerNames.map(() => true);
  buildSubjectGrid();
  updateUI();
}

function rasterizeCurrentCreature() {
  if (!editingCreature) return;
  const px = rasterizeCreatureToPixels(editingCreature, doc.w, doc.h);
  const bodyIdx = Math.max(0, doc.layerNames.indexOf("body"));
  curFrame().layers[bodyIdx] = px;
  saveToStorage();
  buildSubjectGrid(); drawStage();
  flash(`Rasterized ${CREATURE_DISPLAY[editingCreature] ?? editingCreature} from vector art ✓`);
}

// ── Clothing editor ────────────────────────────────────────────────────────────
function getBodyRefPixels(): string[] {
  return renderFrame(charDoc, charDoc.defaultClip, facing, 0, {});
}

function selectClothing(itemId: string) {
  currentClothingId = itemId;
  editingClothing = itemId; editingCreature = null; editingObject = null;
  doc = clothingDocFor(itemId);
  currentClip = doc.defaultClip;
  facing = "down"; frameIdx = 0; layerIdx = 0; previewFrame = 0;
  layerVisible = doc.layerNames.map(() => true);
  onionRefPixels = getBodyRefPixels();
  buildSubjectGrid();
  updateUI();
}

// ── Object editor ─────────────────────────────────────────────────────────────
function selectObject(kind: string) {
  currentObjectId = kind;
  editingObject = kind; editingCreature = null; editingClothing = null;
  onionRefPixels = null;
  doc = objectDocFor(kind);
  currentClip = doc.defaultClip;
  facing = "down"; frameIdx = 0; layerIdx = 0; previewFrame = 0;
  layerVisible = doc.layerNames.map(() => true);
  buildSubjectGrid();
  updateUI();
}

// ── updateUI ─────────────────────────────────────────────────────────────────
function updateUI() {
  const isPaint = isSpriteMode();
  const isItem = category === "items";
  const isTerrain = category === "terrain";
  const isNPC = category === "characters" && !!editingNpc;
  if (isNPC) populateNpcCopySelect();

  // Header ops
  show("paint-ops",           isPaint && !isNPC,                                "flex");
  show("item-ops",            isItem,                                           "flex");
  show("terrain-ops",         isTerrain,                                        "flex");
  show("npc-ops",             isNPC,                                            "flex");
  show("creature-extra-ops",  category === "creatures" && !!editingCreature,    "flex");
  show("clothing-ops",        category === "clothing",                          "flex");
  show("objects-ops",         category === "objects",                           "flex");

  // Left sidebar
  show("tools-group",         isPaint || isItem);
  show("palette-group",       isPaint || isItem);
  show("canvas-options",      isPaint || isItem);

  // Center canvas
  ($("stage") as HTMLElement).style.display = (isPaint || isItem) ? "" : "none";
  show("item-preview-wrap",   isItem);
  show("canvas-placeholder",  !isPaint && !isItem);
  show("npc-stage-wrap",      false,     "flex");
  show("terrain-stage-wrap",  false,     "flex");

  // Timeline
  show("timeline", isPaint);

  // Right sidebar
  show("preview-group",        isPaint);
  show("npc-app-group",        false);
  show("layers-group",         isPaint);
  show("dye-group",            isPaint);
  show("canvas-options-group", isPaint || isItem);

  // Update preview label
  const lbl = document.getElementById("preview-label");
  if (lbl) {
    if (category === "creatures") lbl.textContent = "Creature";
    else if (category === "clothing") lbl.textContent = "Clothing";
    else if (category === "objects") lbl.textContent = "Object";
    else lbl.textContent = "Preview";
  }

  // Update subject title
  const titleEl = document.getElementById("subject-title");
  if (titleEl) {
    if (editingTerrainTile) titleEl.textContent = TERRAIN_TILE_LABELS[editingTerrainTile] ?? editingTerrainTile;
    else if (editingCreature) titleEl.textContent = CREATURE_DISPLAY[editingCreature] ?? editingCreature;
    else if (editingClothing) titleEl.textContent = CLOTHING_DISPLAY[editingClothing] ?? editingClothing;
    else if (editingObject) titleEl.textContent = OBJECT_DISPLAY[editingObject] ?? editingObject;
    else if (isNPC) titleEl.textContent = NPC_DISPLAY[charSubject] ?? charSubject;
    else if (isPaint) titleEl.textContent = doc.name;
    else titleEl.textContent = "";
  }

  // Delete char button: only relevant when editing a player character (not creature/clothing/etc.)
  const isPlayerChar = !editingCreature && !editingClothing && !editingObject && !editingNpc && category === "characters";
  const delBtn = document.getElementById("btn-char-delete") as HTMLButtonElement | null;
  if (delBtn) delBtn.style.display = (isPlayerChar && Object.keys(playerSheet.docs).length > 1) ? "" : "none";

  // Sync docname input with current doc name
  const docnameEl = document.getElementById("docname") as HTMLInputElement | null;
  if (docnameEl && isPaint) docnameEl.value = doc.name ?? "";

  if (isPaint) { sizeStage(); buildTimeline(); buildLayers(); buildDyeRows(); drawStage(); }
  else if (isItem) { sizeStage(); drawStage(); buildDyeRows(); }
  else if (isTerrain) { renderTerrainPreview(); }
}

// ── Category switching ────────────────────────────────────────────────────────
function setCategory(c: Category) {
  category = c;
  ($("category-select") as unknown as HTMLSelectElement).value = c;

  if (c !== "creatures" && c !== "clothing" && c !== "objects") {
    if (editingCreature || editingClothing || editingObject) {
      editingCreature = null; editingClothing = null; editingObject = null;
      doc = charDoc;
      currentClip = doc.defaultClip;
      layerVisible = doc.layerNames.map(() => true);
    }
  }
  if (c !== "characters") editingNpc = null;
  if (c !== "terrain") editingTerrainTile = null;

  buildSubjectGrid();

  if (c === "characters") {
    const validSubject = playerSheet.docs[charSubject] || NPC_KINDS.includes(charSubject as NpcKind) ? charSubject : playerSheet.active;
    setCharSubject(validSubject);
  } else if (c === "creatures") {
    selectCreature(currentCreatureKind || CREATURE_KINDS[0]);
  } else if (c === "clothing") {
    selectClothing(currentClothingId || CLOTHING_ITEMS[0]);
  } else if (c === "objects") {
    selectObject(currentObjectId || OBJECT_KINDS[0]);
  } else if (c === "items") {
    updateUI();
    if (!currentItemId && Object.keys(itemSheet.icons).length > 0) selectItem(Object.keys(itemSheet.icons)[0]);
    else if (currentItemId) { sizeStage(); drawStage(); }
  } else if (c === "terrain") {
    // Auto-open the first tile so the pixel editor appears immediately,
    // same as characters/creatures always auto-select something.
    const firstTile = editingTerrainTile ?? TERRAIN_TILE_TYPES[0];
    selectTerrainTile(firstTile);
  }
}

($("category-select") as unknown as HTMLSelectElement).addEventListener("change", (e) => {
  setCategory((e.target as HTMLSelectElement).value as Category);
});

// ── Creature sprite: rasterize / clear / save ──────────────────────────────────
$("btn-creature-raster")?.addEventListener("click", () => rasterizeCurrentCreature());
$("btn-creature-clear")?.addEventListener("click", () => {
  if (!editingCreature) return;
  if (!confirm(`Clear ${CREATURE_DISPLAY[editingCreature] ?? editingCreature}'s sprite? It reverts to the built-in art.`)) return;
  delete creatureSheet.docs[editingCreature];
  saveCreatureSheet();
  selectCreature(editingCreature);
  flash("Creature sprite cleared ✓");
});
$("btn-creature-save")?.addEventListener("click", async () => {
  const out: CreatureSheet = { version: creatureSheet.version, w: creatureSheet.w, h: creatureSheet.h, layers: creatureSheet.layers, docs: {} };
  for (const [k, d] of Object.entries(creatureSheet.docs)) if (docHasPaint(d)) out.docs[k] = d;
  saveCreatureSheet();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "creature-sprites.json", data: out }),
    });
    flash("Creature sprites saved to game ✓");
  } catch { flash("Creature sprites saved (localStorage only)"); }
});

// ── Clothing: clear / save ────────────────────────────────────────────────────
$("btn-clothing-clear")?.addEventListener("click", () => {
  if (!editingClothing) return;
  if (!confirm(`Clear ${CLOTHING_DISPLAY[editingClothing] ?? editingClothing}'s sprite?`)) return;
  delete clothingSheet.docs[editingClothing];
  saveClothingSheet();
  selectClothing(editingClothing);
  flash("Clothing sprite cleared ✓");
});
$("btn-clothing-save")?.addEventListener("click", async () => {
  const out: ClothingSheet = { version: 1, docs: {} };
  for (const [k, d] of Object.entries(clothingSheet.docs)) if (docHasPaint(d)) out.docs[k] = d;
  saveClothingSheet();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "clothing-sprites.json", data: out }),
    });
    flash("Clothing sprites saved to game ✓");
  } catch { flash("Clothing sprites saved (localStorage only)"); }
});

// ── Objects: clear / save ─────────────────────────────────────────────────────
$("btn-object-clear")?.addEventListener("click", () => {
  if (!editingObject) return;
  if (!confirm(`Clear ${OBJECT_DISPLAY[editingObject] ?? editingObject}'s sprite?`)) return;
  delete objectSheet.docs[editingObject];
  saveObjectSheet();
  selectObject(editingObject);
  flash("Object sprite cleared ✓");
});
$("btn-objects-save")?.addEventListener("click", async () => {
  const out: ObjectSheet = { version: 1, docs: {} };
  for (const [k, d] of Object.entries(objectSheet.docs)) if (docHasPaint(d)) out.docs[k] = d;
  saveObjectSheet();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "object-sprites.json", data: out }),
    });
    flash("Object sprites saved to game ✓");
  } catch { flash("Object sprites saved (localStorage only)"); }
});

// ── Item save / export / import ───────────────────────────────────────────────
$("btn-item-save").addEventListener("click", async () => {
  if (!currentItemId) return flash("Select an item first");
  itemSheet.icons[currentItemId] = [...itemPixels];
  saveItemSheet();
  buildSubjectGrid();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "item-sprites.json", data: itemSheet }),
    });
    flash(`Saved ${currentItemId} to game ✓`);
  } catch {
    flash(`Saved icon: ${currentItemId} (localStorage only)`);
  }
});

$("btn-item-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(itemSheet, null, 2)], { type: "application/json" });
  downloadBlob(blob, "item-sprites.json");
  flash("Exported item-sprites.json ✓");
});

$("btn-item-import").addEventListener("click", () => $<HTMLInputElement>("file-item-import").click());
$<HTMLInputElement>("file-item-import").addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    itemSheet = JSON.parse(await file.text()) as ItemSheet;
    saveItemSheet();
    currentItemId = "";
    buildSubjectGrid();
    if (Object.keys(itemSheet.icons).length > 0) selectItem(Object.keys(itemSheet.icons)[0]);
    flash("Item sprites imported ✓");
  } catch { flash("Bad item-sprites.json file"); }
});

// ── NPC save / reset ──────────────────────────────────────────────────────────
$("btn-npc-save").addEventListener("click", async () => {
  const out: NpcSheet = { version: 1, docs: {} };
  for (const [k, d] of Object.entries(npcSheet.docs)) if (docHasPaint(d)) out.docs[k] = d;
  saveNpcSheet();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "npc-sprites.json", data: out }),
    });
    flash("NPC sprites saved to game ✓");
  } catch {
    flash("NPC sprites saved (localStorage only)");
  }
});

$("btn-npc-reset").addEventListener("click", () => {
  if (!editingNpc) return;
  if (!confirm(`Reseed ${NPC_DISPLAY[editingNpc] ?? editingNpc} from the procedural art? Repainting is lost.`)) return;
  npcSheet.docs[editingNpc] = seedNpcDoc(editingNpc);
  saveNpcSheet();
  setCharSubject(editingNpc);
  flash("Reseeded from procedural art ✓");
});

// Copy a saved player character into the current NPC slot
$("btn-npc-copy-char")?.addEventListener("click", () => {
  if (!editingNpc) return;
  const sel = document.getElementById("npc-copy-char-sel") as HTMLSelectElement | null;
  const srcId = sel?.value;
  if (!srcId || !playerSheet.docs[srcId]) { flash("Select a character first"); return; }
  const src = playerSheet.docs[srcId];
  npcSheet.docs[editingNpc] = JSON.parse(JSON.stringify(src)) as SpriteDoc;
  npcSheet.docs[editingNpc].name = NPC_DISPLAY[editingNpc] ?? editingNpc;
  saveNpcSheet();
  setCharSubject(editingNpc);
  flash(`Copied "${src.name || srcId}" into ${NPC_DISPLAY[editingNpc] ?? editingNpc} ✓`);
});

function populateNpcCopySelect() {
  const sel = document.getElementById("npc-copy-char-sel") as HTMLSelectElement | null;
  if (!sel) return;
  sel.innerHTML = "";
  for (const [id, cd] of Object.entries(playerSheet.docs)) {
    const opt = document.createElement("option");
    opt.value = id; opt.textContent = cd.name || id;
    sel.appendChild(opt);
  }
}

// ── Terrain ──────────────────────────────────────────────────────────────────
const terrainCanvas = $<HTMLCanvasElement>("terrain-preview");
const terrainPctx = terrainCanvas?.getContext("2d");

// Draw one terrain tile-card thumbnail: painted pixels if present, else the
// flat fallback colour, with a painted (✎) / unpainted (○) badge.
function drawTerrainCardCanvas(c: HTMLCanvasElement, tileKey: string) {
  const cx2 = c.getContext("2d")!;
  cx2.clearRect(0, 0, 60, 60);
  cx2.fillStyle = terrainSettings.colors[tileKey] ?? TERRAIN_DEFAULTS[tileKey] ?? "#888";
  cx2.fillRect(0, 0, 60, 60);
  const d = terrainSpriteSheet.docs[tileKey];
  let painted = false;
  if (d && docHasPaint(d)) {
    const scale = Math.floor(60 / Math.max(d.w, d.h));
    const frame = d.animations[d.defaultClip]?.facings.down?.[0];
    if (frame) {
      const px = compositeFrame(frame, d.layerNames.map(() => true), d.w, d.h);
      cx2.save(); cx2.translate((60 - d.w * scale) / 2, (60 - d.h * scale) / 2);
      paintPixels(cx2, px, scale, d.w, d.h);
      cx2.restore();
      painted = true;
    }
  }
  cx2.font = "9px system-ui"; cx2.textAlign = "right";
  cx2.fillStyle = painted ? "#ffd54f" : "rgba(255,255,255,.5)";
  cx2.fillText(painted ? "✎" : "○", 58, 11);
}

// Live-update the selected tile's sidebar thumbnail after painting, without
// rebuilding the whole grid (which would reset scroll / selection).
function refreshTerrainCard() {
  if (!editingTerrainTile) return;
  const card = document.querySelector(`#subject-scroll .subj-card[data-tile="${editingTerrainTile}"]`);
  const c = card?.querySelector("canvas") as HTMLCanvasElement | null;
  if (c) drawTerrainCardCanvas(c, editingTerrainTile);
}

function buildTerrainRows() {
  // For terrain category, terrain rows go in subject-scroll
  const wrap = $("subject-scroll");
  wrap.innerHTML = "";

  // ── Pixel tile sprites (PRIMARY) ──────────────────────────────────────────
  // Click a tile to open the full pixel editor and paint its 24×24 art.
  const hdr = document.createElement("div");
  hdr.style.cssText = "margin:2px 0 6px;font-size:11px;font-weight:600;color:var(--fg)";
  hdr.textContent = "Paint a tile (click to edit pixels)";
  wrap.appendChild(hdr);

  const grid = document.createElement("div");
  grid.style.cssText = "display:grid;grid-template-columns:repeat(2,1fr);gap:6px";
  for (const tileKey of TERRAIN_TILE_TYPES) {
    const card = document.createElement("div");
    card.className = "subj-card" + (tileKey === editingTerrainTile ? " sel" : "");
    card.dataset.tile = tileKey;
    const c = document.createElement("canvas");
    c.width = 60; c.height = 60;
    drawTerrainCardCanvas(c, tileKey);
    const lbl2 = document.createElement("div");
    lbl2.className = "subj-label";
    lbl2.textContent = TERRAIN_TILE_LABELS[tileKey] ?? tileKey;
    card.style.cursor = "pointer";
    card.appendChild(c); card.appendChild(lbl2);
    card.addEventListener("click", () => selectTerrainTile(tileKey));
    grid.appendChild(card);
  }
  wrap.appendChild(grid);

  // ── Fallback colours (SECONDARY) ──────────────────────────────────────────
  // For tiles you haven't painted yet, the game uses these flat colours.
  const sep = document.createElement("div");
  sep.style.cssText = "margin:14px 0 4px;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em";
  sep.textContent = "Fallback colours (used until painted)";
  wrap.appendChild(sep);

  for (const [key, label] of Object.entries(TERRAIN_LABELS)) {
    const row = document.createElement("div");
    row.className = "terrain-row";
    const swatch = document.createElement("div");
    swatch.className = "tswatch";
    swatch.style.background = terrainSettings.colors[key] ?? TERRAIN_DEFAULTS[key] ?? "#888";
    const lbl = document.createElement("span");
    lbl.className = "tlabel";
    lbl.textContent = label;
    const inp = document.createElement("input");
    inp.type = "color";
    inp.value = terrainSettings.colors[key] ?? TERRAIN_DEFAULTS[key] ?? "#888888";
    inp.addEventListener("input", () => {
      terrainSettings.colors[key] = inp.value;
      swatch.style.background = inp.value;
      renderTerrainPreview();
    });
    row.appendChild(swatch); row.appendChild(lbl); row.appendChild(inp);
    wrap.appendChild(row);
  }

  renderTerrainPreview();
}

// Terrain texture helpers
function editorTileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 1234567891) | 0;
  h ^= h >>> 13; h = Math.imul(h, 1540483477); h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}

function drawTerrainGrass(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number) {
  const h1 = editorTileHash(tx, ty);
  const h2 = editorTileHash(tx + 97, ty + 13);
  const h3 = editorTileHash(tx * 3 + 1, ty * 5 + 7);
  const patchCount = 2 + (h1 * 3 | 0);
  for (let i = 0; i < patchCount; i++) {
    const ph  = editorTileHash(tx + i * 17, ty + i * 11);
    const ph2 = editorTileHash(tx + i * 13 + 5, ty * 3 + i);
    ctx.fillStyle = i % 3 === 0 ? "#7aab34" : i % 3 === 1 ? "#96c83c" : "#6a9828";
    ctx.fillRect(sx + (ph * (T - 3) | 0), sy + (ph2 * (T - 3) | 0), 2, 2);
  }
  const bladeCount = 2 + (h1 > 0.45 ? 1 : 0);
  for (let i = 0; i < bladeCount; i++) {
    const bh  = editorTileHash(tx * 7 + i * 3, ty + i * 11);
    const bh2 = editorTileHash(tx + i * 13,    ty * 5 + i * 7);
    const bh3 = editorTileHash(tx + i * 23,    ty * 11 + i * 5);
    const gx  = sx + 2 + (bh  * (T - 6) | 0);
    const gy  = sy + 5 + (bh2 * (T - 9) | 0);
    const lean = (bh3 > 0.5 ? 1 : -1);
    const bladeH = 3 + (bh3 * 2 | 0);
    ctx.fillStyle = "#3a5c1e";
    ctx.fillRect(gx,     gy,     1, bladeH);
    ctx.fillStyle = "#5a8c28";
    ctx.fillRect(gx + 1, gy,     1, bladeH);
    ctx.fillStyle = "#8ac838";
    ctx.fillRect(gx + 1 + lean, gy - 1, 1, 1);
  }
  if (h3 < 0.12) {
    const stx = sx + 2 + (h1 * (T - 7) | 0);
    const sty = sy + 4 + (h2 * (T - 7) | 0);
    ctx.fillStyle = "#b0a880"; ctx.fillRect(stx, sty, 4, 2);
  }
}

function drawTerrainForest(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number) {
  const h1 = editorTileHash(tx, ty);
  const h2 = editorTileHash(tx + 31, ty + 71);
  const h3 = editorTileHash(tx * 5, ty * 3 + 17);
  const h4 = editorTileHash(tx * 9 + 17, ty * 3 + 41);
  const patchCount = 2 + (h4 * 3 | 0);
  for (let i = 0; i < patchCount; i++) {
    const ph  = editorTileHash(tx + i * 19, ty + i * 13);
    const ph2 = editorTileHash(tx * 3 + i * 7, ty + i);
    ctx.fillStyle = i % 3 === 0 ? "#1e3016" : i % 3 === 1 ? "#2a3e1c" : "#223418";
    ctx.fillRect(sx + (ph * (T - 3) | 0), sy + (ph2 * (T - 3) | 0), 3, 3);
  }
  if (h1 > 0.42) {
    ctx.fillStyle = "#5a8e32";
    const lx = sx + 2 + (h2 * (T - 8) | 0);
    const ly = sy + 2 + (h3 * (T - 8) | 0);
    ctx.fillRect(lx, ly, 5, 4);
    ctx.fillStyle = "#70a840"; ctx.fillRect(lx + 1, ly, 3, 2);
  }
  if (h2 < 0.35) {
    ctx.fillStyle = "#3a2a14";
    const rx = sx + (h1 * (T * 0.4) | 0);
    const ry = sy + T - 5;
    ctx.fillRect(rx, ry, 1, 4);
    ctx.fillRect(rx + 1, ry + 1, 3, 1);
  }
}

function drawTerrainSand(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number) {
  const h1 = editorTileHash(tx, ty);
  const h2 = editorTileHash(tx + 17, ty + 43);
  ctx.strokeStyle = "#b0984a"; ctx.lineWidth = 1;
  for (let i = 0; i < 2; i++) {
    const wy = sy + 4 + (editorTileHash(tx + i, ty + i * 7) * (T - 8) | 0);
    ctx.beginPath(); ctx.moveTo(sx + 1, wy);
    ctx.quadraticCurveTo(sx + T * 0.35, wy - 1, sx + T * 0.65, wy + 1);
    ctx.quadraticCurveTo(sx + T * 0.82, wy + 1, sx + T - 1, wy);
    ctx.stroke();
  }
  if (h2 > 0.8) { ctx.fillStyle = "#ece8d0"; ctx.fillRect(sx + (h1 * (T - 4) | 0), sy + (h2 * (T - 4) | 0), 2, 1); }
}

function drawTerrainRock(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number) {
  const h1 = editorTileHash(tx, ty);
  const h2 = editorTileHash(tx + 19, ty + 83);
  ctx.fillStyle = "#585048";
  ctx.fillRect(sx + (h1 * (T - 10) | 0), sy + T - 6, 8, 5);
  ctx.fillStyle = "#b0a898";
  ctx.fillRect(sx + 2, sy + 2, T - 4, 2);
  ctx.strokeStyle = "#484038"; ctx.lineWidth = 1;
  ctx.beginPath();
  const cx2 = sx + 3 + (h1 * (T - 8) | 0);
  const cy2 = sy + 5 + (h2 * (T - 12) | 0);
  ctx.moveTo(cx2, cy2); ctx.lineTo(cx2 + 3, cy2 + 4); ctx.lineTo(cx2 + 2, cy2 + 7); ctx.stroke();
}

function drawTerrainWater(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number, col: string) {
  const r1 = parseInt(col.slice(1, 3), 16);
  const g1 = parseInt(col.slice(3, 5), 16);
  const b1 = parseInt(col.slice(5, 7), 16);
  const now = performance.now() / 1000;
  const p1 = (now * 0.9 + tx * 0.6 + ty * 0.8) % 1;
  const row1 = sy + (p1 * T | 0);
  const w1 = 5 + (editorTileHash(tx * 7, ty * 3) * 8 | 0);
  const x1 = sx + 1 + (editorTileHash(tx + 1, ty) * (T - w1 - 2) | 0);
  ctx.fillStyle = `rgba(${Math.min(255, r1 + 80)},${Math.min(255, g1 + 80)},${Math.min(255, b1 + 80)},0.65)`;
  ctx.fillRect(x1, row1, w1, 1);
}

function drawTerrainRoad(ctx: CanvasRenderingContext2D, sx: number, sy: number, tx: number, ty: number, T: number) {
  ctx.fillStyle = "#3e3028";
  ctx.fillRect(sx + 2, sy + (T * 0.3 | 0), T - 4, 1);
  ctx.fillRect(sx + 2, sy + (T * 0.7 | 0), T - 4, 1);
  ctx.fillStyle = "#706558";
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(sx + (editorTileHash(tx + i, ty + i * 3) * (T - 2) | 0), sy + (editorTileHash(tx + i * 5, ty + i) * (T - 2) | 0), 1, 1);
  }
}

function renderTerrainPreview() {
  if (!terrainPctx) return;
  const c = terrainCanvas;
  terrainPctx.clearRect(0, 0, c.width, c.height);
  const keys = Object.keys(TERRAIN_LABELS);
  const T = 64;
  for (let i = 0; i < Math.min(9, keys.length); i++) {
    const key = keys[i];
    const col = terrainSettings.colors[key] ?? "#888";
    const sx = (i % 3) * T;
    const sy = Math.floor(i / 3) * T;
    const tx = i % 3;
    const ty = Math.floor(i / 3);
    terrainPctx.fillStyle = col;
    terrainPctx.fillRect(sx, sy, T, T);
    if (key === "grass") drawTerrainGrass(terrainPctx, sx, sy, tx, ty, T);
    else if (key === "forest") drawTerrainForest(terrainPctx, sx, sy, tx, ty, T);
    else if (key === "sand") drawTerrainSand(terrainPctx, sx, sy, tx, ty, T);
    else if (key === "rock") drawTerrainRock(terrainPctx, sx, sy, tx, ty, T);
    else if (key === "hill") drawTerrainRock(terrainPctx, sx, sy, tx, ty, T);
    else if (key === "water" || key === "freshwater") drawTerrainWater(terrainPctx, sx, sy, tx, ty, T, col);
    else if (key === "road") drawTerrainRoad(terrainPctx, sx, sy, tx, ty, T);
    terrainPctx.font = "bold 9px system-ui";
    terrainPctx.fillStyle = "rgba(0,0,0,0.6)";
    terrainPctx.fillText(TERRAIN_LABELS[key], sx + 3, sy + 11);
  }
}

$("btn-terrain-save")?.addEventListener("click", async () => {
  saveTerrainSettings();
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "terrain-settings.json", data: terrainSettings }),
    });
    flash("Terrain colours saved to game ✓");
  } catch { flash("Terrain saved (localStorage only)"); }
});

$("btn-terrain-reset")?.addEventListener("click", () => {
  terrainSettings = { colors: { ...TERRAIN_DEFAULTS } };
  saveTerrainSettings();
  buildSubjectGrid();
  flash("Terrain reset to defaults ✓");
});

$("btn-terrain-sprites-save")?.addEventListener("click", async () => {
  saveTerrainSpriteSheet();
  const out: TerrainSpriteSheet = { version: 1, tileSize: terrainSpriteSheet.tileSize, docs: {} };
  for (const [k, d] of Object.entries(terrainSpriteSheet.docs)) if (docHasPaint(d)) out.docs[k] = d;
  try {
    await fetch("/api/save-asset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "terrain-sprites.json", data: out }),
    });
    flash("Terrain sprites saved to game ✓");
  } catch { flash("Terrain sprites saved (localStorage only)"); }
});

// ── New sprite creation ────────────────────────────────────────────────────────
$("btn-new-sprite")?.addEventListener("click", () => {
  const name = ($<HTMLInputElement>("new-sprite-name")).value.trim();
  if (!name) return flash("Enter a sprite file name first");
  const cat = ($("new-sprite-category") as unknown as HTMLSelectElement).value;
  if (cat === "items") {
    if (itemSheet.icons[name]) return flash(`Item "${name}" already exists — select it in the Items tab`);
    itemSheet.icons[name] = Array(ITEM_SIZE * ITEM_SIZE).fill("");
    saveItemSheet();
    flash(`Created item icon "${name}" ✓ — switch to Items to paint it`);
  } else {
    doc = newSpriteDoc(name);
    layerVisible = doc.layerNames.map(() => true);
    saveToStorage();
    flash(`Created character sprite "${name}" ✓`);
    setCategory("characters");
  }
  ($<HTMLInputElement>("new-sprite-name")).value = "";
});

// ── PixelLab PNG importer ─────────────────────────────────────────────────────

// PixelLab direction name → our Facing
const PL_NAME_TO_FACING: Record<string, Facing> = {
  "south": "down", "south-east": "downright", "east": "right", "north-east": "upright",
  "north": "up", "north-west": "upleft", "west": "left", "south-west": "downleft",
  // fallback: numeric order 0-7
  "0": "down", "1": "downright", "2": "right", "3": "upright",
  "4": "up", "5": "upleft", "6": "left", "7": "downleft",
};
// Also used for sprite-sheet ordering
const PL_FACING_MAP: Facing[] = [
  "down", "downright", "right", "upright", "up", "upleft", "left", "downleft",
];

// State for 8-png mode
const pli8Bitmaps = new Map<Facing, ImageBitmap>(); // facing → loaded bitmap
let pli8W = 0, pli8H = 0;

// State for sheet mode
let pliSheetBitmap: ImageBitmap | null = null;
let pliSheetW = 0, pliSheetH = 0;

// Active mode: "8png" | "sheet"
let pliMode: "8png" | "sheet" = "8png";

function pliGetEl<T extends HTMLElement>(id: string) { return document.getElementById(id) as T; }
function pliNum(id: string) { return parseInt((pliGetEl<HTMLInputElement>(id)).value) || 0; }
function pliStr(id: string) { return (pliGetEl<HTMLInputElement>(id)).value.trim(); }

/** Try to derive a Facing from a filename. */
function pliFilenameToFacing(name: string): Facing | null {
  const base = name.toLowerCase().replace(/\.[^.]+$/, ""); // strip extension
  if (PL_NAME_TO_FACING[base]) return PL_NAME_TO_FACING[base];
  // partial match — e.g. "char_south-east_idle" contains "south-east"
  for (const [key, facing] of Object.entries(PL_NAME_TO_FACING)) {
    if (base.includes(key)) return facing;
  }
  return null;
}

/** Extract a w×h block from a canvas context as hex pixel array. */
function pliExtractPixels(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string[] {
  const d = ctx.getImageData(x, y, w, h).data;
  const out: string[] = new Array(w * h).fill("");
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] < 10) continue;
    const r = d[i * 4].toString(16).padStart(2, "0");
    const g = d[i * 4 + 1].toString(16).padStart(2, "0");
    const b = d[i * 4 + 2].toString(16).padStart(2, "0");
    out[i] = `#${r}${g}${b}`;
  }
  return out;
}

/** Finalise import: build SpriteDoc from the facing→pixels map and load into editor. */
function pliFinishImport(
  facingPixels: Map<Facing, string[][]>, // facing → [frame0pixels, frame1pixels, ...]
  fw: number, fh: number,
  name: string, clipName: string,
) {
  const newDoc = newSpriteDoc(name, fw, fh,
    ["skin", "hair", "shirt", "pants", "accessory"], DEFAULT_DYES, [clipName]);
  const clip = newDoc.animations[clipName];
  clip.fps = 6; clip.loop = true;

  for (const [f, frames] of facingPixels) {
    clip.facings[f] = frames.map(px => ({
      layers: [px, ...Array.from({ length: 4 }, () => emptyPixels(fw, fh))],
    } as SpriteFrame));
  }
  // Fill any missing facings from nearest neighbour
  for (const f of FACINGS) {
    if (!clip.facings[f] || clip.facings[f].length === 0) {
      const src = clip.facings["down"] ?? clip.facings[FACINGS[0]];
      clip.facings[f] = src.map(fr => ({ layers: fr.layers.map(l => [...l]) }));
    }
  }

  const docId = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `imported-${Date.now()}`;
  playerSheet.docs[docId] = newDoc;
  playerSheet.active = docId;
  charDoc = newDoc;
  doc = charDoc;
  savePlayerSheet();
  currentClip = clipName;
  facing = "down"; frameIdx = 0; layerIdx = 0;
  layerVisible = doc.layerNames.map(() => true);
  ($<HTMLInputElement>("docname")).value = name;
  category = "characters";
  charSubject = docId;
  editingNpc = null;
  ($("category-select") as unknown as HTMLSelectElement).value = "characters";

  pliGetEl("pli-modal").style.display = "none";
  flash(`Imported "${name}" — ${facingPixels.size} facings on skin layer ✓`);
  buildSubjectGrid();
  updateUI();
}

// ── Mode A: 8 individual PNGs ─────────────────────────────────────────────────

const PL_FACING_LABELS = ["S ↓","SE ↘","E →","NE ↗","N ↑","NW ↖","W ←","SW ↙"];

function pli8BuildGrid() {
  const grid = pliGetEl("pli-8-grid");
  grid.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const f = PL_FACING_MAP[i];
    const cell = document.createElement("div");
    cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:3px";
    const lbl = document.createElement("div");
    lbl.style.cssText = "font-size:9px;color:var(--muted)";
    lbl.textContent = PL_FACING_LABELS[i];
    const cv = document.createElement("canvas") as HTMLCanvasElement;
    cv.id = `pli8-cv-${f}`;
    cv.style.cssText = "image-rendering:pixelated;border:1px solid var(--border);background:#0c1820;border-radius:3px";
    const bm = pli8Bitmaps.get(f);
    if (bm) {
      const SCALE = Math.max(1, Math.floor(80 / Math.max(bm.width, bm.height)));
      cv.width = bm.width * SCALE; cv.height = bm.height * SCALE;
      const ctx = cv.getContext("2d")!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bm, 0, 0, cv.width, cv.height);
      cell.style.opacity = "1";
    } else {
      cv.width = 46; cv.height = 46;
      const ctx = cv.getContext("2d")!;
      ctx.fillStyle = "#1a2c38"; ctx.fillRect(0, 0, 46, 46);
      ctx.fillStyle = "#2b5067"; ctx.font = "10px monospace"; ctx.fillText("?", 18, 28);
    }
    cell.appendChild(lbl); cell.appendChild(cv);
    grid.appendChild(cell);
  }
  grid.style.display = "grid";

  const loaded = pli8Bitmaps.size;
  pliGetEl("pli-8-status").textContent = `${loaded}/8 facings loaded${loaded < 8 ? " — select all 8 PNGs at once" : " — ready!"}`;
  (pliGetEl<HTMLButtonElement>("pli-import")).disabled = loaded < 8;
}

$("pli-choose-8")?.addEventListener("click", () => pliGetEl<HTMLInputElement>("pli-file-8").click());

$("pli-file-8")?.addEventListener("change", async (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  if (!files.length) return;

  pli8Bitmaps.clear();
  pli8W = 0; pli8H = 0;

  let matched = 0;
  await Promise.all(files.map(async (file) => {
    const facing = pliFilenameToFacing(file.name);
    if (!facing) return;
    const bm = await createImageBitmap(await file.arrayBuffer().then(b => new Blob([b], { type: file.type })));
    pli8Bitmaps.set(facing, bm);
    pli8W = bm.width; pli8H = bm.height;
    matched++;
  }));

  pliGetEl("pli-8-count").textContent = `${files.length} file(s), ${matched} matched to facings`;

  // Auto-name from first filename (strip direction suffix)
  const base = files[0].name.replace(/\.[^.]+$/, "")
    .replace(/[-_]?(south|north|east|west|se|sw|ne|nw)[-_]?/gi, "")
    .replace(/[-_]+/g, " ").trim();
  if (base) (pliGetEl<HTMLInputElement>("pli-8-name")).value = base;

  pli8BuildGrid();
});

function pli8DoImport() {
  if (pli8Bitmaps.size === 0) return;
  const name = pliStr("pli-8-name") || "imported";
  const clipName = pliStr("pli-8-clip") || "idle";
  const fw = pli8W, fh = pli8H;

  const facingPixels = new Map<Facing, string[][]>();
  for (const [f, bm] of pli8Bitmaps) {
    const canvas = document.createElement("canvas");
    canvas.width = fw; canvas.height = fh;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(bm, 0, 0);
    facingPixels.set(f, [pliExtractPixels(ctx, 0, 0, fw, fh)]);
  }
  pliFinishImport(facingPixels, fw, fh, name, clipName);
}

// ── Mode B: sprite sheet ──────────────────────────────────────────────────────

function pliRedrawSheetPreview() {
  const canvas = pliGetEl<HTMLCanvasElement>("pli-preview");
  if (!pliSheetBitmap) return;
  const fw = pliNum("pli-fw"), fh = pliNum("pli-fh"), nf = pliNum("pli-nf");
  const facingsInRows = (pliGetEl<HTMLInputElement>("pli-axis-rows")).checked;
  const SCALE = Math.max(1, Math.min(4, Math.floor(280 / Math.max(pliSheetW, pliSheetH))));
  canvas.width = pliSheetW * SCALE;
  canvas.height = pliSheetH * SCALE;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pliSheetBitmap, 0, 0, pliSheetW * SCALE, pliSheetH * SCALE);
  if (fw > 0 && fh > 0) {
    for (let fi = 0; fi < 8; fi++) {
      for (let fr = 0; fr < nf; fr++) {
        const col = facingsInRows ? fr : fi;
        const row = facingsInRows ? fi : fr;
        ctx.strokeStyle = fr === 0 ? "rgba(127,255,212,.8)" : "rgba(255,213,79,.5)";
        ctx.lineWidth = 1;
        ctx.strokeRect(col * fw * SCALE + .5, row * fh * SCALE + .5, fw * SCALE - 1, fh * SCALE - 1);
        if (fr === 0 && fw * SCALE >= 14) {
          const lbl = ["S","SE","E","NE","N","NW","W","SW"][fi] ?? "";
          ctx.fillStyle = "rgba(127,255,212,.9)";
          ctx.font = `${Math.max(8, Math.min(12, fw * SCALE / 5))}px monospace`;
          ctx.fillText(lbl, col * fw * SCALE + 2, row * fh * SCALE + 12);
        }
      }
    }
  }
  pliGetEl("pli-status").textContent =
    fw > 0 && fh > 0 ? `${pliSheetW}×${pliSheetH} → ${facingsInRows ? "rows" : "cols"} × ${nf} frame(s) @ ${fw}×${fh}` : "Set frame size";
}

$("pli-choose")?.addEventListener("click", () => pliGetEl<HTMLInputElement>("pli-file").click());

$("pli-file")?.addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  pliGetEl("pli-filename").textContent = file.name;
  pliSheetBitmap = await createImageBitmap(await file.arrayBuffer().then(b => new Blob([b], { type: file.type })));
  pliSheetW = pliSheetBitmap.width; pliSheetH = pliSheetBitmap.height;

  // Auto-guess
  if (pliSheetH >= pliSheetW) {
    (pliGetEl<HTMLInputElement>("pli-axis-rows")).checked = true;
    (pliGetEl<HTMLInputElement>("pli-fw")).value = String(pliSheetW);
    (pliGetEl<HTMLInputElement>("pli-fh")).value = String(Math.floor(pliSheetH / 8));
  } else {
    (pliGetEl<HTMLInputElement>("pli-axis-cols")).checked = true;
    (pliGetEl<HTMLInputElement>("pli-fw")).value = String(Math.floor(pliSheetW / 8));
    (pliGetEl<HTMLInputElement>("pli-fh")).value = String(pliSheetH);
  }
  (pliGetEl<HTMLInputElement>("pli-nf")).value = "1";

  pliGetEl("pli-preview-wrap").style.display = "block";
  (pliGetEl<HTMLElement>("pli-settings") as HTMLElement).style.display = "flex";
  (pliGetEl<HTMLButtonElement>("pli-import")).disabled = false;
  const base = file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
  (pliGetEl<HTMLInputElement>("pli-name")).value = base || "imported";
  pliRedrawSheetPreview();
});

["pli-fw","pli-fh","pli-nf"].forEach(id =>
  pliGetEl<HTMLInputElement>(id).addEventListener("input", pliRedrawSheetPreview));
pliGetEl<HTMLInputElement>("pli-axis-rows").addEventListener("change", pliRedrawSheetPreview);
pliGetEl<HTMLInputElement>("pli-axis-cols").addEventListener("change", pliRedrawSheetPreview);

$("pli-preset-v3rows")?.addEventListener("click", () => {
  if (!pliSheetBitmap) return;
  (pliGetEl<HTMLInputElement>("pli-fw")).value = String(pliSheetW);
  (pliGetEl<HTMLInputElement>("pli-fh")).value = String(Math.floor(pliSheetH / 8));
  (pliGetEl<HTMLInputElement>("pli-nf")).value = "1";
  (pliGetEl<HTMLInputElement>("pli-axis-rows")).checked = true;
  pliRedrawSheetPreview();
});
$("pli-preset-v3cols")?.addEventListener("click", () => {
  if (!pliSheetBitmap) return;
  (pliGetEl<HTMLInputElement>("pli-fw")).value = String(Math.floor(pliSheetW / 8));
  (pliGetEl<HTMLInputElement>("pli-fh")).value = String(pliSheetH);
  (pliGetEl<HTMLInputElement>("pli-nf")).value = "1";
  (pliGetEl<HTMLInputElement>("pli-axis-cols")).checked = true;
  pliRedrawSheetPreview();
});

function pliSheetDoImport() {
  if (!pliSheetBitmap) return;
  const fw = pliNum("pli-fw"), fh = pliNum("pli-fh"), nf = pliNum("pli-nf");
  if (!fw || !fh || !nf) { alert("Set frame size first."); return; }
  const name = pliStr("pli-name") || "imported";
  const clipName = pliStr("pli-clip") || "idle";
  const facingsInRows = (pliGetEl<HTMLInputElement>("pli-axis-rows")).checked;

  const canvas = document.createElement("canvas");
  canvas.width = pliSheetW; canvas.height = pliSheetH;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(pliSheetBitmap, 0, 0);

  const facingPixels = new Map<Facing, string[][]>();
  for (let fi = 0; fi < 8; fi++) {
    const f = PL_FACING_MAP[fi];
    facingPixels.set(f, []);
    for (let fr = 0; fr < nf; fr++) {
      const col = facingsInRows ? fr : fi;
      const row = facingsInRows ? fi : fr;
      facingPixels.get(f)!.push(pliExtractPixels(ctx, col * fw, row * fh, fw, fh));
    }
  }
  pliFinishImport(facingPixels, fw, fh, name, clipName);
}

// ── Modal wiring ──────────────────────────────────────────────────────────────

function pliSetMode(m: "8png" | "sheet") {
  pliMode = m;
  pliGetEl("pli-mode-8png").style.display = m === "8png" ? "flex" : "none";
  pliGetEl("pli-mode-sheet").style.display = m === "sheet" ? "flex" : "none";
  pliGetEl("pli-tab-8png").classList.toggle("active", m === "8png");
  pliGetEl("pli-tab-sheet").classList.toggle("active", m === "sheet");
  if (m === "8png") {
    (pliGetEl<HTMLButtonElement>("pli-import")).disabled = pli8Bitmaps.size < 8;
  } else {
    (pliGetEl<HTMLButtonElement>("pli-import")).disabled = !pliSheetBitmap;
  }
}

function pliOpenModal() {
  pliGetEl("pli-modal").style.display = "flex";
  pliSetMode("8png");
}

$("btn-pixellab")?.addEventListener("click", pliOpenModal);
$("pli-close")?.addEventListener("click", () => { pliGetEl("pli-modal").style.display = "none"; });
$("pli-cancel")?.addEventListener("click", () => { pliGetEl("pli-modal").style.display = "none"; });
$("pli-tab-8png")?.addEventListener("click", () => pliSetMode("8png"));
$("pli-tab-sheet")?.addEventListener("click", () => pliSetMode("sheet"));

$("pli-import")?.addEventListener("click", () => {
  if (pliMode === "8png") pli8DoImport();
  else pliSheetDoImport();
});

// ── Init ─────────────────────────────────────────────────────────────────────
function refreshAll() {
  currentClip = doc.defaultClip;
  ($("fps") as HTMLInputElement).value = String(curClip().fps);
  buildPalette();
  setColor(color);
  buildSubjectGrid();
  setCategory(category);
}

// Hook up tintToggle
const tintToggleEl = document.getElementById("tintToggle") as HTMLInputElement | null;
if (tintToggleEl) {
  tintToggleEl.addEventListener("change", (e) => {
    tintPreview = (e.target as HTMLInputElement).checked;
    drawStage();
  });
}

refreshAll();
