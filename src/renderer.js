// minima melt — UI thread. The same architecture as galaxy/fission,
// reinterpreted as MELTING GRAFFITI: a tag drawn in light on a night wall,
// dissolving. Everything stays in the series' vocabulary — white line-art
// and luminous orbs on near-black, never a painted fill:
//
//   galaxy sun         -> a bubble-letter "M" THROW-UP, dead centre: hollow
//                         double outline, hand-drawn and wobbling (JS-driven
//                         path), paint-runs threading off its lower edge.
//                         = play/stop (pointerdown). It pulses while playing,
//                         bulges on the kick, and its shockwave ring is the
//                         sidechain made visible.
//   galaxy orbit rings -> a ring of 16 SPRAY SPLATS around the M — the steps.
//                         A lit splat glows violet and hangs a paint-run;
//                         an accented acid step blazes bigger and wears a
//                         crown; a slide step is joined to the previous one
//                         by a streak of paint that ran along the wall.
//   galaxy playhead    -> a little SPRAY CAN (white line-art) circling the
//                         ring, scattering mist behind its nozzle; crossing
//                         a lit splat it BURSTS: mist puffs out, a ripple
//                         ring blooms and the splat stretches for an instant.
//   galaxy planets     -> four MELTING GRAFFITI ICONS: KICK = a wildstyle
//                         arrow, HATS = a sparkle star, CLAP = an
//                         exclamation mark, ACID = a crown — each one-stroke
//                         line-art with its underside drooping molten.
//                         Tap to open the editor; muting dims the icon.
//   galaxy black hole  -> MELT: a hand-tagged "MELT", top-left — drag DOWN
//                         and the four letters shear, stretch and bleed
//                         paint-runs until they are unreadable at 100%.
//                         Mirrored by #melt-slider in the FX panel. High
//                         MELT: the M slumps, the splat ring undulates,
//                         wall paint-runs multiply and the glow wavers.
//
// Owns the AudioContext and messages the melt engine in the AudioWorklet.

const STEPS = 16;
const NS = 'http://www.w3.org/2000/svg';
const CX = 160;
const CY = 130;
const TILT = 0.42; // vertical squash of the ring plane
const RING_R = 104; // droplet ring radius

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Euclidean rhythm: distribute k hits as evenly as possible across n steps,
// optionally rotated. (Local copy — the audio bundle is owned by the DSP.)
function euclid(k, n, rotate = 0) {
  const raw = [];
  let bucket = 0;
  for (let i = 0; i < n; i++) {
    bucket += k;
    if (bucket >= n) {
      bucket -= n;
      raw.push(1);
    } else {
      raw.push(0);
    }
  }
  const first = raw.indexOf(1);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(raw[(i + first - rotate + 2 * n) % n]);
  }
  return out;
}

let audioCtx = null;
let engine = null;
let playing = false;
let bpm = 130;
let melt = 0;

// trigger rows (0/1). Five rows, four voices — the hat has closed + open
// rows. Initial pattern: the DESIGN.md canonical acid groove (four-on-the-
// floor kick, 16th closed hats yielding the offbeats to opens, claps on the
// backbeat, a rolling 10-note acid line with 3 accents and 3 slides).
const toggles = {
  kick: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
  hatC: [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1],
  hatO: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
  clap: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  acid: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1],
};

// acid rows: per-step semitone offset from ROOT (-12..+12), accent, slide
const acidNotes = Array.from({ length: STEPS }, () => 0);
acidNotes[3] = 12;
acidNotes[7] = 3;
acidNotes[10] = -2;
acidNotes[11] = 12;
acidNotes[14] = 7;
acidNotes[15] = 5;
const acidAcc = Array.from({ length: STEPS }, () => 0);
acidAcc[0] = 1;
acidAcc[7] = 1;
acidAcc[11] = 1;
const acidSlide = Array.from({ length: STEPS }, () => 0);
acidSlide[3] = 1;
acidSlide[8] = 1;
acidSlide[15] = 1;

function send(msg) {
  engine?.port.postMessage(msg);
  scheduleSave(); // any outgoing state change also persists (debounced)
}

function sendAcidRows() {
  send({ type: 'acidNotes', notes: acidNotes });
  send({ type: 'acidAcc', flags: acidAcc });
  send({ type: 'acidSlide', flags: acidSlide });
}

function pushAllState() {
  send({ type: 'bpm', value: bpm });
  send({ type: 'melt', value: melt });
  send({ type: 'master', value: parseFloat(document.getElementById('master-vol').value) });
  for (const [track, steps] of Object.entries(toggles)) {
    send({ type: 'steps', track, steps });
  }
  sendAcidRows();
  document.querySelectorAll('.params input[data-param]').forEach((input) => {
    sendParam(input);
  });
}

// ---- audio setup ----

async function ensureAudio() {
  if (engine) return;
  audioCtx = new AudioContext({ latencyHint: 'interactive' });
  await audioCtx.audioWorklet.addModule('audio/engine-processor.js');
  engine = new AudioWorkletNode(audioCtx, 'melt-engine', {
    outputChannelCount: [2],
  });
  engine.connect(audioCtx.destination);
  engine.port.onmessage = (e) => {
    if (e.data.type === 'step') movePlayhead(e.data.index);
  };
  pushAllState();
}

// ---- melting-graffiti scene ----

// the four melting graffiti icons floating around the M (galaxy's planets)
const LUMPS = {
  acid: { x: 96, y: 46, s: 1.1, label: 'ACID' },
  hat: { x: 240, y: 52, s: 0.85, label: 'HATS' },
  kick: { x: 58, y: 208, s: 1.15, label: 'KICK' },
  clap: { x: 262, y: 202, s: 0.95, label: 'CLAP' },
};

const space = document.getElementById('space');
const ringNodes = []; // per step: { g, core, tail, crown, scaleWrap }
const nodePos = [];
const slideThreads = []; // 16 ran-paint streaks, prev splat -> slide splat
const dotMeta = []; // floating spray-mist particles that wander
const lumpEls = {};
const selectionRings = {};
let playheadG = null;
let splashG = null;
let splashDrops = null;
let sunIcon = null;
let sunEl = null;
let sunHazeEl = null;
let coreBlobEl = null; // the wobbling outer outline of the M (JS-driven path)
let coreInnerEl = null; // the inner echo line of the throw-up
let coreDripsG = null; // paint-runs threading off the M's lower edge
let burstEl = null;
let ringG = null; // ring + splats + playhead: undulates as one at high MELT
let cometA = null;
let cometB = null;
const meltStreaks = []; // extra wall paint-run streaks, revealed by MELT
let kickEnv = 0; // M swell on each kick, decays in the rAF loop

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// project a point on the tilted ring plane; depth is 0 at the back, 1 in front
function proj(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return {
    x: CX + r * Math.cos(a),
    y: CY + TILT * r * Math.sin(a),
    depth: (Math.sin(a) + 1) / 2,
  };
}

