// demo.js: a test page for the runtime. One bot, or a labeled grid of bots.
//
// Query keys (all optional):
//   style, eyes, mouth, hair (hex, no #), shell (hex), eyeColor (hex), personality, acc (comma list)
//   expr, state, weather, action, yaw (deg), simulate=tickle, reduced=1, seed
//   t     ms of bot time to run before the picture (default 1200). With t, the bot runs on a manual clock.
//   p     position in the action, 0..1 (default 0.5). The demo plays the action and runs to that point.
//   grid  expressions | actions | weather | states | sneeze | turns | hair | eyes | mouths | reduced | tickle
//   only  comma list that limits the grid cells, for example only=happy,sad
//   cols  grid columns
//   live=1  run on the normal animation clock (for a browser, not for screenshots)

import { createBot, EXPRESSIONS, ACTIONS, STATES, WEATHER, EYES, MOUTHS } from './bot.js';
import { ACTIONS as ACTION_DEFS } from './catalog.js';

const q = new URLSearchParams(location.search);
const A = window.__SEIRA_ASSETS || {};
let baseUrl = A.baseUrl;
if (!baseUrl) { try { baseUrl = new URL('../art/', import.meta.url).href; } catch { baseUrl = '../art/'; } }
const assetOpts = { bases: A.bases, stickers: A.stickers, baseUrl };
const hex = (v) => (v ? (v.startsWith('#') ? v : '#' + v) : undefined);

function baseConfig() {
  const c = {};
  if (q.get('style')) c.style = q.get('style');
  if (q.get('eyes')) c.eyes = q.get('eyes');
  if (q.get('mouth')) c.mouth = q.get('mouth');
  if (q.get('hair')) c.hairColor = hex(q.get('hair'));
  if (q.get('shell')) c.shell = hex(q.get('shell'));
  if (q.get('eyeColor')) c.eyeColor = hex(q.get('eyeColor'));
  if (q.get('personality')) c.personality = q.get('personality');
  if (q.get('acc')) c.accessories = q.get('acc').split(',');
  return c;
}

// Rub the pointer over the head: 8 fast direction changes.
function simulateTickle(bot) {
  const r = bot.canvas.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.42;
  for (let i = 0; i < 10; i++) {
    const x = cx + (i % 2 ? 1 : -1) * r.width * 0.08;
    bot.canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: cy, bubbles: true, pointerType: 'mouse' }));
  }
}

// Apply one cell spec to a bot, then run its clock.
async function run(bot, spec) {
  const ms = spec.t ?? +(q.get('t') || 1200);
  if (spec.yaw !== undefined) bot.turn(spec.yaw);
  if (spec.weather) bot.setWeather(spec.weather);
  if (spec.state) bot.setState(spec.state);
  if (spec.expr) bot.express(spec.expr);
  bot.tick(ms);
  if (spec.clear) { bot.setWeather(null); bot.tick(1500); }
  if (spec.tickle) {
    simulateTickle(bot);
    const giggle = ACTION_DEFS.giggle;
    bot.tick(giggle.ms * (spec.p ?? 0.4));
  }
  if (spec.action) {
    const def = ACTION_DEFS[spec.action];
    const done = bot.play(spec.action);
    bot.tick(def ? def.ms * (spec.p ?? +(q.get('p') || 0.5)) : 16);
    done.then(() => {});
  }
}

function cellsFor(grid) {
  const only = q.get('only') ? q.get('only').split(',') : null;
  const pick = (arr) => (only ? arr.filter((c) => only.includes(c.id)) : arr);
  switch (grid) {
    case 'expressions': return pick(EXPRESSIONS.map((e) => ({ id: e.id, label: e.label, expr: e.id })));
    case 'actions': return pick(ACTIONS.map((a) => ({ id: a.id, label: a.label + ' (mid)', action: a.id })));
    case 'weather': return pick([...WEATHER.map((w) => ({ id: w.id, label: w.label, weather: w.id, t: 3000 })),
      { id: 'none', label: 'rain, then setWeather(null)', weather: 'rain', t: 3000, clear: true }]);
    case 'states': return pick(STATES.map((s) => ({ id: s.id, label: s.label, state: s.id, t: 900 })));
    case 'sneeze': return [0.25, 0.45, 0.53, 0.58, 0.8].map((p) => ({ id: 'p' + p, label: 'sneeze p=' + p, action: 'sneeze', p }));
    case 'turns': return pick([-90, -45, -20, 0, 20, 45, 90, 180].map((y) => ({ id: String(y), label: 'yaw ' + y, yaw: y })));
    case 'hair': return pick([null, '#3B3F4A', '#C8475B', '#2F7DE1', '#E8C15A', '#7A4BD1']
      .map((h) => ({ id: h || 'default', label: 'hair ' + (h || 'default'), config: { hairColor: h } })));
    case 'eyes': return pick(EYES.map((e) => ({ id: e.id, label: 'eyes: ' + e.label, config: { eyes: e.id } })));
    case 'mouths': return pick(MOUTHS.map((m) => ({ id: m.id, label: 'mouth: ' + m.label, config: { mouth: m.id } })));
    case 'reduced': return [
      { id: 'idle', label: 'reduced: idle', reduced: true },
      { id: 'hop', label: 'reduced: hop (mid)', reduced: true, action: 'hop' },
      { id: 'rain', label: 'reduced: rain', reduced: true, weather: 'rain', t: 3000 },
      { id: 'snow', label: 'reduced: snow', reduced: true, weather: 'snow', t: 3000 },
      { id: 'love', label: 'reduced: love', reduced: true, expr: 'love' },
      { id: 'sneeze', label: 'reduced: sneeze (jerk)', reduced: true, action: 'sneeze', p: 0.55 },
    ];
    case 'tickle': return [
      { id: 'before', label: 'before tickle' },
      { id: 'giggle', label: 'tickle -> giggle', tickle: true, p: 0.35 },
      { id: 'giggle2', label: 'tickle -> giggle (late)', tickle: true, p: 0.7 },
    ];
    default: return [];
  }
}

