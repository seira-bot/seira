// actions.js: the timed actions. Each action is a function of the progress p (0..1) and a context c.
// It returns { face, d, hands, behind }:
//   face    a face id (FACES in catalog.js) or a face spec object
//   d       pose changes. yaw, pitch, roll, hx, hy, bx, by, brot add to the base pose; sx, sy multiply.
//   hands   { L, R } hands in world units. They replace the base hands. Leave a side out to keep it.
//   behind  true when the hands go behind the head (for example during a spin)
// c.t is the time in seconds since the start. c.at(p0, key, fn) runs fn one time when p passes p0.
// c.fx(kind, opts) adds an effect (see fx.js). The bot fades every action in and out with the edge
// value of the action (default 0.1 of its length).

import { hand, REST, bump, ramp, win, smooth, easeOut, easeInOut, backOut, clamp, lerp } from './motion.js';

const restL = () => ({ ...REST.L });
const restR = () => ({ ...REST.R });
const sq = (k) => ({ sx: 1 + k * 0.6, sy: 1 - k });   // squash (k > 0) or stretch (k < 0), volume kept

// Hop curve: anticipation squash, jump with stretch, landing squash, settle. Returns { y, k } with k for sq().
function hopCurve(p) {
  if (p < 0.22) { const k = smooth(p / 0.22); return { y: 0.03 * k, k: 0.12 * k }; }
  if (p < 0.62) {
    const q = (p - 0.22) / 0.4;
    return { y: 0.03 - 4 * q * (1 - q) * 0.62, k: q < 0.5 ? -0.1 * (1 - q * 2) : 0.04 * (q - 0.5) };
  }
  if (p < 0.8) { const q = (p - 0.62) / 0.18; return { y: 0.04 * Math.sin(q * Math.PI), k: 0.14 * Math.sin(q * Math.PI) }; }
  const q = (p - 0.8) / 0.2;
  return { y: 0, k: -0.03 * Math.sin(q * Math.PI) };
}

