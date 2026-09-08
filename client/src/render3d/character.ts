import * as THREE from "three";
import type { DyeRole } from "../../../shared/sprite";

// One canonical skeleton, shared by every character in the game. This is the
// whole reason "every item fits everyone": equipment meshes are authored
// against these bone names and rest dimensions, so any item parented to a bone
// lands correctly on any body. Change a rest transform here and you have
// changed it for every character and every item at once.
//
// Parts are rigid meshes parented to bones (not skinned) — that segmented look
// is how OSRS models actually work, and it makes equipping a swap of one child.

export type BoneName =
  | "root" | "hips" | "torso" | "neck" | "head"
  | "armL" | "forearmL" | "handL"
  | "armR" | "forearmR" | "handR"
  | "legL" | "shinL" | "footL"
  | "legR" | "shinR" | "footR";

/** Where an equipment mesh may attach. Slots map onto bones. */
export type EquipSlot =
  | "head" | "torso" | "legs" | "feet" | "hands" | "weapon" | "shield" | "back";

const SLOT_BONE: Record<EquipSlot, BoneName> = {
  head: "head", torso: "torso", legs: "hips", feet: "footL",
  hands: "handL", weapon: "handR", shield: "handL", back: "torso",
};

// Rest pose: bone offset from its parent, in scene units (1 unit = 1 tile).
// Limb bones sit at their joint and their mesh hangs downward from it.
const REST: Record<BoneName, [number, number, number]> = {
  root:     [0, 0, 0],
  // Hip height is set so the soles land exactly on y=0: legs 0.42 + shins 0.40
  // + feet 0.10. Change a limb length and this must move with it.
  hips:     [0, 0.92, 0],
  torso:    [0, 0, 0],
  neck:     [0, 0.55, 0],
  head:     [0, 0.05, 0],
  armL:     [-0.30, 0.48, 0],
  forearmL: [0, -0.34, 0],
  handL:    [0, -0.32, 0],
  armR:     [0.30, 0.48, 0],
  forearmR: [0, -0.34, 0],
  handR:    [0, -0.32, 0],
  legL:     [-0.11, 0, 0],
  shinL:    [0, -0.42, 0],
  footL:    [0, -0.40, 0],
  legR:     [0.11, 0, 0],
  shinR:    [0, -0.42, 0],
  footR:    [0, -0.40, 0],
};

const PARENT: Partial<Record<BoneName, BoneName>> = {
  hips: "root", torso: "hips", neck: "torso", head: "neck",
  armL: "torso", forearmL: "armL", handL: "forearmL",
  armR: "torso", forearmR: "armR", handR: "forearmR",
  legL: "hips", shinL: "legL", footL: "shinL",
  legR: "hips", shinR: "legR", footR: "shinR",
};

/**
 * A box tapered between its top and bottom face, origin at the TOP-centre so
 * limbs hang from their joint. Six quads, no smoothing — flat-shaded facets.
 */
