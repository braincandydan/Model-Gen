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

// A slider's 'input' event fires on every tick of a drag, and a rebuild with any bevel
// applied now costs several seconds (fixing the bevel corners properly meant a lot more
// CSG work than before) — without debouncing, dragging would queue up rebuilds far
// faster than they complete and freeze the tab for the whole drag. Only the value after
// the user pauses actually rebuilds; the number label itself still updates live.
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
function refreshModel(params: HookParams) {
  if (rebuildTimer !== undefined) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    current = buildModel(params);
    viewport.setModel(current);
    panel.updateSpec(current.screw, { hookBevelMax: current.hookBevelMax, screwBevelMax: current.screwBevelMax });
    refreshZip();
  }, 200);
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