// closed Catmull-Rom spline through pts -> smooth cubic Bezier blob path
function blobPath(pts) {
  const n = pts.length;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} `;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    d += `C ${(p1.x + (p2.x - p0.x) / 6).toFixed(2)} ${(p1.y + (p2.y - p0.y) / 6).toFixed(2)}, `
      + `${(p2.x - (p3.x - p1.x) / 6).toFixed(2)} ${(p2.y - (p3.y - p1.y) / 6).toFixed(2)}, `
      + `${p2.x.toFixed(2)} ${p2.y.toFixed(2)} `;
  }
  return d + 'Z';
}

// a static spray-splat outline: an irregular star of spikes, one per node,
// its character varied by seed. Built once — animated only by transform.
function splatPath(r, seed) {
  const spikes = 7;
  let d = '';
  for (let i = 0; i < spikes * 2; i++) {
    const ang = (i / (spikes * 2)) * Math.PI * 2 + seed;
    const rad = i % 2 === 0
      ? r * (1 + 0.35 * Math.sin(seed * 3 + i * 2.1))
      : r * (0.42 + 0.12 * Math.sin(seed * 5 + i * 1.3));
    d += `${i === 0 ? 'M' : 'L'} ${(rad * Math.cos(ang)).toFixed(2)} ${(rad * Math.sin(ang)).toFixed(2)} `;
  }
  return d + 'Z';
}

// a tiny one-stroke crown, worn by accented splats (and ACID's own icon)
const CROWN = 'M -3.2 0.6 L -3.2 -2.6 L -1.6 -0.9 L 0 -3.4 L 1.6 -0.9 L 3.2 -2.6 L 3.2 0.6 Z';

// the melting graffiti icons, one-stroke line-art (drift's car abstraction):
// each outline's underside droops molten. Local coords, unit ~16px tall.
const ICON_PATHS = {
  // KICK: a wildstyle block arrow flying up-right, its tail dripping
  kick: [
    'M 6 -6 L 5 0 L 3.6 -1.4 L -3.4 5.6 Q -3.9 8.4 -4.9 6 L -5.6 3.4 L 1.4 -3.6 L 0 -5 Z',
  ],
  // HATS: a sparkle star whose bottom ray sags and stretches
  hat: [
    'M 0 -7 Q 1.1 -1.6 6.2 0 Q 1.1 1.4 0.4 6.2 Q 0.2 8.6 -0.7 6 Q -1.1 1.4 -6.2 0 Q -1.1 -1.6 0 -7 Z',
  ],
  // CLAP: an exclamation mark, its dot half-melted into a droplet
  clap: [
    'M -1.3 -7.5 L 1.3 -7.5 L 0.8 1.6 L -0.8 1.6 Z',
    'M -1 4.4 Q -1 3.2 0 3.2 Q 1 3.2 1 4.4 Q 1 5.9 0.3 6.7 Q 0 7.1 -0.2 6.4 Q -1 5.6 -1 4.4 Z',
  ],
  // ACID: a crown whose base bulges downward, mid-melt
  acid: [
    'M -6.4 -3.6 L -3.1 -0.9 L 0 -5.6 L 3.1 -0.9 L 6.4 -3.6 L 5.3 3.4 Q 0.2 5.9 -5.3 3.4 Z',
  ],
};

// skeleton of the central bubble-letter "M" (throw-up): a closed clockwise
// outline, smoothed into fat rounded strokes by blobPath. Local coords; the
// window between the top valley and the bottom V keeps the play glyph clear.
const M_PTS = [
  [-19, 14], [-21, 2], [-17, -10], [-9, -15], [0, -8], [9, -15], [17, -10],
  [21, 2], [19, 14], [10, 13], [7, 0], [0, 9], [-7, 0], [-10, 13],
];

// atmosphere: gradients, glow filter, haze banks, falling drip streaks
function buildAtmosphere() {
  const defs = el('defs');

  const glow = el('filter', { id: 'glow', x: '-120%', y: '-120%', width: '340%', height: '340%' });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }));
  const merge = el('feMerge');
  merge.appendChild(el('feMergeNode', { in: 'b' }));
  merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);

  // pale violet chamber haze
  const haze = el('radialGradient', { id: 'haze', cx: '50%', cy: '46%', r: '52%' });
  haze.appendChild(el('stop', { offset: '0%', 'stop-color': '#e9dcf6', 'stop-opacity': 0.3 }));
  haze.appendChild(el('stop', { offset: '55%', 'stop-color': '#d3bfe8', 'stop-opacity': 0.1 }));
  haze.appendChild(el('stop', { offset: '100%', 'stop-color': '#d3bfe8', 'stop-opacity': 0 }));
  defs.appendChild(haze);

  // molten core glow: white heart falling off through toxic violet
  const coreHaze = el('radialGradient', { id: 'core-haze' });
  coreHaze.appendChild(el('stop', { offset: '0%', 'stop-color': '#fdfaff', 'stop-opacity': 1 }));
  coreHaze.appendChild(el('stop', { offset: '45%', 'stop-color': '#c98aff', 'stop-opacity': 0.4 }));
  coreHaze.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(coreHaze);

  // luminous orb: tiny hot core, wide violet falloff — no flat white areas
  const orb = el('radialGradient', { id: 'orb' });
  orb.appendChild(el('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 1 }));
  orb.appendChild(el('stop', { offset: '35%', 'stop-color': '#efe2ff', 'stop-opacity': 0.85 }));
  orb.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(orb);

  // a lit step node: a small violet light-orb
  const nodeViolet = el('radialGradient', { id: 'node-violet' });
  nodeViolet.appendChild(el('stop', { offset: '0%', 'stop-color': '#f6edff', 'stop-opacity': 1 }));
  nodeViolet.appendChild(el('stop', { offset: '55%', 'stop-color': '#a34dff', 'stop-opacity': 0.75 }));
  nodeViolet.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(nodeViolet);

  // an accented acid node runs hotter: white into blazing lavender
  const nodeAcc = el('radialGradient', { id: 'node-acc' });
  nodeAcc.appendChild(el('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 1 }));
  nodeAcc.appendChild(el('stop', { offset: '50%', 'stop-color': '#d9b3ff', 'stop-opacity': 0.85 }));
  nodeAcc.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(nodeAcc);

  // falling light drips (comets): white-violet fade
  const fade = el('linearGradient', { id: 'fade' });
  fade.appendChild(el('stop', { offset: '0%', 'stop-color': '#e6d8f4', 'stop-opacity': 0 }));
  fade.appendChild(el('stop', { offset: '70%', 'stop-color': '#f0e6fb', 'stop-opacity': 0.5 }));
  fade.appendChild(el('stop', { offset: '100%', 'stop-color': '#faf6ff', 'stop-opacity': 1 }));
  defs.appendChild(fade);

  space.appendChild(defs);

  // ghosts of a huge tag, buried in the wall: 1-2 fragment strokes at a
  // whisper of opacity — fat marker sweeps, never louder than the scene
  space.appendChild(el('path', {
    d: 'M -28 216 C 42 152 96 238 148 176 C 184 134 146 116 190 94 C 226 76 264 118 332 72',
    fill: 'none', stroke: 'rgba(240,234,246,0.045)', 'stroke-width': 7, 'stroke-linecap': 'round',
  }));
  space.appendChild(el('path', {
    d: 'M 236 270 C 250 212 302 198 286 152 C 276 124 300 108 326 112',
    fill: 'none', stroke: 'rgba(240,234,246,0.035)', 'stroke-width': 5, 'stroke-linecap': 'round',
  }));

  // chamber haze banks, drifting very slowly (CSS animation)
  space.appendChild(el('ellipse', { class: 'haze-a', cx: 88, cy: 72, rx: 112, ry: 60, fill: 'url(#haze)', opacity: 0.5 }));
  space.appendChild(el('ellipse', { class: 'haze-b', cx: 250, cy: 206, rx: 120, ry: 68, fill: 'url(#haze)', opacity: 0.4 }));

  // paint-runs of light creeping down the wall (the galaxy comets, vertical)
  cometA = el('path', { class: 'comet comet-a', d: 'M 66 -8 C 70 70 62 160 66 268', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.9, fill: 'none', opacity: 0.5 });
  cometB = el('path', { class: 'comet comet-b', d: 'M 254 -8 C 250 84 258 170 252 268', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.7, fill: 'none', opacity: 0.32 });
  space.appendChild(cometA);
  space.appendChild(cometB);
  // extra runs that only appear as MELT rises
  for (const [cls, d, w] of [
    ['comet comet-c', 'M 118 -8 C 122 90 114 180 120 268', 0.8],
    ['comet comet-d', 'M 210 -8 C 206 76 214 168 208 268', 0.7],
    ['comet comet-c', 'M 30 -8 C 34 96 26 186 32 268', 0.6],
  ]) {
    const p = el('path', { class: cls, d, pathLength: 100, stroke: 'url(#fade)', 'stroke-width': w, fill: 'none', opacity: 0 });
    space.appendChild(p);
    meltStreaks.push(p);
  }

  // fine spray-mist particles afloat in the dark
  for (let i = 0; i < 18; i++) {
    const bx = 14 + Math.random() * 292;
    const by = 14 + Math.random() * 232;
    const dot = el('circle', { cx: bx, cy: by, r: (0.5 + Math.random() * 0.7).toFixed(2), fill: 'var(--light)', opacity: (0.1 + Math.random() * 0.2).toFixed(2) });
    space.appendChild(dot);
    dotMeta.push({
      el: dot,
      bx,
      by,
      ph: Math.random() * 6.28,
      w: 0.25 + Math.random() * 0.5,
      ax: 3 + Math.random() * 4,
      ay: 2 + Math.random() * 3,
    });
  }

  // faint distant sparks, twinkling out of phase
  for (const [x, y, r] of [[52, 196, 1.1], [296, 226, 0.9], [124, 24, 0.8], [206, 244, 0.7]]) {
    const star = el('circle', { class: 'bg-star', cx: x, cy: y, r, fill: 'var(--text)' });
    star.style.animationDelay = `${(Math.random() * 5).toFixed(2)}s`;
    star.style.animationDuration = `${(3.5 + Math.random() * 3).toFixed(2)}s`;
    space.appendChild(star);
  }
}

// the splat ring carrying the 16 step nodes, plus decorative shells.
// Everything lives in ringG so the whole ring can undulate at high MELT.
function buildRing() {
  ringG = el('g', { class: 'ring-g' });
  ringG.style.transformOrigin = `${CX}px ${CY}px`;
  space.appendChild(ringG);

  // the sequencer ring: one hand-sprayed circle tag — a wobbly closed sweep
  // instead of a perfect ellipse (perfect crossed orbits read as fission/
  // galaxy DNA, which this unit must not echo)
  const ringPts = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const wob = 1 + 0.045 * Math.sin(a * 3 + 0.9) + 0.03 * Math.sin(a * 5 + 2.2);
    ringPts.push({ x: CX + RING_R * wob * Math.cos(a), y: CY + RING_R * TILT * wob * Math.sin(a) });
  }
  ringG.appendChild(el('path', { class: 'orbit-ring', d: blobPath(ringPts), fill: 'none', stroke: 'rgba(240,234,246,0.32)', 'stroke-width': 0.7, 'stroke-linejoin': 'round' }));
  // the second pass of the spray: an open, offset arc that trails off —
  // the way a hand doubles a circle without ever closing it
  const passPts = [];
  for (let i = 0; i <= 13; i++) {
    const a = ((i + 9.5) / 24) * Math.PI * 2;
    const wob = 1.05 + 0.05 * Math.sin(a * 4 + 4.1);
    passPts.push(`${(CX + RING_R * wob * Math.cos(a)).toFixed(1)} ${(CY + RING_R * TILT * wob * Math.sin(a) + 1.5).toFixed(1)}`);
  }
  ringG.appendChild(el('path', { class: 'orbit-pass', d: 'M ' + passPts.join(' L '), fill: 'none', stroke: 'rgba(240,234,246,0.14)', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-dasharray': '10 3 16 2 22 4', 'stroke-linejoin': 'round' }));

  // slide streaks: paint that ran along the wall from a slide splat back to
  // the splat before it, sagging under gravity (hidden until a slide is lit)
  for (let i = 0; i < STEPS; i++) {
    const th = el('path', { d: '', fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.8, 'stroke-linecap': 'round', opacity: 0, filter: 'url(#glow)' });
    ringG.appendChild(th);
    slideThreads.push(th);
  }

  // 16 spray splats strung on the ring: a static star-splat outline (path,
  // transform/opacity animation only) + a hanging paint-run + a crown that
  // only accented acid steps wear
  for (let i = 0; i < STEPS; i++) {
    const p = proj(RING_R, i * 22.5);
    nodePos.push(p);
    const g = el('g', { class: 'node-g', transform: `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})` });
    const baseR = 2.2 + 1.4 * p.depth;
    const tail = el('path', { class: 'node-tail', d: '', fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.8, 'stroke-linecap': 'round', opacity: 0 });
    const scaleWrap = el('g', { class: 'splat-scale' });
    const core = el('path', { class: 'node-core', d: splatPath(baseR, i * 1.7 + 0.6), fill: 'none', stroke: 'rgba(240,234,246,0.5)', 'stroke-width': 0.7, 'stroke-linejoin': 'round' });
    const crown = el('path', { class: 'node-crown', d: CROWN, transform: `translate(0 ${(-baseR - 3.2).toFixed(1)}) scale(0.8)`, fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.8, 'stroke-linejoin': 'round', opacity: 0, filter: 'url(#glow)' });
    scaleWrap.appendChild(core);
    scaleWrap.appendChild(crown);
    g.appendChild(tail);
    g.appendChild(scaleWrap);
    g.dataset.depth = p.depth.toFixed(3);
    ringG.appendChild(g);
    ringNodes.push({ g, core, tail, crown, scaleWrap });
  }

  // the spray-burst rig: ripple ring + a puff of mist particles.
  // Repositioned to a splat and replayed on each strike.
  splashG = el('g', { class: 'splash' });
  splashG.appendChild(el('circle', { class: 'ripple', cx: 0, cy: 0, r: 5.5, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2 }));
  splashDrops = el('g');
  splashDrops.style.transformOrigin = '0px 0px';
  splashDrops.appendChild(el('circle', { class: 'spl spl-1', cx: 0, cy: 0, r: 1.1, fill: 'var(--accent2-bright)', filter: 'url(#glow)' }));
  splashDrops.appendChild(el('circle', { class: 'spl spl-2', cx: 0, cy: 0, r: 0.9, fill: 'var(--accent)', filter: 'url(#glow)' }));
  splashDrops.appendChild(el('circle', { class: 'spl spl-3', cx: 0, cy: 0, r: 1, fill: 'var(--accent2)', filter: 'url(#glow)' }));
  splashDrops.appendChild(el('circle', { class: 'spl spl-4', cx: 0, cy: 0, r: 0.7, fill: 'var(--accent2-bright)', filter: 'url(#glow)' }));
  splashG.appendChild(splashDrops);
  ringG.appendChild(splashG);

  // the spray-can playhead: a small one-stroke can (drift-car abstraction)
  // gliding around the ring, nozzle trailing mist behind it. Drawn with
  // travel along +x, then rotated to the ring's heading like the rest.
  playheadG = el('g', { class: 'spray-head' });
  // mist scattered behind the nozzle (behind = -x)
  const mistSpots = [[-5.5, -0.7, 0.7], [-8, 0.9, 0.55], [-10.5, -1, 0.45], [-7, -2.2, 0.4]];
  for (const [k, [mx, my, mr]] of mistSpots.entries()) {
    const m = el('circle', { class: 'can-mist', cx: mx, cy: my, r: mr, fill: 'var(--accent2)', opacity: 0.45 });
    m.style.animationDelay = `${(k * 0.37).toFixed(2)}s`;
    playheadG.appendChild(m);
  }
  playheadG.appendChild(el('circle', { class: 'blob-head-glow', cx: 0, cy: 0, r: 5, fill: 'url(#orb)', opacity: 0.5 }));
  const can = el('g', { transform: 'rotate(-90)' }); // cap/nozzle face backwards
  // body: a slim rounded canister
  can.appendChild(el('path', { d: 'M -1.9 -0.6 L -1.9 4.6 Q -1.9 5.6 -0.9 5.6 L 0.9 5.6 Q 1.9 5.6 1.9 4.6 L 1.9 -0.6 Z', fill: 'none', stroke: '#f6edff', 'stroke-width': 0.8, 'stroke-linejoin': 'round', filter: 'url(#glow)' }));
  // cap dome + nozzle stub
  can.appendChild(el('path', { d: 'M -1.3 -0.6 Q -1.3 -2 0 -2 Q 1.3 -2 1.3 -0.6', fill: 'none', stroke: '#f6edff', 'stroke-width': 0.8 }));
  can.appendChild(el('path', { d: 'M -0.4 -2.2 L -0.4 -3.1 L 0.4 -3.1 L 0.4 -2.2', fill: 'none', stroke: '#f6edff', 'stroke-width': 0.7 }));
  // the violet label band
  can.appendChild(el('line', { x1: -1.9, y1: 2.3, x2: 1.9, y2: 2.3, stroke: 'var(--accent)', 'stroke-width': 0.7, opacity: 0.9 }));
  playheadG.appendChild(can);
  ringG.appendChild(playheadG);
  parkPlayhead();
}

// heading (degrees) of the ring at node `index`, from the tangent between its
// neighbours — so the can's mist streams behind its direction of travel
function headingAt(index) {
  const prev = nodePos[(index - 1 + STEPS) % STEPS];
  const next = nodePos[(index + 1) % STEPS];
  return (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI;
}

// park the spray can, dimmed, at step 0 so the ring always keeps its writer
function parkPlayhead() {
  const p = nodePos[0];
  lastDeg = headingAt(0);
  playheadG.style.transition = 'none';
  playheadG.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${lastDeg.toFixed(1)}deg)`;
  playheadG.style.opacity = 0.28;
}

