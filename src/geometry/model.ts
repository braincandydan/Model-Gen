import * as THREE from 'three';
import { buildHookBody } from './hook';
import { buildScrewSolid } from './screw';
import { deriveScrewSpec, type HookParams, type ScrewSpec } from '../params';

export interface BuiltModel {
  hookGeometry: THREE.BufferGeometry;
  screwGeometry: THREE.BufferGeometry;
  screw: ScrewSpec;
  boss: { centerY: number; backZProfile: number };
  params: HookParams;
}

export function buildModel(params: HookParams): BuiltModel {
  const screw = deriveScrewSpec(params);
  const { geometry: hookGeometry, boss } = buildHookBody(params, screw);
  const screwGeometry = buildScrewSolid(screw);
  return { hookGeometry, screwGeometry, screw, boss, params };
}
