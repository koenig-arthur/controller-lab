#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 koenig-arthur
"""Generate independent SciPy references. Not needed to run the application/tests."""
import json
from pathlib import Path
import numpy as np
import scipy
from scipy import signal


def tf(b, a=(1,)):
    return np.asarray(b, dtype=float), np.asarray(a, dtype=float)


def series(x, y):
    return np.convolve(x[0], y[0]), np.convolve(x[1], y[1])


def parallel(x, y):
    return np.polynomial.polynomial.polyadd(np.convolve(x[0], y[1]), np.convolve(y[0], x[1])), np.convolve(x[1], y[1])


def response(name, system, fs, count=240):
    b, a = system
    frequencies = np.asarray([0.003, 0.01, 0.03, 0.1, 0.25, 0.49]) * fs
    _, h = signal.freqz(b, a, worN=frequencies, fs=fs)
    impulse = signal.lfilter(b, a, np.r_[1., np.zeros(count - 1)])
    step = signal.lfilter(b, a, np.ones(count))
    return dict(name=name, b=b.tolist(), a=a.tolist(), fs=fs, frequencies=frequencies.tolist(),
                real=h.real.tolist(), imag=h.imag.tolist(), impulse=impulse.tolist(), step=step.tolist())


plants = []
for name, b, a, fs in [
    ('100 ms lag', [1], [.1, 1], 1000),
    ('integrator', [2], [1, 0], 100),
    ('damped second order', [64], [1, 3.2, 64], 200),
    ('direct feedthrough', [2, 3], [1, 4], 100),
    ('nonminimum phase', [-1, 2], [1, 4, 3], 50),
    ('third order', [3, 2], [1, 6, 11, 6], 40),
    ('eighth order', [40320], np.poly(-np.arange(1, 9)).tolist(), 20),
    ('eighth order fast sampling', [40320], np.poly(-np.arange(1, 9)).tolist(), 1000),
]:
    A, B, C, E = signal.tf2ss(b, a)
    Ad, Bd, Cd, Dd, _ = signal.cont2discrete((A, B, C, E), 1 / fs, method='zoh')
    bd, ad, _ = signal.cont2discrete((b, a), 1 / fs, method='zoh')
    impulse = signal.dlsim((Ad, Bd, Cd, Dd, 1 / fs), np.r_[1., np.zeros(239)])[1][:, 0]
    frequencies = np.asarray([.00001, .0001, .001, .01, .1, .49]) * fs
    h = np.asarray([(Cd @ np.linalg.solve(np.exp(2j*np.pi*f/fs)*np.eye(len(Ad))-Ad, Bd) + Dd)[0, 0] for f in frequencies])
    plants.append(dict(name=name, continuousB=b, continuousA=a, fs=fs, b=bd[0].tolist(), a=ad.tolist(),
                       A=Ad.tolist(), B=Bd[:, 0].tolist(), C=Cd[0].tolist(), D=float(Dd[0, 0]), impulse=impulse.tolist(),
                       frequencies=frequencies.tolist(), real=h.real.tolist(), imag=h.imag.tolist()))

loops = []
for name, fs, kp, ki, kd, tau_d, plant_tau, delay, filters in [
    ('PI first order', 1000, 1, 10, 0, .01, .1, 0, False),
    ('PID all four filters and delay', 100, 1.3, 4, .02, .025, .08, 3, True),
]:
    dt = 1 / fs
    controller = tf([kp])
    if ki:
        controller = parallel(controller, tf([0, ki * dt], [1, -1]))
    if kd:
        controller = parallel(controller, tf([kd / (tau_d + dt), -kd / (tau_d + dt)], [1, -tau_d / (tau_d + dt)]))
    p = np.exp(-dt / plant_tau)
    plant = tf([0, 1-p], [1, -p])
    slots = dict(setpoint=tf([.7], [1, -.3]), error=tf([.6], [1, -.4]),
                 output=tf([.8], [1, -.2]), measurement=tf([.9], [1, -.1])) if filters else {k: tf([1]) for k in ['setpoint', 'error', 'output', 'measurement']}
    forward = series(series(series(slots['error'], controller), slots['output']), series(plant, tf([0] * delay + [1])))
    loop = series(forward, slots['measurement'])
    den = np.polynomial.polynomial.polyadd(loop[1], loop[0])
    closed = series(slots['setpoint'], (np.convolve(forward[0], slots['measurement'][1]), den))
    item = response(name, closed, fs)
    item.update(pid=dict(kp=kp, ki=ki, kd=kd, derivativeTau=tau_d), tau=plant_tau, delay=delay,
                filters={k: dict(b=v[0].tolist(), a=v[1].tolist()) for k, v in slots.items()})
    loops.append(item)

nonlinear = []
for antiwindup in [False, True]:
    fs = 100; dt = 1/fs; p = np.exp(-dt/.1); y = 0.; integ = 0.; output_state = 0.
    rows = []
    for n in range(251):
        reference = 2. if n < 100 else .3
        error = reference - y
        raw = error + integ
        command = .5 * raw + output_state
        output_state = .5 * command
        actuator = np.clip(command, -1, 1)
        rows.append([y, error, integ, raw, command, actuator])
        integ += 15 * dt * error
        if antiwindup:
            integ += dt/.05 * (actuator-command)
        y = p*y + (1-p)*actuator
    nonlinear.append(dict(antiWindup=antiwindup, rows=np.asarray(rows).tolist()))

equation = response('Pasted difference equation', tf([.96585, -1.3659, .96585], [1, -1.3659, .9317]), 1000)
path = Path(__file__).with_name('references.json')
path.write_text(json.dumps(dict(generator=f'SciPy {scipy.__version__}', plants=plants, loops=loops, nonlinear=nonlinear, equation=equation), indent=2) + '\n')
print(f'Wrote {len(plants)} plant, {len(loops)} loop, {len(nonlinear)} nonlinear and one equation references.')
