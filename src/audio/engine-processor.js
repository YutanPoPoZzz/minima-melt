// The audio engine. Runs on the audio thread (AudioWorklet), which owns the
// master clock and the 16-step sequencer — same architecture as minima galaxy
// / rain / drift / city / fission. The UI thread only sends parameter/pattern
// messages through the port and receives the current step back for the
// playhead ({type:'step',index} is the ONLY engine->UI message).
//
// melt's identity over its siblings: acid techno at 130 BPM — a four-on-the-
// floor kick, a sixteenth hat grid with offbeat opens, claps on 4/12, and the
// 303 up front with per-step pitch + accent + slide. MELT is the hero macro —
// the dissolution: a slow LFO wobbles the 303's cutoff (up to ±1.5 octaves),
// resonance creeps up (+0.2, capped 0.97), lit steps randomly droop up to -5
// semitones reached THROUGH the glide (the pitch literally melting off), non-
// slide steps fuse into slides, the delay feedback rises (+0.12), and past 0.7
// bubble pops — high-resonance filter pings at 800..3000 Hz — burst at random.
// The dice are a seeded xorshift reseeded at step 0, so each bar is a coherent
// variation — and melt=0 is ALWAYS the exact programmed pattern: every
// intervention lives at the engine layer (modulation inputs + bend), never in
// the voice params.
//
// This file is the only place AudioWorklet globals (sampleRate,
// AudioWorkletProcessor, registerProcessor) are referenced; the dsp/ modules
// stay pure so Node can import them for the offline render tests.

import { Kick } from './dsp/kick.js';
import { Hat } from './dsp/hat.js';
import { Clap } from './dsp/clap.js';
import { Acid } from './dsp/acid.js';
import { DubDelay, Reverb, Ducker, Bitcrush, Bubble } from './dsp/effects.js';
import { xorshift32 } from './dsp/util.js';

const STEPS = 16;
const TWO_PI = 2 * Math.PI;

class EngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.playing = false;
    this.bpm = 130; // canonical default
    this.stepIndex = 0;
    this.sampleInStep = 0;
    this.swing = 0.02; // canonical default (fx `swing`)

    this.voices = {
      kick: new Kick(sampleRate),
      hat: new Hat(sampleRate),
      clap: new Clap(sampleRate),
      acid: new Acid(sampleRate),
    };

    this.delay = new DubDelay(sampleRate);
    this.reverb = new Reverb(sampleRate);
    this.ducker = new Ducker(sampleRate);
    this.crush = new Bitcrush();
    this.bubble = new Bubble(sampleRate);
    this.syncDelay(); // dotted eighth (3 sixteenth steps)

    // trigger rows (0/1). The UI pushes its own state on startup; these are
    // the canonical defaults from DESIGN.md in case it doesn't. The hat has
    // TWO rows (closed/open) sharing one voice — open wins on a shared step
    // and chokes the closed tail.
    this.patterns = {
      kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
      hatC: [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1],
      hatO: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
      clap: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
      acid: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1],
    };
    // per-step 303 lanes, canonical defaults: semitones -12..+12 / accent 0-1
    // / slide 0-1 (slide=1: glide from the previous note, no retrigger)
    this.acidNotes = [0, 0, 0, 12, 0, 0, 0, 3, 0, 0, -2, 12, 0, 0, 7, 5];
    this.acidAcc = [1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0];
    this.acidSlide = [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

    // FX base values the UI can override. MELT modulates on top of these.
    this.delaySend = 0.3; // fx `delay`
    this.delayFeedback = 0.5; // fx `feedback`
    this.reverbSend = 0.15; // fx `reverb`
    // fx `crush` and `duck` live directly on their processors (defaults there)

    // MELT (0 = solid, 1 = fully molten): cutoff LFO, reso creep, pitch droop,
    // slide fusing, delay feedback, bubble pops. Dice reseed at step 0 each
    // bar. Everything is applied at the engine layer so melt=0 restores the
    // exact programmed pattern.
    this.melt = 0;
    this.rng = null;
    this.loopSeed = 33333;
    this.lfoPhase = 0;
    this.lfoRate = 0.25; // Hz — re-rolled 0.15..0.35 at each bar while molten
    this.pops = []; // scheduled bubble pops {in, freq}

    this.muted = { kick: false, hat: false, clap: false, acid: false };
    this.master = 0.85;

    this.applyMelt();
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  get samplesPerStep() {
    // 16th notes: one beat is 60/bpm seconds, one step is a quarter of that.
    return Math.max(1, Math.round(((60 / this.bpm) * sampleRate) / 4));
  }

  // swing: even steps stretch, odd steps shrink — pairs keep the same total
  stepLength(index) {
    const sps = this.samplesPerStep;
    return Math.max(1, Math.round(sps * (index % 2 === 0 ? 1 + this.swing : 1 - this.swing)));
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'play':
        this.stepIndex = 0;
        this.sampleInStep = 0;
        this.pops.length = 0;
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        this.pops.length = 0;
        break;
      case 'bpm':
        this.bpm = Math.min(190, Math.max(60, msg.value));
        this.syncDelay();
        break;
      case 'master':
        this.master = Math.min(1, Math.max(0, msg.value));
        break;
      case 'mute':
        if (msg.track in this.muted) this.muted[msg.track] = !!msg.value;
        break;
      case 'steps':
        if (this.patterns[msg.track]) this.patterns[msg.track] = msg.steps;
        break;
      case 'param':
        if (this.voices[msg.track]) this.voices[msg.track].set(msg.name, msg.value);
        break;
      case 'fx':
        this.setFxParam(msg.name, msg.value);
        break;
      case 'melt':
        this.melt = Math.min(1, Math.max(0, msg.value));
        this.applyMelt();
        break;
      case 'acidNotes':
        if (Array.isArray(msg.notes) && msg.notes.length === STEPS) this.acidNotes = msg.notes;
        break;
      case 'acidAcc':
        if (Array.isArray(msg.flags) && msg.flags.length === STEPS) this.acidAcc = msg.flags;
        break;
      case 'acidSlide':
        if (Array.isArray(msg.flags) && msg.flags.length === STEPS) this.acidSlide = msg.flags;
        break;
    }
  }

  syncDelay() {
    // dotted eighth = 3 sixteenth steps — the acid throw
    this.delay.setTimeSamples(3 * this.samplesPerStep);
  }

  setFxParam(name, value) {
    switch (name) {
      case 'delay':
        this.delaySend = value;
        break;
      case 'feedback':
        this.delayFeedback = value;
        this.applyMelt();
        break;
      case 'reverb':
        this.reverbSend = value;
        break;
      case 'crush':
        this.crush.set('amount', value);
        break;
      case 'duck':
        this.ducker.set('amount', value);
        break;
      case 'swing':
        this.swing = Math.min(0.3, Math.max(0, value));
        break;
    }
  }

  // fold MELT into the continuous targets: the delay feedback creeps up, the
  // 303's resonance rises (through the modulation input, NOT the param), and
  // at exactly 0 every modulation returns home so the voice is untouched.
  applyMelt() {
    const m = this.melt;
    this.delay.feedback = Math.min(0.9, this.delayFeedback + m * 0.12);
    this.voices.acid.modResoAdd = 0.2 * m; // voice caps total reso at 0.97
    if (m === 0) this.voices.acid.modCutoffOct = 0; // LFO fully off
  }

  // reseed the dissolution dice — called at step 0 of every bar, so each pass
  // is its own coherent variation (fission CRITICAL flow). The cutoff LFO
  // speed is re-rolled per bar inside the design's 0.15..0.35 Hz band.
  reseed() {
    this.loopSeed = (this.loopSeed * 1664525 + 1013904223) >>> 0;
    this.rng = xorshift32(this.loopSeed ^ 0x9e3779b9);
    this.lfoRate = 0.15 + this.rng() * 0.2;
  }

  triggerStep(index) {
    if (index === 0 || !this.rng) this.reseed();
    const m = this.melt;
    const len = this.stepLength(index);

    // KICK — the anchor; four on the floor, never ducked
    if (this.patterns.kick[index]) {
      this.voices.kick.trigger(1);
      this.ducker.trigger();
    }

    // HAT — open wins a shared step and chokes the closed tail (one voice)
    if (this.patterns.hatO[index]) {
      this.voices.hat.trigger(true, 1);
    } else if (this.patterns.hatC[index]) {
      this.voices.hat.trigger(false, 0.9);
    }

    // CLAP
    if (this.patterns.clap[index]) {
      this.voices.clap.trigger(1);
    }

    // ACID — per-step note/accent/slide. MELT intervenes here (dice are only
    // rolled while molten, so melt=0 stays bit-exact to the programmed line):
    // non-slide steps fuse into slides with probability ∝ melt, and lit steps
    // droop up to -5 semitones × melt, reached through the glide.
    if (this.patterns.acid[index]) {
      const note = this.acidNotes[index] | 0;
      const acc = !!this.acidAcc[index];
      let slide = !!this.acidSlide[index];
      if (m > 0 && !slide && this.rng() < m * 0.6) slide = true;
      this.voices.acid.noteOn(note, acc, slide);
      if (m > 0 && this.rng() < m * 0.9) {
        const droop = this.rng() * 5 * m;
        this.voices.acid.bend(note - droop);
      }
    }

    // BUBBLE POPS — past melt 0.7, schedule a filter ping at a random offset
    // inside this step, pitched 800..3000 Hz
    if (m > 0.7 && this.rng() < ((m - 0.7) / 0.3) * 0.45) {
      this.pops.push({
        in: 1 + Math.floor(this.rng() * len * 0.9),
        freq: 800 + this.rng() * 2200,
      });
    }
  }

  // fire any scheduled bubble pops whose countdown has elapsed
  runPops() {
    for (let j = this.pops.length - 1; j >= 0; j--) {
      const p = this.pops[j];
      if (--p.in <= 0) {
        this.bubble.trigger(p.freq, 0.5);
        this.pops[j] = this.pops[this.pops.length - 1];
        this.pops.pop();
      }
    }
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || out[0];

    for (let i = 0; i < left.length; i++) {
      if (this.playing) {
        if (this.sampleInStep === 0) {
          this.triggerStep(this.stepIndex);
          this.port.postMessage({ type: 'step', index: this.stepIndex });
        }
        if (this.pops.length) this.runPops();
        this.sampleInStep++;
        if (this.sampleInStep >= this.stepLength(this.stepIndex)) {
          this.sampleInStep = 0;
          this.stepIndex = (this.stepIndex + 1) % STEPS;
        }
      }

      // MELT cutoff LFO — a slow wobble up to ±1.5 octaves, engine-layer only
      if (this.melt > 0) {
        this.lfoPhase += this.lfoRate / sampleRate;
        if (this.lfoPhase >= 1) this.lfoPhase -= 1;
        this.voices.acid.modCutoffOct = Math.sin(TWO_PI * this.lfoPhase) * 1.5 * this.melt;
      }

      const kickS = this.voices.kick.process() * (this.muted.kick ? 0 : 1);
      const hatS = this.voices.hat.process() * (this.muted.hat ? 0 : 1);
      const clapS = this.voices.clap.process() * (this.muted.clap ? 0 : 1);
      const acidS = this.voices.acid.process() * (this.muted.acid ? 0 : 1);
      const pop = this.bubble.process();

      // sends: the 303 is the main throw into the dotted-eighth delay, the
      // hat and clap lighter ones; the reverb is a small plate centred on the
      // clap with some acid and a little of the delay tail folded in.
      const delayOut = this.delay.process(
        (acidS * 0.7 + hatS * 0.12 + clapS * 0.2) * this.delaySend
      );
      const verbOut = this.reverb.process(
        (clapS * 0.8 + acidS * 0.3 + delayOut * 0.3) * this.reverbSend
      );

      // sidechain: everything except the kick breathes when the kick lands
      const duck = this.ducker.process();

      // bus: kick (unducked) + everything else through the duck, the whole
      // mix through the bitcrush texture, then the master soft-clip.
      const mix = this.crush.process(
        kickS + (hatS + clapS + acidS + pop + delayOut + verbOut) * duck
      );

      // master soft-clip — the contract: master = tanh(mix * master)
      left[i] = Math.tanh(mix * this.master);
      right[i] = left[i];
    }
    return true;
  }
}

registerProcessor('melt-engine', EngineProcessor);