// a track icon: melting graffiti in one-stroke white line-art (arrow, star,
// "!", crown) + a luminous heart + a hanging drip, annotated with a serif
// label (galaxy's planet)
function buildLump(track, cfg) {
  const g = el('g', { class: 'planet', transform: `translate(${cfg.x} ${cfg.y})`, 'data-track': track });
  const s = cfg.s;
  // generous invisible hit area (the icon is small)
  g.appendChild(el('circle', { cx: 0, cy: 4, r: 24, fill: 'transparent' }));
  const ring = el('circle', { class: 'select-ring', cx: 0, cy: 2, r: 14 * s + 4, stroke: 'var(--cream)', 'stroke-width': 0.9, fill: 'none', opacity: 0 });
  g.appendChild(ring);

  const scaleWrap = el('g', { class: 'planet-scale' });
  const body = el('g', { class: 'planet-body bob' });
  body.style.animationDelay = `${(Math.random() * -6).toFixed(2)}s`;
  // the luminous heart glowing behind the tag
  body.appendChild(el('circle', { cx: 0, cy: 0, r: (4.4 * s).toFixed(2), fill: 'url(#orb)', opacity: 0.55 }));
  // the melting icon itself, white line-art (static paths, scaled per track)
  for (const d of ICON_PATHS[track]) {
    body.appendChild(el('path', { d, fill: 'none', stroke: 'rgba(240,234,246,0.75)', 'stroke-width': 0.9, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)', transform: `scale(${s})` }));
  }
  // a paint-run stretching from the icon's underside
  const dripY = 8.5 * s;
  body.appendChild(el('path', { d: `M 0.5 ${dripY.toFixed(1)} Q 0.9 ${(dripY + 2.4).toFixed(1)} 0.4 ${(dripY + 4.4).toFixed(1)}`, fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.6, 'stroke-linecap': 'round', opacity: 0.55 }));
  body.appendChild(el('circle', { cx: 0.4, cy: dripY + 5.4, r: 0.8, fill: 'var(--accent)', opacity: 0.7 }));
  scaleWrap.appendChild(body);
  g.appendChild(scaleWrap);

  // thin leader line down to the annotation label, like a technical diagram
  const halo = 14 * s + 5;
  g.appendChild(el('line', { x1: 0, y1: halo + 1, x2: 0, y2: halo + 7, stroke: 'var(--dim)', 'stroke-width': 0.5 }));
  const text = el('text', { y: halo + 18, 'text-anchor': 'middle', class: 'planet-label' });
  text.textContent = cfg.label;
  g.appendChild(text);

  g.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectTrack(track);
  });
  selectionRings[track] = ring;
  lumpEls[track] = g;
  return g;
}