function errorBox(err) {
  const p = document.createElement('pre');
  p.style.cssText = 'position:fixed;left:8px;bottom:8px;margin:0;color:#B01235;font:12px monospace;white-space:pre-wrap';
  p.textContent = 'demo error: ' + String((err && err.stack) || err);
  document.body.appendChild(p);
}

async function single(stage) {
  const live = q.get('live') === '1';
  const reduced = q.get('reduced') === '1' ? true : undefined;
  const bot = await createBot(stage, baseConfig(), { ...assetOpts, manual: !live, reduced, seed: +(q.get('seed') || 7) });
  window.bot = bot;
  bot.on('tickle', () => { document.body.dataset.tickle = '1'; });
  const spec = {
    expr: q.get('expr'), state: q.get('state'), weather: q.get('weather'), action: q.get('action'),
    yaw: q.has('yaw') ? +q.get('yaw') : undefined, tickle: q.get('simulate') === 'tickle',
  };
  if (live) {
    if (spec.yaw !== undefined) bot.turn(spec.yaw);
    if (spec.weather) bot.setWeather(spec.weather);
    if (spec.state) bot.setState(spec.state);
    if (spec.expr) bot.express(spec.expr);
    if (spec.action) bot.play(spec.action);
  } else {
    await run(bot, spec);
  }
}

async function grid(stage, name) {
  const cells = cellsFor(name);
  const cols = +(q.get('cols') || Math.ceil(Math.sqrt(cells.length)));
  stage.style.cssText = `position:static;display:grid;grid-template-columns:repeat(${cols},1fr);gap:6px;padding:8px;box-sizing:border-box`;
  const reducedAll = q.get('reduced') === '1';
  let i = 0;
  for (const c of cells) {
    const box = document.createElement('figure');
    box.style.cssText = 'margin:0;background:#FFF;border-radius:8px;overflow:hidden;display:flex;flex-direction:column';
    const holder = document.createElement('div');
    holder.style.cssText = 'aspect-ratio:3.8/4.05;width:100%';
    const cap = document.createElement('figcaption');
    cap.style.cssText = 'padding:2px 6px 4px;font-weight:600;text-align:center';
    cap.textContent = c.label;
    box.append(holder, cap);
    stage.appendChild(box);
    const cfg = { ...baseConfig(), ...c.config };
    const bot = await createBot(holder, cfg, { ...assetOpts, manual: true, reduced: c.reduced || reducedAll || undefined, seed: 11 + i++ });
    let tickled = false;
    bot.on('tickle', () => { tickled = true; });
    await run(bot, c);
    if (c.tickle) cap.textContent += tickled ? ' (tickle event: yes)' : ' (tickle event: NO)';
  }
}

async function main() {
  const stage = document.getElementById('stage');
  const g = q.get('grid');
  if (g) await grid(stage, g);
  else await single(stage);
  document.body.dataset.ready = '1';
  if (q.get('debug') === '1' && window.bot) {
    const pre = document.createElement('pre');
    pre.style.cssText = 'position:fixed;left:4px;top:4px;margin:0;font:11px monospace;white-space:pre-wrap;color:#123';
    const d = window.bot.debug();
    const cv = d.canvases; delete d.canvases;
    pre.textContent = JSON.stringify(d, null, 0);
    document.body.appendChild(pre);
    let y = 60;
    for (const [name, c] of Object.entries(cv)) {
      c.style.cssText = `position:fixed;right:4px;top:${y}px;width:240px;border:1px solid #c00;background:#8a8`;
      c.title = name;
      document.body.appendChild(c);
      y += 240 * c.height / c.width + 8;
    }
  }
}

main().catch(errorBox);
