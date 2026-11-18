// motion.js: easing helpers, the pose object, idle life, body motions, and base hand poses.
// World units: the origin is the head pivot, 1 unit = the head radius, +y is down.
// A pose: yaw (degrees, + = the face turns to the viewer's right), pitch (-1 = up view, +1 = down view),
// roll (radians), hx/hy (head offset), bx/by/brot (body offset and lean), sx/sy (squash and stretch),
// hands { L, R } with { g: gesture, x, y, rot, s, a }, handsBehind, shadow (0..1), flash (0..1).

export const TAU = Math.PI * 2;
export const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, k) => a + (b - a) * k;
export const smooth = (k) => { k = clamp(k); return k * k * (3 - 2 * k); };
export const easeOut = (k) => 1 - Math.pow(1 - clamp(k), 3);
export const easeIn = (k) => Math.pow(clamp(k), 3);
export const easeInOut = (k) => { k = clamp(k); return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2; };
export const backOut = (k) => { k = clamp(k); const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
// 0 -> 1 between a and b (smooth).
export const ramp = (p, a, b) => smooth((p - a) / (b - a));
// 0 -> 1 -> 0 between a and b (sine bump).
export const bump = (p, a, b) => (p <= a || p >= b ? 0 : Math.sin(Math.PI * (p - a) / (b - a)));
// A window: 1 between a and b, with soft edges of width e.
export const win = (p, a, b, e = 0.06) => Math.min(ramp(p, a - e, a + e), 1 - ramp(p, b - e, b + e));

export const REST = { L: { g: 'open', x: -0.7, y: 1.2, rot: -0.32, s: 0.78, a: 1 }, R: { g: 'open', x: 0.7, y: 1.2, rot: 0.32, s: 0.78, a: 1 } };

export function hand(g, x, y, rot = 0, s = 0.78, a = 1) { return { g, x, y, rot, s, a }; }
export function mirrorHand(h) { return h ? { ...h, x: -h.x, rot: -h.rot } : h; }
export function copyHand(h) { return h ? { ...h } : null; }

export function newPose() {
  return {
    yaw: 0, pitch: 0, roll: 0, hx: 0, hy: 0, bx: 0, by: 0, brot: 0, sx: 1, sy: 1,
    hands: { L: copyHand(REST.L), R: copyHand(REST.R) }, handsBehind: false, shadow: 1, flash: 0,
  };
}

const NUM = ['yaw', 'pitch', 'roll', 'hx', 'hy', 'bx', 'by', 'brot', 'sx', 'sy', 'shadow', 'flash'];

function mixHand(a, b, k) {
  if (!a) return b && k > 0.5 ? { ...b } : null;
  if (!b) return k < 0.5 ? { ...a } : null;
  return {
    g: k < 0.5 ? a.g : b.g,
    x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k), rot: lerp(a.rot, b.rot, k),
    s: lerp(a.s, b.s, k), a: lerp(a.a ?? 1, b.a ?? 1, k),
  };
}

// Blend pose b over pose a with weight k (0..1). Returns a new pose.
export function mixPose(a, b, k) {
  const o = { ...a, hands: { L: a.hands.L, R: a.hands.R } };
  if (k <= 0) return o;
  for (const n of NUM) if (b[n] !== undefined) o[n] = lerp(a[n], b[n], k);
  if (b.hands) {
    if ('L' in b.hands) o.hands.L = mixHand(a.hands.L, b.hands.L, k);
    if ('R' in b.hands) o.hands.R = mixHand(a.hands.R, b.hands.R, k);
  }
  if (b.handsBehind !== undefined && k > 0.5) o.handsBehind = b.handsBehind;
  return o;
}

// Base hand poses for states and weather. t: seconds.
export const HAND_POSES = {
  rest: () => ({ L: copyHand(REST.L), R: copyHand(REST.R) }),
  hug: (t) => {
    const j = Math.sin(t * 40) * 0.012;
    return { L: hand('fist', -0.98 + j, 0.62, 0.35, 0.72), R: hand('fist', 0.98 - j, 0.62, -0.35, 0.72) };
  },
  chin: () => ({ L: copyHand(REST.L), R: hand('chin', 0.3, 1.0, 0.1, 0.8) }),
  type: (t) => ({
    L: hand('fist', -0.42, 1.3 - Math.max(0, Math.sin(t * 13)) * 0.06, 0.15, 0.68),
    R: hand('fist', 0.42, 1.3 - Math.max(0, Math.sin(t * 13 + 2.1)) * 0.06, -0.15, 0.68),
  }),
  catch: (t) => ({
    L: hand('hold', -0.5, 1.22 + Math.sin(t * 2) * 0.02, 0.15, 0.78),
    R: hand('hold', 0.5, 1.22 + Math.sin(t * 2 + 1) * 0.02, -0.15, 0.78),
  }),
  umbrella: () => ({ L: copyHand(REST.L), R: hand('hold', 0.82, 0.62, -0.1, 0.74) }),
};

