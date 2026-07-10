// minima melt — UI thread. The same architecture as galaxy/fission,
// reinterpreted as a MOLTEN LUMINOUS BODY dissolving on black, in the
// series' light vocabulary:
//
//   galaxy sun         -> the central MOLTEN CORE: an organic blob of light
//                         whose outline slowly wobbles (JS-driven path) and
//                         whose underside sags and drips viscous threads.
//                         = play/stop (pointerdown). It pulses while playing
//                         and its shockwave ring is the kick sidechain.
//   galaxy orbit rings -> ONE droplet ring; its 16 teardrop nodes are the
//                         steps (lit step = a violet light-orb with a hanging
//                         tail of light). Accented acid steps glow bigger and
//                         brighter; slide steps are strung to the previous
//                         node with a thin thread of light.
//   galaxy playhead    -> a MOLTEN DROP circling the ring with a droopy light
//                         trail; crossing a lit node it SPLASHES: 2-3 light
//                         droplets fly out, a ripple ring bursts and the node
//                         squishes like jelly for an instant.
//   galaxy planets     -> four half-melted LUMPS (hollow line-art blob +
//                         glowing dot + a drip): KICK/HATS/CLAP/ACID.
//                         Tap to open the editor; muting dims the whole lump.
//   galaxy black hole  -> MELT: a melting pillar, top-left — a white line-art
//                         column whose lower half deforms and smears into a
//                         luminous pool as you drag down, a drip thread
//                         stretching from its base. Mirrored by #melt-slider
//                         in the FX panel. High MELT: the core sags harder,
//                         the ring undulates, falling drip streaks multiply
//                         and the glow itself wavers.
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

// ---- molten scene ----

// the four half-melted lumps floating around the core (galaxy's planets)
const LUMPS = {
  acid: { x: 96, y: 46, s: 1.1, label: 'ACID' },
  hat: { x: 240, y: 52, s: 0.85, label: 'HATS' },
  kick: { x: 58, y: 208, s: 1.15, label: 'KICK' },
  clap: { x: 262, y: 202, s: 0.95, label: 'CLAP' },
};

const space = document.getElementById('space');
const ringNodes = []; // per step: { g, core, tail }
const nodePos = [];
const slideThreads = []; // 16 thin light strings, prev node -> slide node
const dotMeta = []; // background dust particles that wander
const lumpEls = {};
const selectionRings = {};
let playheadG = null;
let splashG = null;
let splashDrops = null;
let sunIcon = null;
let sunEl = null;
let sunHazeEl = null;
let coreBlobEl = null; // the wobbling molten outline (path, JS-driven)
let coreInnerEl = null; // a smaller inner blob of hotter light
let coreDripsG = null; // viscous drips hanging off the core's underside
let burstEl = null;
let ringG = null; // ring + nodes + playhead: undulates as one at high MELT
let cometA = null;
let cometB = null;
const meltStreaks = []; // extra falling drip streaks, revealed by MELT
let kickEnv = 0; // core swell on each kick, decays in the rAF loop

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

