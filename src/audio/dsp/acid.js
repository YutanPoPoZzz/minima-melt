// The 303 — melt's lead voice. Grown from galaxy's bass303.js with the three
// melt extensions from DESIGN.md: WAVE (polyblep saw <-> polyblep square
// crossfade), ENVMOD (the classic ENV MOD knob — how far the filter envelope
// opens the cutoff), and DRIVE (in-voice tanh saturation). The four defining
// 303 ingredients stay intact: one oscillator, a strongly resonant lowpass,
// slides (pitch glides to the next note WITHOUT retriggering the envelopes),
// and accents (a simultaneous boost of volume and filter envelope depth).
//
// Pitch is A1-referenced: root=9 (A) + note 0 lands on A1 (~55 Hz), and the
// per-step note row moves in semitones around that.
//
// MELT plumbing: the engine "melts" this voice through modCutoffOct (cutoff
// offset in OCTAVES — the slow LFO wobble) and modResoAdd (extra resonance),
// plus bend() (retune the glide target without a retrigger — the pitch droop).
// These are modulation inputs, NOT params: the user-facing param values are
// never touched, so melt=0 restores the exact programmed sound.

import { SVF, polyblep } from './util.js';

const PARAMS = ['root', 'wave', 'cutoff', 'reso', 'envMod', 'decay', 'accent', 'glide', 'drive', 'level'];

export class Acid {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.phase = 0;
    this.freq = 55;
    this.targetFreq = 55;
    this.ampEnv = 0;
    this.filtEnv = 0;
    this.att = 1; // short attack ramp to soften the note-on click
    this.accentAmt = 0;
    this.active = false;
    this.filter = new SVF(sampleRate);

    // engine-layer MELT modulation (see header) — identity when melt is 0
    this.modCutoffOct = 0;
    this.modResoAdd = 0;

    // canonical defaults — MUST match the DESIGN.md table / index.html values
    this.root = 9; // 0..11 — 9 = A, so note 0 is A1 (~55 Hz)
    this.wave = 0; // 0 saw .. 1 square
    this.cutoff = 380; // LPF base Hz
    this.reso = 0.75;
    this.envMod = 0.65; // filter env depth — the ENV MOD knob
    this.decay = 0.18; // filter env decay — the acid pluck length
    this.accent = 0.7;
    this.glide = 0.055; // slide time in seconds
    this.drive = 0.35; // in-voice saturation
    this.level = 0.8;
    this._recalc();
  }

  _recalc() {
    this.ampCoef = Math.exp(Math.log(0.001) / (0.4 * this.sr));
    this.filtCoef = Math.exp(-1 / (this.decay * this.sr));
    this.glideCoef = 1 - Math.exp(-1 / (this.glide * this.sr));
    this.attStep = 1 / (0.002 * this.sr);
  }

  set(name, value) {
    if (PARAMS.includes(name)) {
      this[name] = value;
      this._recalc();
    }
  }

  // note: semitones relative to root at octave 1 — root=9, note=0 => A1 55 Hz
  freqFor(note) {
    return 55 * Math.pow(2, (this.root - 9 + note) / 12);
  }

  // slide=true on an active voice ONLY retunes the glide target: the phase,
  // amp env and filter env all keep running — the 303 slide.
  noteOn(note, accent = false, slide = false) {
    this.targetFreq = this.freqFor(note);
    if (slide && this.active) return;
    this.freq = this.targetFreq;
    this.ampEnv = 1;
    this.filtEnv = 1;
    this.att = 0;
    this.accentAmt = accent ? this.accent : 0;
    this.active = true;
  }

  // retune the glide target without touching any envelope — the engine uses
  // this (fractional notes allowed) for the MELT pitch droop.
  bend(note) {
    this.targetFreq = this.freqFor(note);
  }

  process() {
    if (!this.active) return 0;
    this.freq += (this.targetFreq - this.freq) * this.glideCoef;
    const dt = this.freq / this.sr;
    this.phase += dt;
    if (this.phase >= 1) this.phase -= 1;

    // WAVE: polyblep saw crossfaded into a polyblep square
    const saw = 2 * this.phase - 1 - polyblep(this.phase, dt);
    let sqPhase = this.phase + 0.5;
    if (sqPhase >= 1) sqPhase -= 1;
    const square = (this.phase < 0.5 ? 1 : -1) + polyblep(this.phase, dt) - polyblep(sqPhase, dt);
    const osc = saw + (square - saw) * this.wave;

    // filter env opens the cutoff by up to +4 octaves (scaled by ENV MOD);
    // accent pushes the envelope harder, MELT wobbles the whole thing
    const envLevel = this.filtEnv * (1 + this.accentAmt * 1.5);
    let fc = this.cutoff * Math.pow(2, this.envMod * envLevel * 4 + this.modCutoffOct);
    if (fc > 12000) fc = 12000;
    if (fc < 30) fc = 30;
    const res = Math.min(0.97, this.reso + this.accentAmt * 0.1 + this.modResoAdd);
    const out = this.filter.lowpass(osc, fc, res);

    if (this.att < 1) this.att = Math.min(1, this.att + this.attStep);
    const amp = this.ampEnv * this.att * (1 + this.accentAmt * 0.6);
    this.ampEnv *= this.ampCoef;
    this.filtEnv *= this.filtCoef;
    if (this.ampEnv < 1e-4) this.active = false;

    // DRIVE: tanh saturation — tames resonance/accent peaks and adds the
    // overdriven spit acid lines are known for
    const d = 1.5 + this.drive * 5;
    return Math.tanh(out * amp * d) * this.level;
  }
}
