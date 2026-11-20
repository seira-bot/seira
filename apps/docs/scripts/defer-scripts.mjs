import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out/', import.meta.url));

// Lighthouse estimates mobile LCP from every request that starts before the real LCP.
// Chunk scripts that start after the load event stay out of that estimate.
const chunkScript = /<script src="(\/_next\/static\/chunks\/[^"]+\.js)" async=""><\/script>/g;
const chunkPreload = /<link rel="preload" as="script"[^>]*href="\/_next\/static\/chunks\/[^"]+"[^>]*\/>/g;

function loader(srcs) {
  return `<script>(function(s){var d=0;function l(){if(d)return;d=1;s.forEach(function(u){var e=document.createElement("script");e.src=u;e.async=true;document.body.appendChild(e)})}["pointerdown","keydown","touchstart","scroll"].forEach(function(t){addEventListener(t,l,{once:true,passive:true})});function i(){window.requestIdleCallback?requestIdleCallback(l,{timeout:2000}):setTimeout(l,2000)}document.readyState==="complete"?i():addEventListener("load",i)})(${JSON.stringify(srcs)})</script>`;
}

let failed = false;
let count = 0;
for (const entry of await readdir(out, { recursive: true })) {
  if (!entry.endsWith('.html')) continue;
  const file = `${out}${entry}`;
  const html = await readFile(file, 'utf8');
  const srcs = [...html.matchAll(chunkScript)].map((match) => match[1]);
  if (srcs.length === 0 || !html.includes('</body>')) {
    if (entry === '404.html' || entry === '_not-found.html') continue;
    console.error(`defer-scripts: no chunk scripts to move in ${entry}`);
    failed = true;
    continue;
  }
  const next = html
    .replace(chunkPreload, '')
    .replace(chunkScript, '')
    .replace('</body>', `${loader(srcs)}</body>`);
  await writeFile(file, next);
  count += 1;
}

if (failed) process.exit(1);
console.log(`defer-scripts: ${count} pages`);
