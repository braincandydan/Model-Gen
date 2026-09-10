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
  hookBevelMax: number; // the cap the hook bevel slider got clamped to, for the UI note
  screwBevelMax: number;
}

export function buildModel(params: HookParams): BuiltModel {
  const screw = deriveScrewSpec(params);
  const { geometry: hookGeometry, boss, bevelMax: hookBevelMax } = buildHookBody(params, screw);
  const { geometry: screwGeometry, bevelMax: screwBevelMax } = buildScrewSolid(params, screw);
  return { hookGeometry, screwGeometry, screw, boss, params, hookBevelMax, screwBevelMax };
}
