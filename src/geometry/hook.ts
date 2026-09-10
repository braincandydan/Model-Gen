import * as THREE from 'three';
import { cleanupGeometry, toBrush, union, subtract } from './csg';
import { buildThreadedCylinderGeometry } from './thread';
import type { HookParams, ScrewSpec } from '../params';

/**
 * The body is built as a union of simple boxes rather than one extruded 2D profile.
 * A single concave profile (this shape has several reflex corners — the shelf notch,
 * the clamp slot) hit real winding/normal bugs in THREE.ExtrudeGeometry's side-wall
 * generation that survived even after fixing the path's overall winding direction.
 * Boxes have trivially correct normals, so this sidesteps that class of bug entirely.
 *
 * Coordinates: z_profile=0 is the front face (what hung items rest against, and what
 * touches the front of the clamped piece); z_profile increases going back into the
 * clamp's gap and back wall. World Z is the negative of that (kept for compatibility
 * with the hole-cutting code below). y=0 is the hook tip (bottom); the clamp band with
 * the screw sits at the top, per the shelf mounted "over a lip" orientation.
 */

/**
 * A box with its 4 vertical edges chamfered (an octagonal cross-section instead of a
 * square one) — softens the sharp printed edges a bit. Built directly as a ring-based
 * prism (bottom ring, top ring, side walls, two fan-triangulated caps) rather than via
 * ExtrudeGeometry: the cross-section is convex, so a simple fan from the centroid
 * triangulates it correctly with no risk of the concave-shape winding bugs hit
 * elsewhere in this file's history.
 */
function makeChamferedBox(
  width: number,
  zProfMin: number,
  zProfMax: number,
  yMin: number,
  yMax: number,
  bevel: number,
): THREE.BufferGeometry {
  const hw = width / 2;
  const zw0 = -zProfMax; // world_z = -z_profile
  const zw1 = -zProfMin;
  const b = Math.max(0, Math.min(bevel, hw * 0.9, (zw1 - zw0) * 0.45));

  const rawCorners: Array<[number, number]> =
    b > 0.001
      ? [
          [-hw + b, zw0],
          [hw - b, zw0],
          [hw, zw0 + b],
          [hw, zw1 - b],
          [hw - b, zw1],
          [-hw + b, zw1],
          [-hw, zw1 - b],
          [-hw, zw0 + b],
        ]
      : [
          [-hw, zw0],
          [hw, zw0],
          [hw, zw1],
          [-hw, zw1],
        ];
  const corners = rawCorners.slice().reverse();

  const n = corners.length;
  const bottom = corners.map(([x, z]) => new THREE.Vector3(x, yMin, z));
  const top = corners.map(([x, z]) => new THREE.Vector3(x, yMax, z));

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    pushTri(bottom[k], bottom[k2], top[k2]);
    pushTri(bottom[k], top[k2], top[k]);
  }

  const bottomCenter = new THREE.Vector3(0, yMin, 0);
  const topCenter = new THREE.Vector3(0, yMax, 0);
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    pushTri(bottomCenter, bottom[k2], bottom[k]);
    pushTri(topCenter, top[k], top[k2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export interface HookBuildResult {
  geometry: THREE.BufferGeometry;
  boss: { centerY: number; backZProfile: number };
}

export function buildHookBody(p: HookParams, screw: ScrewSpec): HookBuildResult {
  const t = p.wallThickness;
  const D = p.engagementDepth;
  const B = p.clampBandHeight;
  const H = p.hookHeight;
  const L = p.hookLipDepth;
  const curl = p.hookCurlHeight;
  const Tb = screw.backWallThickness;
  const w = p.partWidth;
  const bevel = Math.min(0.8, t * 0.25);

  const clampBottom = t + H; // arm attaches here
  const clampTop = clampBottom + B;

  const box = (zProfMin: number, zProfMax: number, yMin: number, yMax: number) =>
    makeChamferedBox(w, zProfMin, zProfMax, yMin, yMax, bevel);

  let brush = toBrush(box(-L, t, 0, t)); // shelf
  if (curl > 0) {
    brush = union(brush, toBrush(box(-L, -L + t, t, t + curl))); // end-stop
  }
  brush = union(brush, toBrush(box(0, t, t, clampTop))); // arm + front wall of clamp
  brush = union(brush, toBrush(box(0, D + t + Tb, clampTop - t, clampTop))); // floor, at the top of the band
  brush = union(brush, toBrush(box(t + D, t + D + Tb, clampBottom, clampTop))); // back wall

  const bossCenterY = clampBottom + B / 2;
  const backOuterZProfile = t + D + Tb;

  const holeMinor = screw.nominalDiameter / 2 - screw.threadDepth + screw.clearance;
  const holeMajor = screw.nominalDiameter / 2 + screw.clearance;
  const margin = 3;
  const zProfInnerStop = t + D - margin;
  const zProfOuterStop = backOuterZProfile + margin;
  const holeLength = zProfOuterStop - zProfInnerStop;

  const holeToolGeom = buildThreadedCylinderGeometry({
    minorRadius: holeMinor,
    majorRadius: holeMajor,
    pitch: screw.pitch,
    length: holeLength,
  });
  holeToolGeom.translate(0, bossCenterY, -zProfOuterStop);
  brush = subtract(brush, toBrush(holeToolGeom));

  const geometry = cleanupGeometry(brush.geometry.clone());

  return {
    geometry,
    boss: { centerY: bossCenterY, backZProfile: backOuterZProfile },
  };
}
