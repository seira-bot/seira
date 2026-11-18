// Rendered body pictures are read from files named <body>-<px>.webp or .png: square, at <px> device pixels.

export interface SteelImage { body: string; px: number; url: string }

/** Reads `<body>-<px>.webp` or `.png` file names into a list sorted by size. */
export function sizedImages(globbed: Record<string, string>): SteelImage[] {
  return Object.entries(globbed)
    .flatMap(([path, url]) => {
      const match = /\/([a-z]+)-(\d+)\.(?:webp|png)$/.exec(path);
      return match ? [{ body: match[1]!, px: Number(match[2]), url }] : [];
    })
    .sort((a, b) => a.px - b.px);
}

/** The smallest image that still has a device pixel for every pixel drawn, or the largest there is; null when this body
 * has none. */
export function steelBodyImage(body: string, size: number, density: number, images: readonly SteelImage[]): string | null {
  const own = images.filter((image) => image.body === body);
  if (!own.length) return null;
  const wanted = size * Math.max(1, density);
  return (own.find((image) => image.px >= wanted) ?? own.at(-1)!).url;
}
