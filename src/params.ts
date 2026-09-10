export type Material = 'PLA' | 'PETG' | 'ABS' | 'TPU';

export interface HookParams {
  // Hook (the arm that hangs below the clamp band, and what things hang on)
  hookHeight: number; // vertical length of the arm below the clamp band
  hookLipDepth: number; // how far the lip projects forward, away from the wall
  hookCurlHeight: number; // depth of the upturned stop at the tip, so hung items can't slide off the end
  // Clamp / wraparound (the part that grips the shelf lip / wall piece, at the top)
  clampBandHeight: number; // vertical height of the wraparound band
  clampOffset: number; // extra gap pushing the clamp further above the arm's natural end; 0 = lowest position = max leverage
  engagementDepth: number; // front-to-back thickness of the piece being clamped
  screwEngagementDepth: number; // how deep the screw threads into the back wall (independent of print wall thickness; floored to a safe minimum for the current screw size)
  // Overall / print
  partWidth: number; // width of the whole part (left-right), also drives screw size
  wallThickness: number; // thickness of every printed wall/lip
  material: Material;
}

export interface MaterialProfile {
  label: string;
  threadClearance: number; // radial clearance added to the hole per side (mm)
  minWall: number; // recommended minimum wall thickness (mm), used for clamping UI
  fitNote: string; // plain-language description of the resulting thread fit
}

export const MATERIALS: Record<Material, MaterialProfile> = {
  PLA: { label: 'PLA', threadClearance: 0.18, minWall: 1.6, fitNote: 'snug fit' },
  PETG: { label: 'PETG', threadClearance: 0.22, minWall: 1.8, fitNote: 'standard fit' },
  ABS: { label: 'ABS', threadClearance: 0.25, minWall: 2.0, fitNote: 'looser, easier to hand-thread' },
  TPU: { label: 'TPU', threadClearance: 0.3, minWall: 2.4, fitNote: 'loosest — flexible material' },
};

export const DEFAULT_PARAMS: HookParams = {
  hookHeight: 55,
  hookLipDepth: 28,
  hookCurlHeight: 16,
  clampBandHeight: 32,
  clampOffset: 0,
  engagementDepth: 18,
  screwEngagementDepth: 22,
  partWidth: 24,
  wallThickness: 3.2,
  material: 'PLA',
};

export const PARAM_LIMITS: Record<keyof Omit<HookParams, 'material'>, { min: number; max: number; step: number; label: string; unit: string }> = {
  hookHeight: { min: 15, max: 150, step: 1, label: 'Hook arm length', unit: 'mm' },
  hookLipDepth: { min: 10, max: 80, step: 1, label: 'Hook lip depth', unit: 'mm' },
  hookCurlHeight: { min: 0, max: 40, step: 1, label: 'Hook end-stop height', unit: 'mm' },
  clampBandHeight: { min: 12, max: 100, step: 1, label: 'Clamp band height', unit: 'mm' },
  clampOffset: {
    min: 0,
    max: 50,
    step: 1,
    label: 'Clamp height above arm (0 = strongest)',
    unit: 'mm',
  },
  engagementDepth: { min: 4, max: 60, step: 0.5, label: 'Shelf-lip gap width', unit: 'mm' },
  screwEngagementDepth: {
    min: 8,
    max: 50,
    step: 0.5,
    label: 'Screw grip depth',
    unit: 'mm',
  },
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
  backWallThickness: number; // the flush back wall's thickness = actual thread engagement length
  backWallThicknessMin: number; // the enforced floor that backWallThickness was clamped to, if needed
  clearance: number; // radial clearance for the female hole, per side
}

const STANDARD_DIAMETERS = [6, 8, 10, 12, 16, 20, 25];

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
 *
 * The one place a floor is enforced rather than just following the user's slider is
 * thread engagement (backWallThickness): a hand-tightened screw pressure-fitting
 * against something relies entirely on its printed plastic threads not stripping.
 * Printed threads are far weaker than machined ones, so engagement shorter than about
 * 1.5x the screw's nominal diameter is a real risk of stripping under normal tightening
 * torque — that floor is enforced here regardless of what the wall-thickness or
 * engagement-depth sliders are set to.
 */
export function deriveScrewSpec(p: HookParams): ScrewSpec {
  const hookScale = p.partWidth * 0.5 + p.hookHeight * 0.15 + p.hookLipDepth * 0.15;
  const rawDiameter = 8 + hookScale * 0.22; // biased up: this is a hand-tightened structural screw, not a machine screw
  const nominalDiameter = nearestStandardDiameter(rawDiameter);

  const pitch = clamp(nominalDiameter / 5, 2, 4.5);
  const threadDepth = pitch * 0.5;

  const backWallThicknessMin = Math.max(nominalDiameter * 1.5, 12);
  const backWallThickness = Math.max(p.screwEngagementDepth, backWallThicknessMin);

  const travelMargin = 6; // extra travel so the screw can be backed off and re-tightened
  const length = p.engagementDepth + backWallThickness + travelMargin;

  // Hand-tightened, so the head is a real handle, not a machine-screw head.
  const headDiameter = nominalDiameter * 3;
  const headHeight = Math.max(nominalDiameter * 1.1, 10);

  const mat = MATERIALS[p.material];

  return {
    nominalDiameter,
    pitch,
    threadDepth,
    length,
    headDiameter,
    headHeight,
    backWallThickness,
    backWallThicknessMin,
    clearance: mat.threadClearance,
  };
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
