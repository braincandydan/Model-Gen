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
  }

  setLayout(mode: LayoutMode) {
    this.layout = mode;
    this.applyLayout();
  }

  private applyLayout() {
    if (!this.current) return;
    const { params, screw, boss } = this.current;
    if (this.layout === 'print') {
      // Lay the hook flat-ish for viewing and place the screw beside it, as they'd
      // be arranged as two separate bodies on a print bed.
      this.hookMesh.position.set(0, 0, 0);
      this.hookMesh.rotation.set(0, 0, 0);

      const gap = 20;
      this.screwMesh.position.set(
        params.partWidth / 2 + gap + screw.headDiameter / 2,
        screw.headDiameter / 2,
        0,
      );
      this.screwMesh.rotation.set(0, Math.PI / 2, 0);
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
