// Page entry. It loads the runtime and the data files, then starts the builder.
// A data file that fails to load becomes null. The builder then uses its own defaults.

import * as runtime from '../runtime/bot.js';
import { mountBuilder } from './builder.js';

async function load(url) {
  try {
    const res = await fetch(new URL(url, import.meta.url));
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const [bases, stickers, cast] = await Promise.all([
  load('../art/bases/manifest.json'),
  load('../art/stickers/manifest.json'),
  load('../cast/cast.json'),
]);

await mountBuilder(document.getElementById('app'), {
  runtime,
  bases,
  stickers,
  cast,
  baseUrl: new URL('../art/', import.meta.url).href,
});
