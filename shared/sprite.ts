// Shared sprite-document model.
//
// A SpriteDoc is the authored, hand-painted alternative to code-drawn
// characters. The sprite editor produces these; the game can render from them.
//
// Pixels are stored as a flat array of colour strings, length w*h, row-major.
// An empty string ("") means transparent. Each (facing, frame) "cell" is a
// stack of layers (skin, hair, shirt, …) painted independently so outfits and
// recolours can be composited or swapped without repainting the body.

export type Facing =
  | "down" | "up" | "left" | "right"
  | "downleft" | "downright" | "upleft" | "upright";
export const FACINGS: Facing[] = [
  "down", "downright", "right", "upright", "up", "upleft", "left", "downleft",
];

/** Nearest cardinal facing to copy art from when a diagonal is missing. */
export const FACING_FALLBACK: Record<Facing, Facing> = {
  down: "down", up: "up", left: "left", right: "right",
  downright: "right", downleft: "left", upright: "right", upleft: "left",
};

/** Flat row-major pixel buffer; "" = transparent, else "#rrggbb". */
export type Pixels = string[];

/**
 * What a layer is dyed by. A dyeable layer is painted once in real colours
 * (with its own shading) and re-tinted at runtime to the chosen colour while
 * preserving that shading. "none" layers (outline, eyes, metal) pass through.
 */
export type DyeRole = "none" | "skin" | "hair" | "shirt" | "pants" | "accent";
export const DYE_ROLES: DyeRole[] = ["none", "skin", "hair", "shirt", "pants", "accent"];

/** Runtime dye colours keyed by role (omitted roles render as painted). */
export type Tints = Partial<Record<Exclude<DyeRole, "none">, string>>;

/** One animation frame for one facing: one Pixels buffer per layer. */
export interface SpriteFrame {
  layers: Pixels[];
}

/**
 * A named animation clip (walk, punch, jump, …). Each clip holds its own frames
 * per facing and its own playback speed, so a subject can carry any number of
 * independently-timed animations on the same body grid.
 */
export interface AnimationClip {
  facings: Record<Facing, SpriteFrame[]>;
  fps: number;
  loop: boolean;
}

export interface SpriteDoc {
  version: 2;
  name: string;
  w: number;
  h: number;
  /** Layer names, bottom-to-top draw order (index 0 drawn first). */
  layerNames: string[];
  /** Dye role per layer (parallel to layerNames). */
  layerDye: DyeRole[];
  /** Reference luminance (0..255) per layer for shading-preserving re-tinting. */
  layerRefLum?: number[];
  /** Named animation clips. Always has at least the `defaultClip`. */
  animations: Record<string, AnimationClip>;
  /** Which clip is shown first / used when no clip is requested. */
  defaultClip: string;
}

export const DEFAULT_LAYERS = ["skin", "hair", "shirt", "pants", "accessory"];
export const DEFAULT_DYES: DyeRole[] = ["skin", "hair", "shirt", "pants", "accent"];

// Creatures are authored the same way as characters — layered, frame-based
// pixel art — but with body-oriented layers and no runtime dyeing.
export const CREATURE_LAYERS = ["body", "shade", "detail"];
export const CREATURE_DYES: DyeRole[] = ["none", "none", "none"];
export const CREATURE_W = 32;
export const CREATURE_H = 24;

// The catalogue of animation clips a subject can carry. Editors offer these as
// "add animation" choices; the game maps player/creature state onto them.
export const CHAR_CLIPS = [
  "idle", "walk", "run", "punch", "kick", "block",
  "jump", "modeswitch", "swim", "fish", "sleep", "hurt",
] as const;
export const CREATURE_CLIPS = ["idle", "walk", "run", "attack", "hurt"] as const;
export const PROP_CLIPS = ["idle", "active"] as const; // objects/environment (fire, water, doors)

export function emptyPixels(w: number, h: number): Pixels {
  return new Array(w * h).fill("");
}

export function emptyFrame(w: number, h: number, layerCount: number): SpriteFrame {
  return { layers: Array.from({ length: layerCount }, () => emptyPixels(w, h)) };
}