// a static half-melted outline for the track lumps: wobbly on top, sagging
// and smeared at the bottom. seed varies the character per lump.
function lumpOutline(r, seed, droop) {
  const pts = [];
  const N = 8;
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const w = 1 + 0.16 * Math.sin(ang * 3 + seed) + 0.1 * Math.sin(ang * 2 + seed * 2.3);
    let x = r * w * Math.cos(ang);
    let y = r * w * Math.sin(ang);
    const down = Math.max(0, Math.sin(ang));
    y += down * down * droop;
    pts.push({ x, y });
  }
  return blobPath(pts);
}

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

  // chamber haze banks, drifting very slowly (CSS animation)
  space.appendChild(el('ellipse', { class: 'haze-a', cx: 88, cy: 72, rx: 112, ry: 60, fill: 'url(#haze)', opacity: 0.5 }));
  space.appendChild(el('ellipse', { class: 'haze-b', cx: 250, cy: 206, rx: 120, ry: 68, fill: 'url(#haze)', opacity: 0.4 }));

  // light drips falling from above (the galaxy comets, turned vertical)
  cometA = el('path', { class: 'comet comet-a', d: 'M 66 -8 C 70 70 62 160 66 268', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.9, fill: 'none', opacity: 0.5 });
  cometB = el('path', { class: 'comet comet-b', d: 'M 254 -8 C 250 84 258 170 252 268', pathLength: 100, stroke: 'url(#fade)', 'stroke-width': 0.7, fill: 'none', opacity: 0.32 });
  space.appendChild(cometA);
  space.appendChild(cometB);
  // extra streaks that only appear as MELT rises
  for (const [cls, d, w] of [
    ['comet comet-c', 'M 118 -8 C 122 90 114 180 120 268', 0.8],
    ['comet comet-d', 'M 210 -8 C 206 76 214 168 208 268', 0.7],
    ['comet comet-c', 'M 30 -8 C 34 96 26 186 32 268', 0.6],
  ]) {
    const p = el('path', { class: cls, d, pathLength: 100, stroke: 'url(#fade)', 'stroke-width': w, fill: 'none', opacity: 0 });
    space.appendChild(p);
    meltStreaks.push(p);
  }

  // fine dust particles wandering through the dark
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

// the droplet ring carrying the 16 step nodes, plus decorative shells.
// Everything lives in ringG so the whole ring can undulate at high MELT.
function buildRing() {
  ringG = el('g', { class: 'ring-g' });
  ringG.style.transformOrigin = `${CX}px ${CY}px`;
  space.appendChild(ringG);

  // decorative crossed shells, pure line-art
  const decorA = el('g', { class: 'orbit-decor' });
  decorA.style.transformOrigin = `${CX}px ${CY}px`;
  decorA.appendChild(el('ellipse', { cx: CX, cy: CY, rx: 88, ry: 30, fill: 'none', stroke: 'rgba(240,234,246,0.2)', 'stroke-width': 0.6, transform: `rotate(-24 ${CX} ${CY})` }));
  ringG.appendChild(decorA);
  const decorB = el('g', { class: 'orbit-decor rev' });
  decorB.style.transformOrigin = `${CX}px ${CY}px`;
  decorB.appendChild(el('ellipse', { cx: CX, cy: CY, rx: 92, ry: 26, fill: 'none', stroke: 'rgba(240,234,246,0.16)', 'stroke-width': 0.6, transform: `rotate(28 ${CX} ${CY})` }));
  ringG.appendChild(decorB);

  // the sequencer ring itself
  ringG.appendChild(el('ellipse', { class: 'orbit-ring', cx: CX, cy: CY, rx: RING_R, ry: RING_R * TILT, fill: 'none', stroke: 'rgba(240,234,246,0.32)', 'stroke-width': 0.7 }));

  // slide strings: thin threads of light joining a slide node to the node
  // before it, sagging slightly like syrup (hidden until a slide is lit)
  for (let i = 0; i < STEPS; i++) {
    const th = el('path', { d: '', fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.7, 'stroke-linecap': 'round', opacity: 0, filter: 'url(#glow)' });
    ringG.appendChild(th);
    slideThreads.push(th);
  }

  // 16 droplet nodes strung on the ring: a core orb + a hanging tail of
  // light that appears when the step is lit
  for (let i = 0; i < STEPS; i++) {
    const p = proj(RING_R, i * 22.5);
    nodePos.push(p);
    const g = el('g', { class: 'node-g', transform: `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})` });
    const tail = el('path', { class: 'node-tail', d: 'M 0 2.4 Q 0.4 5 0 7', fill: 'none', stroke: 'var(--accent)', 'stroke-width': 0.8, 'stroke-linecap': 'round', opacity: 0 });
    const core = el('circle', { class: 'node-core', cx: 0, cy: 0, r: 2, fill: 'none', stroke: 'rgba(240,234,246,0.5)', 'stroke-width': 0.8 });
    g.appendChild(tail);
    g.appendChild(core);
    g.dataset.depth = p.depth.toFixed(3);
    ringG.appendChild(g);
    ringNodes.push({ g, core, tail });
  }

  // the splash rig: ripple ring + three flying light droplets (one droops).
  // Repositioned to a node and replayed on each strike.
  splashG = el('g', { class: 'splash' });
  splashG.appendChild(el('circle', { class: 'ripple', cx: 0, cy: 0, r: 5.5, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1.2 }));
  splashDrops = el('g');
  splashDrops.style.transformOrigin = '0px 0px';
  splashDrops.appendChild(el('circle', { class: 'spl spl-1', cx: 0, cy: 0, r: 1.4, fill: 'var(--accent2-bright)', filter: 'url(#glow)' }));
  splashDrops.appendChild(el('circle', { class: 'spl spl-2', cx: 0, cy: 0, r: 1.1, fill: 'var(--accent)', filter: 'url(#glow)' }));
  splashDrops.appendChild(el('circle', { class: 'spl spl-3', cx: 0, cy: 0, r: 1.2, fill: 'var(--accent2)', filter: 'url(#glow)' }));
  splashG.appendChild(splashDrops);
  ringG.appendChild(splashG);

  // the molten-drop playhead: a glowing viscous bead + droopy light trail,
  // drawn pointing along +x and rotated to the ring's heading
  playheadG = el('g', { class: 'blob-head' });
  playheadG.appendChild(el('path', { d: 'M -16 1.6 Q -8 -1.4 -3.5 -1.7 L -3.5 1.7 Q -9 2.8 -16 1.6 Z', fill: 'var(--accent)', opacity: 0.35, filter: 'url(#glow)' }));
  playheadG.appendChild(el('circle', { class: 'blob-head-glow', cx: 0, cy: 0, r: 4.4, fill: 'url(#orb)', opacity: 0.6 }));
  playheadG.appendChild(el('circle', { class: 'blob-head-core', cx: 0, cy: 0.2, r: 1.9, fill: '#f6edff', filter: 'url(#glow)' }));
  // a tiny bead sagging under the drop — molten, not ballistic
  playheadG.appendChild(el('circle', { cx: -0.4, cy: 2.6, r: 0.7, fill: 'var(--accent2)', opacity: 0.8 }));
  ringG.appendChild(playheadG);
  parkPlayhead();
}

