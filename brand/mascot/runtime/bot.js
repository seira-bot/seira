// bot.js: the seira.bot runtime. It animates generated image frames on a 2D canvas (CONTRACT.md, "Runtime").
//
//   import { createBot, EYES, MOUTHS, EXPRESSIONS, ACTIONS, STATES, WEATHER } from './runtime/bot.js';
//   const bot = await createBot(el, config, { bases, stickers, baseUrl });
//
// Draw order: shadow, back effects, base frame (hair recolored), face on the visor (clipped by the visor mask,
// squeezed by cos(yaw), moved with the visor), accessories, hands, front effects.

import {
  EYES as EYE_DEFS, MOUTHS as MOUTH_DEFS, EXPRESSIONS as EXPR_DEFS, ACTIONS as ACTION_DEFS, STATES as STATE_DEFS,
  WEATHER as WEATHER_DEFS, FACES, PERSONALITY, DEFAULT_CONFIG, DEFAULT_HAIR, DEFAULT_SHELL,
} from './catalog.js';
import { drawFace, drawGloss, FW, FH, LAYOUT } from './face.js';
import { resolveManifest, fileUrl, loadImage, alphaMask, canvas } from './assets.js';
import { recolorFrame } from './recolor.js';
import { newPose, mixPose, idleMotion, MOTIONS, HAND_POSES, clamp, lerp, smooth, ramp, TAU } from './motion.js';
import { ACTION_FNS } from './actions.js';
import { Fx } from './fx.js';
import { Weather } from './weather.js';
import { attachInteraction } from './interact.js';

const list = (o) => Object.entries(o).map(([id, v]) => ({ id, label: v.label || id }));
export const EYES = list(EYE_DEFS);
export const MOUTHS = list(MOUTH_DEFS);
export const EXPRESSIONS = list(EXPR_DEFS);
export const ACTIONS = list(ACTION_DEFS);
export const STATES = list(STATE_DEFS);
export const WEATHER = list(WEATHER_DEFS);
export { DEFAULT_CONFIG };

// Yaw of each turn view. Negative yaw mirrors these. 'up' and 'down' are front views for pitch.
const YAW_VIEWS = [['front', 0], ['yaw20', 20], ['yaw45', 45], ['side', 90], ['back', 180]];
// The world box that the canvas shows (head radii, origin = head pivot, +y down).
const BOX = { x0: -1.9, x1: 1.9, y0: -2.05, y1: 2.0 };
const GROUND = 1.82;
const DEG = Math.PI / 180;
const SLOTS_MAX = 3;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sanitizeConfig(base, partial) {
  const c = { ...base, ...partial };
  if (!Array.isArray(c.accessories)) c.accessories = [];
  c.accessories = c.accessories.slice(0, SLOTS_MAX);
  if (!PERSONALITY[c.personality]) c.personality = 'calm';
  return c;
}

// ---- Asset sets -----------------------------------------------------------------------------

async function loadStyle(bases, styleId) {
  const data = bases.data;
  const def = data && data.styles && (data.styles[styleId] || data.styles.seira || Object.values(data.styles)[0]);
  if (!def) return null;
  const id = data.styles[styleId] ? styleId : Object.keys(data.styles).find((k) => data.styles[k] === def);
  const views = {};
  await Promise.all(Object.entries(def.views || {}).map(async ([name, v]) => {
    const [img, hair, visor] = await Promise.all([
      loadImage(fileUrl(bases.root, v.file)),
      loadImage(fileUrl(bases.root, v.hair)),
      loadImage(fileUrl(bases.root, v.visor)),
    ]);
    if (!img) return;
    const size = data.size || [img.naturalWidth, img.naturalHeight];
    const mask = visor ? alphaMask(visor, fileUrl(bases.root, v.visor)) : null;
    views[name] = {
      name, img, hair, mask,
      pivot: v.pivot || [size[0] / 2, size[1] * 0.44],
      r: v.r || size[0] * 0.29,
      anchors: v.anchors || {},
      visorBox: (mask && mask.box) || v.visorBox || null,
      key: fileUrl(bases.root, v.file),
      yaw: v.measuredYaw ?? (YAW_VIEWS.find(([n]) => n === name) || [0, 0])[1],
    };
  }));
  return { id, def, recolor: !!def.recolor, views };
}

async function loadStickers(st) {
  const out = { hands: {}, acc: {}, fx: {} };
  const d = st.data;
  if (!d) return out;
  const jobs = [];
  for (const [g, h] of Object.entries(d.hands || {})) {
    jobs.push(loadImage(fileUrl(st.root, h.file)).then((img) => {
      if (img) out.hands[g] = { img, pivot: h.pivot || [img.width / 2, img.height], w: img.naturalWidth, h: img.naturalHeight, width: h.width || 0.8 };
    }));
  }
  for (const [id, a] of Object.entries(d.accessories || {})) {
    out.acc[id] = { def: a, img: null, files: {} };
    jobs.push(loadImage(fileUrl(st.root, a.file)).then((img) => { out.acc[id].img = img; }));
    for (const [view, f] of Object.entries(a.files || {})) {
      jobs.push(loadImage(fileUrl(st.root, f)).then((img) => { if (img) out.acc[id].files[view] = img; }));
    }
  }
  for (const [id, f] of Object.entries(d.fx || {})) {
    const frames = f.frames || (f.file ? [f.file] : []);
    jobs.push(Promise.all(frames.map((u) => loadImage(fileUrl(st.root, u)))).then((imgs) => {
      const ok = imgs.filter(Boolean);
      if (ok.length) out.fx[id] = { imgs: ok, pivot: f.pivot || [ok[0].naturalWidth / 2, ok[0].naturalHeight / 2], mode: f.mode || 'single' };
    }));
  }
  await Promise.all(jobs);
  return out;
}

