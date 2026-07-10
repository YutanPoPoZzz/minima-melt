// Offline sanity checks for the melt voices: kick, hat, clap, and the 303.
// Renders each to test/out/*.wav and verifies the numbers: bounded output,
// no NaN, decay behaviour, tune/tone response, choke, clap spread, and the
// full 303 contract — A1 root pitch, +12 doubling, wave morph, slide (no
// retrigger), accent, envMod, drive.

import { Kick } from '../src/audio/dsp/kick.js';
import { Hat } from '../src/audio/dsp/hat.js';
import { Clap } from '../src/audio/dsp/clap.js';
import { Acid } from '../src/audio/dsp/acid.js';
import { toWav, stats, rms } from './wav.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SR = 48000;
let ok = true;

function check(cond, label) {
  if (!cond) {
    ok = false;
    console.error(`FAIL: ${label}`);
  }
}

mkdirSync(join(__dirname, 'out'), { recursive: true });

// upward zero crossings inside a window -> rough pitch
function zeroCrossFreq(buf, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) {
    if (buf[i - 1] < 0 && buf[i] >= 0) n++;
  }
  return (n * SR) / (to - from);
}

// window "brightness" = rms(first-difference)/rms — a crude spectral-centroid
// proxy used for the tone/punch/cutoff checks
function brightness(arr, from, to) {
  let dsum = 0;
  for (let i = from + 1; i < to; i++) {
    const dd = arr[i] - arr[i - 1];
    dsum += dd * dd;
  }
  return Math.sqrt(dsum / (to - from)) / (rms(arr, from, to) + 1e-9);
}