// heading (degrees) of the ring at node `index`, from the tangent between its
// neighbours — so the drop's trail streams behind its direction of travel
function headingAt(index) {
  const prev = nodePos[(index - 1 + STEPS) % STEPS];
  const next = nodePos[(index + 1) % STEPS];
  return (Math.atan2(next.y - prev.y, next.x - prev.x) * 180) / Math.PI;
}

// park the molten drop, dimmed, at step 0 so the ring always has its bead
function parkPlayhead() {
  const p = nodePos[0];
  lastDeg = headingAt(0);
  playheadG.style.transition = 'none';
  playheadG.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px) rotate(${lastDeg.toFixed(1)}deg)`;
  playheadG.style.opacity = 0.28;
}

// a track lump: hollow half-melted outline + glowing dot + a hanging drip,
// annotated with a serif label (galaxy's planet)
function buildLump(track, cfg) {
  const g = el('g', { class: 'planet', transform: `translate(${cfg.x} ${cfg.y})`, 'data-track': track });
  const s = cfg.s;
  // generous invisible hit area (the lump is small)
  g.appendChild(el('circle', { cx: 0, cy: 4, r: 24, fill: 'transparent' }));
  const ring = el('circle', { class: 'select-ring', cx: 0, cy: 2, r: 14 * s + 4, stroke: 'var(--cream)', 'stroke-width': 0.9, fill: 'none', opacity: 0 });
  g.appendChild(ring);

  const scaleWrap = el('g', { class: 'planet-scale' });
  const body = el('g', { class: 'planet-body bob' });
  body.style.animationDelay = `${(Math.random() * -6).toFixed(2)}s`;
  // half-melted outline, white line-art (a different sag per track)
  const seed = { kick: 0.8, hat: 2.1, clap: 3.9, acid: 5.2 }[track];
  body.appendChild(el('path', { d: lumpOutline(9 * s, seed, 4.5 * s), fill: 'none', stroke: 'rgba(240,234,246,0.7)', 'stroke-width': 0.9, filter: 'url(#glow)' }));
  // the luminous heart inside the lump
  body.appendChild(el('circle', { cx: 0, cy: 1, r: (4.6 * s).toFixed(2), fill: 'url(#orb)', opacity: 0.6 }));
  body.appendChild(el('circle', { cx: 0, cy: 1, r: (1.8 * s).toFixed(2), fill: 'none', stroke: '#ffffff', 'stroke-width': 1.1, filter: 'url(#glow)' }));
  // a drip stretching from the lump's underside
  const dripY = 9 * s + 4.5 * s;
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

  // track lumps (after the ring so they sit on top)
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

  // the MOLTEN CORE = play button (a wobbling blob of light, drawn last so
  // it floats on top of the ring)
  const sun = el('g', { class: 'sun' });
  sunHazeEl = el('circle', { class: 'sun-haze', cx: CX, cy: CY + 2, r: 42, fill: 'url(#core-haze)', opacity: 0.75 });
  sun.appendChild(sunHazeEl);
  // shockwave ring that expands on every kick — the sidechain, visualized
  burstEl = el('circle', { class: 'sun-burst', cx: CX, cy: CY, r: 17, stroke: '#ffffff', 'stroke-width': 1, fill: 'none', opacity: 0 });
  sun.appendChild(burstEl);

  // the blob itself: an outer molten outline + an inner hotter blob, both
  // re-pathed every frame from slow sine wobbles (see animate); only these
  // deform — the hit-area/play-control circles below stay perfectly still
  // so the tap target never moves.
  const coreWrap = el('g', { class: 'core-wrap' });
  coreBlobEl = el('path', { d: '', fill: 'none', stroke: 'rgba(240,234,246,0.85)', 'stroke-width': 1.1, filter: 'url(#glow)' });
  coreInnerEl = el('path', { d: '', fill: 'url(#core-haze)', opacity: 0.55 });
  coreWrap.appendChild(coreInnerEl);
  coreWrap.appendChild(coreBlobEl);
  sun.appendChild(coreWrap);

  // viscous drips hanging and falling from the core's underside (JS-driven)
  coreDripsG = el('g');
  sun.appendChild(coreDripsG);

  // refined play control: faint outer corona, loading arc, stroked glyph
  sun.appendChild(el('circle', { cx: CX, cy: CY, r: 20.5, stroke: 'rgba(240,234,246,0.25)', 'stroke-width': 0.7, fill: 'none' }));
  sun.appendChild(el('circle', { class: 'sun-load', cx: CX, cy: CY, r: 16.5, stroke: '#ffffff', 'stroke-width': 1.3, fill: 'none', 'stroke-dasharray': '26 78', 'stroke-linecap': 'round', filter: 'url(#glow)' }));
  sunIcon = el('path', { class: 'sun-icon', d: playPath(), fill: 'none', stroke: '#ffffff', 'stroke-width': 1.5, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', filter: 'url(#glow)' });
  sun.appendChild(sunIcon);
  // an invisible, always-round hit target on top of everything
  const hit = el('circle', { cx: CX, cy: CY, r: 24, fill: 'transparent' });
  sun.appendChild(hit);
  sun.classList.add('loading');
  sunEl = sun;
  sun.addEventListener('pointerdown', togglePlay);
  space.appendChild(sun);

  buildCoreDrips();
  refreshOverview();
}

function playPath() {
  return `M${CX - 3.5} ${CY - 5.5} L${CX + 6} ${CY} L${CX - 3.5} ${CY + 5.5} Z`;
}

// two slim bars while playing — tap to stop
function stopPath() {
  return `M${CX - 3} ${CY - 5} L${CX - 3} ${CY + 5} M${CX + 3} ${CY - 5} L${CX + 3} ${CY + 5}`;
}

// ---- the core blob: slow organic wobble, sagging with MELT ----

function corePoints(t) {
  const N = 10;
  const pts = [];
  const breathe = playing ? 0.05 * Math.sin(t / 430) : 0.024 * Math.sin(t / 1500);
  const base = 18.5 * (1 + breathe + kickEnv * 0.14);
  for (let i = 0; i < N; i++) {
    const ang = (i / N) * Math.PI * 2;
    const w = 1
      + 0.07 * Math.sin(ang * 3 + t / 620)
      + 0.05 * Math.sin(ang * 2 - t / 840 + 1.7)
      + melt * 0.07 * Math.sin(ang * 4 + t / 300);
    const x = CX + base * w * Math.cos(ang);
    let y = CY + base * w * Math.sin(ang);
    // the underside sags — a little at rest, heavily molten at high MELT
    const down = Math.max(0, Math.sin(ang));
    y += down * down * (2.2 + melt * 9 + kickEnv * 2);
    pts.push({ x, y });
  }
  return pts;
}

// ---- core drips: threads that stretch, snap and fall as glowing beads ----

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
        d.x = CX + (Math.random() - 0.5) * 18;
        d.y0 = CY + 19 + melt * 9 + Math.abs(d.x - CX) * -0.25;
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

// ---- MELT: the melting pillar, top-left — a white line-art column whose
// lower half smears into a glowing pool as you drag DOWN over it ----

let meltGroup = null;
let meltColLeft = null;
let meltColRight = null;
let meltPool = null;
let meltDripThread = null;
let meltDripBead = null;
let meltValueEl = null;
const meltSlider = document.getElementById('melt-slider');

function buildMeltPillar() {
  const g = el('g', { class: 'meltctl', transform: 'translate(36 26)' });
  meltGroup = g;
  const hit = el('rect', { x: -18, y: -24, width: 36, height: 68, fill: 'transparent' });
  g.appendChild(hit);

  const throb = el('g', { class: 'melt-throb' });
  // pillar cap
  throb.appendChild(el('line', { x1: -4.5, y1: -18, x2: 4.5, y2: -18, stroke: 'var(--light)', 'stroke-width': 1, 'stroke-linecap': 'round', filter: 'url(#glow)' }));
  // the two side rails: straight at 0%, bending and smearing as MELT rises
  meltColLeft = el('path', { d: '', fill: 'none', stroke: 'var(--light)', 'stroke-width': 1, 'stroke-linecap': 'round', filter: 'url(#glow)' });
  meltColRight = el('path', { d: '', fill: 'none', stroke: 'var(--light)', 'stroke-width': 1, 'stroke-linecap': 'round', filter: 'url(#glow)' });
  throb.appendChild(meltColLeft);
  throb.appendChild(meltColRight);
  // the luminous pool the pillar melts into
  meltPool = el('ellipse', { cx: 0, cy: 12.5, rx: 7, ry: 1.6, fill: 'none', stroke: 'var(--accent2)', 'stroke-width': 0.7, opacity: 0.5 });
  throb.appendChild(meltPool);
  // drip thread + bead stretching from the pillar's base
  meltDripThread = el('line', { x1: 0, y1: 12, x2: 0, y2: 13, stroke: 'var(--accent2)', 'stroke-width': 0.6, 'stroke-linecap': 'round', opacity: 0 });
  meltDripBead = el('circle', { cx: 0, cy: 13, r: 0.9, fill: 'var(--accent)', filter: 'url(#glow)', opacity: 0 });
  throb.appendChild(meltDripThread);
  throb.appendChild(meltDripBead);
  g.appendChild(throb);

  const label = el('text', { y: 30, 'text-anchor': 'middle', class: 'planet-label' });
  label.textContent = 'MELT';
  meltValueEl = el('text', { y: 41, 'text-anchor': 'middle', class: 'melt-value' });
  meltValueEl.textContent = '0%';
  g.appendChild(label);
  g.appendChild(meltValueEl);

  g.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      g.setPointerCapture(e.pointerId);
    } catch {}
    const startY = e.clientY;
    const start = melt;
    // dragging DOWN melts the pillar (dissolution pulls everything down)
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
  // the pillar deforms: rails bow outwards, the pool widens, a drip stretches
  const bend = 0.4 + melt * 7.5;
  const yGive = -2 + melt * 6; // where the straight rail gives way
  meltColLeft.setAttribute('d', `M -4.5 -18 L -4.5 ${yGive.toFixed(1)} C -4.5 6, ${(-4.5 - bend).toFixed(1)} 8, ${(-5.5 - bend).toFixed(1)} 12`);
  meltColRight.setAttribute('d', `M 4.5 -18 L 4.5 ${(yGive - 1.5).toFixed(1)} C 4.5 5, ${(4.5 + bend * 0.8).toFixed(1)} 9, ${(5 + bend).toFixed(1)} 12`);
  meltPool.setAttribute('rx', (7 + melt * 7).toFixed(1));
  meltPool.setAttribute('ry', (1.6 + melt * 0.9).toFixed(2));
  meltPool.setAttribute('opacity', (0.5 + melt * 0.4).toFixed(2));
  const dripLen = melt * 9;
  meltDripThread.setAttribute('y2', (13 + dripLen).toFixed(1));
  meltDripThread.setAttribute('opacity', melt > 0.05 ? 0.7 : 0);
  meltDripBead.setAttribute('cy', (13 + dripLen).toFixed(1));
  meltDripBead.setAttribute('opacity', melt > 0.05 ? 0.85 : 0);
  // the readout goes toxic as dissolution rises
  meltValueEl.style.fill = melt > 0.001 ? 'var(--accent-bright)' : 'var(--dim)';
  if (meltSlider) meltSlider.value = melt;
  // falling drip streaks multiply and quicken
  for (const [i, s] of meltStreaks.entries()) {
    s.setAttribute('opacity', Math.max(0, (melt - 0.12 * i) * 0.55).toFixed(2));
  }
  cometA.style.animationDuration = `${(9 / (1 + melt * 1.6)).toFixed(2)}s`;
  cometB.style.animationDuration = `${(14 / (1 + melt * 1.6)).toFixed(2)}s`;
}

// ---- overview: light the droplet nodes to match the pattern ----

function nodeState(i) {
  if (toggles.acid[i]) return acidAcc[i] ? 'acc' : 'acid';
  if (toggles.kick[i] || toggles.hatC[i] || toggles.hatO[i] || toggles.clap[i]) return 'on';
  return 'off';
}

function setNode(i) {
  const { g, core, tail } = ringNodes[i];
  const depth = parseFloat(g.dataset.depth);
  const baseR = 2.2 + 1.6 * depth;
  const st = nodeState(i);
  if (st === 'off') {
    core.setAttribute('r', baseR.toFixed(2));
    core.setAttribute('fill', 'none');
    core.setAttribute('stroke', 'rgba(240,234,246,0.4)');
    core.setAttribute('stroke-width', 0.7);
    tail.setAttribute('opacity', 0);
    g.style.opacity = 0.6;
  } else {
    // lit = a violet light-orb; an accented acid step blazes bigger and
    // brighter; every lit droplet hangs a little tail of light
    const acc = st === 'acc';
    core.setAttribute('r', (baseR + (acc ? 2 : 0.8)).toFixed(2));
    core.setAttribute('fill', acc ? 'url(#node-acc)' : 'url(#node-violet)');
    core.setAttribute('stroke', acc ? 'var(--accent2)' : 'var(--accent)');
    core.setAttribute('stroke-width', acc ? 1.5 : 1.1);
    const tl = acc ? 8.5 : 6;
    tail.setAttribute('d', `M 0 ${(baseR * 0.8).toFixed(1)} Q 0.5 ${(baseR + tl * 0.5).toFixed(1)} 0 ${(baseR + tl).toFixed(1)}`);
    tail.setAttribute('opacity', acc ? 0.85 : 0.6);
    g.style.opacity = 1;
  }
  // slide string: tie this node back to the previous one with a sagging
  // thread of light whenever the step slides
  const th = slideThreads[i];
  if (toggles.acid[i] && acidSlide[i]) {
    const a = nodePos[(i - 1 + STEPS) % STEPS];
    const b = nodePos[i];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 + 5; // syrup sag
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

  // the molten drop smacks through a LIT droplet: SPLASH — light droplets
  // fly, a ripple ring bursts, and the node squishes like jelly
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
    kickEnv = 1; // the core swells with the kick (decays in the rAF loop)
    burstEl.classList.remove('go');
    void burstEl.getBoundingClientRect();
    burstEl.classList.add('go');
  }
}

function fireSplash(index, p) {
  splashG.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)})`);
  // throw the droplets at a fresh angle every splash
  splashDrops.style.transform = `rotate(${(Math.random() * 360).toFixed(0)}deg)`;
  splashG.classList.remove('go');
  void splashG.getBoundingClientRect(); // restart the animations
  splashG.classList.add('go');
  // the struck droplet stretches — びよん
  const g = ringNodes[index].g;
  g.classList.remove('boing');
  void g.getBoundingClientRect();
  g.classList.add('boing');
}

