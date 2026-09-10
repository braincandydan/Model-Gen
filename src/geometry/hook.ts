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
 * A chamfered-box variant (octagonal cross-section, for a slight print-friendly bevel)
 * was tried here and reverted: it made the sequence of unions below produce a large,
 * clearly-wrong stray triangle bridging across the open clamp slot, and a bit of extra
 * overlap at the seams didn't fix it. Plain boxes are what's verified correct.
 *
 * Coordinates: z_profile=0 is the front face (what hung items rest against, and what
 * touches the front of the clamped piece); z_profile increases going back into the
 * clamp's gap and back wall. World Z is the negative of that (kept for compatibility
 * with the hole-cutting code below). y=0 is the hook tip (bottom); the clamp band with
 * the screw sits at the top, per the shelf mounted "over a lip" orientation.
 */
function makeBox(width: number, zProfMin: number, zProfMax: number, yMin: number, yMax: number): THREE.BufferGeometry {
  const geom = new THREE.BoxGeometry(width, yMax - yMin, zProfMax - zProfMin);
  geom.translate(0, (yMin + yMax) / 2, -(zProfMin + zProfMax) / 2);
  return geom;
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

  // clampOffset adds extra plain arm above the hook's own reach before the clamp
  // starts; 0 (the default/minimum) puts the clamp as close to the hook as possible,
  // which is the strongest/most leverage-favorable position — moving it up trades some
  // of that away, so it's capped (see PARAM_LIMITS) rather than left open-ended.
  const clampBottom = t + H + p.clampOffset;
  const clampTop = clampBottom + B;

  let brush = toBrush(makeBox(w, -L, t, 0, t)); // shelf
  if (curl > 0) {
    brush = union(brush, toBrush(makeBox(w, -L, -L + t, t, t + curl))); // end-stop
  }
  brush = union(brush, toBrush(makeBox(w, 0, t, t, clampTop))); // arm + front wall of clamp
  brush = union(brush, toBrush(makeBox(w, 0, D + t + Tb, clampTop - t, clampTop))); // floor, at the top of the band
  brush = union(brush, toBrush(makeBox(w, t + D, t + D + Tb, clampBottom, clampTop))); // back wall

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
