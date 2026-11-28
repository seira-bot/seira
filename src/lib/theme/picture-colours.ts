const SIDE = 64;
const SHIFT = 4;
const APART = 40;

const channel = (value: number) => Math.round(value).toString(16).padStart(2, "0");

/** The `count` main colours of an RGBA pixel buffer as hex, the most common first. Pixels that are mostly see-through are
 * skipped, and colours too close to one already chosen are folded into it so five swatches look different. */
export function quantizeColours(pixels: ArrayLike<number>, count = 5): string[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let at = 0; at + 3 < pixels.length; at += 4) {
    if (pixels[at + 3]! < 128) continue;
    const [r, g, b] = [pixels[at]!, pixels[at + 1]!, pixels[at + 2]!];
    const key = ((r >> SHIFT) << 8) | ((g >> SHIFT) << 4) | (b >> SHIFT);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const ranked = [...buckets.values()].sort((a, b) => b.n - a.n).map((bucket) => ({ n: bucket.n, rgb: [bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n] as const }));
  const chosen: Array<{ n: number; rgb: readonly [number, number, number] }> = [];
  const apart = (distance: number) => ranked.filter((one) => !chosen.includes(one) && chosen.every((taken) => Math.hypot(one.rgb[0] - taken.rgb[0], one.rgb[1] - taken.rgb[1], one.rgb[2] - taken.rgb[2]) >= distance));
  for (const distance of [APART, APART / 2, 0]) {
    for (let next = apart(distance)[0]; next && chosen.length < count; next = apart(distance)[0]) chosen.push(next);
    if (chosen.length === count) break;
  }
  return chosen.map(({ rgb }) => `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`);
}

/** Reads a picked picture inside this window and returns its main colours. The picture is never uploaded. */
export async function pictureColours(file: Blob, count = 5): Promise<string[]> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("no canvas");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const colours = quantizeColours(context.getImageData(0, 0, canvas.width, canvas.height).data, count);
    if (!colours.length) throw new Error("no colours");
    return colours;
  } finally {
    bitmap.close();
  }
}