function buildScene() {
  buildAtmosphere();
  buildRing();

  // track icons (after the ring so they sit on top)
  for (const [track, cfg] of Object.entries(LUMPS)) {
    space.appendChild(buildLump(track, cfg));
  }

  // fx: a small luminous point floating top-right, annotated like the rest
  const fx = el('g', { class: 'planet', transform: 'translate(291 24)', 'data-track': 'fx' });
  fx.appendChild(el('circle', { cx: 0, cy: 8, r: 18, fill: 'transparent' }));
  const fxRing = el('circle', { class: 'select-ring', cx: 0, cy: 0, r: 11, stroke: 'var(--cream)', 'stroke-width': 0.9, fill: 'none', opacity: 0 });
  const fxBody = el('g', { class: 'planet-body bob' });
  fxBody.appendChild(el('circle', { cx: 0, cy: 0, r: 6, fill: 'none', stroke: '#ffffff', 'stroke-width': 1.1, filter: 'url(#glow)' }));
  fx.appendChild(el('line', { x1: 0, y1: 8, x2: 0, y2: 15, stroke: 'var(--dim)', 'stroke-width': 0.5 }));
  const fxText = el('text', { y: 26, 'text-anchor': 'middle', class: 'planet-label' });
  fxText.textContent = 'FX';
  fx.appendChild(fxRing);
  fx.appendChild(fxBody);
  fx.appendChild(fxText);
  fx.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    selectTrack('fx');
  });
  selectionRings.fx = fxRing;
  lumpEls.fx = fx;
  space.appendChild(fx);

  buildMeltPillar();

  // the bubble-letter "M" THROW-UP = play button (drawn last so it floats
  // on top of the ring)
  const sun = el('g', { class: 'sun' });
  sunHazeEl = el('circle', { class: 'sun-haze', cx: CX, cy: CY + 2, r: 42, fill: 'url(#core-haze)', opacity: 0.75 });
  sun.appendChild(sunHazeEl);
  // shockwave ring that expands on every kick — the sidechain, visualized
  burstEl = el('circle', { class: 'sun-burst', cx: CX, cy: CY, r: 17, stroke: '#ffffff', 'stroke-width': 1, fill: 'none', opacity: 0 });
  sun.appendChild(burstEl);

  // the letter itself: a fat outer outline + an inner echo line (the classic
  // hollow double stroke of a throw-up), both re-pathed every frame from
  // slow hand-wobble sines (see animate); only these deform — the play
  // controls below stay perfectly still so the tap target never moves.
  const coreWrap = el('g', { class: 'core-wrap' });
  coreBlobEl = el('path', { d: '', fill: 'none', stroke: 'rgba(240,234,246,0.85)', 'stroke-width': 1.2, 'stroke-linejoin': 'round', filter: 'url(#glow)' });
  coreInnerEl = el('path', { d: '', fill: 'url(#core-haze)', 'fill-opacity': 0.3, stroke: 'var(--accent)', 'stroke-width': 0.7, opacity: 0.75 });
  coreWrap.appendChild(coreInnerEl);
  coreWrap.appendChild(coreBlobEl);
  sun.appendChild(coreWrap);

  // paint-runs hanging and falling off the letter's lower edge (JS-driven)
  coreDripsG = el('g');
  sun.appendChild(coreDripsG);

  // play control: loading arc + stroked glyph, sitting in the M's window
  sun.appendChild(el('circle', { class: 'sun-load', cx: CX, cy: CY, r: 16.5, stroke: '#ffffff', 'stroke-width': 1.3, fill: 'none', 'stroke-dasharray': '26 78', 'stroke-linecap': 'round', filter: 'url(#glow)' }));
  sunIcon = el('path', { class: 'sun-icon', d: playPath(), fill: 'none', stroke: '#ffffff', 'stroke-width': 1.4, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)' });
  sun.appendChild(sunIcon);
  // an invisible, always-round hit target on top of everything
  const hit = el('circle', { cx: CX, cy: CY, r: 25, fill: 'transparent' });
  sun.appendChild(hit);
  sun.classList.add('loading');
  sunEl = sun;
  sun.addEventListener('pointerdown', togglePlay);
  space.appendChild(sun);

  buildCoreDrips();
  refreshOverview();
}

// compact glyphs, sized to sit inside the M's central window
function playPath() {
  return `M${CX - 2.8} ${CY - 4.2} L${CX + 4.8} ${CY} L${CX - 2.8} ${CY + 4.2} Z`;
}

