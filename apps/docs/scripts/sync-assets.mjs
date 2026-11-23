import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const screenshotsSource = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));
const screenshotsTarget = fileURLToPath(new URL('../public/screenshots/', import.meta.url));
const contentSource = fileURLToPath(new URL('../content/docs/', import.meta.url));
const iconSource = fileURLToPath(new URL('../../../public/app-icon.svg', import.meta.url));
const iconTarget = fileURLToPath(new URL('../public/app-icon.svg', import.meta.url));

// Copy only the screenshots that a docs page shows, so that old images do not ship with the site.
const used = new Set();
for (const entry of await readdir(contentSource, { recursive: true })) {
  if (!entry.endsWith('.mdx')) continue;
  const text = await readFile(`${contentSource}/${entry}`, 'utf8');
  for (const match of text.matchAll(/<ProductScreenshot\s[^>]*?name="([^"]+)"/g)) used.add(match[1]);
}

// The target folder holds only this script's output, so start it empty.
await rm(screenshotsTarget, { recursive: true, force: true });
await mkdir(screenshotsTarget, { recursive: true });

for (const name of used) {
  await copyFile(`${screenshotsSource}/${name}.png`, `${screenshotsTarget}/${name}.png`);
}

await copyFile(iconSource, iconTarget);
for (const name of ['app-icon-192.png', 'app-icon-512.png', 'apple-touch-icon.png']) {
  await copyFile(fileURLToPath(new URL(`../../../public/${name}`, import.meta.url)), fileURLToPath(new URL(`../public/${name}`, import.meta.url)));
}