/** A fresh clip with one empty frame per facing. */
export function emptyClip(w: number, h: number, layerCount: number, fps = 6, loop = true): AnimationClip {
  const facings = {} as Record<Facing, SpriteFrame[]>;
  for (const f of FACINGS) facings[f] = [emptyFrame(w, h, layerCount)];
  return { facings, fps, loop };
}

export function newSpriteDoc(
  name = "untitled",
  w = 20,
  h = 26,
  layerNames = DEFAULT_LAYERS,
  layerDye = DEFAULT_DYES,
  clipNames: readonly string[] = ["walk"],
): SpriteDoc {
  const animations: Record<string, AnimationClip> = {};
  for (const c of clipNames) animations[c] = emptyClip(w, h, layerNames.length);
  return {
    version: 2, name, w, h,
    layerNames: [...layerNames],
    layerDye: [...layerDye],
    animations,
    defaultClip: clipNames[0] ?? "walk",
  };
}

/** A blank creature sprite doc (body/shade/detail layers, no dyeing). */
export function newCreatureDoc(name = "creature", w = CREATURE_W, h = CREATURE_H): SpriteDoc {
  return newSpriteDoc(name, w, h, CREATURE_LAYERS, CREATURE_DYES, ["idle", "walk"]);
}

// ── Clip accessors ──────────────────────────────────────────────────────────
/** Resolve a clip by name, falling back to the default / first available. */
export function getClip(doc: SpriteDoc, clip?: string): AnimationClip {
  const a = doc.animations;
  if (clip && a[clip]) return a[clip];
  if (a[doc.defaultClip]) return a[doc.defaultClip];
  const first = Object.keys(a)[0];
  return a[first];
}

/** Frames for one clip + facing (falls back through clip resolution). */
export function clipFrames(doc: SpriteDoc, clip: string | undefined, facing: Facing): SpriteFrame[] {
  return getClip(doc, clip).facings[facing] ?? [];
}

export function listClips(doc: SpriteDoc): string[] {
  return Object.keys(doc.animations);
}

export function addClip(doc: SpriteDoc, name: string): void {
  if (doc.animations[name]) return;
  doc.animations[name] = emptyClip(doc.w, doc.h, doc.layerNames.length);
}

export function deleteClip(doc: SpriteDoc, name: string): void {
  if (!doc.animations[name]) return;
  if (Object.keys(doc.animations).length <= 1) return; // keep at least one
  delete doc.animations[name];
  if (doc.defaultClip === name) doc.defaultClip = Object.keys(doc.animations)[0];
}

/** True if any layer of any frame of any clip/facing has a painted pixel. */
export function docHasPaint(doc: SpriteDoc): boolean {
  for (const clip of Object.values(doc.animations)) {
    for (const f of FACINGS) {
      const frames = clip.facings[f];
      if (!frames) continue;
      for (const frame of frames) {
        for (const layer of frame.layers) {
          for (const px of layer) if (px) return true;
        }
      }
    }
  }
  return false;
}

// ── Dye / tint engine ─────────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Average luminance of a layer's painted pixels across all clips/frames/facings. */
export function computeRefLum(doc: SpriteDoc, layerIdx: number): number {
  let sum = 0, count = 0;
  for (const clip of Object.values(doc.animations)) {
    for (const f of FACINGS) {
      for (const frame of clip.facings[f] ?? []) {
        const layer = frame.layers[layerIdx];
        if (!layer) continue;
        for (const px of layer) {
          if (px) { sum += luminance(px); count++; }
        }
      }
    }
  }
  return count ? sum / count : 200;
}

/**
 * Re-tint one painted pixel toward `target`, scaling by its luminance relative
 * to `refLum` so highlights stay bright and shadows stay dark.
 */
export function tintPixel(painted: string, target: string, refLum: number): string {
  const ratio = refLum > 0 ? luminance(painted) / refLum : 1;
  const [r, g, b] = hexToRgb(target);
  return rgbToHex(r * ratio, g * ratio, b * ratio);
}

/**
 * Composite one (facing, frame) to a flat Pixels buffer, applying dye tints to
 * dyeable layers. `tints` supplies the chosen colour per role; absent roles
 * render as painted. Hidden layers (layerVisible[i] === false) are skipped.
 */
