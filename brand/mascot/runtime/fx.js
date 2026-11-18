// fx.js: effect particles, loop emitters, and vector stand-ins for effect sprites that are not in the manifest.
// Positions are world units (see motion.js). The bot gives an env object:
//   env.sprite(kind, n)  -> { img, pivot, w, h } or null      env.view -> { x0, x1, y0, y1 } (world)
//   env.at(name)         -> [x, y] world point: 'mouth', 'top', 'face', 'eyeL', 'eyeR', 'templeL', 'templeR'
//   env.ground           -> world y of the floor               env.rand() -> 0..1
//   env.flash(k)         -> screen flash for lightning         env.umbrella() -> { x, y, w } or null

import { clamp, backOut, TAU } from './motion.js';

const MAX = 300;

// Drawn width in head radii.
const SIZE = {
  heart: 0.28, star: 0.24, note: 0.26, zzz: 0.36, 'idea-bulb': 0.42, question: 0.34, exclaim: 0.3,
  'anger-mark': 0.3, tear: 0.1, 'dizzy-star': 0.17, 'tickle-sparkle': 0.3, 'sneeze-cloud': 0.62, confetti: 0.07,
  blush: 0.3, snowflake: 0.13, raindrop: 0.06, splash: 0.2, 'sweat-drop': 0.13, frost: 0.28, 'breath-puff': 0.36,
  'steam-puff': 0.26, 'heat-wave': 0.36, 'sun-sparkle': 0.24, lightning: 0.8, 'fog-puff': 1.5, dust: 0.22,
  'wind-line': 0.9,
};

const CONFETTI = ['#FF2A57', '#FFC93C', '#3DD6A3', '#4DA3FF', '#B07CFF'];

// Vector stand-ins. Each draws in a box of width w centered on the origin.
const VECTOR = {
  question: (c, w) => glyph(c, '?', w, '#5B8CFF'),
  exclaim: (c, w) => glyph(c, '!', w, '#FF4D5E'),
  zzz: (c, w) => glyph(c, 'z', w, '#8C8CFF'),
  note: (c, w) => glyph(c, '♪', w, '#8C6CFF'),
  'anger-mark': (c, w) => {
    c.strokeStyle = '#FF3B4E'; c.lineWidth = w * 0.13; c.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      c.save(); c.rotate(k * Math.PI / 2);
      c.beginPath(); c.moveTo(w * 0.12, -w * 0.42); c.quadraticCurveTo(w * 0.14, -w * 0.14, w * 0.42, -w * 0.12); c.stroke();
      c.restore();
    }
  },
  tear: (c, w) => drop(c, w, '#7FD3FF'),
  raindrop: (c, w) => drop(c, w, '#3FA9F5'),
  'sweat-drop': (c, w) => drop(c, w, '#9FE7FF'),
  'dizzy-star': (c, w) => star(c, w, '#FFD23F'),
  star: (c, w) => star(c, w, '#FFC93C'),
  'sun-sparkle': (c, w) => sparkle(c, w, '#FFE27A'),
  'tickle-sparkle': (c, w) => sparkle(c, w, '#FFD6E6'),
  heart: (c, w) => {
    c.fillStyle = '#FF3B6B';
    c.beginPath(); c.moveTo(0, w * 0.35);
    c.bezierCurveTo(-w * 0.6, -w * 0.05, -w * 0.3, -w * 0.5, 0, -w * 0.18);
    c.bezierCurveTo(w * 0.3, -w * 0.5, w * 0.6, -w * 0.05, 0, w * 0.35);
    c.fill();
  },
  'sneeze-cloud': (c, w) => puffs(c, w, 'rgba(255,255,255,0.95)', 'rgba(160,175,190,0.6)'),
  'breath-puff': (c, w) => puffs(c, w, 'rgba(240,248,255,0.85)', null),
  'steam-puff': (c, w) => puffs(c, w, 'rgba(255,255,255,0.7)', null),
  'fog-puff': (c, w) => puffs(c, w, 'rgba(230,235,240,0.75)', null),
  dust: (c, w) => puffs(c, w, 'rgba(200,200,200,0.7)', null),
  confetti: (c, w, p) => { c.fillStyle = CONFETTI[p.variant % CONFETTI.length]; c.fillRect(-w / 2, -w * 0.3, w, w * 0.6); },
  snowflake: (c, w) => {
    c.strokeStyle = '#FFFFFF'; c.lineWidth = w * 0.12; c.lineCap = 'round';
    for (let k = 0; k < 3; k++) { c.save(); c.rotate(k * Math.PI / 3); c.beginPath(); c.moveTo(-w / 2, 0); c.lineTo(w / 2, 0); c.stroke(); c.restore(); }
  },
  blush: (c, w) => { c.fillStyle = 'rgba(255,120,160,0.55)'; c.beginPath(); c.ellipse(0, 0, w / 2, w * 0.28, 0, 0, TAU); c.fill(); },
  'wind-line': (c, w) => {
    c.strokeStyle = 'rgba(255,255,255,0.85)'; c.lineWidth = w * 0.025; c.lineCap = 'round';
    c.beginPath(); c.moveTo(-w / 2, 0); c.bezierCurveTo(-w * 0.1, -w * 0.08, w * 0.2, w * 0.06, w / 2, -w * 0.04); c.stroke();
  },
};