// Body motions for expressions, states, and weather. They add to the pose. t: seconds. P: personality.
export const MOTIONS = {
  bounce: (o, t) => { const b = Math.abs(Math.sin(t * 9)); o.by -= b * 0.05; o.sy *= 1 + b * 0.025; o.sx *= 1 - b * 0.015; },
  wiggle: (o, t) => { o.roll += Math.sin(t * 11) * 0.07; o.bx += Math.sin(t * 11) * 0.02; },
  sway: (o, t) => { o.brot += Math.sin(t * 1.6) * 0.05; o.roll += Math.sin(t * 1.6 + 0.6) * 0.04; },
  droop: (o, t) => { o.by += 0.06; o.sy *= 0.97; o.sx *= 1.015; o.pitch += 0.35; o.brot += Math.sin(t * 0.8) * 0.01; },
  tremble: (o, t) => { o.bx += Math.sin(t * 47) * 0.012; o.by += Math.sin(t * 53) * 0.006; },
  breathe: (o, t) => { const b = Math.sin(t * 1.4); o.sy *= 1 + b * 0.02; o.sx *= 1 - b * 0.01; o.by -= b * 0.015; },
  circle: (o, t) => { o.hx += Math.cos(t * 4) * 0.05; o.hy += Math.sin(t * 4) * 0.03; o.roll += Math.sin(t * 4) * 0.08; },
  shiver: (o, t) => { o.bx += Math.sin(t * 61) * 0.02; o.roll += Math.sin(t * 43) * 0.015; o.sy *= 0.98; o.sx *= 1.01; },
  'shiver-soft': (o, t) => { o.bx += Math.sin(t * 55) * 0.008 * (Math.sin(t * 0.9) > 0.3 ? 1 : 0); o.pitch -= 0.3; },
  pant: (o, t) => { const b = Math.sin(t * 9); o.sy *= 1 + b * 0.012; o.by += 0.04 + b * 0.008; o.pitch += 0.2; },
  ponder: (o, t) => { o.yaw += 10 + Math.sin(t * 0.7) * 6; o.roll += 0.06; o.pitch -= 0.25; },
  talk: (o, t) => { o.pitch += Math.sin(t * 3.1) * 0.08; o.roll += Math.sin(t * 1.7) * 0.025; },
  busy: (o, t) => { o.by += Math.abs(Math.sin(t * 6.5)) * 0.012; o.pitch += 0.35; },
  sleep: (o, t) => { const b = Math.sin(t * 1.1); o.pitch += 0.55; o.roll += 0.1; o.sy *= 1 + b * 0.025; o.by += 0.05 - b * 0.02; },
  bask: (o, t) => { o.pitch -= 0.3; o.brot += Math.sin(t * 0.9) * 0.025; },
  heat: (o, t) => { o.by += 0.07; o.sy *= 0.97; o.sx *= 1.02; o.roll += Math.sin(t * 1.2) * 0.04; o.pitch += 0.25; },
  'look-up': (o, t) => { o.pitch -= 0.75; o.yaw += Math.sin(t * 0.6) * 8; },
  flinch: (o, t) => { o.by += 0.03; o.sy *= 0.97; o.bx += Math.sin(t * 50) * 0.01; },
  lean: (o, t) => { const g = 0.6 + 0.4 * Math.sin(t * 1.3) * Math.sin(t * 0.47); o.brot -= 0.1 * g; o.bx -= 0.06 * g; o.roll -= 0.05 * g; },
  search: (o, t) => { o.yaw += Math.sin(t * 0.55) * 22; o.pitch += 0.1; },
};

// Idle life: breathing, slow sway, float. P: personality.
export function idleMotion(o, t, P) {
  const sp = P.speed;
  const b = Math.sin(t * 1.9 * sp);
  o.by += -b * 0.022 * P.float;
  o.sy *= 1 + b * 0.012;
  o.sx *= 1 - b * 0.008;
  o.brot += Math.sin(t * 0.63 * sp + 1) * 0.018 * P.sway;
  o.roll += Math.sin(t * 0.81 * sp) * 0.022 * P.sway + (P.tilt || 0);
  o.yaw += Math.sin(t * 0.37 * sp) * 4 * P.sway;
  o.pitch += (P.chin || 0) * 4 + Math.sin(t * 0.52 * sp + 2) * 0.05;
  const hb = Math.sin(t * 1.9 * sp - 0.7);
  for (const k of ['L', 'R']) {
    const h = o.hands[k];
    if (!h) continue;
    h.y += hb * 0.03 * P.float;
    h.rot += Math.sin(t * 1.3 * sp + (k === 'L' ? 0 : 1.7)) * 0.05;
  }
}