// ---- The bot --------------------------------------------------------------------------------

export async function createBot(el, config = {}, options = {}) {
  const opt = options || {};
  const [bases, stickersSrc] = await Promise.all([
    resolveManifest(opt.bases || (opt.baseUrl ? 'bases/manifest.json' : null), opt.baseUrl, 'bases'),
    resolveManifest(opt.stickers || (opt.baseUrl ? 'stickers/manifest.json' : null), opt.baseUrl, 'stickers'),
  ]);
  let cfg = sanitizeConfig(DEFAULT_CONFIG, config);
  const [style0, stickers] = await Promise.all([loadStyle(bases, cfg.style), loadStickers(stickersSrc)]);
  let style = style0;

  // Canvas setup.
  const ownCanvas = !(el instanceof HTMLCanvasElement);
  const cv = ownCanvas ? document.createElement('canvas') : el;
  if (ownCanvas) {
    cv.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;';
    cv.setAttribute('role', 'img');
    el.appendChild(cv);
  }
  cv.setAttribute('aria-label', cfg.name || 'Bot');
  const ctx = cv.getContext('2d');
  const layer = canvas(1, 1), lctx = layer.getContext('2d');
  const maskL = canvas(1, 1), mctx = maskL.getContext('2d');
  const faceL = canvas(1, 1), flctx = faceL.getContext('2d');
  const faceC = canvas(1, 1), fctx = faceC.getContext('2d');
  let W = 1, H = 1, unit = 1, ox = 0, oy = 0;

  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reduced = opt.reduced ?? (mq ? mq.matches : false);
  const onMq = () => { if (opt.reduced === undefined) setReduced(mq.matches); };
  if (mq && mq.addEventListener) mq.addEventListener('change', onMq);

  const rand = mulberry(opt.seed ?? ((Math.random() * 1e9) | 0));
  const listeners = {};
  const emit = (ev, data) => (listeners[ev] || []).forEach((fn) => { try { fn(data); } catch (err) { console.error(err); } });

  // Runtime state.
  let P = PERSONALITY[cfg.personality];
  let t = 0;                     // seconds
  let expr = { id: 'calm', until: Infinity };
  let tempFace = null;           // { id, until }
  let state = 'idle';
  const weather = new Weather();
  let action = null;             // { id, fn, t0, ms, resolve, ctx }
  let talkTarget = 0, talkLevel = 0, talkAt = -1e9;
  let lookTarget = null;         // explicit [x, y]
  let pointer = null;            // [x, y] world
  let yawLock = null;
  let flash = 0;
  let tickleCount = 0, tickleAt = -1e9;
  const blink = { next: 1.5, t0: -1 };
  const glance = { next: 2, x: 0, y: 0, yaw: 0 };
  const look = { yaw: 0, pitch: 0, ex: 0, ey: 0 };
  let handsCur = HAND_POSES.rest(0);
  let faceCur = null;            // smoothed face numbers
  let faceShown = null;          // discrete face fields
  let swap = { t0: -1, next: null };
  let lastFaceKey = '';
  let lastPose = newPose();
  let viewsNow = [];
  let destroyed = false;
  let lastDebug = null;

  // ---- Effects environment ----
  const fx = new Fx({
    rand,
    get view() { return BOX; },
    get ground() { return GROUND; },
    get windX() { return weather.wind * 1.6; },
    sprite(kind, n) {
      const s = stickers.fx[kind];
      if (!s) return null;
      const img = s.imgs[(n | 0) % s.imgs.length];
      return { img, pivot: s.pivot, w: img.naturalWidth, h: img.naturalHeight };
    },
    at: (name) => anchorWorld(name),
    flash(k) {
      flash = Math.max(flash, k);
      if (weather.id === 'storm' && !action) shake = 0.35;
    },
    umbrella: () => umbrellaBox,
  });
  fx.enabled = !reduced;
  let shake = 0;
  let umbrellaBox = null;

  // ---- Geometry helpers ----
  function resize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cw = Math.max(1, Math.round((cv.clientWidth || cv.width || 300) * dpr));
    const ch = Math.max(1, Math.round((cv.clientHeight || cv.height || 300) * dpr));
    if (cw === W && ch === H) return;
    W = cw; H = ch;
    cv.width = W; cv.height = H;
    for (const c of [layer, maskL, faceL]) { c.width = W; c.height = H; }
    const bw = BOX.x1 - BOX.x0, bh = BOX.y1 - BOX.y0;
    unit = Math.min(W / bw, H / bh);
    ox = W / 2 - ((BOX.x0 + BOX.x1) / 2) * unit;
    oy = H / 2 - ((BOX.y0 + BOX.y1) / 2) * unit;
  }

  function toWorld(cx, cy) {
    const r = cv.getBoundingClientRect();
    const sx = W / Math.max(1, r.width), sy = H / Math.max(1, r.height);
    return [((cx - r.left) * sx - ox) / unit, ((cy - r.top) * sy - oy) / unit];
  }

  // View choice: the nearest frame for the yaw and the pitch. The current frame stays for a few more degrees
  // (hysteresis), and a change cross-fades over VIEW_FADE seconds. A pose that rests between two frames
  // then shows one frame, not a double image.
  const VIEW_FADE = 0.11;
  const view = { cur: null, prev: null, k: 1 };
  const wrap = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
  const viewKey = (s) => (s ? s.name + (s.mirror ? '~' : '') : '');

  function targetView(yaw, pitch) {
    const vs = style ? style.views : {};
    const y = wrap(yaw), a = Math.abs(y);
    const cur = view.cur;
    const pn = pitch < 0 ? 'up' : 'down';
    const inPitch = cur && (cur.name === 'up' || cur.name === 'down');
    if (vs[pn] && Math.abs(pitch) > (inPitch ? 0.42 : 0.55) && a < (inPitch ? 32 : 26)) return { name: pn, mirror: false };
    const avail = YAW_VIEWS.filter(([n]) => vs[n]);
    if (!avail.length) {
      const n = Object.keys(vs)[0];
      return n ? { name: n, mirror: false } : null;
    }
    let best = avail[0], bd = Infinity;
    for (const e of avail) {
      const d = Math.abs(a - e[1]) - (cur && cur.name === e[0] ? 4 : 0);
      if (d < bd) { bd = d; best = e; }
    }
    return { name: best[0], mirror: y < 0 && best[1] > 0 && best[1] < 180 };
  }

  function updateView(dt, yaw, pitch) {
    const tv = targetView(yaw, pitch);
    if (viewKey(tv) !== viewKey(view.cur)) {
      view.prev = view.prev && view.k < 0.5 ? view.prev : view.cur;
      view.cur = tv;
      view.k = view.prev ? 0 : 1;
    }
    view.k = reduced ? 1 : Math.min(1, view.k + dt / VIEW_FADE);
    if (view.k >= 1) view.prev = null;
  }

  // The frames to draw now, with weights that sum to 1.
  function currentViews() {
    const vs = style ? style.views : {};
    const out = [];
    const add = (s, w) => {
      if (s && vs[s.name] && w > 0.001) out.push({ v: vs[s.name], w, mirror: s.mirror, yaw: (s.mirror ? -1 : 1) * (vs[s.name].yaw || 0) });
    };
    const k = smooth(view.k);
    if (view.prev && k < 1) { add(view.prev, 1 - k); add(view.cur, k); } else add(view.cur, 1);
    if (!out.length) {
      const any = Object.values(vs)[0];
      if (any) out.push({ v: any, w: 1, mirror: false, yaw: 0 });
    }
    const sum = out.reduce((m, o) => m + o.w, 0) || 1;
    for (const o of out) o.w /= sum;
    return out;
  }

  // View pixel -> world (before the head transform).
  function viewToWorld(v, mirror, px, py) {
    const x = (px - v.pivot[0]) / v.r, y = (py - v.pivot[1]) / v.r;
    return [mirror ? -x : x, y];
  }

  function frontVisor() {
    const v = style && (style.views.front || style.views.yaw20 || Object.values(style.views)[0]);
    if (v && v.visorBox) {
      const [x, y, w, h] = v.visorBox;
      const c = viewToWorld(v, false, x + w / 2, y + h / 2);
      return { cx: c[0], cy: c[1], w: w / v.r, h: h / v.r };
    }
    return { cx: 0, cy: -0.05, w: 1.5, h: 0.95 };
  }

  // Face placement in head space: center and world size of one face canvas pixel.
  function facePlace(views, yaw, pitch) {
    const fv = frontVisor();
    let sx = 0, sy = 0, sw = 0;
    for (const o of views) {
      if (!o.v.visorBox || !o.v.mask) continue;
      const [x, y, w, h] = o.v.visorBox;
      const c = viewToWorld(o.v, o.mirror, x + w / 2, y + h / 2);
      sx += c[0] * o.w; sy += c[1] * o.w; sw += o.w;
    }
    const y0 = wrap(yaw);
    let cx = sw > 0 ? sx / sw : fv.cx + Math.sin(y0 * DEG) * 0.88;
    let cy = sw > 0 ? sy / sw : fv.cy - pitch * 0.2;
    // Between two frames the face keeps moving: the rest of the turn moves it on the head sphere.
    if (sw > 0) {
      for (const o of views) {
        const pv = o.v.name === 'up' || o.v.name === 'down';
        cx += o.w * 0.88 * (Math.sin(y0 * DEG) - Math.sin((pv ? 0 : o.yaw) * DEG));
        if (!pv) cy += o.w * pitch * 0.16;
      }
    }
    return { cx, cy, k: fv.w / FW, squeeze: Math.max(0.05, Math.cos(y0 * DEG)), pitchSq: 1 - Math.abs(pitch) * 0.06, vis: sw };
  }

  // A named point in world space (for effects and accessories). Uses the last drawn pose.
  function anchorWorld(name) {
    const p = lastPose;
    const head = (x, y) => {
      const c = Math.cos(p.roll), s = Math.sin(p.roll);
      return [x * c - y * s + p.hx + p.bx, x * s + y * c + p.hy + p.by];
    };
    if (name === 'face' || name === 'eyeL' || name === 'eyeR' || name === 'eyes') {
      const fp = facePlace(viewsNow, p.yaw, p.pitch);
      const ey = fp.cy + (LAYOUT.cy - FH / 2) * fp.k;
      if (name === 'face') return head(fp.cx, fp.cy);
      if (name === 'eyes') return head(fp.cx, ey);
      const i = name === 'eyeL' ? 0 : 1;
      return head(fp.cx + (LAYOUT.cx[i] - FW / 2) * fp.k * fp.squeeze, ey);
    }
    const a = viewAnchor(name);
    if (a) return head(a[0], a[1]);
    const def = { mouth: [0, 0.42], top: [0, -1.25], neck: [0, 1.08], earL: [-1, 0.05], earR: [1, 0.05], templeL: [-0.95, -0.2], templeR: [0.95, -0.2], cheekL: [-0.62, 0.3], cheekR: [0.62, 0.3] };
    const d = def[name] || [0, 0];
    return head(d[0], d[1]);
  }

  function viewAnchor(name) {
    let x = 0, y = 0, w = 0;
    for (const o of viewsNow) {
      // In a mirrored view the left and right anchors swap.
      const n = o.mirror ? name.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R') : name;
      const a = o.v.anchors[n];
      if (!a) continue;
      const c = viewToWorld(o.v, o.mirror, a[0], a[1]);
      x += c[0] * o.w; y += c[1] * o.w; w += o.w;
    }
    return w > 0 ? [x / w, y / w] : null;
  }

  // ---- Face composition ----
  function faceSpec(id) {
    if (!id) return FACES.calm;
    if (typeof id === 'object') return id;
    return FACES[id] || FACES.calm;
  }

  function currentFaceId() {
    if (action && action.face) return action.face;
    if (tempFace && t < tempFace.until) return tempFace.id;
    if (expr.id !== 'calm' && t < expr.until) return expr.id;
    const st = STATE_DEFS[state];
    if (st && st.face) return st.face;
    if (weather.face) return weather.face;
    return 'calm';
  }

  function targetFace(spec) {
    const eyesOf = (v) => (!v || v === 'base' ? cfg.eyes : v);
    const lid0 = { in: P.lid || 0, out: P.lid || 0, low: 0 };
    const lid = spec.lid ? { in: spec.lid.in || 0, out: spec.lid.out || 0, low: spec.lid.low || 0 } : lid0;
    const sc = Array.isArray(spec.scale) ? spec.scale : [spec.scale || 1, spec.scale || 1];
    return {
      eyes: [eyesOf(spec.eyesL || spec.eyes), eyesOf(spec.eyesR || spec.eyes)],
      mouth: spec.dots ? 'flat' : spec.mouth || cfg.mouth,
      tint: spec.tint || null, marks: spec.marks || null, dots: !!spec.dots,
      lidIn: lid.in, lidOut: lid.out, lidLow: lid.low,
      s0: sc[0], s1: sc[1],
      lx: (spec.look ? spec.look[0] : 0), ly: (spec.look ? spec.look[1] : 0),
      blush: Math.max(spec.blush || 0, cfg.blush ? 0.45 : 0),
      tears: spec.tears || 0, sweat: spec.sweat || 0, brow: spec.brow || 0,
    };
  }

  const NUMS = ['lidIn', 'lidOut', 'lidLow', 's0', 's1', 'lx', 'ly', 'blush', 'tears', 'sweat', 'brow'];
  const DISCRETE = ['eyes', 'mouth', 'tint', 'marks', 'dots'];

  function updateFace(dt, spec) {
    const tg = targetFace(spec);
    if (!faceCur) { faceCur = { ...tg }; faceShown = { ...tg }; }
    const k = reduced ? 1 : 1 - Math.exp(-dt * 14);
    for (const n of NUMS) faceCur[n] = lerp(faceCur[n], tg[n], k);
    const key = DISCRETE.map((n) => JSON.stringify(tg[n])).join('|');
    const shownKey = DISCRETE.map((n) => JSON.stringify(faceShown[n])).join('|');
    if (key !== shownKey) {
      if (reduced) { for (const n of DISCRETE) faceShown[n] = tg[n]; }
      else if (swap.t0 < 0) swap = { t0: t, next: tg };
    }
    if (swap.t0 >= 0) {
      const q = (t - swap.t0) / 0.16;
      if (q >= 0.5 && swap.next) { for (const n of DISCRETE) faceShown[n] = swap.next[n]; swap.next = null; }
      if (q >= 1) swap.t0 = -1;
    }
  }

  function blinkAmount() {
    if (reduced) return 0;
    if (t >= blink.next && blink.t0 < 0) blink.t0 = t;
    if (blink.t0 >= 0) {
      const q = (t - blink.t0) / 0.15;
      if (q >= 1) {
        blink.t0 = -1;
        const [a, b] = P.blink;
        blink.next = t + (rand() < 0.15 ? 0.22 : (a + rand() * (b - a)) / 1000);
        return 0;
      }
      return Math.sin(q * Math.PI);
    }
    return 0;
  }

  function faceState(dt) {
    const b = blinkAmount();
    const fc = faceCur, fs = faceShown;
    const swapSq = swap.t0 >= 0 ? Math.sin(clamp((t - swap.t0) / 0.16) * Math.PI) : 0;
    talkLevel = lerp(talkLevel, talkTarget, 1 - Math.exp(-dt * 25));
    let talk = talkLevel;
    if (state === 'talking' && t - talkAt > 0.3) talk = 0.5 + 0.5 * Math.sin(t * 11) * Math.sin(t * 4.3 + 1);
    const lid = { in: fc.lidIn, out: fc.lidOut, low: fc.lidLow };
    return {
      color: cfg.eyeColor, screen: cfg.screen, lashes: cfg.lashes !== false, brows: cfg.brows || 'none',
      eyes: fs.eyes, open: [1 - b * 0.92, 1 - b * 0.92], lid: [lid, lid], scale: [fc.s0, fc.s1],
      look: [(fc.lx + look.ex) * 48, (fc.ly + look.ey) * 36],
      mouth: fs.mouth, talk: clamp(talk), blush: fc.blush, tears: fc.tears, sweat: fc.sweat, tint: fs.tint,
      brow: fc.brow, marks: fs.marks, dots: fs.dots, anim: t, flash, mouthDX: 0, squash: swapSq,
    };
  }

  // ---- Pose ----
  function step(dt) {
    t += dt;
    flash = Math.max(0, flash - dt * 4);
    shake = Math.max(0, shake - dt);

    // Action progress.
    let ar = null, aw = 0;
    if (action) {
      const p = (t - action.t0) / (action.ms / 1000);
      if (p >= 1) {
        const done = action;
        action = null;
        done.resolve();
      } else {
        action.ctx.t = t - action.t0;
        try { ar = action.fn(clamp(p), action.ctx); } catch (err) { console.error(err); ar = null; }
        action.face = ar && ar.face;
        const e = (ar && ar.edge) || 0.1;
        aw = ramp(p, 0, e) * (1 - ramp(p, 1 - e, 1));
        if (p < e) aw = Math.max(aw, 0.001);
      }
    }
    if (!action) {
      const due = weather.update(dt, !!action);
      if (due) bot.play(due);
    }

    // Face.
    const fid = currentFaceId();
    const spec = faceSpec(fid);
    const fkey = typeof fid === 'string' ? fid : JSON.stringify(fid);
    if (fkey !== lastFaceKey) {
      lastFaceKey = fkey;
      if (spec.fx) fx.add(spec.fx);
    }
    updateFace(dt, spec);

    // Base pose.
    const pose = newPose();
    const st = STATE_DEFS[state] || {};
    const hp = HAND_POSES[weather.hands || st.hands || 'rest'] || HAND_POSES.rest;
    const target = hp(t);
    const hk = 1 - Math.exp(-dt * 9);
    for (const s of ['L', 'R']) {
      const a = handsCur[s], b = target[s];
      if (!a || !b) { handsCur[s] = b ? { ...b } : null; continue; }
      handsCur[s] = { g: b.g, x: lerp(a.x, b.x, hk), y: lerp(a.y, b.y, hk), rot: lerp(a.rot, b.rot, hk), s: lerp(a.s, b.s, hk), a: 1 };
    }
    pose.hands = { L: handsCur.L && { ...handsCur.L }, R: handsCur.R && { ...handsCur.R } };

    if (!reduced) {
      idleMotion(pose, t, P);
      const motions = [spec.motion, st.motion, weather.motion].filter(Boolean);
      for (const m of new Set(motions)) if (MOTIONS[m]) MOTIONS[m](pose, t, P);
      if (st.lean) pose.pitch -= st.lean * 2;
      if (shake > 0) { pose.bx += Math.sin(t * 60) * 0.02 * shake; pose.by += 0.02 * shake; }
    }
    if (spec.head && !reduced) {
      pose.pitch += (spec.head.rx || 0) / 0.26;
      pose.yaw += (spec.head.ry || 0) / DEG;
      pose.roll += spec.head.rz || 0;
    }

    // Looking: explicit target, pointer, or idle glances.
    let lx = 0, ly = 0;
    const tgt = lookTarget || pointer;
    if (tgt) {
      lx = clamp(tgt[0] / 1.6, -1, 1);
      ly = clamp((tgt[1] + 0.1) / 1.6, -1, 1);
      if (P.avoid && !lookTarget) lx *= -0.6;
    } else if (!reduced) {
      if (t >= glance.next) {
        const big = rand() < P.glance;
        glance.x = big ? (rand() - 0.5) * 1.6 : (rand() - 0.5) * 0.5;
        glance.y = big ? (rand() - 0.5) * 0.8 : (rand() - 0.5) * 0.3;
        glance.next = t + 1.6 + rand() * 3.4 / P.speed;
      }
      lx = glance.x * 0.6; ly = glance.y * 0.6;
    }
    const lk = 1 - Math.exp(-dt * (tgt ? 7 : 3.5));
    look.ex = lerp(look.ex, lx * 0.85, lk);
    look.ey = lerp(look.ey, ly * 0.8, lk);
    look.yaw = lerp(look.yaw, reduced ? 0 : lx * 30, lk);
    look.pitch = lerp(look.pitch, reduced ? 0 : ly * 0.55, lk);
    pose.yaw += look.yaw;
    pose.pitch += look.pitch;
    if (yawLock !== null) pose.yaw = yawLock;

    // Action changes, faded in and out.
    let final = pose;
    if (ar && aw > 0) {
      const w = reduced ? 0 : aw;
      const d = ar.d || {};
      final = { ...pose, hands: { ...pose.hands } };
      for (const n of ['yaw', 'pitch', 'roll', 'hx', 'hy', 'bx', 'by', 'brot']) if (d[n]) final[n] += d[n] * w;
      if (d.sx) final.sx *= lerp(1, d.sx, w);
      if (d.sy) final.sy *= lerp(1, d.sy, w);
      if (ar.shadow !== undefined) final.shadow = lerp(1, ar.shadow, w);
      if (ar.hands && w > 0) final = mixPose(final, { hands: ar.hands, handsBehind: ar.behind }, w);
      // Hands that an action moves keep their last place, so the return to rest is smooth.
      if (ar.hands && w > 0.9) for (const s of ['L', 'R']) if (ar.hands[s] && final.hands[s]) handsCur[s] = { ...final.hands[s] };
    }
    if (!cfg.hands) final.hands = { L: null, R: null };
    if (reduced) { final.yaw = yawLock ?? 0; final.pitch = 0; final.roll = 0; }
    final.pitch = clamp(final.pitch, -1, 1);
    final.flash = flash;

    // Loop effects.
    const loops = [...weather.loops];
    if (spec.fxLoop) loops.push(spec.fxLoop);
    fx.setLoops(loops);
    fx.update(dt);

    updateView(dt, final.yaw, final.pitch);
    lastPose = final;
    return final;
  }

  // ---- Drawing ----
  function frameImage(v) {
    if (!style) return v.img;
    let hair = cfg.hairColor || null;
    if (!hair && style.recolor) hair = DEFAULT_HAIR;
    const shell = cfg.shell && cfg.shell.toLowerCase() !== DEFAULT_SHELL.toLowerCase() ? cfg.shell : null;
    if (!hair && !shell) return v.img;
    return recolorFrame(v.img, v.hair, { hair, shell, key: v.key });
  }

  function bodyTransform(c, p) {
    c.setTransform(unit, 0, 0, unit, ox, oy);
    c.translate(p.bx, p.by);
    c.translate(0, 1.25);
    c.rotate(p.brot);
    c.scale(p.sx, p.sy);
    c.translate(0, -1.25);
  }
  function headTransform(c, p) {
    bodyTransform(c, p);
    c.translate(p.hx, p.hy);
    c.rotate(p.roll);
  }
  function viewTransform(c, v, mirror) {
    if (mirror) c.scale(-1, 1);
    c.scale(1 / v.r, 1 / v.r);
    c.translate(-v.pivot[0], -v.pivot[1]);
  }

  function drawHands(c, p) {
    for (const s of ['L', 'R']) {
      const h = p.hands[s];
      if (!h || (h.a ?? 1) <= 0.01) continue;
      const spr = stickers.hands[h.g] || stickers.hands.open;
      if (!spr) continue;
      bodyTransform(c, p);
      c.translate(h.x, h.y);
      c.rotate(h.rot);
      if (s === 'R') c.scale(-1, 1);
      const sc = (spr.width * h.s) / spr.w;
      c.scale(sc, sc);
      c.globalAlpha = h.a ?? 1;
      c.drawImage(spr.img, -spr.pivot[0], -spr.pivot[1]);
      c.globalAlpha = 1;
    }
  }

  function activeAccessories() {
    const ids = [...cfg.accessories];
    for (const a of weather.acc) if (!ids.includes(a)) ids.push(a);
    const seen = new Set();
    return ids.filter((id) => {
      const a = stickers.acc[id];
      if (!a || !a.img) return false;
      const slot = a.def.slot || id;
      if (seen.has(slot)) return false;
      seen.add(slot);
      return true;
    });
  }

  function drawAccessories(c, p) {
    const dom = viewsNow.reduce((m, o) => (!m || o.w > m.w ? o : m), null);
    for (const id of activeAccessories()) {
      const a = stickers.acc[id];
      const def = a.def;
      const views = def.views || ['front'];
      let vis = 0;
      for (const o of viewsNow) if (views.includes(o.v.name) || a.files[o.v.name]) vis += o.w;
      if (vis < 0.02) continue;
      const anchor = def.anchor || 'top';
      let pt;
      if (anchor === 'eyes' || anchor === 'face') {
        const fp = facePlace(viewsNow, p.yaw, p.pitch);
        pt = [fp.cx, anchor === 'eyes' ? fp.cy + (LAYOUT.cy - FH / 2) * fp.k : fp.cy];
      } else {
        pt = viewAnchor(anchor);
      }
      if (!pt) continue;
      // A view file (for example glasses.yaw45) already shows the turn. The front file gets squeezed instead.
      const vname = dom && a.files[dom.v.name] ? dom.v.name : null;
      const img = vname ? a.files[vname] : a.img;
      const pv = (vname && def.pivots && def.pivots[vname]) || def.pivot || [img.naturalWidth / 2, img.naturalHeight / 2];
      const width = (vname && def.widths && def.widths[vname]) || def.width || 1;
      const y0 = ((((p.yaw + 180) % 360) + 360) % 360) - 180;
      const squeeze = !vname && (anchor === 'eyes' || anchor === 'mouth') ? Math.max(0.2, Math.cos(y0 * DEG)) : 1;
      const sc = width / img.naturalWidth;
      headTransform(c, p);
      c.translate(pt[0], pt[1]);
      c.scale(sc * squeeze * (vname && dom.mirror ? -1 : 1), sc);
      c.globalAlpha = clamp(vis);
      c.drawImage(img, -pv[0], -pv[1]);
      c.globalAlpha = 1;
    }
  }

  // The umbrella leans on the shoulder behind the head. The hand in front holds the shaft.
  const UMB = { width: 3.4, tilt: -0.42 };
  function drawUmbrella(c, p) {
    umbrellaBox = null;
    if (weather.prop !== 'umbrella') return;
    const s = stickers.fx.umbrella;
    if (!s) return;
    const h = p.hands.R;
    const hx = h ? h.x : 0.78, hy = h ? h.y : 0.6;
    const img = s.imgs[0];
    const sc = UMB.width / img.naturalWidth;
    bodyTransform(c, p);
    c.translate(hx, hy);
    c.rotate(UMB.tilt);
    c.scale(sc, sc);
    c.drawImage(img, -s.pivot[0], -s.pivot[1]);
    // Top of the canopy in world space, for the rain.
    const up = (s.pivot[1] - img.naturalHeight * 0.06) * sc;
    umbrellaBox = { x: hx + Math.sin(UMB.tilt) * up + p.bx, y: hy - Math.cos(UMB.tilt) * up + p.by, w: UMB.width * 0.85 };
  }

  function render() {
    resize();
    const p = lastPose;
    viewsNow = currentViews();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Shadow.
    ctx.setTransform(unit, 0, 0, unit, ox, oy);
    const sk = clamp(p.shadow ?? 1, 0.2, 1.2);
    const g = ctx.createRadialGradient(p.bx, GROUND, 0, p.bx, GROUND, 1.2 * sk);
    g.addColorStop(0, 'rgba(20, 24, 32, 0.20)');
    g.addColorStop(1, 'rgba(20, 24, 32, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(p.bx, GROUND, 1.2 * sk, 0.2 * sk, 0, 0, TAU);
    ctx.fill();

    ctx.setTransform(1, 0, 0, 1, ox, oy);
    fx.draw(ctx, 'back', unit);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawUmbrella(ctx, p);
    if (p.handsBehind) drawHands(ctx, p);

    // Head: base frames, cross-faded with 'lighter' (exact sum of weights).
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.globalCompositeOperation = 'lighter';
    for (const o of viewsNow) {
      headTransform(lctx, p);
      viewTransform(lctx, o.v, o.mirror);
      lctx.globalAlpha = o.w;
      lctx.drawImage(frameImage(o.v), 0, 0);
    }
    lctx.globalAlpha = 1;
    lctx.globalCompositeOperation = 'source-over';

    // Face on the visor.
    const withMask = viewsNow.filter((o) => o.v.mask);
    if (withMask.length) {
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, W, H);
      mctx.globalCompositeOperation = 'lighter';
      for (const o of withMask) {
        headTransform(mctx, p);
        viewTransform(mctx, o.v, o.mirror);
        mctx.globalAlpha = o.w;
        mctx.drawImage(o.v.mask.canvas, 0, 0);
      }
      mctx.globalAlpha = 1;
      mctx.globalCompositeOperation = 'source-over';

      const fp = facePlace(viewsNow, p.yaw, p.pitch);
      const f = faceState(0);
      const fpx = Math.min(1, Math.max(0.25, (fp.k * FW * unit * 1.25) / FW));
      // The face canvas has a margin, so a moved or squeezed face still fills the visor.
      const MX = FW * 0.2, MY = FH * 0.3;
      const fw = Math.round((FW + 2 * MX) * fpx), fh = Math.round((FH + 2 * MY) * fpx);
      lastDebug = { fp, fpx, fw, fh, W, H, unit, ox, oy, views: viewsNow.map((o) => [o.v.name, o.w, o.mirror, o.yaw]) };
      if (faceC.width !== fw || faceC.height !== fh) { faceC.width = fw; faceC.height = fh; }
      fctx.setTransform(fpx, 0, 0, fpx, MX * fpx, MY * fpx);
      f.px = fpx;
      drawFace(fctx, f);
      drawGloss(fctx);

      flctx.setTransform(1, 0, 0, 1, 0, 0);
      flctx.globalCompositeOperation = 'source-over';
      flctx.clearRect(0, 0, W, H);
      headTransform(flctx, p);
      flctx.translate(fp.cx, fp.cy);
      flctx.scale(fp.squeeze, fp.pitchSq);
      flctx.drawImage(faceC, (-FW / 2 - MX) * fp.k, (-FH / 2 - MY) * fp.k, (FW + 2 * MX) * fp.k, (FH + 2 * MY) * fp.k);
      flctx.setTransform(1, 0, 0, 1, 0, 0);
      flctx.globalCompositeOperation = 'destination-in';
      flctx.drawImage(maskL, 0, 0);
      flctx.globalCompositeOperation = 'source-over';
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.drawImage(faceL, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, 0, 0);

    drawAccessories(ctx, p);
    if (!p.handsBehind) drawHands(ctx, p);
    ctx.setTransform(1, 0, 0, 1, ox, oy);
    fx.draw(ctx, 'front', unit);
    if (flash > 0.01 && !reduced) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(255, 255, 250, ${0.35 * flash})`;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ---- Loop ----
  let raf = 0, last = 0;
  function loop(now) {
    if (destroyed) return;
    const dt = last ? clamp((now - last) / 1000, 0, 0.1) : 1 / 60;
    last = now;
    step(dt);
    render();
    raf = requestAnimationFrame(loop);
  }

  function setReduced(v) {
    reduced = !!v;
    fx.enabled = !reduced;
    if (reduced) fx.clear();
  }

  const off = attachInteraction({
    canvas: cv,
    toWorld,
    now: () => performance.now(),
    trigger(kind, data) {
      if (kind === 'move') { pointer = data; return; }
      emit(kind, { x: data[0], y: data[1] });
      if (kind === 'click') {
        tempFace = { id: 'click', until: t + 0.7 };
        if (!action) bot.play('hop');
      } else if (kind === 'tickle') {
        fx.add('tickle-sparkle', { x: data[0], y: data[1] });
        fx.add('tickle-sparkle');
        const again = t - tickleAt < 2.2;
        tickleAt = t;
        tickleCount = again ? tickleCount + 1 : 1;
        if (tickleCount >= 2) { if (!action || action.id !== 'laugh') bot.play('laugh'); }
        else if (!action) bot.play('giggle');
      } else if (kind === 'poke') {
        tempFace = { id: 'poke', until: t + 1.8 };
        fx.add('heart');
      } else if (kind === 'pet') {
        tempFace = { id: 'pet', until: t + 2.0 };
      }
    },
  });

  // ---- Public API ----
  const bot = {
    get canvas() { return cv; },
    get config() { return { ...cfg, accessories: [...cfg.accessories] }; },
    async setConfig(partial) {
      const prev = cfg;
      cfg = sanitizeConfig(cfg, partial);
      P = PERSONALITY[cfg.personality];
      if (cfg.name) cv.setAttribute('aria-label', cfg.name);
      if (cfg.style !== prev.style) {
        const s = await loadStyle(bases, cfg.style);
        if (s && !destroyed) style = s;
      }
      if (manual) render();
    },
    express(id, o = {}) {
      if (!FACES[id] && typeof id !== 'object') return;
      expr = { id, until: o.ms ? t + o.ms / 1000 : Infinity };
      if (manual) render();
    },
    play(id) {
      const fn = ACTION_FNS[id];
      const def = ACTION_DEFS[id];
      if (!fn || !def) return Promise.resolve();
      if (action) { const old = action; action = null; old.resolve(); }
      return new Promise((resolve) => {
        action = { id, fn, t0: t, ms: def.ms, resolve, face: null, ctx: null };
        const marks = new Set();
        action.ctx = {
          t: 0, state: { n: -1 },
          at(p0, key, fn2) {
            if (marks.has(key)) return;
            const p = (t - action.t0) / (def.ms / 1000);
            if (p >= p0) { marks.add(key); fn2(); }
          },
          fx: (kind, o2) => fx.add(kind, o2),
        };
      });
    },
    setState(id) {
      const st = STATE_DEFS[id];
      if (!st) return;
      state = id;
      if (st.enter) bot.play(st.enter);
      if (st.fx) fx.add(st.fx);
      if (id !== 'talking') talkTarget = 0;
    },
    setWeather(id) {
      weather.set(id || null);
      fx.clear();
    },
    talk(level) { talkTarget = clamp(+level || 0); talkAt = t; },
    lookAt(x, y) { lookTarget = x === null || x === undefined ? null : [clamp(+x, -1, 1) * 1.6, clamp(+y || 0, -1, 1) * 1.6 - 0.1]; },
    // Extra: hold the head at a yaw in degrees (null = free). For previews and tests.
    turn(deg) { yawLock = deg === null || deg === undefined ? null : +deg; },
    on(ev, fn) {
      (listeners[ev] = listeners[ev] || []).push(fn);
      return () => { listeners[ev] = (listeners[ev] || []).filter((f) => f !== fn); };
    },
    snapshot() { render(); return cv.toDataURL('image/png'); },
    // Extra: advance the clock by ms and draw (only with options.manual). For tests and contact sheets.
    tick(ms = 16) {
      let left = ms / 1000;
      while (left > 1e-6) { const dt = Math.min(1 / 30, left); step(dt); left -= dt; }
      render();
    },
    get time() { return t; },
    debug() { return { ...lastDebug, canvases: { faceC, maskL, faceL } }; },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      off();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq);
      if (action) { const a = action; action = null; a.resolve(); }
      if (ownCanvas && cv.parentNode) cv.parentNode.removeChild(cv);
    },
  };

  const manual = !!opt.manual;
  resize();
  step(1 / 60);
  render();
  if (!manual) raf = requestAnimationFrame(loop);
  return bot;
}