// two slim bars while playing — tap to stop
function stopPath() {
  return `M${CX - 2.4} ${CY - 4} L${CX - 2.4} ${CY + 4} M${CX + 2.4} ${CY - 4} L${CX + 2.4} ${CY + 4}`;
}

// ---- the central M: hand wobble, kick bulge, slumping with MELT ----

function corePoints(t) {
  const pts = [];
  const breathe = playing ? 0.05 * Math.sin(t / 430) : 0.024 * Math.sin(t / 1500);
  const s = 1 + breathe + kickEnv * 0.13;
  for (let i = 0; i < M_PTS.length; i++) {
    const [bx, by] = M_PTS[i];
    const x = bx * s
      + 0.9 * Math.sin(t / 560 + i * 1.9)
      + melt * 0.8 * Math.sin(t / 300 + i * 2.7);
    let y = by * s
      + 0.9 * Math.sin(t / 700 + i * 2.6);
    // the letter slumps: everything below the waist drags down with MELT —
    // at 100% the M hangs like wet paint
    if (by > 0) {
      const down = by / 14;
      y += down * down * (1.4 + melt * 11 + kickEnv * 1.6);
    }
    pts.push({ x: CX + x, y: CY + y });
  }
  return pts;
}

// ---- paint-runs off the M: threads of light that stretch down from the
// letter's lower edge, snap, and fall as glowing beads ----

const drips = [];

function buildCoreDrips() {
  for (let i = 0; i < 3; i++) {
    const thread = el('line', { stroke: 'var(--accent2)', 'stroke-width': 0.7, 'stroke-linecap': 'round', opacity: 0 });
    const bead = el('circle', { r: 1.2, fill: 'var(--accent)', filter: 'url(#glow)', opacity: 0 });
    coreDripsG.appendChild(thread);
    coreDripsG.appendChild(bead);
    drips.push({ thread, bead, state: 'idle', wait: 1 + Math.random() * 4, x: 0, y0: 0, len: 0, y: 0, vy: 0, max: 8 });
  }
}

function stepDrips(dt) {
  const speedUp = 1 + (playing ? 1.2 : 0) + melt * 2.6;
  for (const d of drips) {
    if (d.state === 'idle') {
      d.wait -= dt * speedUp;
      d.thread.setAttribute('opacity', 0);
      d.bead.setAttribute('opacity', 0);
      if (d.wait <= 0) {
        d.state = 'forming';
        // spawn anywhere along the M's lower edge — the feet hang lower
        // than the middle V, and the whole edge sinks as MELT rises
        d.x = CX + (Math.random() - 0.5) * 34;
        d.y0 = CY + 10 + melt * 10 + Math.abs(d.x - CX) * 0.22;
        d.len = 0;
        d.max = 6 + Math.random() * 7 + melt * 6;
      }
    } else if (d.state === 'forming') {
      d.len += dt * (9 + melt * 18);
      d.thread.setAttribute('x1', d.x.toFixed(1));
      d.thread.setAttribute('y1', d.y0.toFixed(1));
      d.thread.setAttribute('x2', d.x.toFixed(1));
      d.thread.setAttribute('y2', (d.y0 + d.len).toFixed(1));
      d.thread.setAttribute('opacity', 0.7);
      d.bead.setAttribute('cx', d.x.toFixed(1));
      d.bead.setAttribute('cy', (d.y0 + d.len).toFixed(1));
      d.bead.setAttribute('opacity', 0.85);
      if (d.len >= d.max) {
        d.state = 'falling';
        d.y = d.y0 + d.len;
        d.vy = 12;
      }
    } else {
      // falling: the bead detaches and drops, fading into the dark
      d.vy += 130 * dt;
      d.y += d.vy * dt;
      const fall = (d.y - d.y0 - d.max) / 46;
      d.thread.setAttribute('opacity', Math.max(0, 0.5 - fall * 1.6).toFixed(2));
      d.bead.setAttribute('cy', d.y.toFixed(1));
      d.bead.setAttribute('opacity', Math.max(0, 0.85 - fall).toFixed(2));
      if (fall >= 1) {
        d.state = 'idle';
        d.wait = 0.8 + Math.random() * 4;
      }
    }
  }
}

// ---- MELT: the melting tag, top-left — four hand-tagged letters "MELT"
// that shear, stretch and bleed paint-runs as you drag DOWN over them,
// unreadable sludge at 100% ----

let meltGroup = null;
let meltValueEl = null;
const meltLetters = []; // per letter: { g, x } (transform-deformed in setMelt)
const meltLetterDrips = []; // per letter: { thread, bead }
const meltSlider = document.getElementById('melt-slider');

// one-stroke tag letters M E L T, each centred on its own x (8px tall)
const TAG_LETTERS = [
  { d: 'M -3 4 L -3 -4 L 0 0.5 L 3 -4 L 3 4', x: -13.5 },
  { d: 'M 3 -4 L -2.5 -4 L -2.5 4 L 3 4 M -2.5 0 L 2 0', x: -4.5 },
  { d: 'M -2.5 -4 L -2.5 4 L 3 4', x: 4 },
  { d: 'M -3 -4 L 3 -4 M 0 -4 L 0 4', x: 12.5 },
];

// how hard each letter shears (deg), stretches and drops at full melt —
// uneven on purpose, so the word collapses like paint, not like a transform
const TAG_SHEAR = [34, 48, 30, 44];
const TAG_DROP = [3, 5.5, 4, 7];

function buildMeltPillar() {
  const g = el('g', { class: 'meltctl', transform: 'translate(36 26)' });
  meltGroup = g;
  const hit = el('rect', { x: -22, y: -14, width: 44, height: 52, fill: 'transparent' });
  g.appendChild(hit);

  const throb = el('g', { class: 'melt-throb' });
  for (const L of TAG_LETTERS) {
    const lg = el('g', { transform: `translate(${L.x} 0)` });
    lg.appendChild(el('path', { d: L.d, fill: 'none', stroke: 'var(--light)', 'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', filter: 'url(#glow)' }));
    throb.appendChild(lg);
    meltLetters.push({ g: lg, x: L.x });
    // a paint-run threading off this letter's base
    const thread = el('line', { x1: L.x, y1: 5, x2: L.x, y2: 5, stroke: 'var(--accent2)', 'stroke-width': 0.6, 'stroke-linecap': 'round', opacity: 0 });
    const bead = el('circle', { cx: L.x, cy: 5, r: 0.8, fill: 'var(--accent)', filter: 'url(#glow)', opacity: 0 });
    throb.appendChild(thread);
    throb.appendChild(bead);
    meltLetterDrips.push({ thread, bead });
  }
  g.appendChild(throb);

  meltValueEl = el('text', { y: 30, 'text-anchor': 'middle', class: 'melt-value' });
  meltValueEl.textContent = '0%';
  g.appendChild(meltValueEl);

  g.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      g.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const start = melt;
    // dragging DOWN melts the tag (dissolution pulls everything down)
    const onMove = (ev) => setMelt(start + (ev.clientY - startY) / 130);
    const onUp = () => {
      g.removeEventListener('pointermove', onMove);
      g.removeEventListener('pointerup', onUp);
    };
    g.addEventListener('pointermove', onMove);
    g.addEventListener('pointerup', onUp);
  });
  space.appendChild(g);
}

