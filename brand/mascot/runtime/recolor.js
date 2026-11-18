// recolor.js: change the hair color and the shell color of a base frame by luminance.
// Recolor styles have flat magenta hair (#FF00FF). Native styles (for example Seira) have silver hair.
// The hair mask (white = hair) selects the hair. All other opaque pixels are shell, visor, or details.
// The median shade of the source maps to the target color, so shading and highlights stay.

import { pixels } from './assets.js';

const cache = new Map();

function hexRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function median(values) {
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  return values[(values.length / 2) | 0] || 1;
}

// img: base frame. hairImg: grayscale hair mask (or null). hair, shell: hex or null (null = keep).
// Returns a canvas, or the image itself when nothing changes.
export function recolorFrame(img, hairImg, { hair = null, shell = null, key = '' } = {}) {
  if (!img || (!hair && !shell)) return img;
  const ck = `${key}|${hair}|${shell}`;
  if (cache.has(ck)) return cache.get(ck);
  const P = pixels(img);
  if (!P) return img;
  const M = hairImg ? pixels(hairImg) : null;
  const a = P.d.data;
  const m = M ? M.d.data : null;
  const T = hair ? hexRgb(hair) : null;
  const S = shell ? hexRgb(shell) : null;

  // Pass 1: measure the median shade of hair and shell.
  const hs = [], ss = [];
  for (let i = 0; i < a.length; i += 64) {
    if (a[i + 3] < 200) continue;
    const mk = m ? m[i] / 255 : 0;
    const r = a[i], g = a[i + 1], b = a[i + 2];
    if (mk > 0.9) {
      const magenta = r - g > 60 && b - g > 60;
      hs.push(magenta ? Math.max(r, b) : 0.3 * r + 0.59 * g + 0.11 * b);
    } else if (mk < 0.1) {
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      if (L > 90) ss.push(L);
    }
  }
  const hRef = median(hs);
  const sRef = median(ss);

  // Pass 2: write the new colors.
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0) continue;
    const r = a[i], g = a[i + 1], b = a[i + 2];
    const mk = m ? m[i] / 255 : 0;
    let nr = r, ng = g, nb = b;
    if (T && mk > 0) {
      const magenta = r - g > 40 && b - g > 40;
      let shade, spec;
      if (magenta) {
        shade = Math.max(r, b) / hRef;
        spec = Math.min(1, g / Math.max(1, Math.max(r, b))) * 0.9;
      } else {
        const L = 0.3 * r + 0.59 * g + 0.11 * b;
        shade = L / hRef;
        spec = Math.max(0, (L - hRef) / Math.max(1, 255 - hRef)) * 0.55;
      }
      const cr = Math.min(255, T[0] * shade), cg = Math.min(255, T[1] * shade), cb = Math.min(255, T[2] * shade);
      const hr = cr + (255 - cr) * spec, hg = cg + (255 - cg) * spec, hb = cb + (255 - cb) * spec;
      nr = r + (hr - r) * mk; ng = g + (hg - g) * mk; nb = b + (hb - b) * mk;
    }
    if (S && mk < 1) {
      const L = 0.3 * r + 0.59 * g + 0.11 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // Only light, grey pixels are shell. Dark glass and colored details stay.
      const k = (1 - mk) * Math.max(0, Math.min(1, (L - 70) / 60)) * (sat < 40 ? 1 : 0);
      if (k > 0) {
        const shade = L / sRef;
        const spec = Math.max(0, (L - sRef) / Math.max(1, 255 - sRef)) * 0.7;
        const cr = Math.min(255, S[0] * shade), cg = Math.min(255, S[1] * shade), cb = Math.min(255, S[2] * shade);
        const tr = cr + (255 - cr) * spec, tg = cg + (255 - cg) * spec, tb = cb + (255 - cb) * spec;
        nr = nr + (tr - nr) * k; ng = ng + (tg - ng) * k; nb = nb + (tb - nb) * k;
      }
    }
    a[i] = nr; a[i + 1] = ng; a[i + 2] = nb;
  }
  P.x.putImageData(P.d, 0, 0);
  cache.set(ck, P.c);
  return P.c;
}
