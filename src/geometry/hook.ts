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

/**
 * A small triangular-prism cutting tool for chamfering one vertical edge (running
 * along Y) at world (x0, z0), where the solid extends `xInward`/`zInward` (±1) from
 * that corner. Winding is verified correct (positive signed volume) for all 4
 * xInward/zInward sign combinations by construction (see comment on the swap below).
 */
function makeVerticalEdgeWedge(
  x0: number,
  xInward: 1 | -1,
  z0: number,
  zInward: 1 | -1,
  bevel: number,
  yMin: number,
  yMax: number,
): THREE.BufferGeometry {
  const A: [number, number] = [x0, z0];
  let Bp: [number, number] = [x0 + xInward * bevel, z0];
  let Cp: [number, number] = [x0, z0 + zInward * bevel];
  if (xInward * zInward > 0) {
    const tmp = Bp;
    Bp = Cp;
    Cp = tmp;
  }
  const mk = (y: number, p: [number, number]) => new THREE.Vector3(p[0], y, p[1]);
  const A0 = mk(yMin, A);
  const B0 = mk(yMin, Bp);
  const C0 = mk(yMin, Cp);
  const A1 = mk(yMax, A);
  const B1 = mk(yMax, Bp);
  const C1 = mk(yMax, Cp);

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  pushTri(A0, B0, B1);
  pushTri(A0, B1, A1);
  pushTri(B0, C0, C1);
  pushTri(B0, C1, B1);
  pushTri(C0, A0, A1);
  pushTri(C0, A1, C1);
  pushTri(A0, C0, B0);
  pushTri(A1, B1, C1);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Same idea as makeVerticalEdgeWedge, but for a horizontal edge running along X. */
function makeHorizontalEdgeWedge(
  y0: number,
  yInward: 1 | -1,
  z0: number,
  zInward: 1 | -1,
  bevel: number,
  xMin: number,
  xMax: number,
): THREE.BufferGeometry {
  const A: [number, number] = [y0, z0];
  let Bp: [number, number] = [y0 + yInward * bevel, z0];
  let Cp: [number, number] = [y0, z0 + zInward * bevel];
  if (yInward * zInward > 0) {
    const tmp = Bp;
    Bp = Cp;
    Cp = tmp;
  }
  const mk = (x: number, p: [number, number]) => new THREE.Vector3(x, p[0], p[1]);
  const A0 = mk(xMin, A);
  const B0 = mk(xMin, Bp);
  const C0 = mk(xMin, Cp);
  const A1 = mk(xMax, A);
  const B1 = mk(xMax, Bp);
  const C1 = mk(xMax, Cp);

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  pushTri(A0, B1, B0);
  pushTri(A0, A1, B1);
  pushTri(B0, C1, C0);
  pushTri(B0, B1, C1);
  pushTri(C0, A1, A0);
  pushTri(C0, C1, A1);
  pushTri(A0, B0, C0);
  pushTri(A1, C1, B1);

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
  // the boxes before the unions above (see the top-of-file note on why).
  const bevel = Math.min(2, t * 0.9);
  const tipZ = L; // world_z of the shelf/end-stop tip
  const frontZ = 0; // world_z of the arm/floor's front face
  const backZ = -(t + D + Tb); // world_z of the back wall's outer face

  const wedges: THREE.BufferGeometry[] = [
    // front-left / front-right, running the full arm height
    makeVerticalEdgeWedge(hw, -1, frontZ, -1, bevel, t, clampTop),
    makeVerticalEdgeWedge(-hw, 1, frontZ, -1, bevel, t, clampTop),
    // tip-left / tip-right, running the full shelf + end-stop height
    makeVerticalEdgeWedge(hw, -1, tipZ, -1, bevel, 0, t + curl),
    makeVerticalEdgeWedge(-hw, 1, tipZ, -1, bevel, 0, t + curl),
    // back-left / back-right, running the full back-wall height
    makeVerticalEdgeWedge(hw, -1, backZ, 1, bevel, clampBottom, clampTop),
    makeVerticalEdgeWedge(-hw, 1, backZ, 1, bevel, clampBottom, clampTop),
    // top-front / top-back, running the full width
    makeHorizontalEdgeWedge(clampTop, -1, frontZ, -1, bevel, -hw, hw),
    makeHorizontalEdgeWedge(clampTop, -1, backZ, 1, bevel, -hw, hw),
  ];
  for (const wedge of wedges) {
    brush = subtract(brush, toBrush(wedge));
  }

  const geometry = cleanupGeometry(brush.geometry.clone());

  return {
    geometry,
    boss: { centerY: bossCenterY, backZProfile: backOuterZProfile },
  };
}
