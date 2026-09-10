import * as THREE from 'three';
import { cleanupGeometry, toBrush, union } from './csg';
import type { Brush } from 'three-bvh-csg';

const OVERLAP = 0.15; // mm interpenetration used when CSG-unioning separate solids (tip/head)

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

function trapezoidBump(minorRadius: number, majorRadius: number, pitch: number, crestFraction: number) {
  const threadDepth = majorRadius - minorRadius;
  const flank = (pitch * (1 - crestFraction)) / 2;
  const crestStart = flank;
  const crestEnd = pitch - flank;
  return (s: number): number => {
    if (s < crestStart) return minorRadius + (s / flank) * threadDepth;
    if (s < crestEnd) return majorRadius;
    return majorRadius - ((s - crestEnd) / flank) * threadDepth;
  };
}

export interface ThreadedCylinderOptions {
  minorRadius: number; // root radius
  majorRadius: number; // crest radius
  pitch: number;
  length: number; // axial length, from z=0 to z=length
  angularSegments?: number; // points around each ring (circle resolution)
  ringsPerTurn?: number; // z-resolution, rings per full turn
  crestFraction?: number; // fraction of pitch that is a flat crest (0..1)
}

/**
 * A single-start trapezoidal-thread rod, built directly as a closed, watertight
 * "distorted cylinder": at height z and angle phi, the radius is a function of
 * (z - phi*pitch/2pi) mod pitch. Every (z, phi) is visited exactly once, so unlike
 * a naive helix-sweep-with-closing-edge approach this cannot self-overlap.
 */
