// Pixel-art inventory icons. The sprites are authored by tools/gen-item-sprites.mjs
// (or repainted in the sprite editor) and stored as flat colour-string buffers.
// We rasterise each icon once into an OffscreenCanvas and blit it with
// nearest-neighbour scaling so it stays crisp at any HUD size.

import sheet from "./assets/item-sprites.json";
import type { ItemId } from "../../shared/protocol";

const SIZE: number = (sheet as { size: number }).size;
const ICONS = (sheet as { icons: Record<string, string[]> }).icons;

const cache = new Map<string, OffscreenCanvas>();

/** True when we have a hand-drawn icon for this item. */
export function hasItemIcon(id: string): boolean {
  return !!ICONS[id];
}

function rasterise(id: string): OffscreenCanvas | null {
  const px = ICONS[id];
  if (!px) return null;
  const c = new OffscreenCanvas(SIZE, SIZE);
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(SIZE, SIZE);
  for (let i = 0; i < px.length; i++) {
    const s = px[i];
    if (!s) continue;
    const n = parseInt(s.slice(1), 16);
    const o = i * 4;
    img.data[o] = (n >> 16) & 255;
    img.data[o + 1] = (n >> 8) & 255;
    img.data[o + 2] = n & 255;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function iconFor(id: string): OffscreenCanvas | null {
  let c = cache.get(id);
  if (c) return c;
  const r = rasterise(id);
  if (r) cache.set(id, r);
  return r;
}

/**
 * Draw item `id` into the box (x, y, size, size), preserving the icon's square
 * aspect and nearest-neighbour pixels. Returns false if no icon exists (caller
 * can fall back to a colour swatch).
 */
export function drawItemIcon(
  ctx: CanvasRenderingContext2D,
  id: ItemId | string,
  x: number, y: number, size: number,
): boolean {
  const c = iconFor(id);
  if (!c) return false;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(c, x, y, size, size);
  ctx.imageSmoothingEnabled = prev;
  return true;
}
