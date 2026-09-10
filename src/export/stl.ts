import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import JSZip from 'jszip';

const exporter = new STLExporter();

function geometryToMesh(geometry: THREE.BufferGeometry): THREE.Mesh {
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

export function geometryToStlBinary(geometry: THREE.BufferGeometry): ArrayBuffer {
  const mesh = geometryToMesh(geometry);
  const result = exporter.parse(mesh, { binary: true }) as unknown as DataView;
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}

export function downloadStl(geometry: THREE.BufferGeometry, filename: string) {
  const buffer = geometryToStlBinary(geometry);
  const blob = new Blob([buffer], { type: 'model/stl' });
  triggerDownload(blob, filename);
}

let cachedZipBlob: Blob | null = null;

/**
 * Zip generation (JSZip's generateAsync) can take anywhere from instant to several
 * seconds depending on the machine, and there's no way to make a.click() wait for an
 * in-flight async result without risking the browser silently dropping the download
 * (some browsers only honor a.click()-triggered downloads as long as they're still
 * inside the same synchronous turn as the click that started them). So the zip is
 * built ahead of time — every time the model changes — and the "Download both" button
 * stays disabled with a "Preparing…" label (see setZipReady in panel.ts) until it's
 * actually ready, instead of letting a click land in the gap and silently do nothing.
 */
export async function prepareZip(
  hookGeometry: THREE.BufferGeometry,
  screwGeometry: THREE.BufferGeometry,
  baseName: string,
) {
  const zip = new JSZip();
  zip.file(`${baseName}-hook.stl`, geometryToStlBinary(hookGeometry));
  zip.file(`${baseName}-screw.stl`, geometryToStlBinary(screwGeometry));
  cachedZipBlob = await zip.generateAsync({ type: 'blob' });
}

export function downloadZip(filename: string) {
  if (!cachedZipBlob) return; // guarded by the button's disabled state in the panel — see setZipReady
  triggerDownload(cachedZipBlob, filename);
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