function setMelt(value) {
  melt = Math.min(1, Math.max(0, value));
  send({ type: 'melt', value: melt });
  meltValueEl.textContent = `${Math.round(melt * 100)}%`;
  // each letter shears sideways, stretches downward and sinks — by 100%
  // the word is a smear of strokes with paint-runs threading off it
  for (const [i, L] of meltLetters.entries()) {
    const sk = melt * TAG_SHEAR[i];
    const sy = 1 + melt * (1.3 + 0.3 * i);
    const dy = melt * TAG_DROP[i];
    L.g.setAttribute('transform',
      `translate(${L.x} ${dy.toFixed(1)}) skewY(${sk.toFixed(1)}) scale(1 ${sy.toFixed(2)})`);
    const d = meltLetterDrips[i];
    const bx = L.x + melt * 2.2;
    const y0 = dy + 4 * sy + 1; // just under the stretched letter's base
    const len = melt * (6 + i * 2.2);
    d.thread.setAttribute('x1', bx.toFixed(1));
    d.thread.setAttribute('x2', bx.toFixed(1));
    d.thread.setAttribute('y1', y0.toFixed(1));
    d.thread.setAttribute('y2', (y0 + len).toFixed(1));
    d.thread.setAttribute('opacity', melt > 0.05 ? 0.65 : 0);
    d.bead.setAttribute('cx', bx.toFixed(1));
    d.bead.setAttribute('cy', (y0 + len).toFixed(1));
    d.bead.setAttribute('opacity', melt > 0.05 ? 0.8 : 0);
  }
  // the readout goes toxic as dissolution rises
  meltValueEl.style.fill = melt > 0.001 ? 'var(--accent-bright)' : 'var(--dim)';
  if (meltSlider) meltSlider.value = melt;
  // wall paint-runs multiply and quicken
  for (const [i, s] of meltStreaks.entries()) {
    s.setAttribute('opacity', Math.max(0, (melt - 0.12 * i) * 0.55).toFixed(2));
  }
  cometA.style.animationDuration = `${(9 / (1 + melt * 1.6)).toFixed(2)}s`;
  cometB.style.animationDuration = `${(14 / (1 + melt * 1.6)).toFixed(2)}s`;
}

// ---- overview: light the spray splats to match the pattern ----

function nodeState(i) {
  if (toggles.acid[i]) return acidAcc[i] ? 'acc' : 'acid';
  if (toggles.kick[i] || toggles.hatC[i] || toggles.hatO[i] || toggles.clap[i]) return 'on';
  return 'off';
}

function setNode(i) {
  const { g, core, tail, crown, scaleWrap } = ringNodes[i];
  const depth = parseFloat(g.dataset.depth);
  const baseR = 2.2 + 1.4 * depth;
  const st = nodeState(i);
  if (st === 'off') {
    core.setAttribute('fill', 'none');
    core.setAttribute('stroke', 'rgba(240,234,246,0.4)');
    core.setAttribute('stroke-width', 0.7);
    scaleWrap.setAttribute('transform', 'scale(1)');
    crown.setAttribute('opacity', 0);
    tail.setAttribute('opacity', 0);
    g.style.opacity = 0.6;
  } else {
    // lit = the splat glows violet and hangs a paint-run; an accented acid
    // step blazes a size bigger and wears the crown
    const acc = st === 'acc';
    core.setAttribute('fill', acc ? 'url(#node-acc)' : 'url(#node-violet)');
    core.setAttribute('stroke', acc ? 'var(--accent2)' : 'var(--accent)');
    core.setAttribute('stroke-width', acc ? 1.1 : 0.9);
    scaleWrap.setAttribute('transform', acc ? 'scale(1.5)' : 'scale(1.15)');
    crown.setAttribute('opacity', acc ? 0.95 : 0);
    const tl = acc ? 9 : 6;
    tail.setAttribute('d', `M 0 ${(baseR * 0.9).toFixed(1)} Q 0.6 ${(baseR + tl * 0.45).toFixed(1)} 0.1 ${(baseR + tl).toFixed(1)}`);
    tail.setAttribute('opacity', acc ? 0.85 : 0.6);
    g.style.opacity = 1;
  }
  // slide streak: paint that ran along the wall from the previous splat to
  // this one, sagging under gravity, whenever the step slides
  const th = slideThreads[i];
  if (toggles.acid[i] && acidSlide[i]) {
    const a = nodePos[(i - 1 + STEPS) % STEPS];
    const b = nodePos[i];
    const mx = (a.x + b.x) / 2 + 0.8;
    const my = (a.y + b.y) / 2 + 6; // the run bellies downward
    th.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`);
    th.setAttribute('opacity', 0.55);
  } else {
    th.setAttribute('opacity', 0);
  }
}

function refreshOverview() {
  for (let i = 0; i < STEPS; i++) setNode(i);
}

// ---- track selection ----

function selectTrack(track) {
  for (const [key, ring] of Object.entries(selectionRings)) {
    ring.setAttribute('opacity', key === track ? 1 : 0);
  }
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${track}`);
  });
  document.getElementById('editor').classList.add('open');
  document.body.classList.add('editor-open'); // hides the bottom bars under the sheet
}

document.querySelectorAll('.close-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.getElementById('editor').classList.remove('open');
    document.body.classList.remove('editor-open');
    for (const ring of Object.values(selectionRings)) ring.setAttribute('opacity', 0);
  });
});

// ---- transport ----

async function togglePlay() {
  // flip the UI instantly — audio setup catches up in the background
  playing = !playing;
  sunIcon.setAttribute('d', playing ? stopPath() : playPath());
  if (playing) {
    lastStep = -1;
    playheadG.style.opacity = 0.95;
  } else {
    parkPlayhead();
    clearEditorPlayhead();
  }
  await ensureAudio();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  send({ type: playing ? 'play' : 'stop' });
}

const bpmValue = document.getElementById('bpm-value');
function setBpm(value) {
  bpm = Math.min(190, Math.max(60, value));
  bpmValue.textContent = bpm;
  send({ type: 'bpm', value: bpm });
}
// tap steps once; holding repeats after a beat, for fast sweeps
function bindHold(btn, step) {
  let delay = null;
  let repeat = null;
  const start = (e) => {
    e.preventDefault();
    step();
    delay = setTimeout(() => {
      repeat = setInterval(step, 65);
    }, 400);
  };
  const end = () => {
    clearTimeout(delay);
    clearInterval(repeat);
  };
  btn.addEventListener('pointerdown', start);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
    btn.addEventListener(ev, end);
  }
}
bindHold(document.getElementById('bpm-up'), () => setBpm(bpm + 1));
bindHold(document.getElementById('bpm-down'), () => setBpm(bpm - 1));

const masterVol = document.getElementById('master-vol');
masterVol.addEventListener('input', () => {
  send({ type: 'master', value: parseFloat(masterVol.value) });
});

// ---- playhead ----

const editorRows = ['kick', 'hatC', 'hatO', 'clap', 'acid'];
let lastStep = -1;
let lastDeg = 0;

