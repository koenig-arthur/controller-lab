// SPDX-License-Identifier: GPL-3.0-only · Copyright (C) 2026 koenig-arthur
const { test, expect } = require('@playwright/test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const C = require('../control.js');
const url = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const pasted = 'y[n] = 0.96585·x[n] − 1.3659·x[n−1] + 0.96585·x[n−2] + 1.3659·y[n−1] − 0.9317·y[n−2]';
const files = data => ({ name: 'test.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
async function ready(page) { await expect(page.locator('body')).toHaveAttribute('data-ready', 'true'); await expect(page.locator('#compute-status')).toHaveText('Ready'); }
async function config(page) { return page.evaluate(() => ControllerLabApp.getConfig()); }
async function downloadText(download) { const stream = await download.createReadStream(); const chunks=[]; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks).toString(); }
test.beforeEach(async ({ page }) => {
  const errors = []; page.testErrors = errors;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) errors.push(`Network request: ${request.url()}`); });
  await page.context().setOffline(true); await page.goto(url); await ready(page);
});
test.afterEach(async ({ page }) => { expect(page.testErrors).toEqual([]); });

test('opens through file:// without network and renders a consistent default experiment', async ({ page }) => {
  await expect(page).toHaveTitle('Controller Lab · PID & Feedback');
  await expect(page.locator('#stability')).toHaveText('Linear · Stable');
  await expect(page.locator('#controller-kind')).toHaveText('PI');
  await expect(page.locator('#metric-error')).toHaveText('≈ 0');
  await expect(page.locator('.plot-card svg')).toHaveCount(8);
  for (const id of ['step','impulse','effort','terms','error','magnitude','phase']) expect(await page.locator(`#${id}-plot path.chart-curve`).count()).toBeGreaterThan(0);
  await page.locator('#step-plot').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('#step-readout')).toContainText('With filters + delay');
});
test('gain edits disable terms, support signed values, and invalid edits retain the last valid model', async ({ page }) => {
  await page.locator('#ki').fill('0'); await ready(page); await expect(page.locator('#controller-kind')).toHaveText('P');
  await expect(page.locator('#metric-error')).toHaveText('0.5');
  await page.locator('#kd').fill('0.02'); await ready(page); await expect(page.locator('#controller-kind')).toHaveText('PD');
  await page.locator('#kp').fill('-0.1'); await ready(page); expect((await config(page)).pid.kp).toBe(-.1);
  const before=await config(page); await page.locator('#sample-rate').fill('0'); await expect(page.locator('#error')).toBeVisible(); expect(await config(page)).toEqual(before);
  await page.locator('#sample-rate').fill('1000'); await ready(page); await expect(page.locator('#error')).toBeHidden();
});
test('three views have different semantics and clickable blocks select the editor', async ({ page }) => {
  await page.locator('[data-view="controller"]').click(); await ready(page); await expect(page.locator('#stability')).toContainText('boundary');
  await expect(page.locator('#view-note')).toContainText('Impose an error');
  await page.locator('[data-block="measurement"]').click(); await expect(page.locator('#panel-filters')).toBeVisible(); await expect(page.locator('#filter-slot')).toHaveValue('measurement');
  await page.locator('[data-view="open"]').click(); await ready(page); await expect(page.locator('#view-note')).toContainText('Feedback is disconnected');
  await page.locator('[data-view="closed"]').click(); await ready(page); await expect(page.locator('#stability')).toContainText('Stable');
  await page.locator('[data-block="delay"]').click(); await expect(page.locator('#dead-time')).toBeFocused();
  await page.locator('#dead-time').fill('100'); await ready(page); await expect(page.locator('#delay-note')).toContainText('100 samples');
});
test('pasted equation previews correct signs, then applies independently to all four filter slots', async ({ page }) => {
  for (const slot of C.SLOTS) {
    await page.locator(`[data-block="${slot}"]`).click(); await page.locator('#filter-method').selectOption('equation');
    await page.locator('#filter-equation').fill(pasted); await page.locator('#preview-filter').click();
    await expect(page.locator('#filter-preview-coefficients')).toContainText('a = [1, -1.3659, 0.9317]');
    expect((await config(page)).filters[slot].enabled).toBe(false);
    await page.locator('#apply-filter').click(); await ready(page);
    expect((await config(page)).filters[slot]).toMatchObject({enabled:true,method:'coefficients',b:[.96585,-1.3659,.96585],a:[1,-1.3659,.9317]});
  }
  await page.locator('#filter-equation').fill('y[n]=x[n+1]'); await page.locator('#preview-filter').click();
  await expect(page.locator('#error')).toBeVisible(); await expect(page.locator('#filter-preview')).toBeHidden();
  expect((await config(page)).filters.measurement.b[0]).toBe(.96585);
});
test('all design methods, response shapes, transfer expressions and coefficient lists are usable', async ({ page }) => {
  await page.locator('[data-block="error"]').click();
  for (const family of ['iir','fir']) for (const type of ['lowpass','highpass','bandpass','notch']) {
    await page.locator('#filter-method').selectOption(family); await page.locator('#filter-type').selectOption(type);
    await page.locator('#preview-filter').click(); await page.locator('#apply-filter').click(); await ready(page);
    expect((await config(page)).filters.error).toMatchObject({method:family,type,enabled:true});
  }
  await page.locator('#filter-method').selectOption('average'); await page.locator('#filter-taps').fill('5');
  await page.locator('#preview-filter').click(); await page.locator('#apply-filter').click(); await ready(page);
  expect((await config(page)).filters.error.b).toEqual([.2,.2,.2,.2,.2]);
  await page.locator('#filter-method').selectOption('expression'); await page.locator('#filter-expression').fill('(1+z^-1)/2');
  await page.locator('#preview-filter').click(); await page.locator('#apply-filter').click(); await ready(page);
  expect((await config(page)).filters.error.b).toEqual([.5,.5]);
  await page.locator('#filter-method').selectOption('coefficients'); await page.locator('#filter-b').fill('2'); await page.locator('#filter-a').fill('2, -1');
  await page.locator('#preview-filter').click(); await page.locator('#apply-filter').click(); await ready(page);
  expect((await config(page)).filters.error.a).toEqual([1,-.5]);
});
test('Filter Lab JSON requires an explicit sampling-rate choice and preserves precision', async ({ page }) => {
  await page.locator('[data-block="error"]').click();
  const data={version:1,b:[.1234567890123456],a:[1,-.8765432109876544],sampleRate:8000};
  await page.locator('#filter-file').setInputFiles(files(data)); await expect(page.locator('#filter-rate-choice')).toBeVisible();
  await page.locator('#apply-filter').click(); await expect(page.locator('#error')).toContainText('Choose whether'); expect((await config(page)).sampleRate).toBe(1000);
  await page.locator('#filter-rate-policy').selectOption('reinterpret'); await page.locator('#apply-filter').click(); await ready(page);
  expect((await config(page)).sampleRate).toBe(1000); expect((await config(page)).filters.error.b).toEqual(data.b);
  await page.locator('#filter-file').setInputFiles(files(data)); await page.locator('#filter-rate-policy').selectOption('adopt'); await page.locator('#apply-filter').click(); await ready(page);
  expect((await config(page)).sampleRate).toBe(8000); await expect(page.locator('#sample-rate')).toHaveValue('8000');
  await expect(page.locator('#filter-method')).toHaveValue('coefficients');
});
test('custom G(s) and G(z) models and physical plant presets are editable', async ({ page }) => {
  await page.locator('#tab-plant').click();
  for (const type of ['second','integrator','unity','first']) { await page.locator('#plant-type').selectOption(type); await ready(page); expect((await config(page)).plant.type).toBe(type); }
  await page.locator('#plant-type').selectOption('continuous'); await page.locator('#plant-b').fill('2'); await page.locator('#plant-a').fill('0.2, 1');
  await page.locator('#plant-coeff-form button').click(); await ready(page); expect((await config(page)).plant).toMatchObject({type:'continuous',b:[2],a:[.2,1]});
  await page.locator('#plant-type').selectOption('discrete'); await ready(page); await page.locator('#plant-b').fill('0, 0.1'); await page.locator('#plant-a').fill('1, -0.9');
  await page.locator('#plant-coeff-form button').click(); await ready(page); expect((await config(page)).plant).toMatchObject({type:'discrete',b:[0,.1],a:[1,-.9]});
});
test('five named snapshots round-trip through experiment JSON without overwriting', async ({ page }) => {
  for (let i=0;i<5;i++) { await page.locator('#save-comparison').click(); await ready(page); }
  await expect(page.locator('#save-comparison')).toBeDisabled(); await expect(page.locator('.saved-curve')).toHaveCount(5);
  await page.getByLabel('Snapshot 1 name',{exact:true}).fill('<script>unsafe()</script>'); await page.getByLabel('Snapshot 1 name',{exact:true}).press('Tab'); await ready(page);
  await expect(page.locator('#curve-legend')).toContainText('<script>unsafe()</script>'); expect(await page.locator('#curve-legend script').count()).toBe(0);
  const exportPromise=page.waitForEvent('download'); await page.locator('#export-experiment').click(); const exported=JSON.parse(await downloadText(await exportPromise));
  expect(exported.comparisons).toHaveLength(5);
  await page.locator('#clear-comparisons').click(); await ready(page); await expect(page.locator('#saved-comparisons')).toBeHidden();
  await page.locator('#experiment-file').setInputFiles(files(exported)); await ready(page); await expect(page.locator('.saved-curve')).toHaveCount(5);
  await page.locator('.saved-curve').first().getByRole('checkbox').uncheck(); await ready(page); expect((await page.evaluate(()=>ControllerLabApp.getSnapshots()))[0].visible).toBe(false);
  await page.locator('.saved-curve').first().getByRole('button').click(); await ready(page); await expect(page.locator('.saved-curve')).toHaveCount(4);
});
test('limits and anti-windup visibly affect recovery while retaining linear analysis', async ({ page }) => {
  await page.locator('#preset').selectOption('windup'); await ready(page); await expect(page.locator('#analysis-warning')).toContainText('command is clipping');
  const original=await page.locator('#step-plot path.chart-curve').last().getAttribute('d');
  await page.locator('#tab-limits').click(); await page.locator('#anti-windup').uncheck(); await ready(page);
  expect(await page.locator('#step-plot path.chart-curve').last().getAttribute('d')).not.toBe(original);
  await expect(page.locator('#stability')).toHaveText('Linear · Stable'); await expect(page.locator('#return-fields')).toBeVisible();
  await page.locator('#limits-enabled').uncheck(); await ready(page); expect((await config(page)).limits.enabled).toBe(false);
});
test('delay preset reports instability; traces CSV includes both excitations and all signals', async ({ page }) => {
  await page.locator('#preset').selectOption('delay'); await ready(page); await expect(page.locator('#stability')).toHaveText('Linear · Unstable');
  await expect(page.locator('#pole-note')).toContainText('limited to 64');
  const exportPromise=page.waitForEvent('download'); await page.locator('#export-csv').click(); const csv=await downloadText(await exportPromise);
  expect(csv).toContain('filteredError,p,i,d,raw,command,actuator,trackingError'); expect(csv).toContain(',step,'); expect(csv).toContain(',impulse,');
  await page.locator('#excitation').selectOption('impulse'); await ready(page); await expect(page.locator('#metrics-note')).toContainText('Step metrics apply');
});
test('long calculations are cancelled when newer edits arrive', async ({ page }) => {
  await page.locator('#duration').fill('99.999');
  await page.locator('#kp').fill('2'); await page.locator('#duration').fill('0.8'); await ready(page);
  expect((await config(page)).pid.kp).toBe(2); expect((await config(page)).duration).toBe(.8);
  await expect(page.locator('#pid-equation')).toContainText('u[n] = 2·e[n]');
  await expect(page.locator('#export-csv')).toBeEnabled();
});
test('mobile layout, keyboard tabs and local license stay usable offline', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  for (const tab of ['pid','plant','filters','limits']) {
    await page.locator(`#tab-${tab}`).click();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  }
  await page.locator('#tab-pid').focus(); await page.keyboard.press('ArrowRight'); await expect(page.locator('#tab-plant')).toHaveAttribute('aria-selected','true');
  await page.keyboard.press('End'); await expect(page.locator('#tab-limits')).toHaveAttribute('aria-selected','true');
  await page.getByRole('link',{name:'License',exact:true}).click(); await expect(page).toHaveTitle('License · Controller Lab');
  await expect(page.getByRole('heading',{level:1})).toHaveText('Controller Lab license');
});
test('malformed experiment imports leave all active settings intact', async ({ page }) => {
  const before=await config(page);
  await page.locator('#experiment-file').setInputFiles(files({kind:'controller-lab',version:1,config:{}})); await expect(page.locator('#error')).toBeVisible(); expect(await config(page)).toEqual(before);
  await page.locator('#experiment-file').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{ nope')}); await expect(page.locator('#error')).toContainText('not valid JSON'); expect(await config(page)).toEqual(before);
});
test('maximum-length simulation completes and preserves a one-sample impulse', async ({ page }) => {
  await page.locator('#show-baselines').uncheck(); await ready(page);
  await page.locator('#duration').fill('99.999');
  await expect(page.locator('#compute-status')).toHaveText('Ready',{timeout:30000});
  await expect(page.locator('#error')).toBeHidden();
  await expect(page.locator('#stability')).toHaveText('Linear · Stable');
  expect((await config(page)).duration).toBe(99.999);
  expect((await page.locator('#impulse-plot path.chart-curve').first().getAttribute('d')).length).toBeGreaterThan(100);
});
