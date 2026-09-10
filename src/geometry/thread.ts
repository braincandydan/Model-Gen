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
  headSegments?: number; // low count = faceted "knurled" grip
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
    const headGeom = new THREE.CylinderGeometry(
      o.headDiameter / 2,
      o.headDiameter / 2,
      o.headHeight,
      o.headSegments ?? 16,
      1,
      false,
    );
    headGeom.rotateX(Math.PI / 2);
    headGeom.translate(0, 0, o.length + o.headHeight / 2 - OVERLAP);
    brush = union(brush, toBrush(headGeom));
  }

  return cleanupGeometry(brush.geometry.clone());
}