function movePlayhead(index) {
  const p = nodePos[index];
  // face the direction of travel; unwrap the angle so the drop turns the
  // short way at the loop instead of spinning backwards
  let deg = headingAt(index);
  while (deg - lastDeg > 180) deg -= 360;
  while (deg - lastDeg < -180) deg += 360;
  lastDeg = deg;
  const to = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${deg.toFixed(1)}deg)`;
  // travel smoothly node to node, but snap on the loop wrap
  if (index <= lastStep) {
    playheadG.style.transition = 'none';
    playheadG.style.transform = to;
    requestAnimationFrame(() => {
      playheadG.style.transition = 'transform 90ms linear';
    });
  } else {
    playheadG.style.transition = 'transform 90ms linear';
    playheadG.style.transform = to;
  }
  lastStep = index;

  // the can passes a LIT splat: SPRAY BURST — mist puffs out, a ripple
  // ring blooms, and the splat stretches for an instant
  if (nodeState(index) !== 'off') fireSplash(index, p);

  pulse('kick', toggles.kick[index]);
  pulse('hat', toggles.hatC[index] || toggles.hatO[index]);
  pulse('clap', toggles.clap[index]);
  pulse('acid', toggles.acid[index]);

  for (const track of editorRows) {
    const cells = document.getElementById(`steps-${track}`).children;
    for (let i = 0; i < cells.length; i++) {
      cells[i].classList.toggle('playhead', i === index);
    }
  }
}

function pulse(track, active) {
  if (!active) return;
  const body = lumpEls[track].querySelector('.planet-scale') || lumpEls[track].querySelector('.planet-body');
  body.classList.remove('hit');
  void body.getBoundingClientRect(); // restart the animation
  body.classList.add('hit');
  if (track === 'kick') {
    kickEnv = 1; // the M bulges with the kick (decays in the rAF loop)
    burstEl.classList.remove('go');
    void burstEl.getBoundingClientRect();
    burstEl.classList.add('go');
  }
}

function fireSplash(index, p) {
  splashG.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  // throw the mist at a fresh angle every burst
  splashDrops.style.transform = `rotate(${(Math.random() * 360).toFixed(0)}deg)`;
  splashG.classList.remove('go');
  void splashG.getBoundingClientRect(); // restart the animations
  splashG.classList.add('go');
  // the struck splat stretches — びよん
  const g = ringNodes[index].g;
  g.classList.remove('boing');
  void g.getBoundingClientRect();
  g.classList.add('boing');
}

// ---- ambient motion: the wobbling M, paint-runs, drifting mist, ring waves ----

let lastFrame = 0;

function animate(t) {
  // clamp dt so returning from a hidden tab doesn't jump the scene
  const dt = Math.min(lastFrame ? (t - lastFrame) / 1000 : 0, 0.1);
  lastFrame = t;

  kickEnv = Math.max(0, kickEnv - dt * 6);

  // the M's hand-drawn outline wobbles — re-pathed every frame (the only
  // per-frame path regeneration in the scene, along with its drips)
  const pts = corePoints(t);
  coreBlobEl.setAttribute('d', blobPath(pts));
  // the inner echo line of the throw-up: same letter, shrunk toward the
  // (slumped) centroid
  let mx = 0;
  let my = 0;
  for (const q of pts) {
    mx += q.x;
    my += q.y;
  }
  mx /= pts.length;
  my /= pts.length;
  coreInnerEl.setAttribute('d', blobPath(pts.map((q) => ({
    x: mx + (q.x - mx) * 0.78,
    y: my + (q.y - my) * 0.78,
  }))));
  // the halo breathes; at high MELT the glow itself wavers
  const flicker = melt * 0.14 * Math.sin(t / 90) * Math.sin(t / 37);
  sunHazeEl.setAttribute('opacity', (0.75 + kickEnv * 0.2 + flicker).toFixed(3));
  sunHazeEl.style.transform = `scale(${(1 + 0.055 * Math.sin(t / 1700) + kickEnv * 0.08).toFixed(4)})`;

  stepDrips(dt);

  // the splat ring undulates as the world melts
  if (melt > 0.01) {
    const wob = melt * 0.035;
    ringG.style.transform = `translate(0px, ${(melt * 2.5 * Math.sin(t / 640)).toFixed(2)}px) `
      + `scale(${(1 + wob * Math.sin(t / 430)).toFixed(4)}, ${(1 + wob * 1.4 * Math.sin(t / 310 + 1.2)).toFixed(4)})`;
  } else {
    ringG.style.transform = '';
  }

  // mist particles wander freely; dissolution stirs them up
  const dotAmp = 1 + melt * 1.4;
  for (const m of dotMeta) {
    const ts = t / 1000;
    m.el.setAttribute('cx', (m.bx + m.ax * dotAmp * Math.sin(ts * m.w + m.ph)).toFixed(2));
    m.el.setAttribute('cy', (m.by + m.ay * dotAmp * Math.cos(ts * m.w * 0.8 + m.ph * 1.7)).toFixed(2));
  }

  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

// film grain flicker: reseed the noise a few times a second
const grainTurb = document.querySelector('.grain-overlay feTurbulence');
if (grainTurb) {
  setInterval(() => grainTurb.setAttribute('seed', (Math.random() * 1000) | 0), 100);
}

function clearEditorPlayhead() {
  document.querySelectorAll('.step.playhead').forEach((c) => c.classList.remove('playhead'));
}

// ---- editor: toggle rows (kick, hats, clap) ----

const rowButtons = { kick: [], hatC: [], hatO: [], clap: [] };

function buildToggleRow(track) {
  const container = document.getElementById(`steps-${track}`);
  for (let i = 0; i < STEPS; i++) {
    const btn = document.createElement('button');
    btn.className = 'step' + (toggles[track][i] ? ' on' : '');
    btn.addEventListener('click', () => {
      toggles[track][i] = toggles[track][i] ? 0 : 1;
      btn.classList.toggle('on');
      send({ type: 'steps', track, steps: toggles[track] });
      refreshOverview();
    });
    container.appendChild(btn);
    rowButtons[track].push(btn);
  }
}

function refreshToggleRow(track) {
  rowButtons[track].forEach((btn, i) => btn.classList.toggle('on', !!toggles[track][i]));
}

// ---- editor: acid row (click toggles, vertical drag edits pitch) ----
// Notes are semitone offsets (-12..+12) from the ROOT slider; the label shows
// the resulting absolute note name (root 0..11 = C1..B1, so root 9 = A1).

const rootInput = document.querySelector('#panel-acid input[data-param="root"]');

function noteName(offset) {
  const v = parseInt(rootInput.value, 10) + offset; // semitones above C1
  const idx = ((v % 12) + 12) % 12;
  const oct = 1 + Math.floor(v / 12);
  return NOTE_NAMES[idx] + oct;
}

function buildAcidRow() {
  const container = document.getElementById('steps-acid');
  for (let i = 0; i < STEPS; i++) {
    const btn = document.createElement('button');
    btn.className = 'step acid-step';
    const label = document.createElement('span');
    label.className = 'note';
    btn.appendChild(label);
    container.appendChild(btn);
    renderAcidStep(i);

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {}
      const startY = e.clientY;
      const startNote = acidNotes[i];
      let dragged = false;

      const onMove = (ev) => {
        const delta = Math.round((startY - ev.clientY) / 8);
        if (delta !== 0) dragged = true;
        const note = Math.min(12, Math.max(-12, startNote + delta));
        if (note !== acidNotes[i]) {
          acidNotes[i] = note;
          if (!toggles.acid[i]) {
            toggles.acid[i] = 1;
            send({ type: 'steps', track: 'acid', steps: toggles.acid });
          }
          renderAcidStep(i);
          send({ type: 'acidNotes', notes: acidNotes });
          refreshOverview();
        }
      };
      const onUp = () => {
        btn.removeEventListener('pointermove', onMove);
        btn.removeEventListener('pointerup', onUp);
        if (!dragged) {
          toggles.acid[i] = toggles.acid[i] ? 0 : 1;
          renderAcidStep(i);
          send({ type: 'steps', track: 'acid', steps: toggles.acid });
          refreshOverview();
        }
      };
      btn.addEventListener('pointermove', onMove);
      btn.addEventListener('pointerup', onUp);
    });
  }
}

function renderAcidStep(i) {
  const btn = document.getElementById('steps-acid').children[i];
  btn.classList.toggle('on', !!toggles.acid[i]);
  btn.querySelector('.note').textContent = noteName(acidNotes[i]);
}

function refreshAcidUI() {
  for (let i = 0; i < STEPS; i++) renderAcidStep(i);
  refreshDotRow('acc');
  refreshDotRow('slide');
}

// moving ROOT retunes every step label
rootInput.addEventListener('input', refreshAcidUI);

// ---- editor: ACC / SLIDE dot rows (lit-pill toggles, galaxy BASS lineage) ----

const dotButtons = { acc: [], slide: [] };
const dotArrays = { acc: acidAcc, slide: acidSlide };

function sendDotRow(kind) {
  if (kind === 'acc') send({ type: 'acidAcc', flags: acidAcc });
  else send({ type: 'acidSlide', flags: acidSlide });
}

function buildDotRow(kind) {
  const container = document.getElementById(`dots-${kind}`);
  const arr = dotArrays[kind];
  for (let i = 0; i < STEPS; i++) {
    const btn = document.createElement('button');
    btn.className = 'step' + (arr[i] ? ' on' : '');
    btn.addEventListener('click', () => {
      arr[i] = arr[i] ? 0 : 1;
      btn.classList.toggle('on');
      sendDotRow(kind);
      refreshOverview();
    });
    container.appendChild(btn);
    dotButtons[kind].push(btn);
  }
}

function refreshDotRow(kind) {
  const arr = dotArrays[kind];
  dotButtons[kind].forEach((btn, i) => btn.classList.toggle('on', !!arr[i]));
}

// ---- GEN: pattern generators (four-on-the-floor acid) ----

const ri = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[ri(arr.length)];

function regenerate(track) {
  if (track === 'kick') {
    // four on the floor, with an occasional pushed extra
    toggles.kick = Array.from({ length: STEPS }, (_, i) => (i % 4 === 0 ? 1 : 0));
    if (Math.random() < 0.3) toggles.kick[pick([7, 10, 14])] = 1;
    send({ type: 'steps', track: 'kick', steps: toggles.kick });
    refreshToggleRow('kick');
  } else if (track === 'hat') {
    toggles.hatO = Array.from({ length: STEPS }, (_, i) =>
      (i % 4 === 2 && Math.random() < 0.85 ? 1 : 0));
    toggles.hatC = euclid(9 + ri(7), STEPS);
    for (let i = 0; i < STEPS; i++) {
      if (toggles.hatO[i]) toggles.hatC[i] = 0; // open takes the slot
    }
    send({ type: 'steps', track: 'hatC', steps: toggles.hatC });
    send({ type: 'steps', track: 'hatO', steps: toggles.hatO });
    refreshToggleRow('hatC');
    refreshToggleRow('hatO');
  } else if (track === 'clap') {
    toggles.clap = Array.from({ length: STEPS }, () => 0);
    toggles.clap[4] = 1;
    toggles.clap[12] = 1;
    if (Math.random() < 0.3) toggles.clap[pick([7, 11, 15])] = 1;
    send({ type: 'steps', track: 'clap', steps: toggles.clap });
    refreshToggleRow('clap');
  } else if (track === 'acid') {
    // a rolling 303 line: dense euclid, acid-flavoured intervals, a few
    // accents to spit and slides to smear
    toggles.acid = euclid(7 + ri(5), STEPS, ri(3));
    toggles.acid[0] = 1; // anchored on the one
    const OFFSETS = [-12, -5, -2, 0, 0, 0, 0, 3, 5, 7, 10, 12, 12];
    for (let i = 0; i < STEPS; i++) {
      acidNotes[i] = toggles.acid[i] ? pick(OFFSETS) : 0;
      acidAcc[i] = toggles.acid[i] && Math.random() < 0.25 ? 1 : 0;
      acidSlide[i] = toggles.acid[i] && Math.random() < 0.25 ? 1 : 0;
    }
    send({ type: 'steps', track: 'acid', steps: toggles.acid });
    sendAcidRows();
    refreshAcidUI();
  }
  refreshOverview();
}

document.querySelectorAll('.gen-btn').forEach((btn) => {
  btn.addEventListener('click', () => regenerate(btn.dataset.gen));
});

// jump straight to a layer's editor — no need to chase a drifting lump
document.querySelectorAll('.jump-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    selectTrack(btn.dataset.jump);
  });
});

// ---- MELT slider (mirrors the melting-tag drag) ----

if (meltSlider) {
  meltSlider.addEventListener('input', () => setMelt(parseFloat(meltSlider.value)));
}

// ---- pattern slots & persistence ----
// Four independent workspaces (steps + acid rows + voice params + fx).
// Switching slots auto-saves the old one; everything persists to
// localStorage, so a reload or app restart comes back where you left off.

const SLOT_COUNT = 4;
const STORAGE_KEY = 'minima-melt-v1';
let activeSlot = 0;
let saveTimer = null;

function collectParams() {
  const params = {};
  document.querySelectorAll('.params input[data-param]').forEach((input) => {
    const track = input.closest('.track').dataset.track;
    (params[track] ??= {})[input.dataset.param] = input.value;
  });
  return params;
}

function snapshotSlot() {
  return {
    toggles: JSON.parse(JSON.stringify(toggles)),
    acidNotes: acidNotes.slice(),
    acidAcc: acidAcc.slice(),
    acidSlide: acidSlide.slice(),
    params: collectParams(),
  };
}

let slots = Array.from({ length: SLOT_COUNT }, snapshotSlot);

function applySlot(slot) {
  for (const key of Object.keys(toggles)) {
    toggles[key] = slot.toggles[key].slice();
    send({ type: 'steps', track: key, steps: toggles[key] });
    if (rowButtons[key]) refreshToggleRow(key);
  }
  const notes = Array.isArray(slot.acidNotes) ? slot.acidNotes : [];
  const accs = Array.isArray(slot.acidAcc) ? slot.acidAcc : [];
  const slides = Array.isArray(slot.acidSlide) ? slot.acidSlide : [];
  for (let i = 0; i < STEPS; i++) {
    acidNotes[i] = notes[i] | 0;
    acidAcc[i] = accs[i] ? 1 : 0;
    acidSlide[i] = slides[i] ? 1 : 0;
  }
  sendAcidRows();
  for (const [track, ps] of Object.entries(slot.params)) {
    for (const [name, value] of Object.entries(ps)) {
      const input = document.querySelector(`#panel-${track} input[data-param="${name}"]`);
      if (input) {
        input.value = value;
        sendParam(input);
      }
    }
  }
  refreshAcidUI();
  refreshOverview();
}

