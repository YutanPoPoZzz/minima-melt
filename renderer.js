// minima melt — UI thread. Third-generation art direction: the GRAVITY
// CASCADE. The whole screen is one melting space, read top to bottom, ruled
// by a single force — gravity — and one material physics: high-viscosity
// liquid (stretch, neck, tear, wobble back; honey time constants
// everywhere).
//
//   top    = the MASS: a huge sheet of molten goo hanging from the top of
//            the screen, full width, its top running off-frame. Its lower
//            edge is an uneven chain of heavy lobes, always slowly rolling.
//            = play/stop toggle (pointerdown, class `sun`). While playing
//            it pulses; every kick shudders the whole mass and sends a
//            ripple across the pool below.
//   middle = 16 DRIP POINTS spaced along the mass's lower edge = the 16
//            steps. No strands: each is a nipple on the edge itself.
//            Unlit: a barely-there swelling. Lit: a heavy violet-glowing
//            drop bulges straight out of the edge (each its own random
//            size and droop). An accented acid step hangs a fatter,
//            brighter drop from an engorged root; a slide step is bridged
//            to its neighbour by a sagging film of goo — a liquid bridge.
//   playhead = a VISCOUS GLOB crawling left to right inside the lower edge
//            (the edge swells around it), pulling a thread from its last
//            position that stretches, necks and snaps — then the glob
//            wobbles back into shape. Passing a lit drip point it squeezes
//            that drop off: it falls, lands heavy, and the pool answers
//            with a slow, syrupy ripple. Stopped, the glob rests dim at
//            step 0's drip point.
//   bottom = the POOL of molten paint, full width = the MELT macro. A low-
//            frequency luminous surface line; drag it up and down to set the
//            level = melt %. High MELT: the mass slumps toward centre
//            screen, the drops run fat and long, the pool seethes with
//            bubbles, the glow wavers.
//   margins = four LAB VESSELS shelved at their own heights (never
//            floating): KICK = an Erlenmeyer flask, HATS = two test tubes
//            in a rack, CLAP = a beaker, ACID = a dropper with a drop at
//            its tip — each holding a violet-glowing liquid (surface line +
//            micro bubbles), each bleeding a thin overflow all the way down
//            into the pool. Tap to edit; muting quenches the liquid's glow
//            and its run stops.
//
// Owns the AudioContext and messages the melt engine in the AudioWorklet.

const STEPS = 16;
const NS = 'http://www.w3.org/2000/svg';

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
    // a step message can already be in flight when stop is pressed — letting
    // it through would repaint the playhead after parkPlayhead cleared it
    if (e.data.type === 'step' && playing) movePlayhead(e.data.index);
  };
  pushAllState();
}

// =====================================================================
// THE GRAVITY CASCADE WALL — scene geometry
// =====================================================================

const W = 320;
const H = 260;
const DRIP_X0 = 48; // the 16 drip points along the mass's lower edge
const DRIP_DX = (272 - DRIP_X0) / (STEPS - 1);
const POOL_BASE = 233; // pool surface at melt = 0
const POOL_RANGE = 31; // how far the level rises by melt = 1

const space = document.getElementById('space');

