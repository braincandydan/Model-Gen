import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ADDITION, Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';

const evaluator = new Evaluator();
evaluator.attributes = ['position', 'normal'];

/** Weld near-duplicate vertices left behind by CSG triangle splitting (closes small T-junction gaps). */
export function cleanupGeometry(geometry: THREE.BufferGeometry, tolerance = 2e-3): THREE.BufferGeometry {
  const cleaned = mergeVertices(geometry, tolerance);
  cleaned.computeVertexNormals();
  return cleaned;
}

export function toBrush(geometry: THREE.BufferGeometry): Brush {
  const brush = new Brush(geometry);
  brush.updateMatrixWorld();
  return brush;
}

export function union(a: Brush, b: Brush): Brush {
  const result = evaluator.evaluate(a, b, ADDITION);
  result.updateMatrixWorld();
  return result;
}

export function subtract(a: Brush, b: Brush): Brush {
  const result = evaluator.evaluate(a, b, SUBTRACTION);
  result.updateMatrixWorld();
  return result;
}
