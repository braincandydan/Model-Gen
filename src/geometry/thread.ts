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

interface RibbedCylinderOptions {
  baseRadius: number;
  ribHeight: number;
  ribCount: number;
  length: number;
  angularSegments?: number;
}

/**
 * A cylinder with rounded ribs running its full length (radius varies with angle only,
 * not z) — a knurled-knob grip, much easier to hand-tighten than a smooth or lightly
 * faceted cylinder. Built the same ring/cap way as buildThreadedCylinderGeometry, so it
 * inherits the same verified-correct (outward-facing) winding.
 */
function buildRibbedCylinderGeometry(o: RibbedCylinderOptions): THREE.BufferGeometry {
  const N = o.angularSegments ?? Math.max(64, o.ribCount * 8);
  const rings: THREE.Vector3[][] = [[], []];
  const zs = [0, o.length];
  for (let ri = 0; ri < 2; ri++) {
    const z = zs[ri];
    for (let k = 0; k < N; k++) {
      const phi = (k / N) * Math.PI * 2;
      const r = o.baseRadius + (o.ribHeight / 2) * (1 + Math.cos(phi * o.ribCount));
      rings[ri].push(new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z));
    }
  }

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  const [first, last] = rings;
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(first[k], first[k2], last[k2]);
    pushTri(first[k], last[k2], last[k]);
  }

  const startCenter = new THREE.Vector3(0, 0, 0);
  for (let k = 0; k < N; k++) {
    const k2 = (k + 1) % N;
    pushTri(startCenter, first[k2], first[k]);
  }

  const endCenter = new THREE.Vector3(0, 0, o.length);
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
  headRibCount?: number; // ribbed grip ridges around the head; 0/undefined = plain cylinder
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
    if (ribCount > 0) {
      // Already built along Z, spanning [0, headHeight] — no rotation needed.
      const headGeom = buildRibbedCylinderGeometry({
        baseRadius: o.headDiameter / 2,
        ribHeight: o.headDiameter * 0.08,
        ribCount,
        length: o.headHeight,
      });
      headGeom.translate(0, 0, o.length - OVERLAP);
      brush = union(brush, toBrush(headGeom));
    } else {
      const headGeom = new THREE.CylinderGeometry(o.headDiameter / 2, o.headDiameter / 2, o.headHeight, 32);
      headGeom.rotateX(Math.PI / 2);
      headGeom.translate(0, 0, o.length + o.headHeight / 2 - OVERLAP);
      brush = union(brush, toBrush(headGeom));
    }
  }

  return cleanupGeometry(brush.geometry.clone());
}