function taperedBox(topW: number, topD: number, botW: number, botD: number, h: number): THREE.BufferGeometry {
  const tw = topW / 2, td = topD / 2, bw = botW / 2, bd = botD / 2;
  // 0-3 top ring (y=0), 4-7 bottom ring (y=-h), both wound CCW from above.
  const v: number[][] = [
    [-tw, 0, -td], [tw, 0, -td], [tw, 0, td], [-tw, 0, td],
    [-bw, -h, -bd], [bw, -h, -bd], [bw, -h, bd], [-bw, -h, bd],
  ];
  const quads = [
    [0, 1, 2, 3], // top
    [7, 6, 5, 4], // bottom
    [4, 5, 1, 0], // -z
    [6, 7, 3, 2], // +z
    [5, 6, 2, 1], // +x
    [7, 4, 0, 3], // -x
  ];
  const pos: number[] = [];
  for (const [a, b, c, d] of quads) {
    pos.push(...v[a], ...v[b], ...v[c]);
    pos.push(...v[a], ...v[c], ...v[d]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

interface PartSpec {
  bone: BoneName;
  role: Exclude<DyeRole, "none">;
  geo: THREE.BufferGeometry;
  /** Offset applied to the mesh within its bone. */
  offset?: [number, number, number];
}

function bodyParts(): PartSpec[] {
  return [
    { bone: "head",  role: "skin",  geo: taperedBox(0.24, 0.22, 0.22, 0.21, 0.26), offset: [0, 0.26, 0] },
    { bone: "head",  role: "hair",  geo: taperedBox(0.25, 0.235, 0.255, 0.24, 0.10), offset: [0, 0.30, 0] },
    { bone: "torso", role: "shirt", geo: taperedBox(0.46, 0.24, 0.38, 0.22, 0.55), offset: [0, 0.55, 0] },
    { bone: "armL",  role: "skin",  geo: taperedBox(0.14, 0.14, 0.12, 0.12, 0.34) },
    { bone: "armR",  role: "skin",  geo: taperedBox(0.14, 0.14, 0.12, 0.12, 0.34) },
    { bone: "forearmL", role: "skin", geo: taperedBox(0.12, 0.12, 0.10, 0.10, 0.32) },
    { bone: "forearmR", role: "skin", geo: taperedBox(0.12, 0.12, 0.10, 0.10, 0.32) },
    { bone: "handL", role: "skin",  geo: taperedBox(0.11, 0.11, 0.09, 0.09, 0.12) },
    { bone: "handR", role: "skin",  geo: taperedBox(0.11, 0.11, 0.09, 0.09, 0.12) },
    { bone: "legL",  role: "pants", geo: taperedBox(0.18, 0.18, 0.15, 0.15, 0.42) },
    { bone: "legR",  role: "pants", geo: taperedBox(0.18, 0.18, 0.15, 0.15, 0.42) },
    { bone: "shinL", role: "pants", geo: taperedBox(0.15, 0.15, 0.12, 0.12, 0.40) },
    { bone: "shinR", role: "pants", geo: taperedBox(0.15, 0.15, 0.12, 0.12, 0.40) },
    { bone: "footL", role: "accent", geo: taperedBox(0.14, 0.26, 0.13, 0.24, 0.10) },
    { bone: "footR", role: "accent", geo: taperedBox(0.14, 0.26, 0.13, 0.24, 0.10) },
  ];
}

export type AnimState = "idle" | "walk" | "run" | "jump" | "fall" | "swim";

export interface RigColors {
  skin?: string; hair?: string; shirt?: string; pants?: string; accent?: string;
}

export class CharacterRig {
  readonly root = new THREE.Object3D();
  private bones = {} as Record<BoneName, THREE.Object3D>;
  private byRole = new Map<string, THREE.MeshLambertMaterial[]>();
  private equipped = new Map<EquipSlot, THREE.Object3D>();
  private owned: (THREE.BufferGeometry | THREE.Material)[] = [];
  private phase = 0;

  constructor(colors: RigColors = {}) {
    for (const name of Object.keys(REST) as BoneName[]) {
      this.bones[name] = new THREE.Object3D();
      this.bones[name].position.fromArray(REST[name]);
    }
    for (const name of Object.keys(REST) as BoneName[]) {
      const parent = PARENT[name];
      (parent ? this.bones[parent] : this.root).add(this.bones[name]);
    }

    for (const spec of bodyParts()) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
      const mesh = new THREE.Mesh(spec.geo, mat);
      if (spec.offset) mesh.position.fromArray(spec.offset);
      mesh.castShadow = true;
      this.bones[spec.bone].add(mesh);
      this.owned.push(spec.geo, mat);
      const list = this.byRole.get(spec.role) ?? [];
      list.push(mat);
      this.byRole.set(spec.role, list);
    }

    this.setColors({
      skin: "#c98a5b", hair: "#3a2a1a", shirt: "#4a6ea8",
      pants: "#3d4450", accent: "#2e2a26",
    });
    this.setColors(colors);
  }

  /** Absent/undefined roles keep their current colour — Appearance.pants and
   *  friends are optional, and spreading them over defaults would erase them. */
  setColors(c: RigColors) {
    for (const [role, hex] of Object.entries(c)) {
      if (!hex) continue;
      for (const mat of this.byRole.get(role) ?? []) mat.color.set(hex);
    }
  }

  /**
   * Attach (or clear, with null) an equipment mesh. Because it parents to a
   * shared bone at a shared rest transform, the same mesh fits every character.
   */
  equip(slot: EquipSlot, mesh: THREE.Object3D | null) {
    const prev = this.equipped.get(slot);
    if (prev) { prev.removeFromParent(); this.equipped.delete(slot); }
    if (!mesh) return;
    this.bones[SLOT_BONE[slot]].add(mesh);
    this.equipped.set(slot, mesh);
  }

  /** Face the given world heading (radians, 0 = +x/east). */
  setHeading(rad: number) {
    this.root.rotation.y = -rad + Math.PI / 2;
  }

  /** Advance the procedural pose. `speed` is in tiles/sec. */
  update(dt: number, state: AnimState, speed: number) {
    const b = this.bones;
    const cadence = state === "run" ? 11 : state === "walk" ? 7 : 0;
    this.phase += dt * (cadence > 0 ? cadence : 2.2);
    const t = this.phase;

    // Reset the bones the poses drive; anything untouched stays at rest.
    b.torso.rotation.set(0, 0, 0);
    b.hips.position.y = REST.hips[1];
    for (const n of ["armL", "armR", "forearmL", "forearmR", "legL", "legR", "shinL", "shinR"] as BoneName[]) {
      b[n].rotation.set(0, 0, 0);
    }

    if (state === "walk" || state === "run") {
      const amp = state === "run" ? 0.95 : 0.6;
      const s = Math.sin(t), c = Math.cos(t);
      b.legL.rotation.x = s * amp;
      b.legR.rotation.x = -s * amp;
      b.shinL.rotation.x = Math.max(0, -s) * amp * 0.9;
      b.shinR.rotation.x = Math.max(0, s) * amp * 0.9;
      b.armL.rotation.x = -s * amp * 0.75;
      b.armR.rotation.x = s * amp * 0.75;
      b.forearmL.rotation.x = -Math.max(0, -s) * 0.5;
      b.forearmR.rotation.x = -Math.max(0, s) * 0.5;
      b.torso.rotation.x = state === "run" ? 0.22 : 0.07;
      b.torso.rotation.y = c * 0.06;
      b.hips.position.y += Math.abs(c) * (state === "run" ? 0.06 : 0.03);
    } else if (state === "jump" || state === "fall") {
      const tuck = state === "jump" ? 0.7 : 0.35;
      b.legL.rotation.x = tuck; b.legR.rotation.x = tuck * 0.6;
      b.shinL.rotation.x = tuck * 0.8; b.shinR.rotation.x = tuck * 0.5;
      b.armL.rotation.x = -1.5; b.armR.rotation.x = -1.5;
      b.armL.rotation.z = 0.35; b.armR.rotation.z = -0.35;
      b.torso.rotation.x = state === "fall" ? -0.12 : 0.16;
    } else if (state === "swim") {
      const s = Math.sin(t * 1.6);
      b.torso.rotation.x = 1.15;              // prone in the water
      b.armL.rotation.x = -1.9 + s * 0.9;
      b.armR.rotation.x = -1.9 - s * 0.9;
      b.legL.rotation.x = -0.9 + s * 0.35;
      b.legR.rotation.x = -0.9 - s * 0.35;
      b.hips.position.y -= 0.35;
    } else {
      const breathe = Math.sin(t * 0.9);
      b.torso.rotation.x = 0.03 + breathe * 0.02;
      b.armL.rotation.z = 0.10; b.armR.rotation.z = -0.10;
      b.armL.rotation.x = breathe * 0.05;
      b.armR.rotation.x = -breathe * 0.05;
      b.hips.position.y += breathe * 0.012;
    }
    void speed;
  }

  dispose() {
    for (const o of this.owned) o.dispose();
    this.owned = [];
    this.root.removeFromParent();
  }
}
