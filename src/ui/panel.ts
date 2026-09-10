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

  const resetRow = document.createElement('div');
  resetRow.className = 'reset-row';
  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset to defaults';
  resetRow.appendChild(resetBtn);
  panelEl.appendChild(resetRow);

  // Grouped in the order a user actually thinks through customizing this: how big
  // overall, then the hanging hook itself, then the clamp/screw that mounts it.
  const groups: { title: string; keys: (keyof typeof PARAM_LIMITS)[] }[] = [
    { title: 'Overall & print', keys: ['partWidth', 'wallThickness'] },
    { title: 'Hook (the part you hang things on)', keys: ['hookHeight', 'hookLipDepth', 'hookCurlHeight'] },
    {
      title: 'Clamp & screw (mounts to the shelf lip)',
      keys: ['clampBandHeight', 'clampOffset', 'engagementDepth', 'screwEngagementDepth'],
    },
  ];

  const inputs: Partial<Record<keyof HookParams, HTMLInputElement>> = {};
  let screwEngagementNote: HTMLDivElement | null = null;

  for (const group of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'field-group';
    const titleEl = document.createElement('h2');
    titleEl.textContent = group.title;
    groupEl.appendChild(titleEl);

    for (const key of group.keys) {
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

      if (key === 'screwEngagementDepth') {
        screwEngagementNote = document.createElement('div');
        screwEngagementNote.className = 'field-note';
        field.appendChild(screwEngagementNote);
      }

      groupEl.appendChild(field);
      inputs[key] = input;
    }

    panelEl.appendChild(groupEl);
  }

  resetBtn.addEventListener('click', () => {
    Object.assign(params, DEFAULT_PARAMS);
    for (const key of Object.keys(inputs) as (keyof HookParams)[]) {
      const input = inputs[key];
      if (!input) continue;
      input.value = String(params[key]);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    matSelect.value = params.material;
    cb.onChange({ ...params });
  });

  const printGroup = document.createElement('div');
  printGroup.className = 'field-group';
  const printTitle = document.createElement('h2');
  printTitle.textContent = 'Material';
  printGroup.appendChild(printTitle);

  const matField = document.createElement('div');
  matField.className = 'field';
  const matLabel = document.createElement('label');
  matLabel.innerHTML = '<span>Plastic (sets thread fit)</span>';
  const matSelect = document.createElement('select');
  for (const key of Object.keys(MATERIALS) as Material[]) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = `${MATERIALS[key].label} — ${MATERIALS[key].fitNote}`;
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

  // viewport toolbar: layout toggle, each with a one-line caption so the purpose of
  // the two modes is clear without guessing, plus a color legend for the two parts.
  toolbarEl.innerHTML = '';

  const makeToolbarButton = (text: string, caption: string) => {
    const wrap = document.createElement('div');
    wrap.className = 'toolbar-group';
    const btn = document.createElement('button');
    btn.className = 'toolbar-btn';
    btn.textContent = text;
    const cap = document.createElement('div');
    cap.className = 'toolbar-caption';
    cap.textContent = caption;
    wrap.appendChild(btn);
    wrap.appendChild(cap);
    return { wrap, btn };
  };

  const { wrap: printWrap, btn: btnPrint } = makeToolbarButton(
    'Print layout',
    'How the parts sit on your print bed',
  );
  const { wrap: assembledWrap, btn: btnAssembled } = makeToolbarButton(
    'Assembled preview',
    'How it looks installed',
  );
  btnPrint.classList.add('active');

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
  toolbarEl.appendChild(printWrap);
  toolbarEl.appendChild(assembledWrap);

  const legend = document.createElement('div');
  legend.className = 'toolbar-legend';
  legend.innerHTML = `
    <span><i class="swatch swatch-hook"></i>Hook</span>
    <span><i class="swatch swatch-screw"></i>Screw</span>
  `;
  toolbarEl.appendChild(legend);

  return {
    updateSpec(screw: ScrewSpec) {
      const raised = screw.backWallThickness <= screw.backWallThicknessMin + 0.01;
      const engagementNote = raised
        ? ` <span title="Raised to the minimum needed so the threads don't strip">(raised to safe minimum)</span>`
        : '';
      specBox.innerHTML = `
        <div>Nominal diameter: <strong>${screw.nominalDiameter.toFixed(1)} mm</strong></div>
        <div>Thread pitch: <strong>${screw.pitch.toFixed(2)} mm</strong></div>
        <div>Thread engagement: <strong>${screw.backWallThickness.toFixed(1)} mm</strong>${engagementNote}</div>
        <div>Screw length: <strong>${screw.length.toFixed(1)} mm</strong></div>
        <div>Head diameter: <strong>${screw.headDiameter.toFixed(1)} mm</strong></div>
      `;
      if (screwEngagementNote) {
        screwEngagementNote.textContent = raised
          ? `Raised to ${screw.backWallThicknessMin.toFixed(1)} mm — the minimum for this screw size so the threads don't strip`
          : '';
      }
    },
  };
}
