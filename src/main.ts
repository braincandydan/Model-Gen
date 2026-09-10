import './style.css';
import { buildModel } from './geometry/model';
import { Viewport } from './scene';
import { mountPanel } from './ui/panel';
import { downloadBothAsZip, downloadStl } from './export/stl';
import type { HookParams } from './params';

const canvasHost = document.getElementById('canvas-host')!;
const panelEl = document.getElementById('panel')!;
const toolbarEl = document.getElementById('viewport-toolbar')!;

const viewport = new Viewport(canvasHost);

let current = buildModel({
  hookHeight: 55,
  hookLipDepth: 28,
  clampBandHeight: 32,
  engagementDepth: 18,
  partWidth: 24,
  wallThickness: 3.2,
  material: 'PLA',
});

const panel = mountPanel(panelEl, toolbarEl, {
  onChange: (params: HookParams) => {
    current = buildModel(params);
    viewport.setModel(current);
    panel.updateSpec(current.screw);
  },
  onLayoutChange: (mode) => viewport.setLayout(mode),
  onExportHook: () => downloadStl(current.hookGeometry, 'hook.stl'),
  onExportScrew: () => downloadStl(current.screwGeometry, 'screw.stl'),
  onExportZip: () => downloadBothAsZip(current.hookGeometry, current.screwGeometry, 'wall-hook'),
});

viewport.setModel(current);
panel.updateSpec(current.screw);
