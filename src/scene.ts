import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { BuiltModel } from './geometry/model';

export type LayoutMode = 'print' | 'assembled';

export class Viewport {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;

  private hookMesh: THREE.Mesh;
  private screwMesh: THREE.Mesh;
  private grid: THREE.GridHelper;
  private layout: LayoutMode = 'print';
  private current: BuiltModel | null = null;

  constructor(host: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14161a);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    this.camera.position.set(140, 110, 180);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 30, 0);
    this.controls.enableDamping = true;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x33363f, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(120, 220, 140);
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-120, 80, -140);
    this.scene.add(fill);

    this.grid = new THREE.GridHelper(400, 40, 0x333844, 0x24272e);
    this.scene.add(this.grid);

    const material = new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.45, metalness: 0.08 });
    const screwMaterial = new THREE.MeshStandardMaterial({ color: 0xff9f4f, roughness: 0.4, metalness: 0.15 });

    this.hookMesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.hookMesh.castShadow = false;
    this.screwMesh = new THREE.Mesh(new THREE.BufferGeometry(), screwMaterial);
    this.scene.add(this.hookMesh, this.screwMesh);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(host);
    resize();

    this.animate();
  }

  setModel(model: BuiltModel) {
    this.current = model;
    this.hookMesh.geometry.dispose();
    this.hookMesh.geometry = model.hookGeometry;
    this.screwMesh.geometry.dispose();
    this.screwMesh.geometry = model.screwGeometry;
    this.applyLayout();
    this.frameToFit();
  }

  setLayout(mode: LayoutMode) {
    this.layout = mode;
    this.applyLayout();
    this.frameToFit();
  }

  /**
   * Sliders can grow or reposition the model a lot (e.g. moving the clamp band up
   * the arm, or lengthening the hook) — the camera used to stay put after construction,
   * so a big-enough change would silently drift the model out of the fixed view and look
   * like nothing happened. This re-centers on the current model's bounding box and backs
   * the camera off to fit it, while keeping the orbit angle/direction the user set.
   */
  private frameToFit() {
    const box = new THREE.Box3();
    box.expandByObject(this.hookMesh);
    box.expandByObject(this.screwMesh);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1);
    const fov = (this.camera.fov * Math.PI) / 180;
    const fitDistance = (maxDim / (2 * Math.tan(fov / 2))) * 1.7;

    const direction = this.camera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() < 1e-6) direction.set(140, 110, 180);
    direction.normalize();

    this.controls.target.copy(center);
    this.camera.position.copy(center).add(direction.multiplyScalar(Math.max(fitDistance, 60)));
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private applyLayout() {
    if (!this.current) return;
    const { params, screw, boss } = this.current;
    if (this.layout === 'print') {
      // Recommended print orientation: hook upright as modeled, screw standing on its
      // (larger, hand-tightened) head with the threaded tip pointing up — the usual way
      // to print a screw so every layer is a full thread cross-section, no overhangs.
      this.hookMesh.position.set(0, 0, 0);
      this.hookMesh.rotation.set(0, 0, 0);

      const gap = 20;
      const screwSpan = screw.length + screw.headHeight;
      this.screwMesh.position.set(params.partWidth / 2 + gap + screw.headDiameter / 2, screwSpan, 0);
      this.screwMesh.rotation.set(Math.PI / 2, 0, 0);
    } else {
      // Thread the screw into the boss from the back, roughly to the tightened position.
      this.hookMesh.position.set(0, 0, 0);
      this.hookMesh.rotation.set(0, 0, 0);

      const t = params.wallThickness;
      const D = params.engagementDepth;
      const insertedZ = -(t + D) - screw.length * 0.15;
      this.screwMesh.position.set(0, boss.centerY, insertedZ);
      this.screwMesh.rotation.set(0, Math.PI, 0);
    }
  }

  private animate = () => {
    requestAnimationFrame(this.animate);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
