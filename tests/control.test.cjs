// SPDX-License-Identifier: GPL-3.0-only · Copyright (C) 2026 koenig-arthur
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../control.js'), D = require('../dsp.js');
const refs = require('./references.json');
const equation = 'y[n] = 0.96585·x[n] − 1.3659·x[n−1] + 0.96585·x[n−2] + 1.3659·y[n−1] − 0.9317·y[n−2]';
function close(a, b, tol = 1e-9) { assert.ok(Number.isFinite(a) && Math.abs(a-b) <= tol * Math.max(1, Math.abs(b)), `${a} != ${b} (tol ${tol})`); }
function arrayClose(a, b, tol) { assert.equal(a.length, b.length); a.forEach((v, i) => close(v, b[i], tol)); }
function frequencies(f, fixture, tol=1e-8) {
  fixture.frequencies.forEach((hz, i) => { const r=D.responseAt(f,hz); assert.equal(r.kind,'finite'); close(r.magnitude*Math.cos(r.phase),fixture.real[i],tol); close(r.magnitude*Math.sin(r.phase),fixture.imag[i],tol); });
}

test('pasted difference equation matches Filter Lab signs and independent SciPy responses', () => {
  const f=C.parseEquation(equation); assert.deepEqual(f.b,[.96585,-1.3659,.96585]); assert.deepEqual(f.a,[1,-1.3659,.9317]);
  arrayClose(D.impulseResponse(f,240).values,refs.equation.impulse); frequencies(f,refs.equation);
  assert.deepEqual(C.parseEquation('y[n]=x[n]+1e-2*x[n-1]-2E-1*y[n-1]').a,[1,.2]);
  assert.deepEqual(C.parseEquation('y[n] = +x[n] − x[n] + 2×x[n−3]').b,[0,0,0,2]);
});
test('equation grammar rejects future, nonlinear, ambiguous and executable inputs', () => {
  for(const s of ['y[n]=x[n+1]','y[n]=y[n]+x[n]','y[n]=x[n]*x[n]','y[n]=sin(x[n])','y[n]=x[n]x[n-1]',
    'y[n]=x[n];alert(1)','y[n]=1e999*x[n]','y[n]=x[n-65]','y[n]=','u[n]=x[n]','y[n]=2','y[n]=x[n-1.5]']) assert.throws(()=>C.parseEquation(s),undefined,s);
});
for(const p of refs.plants) test(`ZOH: ${p.name} agrees with independent SciPy state and coefficients`,()=>{
  const z=C.discretize(p.continuousB,p.continuousA,p.fs);
  arrayClose(z.transfer.a,p.a,2e-7); arrayClose(z.transfer.b,p.b,2e-7);
  z.state.A.forEach((row,i)=>arrayClose(row,p.A[i],2e-7)); arrayClose(z.state.B,p.B,2e-7); arrayClose(z.state.C,p.C,2e-7); close(z.state.D,p.D);
  const c=C.defaults(); c.sampleRate=p.fs; c.duration=239/p.fs; c.onset=0; c.view='open'; c.pid={kp:1,ki:0,kd:0,derivativeTau:0};
  c.plant={...c.plant,type:'continuous',b:p.continuousB,a:p.continuousA};
  const m=C.compile(c);
  arrayClose(C.simulate(m,'impulse').y,p.impulse,3e-7);
  p.frequencies.forEach((hz,i)=>{const f=C.frequencyAt(m,hz);assert.equal(f.kind,'finite');close(f.magnitude*Math.cos(f.phase),p.real[i],3e-7);close(f.magnitude*Math.sin(f.phase),p.imag[i],3e-7);});
});
test('plant validation handles improper, zero, integrator and eighth-order models',()=>{
  assert.throws(()=>C.discretize([1,0],[1],100)); assert.throws(()=>C.discretize([1],[0,0],100));
  assert.throws(()=>C.discretize([1],Array(10).fill(1),100));
  assert.deepEqual(C.discretize([0],[1],100).transfer.b,[0]);
  assert.deepEqual(C.discretize([2],[1,0],100).transfer.b,[0,.02]);
});
for(const r of refs.loops) test(`feedback composition: ${r.name}`,()=>{
  const c=C.defaults(); c.sampleRate=r.fs; c.onset=0; c.duration=239/r.fs; c.pid=r.pid; c.plant.tau=r.tau; c.delay=r.delay/r.fs;
  for(const slot of C.SLOTS) c.filters[slot]={...c.filters[slot],enabled:true,method:'coefficients',...r.filters[slot]};
  const m=C.compile(c); frequencies(m.linear.transfer,r,2e-6);
  r.frequencies.forEach((hz,i)=>{const f=C.frequencyAt(m,hz);close(f.magnitude*Math.cos(f.phase),r.real[i],2e-6);close(f.magnitude*Math.sin(f.phase),r.imag[i],2e-6);});
  arrayClose(C.simulate(m,'impulse').y,r.impulse,2e-6); arrayClose(C.simulate(m,'step').y,r.step,2e-6);
});
test('100 ms lag and 100 ms dead time are distinct and not limited to 64 samples',()=>{
  const c=C.defaults(); c.view='open'; c.onset=0; c.pid.ki=0;
  const normal=C.simulate(C.compile(c),'step'); close(normal.y[100],1-Math.exp(-1),1e-12); close(normal.y[0],0);
  c.delay=.1; const m=C.compile(c), delayed=C.simulate(m,'step'); assert.equal(m.delaySamples,100);
  arrayClose(delayed.y.slice(0,100),Array(100).fill(0)); arrayClose(delayed.y.slice(100),normal.y.slice(0,-100));
  c.delay=.1006; assert.equal(C.compile(c).delaySamples,101);
});
test('PID branches use seconds; zero gains remove inactive states',()=>{
  const c=C.defaults(); c.view='controller'; c.onset=0; c.pid={kp:2,ki:3,kd:.01,derivativeTau:0};
  const m=C.compile(c), t=C.simulate(m,'step'); close(t.p[0],2); close(t.i[0],0); close(t.i[1],.003); close(t.d[0],10); close(t.d[1],0);
  c.pid.ki=0; c.pid.kd=0; const p=C.compile(c); assert.equal(p.states,0); assert.deepEqual(p.controller.a,[1]);
  c.pid.kp=0; const zero=C.compile(c); assert.equal(zero.states,0); assert.equal(C.controllerType(c.pid),'Zero'); assert.ok(C.simulate(zero).y.every(v=>v===0));
});
test('derivative smoothing and forward Euler integrator match their transfer functions',()=>{
  for(const tau of [0,.01]) { const c=C.defaults(); c.view='controller'; c.onset=0; c.pid={kp:1.2,ki:4,kd:.03,derivativeTau:tau};
    const m=C.compile(c); arrayClose(C.simulate(m,'impulse').y,D.impulseResponse(m.controller,1201).values,1e-8);
  }
});
test('unity plant feedback has no hidden sample delay',()=>{
  const c=C.defaults(); c.onset=0; c.plant.type='unity'; c.pid.ki=0; c.pid.kp=2;
  let r=C.simulate(C.compile(c),'step'); r.y.forEach(v=>close(v,2/3));
  c.limits.enabled=true; c.amplitude=2; r=C.simulate(C.compile(c),'step'); assert.equal(r.truncated,false); r.y.forEach(v=>close(v,1)); r.raw.forEach(v=>close(v,2));
});
test('singular and nonunique feedback are reported rather than delayed',()=>{
  const c=C.defaults(); c.onset=0; c.plant.type='unity'; c.pid.ki=0; c.pid.kp=-1; assert.throws(()=>C.compile(c),/Singular/);
  c.pid.kp=-2; c.limits.enabled=true; c.amplitude=0; const r=C.simulate(C.compile(c)); assert.equal(r.truncated,true); assert.match(r.reason,/Nonunique/);
  close(C.solveActuator(2,0,{enabled:true,min:-1,max:1}),1);
});
test('stability retains hidden unstable modes and distinguishes boundaries',()=>{
  const c=C.defaults(); c.pid.ki=0; c.pid.kp=.5; c.plant.type='discrete'; c.plant.b=[1,-1.1]; c.plant.a=[1,-1.1];
  assert.equal(C.analyze(C.compile(c)).status,'unstable');
  c.plant.b=[0,1]; c.plant.a=[1]; c.pid.kp=1; assert.equal(C.analyze(C.compile(c)).status,'boundary');
  c.pid.kp=.5; assert.equal(C.analyze(C.compile(c)).status,'stable');
  c.filters.setpoint={...c.filters.setpoint,enabled:true,method:'coefficients',b:[1,-1.2],a:[1,-1.2]}; assert.equal(C.analyze(C.compile(c)).status,'unstable');
  c.filters.setpoint.enabled=false; assert.equal(C.analyze(C.compile(c)).status,'stable');
  assert.equal(C.schur([1,0,1]).status,'unknown');
  assert.equal(C.analyze(C.compile(C.preset('delay'))).status,'unstable');
});
test('controller and open views disable only the documented blocks',()=>{
  const c=C.defaults(); c.onset=0; c.view='controller'; c.pid.ki=0;
  c.filters.measurement={...c.filters.measurement,enabled:true,method:'coefficients',b:[1],a:[1,-2]};
  c.filters.setpoint={...c.filters.setpoint,enabled:true,method:'coefficients',b:[2],a:[1]};
  c.delay=.1; c.plant.gain=5; const m=C.compile(c); assert.equal(m.states,0); assert.equal(C.simulate(m).y[0],1);
  c.view='open'; assert.equal(C.analyze(C.compile(c)).status,'stable');
});
for(const fixture of refs.nonlinear) test(`saturation after output filter, anti-windup ${fixture.antiWindup}`,()=>{
  const c=C.preset('windup'); c.sampleRate=100; c.onset=0; c.filters.output={...c.filters.output,enabled:true,method:'coefficients',b:[.5],a:[1,-.5]}; c.limits.antiWindup=fixture.antiWindup;
  const m=C.compile(c), r=C.simulate(m); assert.equal(r.truncated,false); assert.equal(r.clipped,true);
  ['y','error','i','raw','command','actuator'].forEach((key,col)=>arrayClose(r[key],fixture.rows.map(row=>row[col]),1e-9));
});
test('anti-windup improves recovery and does nothing when Ki is zero',()=>{
  const c=C.preset('windup'), withAW=C.simulate(C.compile(c)); c.limits.antiWindup=false; const without=C.simulate(C.compile(c));
  assert.ok(Math.abs(withAW.y[1400]-.3)<Math.abs(without.y[1400]-.3));
  c.pid.ki=0; const off=C.simulate(C.compile(c)); c.limits.antiWindup=true; const on=C.simulate(C.compile(c)); arrayClose(off.y,on.y); assert.ok(on.i.every(v=>v===0));
});
test('clipping never changes the advertised unsaturated linear model',()=>{
  const c=C.defaults(), linear=C.compile(c).linear; c.limits.enabled=true;
  assert.deepEqual(C.compile(c).linear,linear);
});
test('response metrics use final output, not target, and never bless unstable traces',()=>{
  const m=C.compile(C.preset('p')), r=C.simulate(m), metrics=C.metrics(m,r,C.analyze(m)); close(metrics.final,.5); close(metrics.error,.5); close(metrics.overshoot,0); assert.ok(metrics.settling>.1);
  const d=C.compile(C.preset('delay')); assert.equal(C.metrics(d,C.simulate(d),C.analyze(d)).final,null);
  const short=C.defaults(); short.duration=.06; const m2=C.compile(short); assert.equal(C.metrics(m2,C.simulate(m2),C.analyze(m2)).settling,null);
});
test('JSON import/export retains full configuration and named comparisons atomically',()=>{
  const c=C.preset('windup'), snapshots=[{name:'Test < & >',visible:false,config:C.preset('delay')}];
  const data=C.exportExperiment(c,snapshots); assert.deepEqual(C.importExperiment(JSON.parse(JSON.stringify(data))),data);
  data.config.pid.kp=99; assert.equal(c.pid.kp,1);
  assert.throws(()=>C.importExperiment({kind:'controller-lab',version:9,config:c}));
  assert.throws(()=>C.importExperiment({kind:'controller-lab',version:1,config:{}}));
  assert.throws(()=>C.exportExperiment(c,Array(6).fill(snapshots[0])));
  const filter=C.importFilter({version:1,b:[.96585,-1.3659,.96585],a:[1,-1.3659,.9317],sampleRate:8000}); assert.equal(filter.sampleRate,8000); assert.equal(filter.b[0],.96585);
});
test('model and sample limits validate before work; divergent traces terminate safely',()=>{
  const c=C.defaults(); c.duration=101; assert.throws(()=>C.compile(c),/100,000/);
  c.duration=1; c.delay=.513; assert.throws(()=>C.compile(c),/512/);
  c.delay=.512; assert.throws(()=>C.compile(c),/states/);
  c.delay=0; c.pid.kp=10000; const m=C.compile(c), r=C.simulate(m); assert.equal(r.truncated,true); assert.ok(r.y.every(Number.isFinite));
  c.pid.kp=1; c.limits.enabled=true; c.limits.trackingTime=.0001; assert.throws(()=>C.compile(c),/one sample/);
});
test('chunked simulation is identical to synchronous simulation',()=>{
  const m=C.compile(C.preset('windup')), expected=C.simulate(m), job=C.createSimulation(m);
  while(!job.advance(7)) {} assert.deepEqual(job.result,expected);
});
test('CSV contains both control and measured signals with correctly quoted names',()=>{
  const m=C.compile(C.defaults()), r=C.simulate(m,'impulse'), csv=C.csv([{name:'A, "quoted" curve',trace:r}]);
  assert.match(csv,/filteredError,p,i,d,raw,command,actuator,trackingError/); assert.match(csv,/"A, ""quoted"" curve",impulse/); assert.equal(csv.split('\r\n').length,r.time.length+2);
});
test('ill-conditioned sampled plants remain uncertain even beyond the pole-plot limit',()=>{
  const p=refs.plants.at(-1),c=C.defaults();c.view='open';c.pid.ki=0;c.plant={...c.plant,type:'continuous',b:p.continuousB,a:p.continuousA};
  for(const delay of [0,.1]) {c.delay=delay; const m=C.compile(c),a=C.analyze(m);assert.equal(a.status,'unknown');assert.match(a.warning,/state-space/);}
});
test('long-delay frequency phase is sampled densely enough to unwrap',()=>{
  const c=C.defaults();c.view='open';c.pid.ki=0;c.plant.type='unity';c.delay=.1;
  const m=C.compile(c),curve=C.frequency(m);close(curve.at(-1).phase,-18000,1e-10);curve.forEach(p=>close(p.db,0));
});
test('closed-loop integral DC response has its finite limit; frequencies stay within Nyquist',()=>{
  const m=C.compile(C.defaults());close(C.frequencyAt(m,0).magnitude,1);
  assert.throws(()=>C.frequencyAt(m,-1),/Nyquist/);assert.throws(()=>C.frequencyAt(m,501),/Nyquist/);
});
test('all requested filter families support every slot at the shared sample rate',()=>{
  const c=C.defaults();
  for(const method of ['iir','fir']) for(const type of ['lowpass','highpass','bandpass','notch']) {
    for(const slot of C.SLOTS) c.filters[slot]={...c.filters[slot],enabled:true,method,type,frequency:20,upperFrequency:40,taps:15};
    const m=C.compile(c);for(const f of Object.values(m.filters)){assert.equal(f.sampleRate,1000);assert.ok(f.b.every(Number.isFinite));}
  }
});