// ---- ambient motion: wobbling core, drips, wandering dust, ring waves ----

let lastFrame = 0;

function animate(t) {
  // clamp dt so returning from a hidden tab doesn't jump the scene
  const dt = Math.min(lastFrame ? (t - lastFrame) / 1000 : 0, 0.1);
  lastFrame = t;

  kickEnv = Math.max(0, kickEnv - dt * 6);

  // the molten core wobbles — its outline is re-pathed every frame
  const pts = corePoints(t);
  coreBlobEl.setAttribute('d', blobPath(pts));
  // the inner hotter blob: same shape, shrunk toward the (sagged) centroid
  let mx = 0;
  let my = 0;
  for (const q of pts) {
    mx += q.x;
    my += q.y;
  }
  mx /= pts.length;
  my /= pts.length;
  coreInnerEl.setAttribute('d', blobPath(pts.map((q) => ({
    x: mx + (q.x - mx) * 0.62,
    y: my + (q.y - my) * 0.62,
  }))));
  // the halo breathes; at high MELT the glow itself wavers
  const flicker = melt * 0.14 * Math.sin(t / 90) * Math.sin(t / 37);
  sunHazeEl.setAttribute('opacity', (0.75 + kickEnv * 0.2 + flicker).toFixed(3));
  sunHazeEl.style.transform = `scale(${(1 + 0.055 * Math.sin(t / 1700) + kickEnv * 0.08).toFixed(4)})`;

  stepDrips(dt);

  // the droplet ring undulates as the world melts
  if (melt > 0.01) {
    const wob = melt * 0.035;
    ringG.style.transform = `translate(0px, ${(melt * 2.5 * Math.sin(t / 640)).toFixed(2)}px) `
      + `scale(${(1 + wob * Math.sin(t / 430)).toFixed(4)}, ${(1 + wob * 1.4 * Math.sin(t / 310 + 1.2)).toFixed(4)})`;
  } else {
    ringG.style.transform = '';
  }

  // dust particles wander freely; dissolution stirs them up
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

// ---- MELT slider (mirrors the melting-pillar drag) ----

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
