export type Material = 'PLA' | 'PETG' | 'ABS' | 'TPU';

export interface HookParams {
  // Hook (the part above the clamp band that things hang on)
  hookHeight: number; // vertical length of the arm above the clamp band
  hookLipDepth: number; // how far the lip projects forward, away from the wall
  // Clamp / wraparound (the part that grips the vertical wall piece)
  clampBandHeight: number; // vertical height of the wraparound band
  engagementDepth: number; // front-to-back thickness of the vertical piece being clamped
  // Overall / print
  partWidth: number; // width of the whole part (left-right), also drives screw size
  wallThickness: number; // thickness of every printed wall/lip
  material: Material;
}

export interface MaterialProfile {
  label: string;
  threadClearance: number; // radial clearance added to the hole per side (mm)
  minWall: number; // recommended minimum wall thickness (mm), used for clamping UI
}

export const MATERIALS: Record<Material, MaterialProfile> = {
  PLA: { label: 'PLA', threadClearance: 0.18, minWall: 1.6 },
  PETG: { label: 'PETG', threadClearance: 0.22, minWall: 1.8 },
  ABS: { label: 'ABS', threadClearance: 0.25, minWall: 2.0 },
  TPU: { label: 'TPU', threadClearance: 0.3, minWall: 2.4 },
};

export const DEFAULT_PARAMS: HookParams = {
  hookHeight: 55,
  hookLipDepth: 28,
  clampBandHeight: 32,
  engagementDepth: 18,
  partWidth: 24,
  wallThickness: 3.2,
  material: 'PLA',
};

export const PARAM_LIMITS: Record<keyof Omit<HookParams, 'material'>, { min: number; max: number; step: number; label: string; unit: string }> = {
  hookHeight: { min: 15, max: 150, step: 1, label: 'Hook arm height', unit: 'mm' },
  hookLipDepth: { min: 10, max: 80, step: 1, label: 'Hook lip depth', unit: 'mm' },
  clampBandHeight: { min: 12, max: 100, step: 1, label: 'Clamp band height', unit: 'mm' },
  engagementDepth: { min: 4, max: 60, step: 0.5, label: 'Wall-piece thickness (gap)', unit: 'mm' },
  partWidth: { min: 12, max: 100, step: 1, label: 'Overall width', unit: 'mm' },
  wallThickness: { min: 2, max: 8, step: 0.1, label: 'Print wall thickness', unit: 'mm' },
};

export interface ScrewSpec {
  nominalDiameter: number; // major (outer) thread diameter, mm
  pitch: number;
  threadDepth: number;
  length: number; // full threaded shank length
  headDiameter: number;
  headHeight: number;
  bossDiameter: number;
  bossLength: number; // extra boss protrusion behind the flat back wall
  clearance: number; // radial clearance for the female hole, per side
}

const STANDARD_DIAMETERS = [5, 6, 8, 10, 12, 16, 20];

function nearestStandardDiameter(target: number): number {
  let best = STANDARD_DIAMETERS[0];
  let bestDiff = Infinity;
  for (const d of STANDARD_DIAMETERS) {
    const diff = Math.abs(d - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = d;
    }
  }
  return best;
}

/**
 * Screw sizing is derived, not user-set directly:
 * - overall hook size (width + arm/lip reach) drives the screw's diameter/gauge
 * - the engagement depth (how wide the piece being clamped is) drives the screw's length
 */
export function deriveScrewSpec(p: HookParams): ScrewSpec {
  const hookScale = p.partWidth * 0.5 + p.hookHeight * 0.15 + p.hookLipDepth * 0.15;
  const rawDiameter = 5 + hookScale * 0.12;
  const nominalDiameter = nearestStandardDiameter(rawDiameter);

  const pitch = clamp(nominalDiameter / 5, 1.8, 4);
  const threadDepth = pitch * 0.5;

  // Boss needs room for a short smooth lead-in (through the back pad) plus real thread engagement.
  const bossLength = Math.max(p.wallThickness * 2 + nominalDiameter * 1.2, 14);
  const travelMargin = 6; // extra travel so the screw can be backed off and re-tightened
  const length = p.engagementDepth + p.wallThickness + bossLength + travelMargin;

  const headDiameter = nominalDiameter * 2.2;
  const headHeight = Math.max(nominalDiameter * 0.9, 6);

  const bossDiameter = Math.max(nominalDiameter + p.wallThickness * 2.4, p.wallThickness * 4);

  const mat = MATERIALS[p.material];

  return {
    nominalDiameter,
    pitch,
    threadDepth,
    length,
    headDiameter,
    headHeight,
    bossDiameter,
    bossLength,
    clearance: mat.threadClearance,
  };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
