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

/**
 * Rounding every edge of a box independently (buildFilletWedge above) leaves a small
 * sharp ridge at every point where three edges meet: each edge's cylindrical wedge cuts
 * a quarter-round along its own two in-plane axes and simply stops (a flat end-cap) at
 * the corner, so it never removes the residual sliver where the *other* two edges' own
 * wedges also stop. The standard fix for rounding a box corner (used here as a real,
 * general pass rather than a one-off patch for whichever corner got reported) is to
 * additionally cut a sphere of the same radius at the true corner point, offset inward
 * by that radius along all three axes — exactly where each adjacent edge's own fillet
 * arc is centered, so the sphere is tangent to all of them and smooths the ridge away.
 */
function buildCornerFillet(center: THREE.Vector3, radius: number, rotation = 0): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(radius, 16, 10);
  // A retry with a plain radius nudge (see the retry loop below) doesn't change the
  // sphere's own facet directions, only their scale — so it can still land back on the
  // same numerically-unlucky near-coplanar alignment with whatever it's cutting into.
  // Rotating the tessellation itself between attempts actually moves those facet edges.
  if (rotation !== 0) geometry.rotateY(rotation);
  geometry.translate(center.x, center.y, center.z);
  return geometry;
}

type Axis = 'x' | 'y' | 'z';

/** Ties a (u, v, span) wedge parametrization to which world axis each one lands on, so a
 * wedge's own corner/inward parameters are enough to derive a full 3D corner position and
 * inward direction (see cornerDescriptors below) without any extra bookkeeping per edge. */
interface AxisMap {
  mapTo3D: (u: number, v: number, span: number) => THREE.Vector3;
  axisU: Axis;
  axisV: Axis;
  axisSpan: Axis;
}

// (x, z) in-plane, extruded along Y (vertical edges)
const mapVertical: AxisMap = { mapTo3D: (x, z, y) => new THREE.Vector3(x, y, z), axisU: 'x', axisV: 'z', axisSpan: 'y' };
// (y, z) in-plane, extruded along X (horizontal edges)
const mapHorizontal: AxisMap = { mapTo3D: (y, z, x) => new THREE.Vector3(x, y, z), axisU: 'y', axisV: 'z', axisSpan: 'x' };
// (x, y) in-plane, extruded along Z (edges running front-to-back)
const mapDepth: AxisMap = { mapTo3D: (x, y, z) => new THREE.Vector3(x, y, z), axisU: 'x', axisV: 'y', axisSpan: 'z' };

function setAxis(v: THREE.Vector3, axis: Axis, value: number): void {
  v[axis] = value;
}

interface WedgeSpec {
  // `spanNudge` extends both span ends outward slightly (harmless — the wedge already
  // only removes material inside the solid, so a touch of overshoot just gets clipped by
  // whatever real boundary is there) — see the retry loop below for why.
  build: (b: number, spanNudge?: number) => THREE.BufferGeometry;
  cornerU: number;
  uInward: 1 | -1;
  cornerV: number;
  vInward: 1 | -1;
  spanMin: number;
  spanMax: number;
  axisMap: AxisMap;
}

function makeWedge(
  cornerU: number,
  uInward: 1 | -1,
  cornerV: number,
  vInward: 1 | -1,
  axisMap: AxisMap,
  spanMin: number,
  spanMax: number,
  segments: number,
): WedgeSpec {
  return {
    build: (b, spanNudge = 0) =>
      buildFilletWedge(cornerU, uInward, cornerV, vInward, b, segments, axisMap.mapTo3D, spanMin - spanNudge, spanMax + spanNudge),
    cornerU,
    uInward,
    cornerV,
    vInward,
    spanMin,
    spanMax,
    axisMap,
  };
}

/**
 * Detects a thin sliver triangle near `center` — the signature of three-bvh-csg botching
 * a boolean when two surfaces meet at a numerically-unlucky near-coplanar angle (the same
 * class of fragility documented elsewhere in this file, just showing up as a degenerate
 * triangle instead of an out-of-bounds spike). Restricted to a small radius around the
 * cut instead of scanning the whole geometry, both to stay cheap and to avoid flagging
 * unrelated legitimately-small facets elsewhere in the model (e.g. from a small bevel).
 */