function persist() {
  slots[activeSlot] = snapshotSlot();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: activeSlot,
      bpm,
      master: parseFloat(masterVol.value),
      melt,
      slots,
    }));
  } catch {}
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 400);
}

function switchSlot(n) {
  if (n === activeSlot) return;
  slots[activeSlot] = snapshotSlot();
  activeSlot = n;
  applySlot(slots[n]);
  document.querySelectorAll('.ptn-btn').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.ptn) === n);
  });
  persist();
}

document.querySelectorAll('.ptn-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    switchSlot(Number(btn.dataset.ptn));
  });
});

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.slots) && data.slots.length === SLOT_COUNT) slots = data.slots;
    activeSlot = Math.min(SLOT_COUNT - 1, Math.max(0, data.active | 0));
    if (data.bpm) setBpm(data.bpm);
    if (data.master != null) masterVol.value = data.master;
    if (data.melt != null) setMelt(data.melt);
    applySlot(slots[activeSlot]);
    document.querySelectorAll('.ptn-btn').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.ptn) === activeSlot);
    });
  } catch (err) {
    console.error(`restore failed: ${err.message}`);
  }
}

// ---- mute toggles: tap to silence a layer, tap again to bring it back ----

const muteState = { kick: false, hat: false, clap: false, acid: false };

function setMute(track, value) {
  muteState[track] = value;
  send({ type: 'mute', track, value });
  // every button for this track shows the same state (space bar + panel)
  document.querySelectorAll(`.mute-btn[data-mute="${track}"]`).forEach((b) => {
    b.classList.toggle('muting', value);
  });
  // the layer's lump sinks into the dark while muted
  lumpEls[track].style.opacity = value ? 0.18 : '';
}

document.querySelectorAll('.mute-btn').forEach((btn) => {
  const track = btn.dataset.mute;
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setMute(track, !muteState[track]);
  });
});

// ---- parameter sliders ----

function sendParam(input) {
  const track = input.closest('.track').dataset.track;
  const value = parseFloat(input.value);
  if (track === 'fx') {
    send({ type: 'fx', name: input.dataset.param, value });
  } else {
    send({ type: 'param', track, name: input.dataset.param, value });
  }
}

document.querySelectorAll('.params input[data-param]').forEach((input) => {
  input.addEventListener('input', () => sendParam(input));
});

// ---- init ----

buildScene();
buildToggleRow('kick');
buildToggleRow('hatC');
buildToggleRow('hatO');
buildToggleRow('clap');
buildAcidRow();
buildDotRow('acc');
buildDotRow('slide');
restore(); // bring back saved patterns before anything is heard
selectTrack('kick');
// start closed on mobile
document.getElementById('editor').classList.remove('open');
document.body.classList.remove('editor-open');

// Load the engine eagerly. In Electron there is no autoplay restriction; in a
// browser the context starts suspended and is resumed by the play button.
ensureAudio()
  .then(() => console.log('audio engine ready'))
  .catch((err) => console.error(`audio engine failed to load: ${err.message}`))
  .finally(() => sunEl.classList.remove('loading'));
