// assets.js: load the manifests and the images, and keep one cache for all bots on the page.
// A manifest can be an object or a URL. File paths in a manifest are relative to the manifest folder.
// A file path can also be a data URL; it then loads as it is.

const imageCache = new Map();

export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return imageCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    if (!url.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  imageCache.set(url, p);
  return p;
}

async function loadJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pageUrl() {
  try { return document.baseURI; } catch { return 'http://localhost/'; }
}

// Return { data, root } for one manifest. root is the folder that file paths resolve against.
export async function resolveManifest(input, baseUrl, folder) {
  const fallbackRoot = baseUrl ? new URL(folder + '/', new URL(baseUrl, pageUrl())).href : pageUrl();
  if (!input) return { data: null, root: fallbackRoot };
  if (typeof input === 'string') {
    const url = new URL(input, baseUrl ? new URL(baseUrl, pageUrl()) : pageUrl()).href;
    const data = await loadJson(url);
    return { data, root: new URL('./', url).href };
  }
  return { data: input, root: fallbackRoot };
}

export function fileUrl(root, file) {
  if (!file) return null;
  if (file.startsWith('data:') || file.startsWith('blob:')) return file;
  try { return new URL(file, root).href; } catch { return null; }
}

export function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Read the pixels of an image. Returns null if the canvas is tainted.
export function pixels(img) {
  const c = canvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0);
  try {
    return { c, x, d: x.getImageData(0, 0, c.width, c.height) };
  } catch {
    return null;
  }
}

// A grayscale mask (white = inside) becomes an alpha mask canvas. The box is the bounding box of the inside.
const maskCache = new Map();
export function alphaMask(img, key) {
  if (!img) return null;
  if (key && maskCache.has(key)) return maskCache.get(key);
  const p = pixels(img);
  if (!p) return null;
  const { c, x, d } = p;
  const a = d.data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let i = 0, n = 0; i < a.length; i += 4, n++) {
    // Use the luminance. A mask that already has alpha keeps it.
    const v = Math.round(((a[i] + a[i + 1] + a[i + 2]) / 3) * (a[i + 3] / 255));
    a[i] = a[i + 1] = a[i + 2] = 255;
    a[i + 3] = v;
    if (v > 127) {
      const px = n % c.width, py = (n / c.width) | 0;
      if (px < x0) x0 = px; if (px > x1) x1 = px;
      if (py < y0) y0 = py; if (py > y1) y1 = py;
    }
  }
  x.putImageData(d, 0, 0);
  const out = { canvas: c, box: x1 >= 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null };
  if (key) maskCache.set(key, out);
  return out;
}

// Bounding box of the opaque part of an image (alpha > 24).
const boxCache = new Map();
export function alphaBox(img, key) {
  if (!img) return null;
  if (key && boxCache.has(key)) return boxCache.get(key);
  const p = pixels(img);
  if (!p) return null;
  const { c, d } = p;
  const a = d.data;
  let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y += 2) {
    for (let xx = 0; xx < c.width; xx += 2) {
      if (a[(y * c.width + xx) * 4 + 3] > 24) {
        if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  const box = x1 >= 0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null;
  if (key) boxCache.set(key, box);
  return box;
}