function hasThinTriangleNear(
  geom: THREE.BufferGeometry,
  center: THREE.Vector3,
  searchRadius: number,
  minArea: number,
): boolean {
  const posAttr = geom.attributes.position;
  const index = geom.index;
  const triCount = index ? index.count / 3 : posAttr.count / 3;
  const vi = (t: number, k: number) => (index ? index.getX(t * 3 + k) : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    const i0 = vi(t, 0), i1 = vi(t, 1), i2 = vi(t, 2);
    const ax = posAttr.getX(i0), ay = posAttr.getY(i0), az = posAttr.getZ(i0);
    const bx = posAttr.getX(i1), by = posAttr.getY(i1), bz = posAttr.getZ(i1);
    const cx = posAttr.getX(i2), cy = posAttr.getY(i2), cz = posAttr.getZ(i2);
    const centroidX = (ax + bx + cx) / 3, centroidY = (ay + by + cy) / 3, centroidZ = (az + bz + cz) / 3;
    if (Math.hypot(centroidX - center.x, centroidY - center.y, centroidZ - center.z) > searchRadius) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area < minArea) return true;
  }
  return false;
}

/** Both ends of a wedge's span are real 3D box corners; each end's inward direction along
 * the span axis is implied by whether the solid continues from spanMin (+1) or spanMax (-1). */
