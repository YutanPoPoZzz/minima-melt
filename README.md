# minima melt

Molten acid groovebox — the sixth unit in the **minima** series
(galaxy / rain / drift / city / fission / **melt**).

A luminous body dissolving on black: a wobbling molten core, a ring of 16
droplet steps, a viscous drop for a playhead that splashes through lit notes.
Toxic violet × pale lavender on black.

**Play it in the browser:** https://yutanpopozzz.github.io/minima-melt/

## Sound

- Acid techno, 130 BPM by default, 16 steps = 1 bar
- 4 voices, all synthesized (no samples):
  - **KICK** — four-on-the-floor techno kick
  - **HATS** — closed / open 16th hats (open chokes closed)
  - **CLAP** — noise-burst clap
  - **ACID** — the star: a 303 voice with saw↔square morph, screaming
    resonant filter, and per-step **pitch + accent + slide** programming
- FX: tempo-synced dotted-⅛ dub delay, plate reverb, bitcrush, kick
  sidechain, swing
- **MELT** — the hero macro. Drag the melting pillar (top-left) down to
  dissolve the pattern: the filter starts to ooze, pitches droop and smear
  into slides, delay feedback swells, and past 70% bubbles pop out of the
  self-oscillating filter. Fully reversible — at 0% the original pattern
  comes back intact.

## Run

Web: any static server over `src/` (it is plain Web Audio + AudioWorklet).

```sh
npx serve src
```

Desktop (Electron):

```sh
npm install
npm start        # dev
npm run dist     # portable .exe
```

## Sisters

- [minima galaxy](https://github.com/YutanPoPoZzz/minima-galaxy) — deep-space techno
- [minima rain](https://github.com/YutanPoPoZzz/minima-rain) — lofi ambient rain
- [minima drift](https://github.com/YutanPoPoZzz/minima-drift) — dub techno night drive
- [minima city](https://github.com/YutanPoPoZzz/minima-city) — city pop skyline
- [minima fission](https://github.com/YutanPoPoZzz/minima-fission) — chain-reaction breakbeats
