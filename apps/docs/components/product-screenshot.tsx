// Pixel size of each image in docs/screenshots. The page keeps this space before the image loads.
const screenshotSizes = {
  'approval-card': [1980, 1470],
  'docs-automations': [2560, 1600],
  'docs-computer-panel': [2560, 1600],
  'docs-connected-apps': [2560, 1600],
  'docs-engine-detection': [2560, 1600],
  'docs-fresh-bot': [2560, 1600],
  'docs-model-picker': [2560, 1600],
} as const;

type ScreenshotName = keyof typeof screenshotSizes;

export function ProductScreenshot({
  name,
  alt,
  caption,
  position = 'center',
}: {
  name: ScreenshotName;
  alt: string;
  caption?: string;
  position?: 'center' | 'top';
}) {
  const [width, height] = screenshotSizes[name];
  return (
    <figure className="seira-product-shot">
      <div className="seira-product-shot-frame">
        <img
          src={`/screenshots/${name}.png`}
          alt={alt}
          width={width}
          height={height}
          loading="lazy"
          decoding="async"
          className={position === 'top' ? 'object-top' : 'object-center'}
        />
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}