function cornerDescriptors(w: WedgeSpec): { pos: THREE.Vector3; inward: THREE.Vector3 }[] {
  const at = (span: number, spanInward: 1 | -1) => {
    const pos = w.axisMap.mapTo3D(w.cornerU, w.cornerV, span);
    const inward = new THREE.Vector3();
    setAxis(inward, w.axisMap.axisU, w.uInward);
    setAxis(inward, w.axisMap.axisV, w.vInward);
    setAxis(inward, w.axisMap.axisSpan, spanInward);
    return { pos, inward };
  };
  return [at(w.spanMin, 1), at(w.spanMax, -1)];
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
    // The shelf's top-side edge is exposed from where it meets the arm (world_z = -t)
    // out to the tip — except where the end-stop sits on top of it near the tip, which
    // covers the last `t` of that length.
    const shelfSideZStart = -t;
    const shelfSideZEnd = curl > 0 ? tipZ - t : tipZ;
    const gapInnerZ = -(t + D); // world_z where the back wall's inner (gap-facing) face sits
    const floorBottomY = clampTop - t; // underside of the floor's cantilevered overhang

    const wedges: WedgeSpec[] = [
      // front-left / front-right, running the full arm height
      makeWedge(hw, -1, frontZ, -1, mapVertical, t, clampTop, filletSegments),
      makeWedge(-hw, 1, frontZ, -1, mapVertical, t, clampTop, filletSegments),
      // tip-left / tip-right, running the full shelf + end-stop height
      makeWedge(hw, -1, tipZ, -1, mapVertical, 0, t + curl, filletSegments),
      makeWedge(-hw, 1, tipZ, -1, mapVertical, 0, t + curl, filletSegments),
      // back-left / back-right, running the full back-wall height
      makeWedge(hw, -1, backZ, 1, mapVertical, clampBottom, clampTop, filletSegments),
      makeWedge(-hw, 1, backZ, 1, mapVertical, clampBottom, clampTop, filletSegments),
      // top-front / top-back, running the full width
      makeWedge(clampTop, -1, frontZ, -1, mapHorizontal, -hw, hw, filletSegments),
      makeWedge(clampTop, -1, backZ, 1, mapHorizontal, -hw, hw, filletSegments),
      // top-left / top-right of the clamp block, running the full depth of the band
      makeWedge(hw, -1, clampTop, -1, mapDepth, backZ, frontZ, filletSegments),
      makeWedge(-hw, 1, clampTop, -1, mapDepth, backZ, frontZ, filletSegments),
      // shelf-left / shelf-right, running the lip's exposed length (its top-side edge)
      makeWedge(hw, -1, t, -1, mapDepth, shelfSideZStart, shelfSideZEnd, filletSegments),
      makeWedge(-hw, 1, t, -1, mapDepth, shelfSideZStart, shelfSideZEnd, filletSegments),
      // back-wall-inner-left / -right: where the back wall's gap-facing inner face meets
      // its own side face (separate from back-left/right, which is its far outer corner)
      makeWedge(hw, -1, gapInnerZ, -1, mapVertical, clampBottom, floorBottomY, filletSegments),
      makeWedge(-hw, 1, gapInnerZ, -1, mapVertical, clampBottom, floorBottomY, filletSegments),
      // back-wall-bottom-left / -right: the underside of the back wall, which isn't backed
      // by anything below it
      makeWedge(hw, -1, clampBottom, 1, mapDepth, backZ, gapInnerZ, filletSegments),
      makeWedge(-hw, 1, clampBottom, 1, mapDepth, backZ, gapInnerZ, filletSegments),
      // arm/shelf-back-left / -right: the other long side edge, opposite frontZ — this
      // and the next two pairs are the ones opposite an already-beveled face across a
      // `t`-thick wall (see the bevelMax comment above for why they use the same,
      // already-safe `bevel` rather than a separately-shrunk amount)
      makeWedge(hw, -1, -t, 1, mapVertical, 0, floorBottomY, filletSegments),
      makeWedge(-hw, 1, -t, 1, mapVertical, 0, floorBottomY, filletSegments),
      // shelf-bottom-left / -right: the lip's underside side edge
      makeWedge(hw, -1, 0, 1, mapDepth, shelfSideZStart, tipZ, filletSegments),
      makeWedge(-hw, 1, 0, 1, mapDepth, shelfSideZStart, tipZ, filletSegments),
      // floor-bottom-left / -right: the underside of the floor's cantilevered overhang
      makeWedge(hw, -1, floorBottomY, 1, mapDepth, gapInnerZ, -t, filletSegments),
      makeWedge(-hw, 1, floorBottomY, 1, mapDepth, gapInnerZ, -t, filletSegments),
    ];

    if (curl > 0) {
      // end-stop-left / end-stop-right, covering the short length the shelf bevel above leaves out
      wedges.push(
        makeWedge(hw, -1, t + curl, -1, mapDepth, tipZ - t, tipZ, filletSegments),
        makeWedge(-hw, 1, t + curl, -1, mapDepth, tipZ - t, tipZ, filletSegments),
        // end-stop-back-left / -right: its own back vertical edge, between the shelf-top
        // bevel (below) and the end-stop-top bevel (above)
        makeWedge(hw, -1, tipZ - t, 1, mapVertical, t, t + curl, filletSegments),
        makeWedge(-hw, 1, tipZ - t, 1, mapVertical, t, t + curl, filletSegments),
      );
    }
    // three-bvh-csg is documented elsewhere in this file as fragile for complex
    // geometry, and with this many sequential wedge cuts it occasionally proves it:
    // at isolated, seemingly arbitrary bevel values (not a pattern tied to any
    // particular margin — confirmed by sweeping the whole range) a single wedge
    // subtraction produces a degenerate result that spikes far outside the model's
    // real bounds, instead of the small local cut it's supposed to be. Since which
    // wedge and which value is unpredictable, guard generically: after each cut,
    // check the result against the model's own known bounds (with a small tolerance
    // for the rounding the bevel itself is supposed to add). A rejected cut is
    // retried with the bevel nudged by a fraction of a percent — these failures are
    // exact numerical coincidences (confirmed by the sweep), so a tiny perturbation
    // almost always produces a visually-identical but numerically distinct cut that
    // succeeds, rather than just leaving that one edge sharp.
    const maxBoundsGrowth = bevel + 0.5;
    const expectedBounds = { maxX: hw, minX: -hw, maxY: clampTop, maxZ: tipZ, minZ: backZ };
    const isInBounds = (geom: THREE.BufferGeometry) => {
      geom.computeBoundingBox();
      const bb = geom.boundingBox!;
      return (
        bb.max.x <= expectedBounds.maxX + maxBoundsGrowth &&
        bb.min.x >= expectedBounds.minX - maxBoundsGrowth &&
        bb.max.y <= expectedBounds.maxY + maxBoundsGrowth &&
        bb.max.z <= expectedBounds.maxZ + maxBoundsGrowth &&
        bb.min.z >= expectedBounds.minZ - maxBoundsGrowth
      );
    };
    // Each attempt varies bevel scale, position, and span length together — three
    // different numbers behind the same visual cut, any one of which can flip
    // three-bvh-csg's boolean from silently failing to succeeding at a given absolute
    // position in space (all three confirmed directly, independently of one another).
    // Scale is only ever nudged down beyond 1.05, never up, since bevel is already capped
    // at half the wall thickness and scaling further would let opposite faces' bevels
    // overlap and break the cut outright instead of dodging a coincidence.
    const retryAttempts: { scale: number; jitter: [number, number, number]; spanNudge: number }[] = [
      { scale: 1, jitter: [0, 0, 0], spanNudge: 0 },
      { scale: 0.995, jitter: [0, 0, 0], spanNudge: 0 },
      { scale: 1.005, jitter: [0, 0, 0], spanNudge: 0 },
      { scale: 0.99, jitter: [0.05, 0, 0.05], spanNudge: 0.05 },
      { scale: 1.01, jitter: [-0.05, 0, -0.05], spanNudge: 0.05 },
      { scale: 0.98, jitter: [0, 0.05, 0], spanNudge: 0.1 },
      { scale: 1.02, jitter: [0, -0.05, 0], spanNudge: 0.1 },
      { scale: 0.95, jitter: [0.1, 0, 0.1], spanNudge: 0.2 },
      { scale: 1.05, jitter: [-0.1, 0, -0.1], spanNudge: 0.2 },
    ];
    const trianglesOf = (geom: THREE.BufferGeometry) => (geom.index ? geom.index.count : geom.attributes.position.count) / 3;
    for (const wedge of wedges) {
      const beforeTris = trianglesOf(brush.geometry);
      for (const { scale, jitter, spanNudge } of retryAttempts) {
        const geom = wedge.build(bevel * scale, spanNudge);
        const [jx, jy, jz] = jitter;
        if (jx || jy || jz) geom.translate(jx, jy, jz);
        const candidate = subtract(brush, toBrush(geom));
        // three-bvh-csg can also silently no-op a subtraction (a near-degenerate/
        // coincident intersection) — bounds trivially pass when nothing changed, so also
        // require the cut to have actually added a meaningful number of facets. This
        // won't catch every partial-cut failure (occasionally one edge stays sharp at a
        // specific bevel value despite this), but a stricter per-triangle check here cost
        // several seconds per rebuild for a modest gain, which isn't a fair trade for an
        // interactive slider.
        const grewMeaningfully = trianglesOf(candidate.geometry) > beforeTris + 2;
        if (isInBounds(candidate.geometry) && grewMeaningfully) {
          brush = candidate;
          break;
        }
        // last attempt failed too — that edge stays sharp for this exact configuration
      }
    }

    // Corner pass: a wedge's span endpoint is only a genuine 3-face box corner when a
    // *different* edge's wedge also terminates there — a point where only one wedge ends
    // is instead a T-junction, where a perpendicular edge merges into an otherwise
    // continuous edge that just happens to run through that point without its own
    // endpoint there (e.g. the shelf-top edge meeting the arm's back edge partway along
    // its length). Cutting a corner-rounding sphere at a T-junction is wrong — there's no
    // third face terminating there for it to blend into — so corners are only kept when
    // at least two independent wedges agree on both the position and the inward
    // direction; a single contributor, or two that disagree, is left alone.
    const cornersByKey = new Map<string, { pos: THREE.Vector3; inward: THREE.Vector3; count: number; consistent: boolean }>();
    for (const wedge of wedges) {
      for (const c of cornerDescriptors(wedge)) {
        const key = `${c.pos.x.toFixed(3)},${c.pos.y.toFixed(3)},${c.pos.z.toFixed(3)}`;
        const existing = cornersByKey.get(key);
        if (!existing) {
          cornersByKey.set(key, { pos: c.pos, inward: c.inward, count: 1, consistent: true });
        } else {
          existing.count++;
          if (!existing.inward.equals(c.inward)) existing.consistent = false;
        }
      }
    }
    const corners = Array.from(cornersByKey.entries()).filter(([, c]) => c.count >= 2 && c.consistent);
    const cornerRetryScales = [1, 0.995, 1.005, 0.99, 1.01, 0.98, 1.02, 0.95, 1.05];
    for (const [, { pos, inward }] of corners) {
      for (const [scaleIdx, scale] of cornerRetryScales.entries()) {
        const r = bevel * scale;
        // Unlike the plain radius nudge above, rotating the sphere's own tessellation
        // between attempts actually moves its facet edges, giving a real chance of
        // dodging a near-coplanar coincidence that a radius-only change wouldn't.
        const rotation = (scaleIdx * 0.41) % (Math.PI / 2);
        const center = pos.clone().addScaledVector(inward, r);
        const candidate = subtract(brush, toBrush(buildCornerFillet(center, r, rotation)));
        if (isInBounds(candidate.geometry) && !hasThinTriangleNear(candidate.geometry, center, r * 3, r * r * 1e-4)) {
          brush = candidate;
          break;
        }
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
