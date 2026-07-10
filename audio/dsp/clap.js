// Clap — three fast noise bursts and a ringing tail, the 909-style smack on
// steps 4 and 12. Band-shaped white noise (one-pole HP + LP around the clap
// midband, both moved together by TONE), retriggered by a fast micro-envelope
// for each burst, then handed to the longer DECAY tail on the last one.
//
// SPREAD sets the gap between the bursts: tight (~6 ms, almost one snap) at 0,
// wide (~20 ms, a loose crowd clap) at 1. The engine mixes mono, so spread is
// purely a time feel here — the "stereo" in the design note reads as width of
// the burst cluster.

import { OnePoleHP, OnePoleLP } from './util.js';

const PARAMS = ['tone', 'decay', 'spread', 'level'];

export class Clap {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.env = 0;
    this.vel = 0;
    this.burstsLeft = 0; // bursts still to fire AFTER the initial one
    this.nextBurst = 0; // samples until the next burst retrigger
    this.inTail = false;
    this.active = false;
    this.hp = new OnePoleHP(sampleRate);
    this.lp = new OnePoleLP(sampleRate);

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.tone = 0.55; // 0..1 — moves the noise band up
    this.decay = 0.22; // tail seconds to -60 dB
    this.spread = 0.5; // 0..1 — burst spacing
    this.level = 0.6;
    this._recalc();
  }

  _recalc() {
    this.hp.setCutoff(500 + this.tone * 1500); // 500 Hz .. 2 kHz floor
    this.lp.setCutoff(3000 + this.tone * 7000); // 3 kHz .. 10 kHz ceiling
    this.burstCoef = Math.exp(Math.log(0.001) / (0.008 * this.sr)); // ~8 ms snap
    this.tailCoef = Math.exp(Math.log(0.001) / (this.decay * this.sr));
    this.interval = Math.max(8, Math.round((0.006 + this.spread * 0.014) * this.sr));
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  trigger(velocity = 1) {
    this.vel = velocity;
    this.env = velocity * 0.8; // pre-claps sit under the final smack
    this.burstsLeft = 2;
    this.nextBurst = this.interval;
    this.inTail = false;
    this.active = true;
  }

  process() {
    if (!this.active) return 0;
    if (this.burstsLeft > 0 && --this.nextBurst <= 0) {
      this.burstsLeft--;
      // the LAST burst is the loudest and owns the ringing tail
      this.env = this.vel * (this.burstsLeft === 0 ? 1 : 0.85);
      this.nextBurst = this.interval;
      if (this.burstsLeft === 0) this.inTail = true;
    }
    const noise = Math.random() * 2 - 1;
    const s = this.lp.process(this.hp.process(noise)) * this.env;
    this.env *= this.inTail ? this.tailCoef : this.burstCoef;
    // stay armed while bursts are still pending, even if a burst's micro-env
    // has already died out (wide SPREAD leaves silent gaps between bursts)
    if (this.env < 1e-4 && this.burstsLeft === 0) this.active = false;
    return s * this.level;
  }
}
