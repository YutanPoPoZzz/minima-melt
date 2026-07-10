// Send effects and bus processing — the vat around the acid line. Same bones
// as the fission/drift/galaxy dub chain (tempo-synced filtered delay, small
// Schroeder plate, sidechain ducker, bus bitcrush), plus the melt-specific
// stage: a Bubble — a high-resonance filter ping the engine fires at random
// past melt 0.7, the sound of gas escaping the molten core.

import { SVF, OnePoleHP } from './util.js';

// Tempo-synced delay with lowpass + highpass filtering inside the feedback
// loop, so each repeat gets darker and thinner — the dub echo throw. The
// engine syncs the time to a dotted eighth (3 sixteenth steps).
export class DubDelay {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.buf = new Float32Array(Math.ceil(sampleRate * 4.0));
    this.writeIdx = 0;
    this.timeSamples = Math.floor(sampleRate * 0.28);
    this.feedback = 0.5; // canonical default (fx `feedback`)
    this.color = 1400; // lowpass cutoff in the loop — darker repeats
    this.level = 0.9; // the engine scales the SEND, so the return runs hot
    this.lp = new SVF(sampleRate);
    this.hpX = 0;
    this.hpY = 0;
  }

  setTimeSamples(n) {
    this.timeSamples = Math.min(this.buf.length - 1, Math.max(32, Math.floor(n)));
  }

  process(x) {
    const len = this.buf.length;
    const readIdx = (this.writeIdx - this.timeSamples + len) % len;
    const echo = this.buf[readIdx];
    // filter the feedback path: darker (lowpass) and thinner (highpass) each
    // time around, so the acid squelch smears into haze instead of mud
    let fb = this.lp.lowpass(echo, this.color, 0);
    const hp = 0.992 * (this.hpY + fb - this.hpX);
    this.hpX = fb;
    this.hpY = hp;
    fb = hp;
    this.buf[this.writeIdx] = x + fb * this.feedback;
    this.writeIdx = (this.writeIdx + 1) % len;
    return echo * this.level;
  }
}

// Small plate — a compact Schroeder (four damped combs + two allpasses) with
// SHORT loops, so it reads as a clap plate rather than a hall wash.
export class Reverb {
  constructor(sampleRate) {
    this.sr = sampleRate;
    const scale = sampleRate / 44100;
    this.combs = [1113, 1188, 1277, 1356].map((n) => ({
      buf: new Float32Array(Math.floor(n * scale)),
      idx: 0,
      damp: 0,
      g: 0,
    }));
    this.allpasses = [225, 556].map((n) => ({
      buf: new Float32Array(Math.floor(n * scale)),
      idx: 0,
    }));
    this.decay = 1.4; // seconds — a tight plate behind the clap
    this.level = 0.6;
    this._recalc();
  }

  _recalc() {
    // comb feedback gain for the requested decay time (-60 dB after `decay` s)
    for (const c of this.combs) {
      const loopSec = c.buf.length / this.sr;
      c.g = Math.pow(10, (-3 * loopSec) / this.decay);
    }
  }

  set(name, value) {
    if (name === 'decay') {
      this.decay = value;
      this._recalc();
    } else if (name === 'level') {
      this.level = value;
    }
  }

  process(x) {
    let s = 0;
    for (const c of this.combs) {
      const out = c.buf[c.idx];
      // damping inside the comb loop darkens the tail as it rings out
      c.damp = out * 0.3 + c.damp * 0.7;
      c.buf[c.idx] = x + c.damp * c.g;
      c.idx = (c.idx + 1) % c.buf.length;
      s += out;
    }
    s *= 0.25;
    for (const a of this.allpasses) {
      const buffered = a.buf[a.idx];
      const out = -s + buffered;
      a.buf[a.idx] = s + buffered * 0.5;
      a.idx = (a.idx + 1) % a.buf.length;
      s = out;
    }
    return s * this.level;
  }
}

// Sidechain ducker — everything except the kick breathes when the kick lands.
export class Ducker {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.env = 0;
    this.amount = 0.4; // canonical default (fx `duck`)
    this.release = 0.15; // the 130 BPM pump — a slower breath than fission's
    this._recalc();
  }

  _recalc() {
    this.relCoef = Math.exp(-1 / (this.release * this.sr));
  }

  set(name, value) {
    if (name === 'amount') this.amount = value;
    else if (name === 'release') {
      this.release = value;
      this._recalc();
    }
  }

  trigger() {
    this.env = 1;
  }

  process() {
    const gain = 1 - this.amount * this.env;
    this.env *= this.relCoef;
    return gain;
  }
}

// Bus Bitcrush — sample-rate reduction + bit quantise, dry/wet blended by
// AMOUNT. At melt's default 0.06 it's the faintest dusting of texture on the
// bus; cranked, it chews the mix into 8-bit rubble. amount<=~0 is an exact
// passthrough so crush 0 is truly clean.
export class Bitcrush {
  constructor() {
    this.amount = 0.06; // canonical default (fx `crush`)
    this.held = 0;
    this.acc = 0;
  }

  set(name, value) {
    if (name === 'amount') this.amount = value;
  }

  process(x) {
    const a = this.amount;
    if (a < 1e-3) return x;
    // rate reduction: hold each sample for 1..15 samples (squared curve so
    // low amounts stay subtle)
    this.acc += 1;
    const factor = 1 + a * a * 14;
    if (this.acc >= factor) {
      this.acc -= factor;
      // bit reduction: 12 bits down to ~4.5 bits at full crush
      const steps = Math.pow(2, 12 - a * 7.5);
      this.held = Math.round(x * steps) / steps;
    }
    const wet = Math.min(1, a * 2.5);
    return x + (this.held - x) * wet;
  }
}

// Bubble pop — a near-self-oscillation filter ping. An impulse hits an SVF
// sitting at very high resonance, which rings at the trigger frequency
// (800..3000 Hz from the engine) and is squeezed by a short envelope: the
// sound of a gas bubble bursting at the surface of the melt. Quiet by design.
export class Bubble {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.svf = new SVF(sampleRate);
    this.freq = 1500;
    this.impulse = 0;
    this.env = 0;
    this.coef = Math.exp(Math.log(0.001) / (0.12 * sampleRate)); // ~120 ms cap
  }

  trigger(freq, amp = 1) {
    this.freq = Math.min(3000, Math.max(200, freq));
    this.impulse = amp;
    this.env = 1;
    this.svf.reset();
  }

  process() {
    if (this.env < 1e-4 && this.impulse === 0) return 0;
    const x = this.impulse;
    this.impulse = 0;
    // res 0.995 => the SVF rings for tens of ms on its own; the envelope
    // guarantees the pop always dies fast enough to stay a detail
    const s = this.svf.lowpass(x * 6, this.freq, 0.995);
    this.env *= this.coef;
    return s * this.env;
  }
}
