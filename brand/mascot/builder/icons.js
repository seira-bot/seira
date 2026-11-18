// Small inline SVG icons for the eye and mouth choices.
// Each icon is drawn on a 48 x 32 grid. The caller sets the color.

const NS = 'xmlns="http://www.w3.org/2000/svg"';

function starPoints(cx, cy, outer, inner) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
  }
  return pts.join(' ');
}

// Each shape gets the x center of one eye. The right eye uses the same call with a mirror flag.
const EYE_SHAPES = {
  pill: (x) => `<rect x="${x - 3.5}" y="8" width="7" height="16" rx="3.5"/>`,
  round: (x) => `<circle cx="${x}" cy="16" r="6"/>`,
  sharp: (x, m) => `<polygon points="${x - 6 * m},21 ${x + 6 * m},12 ${x + 6 * m},21"/>`,
  almond: (x) => `<path d="M${x - 7} 16 Q${x} 8 ${x + 7} 16 Q${x} 24 ${x - 7} 16Z"/>`,
  sleepy: (x) => `<path d="M${x - 6} 15 h12 a6 6 0 0 1 -12 0z"/>`,
  dot: (x) => `<circle cx="${x}" cy="16" r="3"/>`,
  star: (x) => `<polygon points="${starPoints(x, 16, 7.5, 3.2)}"/>`,
  square: (x) => `<rect x="${x - 5.5}" y="10.5" width="11" height="11" rx="2"/>`,
};

const MOUTH_SHAPES = {
  smile: '<path d="M14 13 Q24 25 34 13" fill="none" stroke-width="3" stroke-linecap="round"/>',
  cat: '<path d="M12 14 Q18 23 24 15 Q30 23 36 14" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
  flat: '<path d="M15 16 H33" fill="none" stroke-width="3" stroke-linecap="round"/>',
  grin: '<path d="M13 12 H35 Q35 25 24 25 Q13 25 13 12Z"/>',
  fang: '<path d="M14 12 Q24 24 34 12" fill="none" stroke-width="3" stroke-linecap="round"/><polygon points="27,17.5 31.5,15.5 30,24"/>',
  'small-o': '<ellipse cx="24" cy="16" rx="4" ry="5.5" fill="none" stroke-width="3"/>',
  smirk: '<path d="M14 19 Q24 21 34 12" fill="none" stroke-width="3" stroke-linecap="round"/>',
};

function wrap(inner, color) {
  return `<svg ${NS} viewBox="0 0 48 32" width="48" height="32" aria-hidden="true" focusable="false" fill="${color}" stroke="${color}" stroke-width="0">${inner}</svg>`;
}

export function hasEyeIcon(id) {
  return Object.prototype.hasOwnProperty.call(EYE_SHAPES, id);
}

export function hasMouthIcon(id) {
  return Object.prototype.hasOwnProperty.call(MOUTH_SHAPES, id);
}

export function eyeIcon(id, color) {
  const shape = EYE_SHAPES[id] || EYE_SHAPES.round;
  return wrap(shape(15, 1) + shape(33, -1), color);
}

export function mouthIcon(id, color) {
  const shape = MOUTH_SHAPES[id] || MOUTH_SHAPES.flat;
  // Stroke paths set their own width. Filled shapes keep stroke width 0.
  return wrap(shape, color);
}