export const ACTION_FNS = {
  wave(p, c) {
    const up = ramp(p, 0, 0.2) * (1 - ramp(p, 0.84, 1));
    const sw = Math.sin(c.t * 11) * 0.38 * up;
    return {
      face: 'happy',
      d: { roll: 0.09 * up, yaw: 10 * up, by: -Math.abs(Math.sin(c.t * 5.5)) * 0.02 * up },
      hands: { R: hand('wave', lerp(0.7, 1.05, up), lerp(1.2, -0.05, up), lerp(0.32, 0.18, up) + sw, lerp(0.78, 0.9, up)) },
    };
  },

  nod(p) {
    const n = Math.sin(p * Math.PI * 4) * (1 - ramp(p, 0.7, 1));
    return { face: 'click', d: { pitch: 0.55 * Math.max(0, n) - 0.15 * Math.max(0, -n), hy: 0.04 * Math.max(0, n) } };
  },

  'shake-head'(p) {
    const e = ramp(p, 0, 0.1) * (1 - ramp(p, 0.75, 1));
    return { face: 'nope', d: { yaw: Math.sin(p * Math.PI * 5) * 26 * e, roll: Math.sin(p * Math.PI * 5) * 0.03 * e } };
  },

  bow(p) {
    const b = ramp(p, 0.1, 0.38) * (1 - ramp(p, 0.62, 0.9));
    const hd = { L: hand('open', -0.22, 1.18, 0.45, 0.76), R: hand('open', 0.22, 1.18, -0.45, 0.76) };
    return { face: 'bow', d: { pitch: 1 * b, hy: 0.16 * b, by: 0.06 * b, ...sq(0.05 * b) }, hands: hd };
  },

  hop(p, c) {
    const h = hopCurve(p);
    c.at(0.62, 'land', () => c.fx('dust'));
    return { face: p > 0.2 && p < 0.85 ? 'happy' : null, d: { by: h.y, ...sq(h.k), pitch: -0.25 * bump(p, 0.22, 0.62) }, shadow: 1 - 0.6 * bump(p, 0.22, 0.62) };
  },

  spin(p) {
    const a = p < 0.15 ? -18 * smooth(p / 0.15) : -18 + 378 * easeInOut((p - 0.15) / 0.75);
    const yaw = p > 0.9 ? 0 : a;
    const k = bump(p, 0.15, 0.9);
    const cy = Math.cos((yaw * Math.PI) / 180);
    const behind = cy < 0;
    return {
      face: 'happy',
      d: { yaw, by: -0.1 * k, ...sq(-0.05 * k) },
      hands: { L: hand('open', -0.78 * cy, 1.1, -0.5 * cy, 0.74), R: hand('open', 0.78 * cy, 1.1, 0.5 * cy, 0.74) },
      behind,
      edge: 0.04,
    };
  },

  'dance-1'(p, c) {
    const beat = c.t * 2.4 * Math.PI;
    const b = Math.sin(beat);
    if (Math.floor(c.t * 1.2) !== c.state.n) { c.state.n = Math.floor(c.t * 1.2); c.fx('note'); }
    return {
      face: 'dance',
      d: { roll: 0.14 * b, by: Math.abs(Math.cos(beat)) * 0.05, ...sq(Math.abs(Math.cos(beat)) * 0.05), yaw: 6 * b },
      hands: {
        L: hand('fist', -0.75, 0.95 - Math.max(0, b) * 0.35, -0.2, 0.74),
        R: hand('fist', 0.75, 0.95 - Math.max(0, -b) * 0.35, 0.2, 0.74),
      },
    };
  },

  'dance-2'(p, c) {
    const a = c.t * 9;
    const sway = Math.sin(c.t * 2.4 * Math.PI / 2);
    if (Math.floor(c.t * 1.5) !== c.state.n) { c.state.n = Math.floor(c.t * 1.5); c.fx('note'); }
    return {
      face: 'dance',
      d: { bx: 0.14 * sway, brot: -0.06 * sway, yaw: 14 * sway, by: Math.abs(Math.sin(c.t * 4.8)) * 0.03 },
      hands: {
        L: hand('fist', -0.2 + Math.cos(a) * 0.14 + 0.14 * sway, 1.12 + Math.sin(a) * 0.12, 0.3, 0.7),
        R: hand('fist', 0.2 + Math.cos(a + Math.PI) * 0.14 + 0.14 * sway, 1.12 + Math.sin(a + Math.PI) * 0.12, -0.3, 0.7),
      },
    };
  },

  'dance-3'(p, c) {
    const phase = Math.floor(c.t * 2.4) % 2;
    const k = smooth((c.t * 2.4) % 1 * 3);
    const up = phase === 0 ? k : 1 - k;
    if (Math.floor(c.t * 2.4) !== c.state.n) { c.state.n = Math.floor(c.t * 2.4); c.fx(phase ? 'star' : 'note'); }
    return {
      face: 'stars',
      d: { bx: 0.08 * (up - 0.5), brot: 0.1 * (0.5 - up), roll: 0.12 * (up - 0.5), yaw: 18 * (up - 0.5), by: 0.03 * Math.abs(Math.sin(c.t * 7.5)) },
      hands: {
        R: hand('point', lerp(-0.25, 1.05, up), lerp(1.25, -0.75, up), lerp(-2.4, 0.55, up), 0.8),
        L: hand('fist', -0.82, lerp(1.1, 1.25, up), -0.3, 0.7),
      },
    };
  },

  laugh(p, c) {
    const b = Math.abs(Math.sin(c.t * 10));
    return {
      face: 'laugh',
      d: { by: -b * 0.05, ...sq(-b * 0.04), pitch: -0.45, roll: Math.sin(c.t * 5) * 0.05 },
      hands: { L: hand('fist', -0.4, 1.2 - b * 0.05, 0.4, 0.72), R: hand('fist', 0.4, 1.2 - b * 0.05, -0.4, 0.72) },
    };
  },

  giggle(p, c) {
    if (Math.floor(c.t * 3) !== c.state.n) { c.state.n = Math.floor(c.t * 3); c.fx('tickle-sparkle'); }
    const w = Math.sin(c.t * 13);
    return {
      face: 'giggle',
      d: { roll: 0.08 * w, bx: 0.02 * w, ...sq(Math.abs(w) * 0.03), pitch: 0.12 },
      hands: { R: hand('open', 0.3, 0.62, -0.5, 0.74) },
    };
  },

  sneeze(p, c) {
    // Build-up: look up, squint, open mouth, with 2 small "ah" lifts. Then a sharp forward jerk.
    let face, pitch = 0, hy = 0, k = 0, jit = 0;
    if (p < 0.5) {
      const q = p / 0.5;
      face = q < 0.55 ? 'sneeze-ah' : 'sneeze-ahh';
      pitch = -1 * easeOut(q);
      hy = -0.05 * q - 0.03 * bump(q, 0.15, 0.4) - 0.05 * bump(q, 0.5, 0.85);
      k = -0.08 * q;
    } else if (p < 0.6) {
      const q = (p - 0.5) / 0.1;
      face = 'sneeze-choo';
      pitch = lerp(-1, 1, easeOut(q * 2));
      hy = lerp(-0.05, 0.16, easeOut(q * 2));
      k = 0.16 * Math.sin(Math.min(1, q * 1.3) * Math.PI / 2 + Math.PI / 2 * 0);
      jit = (1 - q) * 0.02;
    } else {
      const q = (p - 0.6) / 0.4;
      face = q < 0.25 ? 'sneeze-choo' : 'sneeze-after';
      pitch = lerp(1, 0, easeOut(q * 1.4));
      hy = lerp(0.16, 0, easeOut(q * 1.4));
      k = 0.16 * (1 - easeOut(q * 2)) - 0.02 * bump(q, 0.3, 0.7);
    }
    c.at(0.505, 'choo', () => { c.fx('sneeze-cloud'); c.fx('sneeze-cloud', { delay: 0.05 }); });
    const cover = win(p, 0.32, 0.58, 0.05);
    return {
      face,
      d: { pitch, hy, ...sq(k), bx: Math.sin(c.t * 70) * jit },
      hands: { R: hand('fist', lerp(0.7, 0.36, cover), lerp(1.2, 0.72, cover), lerp(0.32, -0.3, cover), 0.74) },
      edge: 0.03,
    };
  },

  hiccup(p, c) {
    let h = 0;
    for (const t0 of [0.12, 0.52]) h = Math.max(h, bump(p, t0, t0 + 0.12));
    c.at(0.12, 'h1', () => c.fx('exclaim', { small: true }));
    c.at(0.52, 'h2', () => c.fx('exclaim', { small: true }));
    return { face: h > 0.2 ? 'hiccup' : 'calm', d: { by: -0.1 * h, ...sq(-0.08 * h), pitch: -0.2 * h } };
  },

  yawn(p) {
    const y = win(p, 0.15, 0.78, 0.12);
    const cover = win(p, 0.3, 0.7, 0.08);
    return {
      face: y > 0.4 ? 'yawn' : 'sleepy',
      d: { pitch: -0.55 * y, ...sq(-0.07 * y), by: -0.03 * y, roll: 0.06 * y },
      hands: { R: hand('open', lerp(0.7, 0.2, cover), lerp(1.2, 0.58, cover), lerp(0.32, -0.25, cover), 0.76) },
    };
  },

  stretch(p, c) {
    const up = win(p, 0.12, 0.7, 0.1);
    const shake = bump(p, 0.72, 0.95);
    return {
      face: up > 0.5 ? 'stretch' : 'happy',
      d: { ...sq(-0.12 * up + 0.04 * shake), by: -0.06 * up, pitch: -0.4 * up, bx: Math.sin(c.t * 30) * 0.02 * shake },
      hands: {
        L: hand('fist', lerp(-0.7, -0.5, up), lerp(1.2, -0.95, up), lerp(-0.32, 0.25, up), 0.74),
        R: hand('fist', lerp(0.7, 0.5, up), lerp(1.2, -0.95, up), lerp(0.32, -0.25, up), 0.74),
      },
    };
  },

  think(p, c) {
    c.at(0.15, 'q', () => c.fx('question'));
    const k = win(p, 0.08, 0.92, 0.08);
    return {
      face: p < 0.5 ? 'thinking' : 'think-state',
      d: { yaw: 14 * k, roll: 0.09 * k, pitch: -0.25 * k + Math.sin(c.t * 2) * 0.04 },
      hands: { R: hand('chin', lerp(0.7, 0.3, k), lerp(1.2, 1.0, k), lerp(0.32, 0.1, k), 0.8) },
    };
  },

  idea(p, c) {
    c.at(0.18, 'bulb', () => c.fx('idea-bulb'));
    const h = hopCurve(clamp(p * 1.6));
    const up = ramp(p, 0.15, 0.3);
    return {
      face: p < 0.15 ? 'thinking' : 'idea',
      d: { by: h.y * 0.5, ...sq(h.k * 0.6), pitch: -0.3 * up },
      hands: { R: hand('point', lerp(0.7, 0.95, up), lerp(1.2, -0.3, up), lerp(0.32, 0.25, up), 0.82) },
    };
  },

  celebrate(p, c) {
    const h = hopCurve((p * 2) % 1);
    c.at(0.2, 'c1', () => c.fx('confetti', { n: 26 }));
    c.at(0.6, 'c2', () => { c.fx('confetti', { n: 18 }); c.fx('star'); });
    const w = Math.sin(c.t * 12) * 0.25;
    return {
      face: 'cheer',
      d: { by: h.y * 0.7, ...sq(h.k * 0.7), pitch: -0.3 },
      hands: { L: hand('peace', -1.0, -0.45 + h.y * 0.5, -0.35 + w, 0.86), R: hand('peace', 1.0, -0.45 + h.y * 0.5, 0.35 - w, 0.86) },
    };
  },

  oops(p, c) {
    c.at(0.2, 'sw', () => c.fx('sweat-drop'));
    const k = win(p, 0.1, 0.85, 0.1);
    return {
      face: 'oops',
      d: { by: 0.04 * bump(p, 0, 0.3), ...sq(0.06 * bump(p, 0, 0.3)), roll: -0.1 * k, yaw: -10 * k },
      hands: { R: hand('open', lerp(0.7, 0.98, k), lerp(1.2, -0.5, k), lerp(0.32, -0.7, k) + Math.sin(c.t * 16) * 0.12 * k, 0.8) },
    };
  },

  greet(p, c) {
    c.at(0.4, 'st', () => c.fx('star'));
    const b = bump(p, 0.02, 0.32);
    const up = ramp(p, 0.3, 0.45) * (1 - ramp(p, 0.88, 1));
    return {
      face: p < 0.3 ? 'bow' : 'happy',
      d: { pitch: 0.6 * b, hy: 0.08 * b, roll: 0.08 * up, yaw: 8 * up },
      hands: { R: hand('wave', lerp(0.7, 1.02, up), lerp(1.2, -0.05, up), 0.2 + Math.sin(c.t * 11) * 0.35 * up, lerp(0.78, 0.9, up)) },
    };
  },

  bye(p, c) {
    const up = ramp(p, 0, 0.18) * (1 - ramp(p, 0.85, 1));
    return {
      face: p < 0.7 ? 'happy' : 'click',
      d: { roll: -0.07 * up, yaw: -8 * up, brot: Math.sin(c.t * 3) * 0.03 * up },
      hands: { L: hand('wave', lerp(-0.7, -1.05, up), lerp(1.2, -0.25, up), lerp(-0.32, -0.15, up) + Math.sin(c.t * 7) * 0.45 * up, lerp(0.78, 0.9, up)) },
    };
  },

  shiver(p, c) {
    if (Math.floor(c.t * 1.6) !== c.state.n) { c.state.n = Math.floor(c.t * 1.6); c.fx('breath-puff'); }
    c.at(0.1, 'fr', () => c.fx('frost'));
    const j = Math.sin(c.t * 62) * 0.022;
    return {
      face: 'cold',
      d: { bx: j, roll: Math.sin(c.t * 41) * 0.02, ...sq(0.04) },
      hands: { L: hand('fist', -0.98 - j, 0.62, 0.35, 0.72), R: hand('fist', 0.98 - j, 0.62, -0.35, 0.72) },
    };
  },

  'fan-self'(p, c) {
    if (Math.floor(c.t * 2) !== c.state.n) { c.state.n = Math.floor(c.t * 2); c.fx('steam-puff'); }
    const up = ramp(p, 0, 0.15) * (1 - ramp(p, 0.85, 1));
    return {
      face: 'hot',
      d: { roll: 0.06 * up, yaw: 8 * up, pitch: -0.2 * up },
      hands: { R: hand('fan', lerp(0.7, 1.0, up), lerp(1.2, 0.15, up), lerp(0.32, -0.15, up) + Math.sin(c.t * 16) * 0.42 * up, 0.86) },
    };
  },

  'wipe-sweat'(p, c) {
    c.at(0.8, 'fling', () => c.fx('sweat-drop', { fling: true }));
    const up = ramp(p, 0, 0.2) * (1 - ramp(p, 0.82, 1));
    const sweep = ramp(p, 0.25, 0.7);
    return {
      face: p < 0.7 ? 'hot' : 'phew',
      d: { pitch: -0.15 * up, roll: 0.05 * up },
      hands: { R: hand('open', lerp(0.7, lerp(1.0, -0.1, sweep), up), lerp(1.2, -0.62, up), lerp(0.32, -1.45, up), 0.82) },
    };
  },

  peek(p) {
    const cov = win(p, 0.1, 0.9, 0.08);
    const slide = bump(p, 0.4, 0.72);
    const reveal = ramp(p, 0.84, 0.95);
    return {
      face: p < 0.38 ? { eyes: 'arc-down', mouth: 'wavy-small', blush: 0.5 } : p < 0.8 ? 'peek' : 'click',
      d: { pitch: 0.15 * cov, roll: 0.05 * slide },
      hands: {
        L: hand('open', lerp(-0.7, -0.3, cov), lerp(1.2, 0.08, cov), lerp(-0.32, 0.12, cov), lerp(0.78, 1.05, cov)),
        R: hand('open', lerp(0.7, 0.3 + 0.55 * slide + 0.4 * reveal, cov), lerp(1.2, 0.08 + 0.1 * slide, cov), lerp(0.32, -0.12 + 0.4 * slide, cov), lerp(0.78, 1.05, cov)),
      },
    };
  },

  clap(p, c) {
    const n = Math.floor(c.t * 4);
    const q = (c.t * 4) % 1;
    const gap = 0.08 + 0.22 * Math.abs(Math.sin(q * Math.PI));
    if (n !== c.state.n && p > 0.1 && p < 0.9) { c.state.n = n; c.fx('star', { small: true }); }
    const k = win(p, 0.06, 0.94, 0.06);
    return {
      face: 'happy',
      d: { by: -0.02 * Math.abs(Math.sin(q * Math.PI)), pitch: -0.15 },
      hands: { L: hand('open', lerp(-0.7, -gap, k), lerp(1.2, 1.0, k), lerp(-0.32, 0.5, k), 0.78), R: hand('open', lerp(0.7, gap, k), lerp(1.2, 1.0, k), lerp(0.32, -0.5, k), 0.78) },
    };
  },

  facepalm(p) {
    const k = win(p, 0.2, 0.86, 0.1);
    return {
      face: k > 0.5 ? 'palm' : 'nope',
      d: { pitch: 0.45 * k, hy: 0.04 * k, by: 0.04 * k, ...sq(0.04 * k), roll: -0.05 * k },
      hands: { R: hand('open', lerp(0.7, 0.08, k), lerp(1.2, 0.0, k), lerp(0.32, -0.25, k), lerp(0.78, 1.05, k)) },
    };
  },
};