export function renderFrame(
  doc: SpriteDoc,
  clip: string | undefined,
  facing: Facing,
  frameIdx: number,
  tints: Tints = {},
  layerVisible?: boolean[],
): Pixels {
  const out = emptyPixels(doc.w, doc.h);
  const frames = clipFrames(doc, clip, facing);
  const frame = frames[frameIdx];
  if (!frame) return out;
  const refLums = doc.layerRefLum;
  for (let li = 0; li < frame.layers.length; li++) {
    if (layerVisible && layerVisible[li] === false) continue;
    const role = doc.layerDye[li] ?? "none";
    const target = role !== "none" ? tints[role] : undefined;
    const refLum = target ? (refLums?.[li] ?? computeRefLum(doc, li)) : 0;
    const layer = frame.layers[li];
    for (let i = 0; i < out.length; i++) {
      const px = layer[i];
      if (!px) continue;
      out[i] = target ? tintPixel(px, target, refLum) : px;
    }
  }
  return out;
}

/** Flatten a frame's visible layers into a single composited Pixels buffer. */
export function compositeFrame(
  frame: SpriteFrame,
  layerVisible: boolean[],
  w: number,
  h: number,
): Pixels {
  const out = emptyPixels(w, h);
  for (let li = 0; li < frame.layers.length; li++) {
    if (layerVisible[li] === false) continue;
    const layer = frame.layers[li];
    for (let i = 0; i < out.length; i++) {
      if (layer[i]) out[i] = layer[i];
    }
  }
  return out;
}

/**
 * Migrate + normalize any saved doc to the current v2 shape: fold a legacy
 * single-clip (`facings`/`fps`) doc into `animations.walk`, back-fill missing
 * facings within every clip, and reconcile layer counts. Safe to call on
 * already-v2 docs (idempotent). Kept named `normalizeLayers` for call sites.
 */
export function normalizeLayers(doc: SpriteDoc): SpriteDoc {
  // ── v1 → v2: wrap the old top-level facings/fps into a "walk" clip. ──
  const legacy = doc as unknown as { facings?: Record<Facing, SpriteFrame[]>; fps?: number; animations?: Record<string, AnimationClip> };
  if (!legacy.animations) {
    const facings = legacy.facings ?? {} as Record<Facing, SpriteFrame[]>;
    doc.animations = { walk: { facings, fps: legacy.fps ?? 6, loop: true } };
    doc.defaultClip = "walk";
    delete legacy.facings;
    delete legacy.fps;
  }
  if (!doc.defaultClip || !doc.animations[doc.defaultClip]) {
    doc.defaultClip = Object.keys(doc.animations)[0] ?? "walk";
    if (!doc.animations[doc.defaultClip]) {
      doc.animations[doc.defaultClip] = emptyClip(doc.w, doc.h, doc.layerNames.length);
    }
  }
  doc.version = 2;

  const n = doc.layerNames.length;
  // Back-fill dye roles for docs authored before the dye system existed.
  if (!doc.layerDye) {
    doc.layerDye = doc.layerNames.map((nm) =>
      (DYE_ROLES as string[]).includes(nm) ? (nm as DyeRole) : "none");
  }
  while (doc.layerDye.length < n) doc.layerDye.push("none");
  doc.layerDye.length = n;

  for (const clip of Object.values(doc.animations)) {
    // Back-fill missing facings (e.g. diagonals) by cloning the nearest cardinal.
    for (const f of FACINGS) {
      if (!clip.facings[f] || clip.facings[f].length === 0) {
        const src = clip.facings[FACING_FALLBACK[f]] ?? clip.facings.down;
        clip.facings[f] = (src ?? [emptyFrame(doc.w, doc.h, n)]).map((fr) => ({
          layers: fr.layers.map((l) => [...l]),
        }));
      }
    }
    if (typeof clip.fps !== "number") clip.fps = 6;
    if (typeof clip.loop !== "boolean") clip.loop = true;
    // Reconcile layer counts on every frame.
    for (const f of FACINGS) {
      for (const frame of clip.facings[f]) {
        while (frame.layers.length < n) frame.layers.push(emptyPixels(doc.w, doc.h));
        frame.layers.length = n;
      }
    }
  }
  return doc;
}