function glyph(c, ch, w, color) {
  c.font = `900 ${w * 1.15}px system-ui, sans-serif`;
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = w * 0.12; c.strokeStyle = '#FFFFFF'; c.lineJoin = 'round';
  c.strokeText(ch, 0, 0);
  c.fillStyle = color; c.fillText(ch, 0, 0);
}
function drop(c, w, color) {
  c.fillStyle = color;
  c.beginPath(); c.moveTo(0, -w); c.quadraticCurveTo(w * 0.62, 0, 0, w * 0.5); c.quadraticCurveTo(-w * 0.62, 0, 0, -w); c.fill();
  c.fillStyle = 'rgba(255,255,255,0.7)'; c.beginPath(); c.arc(-w * 0.12, w * 0.05, w * 0.1, 0, TAU); c.fill();
}
function star(c, w, color) {
  c.fillStyle = color; c.beginPath();
  for (let k = 0; k < 10; k++) { const r = k % 2 ? w * 0.22 : w * 0.5; const a = -Math.PI / 2 + k * Math.PI / 5; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  c.closePath(); c.fill();
}
function sparkle(c, w, color) {
  c.fillStyle = color; c.beginPath();
  for (let k = 0; k < 8; k++) { const r = k % 2 ? w * 0.1 : w * 0.5; const a = k * Math.PI / 4; c.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  c.closePath(); c.fill();
}
function puffs(c, w, fill, stroke) {
  c.fillStyle = fill;
  const P = [[-0.22, 0.05, 0.24], [0.02, -0.08, 0.28], [0.25, 0.04, 0.22], [0.05, 0.14, 0.2]];
  c.beginPath(); for (const [x, y, r] of P) { c.moveTo(x * w + r * w, y * w); c.arc(x * w, y * w, r * w, 0, TAU); } c.fill();
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = w * 0.02; c.stroke(); }
}

export class Fx {
  constructor(env) {
    this.env = env;
    this.list = [];
    this.loops = new Map();
    this.enabled = true;
  }

  clear() { this.list.length = 0; }

  push(p) {
    if (!this.enabled) return null;
    const q = {
      kind: p.kind, variant: p.variant ?? 0, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0, rot: 0, vr: 0,
      size: SIZE[p.kind] || 0.25, scale: 1, grow: 0, life: 1, age: 0, delay: 0, layer: 'front', fadeIn: 0.12, fadeOut: 0.3,
      pop: false, sway: 0, swayF: 2, drag: 0, alpha: 1, ...p,
    };
    this.list.push(q);
    if (this.list.length > MAX) this.list.splice(0, this.list.length - MAX);
    return q;
  }

  // One effect by id. opts depend on the id.
  add(kind, opts = {}) {
    if (!this.enabled) return;
    const E = this.env, r = E.rand;
    const top = E.at('top'), mouth = E.at('mouth'), face = E.at('face');
    const side = r() < 0.5 ? -1 : 1;
    const d = opts.delay || 0;
    switch (kind) {
      case 'heart':
        for (let k = 0; k < 3; k++) {
          const s = k === 1 ? 0 : (k === 0 ? -1 : 1);
          this.push({ kind, variant: k % 2, x: s * 0.75, y: face[1] - 0.1, vx: s * 0.12, vy: -0.55 - r() * 0.2, life: 1.8, delay: d + k * 0.18, pop: true, sway: 0.08, rot: s * 0.2 });
        }
        break;
      case 'star':
        for (let k = 0; k < (opts.small ? 2 : 4); k++) {
          const a = -Math.PI / 2 + (k - 1.5) * 0.7;
          this.push({ kind, x: Math.cos(a) * 1.2, y: top[1] * 0.5 + Math.sin(a) * 0.6, vx: Math.cos(a) * 0.5, vy: Math.sin(a) * 0.5, life: 0.9, delay: d + k * 0.05, pop: true, vr: 2 * side, scale: opts.small ? 0.7 : 1 });
        }
        break;
      case 'note':
        this.push({ kind, variant: (r() * 2) | 0, x: side * (0.95 + r() * 0.2), y: face[1] - 0.3, vx: side * 0.15, vy: -0.5, life: 1.7, delay: d, pop: true, sway: 0.12, rot: side * 0.15 });
        break;
      case 'question':
        this.push({ kind, x: 0.85, y: top[1] + 0.15, life: 1.9, delay: d, pop: true, sway: 0.03, swayF: 3, rot: 0.15 });
        break;
      case 'exclaim':
        this.push({ kind, x: -0.85, y: top[1] + 0.2, life: opts.small ? 0.6 : 1.2, delay: d, pop: true, scale: opts.small ? 0.7 : 1, rot: -0.12 });
        break;
      case 'anger-mark':
        this.push({ kind, x: 0.72, y: top[1] + 0.5, life: 1.8, delay: d, pop: true, pulse: 6 });
        break;
      case 'sweat-drop':
        if (opts.fling) this.push({ kind, x: -0.2, y: -0.6, vx: -1.4, vy: -1.0, ay: 4, life: 0.7, delay: d, rot: -0.6, vr: -3 });
        else this.push({ kind, x: 0.72, y: -0.55, vy: 0.12, ay: 0.3, life: 1.6, delay: d, fadeIn: 0.2 });
        break;
      case 'tear':
        for (const e of ['eyeL', 'eyeR']) {
          const p = E.at(e);
          this.push({ kind, x: p[0] + (e === 'eyeL' ? -0.05 : 0.05), y: p[1] + 0.15, vy: 0.3, ay: 2.2, life: 0.75, delay: d, fadeIn: 0.05 });
        }
        break;
      case 'dizzy-star':
        for (let k = 0; k < 3; k++) this.push({ kind, x: 0, y: top[1] + 0.25, orbit: { a: k * TAU / 3, rx: 0.75, ry: 0.16, w: 4 }, life: 1.2, delay: d, fadeIn: 0.1 });
        break;
      case 'zzz':
        this.push({ kind, x: 0.6, y: top[1] + 0.3, vx: 0.25, vy: -0.35, grow: 0.5, life: 2.4, delay: d, sway: 0.06, scale: 0.7 });
        break;
      case 'idea-bulb':
        this.push({ kind, x: 0.05, y: top[1] - 0.25, life: 1.6, delay: d, pop: true, sway: 0.02, swayF: 4, glow: true });
        for (let k = 0; k < 3; k++) this.push({ kind: 'sun-sparkle', x: (k - 1) * 0.35, y: top[1] - 0.45 - (k === 1 ? 0.15 : 0), life: 0.8, delay: d + 0.15 + k * 0.07, pop: true, scale: 0.6 });
        break;
      case 'tickle-sparkle': {
        const x = opts.x ?? (r() - 0.5) * 1.8, y = opts.y ?? face[1] + (r() - 0.6) * 1.2;
        this.push({ kind, x, y, vy: -0.2, life: 0.7, delay: d, pop: true, rot: (r() - 0.5) * 0.8 });
        break;
      }
      case 'sneeze-cloud':
        for (let k = 0; k < 3; k++) {
          this.push({ kind, x: mouth[0] + (k - 1) * 0.12, y: mouth[1] + 0.05, vx: (k - 1) * 0.6 + (r() - 0.5) * 0.2, vy: 0.25 + r() * 0.2, drag: 2.2, grow: 1.4, life: 1.1, delay: d + k * 0.04, fadeIn: 0.03, fadeOut: 0.5, scale: 0.6, rot: (r() - 0.5) * 0.5 });
        }
        break;
      case 'confetti':
        for (let k = 0; k < (opts.n || 20); k++) {
          const a = -Math.PI / 2 + (r() - 0.5) * 2.2, v = 1.6 + r() * 1.6;
          this.push({ kind, variant: k, x: (r() - 0.5) * 0.4, y: top[1] + 0.2, vx: Math.cos(a) * v, vy: Math.sin(a) * v, ay: 2.6, drag: 0.6, rot: r() * 6, vr: (r() - 0.5) * 14, life: 1.8 + r() * 0.6, delay: d, sway: 0.05, swayF: 6, flip: true });
        }
        break;
      case 'dust':
        for (const s of [-1, 1]) this.push({ kind, x: s * 0.45, y: E.ground - 0.05, vx: s * 0.6, vy: -0.1, drag: 3, grow: 0.8, life: 0.6, delay: d, layer: 'back', scale: 0.7 });
        break;
      case 'breath-puff':
        this.push({ kind, x: mouth[0] + 0.15, y: mouth[1] + 0.05, vx: 0.45, vy: -0.12, drag: 0.8, grow: 0.9, life: 1.5, delay: d, scale: 0.55, fadeIn: 0.15, fadeOut: 0.55 });
        break;
      case 'steam-puff':
        this.push({ kind, x: (r() - 0.5) * 0.8, y: top[1] + 0.35, vy: -0.45, grow: 0.5, life: 1.4, delay: d, layer: r() < 0.5 ? 'back' : 'front', sway: 0.06, scale: 0.8 });
        break;
      case 'frost': {
        const a = Math.PI * (0.05 + r() * 0.9) * (r() < 0.5 ? 1 : -1) - Math.PI / 2;
        this.push({ kind, x: Math.cos(a) * 1.0, y: Math.sin(a) * 0.95 - 0.05, rot: a + Math.PI / 2, life: 2.6, delay: d, fadeIn: 0.3, fadeOut: 0.4, pop: true, scale: 0.75 + r() * 0.4 });
        break;
      }
      default:
        if (SIZE[kind]) this.push({ kind, x: opts.x ?? 0, y: opts.y ?? top[1], life: opts.life || 1, delay: d, pop: true });
    }
  }

  // Loop emitters: set the active ids. Unknown ids are skipped.
  setLoops(ids) {
    const want = new Set(ids.filter((id) => LOOPS[id]));
    for (const id of this.loops.keys()) if (!want.has(id)) this.loops.delete(id);
    for (const id of want) if (!this.loops.has(id)) this.loops.set(id, { next: 0, t: 0 });
  }

  update(dt) {
    if (this.enabled) {
      for (const [id, s] of this.loops) {
        s.t += dt;
        while (s.t >= s.next) {
          const gap = LOOPS[id](this, this.env, s);
          s.next += gap > 0 ? gap : 1;
          if (s.next - s.t > 10) break;
        }
      }
    }
    const E = this.env;
    const um = E.umbrella ? E.umbrella() : null;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.delay > 0) { p.delay -= dt; continue; }
      p.age += dt;
      if (p.age >= p.life) { this.list.splice(i, 1); continue; }
      p.vx += p.ax * dt; p.vy += p.ay * dt;
      if (p.drag) { const k = Math.exp(-p.drag * dt); p.vx *= k; p.vy *= k; }
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.wind) p.vx += p.wind * dt;
      if (p.rain) {
        let hit = p.y > E.ground;
        if (!hit && um && Math.abs(p.x - um.x) < um.w / 2 && p.y > um.y && p.y < um.y + 0.3) hit = true;
        if (hit) {
          this.list.splice(i, 1);
          if (E.rand() < 0.35) this.push({ kind: 'splash', x: p.x, y: p.y, life: 0.3, fadeIn: 0, fadeOut: 0.3, seq: true, scale: 0.8, layer: p.layer });
        }
      }
    }
  }

  draw(c, layer, unit) {
    const E = this.env;
    for (const p of this.list) {
      if (p.layer !== layer || p.delay > 0) continue;
      const k = p.age / p.life;
      let a = p.alpha * Math.min(1, p.fadeIn > 0 ? k / p.fadeIn : 1) * Math.min(1, (1 - k) / Math.max(0.001, p.fadeOut));
      if (a <= 0.01) continue;
      let s = p.scale * (1 + p.grow * k);
      if (p.pop) s *= backOut(Math.min(1, p.age / 0.28));
      if (p.pulse) s *= 1 + 0.12 * Math.sin(p.age * p.pulse * TAU / 2);
      let x = p.x, y = p.y;
      if (p.sway) x += Math.sin(p.age * p.swayF * TAU / 2 + p.variant) * p.sway;
      if (p.orbit) {
        const o = p.orbit, ang = o.a + p.age * o.w;
        x += Math.cos(ang) * o.rx; y += Math.sin(ang) * o.ry;
        if (Math.sin(ang) < 0 && layer === 'front') continue;
        if (Math.sin(ang) >= 0 && layer === 'back') continue;
      }
      const w = p.size * s * unit;
      let n = p.variant;
      if (p.seq) n = Math.floor(k * 3);
      const spr = E.sprite(p.kind, n);
      c.save();
      c.globalAlpha = clamp(a);
      c.translate(x * unit, y * unit);
      c.rotate(p.rot);
      if (p.flip) c.scale(1, Math.cos(p.age * 9 + p.variant));
      if (p.glow) { c.shadowColor = 'rgba(255, 230, 120, 0.9)'; c.shadowBlur = w * 0.4; }
      if (spr) {
        const sc = w / spr.w;
        c.drawImage(spr.img, -spr.pivot[0] * sc, -spr.pivot[1] * sc, spr.w * sc, spr.h * sc);
      } else if (VECTOR[p.kind]) {
        VECTOR[p.kind](c, w, p);
      }
      c.restore();
    }
  }
}

