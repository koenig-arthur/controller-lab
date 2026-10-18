/* SPDX-License-Identifier: GPL-3.0-only
 * Copyright (C) 2026 koenig-arthur
 * Controller Lab: DOM-independent sampled control models. No runtime dependencies
 * beyond the bundled FilterDSP. See LICENSE; provided without warranty.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./dsp.js') : root.FilterDSP);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ControlLab = api;
})(globalThis, function (D) {
  'use strict';
  const MAX_ORDER = 512, MAX_SAMPLES = 100000, LIMIT = 1e9;
  const SLOTS = ['setpoint', 'error', 'output', 'measurement'];
  const clone = value => JSON.parse(JSON.stringify(value));
  function finite(x, name) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${name} must be a finite number.`);
    return x;
  }
  function positive(x, name, zero = false) {
    finite(x, name);
    if (zero ? x < 0 : x <= 0) throw new Error(`${name} must be ${zero ? 'nonnegative' : 'greater than zero'}.`);
    return x;
  }
  function trim(a) { a = a.slice(); while (a.length > 1 && a.at(-1) === 0) a.pop(); return a; }
  function add(a, b, sign = 1) { return trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => (a[i] || 0) + sign * (b[i] || 0))); }
  function mul(a, b) { return trim(D.convolve(a, b)); }
  function tf(b, a = [1], fs = 1000) {
    if (!Array.isArray(b) || !Array.isArray(a) || !b.length || !a.length) throw new Error('Coefficient lists must not be empty.');
    if (Math.max(b.length, a.length) > MAX_ORDER + 1) throw new Error(`Combined model exceeds order ${MAX_ORDER}.`);
    [...b, ...a].forEach(v => finite(v, 'Coefficient'));
    if (a[0] === 0) throw new Error('Singular model: the current-sample denominator is zero.');
    const f = { b: trim(b.map(v => v / a[0])), a: trim(a.map(v => v / a[0])), sampleRate: fs };
    [...f.b, ...f.a].forEach(v => finite(v, 'Normalized coefficient'));
    return f;
  }
  const identity = fs => tf([1], [1], fs);
  const series = (a, b) => tf(mul(a.b, b.b), mul(a.a, b.a), a.sampleRate);
  const parallel = (a, b) => tf(add(mul(a.b, b.a), mul(b.b, a.a)), mul(a.a, b.a), a.sampleRate);
  const order = f => Math.max(f.a.length, f.b.length) - 1;

  function defaults() {
    return { sampleRate: 1000, duration: 1.2, onset: 0.05, amplitude: 1, returnTime: 0.6, returnLevel: 0.3,
      excitation: 'step', view: 'closed', pid: { kp: 1, ki: 10, kd: 0, derivativeTau: 0.01 },
      plant: { type: 'first', gain: 1, tau: 0.1, frequency: 3, damping: 0.35, b: [1], a: [0.1, 1] },
      delay: 0, filters: Object.fromEntries(SLOTS.map(k => [k, { enabled: false, method: 'iir', type: 'lowpass',
        frequency: 20, upperFrequency: 40, q: Math.SQRT1_2, taps: 15, b: [1], a: [1] }])),
      limits: { enabled: false, min: -1, max: 1, antiWindup: true, trackingTime: 0.05 } };
  }

  // Parse a deliberately small grammar, never JavaScript or a symbolic evaluator.
  function parseEquation(source, fs = 1000) {
    let s = String(source).replace(/[−–]/g, '-').replace(/[·×]/g, '*').replace(/\s+/g, '');
    const sides = s.split('=');
    if (sides.length !== 2 || sides[0] !== 'y[n]') throw new Error('Start with y[n] = and a sum of x[n-k] / y[n-k] terms.');
    s = sides[1];
    const number = '(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
    const term = new RegExp(`([+-]?)(?:(${number})\\*?)?([xy])\\[n(?:-(\\d+))?\\]`, 'y');
    const b = [0], a = [1]; let pos = 0, count = 0;
    while (pos < s.length) {
      term.lastIndex = pos;
      const m = term.exec(s);
      if (!m || (pos > 0 && !m[1])) throw new Error(`Invalid difference-equation term near “${s.slice(pos, pos + 24)}”. Use linear, causal sample terms.`);
      const k = m[4] ? Number(m[4]) : 0;
      if (k > 64) throw new Error('A filter may use delays through 64 samples.');
      if (m[3] === 'y' && k === 0) throw new Error('Only past y samples are allowed on the right side.');
      const v = finite((m[1] === '-' ? -1 : 1) * (m[2] === undefined ? 1 : Number(m[2])), 'Equation coefficient');
      const target = m[3] === 'x' ? b : a;
      while (target.length <= k) target.push(0);
      target[k] += m[3] === 'x' ? v : -v;
      pos = term.lastIndex; count++;
    }
    if (!count) throw new Error('Enter at least one sample term.');
    return D.normalize(b, a, fs);
  }

  // Small dense matrices (continuous plant order <= 8). Scaled Taylor exponential
  // of the augmented ZOH matrix avoids inverting A, including integrators.
  const zeros = (n, m = n) => Array.from({ length: n }, () => Array(m).fill(0));
  const eye = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => +(i === j)));
  const mm = (a, b) => a.map(row => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
  const mv = (a, x) => a.map(row => row.reduce((s, v, j) => s + v * x[j], 0));
  const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
  const norm = a => Math.max(...a.map(row => row.reduce((s, v) => s + Math.abs(v), 0)));
  function expm(matrix) {
    const n = matrix.length, magnitude = norm(matrix);
    finite(magnitude, 'Plant matrix norm');
    const squares = Math.max(0, Math.ceil(Math.log2(magnitude / 0.5)));
    if (squares > 60) throw new Error('Continuous model is too poorly scaled for reliable discretization.');
    const a = matrix.map(row => row.map(v => v / 2 ** squares));
    let out = eye(n), term = eye(n), converged = false;
    for (let k = 1; k <= 60; k++) {
      term = mm(term, a).map(row => row.map(v => v / k));
      out = out.map((row, i) => row.map((v, j) => v + term[i][j]));
      if (norm(term) < 1e-16 * Math.max(1, norm(out))) { converged = true; break; }
    }
    if (!converged) throw new Error('Continuous plant discretization did not converge.');
    for (let k = 0; k < squares; k++) out = mm(out, out);
    out.flat().forEach(v => finite(v, 'Discretized plant'));
    return out;
  }
  function stateToTF(A, B, C, feedthrough, fs) {
    const n = A.length;
    let R = eye(n); const a = [1];
    for (let k = 1; k <= n; k++) {
      const product = mm(A, R), c = -product.reduce((s, row, i) => s + row[i], 0) / k;
      a.push(c); R = product.map((row, i) => row.map((v, j) => v + (i === j ? c : 0)));
    }
    const h = [feedthrough]; let v = B.slice();
    for (let k = 1; k <= n; k++) { h.push(dot(C, v)); v = mv(A, v); }
    const b = h.map((_, k) => a.slice(0, k + 1).reduce((s, av, j) => s + av * h[k - j], 0));
    return tf(b, a, fs);
  }
  function discretize(numerator, denominator, fs) {
    positive(fs, 'Sampling rate');
    if (!Array.isArray(numerator) || !Array.isArray(denominator) || !numerator.length || !denominator.length) throw new Error('Enter continuous numerator and denominator coefficients.');
    [...numerator, ...denominator].forEach(v => finite(v, 'Continuous coefficient'));
    let a = denominator.slice(), b = numerator.slice();
    while (a.length > 1 && a[0] === 0) a.shift();
    while (b.length > 1 && b[0] === 0) b.shift();
    if (a[0] === 0) throw new Error('Continuous denominator cannot be zero.');
    if (b.length > a.length) throw new Error('Continuous plant must be proper: numerator degree cannot exceed denominator degree.');
    const n = a.length - 1;
    if (n > 8) throw new Error('Continuous plant order must be at most eight.');
    b = Array(a.length - b.length).fill(0).concat(b).map(v => v / a[0]);
    a = a.map(v => v / a[0]);
    const feedthrough = b[0];
    if (!n) return { transfer: tf([feedthrough], [1], fs), state: { A: [], B: [], C: [], D: feedthrough } };
    const aug = zeros(n + 1);
    aug[0] = a.slice(1).map(v => -v / fs).concat(1 / fs);
    for (let i = 1; i < n; i++) aug[i][i - 1] = 1 / fs;
    const discrete = expm(aug), A = discrete.slice(0, n).map(row => row.slice(0, n));
    const B = discrete.slice(0, n).map(row => row[n]), C = b.slice(1).map((v, i) => v - feedthrough * a[i + 1]);
    const transfer = stateToTF(A, B, C, feedthrough, fs);
    let numericalWarning = '';
    try {
      if (rootUncertainty(transfer.a, D.polynomialRoots(transfer.a)) > 1e-6) numericalWarning = 'The sampled plant denominator is sensitive to coefficient rounding. Time/frequency responses use its state-space model, but polynomial stability cannot be certified.';
    } catch { numericalWarning = 'The sampled plant denominator could not be verified. Time/frequency responses use its state-space model; polynomial stability is uncertain.'; }
    return { transfer, state: { A, B, C, D: feedthrough }, numericalWarning };
  }
  function compilePlant(p, fs) {
    finite(p.gain, 'Plant gain');
    if (p.type === 'discrete') return { transfer: D.normalize(p.b, p.a, fs), state: null };
    if (p.type === 'continuous') return discretize(p.b, p.a, fs);
    if (p.type === 'unity') return discretize([p.gain], [1], fs);
    if (p.type === 'first') return discretize([p.gain], [positive(p.tau, 'Time constant'), 1], fs);
    if (p.type === 'integrator') return discretize([p.gain], [1, 0], fs);
    if (p.type === 'second') {
      const w = 2 * Math.PI * positive(p.frequency, 'Natural frequency');
      positive(p.damping, 'Damping ratio', true);
      return discretize([p.gain * w * w], [1, 2 * p.damping * w, w * w], fs);
    }
    throw new Error('Unknown plant type.');
  }
  function compileFilter(f, fs) {
    if (!f.enabled) return identity(fs);
    if (f.method === 'iir') return D.designIIR(f, fs);
    if (f.method === 'fir') return D.designFIR(f, fs);
    if (f.method === 'average') {
      if (!Number.isInteger(f.taps) || f.taps < 1 || f.taps > 65) throw new Error('Moving average length must be 1–65 samples.');
      return D.normalize(Array(f.taps).fill(1 / f.taps), [1], fs);
    }
    if (f.method === 'coefficients') return D.normalize(f.b, f.a, fs);
    throw new Error('Unknown filter method.');
  }
  function controllerTF(pid, fs) {
    const { kp, ki, kd, derivativeTau: tau } = pid, dt = 1 / fs;
    [kp, ki, kd].forEach(v => finite(v, 'PID gain')); positive(tau, 'Derivative time constant', true);
    let c = tf([kp], [1], fs);
    if (ki !== 0) c = parallel(c, tf([0, ki * dt], [1, -1], fs));
    if (kd !== 0) c = parallel(c, tf([kd / (tau + dt), -kd / (tau + dt)], [1, -tau / (tau + dt)], fs));
    return c;
  }
  function controllerType(p) {
    return [['P', p.kp], ['I', p.ki], ['D', p.kd]].filter(([, v]) => v !== 0).map(([s]) => s).join('') || 'Zero';
  }
  function validateConfig(input) {
    if (!input || typeof input !== 'object') throw new Error('Missing experiment configuration.');
    const c = clone(input);
    positive(c.sampleRate, 'Sampling rate'); positive(c.duration, 'Duration');
    positive(c.onset, 'Input onset', true); finite(c.amplitude, 'Input amplitude');
    positive(c.returnTime, 'Return time', true); finite(c.returnLevel, 'Return level');
    if (c.onset >= c.duration || Math.round(c.onset * c.sampleRate) > Math.floor(c.duration * c.sampleRate)) throw new Error('Input onset must land on a sample within the simulation window.');
    if (!['closed', 'open', 'controller'].includes(c.view)) throw new Error('Unknown response view.');
    if (!['step', 'impulse', 'recovery'].includes(c.excitation)) throw new Error('Unknown excitation.');
    if (c.excitation === 'recovery' && (c.returnTime <= c.onset || c.returnTime >= c.duration
      || Math.round(c.returnTime * c.sampleRate) <= Math.round(c.onset * c.sampleRate)
      || Math.round(c.returnTime * c.sampleRate) > Math.floor(c.duration * c.sampleRate))) throw new Error('Return time must land on a later sample than the first step, within the simulation window.');
    if (Math.floor(c.duration * c.sampleRate) + 1 > MAX_SAMPLES) throw new Error(`Choose a duration / sample rate giving at most ${MAX_SAMPLES.toLocaleString()} samples.`);
    positive(c.delay, 'Dead time', true);
    if (Math.round(c.delay * c.sampleRate) > MAX_ORDER) throw new Error('Dead time exceeds 512 samples; reduce the sampling rate or delay.');
    if (!c.pid || !c.plant || !c.filters || !c.limits) throw new Error('Experiment is missing PID, plant, filters or limits.');
    SLOTS.forEach(k => { if (!c.filters[k]) throw new Error(`Missing ${k} filter.`); });
    finite(c.limits.min, 'Lower limit'); finite(c.limits.max, 'Upper limit');
    if (c.limits.min >= c.limits.max) throw new Error('Lower actuator limit must be less than upper limit.');
    positive(c.limits.trackingTime, 'Anti-windup tracking time');
    if (c.limits.enabled && c.limits.antiWindup && c.pid.ki !== 0 && c.limits.trackingTime < 1 / c.sampleRate) throw new Error('Anti-windup tracking time must be at least one sample interval.');
    return c;
  }
  function compile(input) {
    const config = validateConfig(input), fs = config.sampleRate;
    const filters = Object.fromEntries(SLOTS.map(k => [k, compileFilter(config.filters[k], fs)]));
    const plant = compilePlant(config.plant, fs), controller = controllerTF(config.pid, fs);
    const delaySamples = Math.round(config.delay * fs), delay = tf(Array(delaySamples).fill(0).concat(1), [1], fs);
    const active = config.view === 'controller' ? ['error', 'output'] : config.view === 'open' ? ['setpoint', 'error', 'output'] : SLOTS;
    const states = active.reduce((s, k) => s + order(filters[k]), 0) + order(controller)
      + (config.view === 'controller' ? 0 : (plant.state ? plant.state.A.length : order(plant.transfer)) + delaySamples);
    if (states > MAX_ORDER) throw new Error(`Combined model has ${states} states; the maximum is ${MAX_ORDER}. Shorten filters/delay or lower the sampling rate.`);
    const compiled = { config, filters, plant, controller, delay, delaySamples, states };
    compiled.linear = linearModel(compiled);
    return compiled;
  }
  function linearModel(m) {
    const { config: c, filters: f, controller: C, plant, delay } = m;
    const Q = series(series(f.error, C), f.output);
    if (c.view === 'controller') return { transfer: Q, loop: null, characteristic: Q.a };
    const F = series(series(Q, plant.transfer), delay);
    if (c.view === 'open') { const transfer = series(f.setpoint, F); return { transfer, loop: null, characteristic: transfer.a }; }
    const loop = series(F, f.measurement);
    const denominator = add(loop.a, loop.b);
    const scale = Math.max(...loop.a.map(Math.abs), ...loop.b.map(Math.abs), 1e-300);
    if (Math.abs(denominator[0]) < 1e-13 * scale) throw new Error('Singular or ill-conditioned current-sample feedback. Change gains or add an explicit delay.');
    const transfer = series(f.setpoint, tf(mul(F.b, f.measurement.a), denominator, c.sampleRate));
    return { transfer, loop, characteristic: transfer.a };
  }

  function schur(coefficients) {
    // Long-delay polynomials can exhaust double precision during Schur reduction.
    // Use 80 decimal digits of fixed-point arithmetic, renormalized after every
    // stage. This checks the supplied coefficients; it cannot recover precision
    // already lost while constructing a poorly conditioned transfer function.
    const scale = 10n ** 80n, abs = v => v < 0n ? -v : v;
    const source = trim(coefficients), peak = Math.max(...source.map(Math.abs));
    if (!peak || !Number.isFinite(peak)) return { status: 'unknown', reason: 'Invalid characteristic polynomial.' };
    const convert = v => {
      const [mantissa, exponent] = (v / peak).toExponential(17).split('e');
      const integer = BigInt(mantissa.replace('.', '')), shift = 80 + Number(exponent) - 17;
      return shift >= 0 ? integer * 10n ** BigInt(shift) : integer / 10n ** BigInt(-shift);
    };
    let a = source.map(convert), smallest = 1;
    if (source.some((v, i) => v !== 0 && a[i] === 0n)) return { status: 'unknown', reason: 'Characteristic coefficient range exceeds the Schur precision budget.' };
    while (a.length > 1) {
      const first = abs(a[0]), last = abs(a.at(-1));
      if (first === 0n || abs(first - last) * 10000000000n <= first) return { status: 'unknown', reason: 'Unit-circle boundary or ill-conditioned Schur reduction.' };
      const gap = 1 - Number(last) / Number(first); smallest = Math.min(smallest, gap);
      if (last > first) return { status: 'unstable', clearance: gap };
      const next = a.slice(0, -1).map((v, i) => a[0] * v - a.at(-1) * a[a.length - 1 - i]);
      const norm = next.reduce((p, v) => abs(v) > p ? abs(v) : p, 0n);
      if (norm === 0n) return { status: 'unknown', reason: 'Schur reduction became singular.' };
      a = next.map(v => v * scale / norm);
    }
    return { status: 'stable', clearance: smallest };
  }
  function rootUncertainty(a, roots) {
    // First-order root sensitivity to coefficient roundoff. A small residual alone
    // does not establish trustworthy radii for nearly repeated sampled poles.
    return roots.reduce((worst, r) => {
      const { add, mul, abs } = D.complex;
      let p = D.C(a[0]), dp = D.C(), bound = Math.abs(a[0]);
      for (let i = 1; i < a.length; i++) { dp = add(mul(dp, r), p); p = add(mul(p, r), D.C(a[i])); bound = bound * abs(r) + Math.abs(a[i]); }
      return Math.max(worst, (abs(p) + 32 * Number.EPSILON * a.length * bound) / Math.max(abs(dp), 1e-300));
    }, 0);
  }
  function analyze(m) {
    const { characteristic: a, transfer } = m.linear;
    const s = schur(a); let status = s.status, poles = [], zerosFound = [], warning = s.reason || '';
    const charDegree = a.length - 1;
    if (m.states <= 64) {
      try {
        const recovered = D.polynomialRoots(a), uncertainty = rootUncertainty(a, recovered);
        poles = recovered.concat(Array.from({ length: Math.max(0, m.states - charDegree) }, () => D.C()));
        const radius = Math.max(0, ...poles.map(D.complex.abs));
        const rootsStatus = radius > 1 + 1e-8 ? 'unstable' : radius >= 1 - 1e-8 ? 'boundary' : 'stable';
        if (uncertainty > 1e-6) {
          status = 'unknown'; poles = []; warning = 'Pole radii are too sensitive to coefficient rounding to verify. The coefficient-based Schur result is not sufficient to certify this realization.';
        } else if ((s.status === 'stable' && rootsStatus === 'unstable') || (s.status === 'unstable' && rootsStatus === 'stable')) {
          status = 'unknown'; warning = 'Root and Schur checks disagree; numerical stability is uncertain.';
        } else { status = rootsStatus; if (rootsStatus !== 'boundary') warning = ''; }
        if (transfer.b.some(v => v !== 0)) zerosFound = D.polynomialRoots(transfer.b);
      } catch (error) { warning = `Pole/zero recovery: ${error.message}`; }
    } else warning = 'Pole plotting is limited to 64 states. The Schur test still checks this complete model.';
    if (m.config.view !== 'controller' && m.plant.numericalWarning) {
      status = 'unknown'; poles = []; warning = m.plant.numericalWarning;
    }
    return { status, schur: s.status, poles, zeros: zerosFound, warning, states: m.states, polePlotAvailable: m.states <= 64 && poles.length === m.states };
  }

  function filterBlock(f) {
    const n = order(f), state = new Float64Array(n);
    return { peek: () => ({ d: f.b[0], h: state[0] || 0 }), step(x) {
      const y = f.b[0] * x + (state[0] || 0);
      for (let i = 0; i < n; i++) state[i] = (state[i + 1] || 0) + (f.b[i + 1] || 0) * x - (f.a[i + 1] || 0) * y;
      return y;
    }, magnitude: () => state.reduce((v, x) => Math.max(v, Math.abs(x)), 0) };
  }
  function plantBlock(p) {
    if (!p.state) return filterBlock(p.transfer);
    const { A, B, C, D: feedthrough } = p.state; let state = Array(A.length).fill(0);
    return { peek: () => ({ d: feedthrough, h: dot(C, state) }), step(x) {
      const y = feedthrough * x + dot(C, state);
      state = mv(A, state).map((v, i) => v + B[i] * x); return y;
    }, magnitude: () => Math.max(0, ...state.map(Math.abs)) };
  }
  function delayBlock(n) {
    const values = new Float64Array(n); let at = 0;
    return { peek: () => ({ d: n ? 0 : 1, h: n ? values[at] : 0 }), step(x) {
      if (!n) return x;
      const y = values[at]; values[at] = x; at = (at + 1) % n; return y;
    }, magnitude: () => 0 };
  }
  function pidBlock(pid, fs) {
    let integral = 0, derivative = 0, previous = 0;
    const dt = 1 / fs, g = pid.kd / (pid.derivativeTau + dt), rho = pid.derivativeTau / (pid.derivativeTau + dt);
    return { peek: () => ({ d: pid.kp + g, h: integral + (pid.kd ? rho * derivative - g * previous : 0) }),
      step(e) {
        const p = pid.kp * e, i = pid.ki ? integral : 0;
        const d = pid.kd ? rho * derivative + g * (e - previous) : 0;
        derivative = d; previous = e; return { p, i, d, raw: p + i + d };
      }, update(e, residual, limits) {
        if (!pid.ki) { integral = 0; return; }
        integral += pid.ki * dt * e;
        if (limits.enabled && limits.antiWindup) integral += dt / limits.trackingTime * residual;
      }, magnitude: () => Math.max(Math.abs(integral), Math.abs(derivative)) };
  }
  const cascadePeek = blocks => blocks.reduce((v, b) => { const p = b.peek(); return { d: p.d * v.d, h: p.d * v.h + p.h }; }, { d: 1, h: 0 });
  function solveActuator(base, slope, limits) {
    const den = 1 - slope;
    if (!limits.enabled) {
      if (Math.abs(den) < 1e-13 * Math.max(1, Math.abs(slope))) throw new Error('Singular current-sample feedback.');
      return base / den;
    }
    const { min, max } = limits, tolerance = 1e-10 * Math.max(1, Math.abs(min), Math.abs(max));
    const candidates = [];
    if (Math.abs(den) < 1e-13 && Math.abs(base) <= tolerance) throw new Error('Nonunique saturated feedback: infinitely many current-sample solutions.');
    const addCandidate = x => { if (!candidates.some(v => Math.abs(v - x) <= tolerance)) candidates.push(x); };
    if (Math.abs(den) >= 1e-13) {
      const x = base / den;
      if (x >= min - tolerance && x <= max + tolerance) addCandidate(Math.max(min, Math.min(max, x)));
    }
    if (base + slope * min <= min + tolerance) addCandidate(min);
    if (base + slope * max >= max - tolerance) addCandidate(max);
    if (candidates.length !== 1) throw new Error(`${candidates.length ? 'Nonunique' : 'No consistent'} saturated feedback solution. Change gains or add an explicit plant delay.`);
    return candidates[0];
  }
  function createSimulation(m, excitation = m.config.excitation) {
    const c = m.config, fs = c.sampleRate, closed = c.view === 'closed', controllerOnly = c.view === 'controller';
    const filters = Object.fromEntries(SLOTS.map(k => [k, filterBlock(m.filters[k])]));
    const pid = pidBlock(c.pid, fs), plant = plantBlock(m.plant), delay = delayBlock(m.delaySamples);
    const count = Math.floor(c.duration * fs) + 1, onset = Math.round(c.onset * fs), returnAt = Math.round(c.returnTime * fs);
    const keys = ['time', 'input', 'reference', 'y', 'measured', 'error', 'filteredError', 'p', 'i', 'd', 'raw', 'command', 'actuator', 'trackingError'];
    const result = Object.fromEntries(keys.map(k => [k, []]));
    Object.assign(result, { truncated: false, reason: '', clipped: false, excitation, sampleRate: fs });
    let n = 0, done = false;
    function advance(budget = 512) {
      for (let stop = Math.min(count, n + budget); n < stop && !done; n++) {
        try {
          const input = excitation === 'impulse' ? (n === onset ? c.amplitude : 0)
            : n < onset ? 0 : excitation === 'recovery' && n >= returnAt ? c.returnLevel : c.amplitude;
          const reference = controllerOnly ? input : filters.setpoint.step(input);
          const forward = cascadePeek([filters.error, pid, filters.output]);
          const gp = controllerOnly ? { d: 1, h: 0 } : cascadePeek([plant, delay]);
          const sensor = closed ? filters.measurement.peek() : { d: 0, h: 0 };
          const e0 = reference - (closed ? sensor.d * gp.h + sensor.h : 0);
          const eslope = closed ? -sensor.d * gp.d : 0;
          const actuator = solveActuator(forward.d * e0 + forward.h, forward.d * eslope, c.limits);
          const error = e0 + eslope * actuator, filteredError = filters.error.step(error);
          const terms = pid.step(filteredError), command = filters.output.step(terms.raw);
          const y = controllerOnly ? actuator : delay.step(plant.step(actuator));
          const measured = closed ? filters.measurement.step(y) : y;
          pid.update(filteredError, actuator - command, c.limits);
          const row = { time: n / fs, input, reference, y, measured, error, filteredError, ...terms, command, actuator, trackingError: input - y };
          const activeBlocks = [pid, filters.error, filters.output, ...(controllerOnly ? [] : [plant, filters.setpoint]), ...(closed ? [filters.measurement] : [])];
          if (Object.values(row).some(v => !Number.isFinite(v) || Math.abs(v) > LIMIT)
              || activeBlocks.some(b => !Number.isFinite(b.magnitude()) || b.magnitude() > LIMIT)) throw new Error('Simulation stopped before a nonfinite value or magnitude above 1e9.');
          keys.forEach(k => result[k].push(row[k]));
          if (Math.abs(command - actuator) > 1e-10 * Math.max(1, Math.abs(command))) result.clipped = true;
        } catch (error) { result.truncated = true; result.reason = error.message; done = true; }
      }
      if (n >= count) done = true;
      return done;
    }
    return { result, advance, get done() { return done; } };
  }
  function simulate(m, excitation) { const job = createSimulation(m, excitation); while (!job.advance(2048)) { /* synchronous test / export helper */ } return job.result; }
  function metrics(m, trace, analysis) {
    const c = m.config, empty = { final: null, error: null, overshoot: null, rise: null, settling: null, observed: c.limits.enabled, note: '' };
    if (trace.truncated) return { ...empty, note: 'Simulation stopped; response metrics are unavailable.' };
    if (trace.excitation !== 'step') return { ...empty, note: 'Step metrics apply to a single step; select Step to measure them.' };
    if (c.amplitude === 0) return { ...empty, note: 'Use a nonzero step amplitude for response metrics.' };
    const onset = Math.round(c.onset * c.sampleRate), ys = trace.y.slice(onset), ts = trace.time.slice(onset).map(t => t - onset / c.sampleRate);
    if (!ys.length) return empty;
    let final;
    if (!c.limits.enabled) {
      if (analysis.status !== 'stable') return { ...empty, note: 'No verified asymptotically stable linear response.' };
      const dc = D.responseAt(m.linear.transfer, 0);
      if (dc.kind !== 'finite') return { ...empty, note: 'Steady-state response is undefined.' };
      final = c.amplitude * dc.magnitude * (Math.cos(dc.phase || 0) < 0 ? -1 : 1);
    } else {
      const tail = ys.slice(-Math.max(10, Math.ceil(ys.length * 0.1)));
      final = tail.reduce((s, v) => s + v, 0) / tail.length;
      const variation = Math.max(...tail) - Math.min(...tail);
      if (variation > 0.02 * Math.max(Math.abs(final), Math.abs(c.amplitude), 1e-12)) return { ...empty, note: 'No observed plateau in the last 10% of this window.' };
    }
    if (Math.abs(final) < 1e-12) return { ...empty, final, error: c.amplitude - final, note: 'Final output is zero; relative rise/overshoot/settling metrics are undefined.' };
    const normalized = ys.map(y => y / final), low = normalized.findIndex(v => v >= 0.1), high = normalized.findIndex(v => v >= 0.9);
    let lastOutside = -1;
    normalized.forEach((v, i) => { if (Math.abs(v - 1) > 0.02) lastOutside = i; });
    return { final, error: c.amplitude - final, overshoot: Math.max(0, Math.max(...normalized) - 1) * 100,
      rise: low >= 0 && high >= 0 ? ts[high] - ts[low] : null,
      settling: lastOutside < ys.length - 1 ? ts[lastOutside + 1] : null, observed: c.limits.enabled,
      note: `${c.limits.enabled ? 'Observed nonlinear plateau; ' : ''}rise 10–90% and settling ±2% of final output, within the displayed window.` };
  }
  function stateResponse(state, hz, fs) {
    const X = D.complex, z = D.C(Math.cos(2 * Math.PI * hz / fs), Math.sin(2 * Math.PI * hz / fs));
    const n = state.A.length;
    if (!n) return D.C(state.D);
    const a = state.A.map((row, i) => row.map((v, j) => i === j ? X.sub(z, D.C(v)) : D.C(-v)).concat(D.C(state.B[i])));
    // Complex Gaussian elimination with scaled row pivoting on zI - Ad.
    const scales = a.map(row => Math.max(...row.slice(0, n).map(X.abs), 1e-300));
    for (let k = 0; k < n; k++) {
      let pivot = k;
      for (let i = k + 1; i < n; i++) if (X.abs(a[i][k]) / scales[i] > X.abs(a[pivot][k]) / scales[pivot]) pivot = i;
      [a[k], a[pivot]] = [a[pivot], a[k]]; [scales[k], scales[pivot]] = [scales[pivot], scales[k]];
      if (X.abs(a[k][k]) < 1e-15 * scales[k]) return null;
      for (let i = k + 1; i < n; i++) {
        const factor = X.div(a[i][k], a[k][k]);
        for (let j = k + 1; j <= n; j++) a[i][j] = X.sub(a[i][j], X.mul(factor, a[k][j]));
        a[i][k] = D.C();
      }
    }
    const solution = Array.from({ length: n }, () => D.C());
    for (let i = n - 1; i >= 0; i--) {
      let rhs = a[i][n]; for (let j = i + 1; j < n; j++) rhs = X.sub(rhs, X.mul(a[i][j], solution[j]));
      solution[i] = X.div(rhs, a[i][i]);
    }
    return solution.reduce((v, x, i) => X.add(v, X.mul(D.C(state.C[i]), x)), D.C(state.D));
  }
  function frequencyAt(m, hz) {
    const X = D.complex, fs = m.config.sampleRate;
    finite(hz, 'Frequency');
    if (hz < 0 || hz > fs / 2) throw new Error('Frequency must lie between zero and Nyquist.');
    // At DC an integral controller is singular by itself, while its feedback
    // transfer can have a finite limit. The unsimplified transfer retains 0/0
    // warnings for hidden DC cancellations.
    if (hz === 0 && cIsClosedWithIntegral(m) && !m.plant.numericalWarning) return D.responseAt(m.linear.transfer, hz);
    const block = f => {
      const r = D.responseAt(f, hz);
      return r.kind === 'finite' ? D.C(r.magnitude * Math.cos(r.phase || 0), r.magnitude * Math.sin(r.phase || 0)) : null;
    };
    const { filters: f, config: c } = m;
    let out = block(f.error), controller = block(m.controller), output = block(f.output);
    const unavailable = { frequency: hz, kind: 'singular', magnitude: null, db: null, phase: null };
    if (!out || !controller || !output) return unavailable;
    out = X.mul(X.mul(out, controller), output);
    if (c.view !== 'controller') {
      const plant = m.plant.state ? stateResponse(m.plant.state, hz, fs) : block(m.plant.transfer);
      const reference = block(f.setpoint);
      if (!plant || !reference) return unavailable;
      out = X.mul(out, plant);
      const w = -2 * Math.PI * hz / fs * m.delaySamples;
      out = X.mul(out, D.C(Math.cos(w), Math.sin(w)));
      if (c.view === 'closed') {
        const measurement = block(f.measurement); if (!measurement) return unavailable;
        const denominator = X.add(D.C(1), X.mul(out, measurement));
        if (X.abs(denominator) <= 1e-14 * Math.max(1, X.abs(out) * X.abs(measurement))) return unavailable;
        out = X.div(out, denominator);
      }
      out = X.mul(reference, out);
    }
    const magnitude = X.abs(out);
    if (!Number.isFinite(magnitude)) return unavailable;
    return { frequency: hz, kind: 'finite', magnitude, db: magnitude ? 20 * Math.log10(magnitude) : -Infinity,
      phase: magnitude ? Math.atan2(out.im, out.re) : null };
  }
  function cIsClosedWithIntegral(m) { return m.config.view === 'closed' && m.config.pid.ki !== 0; }
  function frequency(m, count = 600) {
    const fs = m.config.sampleRate, min = fs * 1e-5;
    const values = [];
    let previous = null, offset = 0;
    const mesh = Array.from({ length: count }, (_, k) => min * (fs / 2 / min) ** (k / (count - 1)));
    // Add a uniform mesh so high-order delay phase cannot wrap unseen between
    // widely spaced high-frequency points on the logarithmic mesh.
    const uniform = Math.max(128, m.states * 8);
    for (let k = 1; k <= uniform; k++) mesh.push(fs * k / (2 * uniform));
    for (const hz of [...new Set(mesh)].sort((a, b) => a - b)) {
      const r = frequencyAt(m, hz);
      let phase = r.phase;
      if (phase !== null) {
        if (previous !== null) { while (phase - previous > Math.PI) phase -= 2 * Math.PI; while (phase - previous < -Math.PI) phase += 2 * Math.PI; }
        previous = phase; offset = phase * 180 / Math.PI;
      } else previous = null;
      values.push({ hz, db: r.kind === 'finite' ? r.db : null, phase: phase === null ? null : offset });
    }
    return values;
  }
  function comparisonConfigs(c) {
    const raw = clone(c), filtered = clone(c);
    raw.delay = 0; SLOTS.forEach(k => { raw.filters[k].enabled = false; });
    if (c.view === 'controller') {
      raw.limits.enabled = false;
      return [{ name: 'Raw controller', config: raw }, { name: 'Filtered controller', config: clone(c) }];
    }
    filtered.delay = 0;
    return [{ name: 'PID + plant', config: raw }, { name: 'With filters', config: filtered }, { name: 'With filters + delay', config: clone(c) }];
  }
  function exportExperiment(config, comparisons = []) {
    compile(config);
    if (comparisons.length > 5) throw new Error('At most five saved comparisons are supported.');
    return { kind: 'controller-lab', version: 1, config: clone(config), comparisons: comparisons.map(s => {
      compile(s.config); return { name: String(s.name).slice(0, 100), visible: s.visible !== false, config: clone(s.config) };
    }) };
  }
  function importExperiment(data) {
    if (!data || data.kind !== 'controller-lab' || data.version !== 1) throw new Error('Choose a Controller Lab version 1 experiment. Import Filter Lab JSON inside a filter slot.');
    return exportExperiment(data.config, data.comparisons || []);
  }
  function importFilter(data) {
    if (!data || data.version !== 1 || data.kind) throw new Error('Expected a Filter Lab version 1 JSON filter.');
    return D.normalize(data.b, data.a, positive(data.sampleRate, 'Imported sampling rate'));
  }
  function csv(traces) {
    const columns = ['time', 'input', 'reference', 'y', 'measured', 'error', 'filteredError', 'p', 'i', 'd', 'raw', 'command', 'actuator', 'trackingError'];
    const lines = [['curve', 'excitation', ...columns].join(',')];
    traces.forEach(({ name, trace }) => trace.time.forEach((_, i) => lines.push([
      `"${String(name).replace(/"/g, '""')}"`, trace.excitation, ...columns.map(k => trace[k][i])].join(','))));
    return lines.join('\r\n') + '\r\n';
  }
  const PRESETS = {
    pi: { name: 'PI · 100 ms plant', note: 'Integral action removes the offset. Set Ki to zero and compare the final output; increase Kp to see the speed change.' },
    p: { name: 'P · steady-state offset', note: 'Proportional control needs a persistent error to hold a nonzero output. The target is 1; Kp = 1 gives a final output of 0.5.' },
    damping: { name: 'PID · damp an oscillation', note: 'A lightly damped plant rings. Save this response, then set Kd to zero to see how derivative action changes the damping.' },
    derivative: { name: 'D · derivative kick', note: 'A sudden change in error produces a derivative kick. Compare the P/I/D contributions and increase derivative smoothing.' },
    filtering: { name: 'Filters · the cost of smoothing', note: 'A measurement low-pass adds lag inside the feedback loop. Compare filtered and unfiltered responses, then move the same filter to the setpoint slot.' },
    delay: { name: 'Delay · lose stability', note: 'Dead time postpones every action. The same gains and plant can be stable without dead time and unstable when feedback arrives too late.' },
    windup: { name: 'Limits · windup recovery', note: 'The first target cannot be reached with these actuator limits. After the target falls, compare recovery with anti-windup on and off.' }
  };
  function preset(key) {
    const c = defaults();
    if (key === 'p') c.pid.ki = 0;
    else if (key === 'damping') { c.plant.type = 'second'; c.pid = { kp: 1.8, ki: 8, kd: 0.08, derivativeTau: 0.01 }; c.duration = 2; }
    else if (key === 'derivative') { c.view = 'controller'; c.pid = { kp: 1, ki: 0, kd: 0.03, derivativeTau: 0 }; c.duration = 0.4; }
    else if (key === 'filtering') { c.filters.measurement.enabled = true; c.filters.measurement.frequency = 5; c.pid.kp = 3; c.pid.ki = 20; c.duration = 2; }
    else if (key === 'delay') { c.pid.kp = 3; c.pid.ki = 20; c.delay = 0.1; c.duration = 2; }
    else if (key === 'windup') { c.limits.enabled = true; c.amplitude = 2; c.returnLevel = 0.3; c.returnTime = 1; c.duration = 2.5; c.excitation = 'recovery'; c.pid.ki = 15; }
    else if (key !== 'pi') throw new Error('Unknown experiment.');
    return c;
  }
  return { MAX_ORDER, MAX_SAMPLES, SLOTS, defaults, clone, tf, series, parallel, order, parseEquation,
    discretize, compilePlant, compileFilter, controllerTF, controllerType, validateConfig, compile, analyze, schur,
    createSimulation, simulate, metrics, frequencyAt, frequency, comparisonConfigs, exportExperiment, importExperiment, importFilter,
    csv, PRESETS, preset, solveActuator };
});
