/* SPDX-License-Identifier: GPL-3.0-only · Copyright (C) 2026 koenig-arthur */
(function (root) {
  'use strict';
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = v => !Number.isFinite(v) ? (v === -Infinity ? '−∞' : '—') : v === 0 ? '0' : Math.abs(v) >= 1e5 || Math.abs(v) < 1e-3 ? v.toExponential(2) : Number(v.toPrecision(4)).toString();
  const cache = new Map();
  function nearest(xs, x) { let lo = 0, hi = xs.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < x) lo = mid + 1; else hi = mid; } return lo > 0 && x - xs[lo - 1] < xs[lo] - x ? lo - 1 : lo; }
  // Preserve extrema and discontinuities rather than losing an impulse to stride sampling.
  function indices(ys, max = 1400) {
    if (ys.length <= max) return ys.map((_, i) => i);
    const out = [0], size = Math.ceil(ys.length / (max / 4));
    for (let start = 0; start < ys.length; start += size) {
      const end = Math.min(ys.length, start + size); let min = start, max = start, gap = -1;
      for (let i = start; i < end; i++) { if (ys[i] === null || Number.isNaN(ys[i])) gap = i; if (ys[i] < ys[min]) min = i; if (ys[i] > ys[max]) max = i; }
      out.push(...[start, min, max, ...(gap < 0 ? [] : [gap]), end - 1].sort((a, b) => a - b));
    }
    return [...new Set(out)];
  }
  function chart(id, series, options = {}) {
    const svg = document.getElementById(id), W = 600, H = 280, box = { l: 62, r: 580, t: 20, b: 238 };
    const log = !!options.log, tx = x => log ? Math.log10(x) : x;
    let xmin = options.xmin ?? 0, xmax = options.xmax ?? 1;
    if (xmax <= xmin) xmax = xmin + 1;
    let ymin = Infinity, ymax = -Infinity;
    for (const s of series) for (const y of s.ys) if (Number.isFinite(y)) { ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    if (ymin === Infinity) { ymin = -1; ymax = 1; }
    if (options.includeZero !== false) { ymin = Math.min(ymin, 0); ymax = Math.max(ymax, 0); }
    if (ymax - ymin < 1e-12 * Math.max(1, Math.abs(ymax))) { const pad = Math.max(0.5, Math.abs(ymax) * 0.1); ymin -= pad; ymax += pad; }
    else { const pad = (ymax - ymin) * 0.09; ymin -= pad; ymax += pad; }
    if (options.db) { ymin = Math.max(ymin, -160); ymax = Math.max(ymax, ymin + 10); }
    const px = x => box.l + (tx(x) - tx(xmin)) / (tx(xmax) - tx(xmin)) * (box.r - box.l);
    const py = y => box.b - (y - ymin) / (ymax - ymin) * (box.b - box.t);
    let html = `<defs><clipPath id="clip-${id}"><rect x="${box.l}" y="${box.t}" width="${box.r - box.l}" height="${box.b - box.t}"/></clipPath></defs>`;
    for (let i = 0; i <= 4; i++) {
      const y = ymin + (ymax - ymin) * i / 4, p = py(y);
      html += `<line class="chart-grid" x1="${box.l}" y1="${p}" x2="${box.r}" y2="${p}"/><text class="chart-label" text-anchor="end" x="${box.l - 9}" y="${p + 3}">${esc(format(y))}</text>`;
    }
    const ticks = log ? Array.from({ length: Math.ceil(Math.log10(xmax)) - Math.floor(Math.log10(xmin)) + 1 }, (_, i) => 10 ** (Math.floor(Math.log10(xmin)) + i)).filter(v => v >= xmin && v <= xmax)
      : Array.from({ length: 5 }, (_, i) => xmin + (xmax - xmin) * i / 4);
    for (const x of ticks) html += `<line class="chart-grid" x1="${px(x)}" y1="${box.t}" x2="${px(x)}" y2="${box.b}"/><text class="chart-label" text-anchor="middle" x="${px(x)}" y="${box.b + 18}">${esc(format(x))}</text>`;
    html += `<line class="chart-axis" x1="${box.l}" y1="${box.b}" x2="${box.r}" y2="${box.b}"/><text class="chart-label" text-anchor="end" x="${box.r}" y="274">${esc(options.xLabel || 'Time · s')}</text>`;
    for (const s of series) {
      let path = '', pen = false;
      for (const i of indices(s.ys)) {
        let y = s.ys[i]; const x = s.xs[i];
        if (y === -Infinity && options.db) y = ymin;
        if (!Number.isFinite(y) || !Number.isFinite(x) || (log && x <= 0)) { pen = false; continue; }
        path += `${pen ? 'L' : 'M'}${px(x).toFixed(2)},${Math.max(-1e6, Math.min(1e6, py(y))).toFixed(2)}`; pen = true;
      }
      html += `<path class="chart-curve" clip-path="url(#clip-${id})" stroke="${esc(s.color)}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} d="${path}"/>`;
    }
    html += `<line class="chart-probe" x1="${box.l}" x2="${box.l}" y1="${box.t}" y2="${box.b}" visibility="hidden"/>`;
    svg.innerHTML = html;
    const entry = { series, xmin, xmax, px, box, log, options, probe: xmin };
    cache.set(id, entry);
    const readout = document.getElementById(id.replace('-plot', '-readout'));
    if (readout) readout.textContent = 'Hover or use ← / → to inspect.';
    if (!svg.dataset.bound) {
      svg.dataset.bound = 'true';
      svg.addEventListener('pointermove', event => {
        const e = cache.get(id), point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
        const local = point.matrixTransform(svg.getScreenCTM().inverse());
        const t = Math.max(0, Math.min(1, (local.x - e.box.l) / (e.box.r - e.box.l)));
        probe(id, e.log ? e.xmin * (e.xmax / e.xmin) ** t : e.xmin + (e.xmax - e.xmin) * t);
      });
      svg.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const e = cache.get(id), dir = event.key === 'ArrowRight' ? 1 : -1;
        const next = event.key === 'Home' ? e.xmin : event.key === 'End' ? e.xmax : e.log ? e.probe * (e.xmax / e.xmin) ** (dir / 100) : e.probe + dir * (e.xmax - e.xmin) / 100;
        probe(id, Math.max(e.xmin, Math.min(e.xmax, next)));
      });
    }
  }
  function probe(id, x) {
    const e = cache.get(id), svg = document.getElementById(id); e.probe = x;
    const line = svg.querySelector('.chart-probe'); line.setAttribute('x1', e.px(x)); line.setAttribute('x2', e.px(x)); line.setAttribute('visibility', 'visible');
    const parts = [`${format(x)} ${e.log ? 'Hz' : 's'}`];
    for (const s of e.series) if (s.xs.length && x >= s.xs[0] && x <= s.xs.at(-1)) { const i = nearest(s.xs, x); parts.push(`${s.name}: ${format(s.ys[i])}`); }
    const readout = document.getElementById(id.replace('-plot', '-readout')); if (readout) readout.textContent = parts.join(' · ');
  }
  function poles(analysis) {
    const svg = document.getElementById('pole-plot');
    if (!analysis.polePlotAvailable) { svg.innerHTML = '<text class="chart-empty" x="300" y="130" text-anchor="middle">Pole locations unavailable</text><text class="chart-label" x="300" y="150" text-anchor="middle">See the stability check and numerical note below.</text>'; return; }
    const all = [...analysis.poles, ...analysis.zeros], radius = Math.max(1.25, ...all.map(p => Math.hypot(p.re, p.im) * 1.15));
    const scale = 105 / radius, px = x => 300 + x * scale, py = y => 137 - y * scale;
    let html = `<line class="chart-grid" x1="65" y1="137" x2="540" y2="137"/><line class="chart-grid" x1="300" y1="18" x2="300" y2="252"/><circle cx="300" cy="137" r="${scale}" fill="#f4f8ff" stroke="#aac6ec" stroke-dasharray="4 4"/><text class="chart-label" x="545" y="141">Re</text><text class="chart-label" x="307" y="23">Im</text><text class="chart-label" x="${px(1) + 4}" y="151">1</text><text class="chart-label" x="${px(-1) - 16}" y="151">−1</text>`;
    for (const p of analysis.zeros) html += `<circle cx="${px(p.re)}" cy="${py(p.im)}" r="5" fill="white" stroke="#c56e24" stroke-width="1.7"><title>Zero ${esc(format(p.re))} ${p.im < 0 ? '−' : '+'} ${esc(format(Math.abs(p.im)))}j</title></circle>`;
    for (const p of analysis.poles) { const x = px(p.re), y = py(p.im); html += `<path d="M${x - 4},${y - 4}L${x + 4},${y + 4}M${x - 4},${y + 4}L${x + 4},${y - 4}" stroke="#2264d9" stroke-width="1.8"><title>Pole ${esc(format(p.re))} ${p.im < 0 ? '−' : '+'} ${esc(format(Math.abs(p.im)))}j · radius ${esc(format(Math.hypot(p.re, p.im)))}</title></path>`; }
    html += '<text class="chart-label" x="300" y="272" text-anchor="middle">× poles   ○ zeros · stable poles lie inside the unit circle</text>';
    svg.innerHTML = html;
  }
  root.LabPlots = { chart, poles, format, esc };
})(globalThis);