// ---- kick: punch, sweep landing on TUNE, decay ----
{
  const kick = new Kick(SR);
  const buf = new Float32Array(SR);
  kick.trigger(1);
  for (let i = 0; i < buf.length; i++) buf[i] = kick.process();

  const s = stats(buf);
  check(!s.hasNaN, 'kick: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.2, `kick: peak in range (${s.peak.toFixed(3)})`);
  const early = rms(buf, 0, SR * 0.1);
  const late = rms(buf, SR * 0.6, SR * 0.8);
  check(late < early * 0.05, 'kick: decays');

  // TUNE: after the sweep settles the sine should sit near tune (46 Hz)
  const f46 = zeroCrossFreq(buf, SR * 0.1, SR * 0.2);
  check(f46 > 38 && f46 < 62, `kick: settles near TUNE=46 (${f46.toFixed(1)} Hz)`);
  const k64 = new Kick(SR);
  k64.set('tune', 64);
  const b64 = new Float32Array(SR * 0.3);
  k64.trigger(1);
  for (let i = 0; i < b64.length; i++) b64[i] = k64.process();
  const f64 = zeroCrossFreq(b64, SR * 0.1, SR * 0.2);
  check(f64 > f46 + 8, `kick: TUNE raises pitch (${f46.toFixed(1)} -> ${f64.toFixed(1)} Hz)`);

  // PUNCH: more punch = a louder front transient (click) in the first 5 ms
  const front = (punch) => {
    const k = new Kick(SR);
    k.set('punch', punch);
    k.trigger(1);
    const o = new Float32Array(SR * 0.05);
    for (let i = 0; i < o.length; i++) o[i] = k.process();
    return brightness(o, 0, SR * 0.005);
  };
  const soft = front(0);
  const hard = front(1);
  check(hard > soft * 1.3, `kick: PUNCH sharpens the front (${soft.toFixed(3)} -> ${hard.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'kick.wav'), toWav(buf, SR));
  const r = rms(buf, 0, buf.length);
  check(r > 0.01, `kick: not silent (rms ${r.toFixed(4)})`);
  console.log(`kick ok (peak ${s.peak.toFixed(3)}, rms ${r.toFixed(4)}, tune ${f46.toFixed(1)} Hz)`);
}

// ---- hat: closed tick vs open wash, choke, TONE brightens ----
{
  const hat = new Hat(SR);
  const buf = new Float32Array(SR);
  hat.trigger(false, 1); // closed at 0
  for (let i = 0; i < SR * 0.25; i++) buf[i] = hat.process();
  hat.trigger(true, 1); // open at 0.25 s
  for (let i = SR * 0.25; i < SR; i++) buf[i] = hat.process();

  const s = stats(buf);
  check(!s.hasNaN, 'hat: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.02, `hat: peak in range (${s.peak.toFixed(3)})`);
  const closedTail = rms(buf, SR * 0.1, SR * 0.15); // 100 ms after the closed tick
  const openTail = rms(buf, SR * 0.4, SR * 0.45); // 150 ms after the open hat
  check(closedTail < 0.005, 'hat: closed tick decays fast');
  check(openTail > closedTail * 3, 'hat: open rings longer than closed');

  // CHOKE: a closed tick right after an open hit must kill the open tail —
  // compare the tail level with and without the choking tick
  const renderChoke = (choke) => {
    const h = new Hat(SR);
    h.trigger(true, 1);
    const o = new Float32Array(SR * 0.3);
    for (let i = 0; i < o.length; i++) {
      if (choke && i === Math.floor(SR * 0.06)) h.trigger(false, 1);
      o[i] = h.process();
    }
    return rms(o, SR * 0.12, SR * 0.2);
  };
  const rung = renderChoke(false);
  const choked = renderChoke(true);
  check(choked < rung * 0.4, `hat: retrigger chokes the tail (${rung.toFixed(4)} -> ${choked.toFixed(4)})`);

  // TONE: higher tone = higher highpass = brighter hiss
  const toneEdge = (tone) => {
    const h = new Hat(SR);
    h.set('tone', tone);
    h.trigger(true, 1);
    const o = new Float32Array(SR * 0.15);
    for (let i = 0; i < o.length; i++) o[i] = h.process();
    return brightness(o, 0, o.length);
  };
  const dark = toneEdge(0);
  const bright = toneEdge(1);
  check(bright > dark * 1.1, `hat: TONE brightens (${dark.toFixed(3)} -> ${bright.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'hat.wav'), toWav(buf, SR));
  const r = rms(buf, 0, buf.length);
  check(r > 0.001, `hat: not silent (rms ${r.toFixed(4)})`);
  console.log(`hat ok (peak ${s.peak.toFixed(3)}, rms ${r.toFixed(4)}, choke ${rung.toFixed(4)}->${choked.toFixed(4)})`);
}

// ---- clap: burst cluster + tail, SPREAD widens, TONE brightens ----
{
  const clap = new Clap(SR);
  const buf = new Float32Array(SR * 0.8);
  clap.trigger(1);
  for (let i = 0; i < buf.length; i++) buf[i] = clap.process();

  const s = stats(buf);
  check(!s.hasNaN, 'clap: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.05, `clap: peak in range (${s.peak.toFixed(3)})`);
  const early = rms(buf, 0, SR * 0.08);
  const late = rms(buf, SR * 0.6, SR * 0.75);
  check(late < early * 0.05, 'clap: decays');

  // SPREAD: wider spread pushes the bursts (and so the energy) later —
  // compare the centre of mass of |x| over the first 80 ms
  const com = (spread) => {
    const c = new Clap(SR);
    c.set('spread', spread);
    c.trigger(1);
    const n = Math.floor(SR * 0.08);
    let wsum = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(c.process());
      wsum += i * a;
      sum += a;
    }
    return wsum / (sum + 1e-9);
  };
  const tight = com(0);
  const wide = com(1);
  check(wide > tight * 1.2, `clap: SPREAD widens the cluster (com ${tight.toFixed(0)} -> ${wide.toFixed(0)} samples)`);

  // TONE: higher tone moves the noise band up = brighter
  const toneEdge = (tone) => {
    const c = new Clap(SR);
    c.set('tone', tone);
    c.trigger(1);
    const o = new Float32Array(SR * 0.15);
    for (let i = 0; i < o.length; i++) o[i] = c.process();
    return brightness(o, 0, o.length);
  };
  const dull = toneEdge(0);
  const crisp = toneEdge(1);
  check(crisp > dull * 1.15, `clap: TONE brightens (${dull.toFixed(3)} -> ${crisp.toFixed(3)})`);

  writeFileSync(join(__dirname, 'out', 'clap.wav'), toWav(buf, SR));
  const r = rms(buf, 0, buf.length);
  check(r > 0.001, `clap: not silent (rms ${r.toFixed(4)})`);
  console.log(`clap ok (peak ${s.peak.toFixed(3)}, rms ${r.toFixed(4)}, spread com ${tight.toFixed(0)}->${wide.toFixed(0)})`);
}

// ---- acid: the 303 contract ----
{
  // a short phrase at the canonical defaults: root note (accented), a slide
  // up an octave, then a plain +3 — the wav to listen to
  const acid = new Acid(SR);
  const buf = new Float32Array(Math.floor(SR * 1.5));
  acid.noteOn(0, true, false);
  for (let i = 0; i < SR * 0.5; i++) buf[i] = acid.process();
  acid.noteOn(12, false, true); // slide — no retrigger
  for (let i = SR * 0.5; i < SR; i++) buf[i] = acid.process();
  acid.noteOn(3, false, false);
  for (let i = SR; i < buf.length; i++) buf[i] = acid.process();

  const s = stats(buf);
  check(!s.hasNaN, 'acid: no NaN');
  check(s.peak <= 1.0 && s.peak > 0.1, `acid: peak in range (${s.peak.toFixed(3)})`);
  const early = rms(buf, 0, SR * 0.1);
  const tail = rms(buf, SR * 0.45, SR * 0.5);
  check(tail < early, 'acid: note decays');
  writeFileSync(join(__dirname, 'out', 'acid.wav'), toWav(buf, SR));
  const r = rms(buf, 0, buf.length);
  check(r > 0.01, `acid: not silent (rms ${r.toFixed(4)})`);

  // PITCH: root=9 (default), note 0 must sit at A1 ~55 Hz; +12 doubles it.
  // Open the filter and kill reso so zero crossings track the fundamental.
  const renderNote = (note, setup = {}) => {
    const a = new Acid(SR);
    a.set('cutoff', 3000);
    a.set('reso', 0);
    a.set('envMod', 0);
    for (const [k, v] of Object.entries(setup)) a.set(k, v);
    a.noteOn(note, false, false);
    const o = new Float32Array(SR * 0.5);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    return zeroCrossFreq(o, SR * 0.05, SR * 0.45);
  };
  const fA1 = renderNote(0);
  check(Math.abs(fA1 - 55) < 4, `acid: root=9 note=0 is A1 ~55 Hz (${fA1.toFixed(1)} Hz)`);
  const fA2 = renderNote(12);
  const ratio = fA2 / fA1;
  check(ratio > 1.9 && ratio < 2.1, `acid: +12 doubles pitch (${fA1.toFixed(1)} -> ${fA2.toFixed(1)} Hz)`);
  // ROOT: root=0 (C) sits 9 semitones below A1
  const fC1 = renderNote(0, { root: 0 });
  const cRatio = fC1 / fA1;
  const target = Math.pow(2, -9 / 12);
  check(Math.abs(cRatio - target) < 0.06, `acid: ROOT transposes (A ${fA1.toFixed(1)} -> C ${fC1.toFixed(1)} Hz)`);

  // WAVE: saw vs square must be genuinely different waveforms
  const renderWave = (wave) => {
    const a = new Acid(SR);
    a.set('wave', wave);
    a.set('cutoff', 3000);
    a.set('reso', 0);
    a.set('envMod', 0);
    a.noteOn(0, false, false);
    const o = new Float32Array(SR * 0.2);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    return o;
  };
  const sawBuf = renderWave(0);
  const sqBuf = renderWave(1);
  let waveDiff = 0;
  for (let i = 0; i < sawBuf.length; i++) waveDiff += Math.abs(sawBuf[i] - sqBuf[i]);
  waveDiff /= sawBuf.length;
  check(waveDiff > 0.05, `acid: WAVE morph changes the waveform (mean diff ${waveDiff.toFixed(3)})`);
  const fSq = zeroCrossFreq(sqBuf, SR * 0.05, SR * 0.18);
  check(Math.abs(fSq - fA1) < 5, `acid: square keeps the pitch (${fSq.toFixed(1)} Hz)`);

  // SLIDE: noteOn(slide=true) on an active voice must NOT retrigger the amp
  // envelope, and the internal frequency must glide, not jump
  const g = new Acid(SR);
  g.set('glide', 0.12);
  g.noteOn(0, false, false);
  for (let i = 0; i < SR * 0.1; i++) g.process();
  const envBefore = g.ampEnv;
  const fStart = g.freq;
  g.noteOn(12, false, true); // slide
  check(g.ampEnv === envBefore, 'acid: SLIDE does not retrigger the envelope');
  for (let i = 0; i < SR * 0.06; i++) g.process();
  const fMid = g.freq;
  for (let i = 0; i < SR; i++) g.process();
  const fEnd = g.freq;
  check(
    fMid > fStart * 1.1 && fMid < fEnd * 0.92 && Math.abs(fEnd / (fStart * 2) - 1) < 0.02,
    `acid: SLIDE glides the pitch (${fStart.toFixed(1)} -> ${fMid.toFixed(1)} -> ${fEnd.toFixed(1)} Hz)`
  );
  // non-slide retrigger DOES reset the envelope
  const h = new Acid(SR);
  h.noteOn(0, false, false);
  for (let i = 0; i < SR * 0.1; i++) h.process();
  h.noteOn(12, false, false);
  check(h.ampEnv === 1, 'acid: plain retrigger resets the envelope');

  // ACCENT: an accented hit is louder and opens the filter further (brighter)
  const renderAcc = (acc) => {
    const a = new Acid(SR);
    a.noteOn(0, acc, false);
    const o = new Float32Array(SR * 0.15);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    return o;
  };
  const plain = renderAcc(false);
  const accd = renderAcc(true);
  const plainR = rms(plain, 0, plain.length);
  const accR = rms(accd, 0, accd.length);
  check(accR > plainR * 1.15, `acid: ACCENT is louder (rms ${plainR.toFixed(3)} -> ${accR.toFixed(3)})`);

  // ENVMOD: more env depth = a brighter attack
  const renderEnv = (envMod) => {
    const a = new Acid(SR);
    a.set('envMod', envMod);
    a.noteOn(0, false, false);
    const o = new Float32Array(SR * 0.08);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    return brightness(o, 0, o.length);
  };
  const shut = renderEnv(0);
  const biting = renderEnv(1);
  check(biting > shut * 1.3, `acid: ENVMOD opens the pluck (${shut.toFixed(3)} -> ${biting.toFixed(3)})`);

  // DRIVE: more drive = more saturation = a changed (fatter) waveform
  const renderDrive = (drive) => {
    const a = new Acid(SR);
    a.set('drive', drive);
    a.noteOn(0, false, false);
    const o = new Float32Array(SR * 0.2);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    return o;
  };
  const cleanB = renderDrive(0);
  const hotB = renderDrive(1);
  let driveDiff = 0;
  for (let i = 0; i < cleanB.length; i++) driveDiff += Math.abs(cleanB[i] - hotB[i]);
  driveDiff /= cleanB.length;
  check(driveDiff > 0.01, `acid: DRIVE saturates (mean diff ${driveDiff.toFixed(4)})`);

  // MELT modulation inputs: modCutoffOct shifts brightness, params untouched
  const renderMod = (oct) => {
    const a = new Acid(SR);
    a.modCutoffOct = oct;
    a.noteOn(0, false, false);
    const o = new Float32Array(SR * 0.15);
    for (let i = 0; i < o.length; i++) o[i] = a.process();
    check(a.cutoff === 380, 'acid: modCutoffOct leaves the cutoff param untouched');
    return brightness(o, 0, o.length);
  };
  const down = renderMod(-1.5);
  const up = renderMod(1.5);
  check(up > down * 1.2, `acid: modCutoffOct wobbles the filter (${down.toFixed(3)} -> ${up.toFixed(3)})`);

  console.log(
    `acid ok (peak ${s.peak.toFixed(3)}, rms ${r.toFixed(4)}, A1 ${fA1.toFixed(1)} Hz, +12 ratio ${ratio.toFixed(2)}, ` +
      `slide ${fStart.toFixed(1)}->${fMid.toFixed(1)}->${fEnd.toFixed(1)} Hz)`
  );
}

console.log(ok ? '\nALL CHECKS PASSED — wavs in test/out/' : '\nSOME CHECKS FAILED');
process.exit(ok ? 0 : 1);