function el(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// deterministic per-index jitter, so the wall lays out the same every load
function hash01(n) {
  const s = Math.sin(n * 91.7 + 4.3) * 47453.5;
  return s - Math.floor(s);
}

// closed Catmull-Rom loop -> cubic Bezier path: the goo outline primitive
function gooPath(pts) {
  const n = pts.length;
  const at = (i) => pts[(i + n) % n];
  let d = `M ${at(0).x.toFixed(2)} ${at(0).y.toFixed(2)}`;
  for (let i = 0; i < n; i++) {
    const a = at(i - 1);
    const b = at(i);
    const c = at(i + 1);
    const e = at(i + 2);
    d += ` C ${(b.x + (c.x - a.x) / 6).toFixed(2)} ${(b.y + (c.y - a.y) / 6).toFixed(2)}`
      + ` ${(c.x - (e.x - b.x) / 6).toFixed(2)} ${(c.y - (e.y - b.y) / 6).toFixed(2)}`
      + ` ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
  }
  return d + ' Z';
}

// open midpoint-smoothed polyline (the pool surface primitive)
function wavePath(x0, dx, ys) {
  let d = `M ${x0} ${ys[0].toFixed(2)}`;
  for (let i = 1; i < ys.length; i++) {
    const px = x0 + dx * (i - 1);
    const mx = x0 + dx * (i - 0.5);
    d += ` Q ${px.toFixed(1)} ${ys[i - 1].toFixed(2)} ${mx.toFixed(1)} ${((ys[i - 1] + ys[i]) / 2).toFixed(2)}`;
  }
  d += ` L ${(x0 + dx * (ys.length - 1)).toFixed(1)} ${ys[ys.length - 1].toFixed(2)}`;
  return d;
}

// ---- the molten mass: a huge sheet of goo hanging from the top edge ----
// One closed outline regenerated every frame: the top runs off-frame, the
// lower edge is an uneven chain of heavy lobes sampled exactly at the 16
// drip points (so every drop hangs from the true edge), plus one filler at
// each margin and two off-screen corners — 20 points total.

const BLOB_EDGE = 62; // resting mean height of the lower edge
const BLOB_OFF = 26; // how far the sheet's sides and top run off-frame

// lower-edge height at x for this frame: static heavy lobes + slow viscous
// wobble + MELT slump (sagging hardest at centre screen) + kick shudder
function blobEdgeBase(x, t) {
  let y = BLOB_EDGE
    + 6.5 * Math.sin(x * 0.03 + 1.6)
    + 4.0 * Math.sin(x * 0.0128 + 4.2)
    + 2.4 * Math.sin(x * 0.069 + 0.7)
    + 2.0 * Math.sin(t / 940 + x * 0.021)
    + 1.0 * Math.sin(t / 520 - x * 0.044);
  if (playing) y += 1.4 * Math.sin(t / 300 + x * 0.05); // unhurried pulse
  const cw = Math.exp(-(((x - 160) / 120) ** 2));
  y += melt * (26 * (0.32 + 0.68 * cw) + 5 * Math.sin(x * 0.052 + t / 680));
  y += kickEnv * 2.4 * Math.sin(t / 26 + x * 0.09);
  return y;
}

// the glob rides inside the edge: the goo swells locally around it
function globBump(x) {
  const g = (x - glob.x) / 11;
  return (glob.parked ? 1.4 : 3.4) * Math.exp(-g * g);
}

// the hanging drop at a drip point: attach point at 0,0, bulb below
const DROP_D = 'M 0 0 C 2.4 2.2 2.9 4.6 0 7.2 C -2.9 4.6 -2.4 2.2 0 0 Z';

// the four lab vessels: white line-art glassware, local unit ~14px tall,
// each holding a violet-glowing liquid (surface line + micro bubbles)
const TAG_ART = {
  // KICK: an Erlenmeyer flask
  kick: {
    glass: [
      'M -1.9 -7.2 L 1.9 -7.2',
      'M -1.4 -6.6 L -1.4 -2.4 L -5.5 5 Q -6.4 6.9 -4.3 6.9 L 4.3 6.9 Q 6.4 6.9 5.5 5 L 1.4 -2.4 L 1.4 -6.6',
    ],
    liquid: ['M -4.1 2.6 Q 0 1.6 4.1 2.6'],
    bubbles: [[-1.6, 4.6, 0.55], [1.3, 3.7, 0.4]],
  },
  // HATS: two test tubes side by side in a rack
  hat: {
    glass: [
      'M -4.9 -6.9 L -1.1 -6.9',
      'M -4.2 -6.5 L -4.2 4.6 Q -4.2 6.7 -3 6.7 Q -1.8 6.7 -1.8 4.6 L -1.8 -6.5',
      'M 1.1 -6.9 L 4.9 -6.9',
      'M 1.8 -6.5 L 1.8 4.6 Q 1.8 6.7 3 6.7 Q 4.2 6.7 4.2 4.6 L 4.2 -6.5',
      'M -5.8 -0.4 L 5.8 -0.4',
    ],
    liquid: ['M -4.2 1.5 Q -3 0.9 -1.8 1.5', 'M 1.8 0.2 Q 3 -0.4 4.2 0.2'],
    bubbles: [[-3, 3.4, 0.4], [3, 2.4, 0.4]],
  },
  // CLAP: a beaker, spout on the left, graduations on the right
  clap: {
    glass: [
      'M -5.6 -7 L -4.4 -6 L -4.4 5.2 Q -4.4 6.8 -2.8 6.8 L 2.8 6.8 Q 4.4 6.8 4.4 5.2 L 4.4 -6 L 5.2 -6.7',
      'M 2.4 -2.4 L 4.4 -2.4',
      'M 2.4 0.6 L 4.4 0.6',
    ],
    liquid: ['M -4.4 2 Q 0 1.1 4.4 2'],
    bubbles: [[-1.8, 4.4, 0.5], [1.4, 3.4, 0.4]],
  },
  // ACID: a dropper, one drop trembling at its tip
  acid: {
    glass: [
      'M -2.4 -4.4 Q -2.4 -7.6 0 -7.6 Q 2.4 -7.6 2.4 -4.4 L 1.8 -3.3 L 1.1 -2.5 L 1.1 3.2 L 0 6.2 L -1.1 3.2 L -1.1 -2.5 L -1.8 -3.3 Z',
    ],
    liquid: ['M -1.1 0.2 L 1.1 0.2', 'M 0 0.6 L 0 4.4'],
    bubbles: [[0, -5.6, 0.45]],
    tipDrop: { y: 6.4, s: 0.6 },
  },
};

// shelved at their own heights in the left/right margins — wall-fixed
const TAG_POS = {
  kick: { x: 20, y: 112, s: 1.05, label: 'KICK' },
  hat: { x: 300, y: 104, s: 0.92, label: 'HATS' },
  clap: { x: 21, y: 166, s: 0.95, label: 'CLAP' },
  acid: { x: 299, y: 158, s: 1.0, label: 'ACID' },
};

// ---- scene state ----

let sunEl = null; // the whole molten mass (class `sun`, play toggle)
let pieceGooEl = null; // goo container (dims while loading)
let pieceHazeEl = null; // luminous wash behind the mass
let blobOuterEl = null; // the mass: luminous fill + white outline, one path
let blobEchoEl = null; // violet echo line tracing just inside the lower edge

const dripsArr = []; // per step: { g, dropWrap, drop, halo, x, szRnd, hang, bulge, sx, sy }
const edgeYs = Array.from({ length: STEPS }, () => BLOB_EDGE); // this frame's lower-edge y at each drip point
const slideFilms = []; // 16 sagging goo films bridging slide steps to their neighbours
const fallDrops = []; // pooled falling droplets (glob strikes)
const ripples = []; // pooled pool-surface ripples
const bubbles = []; // pooled boil bubbles (high MELT)
const impulses = []; // pool surface impacts { x, amp, age }
const mistPts = []; // wall mist particles

const tagEls = {}; // track -> { g, scale, liq, run, runPrefix }
const selectionRings = {};

let meltValueEl = null;
let poolFillEl = null;
let poolLineEl = null;
let poolEchoEl = null;
let poolY = POOL_BASE;
let poolTarget = POOL_BASE;
let kickEnv = 0; // mass shudder on each kick, decays in the rAF loop
let nowT = 0; // last rAF timestamp, for surface queries outside animate

const meltSlider = document.getElementById('melt-slider');

// the viscous glob playhead
const glob = {
  g: null,
  body: null,
  thread: null,
  x: DRIP_X0,
  targetX: DRIP_X0,
  fromX: DRIP_X0,
  threadLife: 0,
  pluck: 0,
  parked: true,
};

// ---- defs: glow filter + luminous gradients (series-standard infra) ----

function buildDefs() {
  const defs = el('defs');

  const glow = el('filter', { id: 'glow', x: '-120%', y: '-120%', width: '340%', height: '340%' });
  glow.appendChild(el('feGaussianBlur', { stdDeviation: 3.2, result: 'b' }));
  const merge = el('feMerge');
  merge.appendChild(el('feMergeNode', { in: 'b' }));
  merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
  glow.appendChild(merge);
  defs.appendChild(glow);

  // wash of light behind the mass
  const pieceHaze = el('radialGradient', { id: 'piece-haze' });
  pieceHaze.appendChild(el('stop', { offset: '0%', 'stop-color': '#efdffb', 'stop-opacity': 0.5 }));
  pieceHaze.appendChild(el('stop', { offset: '60%', 'stop-color': '#b678f2', 'stop-opacity': 0.14 }));
  pieceHaze.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(pieceHaze);

  // the mass's interior: luminous up where it is thick, fading to nothing
  // at the lower edge (userSpace so it stays put while the edge slumps)
  const blobFill = el('linearGradient', {
    id: 'blob-fill', gradientUnits: 'userSpaceOnUse', x1: 0, y1: -20, x2: 0, y2: 96,
  });
  blobFill.appendChild(el('stop', { offset: '0%', 'stop-color': '#e6ccff', 'stop-opacity': 0.5 }));
  blobFill.appendChild(el('stop', { offset: '45%', 'stop-color': '#b678f2', 'stop-opacity': 0.28 }));
  blobFill.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0.12 }));
  defs.appendChild(blobFill);

  // a lit hanging drop: hot core into violet falloff
  const dropLit = el('radialGradient', { id: 'drop-lit' });
  dropLit.appendChild(el('stop', { offset: '0%', 'stop-color': '#f6edff', 'stop-opacity': 1 }));
  dropLit.appendChild(el('stop', { offset: '55%', 'stop-color': '#a34dff', 'stop-opacity': 0.8 }));
  dropLit.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0.05 }));
  defs.appendChild(dropLit);

  // an accented drop blazes whiter
  const dropAcc = el('radialGradient', { id: 'drop-acc' });
  dropAcc.appendChild(el('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 1 }));
  dropAcc.appendChild(el('stop', { offset: '50%', 'stop-color': '#d9b3ff', 'stop-opacity': 0.9 }));
  dropAcc.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0.08 }));
  defs.appendChild(dropAcc);

  // soft violet halo (drop glow, throw-up hearts)
  const halo = el('radialGradient', { id: 'halo' });
  halo.appendChild(el('stop', { offset: '0%', 'stop-color': '#c98aff', 'stop-opacity': 0.55 }));
  halo.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0 }));
  defs.appendChild(halo);

  // the glob: dense white heart, syrupy violet skin
  const globBody = el('radialGradient', { id: 'glob-body' });
  globBody.appendChild(el('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 1 }));
  globBody.appendChild(el('stop', { offset: '45%', 'stop-color': '#efe2ff', 'stop-opacity': 0.9 }));
  globBody.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0.22 }));
  defs.appendChild(globBody);

  // the pool: luminous at the surface, black at depth (userSpace so it
  // tracks the water line's neighbourhood)
  const poolFill = el('linearGradient', {
    id: 'pool-fill', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 196, x2: 0, y2: 262,
  });
  poolFill.appendChild(el('stop', { offset: '0%', 'stop-color': '#d9b3ff', 'stop-opacity': 0.32 }));
  poolFill.appendChild(el('stop', { offset: '30%', 'stop-color': '#a34dff', 'stop-opacity': 0.15 }));
  poolFill.appendChild(el('stop', { offset: '100%', 'stop-color': '#a34dff', 'stop-opacity': 0.03 }));
  defs.appendChild(poolFill);

  space.appendChild(defs);
}

// ---- the wall behind everything: ghost tags, dried runs, mist ----

function buildWall() {
  // one or two fragments of an old buried tag, at a whisper of opacity
  space.appendChild(el('path', {
    d: 'M -20 158 C 46 118 92 186 150 132 C 196 90 238 148 336 96',
    fill: 'none', stroke: 'rgba(240,234,246,0.04)', 'stroke-width': 6.5, 'stroke-linecap': 'round',
  }));
  space.appendChild(el('path', {
    d: 'M 226 250 C 246 196 214 168 252 140',
    fill: 'none', stroke: 'rgba(240,234,246,0.032)', 'stroke-width': 4.5, 'stroke-linecap': 'round',
  }));

  // dried paint-runs from pieces long gone: static vertical streaks
  for (const [x, w, o] of [[88, 1.4, 0.05], [143, 1, 0.04], [201, 1.6, 0.045], [262, 0.9, 0.038]]) {
    space.appendChild(el('path', {
      d: `M ${x} 30 C ${x + 2} 96 ${x - 1.6} 170 ${x + 1} 250`,
      fill: 'none', stroke: `rgba(240,234,246,${o})`, 'stroke-width': w, 'stroke-linecap': 'round',
    }));
  }

  // fine mist afloat against the wall
  for (let i = 0; i < 12; i++) {
    const bx = 12 + hash01(i * 7 + 2) * 296;
    const by = 20 + hash01(i * 11 + 5) * 200;
    const dot = el('circle', {
      cx: bx, cy: by, r: (0.5 + hash01(i * 3) * 0.6).toFixed(2),
      fill: 'var(--light)', opacity: (0.08 + hash01(i * 13 + 1) * 0.16).toFixed(2),
    });
    space.appendChild(dot);
    mistPts.push({
      el: dot, bx, by,
      ph: hash01(i * 17) * 6.28,
      w: 0.2 + hash01(i * 19) * 0.4,
      ax: 2 + hash01(i * 23) * 3,
      ay: 1.5 + hash01(i * 29) * 2.5,
    });
  }

  // a few sparks twinkling out of phase
  for (const [x, y, r] of [[40, 34, 0.9], [284, 40, 0.8], [160, 24, 0.7]]) {
    const star = el('circle', { class: 'bg-star', cx: x, cy: y, r, fill: 'var(--text)' });
    star.style.animationDelay = `${(hash01(x) * 5).toFixed(2)}s`;
    star.style.animationDuration = `${(3.5 + hash01(y) * 3).toFixed(2)}s`;
    space.appendChild(star);
  }
}

// ---- the pool (bottom, full width) = the MELT macro ----

function buildPool() {
  poolFillEl = el('path', { d: '', fill: 'url(#pool-fill)' });
  space.appendChild(poolFillEl);

  // syrupy ripples that widen slowly when a drop lands (pooled)
  for (let i = 0; i < 4; i++) {
    const r = el('ellipse', {
      cx: 0, cy: 0, rx: 0, ry: 0, fill: 'none',
      stroke: 'var(--accent2)', 'stroke-width': 0.7, opacity: 0,
    });
    space.appendChild(r);
    ripples.push({ el: r, active: false, x: 0, r: 0, age: 0 });
  }

  // boil bubbles for high MELT (pooled)
  for (let i = 0; i < 5; i++) {
    const b = el('circle', {
      cx: 0, cy: 0, r: 1, fill: 'none',
      stroke: 'var(--accent2)', 'stroke-width': 0.5, opacity: 0,
    });
    space.appendChild(b);
    bubbles.push({ el: b, active: false, x: 0, y: 0, r: 1, vy: 0, pop: 0 });
  }

  // the luminous water line (+ a fat dim violet echo just under it)
  poolEchoEl = el('path', {
    d: '', fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.6,
    opacity: 0.22, transform: 'translate(0 2.2)',
  });
  poolLineEl = el('path', {
    d: '', fill: 'none', stroke: '#f6edff', 'stroke-width': 1,
    opacity: 0.85, filter: 'url(#glow)',
  });
  space.appendChild(poolEchoEl);
  space.appendChild(poolLineEl);

  // level readout at the surface's right end
  meltValueEl = el('text', { x: 306, y: POOL_BASE - 6, 'text-anchor': 'end', class: 'melt-value' });
  meltValueEl.textContent = '0%';
  space.appendChild(meltValueEl);

  // drag the surface up/down = MELT amount
  const hit = el('rect', { class: 'pool-hit', x: 0, y: 186, width: W, height: H - 186, fill: 'transparent' });
  hit.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      hit.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const start = melt;
    // dragging UP raises the level — the world sinks into the paint
    const onMove = (ev) => setMelt(start + (startY - ev.clientY) / 110);
    const onUp = () => {
      hit.removeEventListener('pointermove', onMove);
      hit.removeEventListener('pointerup', onUp);
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerup', onUp);
  });
  space.appendChild(hit);
}

// pool surface height at x — slow swells + syrupy impact bumps
function surfY(x, t) {
  let y = poolY
    + 1.3 * Math.sin(x * 0.026 + t * 0.0011)
    + 0.7 * Math.sin(x * 0.058 - t * 0.00074);
  if (melt > 0.45) y += (melt - 0.45) * 1.7 * Math.sin(x * 0.12 + t * 0.0043);
  for (const im of impulses) {
    const g = (x - im.x) / (9 + im.age * 30);
    y -= im.amp * Math.exp(-g * g) * Math.cos(im.age * 5.5) * Math.exp(-im.age * 1.7);
  }
  return y;
}

function spawnRipple(x, big) {
  const rp = ripples.find((r) => !r.active) || ripples[0];
  rp.active = true;
  rp.x = x;
  rp.r = big ? 2.5 : 1.5;
  rp.age = 0;
  rp.el.setAttribute('stroke-width', big ? 1 : 0.7);
}

// ---- the four lab vessels shelved in the margins ----

function buildTags() {
  for (const [track, cfg] of Object.entries(TAG_POS)) {
    // this vessel's overflow, bleeding all the way down into the pool
    // (the d is a stored prefix + the water line's y, re-joined per frame)
    const runPrefix = `M ${cfg.x} ${cfg.y + 10} C ${cfg.x + 1.8} ${cfg.y + 40} ${cfg.x - 1.2} ${(cfg.y + POOL_BASE) / 2 + 30} ${cfg.x + 1} `;
    const run = el('path', {
      d: runPrefix + (POOL_BASE - 2),
      fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.5,
      'stroke-linecap': 'round', opacity: 0.35,
    });
    space.appendChild(run);

    const g = el('g', { class: 'tagup', transform: `translate(${cfg.x} ${cfg.y})`, 'data-track': track });
    g.appendChild(el('circle', { cx: 0, cy: 2, r: 17, fill: 'transparent' })); // hit area
    const ring = el('circle', {
      class: 'select-ring', cx: 0, cy: 0, r: 11.5,
      stroke: 'var(--cream)', 'stroke-width': 0.8, fill: 'none', opacity: 0,
    });
    g.appendChild(ring);

    const scale = el('g', { class: 'tag-scale' });
    scale.appendChild(el('circle', { cx: 0, cy: 0, r: 8, fill: 'url(#halo)', opacity: 0.8 }));
    const art = TAG_ART[track];
    const inner = el('g', { transform: `scale(${cfg.s})` });
    for (const d of art.glass) {
      inner.appendChild(el('path', {
        d, fill: 'none', stroke: 'rgba(240,234,246,0.78)', 'stroke-width': 0.85,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)',
      }));
    }
    // the liquid inside: violet surface line + micro bubbles; muting the
    // track turns this glow off entirely
    const liq = el('g');
    for (const d of art.liquid) {
      liq.appendChild(el('path', {
        d, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.8,
        'stroke-linecap': 'round', opacity: 0.9, filter: 'url(#glow)',
      }));
    }
    for (const [i, [bx, by, br]] of art.bubbles.entries()) {
      const bub = el('circle', {
        class: 'vial-bub', cx: bx, cy: by, r: br,
        fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.4, opacity: 0.55,
      });
      bub.style.animationDelay = `${(-i * 1.1 - hash01(cfg.x + i) * 2).toFixed(2)}s`;
      liq.appendChild(bub);
    }
    if (art.tipDrop) {
      // the dropper's drop, forever about to fall
      const tdWrap = el('g', { transform: `translate(0 ${art.tipDrop.y})` });
      const tdBob = el('g', { class: 'drip-bob' });
      tdBob.appendChild(el('path', {
        d: DROP_D, transform: `scale(${art.tipDrop.s})`,
        fill: 'url(#drop-lit)', stroke: 'var(--accent)', 'stroke-width': 0.35,
      }));
      tdWrap.appendChild(tdBob);
      liq.appendChild(tdWrap);
    }
    inner.appendChild(liq);
    scale.appendChild(inner);
    g.appendChild(scale);

    const label = el('text', { y: 15.5, 'text-anchor': 'middle', class: 'tag-label' });
    label.textContent = cfg.label;
    g.appendChild(label);

    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      selectTrack(track);
    });
    selectionRings[track] = ring;
    tagEls[track] = { g, scale, liq, run, runPrefix };
    space.appendChild(g);
  }
}

// ---- the 16 drip points = the 16 steps ----
// No strands: each step is a nipple on the mass's lower edge (the bulge is
// baked into the edge outline) with a drop swelling straight out of it.

function buildDrips() {
  // slide films: sagging membranes of goo bridging neighbouring drip
  // points; the lit ones are re-pathed every frame under the drops
  for (let i = 0; i < STEPS; i++) {
    const f = el('path', {
      d: '', fill: 'var(--accent)', 'fill-opacity': 0.14,
      stroke: 'var(--accent2)', 'stroke-width': 0.7,
      'stroke-linecap': 'round', opacity: 0, filter: 'url(#glow)',
    });
    space.appendChild(f);
    slideFilms.push(f);
  }

  for (let i = 0; i < STEPS; i++) {
    const x = DRIP_X0 + DRIP_DX * i;
    const g = el('g', { class: 'drip', transform: `translate(${x} ${BLOB_EDGE})` });

    const dropWrap = el('g'); // per-frame state scale (anchor rides in g)
    const bob = el('g', { class: 'drip-bob' }); // slow viscous quiver (CSS)
    bob.style.animationDelay = `${(-hash01(i * 31) * 4).toFixed(2)}s`;
    const halo = el('circle', { cx: 0, cy: 3.6, r: 5.5, fill: 'url(#halo)', opacity: 0.6 });
    const drop = el('path', { class: 'drip-drop', d: DROP_D, fill: 'url(#drop-lit)', stroke: 'var(--accent)', 'stroke-width': 0.4 });
    bob.appendChild(halo);
    bob.appendChild(drop);
    dropWrap.appendChild(bob);
    g.appendChild(dropWrap);

    space.appendChild(g);
    dripsArr.push({
      g, dropWrap, drop, halo, x,
      szRnd: 0.85 + hash01(i * 5 + 2) * 0.5, // every drop its own size...
      hang: 1.05 + hash01(i * 13 + 4) * 0.75, // ...and its own droop
      bulge: 0.8, sx: 0, sy: 0,
    });
  }
}

// world-space y of a hanging drop's tip (melt fattens and lowers everything)
function dripTipY(i) {
  return edgeYs[i] + 7.2 * dripsArr[i].sy * (1 + melt * 0.7);
}

// ---- the glob playhead + its falling droplets ----

function buildGlob() {
  // droplets torn off by the glob, falling into the pool (pooled)
  for (let i = 0; i < 6; i++) {
    const p = el('path', { d: DROP_D, fill: 'url(#drop-lit)', opacity: 0, filter: 'url(#glow)' });
    space.appendChild(p);
    fallDrops.push({ el: p, active: false, x: 0, y: 0, vy: 0, big: false });
  }

  // the thread the glob pulls from its previous perch
  glob.thread = el('path', {
    d: '', fill: 'none', stroke: 'var(--accent2)',
    'stroke-linecap': 'round', opacity: 0, filter: 'url(#glow)',
  });
  space.appendChild(glob.thread);

  glob.g = el('g', { class: 'glob' });
  glob.g.appendChild(el('circle', { cx: 0, cy: 0, r: 7.5, fill: 'url(#halo)', opacity: 0.9 }));
  glob.body = el('ellipse', {
    cx: 0, cy: 0, rx: 4.4, ry: 4,
    fill: 'url(#glob-body)', stroke: 'var(--accent2)', 'stroke-width': 0.5,
  });
  glob.g.appendChild(glob.body);
  space.appendChild(glob.g);
  parkPlayhead();
}

// ---- the molten mass = the play toggle ----

function buildPiece() {
  sunEl = el('g', { class: 'sun' });

  pieceHazeEl = el('ellipse', { cx: 160, cy: 26, rx: 150, ry: 34, fill: 'url(#piece-haze)', opacity: 0.45 });
  sunEl.appendChild(pieceHazeEl);

  pieceGooEl = el('g', { class: 'goo' });
  // the sheet itself: luminous fill + fat white outline with glow
  blobOuterEl = el('path', {
    d: '', fill: 'url(#blob-fill)', stroke: 'rgba(240,234,246,0.88)',
    'stroke-width': 1.3, 'stroke-linejoin': 'round', filter: 'url(#glow)',
  });
  // violet echo line tracing just inside the lower edge
  blobEchoEl = el('path', {
    d: '', fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.8,
    'stroke-linecap': 'round', opacity: 0.7,
  });
  pieceGooEl.appendChild(blobOuterEl);
  pieceGooEl.appendChild(blobEchoEl);
  sunEl.appendChild(pieceGooEl);

  // the whole mass is the button: a slab over its resting extent (the
  // filled outline itself also takes hits wherever MELT slumps it lower)
  sunEl.appendChild(el('rect', { x: 0, y: 0, width: W, height: 88, fill: 'transparent' }));
  sunEl.classList.add('loading');
  sunEl.addEventListener('pointerdown', togglePlay);
  space.appendChild(sunEl);
}

// open Catmull-Rom polyline -> cubic Bezier (the echo line primitive)
function openPath(pts) {
  const n = pts.length;
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[i];
    const c = pts[i + 1];
    const e = pts[Math.min(n - 1, i + 2)];
    d += ` C ${(b.x + (c.x - a.x) / 6).toFixed(2)} ${(b.y + (c.y - a.y) / 6).toFixed(2)}`
      + ` ${(c.x - (e.x - b.x) / 6).toFixed(2)} ${(c.y - (e.y - b.y) / 6).toFixed(2)}`
      + ` ${c.x.toFixed(2)} ${c.y.toFixed(2)}`;
  }
  return d;
}

// this frame's mass outline: the lower edge sampled at the 16 drip points
// (stored into edgeYs so drops, films and glob all share the true edge),
// one filler each side, two off-frame corners — one closed goo loop
function updateBlob(t) {
  for (let i = 0; i < STEPS; i++) {
    const d = dripsArr[i];
    edgeYs[i] = blobEdgeBase(d.x, t) + d.bulge * (1 + melt * 0.8) + globBump(d.x);
  }
  const pts = [
    { x: -BLOB_OFF, y: -BLOB_OFF },
    { x: -BLOB_OFF, y: blobEdgeBase(-BLOB_OFF, t) },
  ];
  for (let i = 0; i < STEPS; i++) pts.push({ x: dripsArr[i].x, y: edgeYs[i] });
  pts.push({ x: W + BLOB_OFF, y: blobEdgeBase(W + BLOB_OFF, t) });
  pts.push({ x: W + BLOB_OFF, y: -BLOB_OFF });
  blobOuterEl.setAttribute('d', gooPath(pts));

  const epts = [];
  for (let i = 0; i < STEPS; i++) {
    epts.push({ x: dripsArr[i].x, y: edgeYs[i] - 4.6 - dripsArr[i].bulge * 0.5 });
  }
  blobEchoEl.setAttribute('d', openPath(epts));
}

function buildScene() {
  buildDefs();
  buildWall();
  buildPool();
  buildTags();
  buildDrips();
  buildGlob();
  buildPiece();
  refreshOverview();
}

// ---- overview: dress each drip point to match the pattern ----

function dripState(i) {
  if (toggles.acid[i]) return acidAcc[i] ? 'acc' : 'acid';
  if (toggles.kick[i] || toggles.hatC[i] || toggles.hatO[i] || toggles.clap[i]) return 'on';
  return 'off';
}

function setDrip(i) {
  const d = dripsArr[i];
  const st = dripState(i);
  const lit = st !== 'off';
  // the nipple on the edge: barely there unlit, engorged on an accent
  d.bulge = st === 'acc' ? 3.2 : st === 'acid' ? 2.3 : st === 'on' ? 1.9 : 0.8;
  // the drop swelling straight out of the edge (its live transform — edge
  // anchor + melt fattening — is applied every frame from these factors)
  const size = lit ? d.szRnd * (st === 'acc' ? 1.85 : st === 'acid' ? 1.4 : 1.2) : 0;
  d.sx = size * 0.92;
  d.sy = size * d.hang;
  d.drop.setAttribute('fill', st === 'acc' ? 'url(#drop-acc)' : 'url(#drop-lit)');
  d.drop.style.display = lit ? '' : 'none';
  d.halo.style.display = lit ? '' : 'none';
  d.halo.setAttribute('opacity', st === 'acc' ? 0.85 : 0.6);
  refreshSlide(i);
}

// a slide step bridges to its neighbour with a sagging film of goo; only
// the on/off state lives here — the lit films are re-pathed every frame
// so they stay glued to the living edge
function refreshSlide(i) {
  const f = slideFilms[i];
  const on = i > 0 && toggles.acid[i] && acidSlide[i];
  f.setAttribute('opacity', on ? 0.6 : 0);
  if (on) f.dataset.on = '1';
  else delete f.dataset.on;
}

function refreshOverview() {
  for (let i = 0; i < STEPS; i++) setDrip(i);
}

// ---- MELT: the pool level is the macro ----

function setMelt(value) {
  melt = Math.min(1, Math.max(0, value));
  send({ type: 'melt', value: melt });
  meltValueEl.textContent = `${Math.round(melt * 100)}%`;
  meltValueEl.style.fill = melt > 0.001 ? 'var(--accent-bright)' : 'var(--dim)';
  poolTarget = POOL_BASE - melt * POOL_RANGE;
  if (meltSlider) meltSlider.value = melt;
  // everything else — the mass slumping toward centre screen, drops
  // fattening and lengthening, films sagging deeper — reads `melt`
  // directly inside the per-frame edge and scale math
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
  sunEl.classList.toggle('playing', playing);
  if (playing) {
    lastStep = -1;
    glob.parked = false;
    glob.g.style.opacity = 0.95;
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

// the glob rests, dim, at step 0's root whenever the machine is stopped
function parkPlayhead() {
  glob.parked = true;
  glob.x = glob.targetX = glob.fromX = dripsArr.length ? dripsArr[0].x : DRIP_X0;
  glob.threadLife = 0;
  glob.pluck = 0;
  if (glob.g) glob.g.style.opacity = 0.28;
}

function movePlayhead(index) {
  const x = dripsArr[index].x;
  if (index <= lastStep) {
    // loop wrap: no cross-screen crawl — the glob reappears at the left
    glob.x = x;
    glob.threadLife = 0;
  } else {
    // pull a thread from the old perch; it stretches, necks and snaps
    glob.fromX = glob.targetX;
    glob.threadLife = 1;
  }
  glob.targetX = x;
  glob.parked = false;
  lastStep = index;

  // crossing a lit drip tears its drop off into the pool
  if (dripState(index) !== 'off') shedDrop(index);

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
  const tag = tagEls[track];
  tag.scale.classList.remove('hit');
  void tag.scale.getBoundingClientRect(); // restart the animation
  tag.scale.classList.add('hit');
  if (track === 'kick') {
    kickEnv = 1; // the mass shudders; the pool answers
    pushImpulse(glob.targetX, 1.1);
  }
}

function pushImpulse(x, amp) {
  impulses.push({ x, amp, age: 0 });
  if (impulses.length > 10) impulses.shift();
}

// the glob passes a lit drip point: it squeezes the drop off the edge and
// the drop falls into the pool
function shedDrop(index) {
  const d = dripsArr[index];
  const st = dripState(index);
  // the hanging drop snaps back and slowly re-swells
  d.drop.classList.remove('shed');
  void d.drop.getBoundingClientRect();
  d.drop.classList.add('shed');
  // a free droplet takes over and falls
  const f = fallDrops.find((p) => !p.active);
  if (!f) return;
  f.active = true;
  f.big = st === 'acc';
  f.x = d.x;
  f.y = dripTipY(index);
  f.vy = 24;
  f.el.setAttribute('fill', f.big ? 'url(#drop-acc)' : 'url(#drop-lit)');
  f.el.setAttribute('opacity', 0.95);
}

// ---- ambient motion: everything obeys honey ----

let lastFrame = 0;

function renderFrame(t) {
  // clamp dt to [0, 0.1]: a hidden-tab return must not jump the scene, and a
  // backwards timestamp must not feed the integrators a negative step
  const dt = Math.min(Math.max(lastFrame ? (t - lastFrame) / 1000 : 0, 0), 0.1);
  lastFrame = t;
  nowT = t;

  kickEnv = Math.max(0, kickEnv - dt * 6);

  // the glob crawls first, so the edge can swell around where it now is
  glob.x += (glob.targetX - glob.x) * (1 - Math.exp(-dt * 16));

  // the mass: outline + echo re-pathed from the edge math (with the pool
  // surface, glob thread and lit slide films, the only per-frame path
  // regeneration)
  updateBlob(t);
  const flicker = melt * 0.12 * Math.sin(t / 95) * Math.sin(t / 41);
  pieceHazeEl.setAttribute('opacity', Math.max(0, 0.45 + kickEnv * 0.25 + flicker).toFixed(3));

  // the 16 drops ride the living edge (transforms only, no new paths)
  const mSclX = 1 + melt * 0.55;
  const mSclY = 1 + melt * 0.7;
  for (let i = 0; i < STEPS; i++) {
    const d = dripsArr[i];
    d.g.setAttribute('transform', `translate(${d.x} ${edgeYs[i].toFixed(2)})`);
    if (d.sx > 0) {
      d.dropWrap.setAttribute('transform',
        `scale(${(d.sx * mSclX).toFixed(3)} ${(d.sy * mSclY).toFixed(3)})`);
    }
  }

  // lit slide films: goo bridges sagging between neighbouring drip points
  for (let i = 1; i < STEPS; i++) {
    const f = slideFilms[i];
    if (!f.dataset.on) continue;
    const ax = dripsArr[i - 1].x;
    const bx = dripsArr[i].x;
    const ay = edgeYs[i - 1] + 0.6;
    const by = edgeYs[i] + 0.6;
    const sag = Math.max(ay, by) + 7 + melt * 7 + 1.2 * Math.sin(t / 480 + i * 1.9);
    f.setAttribute('d',
      `M ${ax.toFixed(1)} ${ay.toFixed(1)} Q ${((ax + bx) / 2).toFixed(1)} ${sag.toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)} Z`);
  }

  // the pool level oozes toward its target — never snaps
  poolY += (poolTarget - poolY) * (1 - Math.exp(-dt * 3));
  for (const im of impulses) im.age += dt;
  while (impulses.length && impulses[0].age > 2.2) impulses.shift();

  // surface line: 17 samples, midpoint-smoothed
  const ys = [];
  for (let x = 0; x <= W; x += 20) ys.push(surfY(x, t));
  const surfD = wavePath(0, 20, ys);
  poolLineEl.setAttribute('d', surfD);
  poolEchoEl.setAttribute('d', surfD);
  poolFillEl.setAttribute('d', `${surfD} L ${W} ${H + 2} L 0 ${H + 2} Z`);
  meltValueEl.setAttribute('y', (poolY - 6).toFixed(1));

  // the four paint-runs always reach exactly down to the water
  for (const { run, runPrefix } of Object.values(tagEls)) {
    run.setAttribute('d', runPrefix + (poolY - 1).toFixed(1));
  }

  // syrupy ripples: fast bloom, then a long slow crawl outward
  for (const rp of ripples) {
    if (!rp.active) continue;
    rp.age += dt;
    rp.r += dt * 26 * Math.exp(-rp.age * 2.2);
    const op = 0.5 * Math.max(0, 1 - rp.age / 1.6);
    if (rp.age > 1.6) {
      rp.active = false;
      rp.el.setAttribute('opacity', 0);
      continue;
    }
    rp.el.setAttribute('cx', rp.x.toFixed(1));
    rp.el.setAttribute('cy', surfY(rp.x, t).toFixed(1));
    rp.el.setAttribute('rx', rp.r.toFixed(1));
    rp.el.setAttribute('ry', (rp.r * 0.28).toFixed(1));
    rp.el.setAttribute('opacity', op.toFixed(2));
  }

  // high MELT: the pool seethes — bubbles rise and pop
  if (melt > 0.55 && Math.random() < dt * (melt - 0.5) * 9) {
    const b = bubbles.find((q) => !q.active);
    if (b) {
      b.active = true;
      b.pop = 0;
      b.x = 18 + Math.random() * (W - 36);
      b.y = poolY + 7 + Math.random() * 13;
      b.r = 0.8 + Math.random() * 1.4;
      b.vy = 4 + Math.random() * 5;
    }
  }
  for (const b of bubbles) {
    if (!b.active) continue;
    if (b.pop > 0) {
      b.pop -= dt;
      b.r += dt * 14;
      b.el.setAttribute('r', b.r.toFixed(1));
      b.el.setAttribute('opacity', Math.max(0, b.pop * 3).toFixed(2));
      if (b.pop <= 0) {
        b.active = false;
        b.el.setAttribute('opacity', 0);
      }
      continue;
    }
    b.y -= b.vy * dt;
    const sy = surfY(b.x, t);
    if (b.y <= sy + 1) {
      b.pop = 0.3; // burst at the surface
      pushImpulse(b.x, 0.6);
    }
    b.el.setAttribute('cx', b.x.toFixed(1));
    b.el.setAttribute('cy', b.y.toFixed(1));
    b.el.setAttribute('r', b.r.toFixed(1));
    b.el.setAttribute('opacity', 0.5);
  }

  // falling droplets: heavy, stretching as they gain speed
  for (const f of fallDrops) {
    if (!f.active) continue;
    f.vy += 420 * dt;
    f.y += f.vy * dt;
    const stretch = 1 + Math.min(0.7, f.vy * 0.004);
    const size = f.big ? 1.5 : 1.1;
    f.el.setAttribute('transform',
      `translate(${f.x.toFixed(1)} ${f.y.toFixed(1)}) scale(${(size / Math.sqrt(stretch)).toFixed(2)} ${(size * stretch).toFixed(2)})`);
    if (f.y >= surfY(f.x, t) - 2) {
      // landing: a heavy splash and a slow syrupy ring
      f.active = false;
      f.el.setAttribute('opacity', 0);
      pushImpulse(f.x, f.big ? 3.4 : 2.3);
      spawnRipple(f.x, f.big);
    }
  }

  // the glob: rides inside the lower edge (the bump in the edge math is
  // its own swelling), stretches while moving, plucks back on arrival
  const gy = blobEdgeBase(glob.x, t) + globBump(glob.x) * 0.55;
  const rem = glob.targetX - glob.x;
  const stretch = Math.min(1.1, Math.abs(rem) * 0.09);
  glob.pluck = Math.max(0, glob.pluck - dt * 3);
  const jiggle = 1 + 0.3 * glob.pluck * Math.sin((1 - glob.pluck) * 26);
  glob.body.setAttribute('rx', (4.4 * (1 + stretch * 0.65)).toFixed(2));
  glob.body.setAttribute('ry', (4 * (1 - stretch * 0.26) * jiggle).toFixed(2));
  glob.g.setAttribute('transform', `translate(${glob.x.toFixed(2)} ${gy.toFixed(2)})`);
  if (glob.threadLife > 0) {
    // the pulled thread: sags, necks as it thins, then snaps — ぷるん
    glob.threadLife -= dt * (Math.abs(rem) < 2.5 ? 9 : 1.2);
    if (glob.threadLife <= 0) {
      glob.threadLife = 0;
      glob.pluck = 1;
      glob.thread.setAttribute('opacity', 0);
    } else {
      const span = glob.x - glob.fromX;
      const fromY = blobEdgeBase(glob.fromX, t) + 1;
      const sag = Math.min(9, Math.abs(span) * 0.25 + 2);
      glob.thread.setAttribute('d',
        `M ${glob.fromX.toFixed(1)} ${fromY.toFixed(1)} Q ${(glob.fromX + span / 2).toFixed(1)} ${(Math.max(gy, fromY) + sag).toFixed(1)} ${glob.x.toFixed(1)} ${gy.toFixed(1)}`);
      glob.thread.setAttribute('stroke-width', (0.5 + 1.1 * glob.threadLife).toFixed(2));
      glob.thread.setAttribute('opacity', (0.55 * glob.threadLife).toFixed(2));
    }
  } else {
    glob.thread.setAttribute('opacity', 0);
  }

  // mist drifts; dissolution stirs it
  const mistAmp = 1 + melt * 1.3;
  for (const m of mistPts) {
    const ts = t / 1000;
    m.el.setAttribute('cx', (m.bx + m.ax * mistAmp * Math.sin(ts * m.w + m.ph)).toFixed(2));
    m.el.setAttribute('cy', (m.by + m.ay * mistAmp * Math.cos(ts * m.w * 0.8 + m.ph * 1.7)).toFixed(2));
  }
}

function animate(t) {
  renderFrame(t);
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

// jump straight to a layer's editor
document.querySelectorAll('.jump-btn').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    selectTrack(btn.dataset.jump);
  });
});

// ---- MELT slider (mirrors the pool-surface drag) ----

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
  // the vessel goes dark: its liquid's glow quenches, the glassware dims,
  // and its overflow stops bleeding into the pool
  tagEls[track].liq.style.opacity = value ? 0 : '';
  tagEls[track].g.style.opacity = value ? 0.18 : '';
  tagEls[track].run.style.opacity = value ? 0 : '';
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
// paint one frame synchronously: rAF is paused in hidden tabs, and the
// letters/pool have no path data until the first render
renderFrame(0);
window.__renderFrame = renderFrame; // headless-QA hook (rAF-less frame step)
// start closed on mobile
document.getElementById('editor').classList.remove('open');
document.body.classList.remove('editor-open');

// Load the engine eagerly. In Electron there is no autoplay restriction; in a
// browser the context starts suspended and is resumed by the play button.
ensureAudio()
  .then(() => console.log('audio engine ready'))
  .catch((err) => console.error(`audio engine failed to load: ${err.message}`))
  .finally(() => sunEl.classList.remove('loading'));
