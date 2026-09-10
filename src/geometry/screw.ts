import * as THREE from 'three';
import { buildThreadedRod } from './thread';
import type { ScrewSpec } from '../params';

/** The standalone printable set-screw: shaft + trapezoidal threads + tip + knurled thumb head. */
export function buildScrewSolid(screw: ScrewSpec): THREE.BufferGeometry {
  return buildThreadedRod({
    minorRadius: screw.nominalDiameter / 2 - screw.threadDepth,
    majorRadius: screw.nominalDiameter / 2,
    pitch: screw.pitch,
    length: screw.length,
    tip: true,
    headDiameter: screw.headDiameter,
    headHeight: screw.headHeight,
    headSegments: 16,
  });
}
