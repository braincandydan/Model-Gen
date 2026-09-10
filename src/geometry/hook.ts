import * as THREE from 'three';
import { cleanupGeometry, toBrush, union, subtract } from './csg';
import { buildThreadedCylinderGeometry } from './thread';
import type { HookParams, ScrewSpec } from '../params';

/**
 * Side profile of the hook, drawn in a (z, y) plane: z=0 is the front face that hung
 * items rest against and that touches the front of the clamped wall piece; z increases
 * going back through the wall-piece gap to the back wall/boss. y=0 is the bottom of the
 * clamp band. It is later extruded along X (the part's width).
 */
export function buildHookProfile(p: HookParams): THREE.Shape {
  const t = p.wallThickness;
  const D = p.engagementDepth;
  const B = p.clampBandHeight;
  const H = p.hookHeight;
  const L = p.hookLipDepth;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(D + 2 * t, 0);
  shape.lineTo(D + 2 * t, B);
  shape.lineTo(t + D, B);
  shape.lineTo(t + D, t);
  shape.lineTo(t, t);
  shape.lineTo(t, B);
  shape.lineTo(t, B + H);
  shape.lineTo(-L, B + H);
  shape.lineTo(-L, B + H - t);
  shape.lineTo(0, B + H - t);
  shape.closePath();
  return shape;
}

export interface HookBuildResult {
  geometry: THREE.BufferGeometry;
  boss: { centerY: number; backZProfile: number };
}

export function buildHookBody(p: HookParams, screw: ScrewSpec): HookBuildResult {
  const shape = buildHookProfile(p);
  const extrudeGeom = new THREE.ExtrudeGeometry(shape, {
    depth: p.partWidth,
    bevelEnabled: false,
    curveSegments: 6,
  });
  // local: x=z_profile, y=y_profile, z=extrude depth (0..partWidth)
  // rotateY(90deg): world_x = local_z, world_z = -local_x
  extrudeGeom.rotateY(Math.PI / 2);
  extrudeGeom.translate(-p.partWidth / 2, 0, 0);

  let brush = toBrush(extrudeGeom);

  const t = p.wallThickness;
  const D = p.engagementDepth;
  const bossCenterY = p.clampBandHeight / 2;
  const backOuterZProfile = t + D + t + screw.bossLength;

  const bossGeom = new THREE.CylinderGeometry(screw.bossDiameter / 2, screw.bossDiameter / 2, screw.bossLength, 32);
  bossGeom.rotateX(Math.PI / 2);
  bossGeom.translate(0, bossCenterY, -(t + D + t + screw.bossLength / 2));
  brush = union(brush, toBrush(bossGeom));

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
