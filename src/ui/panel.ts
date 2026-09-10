import { DEFAULT_PARAMS, MATERIALS, PARAM_LIMITS, type HookParams, type Material, type ScrewSpec } from '../params';
import type { LayoutMode } from '../scene';

export interface PanelCallbacks {
  onChange: (params: HookParams) => void;
  onLayoutChange: (mode: LayoutMode) => void;
  onExportHook: () => void;
  onExportScrew: () => void;
  onExportZip: () => void;
}

export interface PanelHandle {
  updateSpec: (screw: ScrewSpec) => void;
}

export function mountPanel(panelEl: HTMLElement, toolbarEl: HTMLElement, cb: PanelCallbacks): PanelHandle {
  const params: HookParams = { ...DEFAULT_PARAMS };

  panelEl.innerHTML = '';

  const geomGroup = document.createElement('div');
  geomGroup.className = 'field-group';
  const geomTitle = document.createElement('h2');
  geomTitle.textContent = 'Hook geometry';
  geomGroup.appendChild(geomTitle);
  panelEl.appendChild(geomGroup);

  const sliderKeys: (keyof typeof PARAM_LIMITS)[] = [
    'hookHeight',
    'hookLipDepth',
    'clampBandHeight',
    'engagementDepth',
    'partWidth',
    'wallThickness',
  ];

  const inputs: Partial<Record<keyof HookParams, HTMLInputElement>> = {};

  for (const key of sliderKeys) {
    const limit = PARAM_LIMITS[key];
    const field = document.createElement('div');
    field.className = 'field';

    const label = document.createElement('label');
    const nameSpan = document.createElement('span');
    nameSpan.textContent = limit.label;
    const valSpan = document.createElement('span');
    valSpan.className = 'val';
    label.appendChild(nameSpan);
    label.appendChild(valSpan);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(limit.min);
    input.max = String(limit.max);
    input.step = String(limit.step);
    input.value = String(params[key]);

    const setVal = () => {
      valSpan.textContent = `${Number(input.value).toFixed(limit.step < 1 ? 1 : 0)} ${limit.unit}`;
    };
    setVal();

    input.addEventListener('input', () => {
      (params as any)[key] = Number(input.value);
      setVal();
      cb.onChange({ ...params });
    });

    field.appendChild(label);
    field.appendChild(input);
    geomGroup.appendChild(field);
    inputs[key] = input;
  }

  const printGroup = document.createElement('div');
  printGroup.className = 'field-group';
  const printTitle = document.createElement('h2');
  printTitle.textContent = 'Material';
  printGroup.appendChild(printTitle);

  const matField = document.createElement('div');
  matField.className = 'field';
  const matLabel = document.createElement('label');
  matLabel.innerHTML = '<span>Plastic (sets thread fit clearance)</span>';
  const matSelect = document.createElement('select');
  for (const key of Object.keys(MATERIALS) as Material[]) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${MATERIALS[key].label} (+${MATERIALS[key].threadClearance.toFixed(2)}mm clearance)`;
    matSelect.appendChild(opt);
  }
  matSelect.value = params.material;
  matSelect.addEventListener('change', () => {
    params.material = matSelect.value as Material;
    cb.onChange({ ...params });
  });
  matField.appendChild(matLabel);
  matField.appendChild(matSelect);
  printGroup.appendChild(matField);
  panelEl.appendChild(printGroup);

  const specGroup = document.createElement('div');
  specGroup.className = 'field-group';
  const specTitle = document.createElement('h2');
  specTitle.textContent = 'Derived screw';
  specGroup.appendChild(specTitle);
  const specBox = document.createElement('div');
  specBox.className = 'spec-box';
  specGroup.appendChild(specBox);
  panelEl.appendChild(specGroup);

  const exportGroup = document.createElement('div');
  exportGroup.className = 'field-group';
  const exportTitle = document.createElement('h2');
  exportTitle.textContent = 'Export';
  exportGroup.appendChild(exportTitle);
  const exportRow = document.createElement('div');
  exportRow.className = 'export-row';

  const btnHook = document.createElement('button');
  btnHook.textContent = 'Download hook.stl';
  btnHook.addEventListener('click', cb.onExportHook);

  const btnScrew = document.createElement('button');
  btnScrew.textContent = 'Download screw.stl';
  btnScrew.addEventListener('click', cb.onExportScrew);

  const btnZip = document.createElement('button');
  btnZip.className = 'primary';
  btnZip.textContent = 'Download both (.zip)';
  btnZip.addEventListener('click', cb.onExportZip);

  exportRow.appendChild(btnZip);
  exportRow.appendChild(btnHook);
  exportRow.appendChild(btnScrew);
  exportGroup.appendChild(exportRow);

  const warning = document.createElement('div');
  warning.className = 'warning';
  warning.textContent =
    'Print the hook and screw as separate STL files/models so they land as two bodies on your print bed. No supports should be needed for either part in the orientation shown.';
  exportGroup.appendChild(warning);

  panelEl.appendChild(exportGroup);

  // viewport toolbar: layout toggle
  toolbarEl.innerHTML = '';
  const btnPrint = document.createElement('button');
  btnPrint.className = 'toolbar-btn active';
  btnPrint.textContent = 'Print layout';
  const btnAssembled = document.createElement('button');
  btnAssembled.className = 'toolbar-btn';
  btnAssembled.textContent = 'Assembled preview';

  btnPrint.addEventListener('click', () => {
    btnPrint.classList.add('active');
    btnAssembled.classList.remove('active');
    cb.onLayoutChange('print');
  });
  btnAssembled.addEventListener('click', () => {
    btnAssembled.classList.add('active');
    btnPrint.classList.remove('active');
    cb.onLayoutChange('assembled');
  });
  toolbarEl.appendChild(btnPrint);
  toolbarEl.appendChild(btnAssembled);

  return {
    updateSpec(screw: ScrewSpec) {
      specBox.innerHTML = `
        <div>Nominal diameter: <strong>${screw.nominalDiameter.toFixed(1)} mm</strong></div>
        <div>Thread pitch: <strong>${screw.pitch.toFixed(2)} mm</strong></div>
        <div>Screw length: <strong>${screw.length.toFixed(1)} mm</strong></div>
        <div>Head diameter: <strong>${screw.headDiameter.toFixed(1)} mm</strong></div>
      `;
    },
  };
}
