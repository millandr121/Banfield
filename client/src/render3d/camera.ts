import * as THREE from "three";
import { elevToY, groundBasis } from "./coords";

const PITCH_MIN = 0.14;   // just above horizontal
const PITCH_MAX = 1.44;   // near-overhead, never fully top-down
const DIST_MIN = 3.5;
const DIST_MAX = 42;
const DAMP = 12;          // per-second approach rate for yaw/pitch/dist/target

/**
 * OSRS/Minecraft-style orbit rig: the camera always looks at the player and
 * swings around them on a sphere. Drag (middle or right button) orbits, wheel
 * zooms, arrow keys nudge — matching what OSRS players expect.
 */
export class OrbitCamera {
  readonly cam: THREE.PerspectiveCamera;

  private yaw = 0;
  private pitch = 0.75;
  private dist = 14;
  private tYaw = 0;
  private tPitch = 0.75;
  private tDist = 14;

  private readonly target = new THREE.Vector3();
  private targetInit = false;

  private dragging = false;
  private lastPx = 0;
  private lastPy = 0;
  private detach: (() => void) | null = null;

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(55, aspect, 0.1, 2000);
  }

  get currentYaw(): number { return this.yaw; }

  /** Ground-plane forward/right in world tile coords, for camera-relative input. */
  basis() { return groundBasis(this.yaw); }

  yawBy(d: number) { this.tYaw += d; }
  pitchBy(d: number) { this.tPitch = clamp(this.tPitch + d, PITCH_MIN, PITCH_MAX); }
  zoomBy(d: number) { this.tDist = clamp(this.tDist + d, DIST_MIN, DIST_MAX); }

  attach(canvas: HTMLCanvasElement) {
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1 && e.button !== 2) return;
      this.dragging = true;
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.tYaw -= (e.clientX - this.lastPx) * 0.008;
      this.tPitch = clamp(this.tPitch + (e.clientY - this.lastPy) * 0.006, PITCH_MIN, PITCH_MAX);
      this.lastPx = e.clientX;
      this.lastPy = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    const onCtx = (e: Event) => e.preventDefault();

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("contextmenu", onCtx);

    this.detach = () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("contextmenu", onCtx);
    };
  }

  dispose() { this.detach?.(); this.detach = null; }

  setAspect(aspect: number) {
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }

  /** Follow the player. (wx, wy) are tile coords, elevation is tide units. */
  update(dt: number, wx: number, wy: number, elevation: number) {
    const ty = elevToY(elevation) + 0.9; // aim at torso height, not the feet
    if (!this.targetInit) {
      this.target.set(wx, ty, wy);
      this.targetInit = true;
    } else {
      const k = Math.min(1, DAMP * dt);
      this.target.x += (wx - this.target.x) * k;
      this.target.y += (ty - this.target.y) * k;
      this.target.z += (wy - this.target.z) * k;
    }

    const k = Math.min(1, DAMP * dt);
    this.yaw += (this.tYaw - this.yaw) * k;
    this.pitch += (this.tPitch - this.pitch) * k;
    this.dist += (this.tDist - this.dist) * k;

    const cp = Math.cos(this.pitch);
    this.cam.position.set(
      this.target.x + this.dist * cp * Math.sin(this.yaw),
      this.target.y + this.dist * Math.sin(this.pitch),
      this.target.z + this.dist * cp * Math.cos(this.yaw),
    );
    this.cam.lookAt(this.target);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
