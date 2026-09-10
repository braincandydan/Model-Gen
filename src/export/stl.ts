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

export async function downloadBothAsZip(
  hookGeometry: THREE.BufferGeometry,
  screwGeometry: THREE.BufferGeometry,
  baseName: string,
) {
  const zip = new JSZip();
  zip.file(`${baseName}-hook.stl`, geometryToStlBinary(hookGeometry));
  zip.file(`${baseName}-screw.stl`, geometryToStlBinary(screwGeometry));
  const blob = await zip.generateAsync({ type: 'blob' });
  triggerDownload(blob, `${baseName}.zip`);
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
