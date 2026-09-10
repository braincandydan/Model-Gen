import * as THREE from 'three';
import { buildThreadedRod } from './thread';
import type { HookParams, ScrewSpec } from '../params';

export interface ScrewBuildResult {
  geometry: THREE.BufferGeometry;
  bevelMax: number; // the cap the screw bevel slider got clamped to, for the UI note
}

/** The standalone printable set-screw: shaft + trapezoidal threads + flat-point tip + ribbed thumb head. */
export function buildScrewSolid(p: HookParams, screw: ScrewSpec): ScrewBuildResult {
  // The head bevel rounds both its top and bottom edges, so the two cuts must fit
  // within half the head's height without meeting in the middle, and can't exceed the
  // head's own radius either (a bevel that big would pinch the cap to a point).
  const bevelMax = Math.max(0, Math.min(screw.headHeight / 2 - 0.3, screw.headDiameter / 2 - 0.3));
  const headBevel = Math.min(p.screwBevel, bevelMax);

  const geometry = buildThreadedRod({
    minorRadius: screw.nominalDiameter / 2 - screw.threadDepth,
    majorRadius: screw.nominalDiameter / 2,
    pitch: screw.pitch,
    length: screw.length,
    tip: true,
    headDiameter: screw.headDiameter,
    headHeight: screw.headHeight,
    headRibCount: 16,
    headBevel,
  });

  return { geometry, bevelMax };
}
