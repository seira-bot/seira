// face.js: the screen face of the bot, drawn on a 2D canvas. The runtime puts it on the visor of a base frame.
// All sizes are Fibonacci numbers of one face unit U (U = 6 px on a 1024 px wide face canvas).
// The 2D logo proportions stay: eye width:height = 21:34, gap between the eyes = 2 x 13,
// a white highlight on the inner upper side, and a lash wing at the outer upper corner.

export const F = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];
export const U = 6;
export const FW = 1024;
// The face canvas maps to the visor box of the base frame with one uniform scale.
// The visor mask of the frame clips it, so the canvas can be larger than the visible glass.
export const FH = 640;
const EW = F[8] * U;            // eye width, 21 units
const EH = F[9] * U;            // eye height, 34 units
const GAP = 2 * F[7] * U;       // gap between the eyes, 2 x 13 units
const TOP = FH * 0.45 - EH / 2;   // the eye center is at 45 % of the visor height
export const LAYOUT = {
  ew: EW, eh: EH, gap: GAP, top: TOP, cy: TOP + EH / 2,
  cx: [FW / 2 - GAP / 2 - EW / 2, FW / 2 + GAP / 2 + EW / 2],
  my: TOP + EH + F[6] * U,
};

const PI = Math.PI;

function rgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function mix(hex, other, k) {
  const p = (x) => parseInt(x.replace('#', ''), 16);
  const a = p(hex), b = p(other);
  const ch = (s) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

// Size of each eye shape (w, h) and the lid that the shape has by itself.
const SHAPES = {
  pill: { w: EW, h: EH },
  sharp: { w: EW, h: EH, lid: { in: 0.3, out: 0 } },
  round: { w: 2 * F[7] * U, h: 2 * F[7] * U },
  almond: { w: F[9] * U * 0.82, h: F[8] * U * 0.86 },
  sleepy: { w: EW, h: EH, lid: { in: 0.5, out: 0.5 } },
  dot: { w: F[7] * U, h: F[7] * U },
  star: { w: 2 * F[7] * U, h: 2 * F[7] * U },
  square: { w: F[8] * U * 1.05, h: F[8] * U * 1.05 },
};

function shapePath(c, shape, x, cy, w, h, out) {
  c.beginPath();
  if (shape === 'round' || shape === 'dot') {
    c.ellipse(x, cy, w / 2, h / 2, 0, 0, PI * 2);
  } else if (shape === 'almond') {
    const xi = x - out * w / 2, xo = x + out * w / 2;
    c.moveTo(xi, cy + h * 0.1);
    c.bezierCurveTo(x - out * w * 0.2, cy - h * 0.75, x + out * w * 0.25, cy - h * 0.72, xo, cy - h * 0.14);
    c.bezierCurveTo(x + out * w * 0.25, cy + h * 0.72, x - out * w * 0.2, cy + h * 0.66, xi, cy + h * 0.1);
  } else if (shape === 'star') {
    starPath(c, x, cy, w / 2, w / 2 * 0.46, 5);
  } else if (shape === 'square') {
    c.roundRect(x - w / 2, cy - h / 2, w, h, F[5] * U);
  } else {
    c.roundRect(x - w / 2, cy - h / 2, w, h, Math.min(w, h) / 2);
  }
}

function starPath(c, x, y, ro, ri, n) {
  for (let k = 0; k < n * 2; k++) {
    const r = k % 2 ? ri : ro;
    const a = -PI / 2 + k * PI / n;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
  c.closePath();
}

function heartPath(c, x, y, s) {
  c.beginPath();
  c.moveTo(x, y + s * 0.62);
  c.bezierCurveTo(x - s * 0.15, y + s * 0.5, x - s * 0.72, y + s * 0.12, x - s * 0.62, y - s * 0.24);
  c.bezierCurveTo(x - s * 0.52, y - s * 0.62, x - s * 0.08, y - s * 0.6, x, y - s * 0.26);
  c.bezierCurveTo(x + s * 0.08, y - s * 0.6, x + s * 0.52, y - s * 0.62, x + s * 0.62, y - s * 0.24);
  c.bezierCurveTo(x + s * 0.72, y + s * 0.12, x + s * 0.15, y + s * 0.5, x, y + s * 0.62);
  c.closePath();
}

// Lash wing from the 2D logo: a curved triangle at the outer upper corner (ex, ey).
function lashWing(c, ex, ey, out) {
  c.beginPath();
  c.moveTo(ex - out * 5 * U, ey + 3 * U);
  c.quadraticCurveTo(ex + out * 2 * U, ey - 0.5 * U, ex + out * 8 * U, ey - 1 * U);
  c.quadraticCurveTo(ex + out * 3 * U, ey + 5 * U, ex, ey + F[7] * U);
  c.closePath();
  c.fill();
}

function lashFlick(c, ex, ey, out, up = 1) {
  c.save();
  c.lineWidth = 2 * U;
  c.beginPath();
  c.moveTo(ex, ey);
  c.quadraticCurveTo(ex + out * 3 * U, ey - up * 1 * U, ex + out * 5 * U, ey - up * 4 * U);
  c.stroke();
  c.restore();
}

function highlight(c, x, top, w, out, r = F[6] * U / 2) {
  c.save();
  c.shadowBlur = 0;
  c.fillStyle = '#FFFFFF';
  c.beginPath();
  c.arc(x - out * Math.max(0, w / 2 - F[5] * U - r), top + F[5] * U + r, r, 0, PI * 2);
  c.fill();
  c.restore();
}

// One eye with a base shape, lids, blink, highlight, and lash.
function baseEye(c, f, i, shape, x, cy, s) {
  const out = i === 0 ? -1 : 1;
  const S = SHAPES[shape] || SHAPES.pill;
  const w = S.w * s;
  const h0 = S.h * s;
  const open = f.open[i];
  const h = Math.max(F[4] * U, h0 * open);
  const lid = {
    in: Math.max(S.lid ? S.lid.in : 0, f.lid[i].in || 0),
    out: Math.max(S.lid ? S.lid.out : 0, f.lid[i].out || 0),
    low: f.lid[i].low || 0,
  };
  const closedish = open < 0.35;
  const top = cy - h / 2;
  const yi = top + (closedish ? 0 : lid.in * h);
  const yo = top + (closedish ? 0 : lid.out * h);
  const xi = x - out * w / 2, xo = x + out * w / 2;
  const cut = !closedish && (lid.in > 0 || lid.out > 0 || lid.low > 0);

  c.save();
  if (cut) {
    const yAt = (X) => yi + (yo - yi) * (X - xi) / (xo - xi);
    const bot = cy + h / 2;
    const be = bot - lid.low * h * 0.25;
    const bm = bot - lid.low * h * 1.9;
    c.beginPath();
    c.moveTo(x - w, yAt(x - w));
    c.lineTo(x + w, yAt(x + w));
    c.lineTo(x + w, be);
    c.quadraticCurveTo(x, bm, x - w, be);
    c.closePath();
    c.clip();
  }
  if (shape === 'star' && !closedish) {
    shapePath(c, shape, x, cy, w, h0, out);
    c.fill();
  } else {
    shapePath(c, shape === 'star' ? 'pill' : shape, x, cy, w, h, out);
    c.fill();
  }
  if (!closedish && shape !== 'star') {
    const visTop = Math.min(yi, yo) + Math.abs(yi - yo) * 0.5;
    const hr = shape === 'dot' ? F[5] * U / 2 : F[6] * U / 2;
    const hx = shape === 'round' || shape === 'dot' ? x + (-out) * w * 0.12 + out * Math.max(0, w / 2 - F[5] * U - hr) : x;
    if (shape === 'round' || shape === 'dot') highlight(c, hx, cy - h / 2 + h * 0.08, w, out, hr);
    else if (shape === 'almond') highlight(c, x, cy - h * 0.38, w * 0.7, out, hr);
    else highlight(c, x, Math.max(top, visTop - F[3] * U), w, out, hr);
  }
  c.restore();

  if (f.lashes && shape !== 'dot' && shape !== 'star') {
    if (closedish) {
      lashFlick(c, xo, cy, out, 0.6);
    } else if (shape === 'round') {
      lashWing(c, x + out * w * 0.36, cy - h * 0.38, out);
    } else if (shape === 'almond') {
      lashWing(c, xo - out * 1 * U, cy - h * 0.18 - 1 * U, out);
    } else {
      lashWing(c, xo, yo, out);
    }
  }
  return { top: cut ? Math.min(yi, yo) : top, xi, xo, yi, yo };
}

function modeEye(c, f, i, mode, x, cy, s) {
  const out = i === 0 ? -1 : 1;
  const w = EW * s, h = EH * s;
  c.save();
  c.lineWidth = 3 * U;
  if (mode === 'arc-up') {
    const r = w * 0.56;
    const yc = cy + h * 0.12;
    c.beginPath();
    c.arc(x, yc, r, PI * 1.12, PI * 1.88);
    c.stroke();
    if (f.lashes) lashFlick(c, x + out * r * Math.cos(PI * 0.12), yc - r * Math.sin(PI * 0.12), out, 1);
  } else if (mode === 'arc-down') {
    const r = w * 0.56;
    const yc = cy - h * 0.08;
    c.beginPath();
    c.arc(x, yc, r, PI * 0.12, PI * 0.88);
    c.stroke();
    if (f.lashes) lashFlick(c, x + out * r * Math.cos(PI * 0.12), yc + r * Math.sin(PI * 0.12), out, 0.8);
  } else if (mode === 'chevron') {
    const a = w * 0.42, b = h * 0.26;
    c.beginPath();
    c.moveTo(x + out * a, cy - b);
    c.lineTo(x - out * a * 0.7, cy);
    c.lineTo(x + out * a, cy + b);
    c.stroke();
  } else if (mode === 'heart') {
    heartPath(c, x, cy, w * 1.15);
    c.fill();
    c.restore();
    c.save();
    c.shadowBlur = 0;
    c.fillStyle = '#FFFFFF';
    c.beginPath();
    c.arc(x - out * w * 0.28, cy - w * 0.2, F[5] * U / 2 + 3, 0, PI * 2);
    c.fill();
  } else if (mode === 'spiral') {
    c.lineWidth = 2 * U;
    c.beginPath();
    const turns = 2.6, rmax = w * 0.62, rot = f.anim * PI * 2 * out;
    for (let k = 0; k <= 90; k++) {
      const u = k / 90;
      const ang = rot + u * turns * PI * 2;
      const r = u * rmax;
      const px = x + Math.cos(ang) * r, py = cy + Math.sin(ang) * r;
      if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.stroke();
  } else if (mode === 'round-big') {
    const r = w * 0.66;
    c.beginPath();
    c.arc(x, cy, r, 0, PI * 2);
    c.fill();
    highlight(c, x + (-out) * r * 0.22 + out * Math.max(0, r - F[5] * U - F[6] * U / 2), cy - r + r * 0.12, r * 2, out);
    if (f.lashes) lashWing(c, x + out * r * 0.72, cy - r * 0.7, out);
  } else if (mode === 'small') {
    const sw = F[6] * U, sh = F[7] * U;
    c.beginPath();
    c.roundRect(x - sw / 2, cy - sh / 2, sw, sh, sw / 2);
    c.fill();
    highlight(c, x, cy - sh / 2 - F[4] * U, sw, out, F[5] * U / 2 - 2);
  } else if (mode === 'wavy') {
    c.lineWidth = 2.5 * U;
    c.beginPath();
    const a = w * 0.62;
    for (let k = 0; k <= 40; k++) {
      const u = k / 40;
      const px = x - a + u * 2 * a;
      const py = cy + Math.sin(u * PI * 3 + f.anim * PI * 2) * F[3] * U;
      if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.stroke();
    if (f.lashes) lashFlick(c, x + out * a, cy + Math.sin(PI * 3 * (out > 0 ? 1 : 0) + f.anim * PI * 2) * F[3] * U, out, 1);
  } else if (mode === 'line') {
    c.beginPath();
    c.moveTo(x - w * 0.5, cy);
    c.lineTo(x + w * 0.5, cy);
    c.stroke();
  } else if (mode === 'dots') {
    c.beginPath();
    c.arc(x, cy, F[5] * U * 0.7, 0, PI * 2);
    c.fill();
  }
  c.restore();
  return { top: cy - h / 2, xi: x - out * w / 2, xo: x + out * w / 2, yi: cy - h / 2, yo: cy - h / 2 };
}

function wave(c, x0, x1, y, amp, periods, bow = 0) {
  c.beginPath();
  for (let k = 0; k <= 48; k++) {
    const u = k / 48;
    const px = x0 + (x1 - x0) * u;
    const py = y + Math.sin(u * periods * PI * 2) * amp + bow * (1 - (2 * u - 1) ** 2);
    if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
  }
}

function dShape(c, x, y, hw, top, bottom) {
  c.beginPath();
  c.moveTo(x - hw, y + top);
  c.lineTo(x + hw, y + top);
  c.bezierCurveTo(x + hw, y + top + (bottom - top) * 0.75, x + hw * 0.55, y + bottom, x, y + bottom);
  c.bezierCurveTo(x - hw * 0.55, y + bottom, x - hw, y + top + (bottom - top) * 0.75, x - hw, y + top);
  c.closePath();
}

const LINE_MOUTHS = new Set(['smile', 'cat', 'flat', 'smirk', 'fang', 'grin', 'firm', 'flat-side', 'wavy', 'wavy-small', 'frown', 'tiny-o', 'small-o']);

function drawMouth(c, f, x, y) {
  const id = f.mouth;
  c.lineWidth = 2 * U;
  if (f.dots) {
    for (let k = 0; k < 3; k++) {
      const on = Math.floor(f.anim * 3) % 3 === k;
      c.save();
      c.globalAlpha = on ? 1 : 0.35;
      c.beginPath();
      c.arc(x + (k - 1) * 4 * U, y, (on ? 1.5 : 1.2) * U, 0, PI * 2);
      c.fill();
      c.restore();
    }
    return;
  }
  if (f.talk > 0.06 && LINE_MOUTHS.has(id)) {
    const k = f.talk;
    dShape(c, x, y, (3.5 + 2.5 * k) * U, -1.5 * U, (1 + 7 * k) * U);
    c.fill();
    return;
  }
  switch (id) {
    case 'cat':
      c.beginPath();
      c.arc(x - 3 * U, y - 1.5 * U, 3 * U, PI * 0.08, PI * 0.95);
      c.stroke();
      c.beginPath();
      c.arc(x + 3 * U, y - 1.5 * U, 3 * U, PI * 0.05, PI * 0.92);
      c.stroke();
      break;
    case 'flat':
      c.beginPath(); c.moveTo(x - 5 * U, y); c.lineTo(x + 5 * U, y); c.stroke();
      break;
    case 'firm':
      c.lineWidth = 2.5 * U;
      c.beginPath(); c.moveTo(x - 4 * U, y); c.lineTo(x + 4 * U, y); c.stroke();
      break;
    case 'flat-side':
      c.beginPath(); c.moveTo(x + 0.5 * U, y + 0.6 * U); c.lineTo(x + 7 * U, y - 0.6 * U); c.stroke();
      break;
    case 'grin':
      dShape(c, x, y, 8 * U, -3 * U, 6 * U);
      c.fill();
      c.save();
      c.shadowBlur = 0;
      c.strokeStyle = f.screen;
      c.lineWidth = 1.2 * U;
      c.beginPath(); c.moveTo(x - 6.5 * U, y - 0.2 * U); c.lineTo(x + 6.5 * U, y - 0.2 * U); c.stroke();
      c.restore();
      break;
    case 'fang':
      c.beginPath(); c.arc(x, y - 4 * U, 7 * U, PI * 0.2, PI * 0.8); c.stroke();
      c.beginPath();
      c.moveTo(x + 1.6 * U, y + 2.3 * U); c.lineTo(x + 4.4 * U, y + 1.6 * U); c.lineTo(x + 3.2 * U, y + 5.6 * U);
      c.closePath(); c.fill();
      break;
    case 'small-o':
      c.beginPath(); c.arc(x, y + 0.5 * U, 2.6 * U, 0, PI * 2); c.stroke();
      break;
    case 'big-o':
      c.beginPath(); c.ellipse(x, y + 1.5 * U, 4 * U, 5 * U, 0, 0, PI * 2); c.stroke();
      break;
    case 'smirk':
      c.beginPath(); c.moveTo(x - 5 * U, y + 1.5 * U); c.quadraticCurveTo(x + 1 * U, y + 3.5 * U, x + 5.5 * U, y - 2 * U); c.stroke();
      break;
    case 'open':
      dShape(c, x, y, 5 * U, -2 * U, 5 * U); c.fill();
      break;
    case 'open-big':
      dShape(c, x, y, 8 * U, -3 * U, 9 * U); c.fill();
      break;
    case 'open-small':
      dShape(c, x, y, 3.2 * U, -1 * U, 3.5 * U); c.fill();
      break;
    case 'frown':
      c.beginPath(); c.arc(x, y + 6 * U, 6 * U, PI * 1.24, PI * 1.76); c.stroke();
      break;
    case 'wavy':
      wave(c, x - 6 * U, x + 6 * U, y, 1.3 * U, 2); c.stroke();
      break;
    case 'wavy-small':
      wave(c, x - 4 * U, x + 4 * U, y, 1 * U, 1.5); c.stroke();
      break;
    case 'wobbly':
      wave(c, x - 6 * U, x + 6 * U, y + 1 * U, 1 * U, 2.5, -2 * U); c.stroke();
      break;
    case 'zigzag': {
      c.beginPath();
      const n = 6;
      for (let k = 0; k <= n; k++) {
        const px = x - 7 * U + (14 * U * k) / n;
        const py = y + (k % 2 ? -1.6 : 1.6) * U;
        if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.stroke();
      break;
    }
    case 'wavy-open':
    case 'wail': {
      const big = id === 'wail';
      const hw = (big ? 7 : 5.5) * U, hh = (big ? 5 : 4) * U;
      c.beginPath();
      for (let k = 0; k <= 40; k++) {
        const u = k / 40;
        const px = x - hw + u * 2 * hw;
        const py = y - hh * 0.4 + Math.sin(u * PI * 4) * 0.8 * U;
        if (k === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.bezierCurveTo(x + hw, y + hh, x + hw * 0.4, y + hh * 1.2, x, y + hh * 1.2);
      c.bezierCurveTo(x - hw * 0.4, y + hh * 1.2, x - hw, y + hh, x - hw, y - hh * 0.4);
      c.closePath();
      c.stroke();
      break;
    }
    case 'pant': {
      c.beginPath(); c.ellipse(x, y + 1 * U, 4.5 * U, 3.8 * U, 0, 0, PI * 2); c.stroke();
      c.beginPath();
      c.moveTo(x - 2.4 * U, y + 3 * U);
      c.lineTo(x - 2.4 * U, y + 6 * U);
      c.arc(x, y + 6 * U, 2.4 * U, PI, 0, true);
      c.lineTo(x + 2.4 * U, y + 3 * U);
      c.closePath();
      c.fill();
      break;
    }
    case 'pout':
      c.beginPath();
      c.moveTo(x - 1 * U, y - 2.6 * U);
      c.quadraticCurveTo(x + 3.6 * U, y - 1.6 * U, x + 0.6 * U, y);
      c.quadraticCurveTo(x + 3.6 * U, y + 1.6 * U, x - 1 * U, y + 2.6 * U);
      c.stroke();
      break;
    case 'tiny-o':
      c.beginPath(); c.arc(x, y + 1 * U, 1.5 * U, 0, PI * 2); c.fill();
      break;
    case 'yawn':
      c.beginPath(); c.ellipse(x, y + 2 * U, 4 * U, 6 * U, 0, 0, PI * 2);
      c.save(); c.globalAlpha = 0.35; c.fill(); c.restore();
      c.stroke();
      break;
    case 'smile':
    default:
      c.beginPath(); c.arc(x, y - 4 * U, 7 * U, PI * 0.2, PI * 0.8); c.stroke();
      break;
  }
}

function drawBrow(c, f, i, x, top, w, tilt, style) {
  const out = i === 0 ? -1 : 1;
  const lw = style === 'thick' ? 3 * U : style === 'angled' ? 2 * U : 1.5 * U;
  const yb = top - 5 * U;
  const xi = x - out * w * 0.6, xo = x + out * w * 0.6;
  c.save();
  c.lineWidth = lw;
  c.beginPath();
  c.moveTo(xi, yb + tilt * 3.5 * U);
  if (style === 'angled') c.lineTo(xo, yb - tilt * 2.5 * U - 1.5 * U);
  else c.quadraticCurveTo(x, yb - 1.5 * U, xo, yb - tilt * 2.5 * U);
  c.stroke();
  c.restore();
}

function drawBlush(c, f, x, y) {
  const k = f.blush;
  c.save();
  c.globalAlpha = Math.min(1, k);
  const g = c.createRadialGradient(x, y, 0, x, y, 8 * U);
  g.addColorStop(0, 'rgba(255, 110, 150, 0.32)');
  g.addColorStop(1, 'rgba(255, 110, 150, 0)');
  c.save(); c.shadowBlur = 0; c.fillStyle = g; c.fillRect(x - 9 * U, y - 6 * U, 18 * U, 12 * U); c.restore();
  c.strokeStyle = '#FF7FA3';
  c.shadowColor = 'rgba(255, 110, 150, 0.8)';
  c.lineWidth = 1.2 * U;
  for (let n = -1; n <= 1; n++) {
    const bx = x + n * 2.6 * U;
    c.beginPath(); c.moveTo(bx - 1 * U, y + 1.6 * U); c.lineTo(bx + 1 * U, y - 1.6 * U); c.stroke();
  }
  c.restore();
}

function drawTears(c, f, x, y, out) {
  const len = F[7] * U * f.tears;
  c.save();
  c.lineWidth = 2.2 * U;
  c.globalAlpha = 0.9;
  const tx = x + out * 1.5 * U;
  c.beginPath(); c.moveTo(tx, y); c.lineTo(tx, y + len); c.stroke();
  const dy = ((f.anim * 1.7) % 1) * F[7] * U;
  c.beginPath(); c.arc(tx, y + len * 0.4 + dy, 1.6 * U, 0, PI * 2); c.fill();
  c.restore();
}

function drawSweat(c, x, y, s) {
  c.save();
  c.fillStyle = '#9FE7FF';
  c.shadowColor = 'rgba(120, 220, 255, 0.8)';
  c.beginPath();
  c.moveTo(x, y - 2.5 * U * s);
  c.quadraticCurveTo(x + 1.8 * U * s, y + 0.2 * U * s, x, y + 1.5 * U * s);
  c.quadraticCurveTo(x - 1.8 * U * s, y + 0.2 * U * s, x, y - 2.5 * U * s);
  c.fill();
  c.restore();
}

function drawScreen(c, f) {
  const g = c.createLinearGradient(0, 0, 0, FH);
  g.addColorStop(0, mix(f.screen, '#FFFFFF', 0.04));
  g.addColorStop(1, mix(f.screen, '#000000', 0.55));
  c.fillStyle = g;
  c.fillRect(-FW, -FH, FW * 3, FH * 3);
  // Soft inner shade near the rim gives the glass some depth.
  const v = c.createRadialGradient(FW / 2, FH * 0.45, FH * 0.32, FW / 2, FH * 0.5, FW * 0.62);
  v.addColorStop(0, 'rgba(0, 0, 0, 0)');
  v.addColorStop(1, 'rgba(0, 0, 0, 0.5)');
  c.fillStyle = v;
  c.fillRect(-FW, -FH, FW * 3, FH * 3);
  if (f.tint) {
    const t = f.tint;
    const col = t === 'sick' ? '70, 170, 80' : t === 'cold' ? '140, 200, 255' : '255, 110, 60';
    const r = c.createRadialGradient(FW / 2, FH * 0.55, t === 'sick' ? 0 : FH * 0.35, FW / 2, FH * 0.55, FW * 0.55);
    if (t === 'sick') { r.addColorStop(0, `rgba(${col}, 0.32)`); r.addColorStop(1, `rgba(${col}, 0.04)`); }
    else { r.addColorStop(0, `rgba(${col}, 0)`); r.addColorStop(1, `rgba(${col}, 0.3)`); }
    c.fillStyle = r;
    c.fillRect(-FW, -FH, FW * 3, FH * 3);
  }
  if (f.flash > 0) {
    c.fillStyle = `rgba(255, 255, 255, ${0.6 * f.flash})`;
    c.fillRect(-FW, -FH, FW * 3, FH * 3);
  }
}

// A soft gloss band on the glass. The runtime draws it after the face.
export function drawGloss(c) {
  c.save();
  const g = c.createLinearGradient(0, FH * 0.02, 0, FH * 0.3);
  g.addColorStop(0, 'rgba(255, 255, 255, 0.10)');
  g.addColorStop(1, 'rgba(255, 255, 255, 0)');
  c.fillStyle = g;
  c.beginPath();
  c.ellipse(FW * 0.5, FH * 0.06, FW * 0.42, FH * 0.24, 0, 0, PI * 2);
  c.fill();
  c.restore();
}

// f: the face state. See composeFace() in bot.js for the fields.
export function drawFace(c, f) {
  const L = LAYOUT;
  c.save();
  drawScreen(c, f);
  if (f.squash) {
    // The eyes and the mouth flatten for a moment while the expression changes. The screen stays.
    c.translate(0, L.cy);
    c.scale(1, 1 - 0.55 * f.squash);
    c.translate(0, -L.cy);
  }

  c.shadowColor = rgba(f.color, 0.85);
  c.shadowBlur = F[5] * U * (f.px || 1);   // f.px: canvas pixels per face unit pixel (shadowBlur ignores the transform)
  c.fillStyle = f.color;
  c.strokeStyle = f.color;
  c.lineCap = 'round';
  c.lineJoin = 'round';

  const ex = f.look[0], ey = f.look[1];
  const tops = [];
  for (let i = 0; i < 2; i++) {
    const out = i === 0 ? -1 : 1;
    const s = f.scale[i];
    const x = L.cx[i] + ex + out * (s - 1) * L.ew * 0.15;
    const cy = L.cy + ey;
    const mode = f.eyes[i];
    tops[i] = SHAPES[mode] ? baseEye(c, f, i, mode, x, cy, s) : modeEye(c, f, i, mode, x, cy, s);
    const w = (SHAPES[mode] ? SHAPES[mode].w : L.ew) * s;
    const style = f.brows !== 'none' ? f.brows : (f.brow ? 'thin' : null);
    if (style) drawBrow(c, f, i, x, tops[i].top, w, f.brow + (f.brows === 'angled' ? 0.4 : 0), style);
    if (f.blush > 0.02) drawBlush(c, f, L.cx[i] + out * L.ew * 0.25 + ex * 0.5, L.cy + L.eh * 0.56 + ey * 0.5);
    if (f.tears > 0.02) drawTears(c, f, x, L.cy + L.eh * 0.12 + ey, out);
    if (f.marks === 'tremble') {
      c.save();
      c.lineWidth = 1.2 * U;
      for (let k = 0; k < 2; k++) {
        c.beginPath();
        c.arc(x + out * (L.ew * 0.5 + (2.5 + 2 * k) * U), cy, (2 + 1.6 * k) * U, out > 0 ? -0.6 : PI - 0.6, out > 0 ? 0.6 : PI + 0.6);
        c.stroke();
      }
      c.restore();
    }
  }
  if (f.sweat > 0.02) drawSweat(c, L.cx[1] + L.ew * 0.95 + ex, L.top + 4 * U + ey, f.sweat);

  const mx = FW / 2 + ex * 0.6 + f.mouthDX;
  const my = L.my + ey * 0.4;
  drawMouth(c, f, mx, my);
  c.restore();
}

// A short string that changes when the drawn face changes.
export function faceKey(f) {
  const r = (v) => Math.round(v * 100);
  return [f.eyes.join('/'), r(f.open[0]), r(f.open[1]), JSON.stringify(f.lid), r(f.scale[0]), r(f.scale[1]),
    Math.round(f.look[0]), Math.round(f.look[1]), f.mouth, r(f.talk), r(f.blush), r(f.tears), r(f.sweat), f.tint,
    r(f.brow), f.marks, f.dots, r(f.anim), r(f.flash), f.color, f.screen, f.lashes, f.brows, Math.round(f.mouthDX)].join('|');
}
