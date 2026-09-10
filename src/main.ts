import './style.css';
import { buildModel } from './geometry/model';
import { Viewport } from './scene';
import { mountPanel } from './ui/panel';
import { downloadStl, downloadZip, prepareZip } from './export/stl';
import { DEFAULT_PARAMS, type HookParams } from './params';

const canvasHost = document.getElementById('canvas-host')!;
const panelEl = document.getElementById('panel')!;
const toolbarEl = document.getElementById('viewport-toolbar')!;

const viewport = new Viewport(canvasHost);

let current = buildModel(DEFAULT_PARAMS);

// Zip generation takes a variable, sometimes multi-second amount of time — the button
// stays disabled ("Preparing…") until it actually finishes rather than assuming any
// particular delay. A generation counter guards against a rapid slider drag: only the
// most recent request is allowed to mark the button ready.
let zipGeneration = 0;
function refreshZip() {
  const myGeneration = ++zipGeneration;
  panel.setZipReady(false);
  void prepareZip(current.hookGeometry, current.screwGeometry, 'wall-hook').then(() => {
    if (myGeneration === zipGeneration) panel.setZipReady(true);
  });
}

function refreshModel(params: HookParams) {
  current = buildModel(params);
  viewport.setModel(current);
  panel.updateSpec(current.screw, { hookBevelMax: current.hookBevelMax, screwBevelMax: current.screwBevelMax });
  refreshZip();
}

const panel = mountPanel(panelEl, toolbarEl, {
  onChange: refreshModel,
  onLayoutChange: (mode) => viewport.setLayout(mode),
  onExportHook: () => downloadStl(current.hookGeometry, 'hook.stl'),
  onExportScrew: () => downloadStl(current.screwGeometry, 'screw.stl'),
  onExportZip: () => downloadZip('wall-hook.zip'),
});

viewport.setModel(current);
panel.updateSpec(current.screw, { hookBevelMax: current.hookBevelMax, screwBevelMax: current.screwBevelMax });
refreshZip();