// Loop emitters. Each spawns, then returns the seconds until the next call.
const LOOPS = {
  tear: (fx) => { fx.add('tear'); return 0.55; },
  zzz: (fx) => { fx.add('zzz'); return 1.3; },
  'dizzy-star': (fx) => { fx.add('dizzy-star'); return 1.1; },
  heart: (fx) => { fx.add('heart'); return 2.2; },
  'sun-glint': (fx, E) => {
    const v = E.view;
    fx.push({ kind: 'sun-sparkle', x: v.x0 + E.rand() * (v.x1 - v.x0), y: v.y0 + E.rand() * (v.y1 - v.y0) * 0.6, life: 1.1, pop: true, layer: E.rand() < 0.5 ? 'back' : 'front', scale: 0.6 + E.rand() * 0.6, vr: 1 });
    return 0.35;
  },
  'hot-sweat': (fx, E) => {
    const s = E.rand() < 0.5 ? -1 : 1;
    fx.push({ kind: 'sweat-drop', x: s * (0.62 + E.rand() * 0.15), y: -0.6 + E.rand() * 0.2, vy: 0.1, ay: 0.35, life: 1.6, fadeIn: 0.2 });
    return 0.9;
  },
  'hot-shimmer': (fx, E) => {
    fx.push({ kind: 'heat-wave', x: (E.rand() - 0.5) * 2.4, y: E.ground - 0.1, vy: -0.5, life: 1.8, grow: 0.3, layer: 'back', fadeIn: 0.3, fadeOut: 0.5, alpha: 0.75 });
    return 0.55;
  },
  'cold-frost': (fx) => { fx.add('frost'); return 1.2; },
  'cold-breath': (fx) => { fx.add('breath-puff'); return 1.7; },
  rain: (fx, E) => {
    const v = E.view;
    for (let k = 0; k < 3; k++) {
      const front = E.rand() < 0.55;
      fx.push({ kind: 'raindrop', x: v.x0 + E.rand() * (v.x1 - v.x0), y: v.y0 - 0.2, vx: E.windX || 0, vy: 5 + E.rand() * 1.5, life: 2, fadeIn: 0.02, fadeOut: 0.02, rain: true, layer: front ? 'front' : 'back', scale: front ? 1 : 0.75, rot: -(E.windX || 0) * 0.12 });
    }
    return 0.06;
  },
  snow: (fx, E) => {
    const v = E.view;
    const front = E.rand() < 0.5;
    fx.push({ kind: 'snowflake', variant: (E.rand() * 3) | 0, x: v.x0 + E.rand() * (v.x1 - v.x0), y: v.y0 - 0.1, vy: 0.45 + E.rand() * 0.3, vr: (E.rand() - 0.5) * 2, sway: 0.12, swayF: 1.2, life: 9, fadeOut: 0.05, layer: front ? 'front' : 'back', scale: front ? 1 + E.rand() * 0.4 : 0.7 });
    return 0.13;
  },
  lightning: (fx, E) => {
    const s = E.rand() < 0.5 ? -1 : 1;
    fx.push({ kind: 'lightning', x: s * (1.1 + E.rand() * 0.4), y: E.view.y0 + 0.1, life: 0.45, fadeIn: 0, fadeOut: 0.6, layer: 'back', rot: -s * 0.15, scale: 0.9 + E.rand() * 0.4 });
    E.flash(1);
    return 2.4 + E.rand() * 2.8;
  },
  'wind-lines': (fx, E) => {
    const v = E.view;
    const front = E.rand() < 0.5;
    fx.push({ kind: E.rand() < 0.75 ? 'wind-line' : 'breath-puff', x: v.x0 - 0.4, y: v.y0 + E.rand() * (v.y1 - v.y0) * 0.85, vx: 3.2 + E.rand() * 1.4, life: 1.8, fadeIn: 0.1, fadeOut: 0.3, layer: front ? 'front' : 'back', scale: 0.6 + E.rand() * 0.5, alpha: 0.85 });
    return 0.22;
  },
  fog: (fx, E) => {
    const v = E.view;
    const front = E.rand() < 0.45;
    const s = E.rand() < 0.5 ? -1 : 1;
    fx.push({ kind: 'fog-puff', x: s > 0 ? v.x0 - 0.6 : v.x1 + 0.6, y: v.y0 + (0.25 + E.rand() * 0.7) * (v.y1 - v.y0), vx: s * (0.25 + E.rand() * 0.2), life: 9, fadeIn: 0.25, fadeOut: 0.3, layer: front ? 'front' : 'back', scale: 0.7 + E.rand() * 0.6, alpha: front ? 0.35 : 0.65 });
    return 0.9;
  },
};

export const LOOP_IDS = Object.keys(LOOPS);
