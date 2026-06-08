// Shared sprite-document model.
//
// A SpriteDoc is the authored, hand-painted alternative to code-drawn
// characters. The sprite editor produces these; the game can render from them.
//
// Pixels are stored as a flat array of colour strings, length w*h, row-major.
// An empty string ("") means transparent. Each (facing, frame) "cell" is a
// stack of layers (skin, hair, shirt, …) painted independently so outfits and
// recolours can be composited or swapped without repainting the body.

export type Facing = "down" | "up" | "left" | "right";
export const FACINGS: Facing[] = ["down", "up", "left", "right"];

/** Flat row-major pixel buffer; "" = transparent, else "#rrggbb". */
export type Pixels = string[];

/** One animation frame for one facing: one Pixels buffer per layer. */
export interface SpriteFrame {
  layers: Pixels[];
}

export interface SpriteDoc {
  version: 1;
  name: string;
  w: number;
  h: number;
  /** Layer names, bottom-to-top draw order (index 0 drawn first). */
  layerNames: string[];
  /** Frames per facing (each facing may have a different frame count). */
  facings: Record<Facing, SpriteFrame[]>;
  /** Playback speed for the walk cycle, frames per second. */
  fps: number;
}

export const DEFAULT_LAYERS = ["skin", "hair", "shirt", "pants", "accessory"];

export function emptyPixels(w: number, h: number): Pixels {
  return new Array(w * h).fill("");
}

export function emptyFrame(w: number, h: number, layerCount: number): SpriteFrame {
  return { layers: Array.from({ length: layerCount }, () => emptyPixels(w, h)) };
}

export function newSpriteDoc(
  name = "untitled",
  w = 20,
  h = 26,
  layerNames = DEFAULT_LAYERS,
): SpriteDoc {
  const facings = {} as Record<Facing, SpriteFrame[]>;
  for (const f of FACINGS) {
    // Start every facing with a single editable frame.
    facings[f] = [emptyFrame(w, h, layerNames.length)];
  }
  return { version: 1, name, w, h, layerNames: [...layerNames], facings, fps: 6 };
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

/** Re-shape an old doc so it has exactly `layerNames` layers (for migrations). */
export function normalizeLayers(doc: SpriteDoc): SpriteDoc {
  const n = doc.layerNames.length;
  for (const f of FACINGS) {
    for (const frame of doc.facings[f]) {
      while (frame.layers.length < n) frame.layers.push(emptyPixels(doc.w, doc.h));
      frame.layers.length = n;
    }
  }
  return doc;
}
