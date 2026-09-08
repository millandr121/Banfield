import * as THREE from "three";
import { CHUNK, Tile, WorldMap } from "../../../shared/protocol";
import { ELEV_SCALE } from "./coords";

/** How many chunks out from the player we keep meshed. */
const VIEW_CHUNKS = 4;

/**
 * Terrain is meshed one CHUNK (32×32 tiles) at a time and cached, because the
 * world is ~13M tiles — far too many to mesh at once. Chunks outside the view
 * radius are disposed; chunks whose tiles change (map streaming, terrain paint)
 * are marked dirty and rebuilt.
 *
 * Geometry is non-indexed so every tile keeps a flat, uninterpolated colour —
 * that faceted look is the point, not an artifact. Corner heights are averaged
 * across adjacent tiles so the ground still slopes smoothly underneath.
 */
export class TerrainChunks {
  readonly group = new THREE.Group();

  private map: WorldMap | null = null;
  private overrides: Map<string, Tile> | null = null;
  private colors: Record<number, THREE.Color> = {};
  private material: THREE.MeshLambertMaterial;
  private meshes = new Map<string, THREE.Mesh>();
  private dirty = new Set<string>();

  constructor(tileColors: Record<number, string>) {
    for (const [k, hex] of Object.entries(tileColors)) {
      this.colors[Number(k)] = new THREE.Color(hex);
    }
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  }

  setMap(map: WorldMap, overrides?: Map<string, Tile>) {
    this.map = map;
    this.overrides = overrides ?? null;
    this.clear();
  }

  /** Mark chunks overlapping a tile rect for rebuild (streamed or painted tiles). */
  invalidate(tx: number, ty: number, w = 1, h = 1) {
    const c0x = Math.floor(tx / CHUNK), c1x = Math.floor((tx + w - 1) / CHUNK);
    const c0y = Math.floor(ty / CHUNK), c1y = Math.floor((ty + h - 1) / CHUNK);
    for (let cy = c0y; cy <= c1y; cy++) {
      for (let cx = c0x; cx <= c1x; cx++) this.dirty.add(`${cx},${cy}`);
    }
  }

  /** Build/drop chunk meshes around a tile position. Call once per frame. */
  update(centerTileX: number, centerTileY: number) {
    if (!this.map) return;
    const ccx = Math.floor(centerTileX / CHUNK);
    const ccy = Math.floor(centerTileY / CHUNK);
    const maxCx = Math.floor((this.map.width - 1) / CHUNK);
    const maxCy = Math.floor((this.map.height - 1) / CHUNK);

    const want = new Set<string>();
    for (let dy = -VIEW_CHUNKS; dy <= VIEW_CHUNKS; dy++) {
      for (let dx = -VIEW_CHUNKS; dx <= VIEW_CHUNKS; dx++) {
        const cx = ccx + dx, cy = ccy + dy;
        if (cx < 0 || cy < 0 || cx > maxCx || cy > maxCy) continue;
        want.add(`${cx},${cy}`);
      }
    }

    for (const [key, mesh] of this.meshes) {
      if (!want.has(key) || this.dirty.has(key)) {
        this.group.remove(mesh);
        mesh.geometry.dispose();
        this.meshes.delete(key);
      }
    }
    this.dirty.clear();

    for (const key of want) {
      if (this.meshes.has(key)) continue;
      const [cx, cy] = key.split(",").map(Number);
      const mesh = new THREE.Mesh(this.buildChunk(cx, cy), this.material);
      mesh.receiveShadow = true;
      this.meshes.set(key, mesh);
      this.group.add(mesh);
    }
  }

  clear() {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.meshes.clear();
    this.dirty.clear();
  }

  dispose() {
    this.clear();
    this.material.dispose();
  }

  private tileAt(x: number, y: number): Tile {
    const m = this.map!;
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return Tile.Water;
    const o = this.overrides?.get(`${x},${y}`);
    return (o ?? m.tiles[y * m.width + x] ?? Tile.Water) as Tile;
  }

  private elevAt(x: number, y: number): number {
    const m = this.map!;
    const cx = x < 0 ? 0 : x >= m.width ? m.width - 1 : x;
    const cy = y < 0 ? 0 : y >= m.height ? m.height - 1 : y;
    return m.elevation[cy * m.width + cx] ?? 0;
  }

  /** Height at a tile *corner*, averaged from the four tiles meeting there. */
  private cornerY(cx: number, cy: number): number {
    const e = (this.elevAt(cx - 1, cy - 1) + this.elevAt(cx, cy - 1)
             + this.elevAt(cx - 1, cy) + this.elevAt(cx, cy)) * 0.25;
    return e * ELEV_SCALE;
  }

  private buildChunk(cx: number, cy: number): THREE.BufferGeometry {
    const m = this.map!;
    const x0 = cx * CHUNK, y0 = cy * CHUNK;
    const w = Math.min(CHUNK, m.width - x0);
    const h = Math.min(CHUNK, m.height - y0);

    const quads = w * h;
    const pos = new Float32Array(quads * 18); // 6 verts × 3 floats
    const col = new Float32Array(quads * 18);
    let p = 0, c = 0;

    for (let ty = y0; ty < y0 + h; ty++) {
      for (let tx = x0; tx < x0 + w; tx++) {
        const yTL = this.cornerY(tx, ty);
        const yTR = this.cornerY(tx + 1, ty);
        const yBL = this.cornerY(tx, ty + 1);
        const yBR = this.cornerY(tx + 1, ty + 1);
        const xL = tx, xR = tx + 1, zT = ty, zB = ty + 1;

        // Two triangles, wound CCW when viewed from above (+Y).
        pos[p++] = xL; pos[p++] = yTL; pos[p++] = zT;
        pos[p++] = xL; pos[p++] = yBL; pos[p++] = zB;
        pos[p++] = xR; pos[p++] = yTR; pos[p++] = zT;

        pos[p++] = xR; pos[p++] = yTR; pos[p++] = zT;
        pos[p++] = xL; pos[p++] = yBL; pos[p++] = zB;
        pos[p++] = xR; pos[p++] = yBR; pos[p++] = zB;

        const base = this.colors[this.tileAt(tx, ty)] ?? this.colors[Tile.Grass];
        // Deterministic per-tile shade jitter so large flat areas aren't a
        // single dead sheet of colour.
        const j = 0.92 + tileHash(tx, ty) * 0.16;
        const r = base.r * j, g = base.g * j, b = base.b * j;
        for (let i = 0; i < 6; i++) { col[c++] = r; col[c++] = g; col[c++] = b; }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeVertexNormals();
    return geo;
  }
}

function tileHash(x: number, y: number): number {
  let h = (x * 374761393 + y * 1234567891) | 0;
  h ^= h >>> 13; h = Math.imul(h, 1540483477); h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}