export function buildThreadedCylinderGeometry(o: ThreadedCylinderOptions): THREE.BufferGeometry {
  const N = o.angularSegments ?? 32;
  const ringsPerTurn = o.ringsPerTurn ?? 24;
  const crestFraction = o.crestFraction ?? 0.4;
  const bumpRadius = trapezoidBump(o.minorRadius, o.majorRadius, o.pitch, crestFraction);

  const totalTurns = o.length / o.pitch;
  const numRings = Math.max(2, Math.round(totalTurns * ringsPerTurn) + 1);

  const rings: THREE.Vector3[][] = [];
  for (let i = 0; i < numRings; i++) {
    const z = (i / (numRings - 1)) * o.length;
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < N; k++) {
      const phi = (k / N) * Math.PI * 2;
      const s = mod(z - (phi * o.pitch) / (Math.PI * 2), o.pitch);
      const r = bumpRadius(s);
      ring.push(new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z));
    }
    rings.push(ring);
  }

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let i = 0; i < numRings - 1; i++) {
    const ringA = rings[i];
    const ringB = rings[i + 1];
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      pushTri(ringA[k], ringA[k2], ringB[k2]);
      pushTri(ringA[k], ringB[k2], ringB[k]);
    }
  }

  const startCenter = new THREE.Vector3(0, 0, 0);
  const first = rings[0];
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(startCenter, first[k2], first[k]);
  }

  const endCenter = new THREE.Vector3(0, 0, o.length);
  const last = rings[numRings - 1];
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(endCenter, last[k], last[k2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

interface CappedCylinderOptions {
  radiusFn: (phi: number) => number; // radius at angle phi, before any bevel taper
  length: number;
  topBevel?: number; // rounds the z=length edge — 0/undefined = sharp flat cap
  bottomBevel?: number; // rounds the z=0 edge
  angularSegments?: number;
  bevelSegments?: number; // arc facets per rounded edge, same idea as the hook's fillets
}

/**
 * A cylinder (or, via radiusFn, a ribbed/knurled one) with each flat end either left as
 * a sharp cap or rounded off with a quarter-circle fillet — the same faceted-arc idea as
 * the hook's edge bevels, just revolved around an axis instead of extruded along one.
 * Built the same ring/cap way as buildThreadedCylinderGeometry, so it inherits the same
 * verified-correct (outward-facing) winding.
 */
function buildCappedCylinderGeometry(o: CappedCylinderOptions): THREE.BufferGeometry {
  const N = o.angularSegments ?? 64;
  const bevelSegs = o.bevelSegments ?? 4;
  const topBevel = o.topBevel ?? 0;
  const bottomBevel = o.bottomBevel ?? 0;

  // (z, delta) pairs from bottom to top, where delta is how much to subtract from
  // radiusFn(phi) at that z — 0 through the flat middle, tapering up to the full bevel
  // right at a rounded cap (theta=0 there matches the cap; theta=PI/2 matches the side).
  const zDelta: { z: number; delta: number }[] = [];
  if (bottomBevel > 0.001) {
    for (let i = 0; i <= bevelSegs; i++) {
      const theta = (i / bevelSegs) * (Math.PI / 2);
      zDelta.push({ z: bottomBevel * (1 - Math.cos(theta)), delta: bottomBevel * (1 - Math.sin(theta)) });
    }
  } else {
    zDelta.push({ z: 0, delta: 0 });
  }
  if (topBevel > 0.001) {
    for (let i = bevelSegs; i >= 0; i--) {
      const theta = (i / bevelSegs) * (Math.PI / 2);
      zDelta.push({ z: o.length - topBevel * (1 - Math.cos(theta)), delta: topBevel * (1 - Math.sin(theta)) });
    }
  } else {
    zDelta.push({ z: o.length, delta: 0 });
  }

  const rings: THREE.Vector3[][] = zDelta.map(({ z, delta }) => {
    const ring: THREE.Vector3[] = [];
    for (let k = 0; k < N; k++) {
      const phi = (k / N) * Math.PI * 2;
      const r = Math.max(0, o.radiusFn(phi) - delta);
      ring.push(new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z));
    }
    return ring;
  });

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let i = 0; i < rings.length - 1; i++) {
    const ringA = rings[i];
    const ringB = rings[i + 1];
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      pushTri(ringA[k], ringA[k2], ringB[k2]);
      pushTri(ringA[k], ringB[k2], ringB[k]);
    }
  }

  const bottomRing = rings[0];
  const bottomCenter = new THREE.Vector3(0, 0, zDelta[0].z);
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(bottomCenter, bottomRing[k2], bottomRing[k]);
  }

  const topRing = rings[rings.length - 1];
  const topCenter = new THREE.Vector3(0, 0, zDelta[zDelta.length - 1].z);
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(topCenter, topRing[k], topRing[k2]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

export interface ThreadedRodOptions {
  minorRadius: number;
  majorRadius: number;
  pitch: number;
  length: number;
  angularSegments?: number;
  ringsPerTurn?: number;
  tip?: boolean; // flat-point tip at z=0 (full contact against whatever it presses on, no cone digging in)
  headDiameter?: number;
  headHeight?: number;
  headRibCount?: number; // ribbed grip ridges around the head; 0/undefined = plain cylinder
  headBevel?: number; // rounds the head's top and bottom edges; 0/undefined = sharp
}

/** Threaded shaft (+ optional lead-in tip / thumb head), unioned into one solid. Axis = Z, spans [0, length] (plus head beyond `length`, plus tip slightly before 0). */
export function buildThreadedRod(o: ThreadedRodOptions): THREE.BufferGeometry {
  const shaftGeom = buildThreadedCylinderGeometry(o);
  let brush: Brush = toBrush(shaftGeom);

  if (o.tip) {
    // A short, smooth (unthreaded) flat-ended nub: gives full flat contact against
    // whatever the screw presses on, rather than a cone that would just dig a point
    // into it. Slightly narrower than the root so it's a clean flat circle, not a
    // ring left over from the thread crest's own waviness at the shaft's end.
    const tipRadius = o.minorRadius * 0.9;
    const tipLength = Math.max(o.minorRadius * 0.6, 1.5);
    const tipGeom = new THREE.CylinderGeometry(tipRadius, tipRadius, tipLength, 32);
    tipGeom.rotateX(Math.PI / 2);
    tipGeom.translate(0, 0, -tipLength / 2 + OVERLAP);
    brush = union(brush, toBrush(tipGeom));
  }

  if (o.headDiameter && o.headHeight) {
    const ribCount = o.headRibCount ?? 0;
    const headBevel = o.headBevel ?? 0;
    const headRadiusFn =
      ribCount > 0
        ? (phi: number) => o.headDiameter! / 2 + (o.headDiameter! * 0.08) / 2 * (1 + Math.cos(phi * ribCount))
        : () => o.headDiameter! / 2;
    // Already built along Z, spanning [0, headHeight] — no rotation needed.
    const headGeom = buildCappedCylinderGeometry({
      radiusFn: headRadiusFn,
      length: o.headHeight,
      topBevel: headBevel,
      bottomBevel: headBevel,
      angularSegments: ribCount > 0 ? Math.max(64, ribCount * 8) : 64,
    });
    headGeom.translate(0, 0, o.length - OVERLAP);
    brush = union(brush, toBrush(headGeom));
  }

  return cleanupGeometry(brush.geometry.clone());
}
