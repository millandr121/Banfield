// World ↔ scene coordinate mapping.
//
// Game world is a tile grid: x runs east, y runs SOUTH (screen-down, as in the
// old 2D renderer), and `elevation` is the tide heightmap (roughly 0..100 in
// tide units — see WATERLINE_* / TILE_ELEVATION in shared/protocol).
//
// Three.js is Y-up, so:  world(x, y, elev) → scene(x, elev * ELEV_SCALE, y)
//
// Because world-y points south while scene-z points "down-screen" the same way,
// the XY plane is left-handed relative to standard math orientation. Every
// horizontal rotation below accounts for that; don't "fix" the signs.

/** Scene units of height per unit of tide elevation. Elevation tops out near
 *  100 (Rock), so this puts the highest ground ~8 tiles above the sea floor. */
export const ELEV_SCALE = 0.08;

export function elevToY(elevation: number): number {
  return elevation * ELEV_SCALE;
}

/** Ground-plane camera basis in WORLD tile coords, for camera-relative input. */
export function groundBasis(yaw: number): {
  fx: number; fy: number; rx: number; ry: number;
} {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  return { fx: -s, fy: -c, rx: c, ry: -s };
}
