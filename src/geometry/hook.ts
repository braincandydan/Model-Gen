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
 * A chamfered-box variant (octagonal cross-section, for a print-friendly bevel) was
 * tried here and reverted: baking the bevel into each box *before* the unions made the
 * union sequence produce a large, clearly-wrong stray triangle bridging across the open
 * clamp slot. The bevel below is instead cut as a final pass of simple, independent
 * corner-wedge subtractions against the already-correct, already-unioned solid — much
 * better-conditioned for the CSG library than folding it into the unions themselves.
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

/** Tetrahedron-sum signed volume of a triangle soup (closed, consistently-wound). */
function signedVolume(positions: number[]): number {
  let vol = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
    const bx = positions[i + 3], by = positions[i + 4], bz = positions[i + 5];
    const cx = positions[i + 6], cy = positions[i + 7], cz = positions[i + 8];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/**
 * Reverses every triangle's winding if the solid's signed volume is negative, so the
 * result always has outward-facing normals. This replaces hand-derived per-case winding
 * fixes (which were repeatedly a source of bugs in this file) with a self-checking one.
 */
function fixWinding(positions: number[]): number[] {
  if (signedVolume(positions) >= 0) return positions;
  const fixed: number[] = [];
  for (let i = 0; i < positions.length; i += 9) {
    fixed.push(
      positions[i], positions[i + 1], positions[i + 2],
      positions[i + 6], positions[i + 7], positions[i + 8],
      positions[i + 3], positions[i + 4], positions[i + 5],
    );
  }
  return fixed;
}

/**
 * A cutting tool for a rounded (filleted) edge, approximated by `segments` flat facets
 * rather than one 45-degree chamfer cut — a single flat facet reads as an obvious hard
 * bevel and doesn't behave like a print-friendly rounded edge, so this traces a quarter
 * circle of radius `bevel` from corner (cornerU, cornerV) instead, with the solid
 * extending `uInward`/`vInward` (±1) from that corner in the two in-plane axes. `mapTo3D`
 * places the (u, v, span) parametrization into world space, so this one function serves
 * both the vertical edges (extruded along Y) and horizontal edges (extruded along X) —
 * see the call sites below.
 */
function buildFilletWedge(
  cornerU: number,
  uInward: 1 | -1,
  cornerV: number,
  vInward: 1 | -1,
  bevel: number,
  segments: number,
  mapTo3D: (u: number, v: number, span: number) => THREE.Vector3,
  spanMin: number,
  spanMax: number,
): THREE.BufferGeometry {
  const pts: [number, number][] = [[cornerU, cornerV]];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * (Math.PI / 2);
    const u = cornerU + uInward * bevel * (1 - Math.sin(theta));
    const v = cornerV + vInward * bevel * (1 - Math.cos(theta));
    pts.push([u, v]);
  }
  const n = pts.length;
  const bottom = pts.map(([u, v]) => mapTo3D(u, v, spanMin));
  const top = pts.map(([u, v]) => mapTo3D(u, v, spanMax));

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    pushTri(bottom[i], bottom[j], top[j]);
    pushTri(bottom[i], top[j], top[i]);
  }
  for (let i = 1; i < n - 1; i++) pushTri(bottom[0], bottom[i + 1], bottom[i]);
  for (let i = 1; i < n - 1; i++) pushTri(top[0], top[i], top[i + 1]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(fixWinding(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

export interface HookBuildResult {
  geometry: THREE.BufferGeometry;
  boss: { centerY: number; backZProfile: number };
  appliedBevel: number; // the bevel actually cut, after capping to what the wall thickness allows
  bevelMax: number; // the cap itself, so the UI can explain why the slider got reduced
}

export function buildHookBody(p: HookParams, screw: ScrewSpec): HookBuildResult {
  const t = p.wallThickness;
  const D = p.engagementDepth;
  const B = Math.max(p.clampBandHeight, screw.clampBandHeightMin); // wide screws need a taller band to stay enclosed
  const H = p.hookHeight;
  const L = p.hookLipDepth;
  const curl = p.hookCurlHeight;
  const Tb = screw.backWallThickness;
  const w = p.partWidth;
  const hw = w / 2;

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

  // Final bevel pass: chamfer the primary exposed edges. Each cut is an independent
  // subtraction of a small, simple wedge against the now-correct solid, not baked into
  // the boxes before the unions above (see the top-of-file note on why). The bevel size
  // is user-controlled (0 = skip this whole pass, sharp corners everywhere) but capped
  // so it can never exceed what the current wall thickness can safely take.
  //
  // Some edges (the arm's front vs. back, the shelf's top vs. bottom, the floor's top
  // vs. bottom) are opposite faces of a wall that's only `t` thick — bevel-ing both
  // needs 2*bevel to fit inside that wall, or the two cuts overlap and break the CSG
  // subtraction. Capping every edge to half of that (rather than giving the "front"
  // edges a bigger bevel and the "back" edges a shrinking leftover) means one uniform
  // bevel size everywhere that's never at risk of one side losing its bevel as the
  // slider goes up — the earlier version had exactly that bug: the opposite-face edges'
  // bevel shrank toward zero as the main bevel approached its own, larger cap.
  const bevelMax = Math.max(0, (t - 0.3) / 2);
  const bevel = Math.min(p.hookBevel, bevelMax);
  const filletSegments = 4; // faceted quarter-circle approximation, not a single flat chamfer
  const tipZ = L; // world_z of the shelf/end-stop tip
  const frontZ = 0; // world_z of the arm/floor's front face
  const backZ = -(t + D + Tb); // world_z of the back wall's outer face

  if (bevel > 0.01) {
    // (x, z) in-plane, extruded along Y (vertical edges)
    const mapVertical = (x: number, z: number, y: number) => new THREE.Vector3(x, y, z);
    // (y, z) in-plane, extruded along X (horizontal edges)
    const mapHorizontal = (y: number, z: number, x: number) => new THREE.Vector3(x, y, z);
    // (x, y) in-plane, extruded along Z (edges running front-to-back, e.g. the top-side
    // edges of the clamp block and the sides of the hook's lip) — the vertical/horizontal
    // wedges above bevel edges where the extrusion runs along Y or X, but every long edge
    // that instead runs along Z (front-to-back) was missing this pass entirely, leaving
    // the flat top/side face's sharp corner running the full depth past where the front
    // and back bevels stop.
    const mapDepth = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

    // The shelf's top-side edge is exposed from where it meets the arm (world_z = -t)
    // out to the tip — except where the end-stop sits on top of it near the tip, which
    // covers the last `t` of that length.
    const shelfSideZStart = -t;
    const shelfSideZEnd = curl > 0 ? tipZ - t : tipZ;
    const gapInnerZ = -(t + D); // world_z where the back wall's inner (gap-facing) face sits
    const floorBottomY = clampTop - t; // underside of the floor's cantilevered overhang

    const wedges: THREE.BufferGeometry[] = [
      // front-left / front-right, running the full arm height
      buildFilletWedge(hw, -1, frontZ, -1, bevel, filletSegments, mapVertical, t, clampTop),
      buildFilletWedge(-hw, 1, frontZ, -1, bevel, filletSegments, mapVertical, t, clampTop),
      // tip-left / tip-right, running the full shelf + end-stop height
      buildFilletWedge(hw, -1, tipZ, -1, bevel, filletSegments, mapVertical, 0, t + curl),
      buildFilletWedge(-hw, 1, tipZ, -1, bevel, filletSegments, mapVertical, 0, t + curl),
      // back-left / back-right, running the full back-wall height
      buildFilletWedge(hw, -1, backZ, 1, bevel, filletSegments, mapVertical, clampBottom, clampTop),
      buildFilletWedge(-hw, 1, backZ, 1, bevel, filletSegments, mapVertical, clampBottom, clampTop),
      // top-front / top-back, running the full width
      buildFilletWedge(clampTop, -1, frontZ, -1, bevel, filletSegments, mapHorizontal, -hw, hw),
      buildFilletWedge(clampTop, -1, backZ, 1, bevel, filletSegments, mapHorizontal, -hw, hw),
      // top-left / top-right of the clamp block, running the full depth of the band
      buildFilletWedge(hw, -1, clampTop, -1, bevel, filletSegments, mapDepth, backZ, frontZ),
      buildFilletWedge(-hw, 1, clampTop, -1, bevel, filletSegments, mapDepth, backZ, frontZ),
      // shelf-left / shelf-right, running the lip's exposed length (its top-side edge)
      buildFilletWedge(hw, -1, t, -1, bevel, filletSegments, mapDepth, shelfSideZStart, shelfSideZEnd),
      buildFilletWedge(-hw, 1, t, -1, bevel, filletSegments, mapDepth, shelfSideZStart, shelfSideZEnd),
      // back-wall-inner-left / -right: where the back wall's gap-facing inner face meets
      // its own side face (separate from back-left/right, which is its far outer corner)
      buildFilletWedge(hw, -1, gapInnerZ, -1, bevel, filletSegments, mapVertical, clampBottom, floorBottomY),
      buildFilletWedge(-hw, 1, gapInnerZ, -1, bevel, filletSegments, mapVertical, clampBottom, floorBottomY),
      // back-wall-bottom-left / -right: the underside of the back wall, which isn't backed
      // by anything below it
      buildFilletWedge(hw, -1, clampBottom, 1, bevel, filletSegments, mapDepth, backZ, gapInnerZ),
      buildFilletWedge(-hw, 1, clampBottom, 1, bevel, filletSegments, mapDepth, backZ, gapInnerZ),
      // arm/shelf-back-left / -right: the other long side edge, opposite frontZ — this
      // and the next two pairs are the ones opposite an already-beveled face across a
      // `t`-thick wall (see the bevelMax comment above for why they use the same,
      // already-safe `bevel` rather than a separately-shrunk amount)
      buildFilletWedge(hw, -1, -t, 1, bevel, filletSegments, mapVertical, 0, floorBottomY),
      buildFilletWedge(-hw, 1, -t, 1, bevel, filletSegments, mapVertical, 0, floorBottomY),
      // shelf-bottom-left / -right: the lip's underside side edge
      buildFilletWedge(hw, -1, 0, 1, bevel, filletSegments, mapDepth, shelfSideZStart, tipZ),
      buildFilletWedge(-hw, 1, 0, 1, bevel, filletSegments, mapDepth, shelfSideZStart, tipZ),
      // floor-bottom-left / -right: the underside of the floor's cantilevered overhang
      buildFilletWedge(hw, -1, floorBottomY, 1, bevel, filletSegments, mapDepth, gapInnerZ, -t),
      buildFilletWedge(-hw, 1, floorBottomY, 1, bevel, filletSegments, mapDepth, gapInnerZ, -t),
    ];

    if (curl > 0) {
      // end-stop-left / end-stop-right, covering the short length the shelf bevel above leaves out
      wedges.push(
        buildFilletWedge(hw, -1, t + curl, -1, bevel, filletSegments, mapDepth, tipZ - t, tipZ),
        buildFilletWedge(-hw, 1, t + curl, -1, bevel, filletSegments, mapDepth, tipZ - t, tipZ),
        // end-stop-back-left / -right: its own back vertical edge, between the shelf-top
        // bevel (below) and the end-stop-top bevel (above)
        buildFilletWedge(hw, -1, tipZ - t, 1, bevel, filletSegments, mapVertical, t, t + curl),
        buildFilletWedge(-hw, 1, tipZ - t, 1, bevel, filletSegments, mapVertical, t, t + curl),
      );
    }
    // three-bvh-csg is documented elsewhere in this file as fragile for complex
    // geometry, and with this many sequential wedge cuts it occasionally proves it:
    // at isolated, seemingly arbitrary bevel values (not a pattern tied to any
    // particular margin — confirmed by sweeping the whole range) a single wedge
    // subtraction produces a degenerate result that spikes far outside the model's
    // real bounds, instead of the small local cut it's supposed to be. Since which
    // wedge and which value is unpredictable, guard generically: after each cut,
    // reject it and keep the solid as it was if the result has grown past the
    // model's own known bounds (with a small tolerance for the rounding the bevel
    // itself is supposed to add) — a rare edge staying sharp beats a broken part.
    const maxBoundsGrowth = bevel + 0.5;
    const expectedBounds = { maxX: hw, minX: -hw, maxY: clampTop, maxZ: tipZ, minZ: backZ };
    for (const wedge of wedges) {
      const candidate = subtract(brush, toBrush(wedge));
      const cb = candidate.geometry;
      cb.computeBoundingBox();
      const bb = cb.boundingBox!;
      const inBounds =
        bb.max.x <= expectedBounds.maxX + maxBoundsGrowth &&
        bb.min.x >= expectedBounds.minX - maxBoundsGrowth &&
        bb.max.y <= expectedBounds.maxY + maxBoundsGrowth &&
        bb.max.z <= expectedBounds.maxZ + maxBoundsGrowth &&
        bb.min.z >= expectedBounds.minZ - maxBoundsGrowth;
      if (inBounds) {
        brush = candidate;
      }
    }
  }

  const geometry = cleanupGeometry(brush.geometry.clone());

  return {
    geometry,
    boss: { centerY: bossCenterY, backZProfile: backOuterZProfile },
    appliedBevel: bevel,
    bevelMax,
  };
}
