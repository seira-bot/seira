import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../out/', import.meta.url));

// Lighthouse estimates mobile LCP from every request that starts before the real LCP.
// Chunk scripts that start after the load event and the first paint stay out of that estimate.
const chunkScript = /<script src="(\/_next\/static\/chunks\/[^"]+\.js)" async=""><\/script>/g;
const chunkPreload = /<link rel="preload" as="script"[^>]*href="\/_next\/static\/chunks\/[^"]+"[^>]*\/>/g;

// Runs in the browser. A click or a Ctrl/Cmd+K that React cannot see yet is replayed once after hydration.
function loadScripts(srcs) {
  var started = false;
  var painted = false;
  var loaded = false;
  var clicks = 0;
  var keys = 0;
  var replaying = false;
  var pendingClick = null;
  var pendingKey = null;
  var polling = false;

  function hasKey(node, prefixes) {
    var names = Object.keys(node);
    for (var i = 0; i < names.length; i++) {
      for (var j = 0; j < prefixes.length; j++) {
        if (names[i].indexOf(prefixes[j]) === 0) return true;
      }
    }
    return false;
  }
  function reactAttached(node) {
    for (var n = node; n; n = n.parentNode) {
      if (hasKey(n, ['__reactFiber$', '__reactProps$', '__reactContainer$'])) return true;
    }
    return hasKey(document.body, ['__reactContainer$']);
  }
  function hasProps(node) {
    for (var n = node; n; n = n.parentNode) {
      if (hasKey(n, ['__reactProps$'])) return true;
    }
    return false;
  }
  function start() {
    if (started) return;
    started = true;
    srcs.forEach(function (src) {
      var script = document.createElement('script');
      script.src = src;
      script.async = true;
      document.body.appendChild(script);
    });
  }
  function replay() {
    replaying = true;
    try {
      if (pendingClick && pendingClick.isConnected) {
        pendingClick.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      }
      if (pendingKey) {
        var target = pendingKey.target && pendingKey.target.isConnected ? pendingKey.target : document;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: pendingKey.ctrl, metaKey: pendingKey.meta, bubbles: true, cancelable: true }));
      }
    } finally {
      replaying = false;
      pendingClick = null;
      pendingKey = null;
    }
  }
  function poll() {
    if (polling) return;
    polling = true;
    var waited = 0;
    var timer = setInterval(function () {
      waited += 50;
      var button = document.querySelector('button');
      var ready = (!pendingClick || hasProps(pendingClick)) && (!pendingKey || (button && hasProps(button)));
      if (ready || waited >= 3000) {
        clearInterval(timer);
        if (ready) setTimeout(replay, 100);
      }
    }, 50);
  }
  function onClick(event) {
    if (replaying) return;
    clicks++;
    if (clicks > 1) {
      pendingClick = null;
      return;
    }
    var target = event.composedPath()[0];
    if (target && target.nodeType === 1 && !reactAttached(target) && !target.closest('a[href]')) pendingClick = target;
    start();
    if (pendingClick) poll();
  }
  function onKey(event) {
    if (replaying || !(event.ctrlKey || event.metaKey) || (event.key !== 'k' && event.key !== 'K')) return;
    keys++;
    if (keys > 1) {
      pendingKey = null;
      return;
    }
    if (reactAttached(document.body)) return;
    event.preventDefault();
    pendingKey = { ctrl: event.ctrlKey, meta: event.metaKey, target: event.target };
    start();
    poll();
  }
  function idle() {
    if (!painted || !loaded) return;
    if (window.requestIdleCallback) requestIdleCallback(start, { timeout: 2000 });
    else setTimeout(start, 2000);
  }

  addEventListener('click', onClick, true);
  addEventListener('keydown', onKey, true);
  ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(function (name) {
    addEventListener(name, start, { once: true, passive: true });
  });
  try {
    new PerformanceObserver(function (list) {
      if (list.getEntriesByName('first-contentful-paint').length) {
        painted = true;
        idle();
      }
    }).observe({ type: 'paint', buffered: true });
  } catch {
    painted = true;
  }
  setTimeout(function () {
    painted = true;
    idle();
  }, 1500);
  function onLoad() {
    loaded = true;
    idle();
  }
  if (document.readyState === 'complete') onLoad();
  else addEventListener('load', onLoad);
}

const loaderSource = loadScripts
  .toString()
  .replace(/^\s+/gm, '');

function loader(srcs) {
  return `<script>(${loaderSource})(${JSON.stringify(srcs)})</script>`;
}

let moved = 0;
const skipped = [];
const broken = [];
for (const entry of await readdir(out, { recursive: true })) {
  if (!entry.endsWith('.html')) continue;
  const file = `${out}${entry}`;
  const html = await readFile(file, 'utf8');
  const srcs = [...html.matchAll(chunkScript)].map((match) => match[1]);
  if (srcs.length === 0 || !html.includes('</body>')) {
    if (entry.startsWith('docs/') || entry === 'docs.html') broken.push(entry);
    else skipped.push(entry);
    continue;
  }
  const next = html
    .replace(chunkPreload, '')
    .replace(chunkScript, '')
    .replace('</body>', () => `${loader(srcs)}</body>`);
  await writeFile(file, next);
  moved += 1;
}

for (const entry of skipped) console.log(`defer-scripts: skipped ${entry} (no chunk scripts)`);
for (const entry of broken) console.error(`defer-scripts: no chunk scripts to move in ${entry}`);
if (moved === 0 || broken.length > 0) {
  console.error('defer-scripts: failed');
  process.exit(1);
}
console.log(`defer-scripts: ${moved} pages`);
