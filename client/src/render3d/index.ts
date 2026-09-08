import * as THREE from "three";
import { Tile, WorldMap } from "../../../shared/protocol";
import { ELEV_SCALE, elevToY } from "./coords";
import { OrbitCamera } from "./camera";
import { TerrainChunks } from "./terrain";
import { AnimState, CharacterRig, RigColors } from "./character";

export interface PlayerView {
  id: string;
  x: number;
  y: number;
  elevation: number;
  heading: number;
  state: AnimState;
  speed: number;
  colors: RigColors;
  /** Extra height above the ground, in scene units (jump arc). */
  lift?: number;
}

const SKY = 0x8fb8d8;
const WATER_SIZE = 600;

/**
 * The 3D world renderer. It owns its own WebGL canvas, inserted *behind* the
 * existing 2D canvas so the whole HUD keeps working unchanged as a transparent
 * overlay on top.
 */
export class Renderer3D {
  readonly camera: OrbitCamera;
  readonly canvas: HTMLCanvasElement;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private terrain: TerrainChunks;
  private sun: THREE.DirectionalLight;
  private water: THREE.Mesh;
  private rigs = new Map<string, CharacterRig>();
  private waterline = 0;
  private cssW = 1;
  private cssH = 1;
  private scratch = new THREE.Vector3();

  constructor(hudCanvas: HTMLCanvasElement, tileColors: Record<number, string>) {
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    hudCanvas.parentElement?.insertBefore(this.canvas, hudCanvas);
    // The HUD canvas now sits on top and must not paint an opaque background.
    hudCanvas.style.position = "absolute";
    hudCanvas.style.inset = "0";
    hudCanvas.style.background = "transparent";

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 60, 145);

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.15));
    const hemi = new THREE.HemisphereLight(0xcfe4f5, 0x4a4030, 0.85);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff2d8, 1.5);
    this.sun.position.set(-40, 70, 26);
    this.scene.add(this.sun, this.sun.target);

    this.terrain = new TerrainChunks(tileColors);
    this.scene.add(this.terrain.group);

    const waterMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(tileColors[Tile.Water] ?? "#287ab0"),
      transparent: true, opacity: 0.72, depthWrite: false,
    });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE), waterMat);
    this.water.rotation.x = -Math.PI / 2;
    this.water.renderOrder = 1;
    this.scene.add(this.water);

    this.camera = new OrbitCamera(1);
    // Orbit input binds to the HUD canvas: it sits on top, so it — not the
    // WebGL canvas underneath — is what actually receives pointer events.
    this.camera.attach(hudCanvas);
  }

  setMap(map: WorldMap, overrides?: Map<string, Tile>) {
    this.terrain.setMap(map, overrides);
  }

  invalidateTiles(x: number, y: number, w = 1, h = 1) {
    this.terrain.invalidate(x, y, w, h);
  }

  setWaterline(waterline: number) {
    this.waterline = waterline;
  }

  resize(w: number, h: number) {
    this.cssW = w;
    this.cssH = h;
    this.renderer.setSize(w, h, false);
    this.camera.setAspect(w / Math.max(1, h));
  }

  /**
   * World tile position → screen pixels, so world-anchored 2D HUD (nameplates,
   * interaction prompts, tracers) keeps working on top of the 3D scene.
   * `visible` is false when the point is behind the camera.
   */
  project(wx: number, wy: number, elevation: number): { sx: number; sy: number; visible: boolean } {
    const v = this.scratch.set(wx, elevToY(elevation), wy).project(this.camera.cam);
    return {
      sx: (v.x * 0.5 + 0.5) * this.cssW,
      sy: (-v.y * 0.5 + 0.5) * this.cssH,
      visible: v.z < 1,
    };
  }

  /** Create/update/remove character rigs to match the given set of players. */
  syncPlayers(views: PlayerView[], dt: number) {
    const seen = new Set<string>();
    for (const v of views) {
      seen.add(v.id);
      let rig = this.rigs.get(v.id);
      if (!rig) {
        rig = new CharacterRig(v.colors);
        this.rigs.set(v.id, rig);
        this.scene.add(rig.root);
      } else {
        rig.setColors(v.colors);
      }
      rig.root.position.set(v.x, elevToY(v.elevation) + (v.lift ?? 0), v.y);
      rig.setHeading(v.heading);
      rig.update(dt, v.state, v.speed);
    }
    for (const [id, rig] of this.rigs) {
      if (seen.has(id)) continue;
      rig.dispose();
      this.rigs.delete(id);
    }
  }

  /** Ground-plane forward/right in world tile coords, for camera-relative input. */
  basis() { return this.camera.basis(); }

  render(dt: number, focusX: number, focusY: number, focusElevation: number) {
    this.camera.update(dt, focusX, focusY, focusElevation);
    this.terrain.update(focusX, focusY);

    this.water.position.set(focusX, this.waterline * ELEV_SCALE, focusY);
    // Keep the sun rigged to the player so shadows and falloff stay consistent
    // no matter how far you walk from the world origin.
    this.sun.position.set(focusX - 40, 70, focusY + 26);
    this.sun.target.position.set(focusX, 0, focusY);
    this.sun.target.updateMatrixWorld();

    this.renderer.render(this.scene, this.camera.cam);
  }

  dispose() {
    for (const rig of this.rigs.values()) rig.dispose();
    this.rigs.clear();
    this.terrain.dispose();
    this.camera.dispose();
    this.renderer.dispose();
    this.canvas.remove();
  }
}

export type { AnimState, RigColors };
