/* SPDX-License-Identifier: GPL-3.0-only · Copyright (C) 2026 koenig-arthur */
(function () {
  'use strict';
  const C = ControlLab, D = FilterDSP, P = LabPlots, $ = id => document.getElementById(id);
  const colors = { blue: '#2264d9', gray: '#8492a6', purple: '#8657c8', green: '#17785b', orange: '#c56e24' };
  const savedColors = ['#17785b', '#c56e24', '#b54779', '#087e96', '#7c6a35'];
  let config = C.defaults(), snapshots = [], currentPreset = 'pi', selectedSlot = 'setpoint', preview = null;
  let generation = 0, timer = null, rendered = null;
  function showError(error) { $('error').textContent = `${error.message || error} The last valid experiment is retained.`; $('error').hidden = false; }
  function clearError() { $('error').hidden = true; $('error').textContent = ''; }
  function announce(text) { $('announcement').textContent = text; }
  function value(id, v, force = false) { if (force || document.activeElement !== $(id)) $(id).value = v; }
  function check(id, v) { $(id).checked = !!v; }
  function setPath(object, path, v) { const parts = path.split('.'), key = parts.pop(); let at = object; parts.forEach(p => { at = at[p]; }); at[key] = v; }
  function invalidatePreview() { preview = null; $('filter-preview').hidden = true; }
  function commit(candidate, { force = false, filters = false, preset = false } = {}) {
    try {
      const model = C.compile(candidate);
      if (candidate.sampleRate !== config.sampleRate) invalidatePreview();
      config = model.config;
      if (!preset) currentPreset = 'custom';
      clearError(); syncControls(force); if (filters) loadFilter(); schedule();
      return true;
    } catch (error) { showError(error); return false; }
  }
  function bindNumber(id, path, multiplier = 1) {
    $(id).addEventListener('input', () => {
      const next = C.clone(config); setPath(next, path, $(id).value.trim() === '' ? NaN : Number($(id).value) * multiplier); commit(next);
    });
  }
  function bindCheck(id, path) { $(id).addEventListener('change', () => { const next = C.clone(config); setPath(next, path, $(id).checked); commit(next); }); }
  function activateTab(tab, focus = false) {
    for (const key of ['pid', 'plant', 'filters', 'limits']) {
      const active = tab === key; $(`tab-${key}`).setAttribute('aria-selected', String(active)); $(`tab-${key}`).tabIndex = active ? 0 : -1; $(`panel-${key}`).hidden = !active;
    }
    if (focus) $(`tab-${tab}`).focus();
  }
  function syncControls(force = false) {
    const mapping = { 'sample-rate': config.sampleRate, duration: config.duration, kp: config.pid.kp, ki: config.pid.ki, kd: config.pid.kd,
      'kp-range': config.pid.kp, 'ki-range': config.pid.ki, 'kd-range': config.pid.kd, 'derivative-tau': config.pid.derivativeTau * 1000,
      'plant-type': config.plant.type, 'plant-gain': config.plant.gain, 'plant-tau': config.plant.tau * 1000,
      'plant-frequency': config.plant.frequency, 'plant-damping': config.plant.damping, 'dead-time': config.delay * 1000,
      'limit-min': config.limits.min, 'limit-max': config.limits.max, 'tracking-time': config.limits.trackingTime * 1000,
      excitation: config.excitation, amplitude: config.amplitude, onset: config.onset, 'return-time': config.returnTime, 'return-level': config.returnLevel };
    for (const k of ['kp', 'ki', 'kd']) { $(`${k}-range`).min = Math.min(0, config.pid[k]); $(`${k}-range`).max = Math.max({ kp: 10, ki: 100, kd: 0.2 }[k], config.pid[k]); }
    for (const [id, v] of Object.entries(mapping)) value(id, v, force);
    value('preset', currentPreset, true);
    check('limits-enabled', config.limits.enabled); check('anti-windup', config.limits.antiWindup);
    $('sample-note').textContent = `Ts ${P.format(1000 / config.sampleRate)} ms · Nyquist ${P.format(config.sampleRate / 2)} Hz`;
    $('return-fields').hidden = config.excitation !== 'recovery';
    const type = config.plant.type, custom = ['continuous', 'discrete'].includes(type);
    $('plant-gain-field').hidden = custom; $('plant-tau-field').hidden = type !== 'first'; $('plant-second-fields').hidden = type !== 'second'; $('plant-coeff-form').hidden = !custom;
    $('plant-coeff-help').textContent = type === 'continuous' ? 'Descending powers of s. Proper transfer functions through order 8; sampled with a zero-order hold.' : 'Coefficients of 1, z⁻¹, z⁻², …; through order 64. Include leading zeros in b for sample delays.';
    if (force) { value('plant-b', config.plant.b.join(', '), true); value('plant-a', config.plant.a.join(', '), true); }
    const samples = Math.round(config.delay * config.sampleRate);
    $('delay-note').textContent = `${samples} sample${samples === 1 ? '' : 's'} · effective dead time ${P.format(samples / config.sampleRate * 1000)} ms. Rounded to the nearest sample.`;
    $('controller-kind').textContent = C.controllerType(config.pid);
    $('result-title').textContent = currentPreset === 'custom' ? `${C.controllerType(config.pid)} · custom experiment` : C.PRESETS[currentPreset].name;
    $('experiment-note').textContent = currentPreset === 'custom' ? 'Save a snapshot before changing a gain, a filter position, or the dead time. Compare one change at a time to see what it does.' : C.PRESETS[currentPreset].note;
    document.querySelectorAll('[data-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === config.view)));
    updateChain();
  }
  function updateChain() {
    const controller = config.view === 'controller', closed = config.view === 'closed';
    document.querySelectorAll('[data-block]').forEach(button => {
      const key = button.dataset.block; let text = '', enabled = true, inactive = false;
      if (C.SLOTS.includes(key)) {
        enabled = config.filters[key].enabled; text = enabled ? 'enabled' : 'bypassed';
        inactive = (key === 'setpoint' && controller) || (key === 'measurement' && !closed);
      } else if (key === 'pid') { button.querySelector('strong').textContent = C.controllerType(config.pid); text = 'controller'; }
      else if (key === 'plant') { text = config.plant.type === 'first' ? `τ ${P.format(config.plant.tau * 1000)} ms` : 'G(z)'; inactive = controller; }
      else if (key === 'delay') { enabled = config.delay > 0; text = `${P.format(Math.round(config.delay * config.sampleRate) / config.sampleRate * 1000)} ms`; inactive = controller; }
      else if (key === 'limits') { enabled = config.limits.enabled; text = enabled ? `${P.format(config.limits.min)}…${P.format(config.limits.max)}` : 'bypassed'; }
      button.classList.toggle('enabled', enabled); button.classList.toggle('inactive', inactive); button.querySelector('small').textContent = inactive ? 'not in this view' : text;
      button.setAttribute('aria-label', `Edit ${key}${inactive ? '; inactive in this view' : ''}`);
    });
    document.querySelector('.feedback-path').classList.toggle('inactive', !closed);
    $('feedback-label').textContent = closed ? '↳ negative feedback' : 'feedback disconnected';
    $('chain-input').textContent = controller ? 'e' : 'r';
    $('view-note').textContent = controller ? 'Impose an error and inspect the controller output. Setpoint, plant, dead time and measurement blocks are inactive. Raw comparison also bypasses limits.'
      : closed ? 'The measured output is subtracted from the filtered target. Baselines retain the same plant and gains; first add filters, then dead time.'
        : 'Feedback is disconnected. The input passes through setpoint and error filters, PID, output filter, limits, plant and dead time. Measurement filtering is inactive.';
    $('error-title').textContent = closed ? 'Tracking & controller error' : 'Input to the controller';
  }
  function loadFilter() {
    invalidatePreview(); const f = config.filters[selectedSlot];
    value('filter-slot', selectedSlot, true); check('filter-enabled', f.enabled);
    for (const [id, v] of Object.entries({ 'filter-method': f.method, 'filter-type': f.type, 'filter-frequency': f.frequency,
      'filter-upper': f.upperFrequency, 'filter-q': f.q, 'filter-taps': f.taps, 'filter-b': f.b.join(', '), 'filter-a': f.a.join(', ') })) value(id, v, true);
    $('filter-slot-note').textContent = { setpoint: 'Shapes the reference before the error is formed. Does not alter feedback-loop poles, but has its own dynamics.',
      error: 'Filters the whole error signal before all three PID terms.', output: 'Filters the PID command before the actuator limiter and plant.',
      measurement: 'Filters measured output before subtraction. Its delay and phase are inside the feedback loop.' }[selectedSlot];
    filterFields();
  }
  function filterFields() {
    const method = $('filter-method').value, design = ['iir', 'fir', 'average'].includes(method), type = $('filter-type').value;
    $('filter-design-fields').hidden = !design;
    $('filter-type-field').hidden = method === 'average'; $('filter-frequency-field').hidden = method === 'average';
    $('filter-upper-field').hidden = !(method === 'fir' && ['bandpass', 'notch'].includes(type));
    $('filter-q-field').hidden = method !== 'iir'; $('filter-taps-field').hidden = !['fir', 'average'].includes(method);
    $('filter-expression-fields').hidden = method !== 'expression'; $('filter-equation-fields').hidden = method !== 'equation'; $('filter-coefficient-fields').hidden = method !== 'coefficients';
  }
  function presentFilter(f, descriptor, imported = false) {
    preview = { filter: f, descriptor, imported, slot: selectedSlot };
    $('filter-preview-coefficients').textContent = `b = [${f.b.join(', ')}]\na = [${f.a.join(', ')}]`;
    $('filter-preview-note').textContent = `${imported ? 'Source' : 'Lab'} rate: ${P.format(f.sampleRate)} Hz. ${imported ? 'Full precision coefficients from JSON.' : 'Feedback terms change sign when moved into the denominator.'}`;
    $('filter-rate-choice').hidden = !imported || f.sampleRate === config.sampleRate;
    value('filter-rate-policy', '', true); $('filter-preview').hidden = false; clearError();
  }
  function previewFilter(event) {
    event.preventDefault(); invalidatePreview();
    try {
      const method = $('filter-method').value, descriptor = { ...C.clone(config.filters[selectedSlot]), enabled: true, method };
      let f;
      if (method === 'expression') f = D.parseExpression($('filter-expression').value, config.sampleRate);
      else if (method === 'equation') f = C.parseEquation($('filter-equation').value, config.sampleRate);
      else if (method === 'coefficients') f = D.normalize(D.parseCoefficients($('filter-b').value), D.parseCoefficients($('filter-a').value), config.sampleRate);
      else {
        Object.assign(descriptor, { type: $('filter-type').value, frequency: Number($('filter-frequency').value), upperFrequency: Number($('filter-upper').value),
          q: Number($('filter-q').value), taps: Number($('filter-taps').value) });
        f = C.compileFilter(descriptor, config.sampleRate);
      }
      if (['expression', 'equation', 'coefficients'].includes(method)) descriptor.method = 'coefficients';
      descriptor.b = f.b; descriptor.a = f.a; presentFilter(f, descriptor);
    } catch (error) { showError(error); }
  }
  function applyFilter() {
    if (!preview) return;
    const next = C.clone(config), pending = preview;
    if (pending.imported && pending.filter.sampleRate !== next.sampleRate) {
      const policy = $('filter-rate-policy').value;
      if (!policy) { showError('Choose whether to adopt the source sampling rate or reinterpret its coefficients.'); return; }
      if (policy === 'adopt') next.sampleRate = pending.filter.sampleRate;
    }
    next.filters[pending.slot] = C.clone(pending.descriptor);
    if (commit(next, { force: true })) { check('filter-enabled', true); if (pending.imported) loadFilter(); invalidatePreview(); announce(`${pending.slot} filter applied.`); }
  }
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  function schedule() {
    generation++; const token = generation; clearTimeout(timer);
    $('compute-status').textContent = 'Updating…'; document.body.dataset.ready = 'false';
    $('export-csv').disabled = true;
    timer = setTimeout(() => calculate(token), 100);
  }
  async function calculate(token) {
    try {
      const liveConfig = C.clone(config), items = [], omitted = [];
      const baselines = C.comparisonConfigs(liveConfig), baselineColors = baselines.length === 2 ? [colors.gray, colors.blue] : [colors.gray, colors.purple, colors.blue];
      for (let i = 0; i < baselines.length; i++) {
        const active = i === baselines.length - 1;
        if (!active && !$('show-baselines').checked) continue;
        try { items.push({ name: baselines[i].name, config: baselines[i].config, model: C.compile(baselines[i].config), color: baselineColors[i], active }); }
        catch (error) { if (active) throw error; omitted.push(`${baselines[i].name}: ${error.message}`); }
      }
      snapshots.forEach((s, i) => { if (s.visible && s.config.view === liveConfig.view) {
        try { items.push({ name: s.name, config: C.clone(s.config), model: C.compile(s.config), color: savedColors[i], active: false, saved: true }); }
        catch (error) { omitted.push(`${s.name}: ${error.message}`); }
      } });
      const jobs = [];
      for (const item of items) {
        item.stepJob = C.createSimulation(item.model, item.config.excitation === 'recovery' ? 'recovery' : 'step');
        item.impulseJob = C.createSimulation(item.model, 'impulse'); jobs.push(item.stepJob, item.impulseJob);
      }
      let cursor = 0;
      while (jobs.some(j => !j.done)) {
        if (token !== generation) return;
        const start = performance.now();
        do { const job = jobs[cursor++ % jobs.length]; if (!job.done) job.advance(128); }
        while (performance.now() - start < 10 && jobs.some(j => !j.done));
        await tick();
      }
      for (const item of items) {
        if (token !== generation) return;
        item.step = item.stepJob.result; item.impulse = item.impulseJob.result;
        item.main = item.config.excitation === 'impulse' ? item.impulse : item.step;
        item.frequency = C.frequency(item.model); await tick();
      }
      if (token !== generation) return;
      const active = items.find(i => i.active); active.analysis = C.analyze(active.model);
      rendered = { items, active, omitted }; renderResults();
      $('compute-status').textContent = 'Ready'; document.body.dataset.ready = 'true'; $('export-csv').disabled = false;
    } catch (error) {
      if (token !== generation) return;
      showError(error); $('compute-status').textContent = 'Check input'; document.body.dataset.ready = 'true';
    }
  }
  function renderResults() {
    const { items, active, omitted } = rendered, { model, analysis, main } = active, c = model.config;
    const label = { stable: 'Stable', unstable: 'Unstable', boundary: 'Unit-circle boundary', unknown: 'Uncertain' }[analysis.status];
    $('stability').textContent = `Linear · ${label}`; $('stability').className = `badge ${analysis.status}`;
    const warnings = [...omitted];
    if (analysis.warning) warnings.push(analysis.warning);
    if (analysis.status === 'unstable') warnings.push('The unsaturated linear realization is unstable. Frequency curves are algebraic unit-circle evaluations, not a stable steady-state response.');
    if (analysis.status === 'boundary') warnings.push('A pole lies on or near the unit circle. This is not asymptotic stability; a raw PI integrator is a typical example.');
    if (c.limits.enabled) warnings.push(`Limits are active${main.clipped ? ' and the command is clipping' : ''}. Time traces include clipping and anti-windup; frequency and pole analysis describe the unsaturated linear model.`);
    for (const item of items) for (const [name, trace] of [['step', item.step], ['impulse', item.impulse]]) if (trace.truncated) warnings.push(`${item.name}, ${name}: ${trace.reason}`);
    $('analysis-warning').hidden = !warnings.length; $('analysis-warning').textContent = [...new Set(warnings)].join(' ');
    const metrics = C.metrics(model, main, analysis);
    $('metric-overshoot').textContent = metrics.overshoot === null ? '—' : `${P.format(metrics.overshoot)}%`;
    $('metric-rise').textContent = metrics.rise === null ? '—' : `${P.format(metrics.rise * 1000)} ms`;
    $('metric-settling').textContent = metrics.settling === null ? 'Not settled' : `${P.format(metrics.settling * 1000)} ms`;
    const finalMetric = c.view === 'closed' ? metrics.error : metrics.final;
    $('metric-error-label').textContent = c.view === 'closed' ? 'Steady-state error' : 'Final output';
    $('metric-error').textContent = finalMetric === null ? '—' : Math.abs(finalMetric) < 1e-10 * Math.max(1, Math.abs(c.amplitude)) ? '≈ 0' : P.format(finalMetric);
    $('metrics-note').textContent = metrics.note;
    const timeMax = Math.max(...items.map(i => i.config.duration));
    const timeSeries = (traceKey, signal) => items.map(i => ({ name: i.name, color: i.color, xs: i[traceKey].time, ys: i[traceKey][signal], dash: !!i.saved }));
    $('step-title').textContent = items.some(i => i.step.excitation === 'recovery') ? 'Step / recovery response' : 'Step response';
    P.chart('step-plot', [{ name: c.view === 'controller' ? 'Imposed error' : 'Input / target', color: '#a9b2c0', xs: active.step.time, ys: active.step.input, dash: true }, ...timeSeries('step', 'y')], { xmax: timeMax });
    P.chart('impulse-plot', timeSeries('impulse', 'y'), { xmax: timeMax });
    const signal = (name, key, color, dash = false) => ({ name, color, xs: main.time, ys: main[key], dash });
    P.chart('effort-plot', [signal('PID output', 'raw', colors.blue), signal('Filtered command', 'command', colors.purple), signal('Actuator', 'actuator', colors.orange)], { xmax: c.duration });
    P.chart('terms-plot', [signal('P', 'p', colors.blue), signal('I', 'i', colors.green), signal('D', 'd', colors.orange)], { xmax: c.duration });
    P.chart('error-plot', c.view === 'closed' ? [signal('Target − output', 'trackingError', colors.blue), signal('PID input', 'filteredError', colors.purple, true)]
      : [signal('Imposed error', 'error', colors.gray), signal('Filtered PID input', 'filteredError', colors.blue)], { xmax: c.duration });
    const frequencySeries = key => items.map(i => ({ name: i.name, color: i.color, xs: i.frequency.map(r => r.hz), ys: i.frequency.map(r => r[key]), dash: !!i.saved }));
    const freqOptions = { xmin: c.sampleRate * 1e-5, xmax: c.sampleRate / 2, log: true, includeZero: false, xLabel: 'Frequency · Hz (log)' };
    P.chart('magnitude-plot', frequencySeries('db'), { ...freqOptions, db: true });
    P.chart('phase-plot', frequencySeries('phase'), freqOptions);
    P.poles(analysis);
    $('pole-note').textContent = `${model.states} active state${model.states === 1 ? '' : 's'} · Schur check: ${analysis.schur}. Uncancelled internal modes are retained. ${analysis.polePlotAvailable ? 'Overlapping roots share a marker; delay/FIR states can contribute origin poles.' : analysis.warning}`;
    $('curve-legend').innerHTML = items.map(i => `<span><i class="swatch" style="background:${i.color}"></i>${P.esc(i.name)}${i.saved ? ` · ${P.esc(P.format(i.config.sampleRate))} Hz` : ''}</span>`).join('');
    const dt = 1 / c.sampleRate, rho = c.pid.derivativeTau / (c.pid.derivativeTau + dt), gain = c.pid.kd / (c.pid.derivativeTau + dt);
    $('pid-equation').textContent = `u[n] = ${c.pid.kp}·e[n] + I[n] + D[n]\n${c.pid.ki ? `I[n+1] = I[n] + ${c.pid.ki * dt}·e[n]` : 'I disabled (Ki = 0)'}\n${c.pid.kd ? `D[n] = ${P.format(rho)}·D[n−1] + ${P.format(gain)}·(e[n]−e[n−1])` : 'D disabled (Kd = 0)'}${c.limits.enabled && c.limits.antiWindup && c.pid.ki ? `\nAnti-windup adds ${P.format(dt / c.limits.trackingTime)}·(u_applied−u_command) to I[n+1].` : ''}\ne is the filtered error entering the PID. Ts = ${P.format(dt)} s.`;
    $('chain-equation').textContent = c.view === 'closed' ? 'F = Fe · C · Fu · G · z⁻ᵈ\nL = F · H\nY/R = Fr · F / (1 + L)\nFr: setpoint; Fe: error; Fu: output; H: measurement.'
      : c.view === 'open' ? 'Y/R = Fr · Fe · C · Fu · G · z⁻ᵈ\nFeedback disconnected; H is inactive.' : 'U/E = Fe · C · Fu\nRaw comparison: U/E = C\nPlant, setpoint and measurement are inactive.';
    $('model-coefficients').textContent = JSON.stringify({ sampleRate: c.sampleRate, deadTimeSamples: model.delaySamples,
      controller: model.controller, plant: model.plant.transfer, filters: model.filters, linearResponse: model.linear.transfer }, null, 2);
    renderSnapshots();
  }
  function renderSnapshots() {
    $('save-comparison').textContent = `+ Save snapshot (${snapshots.length}/5)`; $('save-comparison').disabled = snapshots.length >= 5;
    $('saved-comparisons').hidden = !snapshots.length;
    $('comparison-list').replaceChildren();
    snapshots.forEach((s, i) => {
      const row = document.createElement('div'); row.className = 'saved-curve';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = s.visible; checkbox.setAttribute('aria-label', `Show ${s.name}`);
      checkbox.addEventListener('change', () => { s.visible = checkbox.checked; schedule(); });
      const swatch = document.createElement('span'); swatch.className = 'swatch'; swatch.style.background = savedColors[i];
      const name = document.createElement('input'); name.type = 'text'; name.value = s.name; name.maxLength = 100; name.setAttribute('aria-label', `Snapshot ${i + 1} name`);
      name.addEventListener('change', () => { s.name = name.value.trim() || `Snapshot ${i + 1}`; schedule(); });
      const detail = document.createElement('small'); detail.textContent = `${P.format(s.config.sampleRate)} Hz · ${s.config.view}${s.config.view !== config.view ? ' (switch view to compare)' : ''}`;
      const remove = document.createElement('button'); remove.className = 'remove-button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${s.name}`);
      remove.addEventListener('click', () => { snapshots.splice(i, 1); schedule(); });
      row.append(checkbox, swatch, name, detail, remove); $('comparison-list').append(row);
    });
  }
  function download(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement('a');
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function readJSON(input) {
    const file = input.files[0]; if (!file) return null;
    input.value = ''; if (file.size > 1024 * 1024) throw new Error('JSON files must be smaller than 1 MB.');
    try { return JSON.parse(await file.text()); } catch { throw new Error('This file is not valid JSON.'); }
  }

  $('preset').innerHTML = Object.entries(C.PRESETS).map(([key, p]) => `<option value="${key}">${P.esc(p.name)}</option>`).join('') + '<option value="custom" disabled>Custom experiment</option>';
  $('preset').addEventListener('change', () => { const key = $('preset').value; currentPreset = key; commit(C.preset(key), { force: true, filters: true, preset: true }); });
  $('reset-experiment').addEventListener('click', () => { if (currentPreset === 'custom') currentPreset = 'pi'; commit(C.preset(currentPreset), { force: true, filters: true, preset: true }); });
  for (const tab of ['pid', 'plant', 'filters', 'limits']) {
    $(`tab-${tab}`).addEventListener('click', () => activateTab(tab));
    $(`tab-${tab}`).addEventListener('keydown', event => {
      const tabs = ['pid', 'plant', 'filters', 'limits'], i = tabs.indexOf(tab);
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); activateTab(event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(i + (event.key === 'ArrowRight' ? 1 : 3)) % 4], true); }
    });
  }
  for (const [id, path, unit] of [['sample-rate', 'sampleRate'], ['duration', 'duration'], ['kp', 'pid.kp'], ['ki', 'pid.ki'], ['kd', 'pid.kd'],
    ['kp-range', 'pid.kp'], ['ki-range', 'pid.ki'], ['kd-range', 'pid.kd'], ['derivative-tau', 'pid.derivativeTau', 0.001],
    ['plant-gain', 'plant.gain'], ['plant-tau', 'plant.tau', 0.001], ['plant-frequency', 'plant.frequency'], ['plant-damping', 'plant.damping'],
    ['dead-time', 'delay', 0.001], ['limit-min', 'limits.min'], ['limit-max', 'limits.max'], ['tracking-time', 'limits.trackingTime', 0.001],
    ['amplitude', 'amplitude'], ['onset', 'onset'], ['return-time', 'returnTime'], ['return-level', 'returnLevel']]) bindNumber(id, path, unit || 1);
  bindCheck('limits-enabled', 'limits.enabled'); bindCheck('anti-windup', 'limits.antiWindup');
  $('plant-type').addEventListener('change', () => { const next = C.clone(config); next.plant.type = $('plant-type').value;
    if (next.plant.type === 'discrete') { const f = C.compilePlant(config.plant, config.sampleRate).transfer; next.plant.b = f.b; next.plant.a = f.a; }
    if (next.plant.type === 'continuous' && config.plant.type !== 'continuous') { next.plant.b = [1]; next.plant.a = [0.1, 1]; }
    commit(next, { force: true });
  });
  $('plant-coeff-form').addEventListener('submit', event => { event.preventDefault(); try { const next = C.clone(config); next.plant.b = D.parseCoefficients($('plant-b').value); next.plant.a = D.parseCoefficients($('plant-a').value); commit(next); } catch (error) { showError(error); } });
  $('excitation').addEventListener('change', () => { const next = C.clone(config); next.excitation = $('excitation').value; commit(next); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => { const next = C.clone(config); next.view = button.dataset.view; commit(next); }));
  document.querySelectorAll('[data-block]').forEach(button => button.addEventListener('click', () => {
    const key = button.dataset.block;
    if (C.SLOTS.includes(key)) { selectedSlot = key; activateTab('filters'); loadFilter(); $('filter-slot').focus(); }
    else { activateTab(key === 'delay' ? 'plant' : key); $(key === 'delay' ? 'dead-time' : key === 'plant' ? 'plant-type' : key === 'limits' ? 'limits-enabled' : 'kp').focus(); }
  }));
  $('filter-slot').addEventListener('change', () => { selectedSlot = $('filter-slot').value; loadFilter(); });
  $('filter-enabled').addEventListener('change', () => { const next = C.clone(config); next.filters[selectedSlot].enabled = $('filter-enabled').checked; commit(next); });
  $('filter-method').addEventListener('change', () => { invalidatePreview(); filterFields(); });
  $('filter-type').addEventListener('change', () => { invalidatePreview(); filterFields(); });
  $('filter-form').addEventListener('input', invalidatePreview);
  $('filter-form').addEventListener('submit', previewFilter); $('apply-filter').addEventListener('click', applyFilter);
  $('import-filter').addEventListener('click', () => $('filter-file').click());
  $('filter-file').addEventListener('change', async () => { try { const data = await readJSON($('filter-file')); if (!data) return; const f = C.importFilter(data);
    presentFilter(f, { ...C.clone(config.filters[selectedSlot]), enabled: true, method: 'coefficients', b: f.b, a: f.a }, true);
  } catch (error) { invalidatePreview(); showError(error); } });
  $('export-experiment').addEventListener('click', () => { try { download('controller-lab.json', JSON.stringify(C.exportExperiment(config, snapshots), null, 2) + '\n', 'application/json'); } catch (error) { showError(error); } });
  $('import-experiment').addEventListener('click', () => $('experiment-file').click());
  $('experiment-file').addEventListener('change', async () => { try { const data = await readJSON($('experiment-file')); if (!data) return; const imported = C.importExperiment(data);
    snapshots = imported.comparisons; commit(imported.config, { force: true, filters: true }); announce('Experiment imported.');
  } catch (error) { showError(error); } });
  $('export-csv').addEventListener('click', () => { if (rendered) download('controller-lab-traces.csv', C.csv(rendered.items.flatMap(i => [{ name: i.name, trace: i.step }, { name: i.name, trace: i.impulse }])), 'text/csv;charset=utf-8'); });
  $('show-baselines').addEventListener('change', schedule);
  $('save-comparison').addEventListener('click', () => { if (snapshots.length >= 5) return; snapshots.push({ name: `${C.controllerType(config.pid)} · snapshot ${snapshots.length + 1}`, visible: true, config: C.clone(config) }); schedule(); announce('Experiment snapshot saved.'); });
  $('clear-comparisons').addEventListener('click', () => { snapshots = []; schedule(); });
  // Read-only hooks also make the numerical state inspectable from the browser console.
  window.ControllerLabApp = { getConfig: () => C.clone(config), getSnapshots: () => C.clone(snapshots) };
  syncControls(true); loadFilter(); schedule();
})();
