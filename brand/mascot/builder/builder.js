// Character builder.
// Call mountBuilder(root, { runtime, bases, stickers, cast, baseUrl }).
// The caller passes the runtime module, so tests can pass a stub.

import { eyeIcon, mouthIcon } from './icons.js';

const DEFAULT_SHELL = '#ECEEF1';
const DEFAULT_SCREEN = '#0C0F14';
const DEFAULT_HAIR = '#2B2B33';
const MAX_ACCESSORIES = 3;
const MSG_LIMIT = 'Pick up to 3. Remove one to add another.';
const MSG_SLOT = 'Only one item fits here. Remove the other one first.';
const MSG_HAIR_NATIVE = 'This head keeps its own hair color.';
const MSG_HAIR_NONE = 'This head has no hair.';

const HAIR_SWATCHES = [
  ['#1B1D22', 'Black'], ['#4A2F22', 'Brown'], ['#8A5A3B', 'Chestnut'], ['#D9B26F', 'Blonde'],
  ['#E9ECEF', 'Silver'], ['#E11D48', 'Red'], ['#3B82F6', 'Blue'], ['#8B5CF6', 'Violet'],
];
const EYE_COLORS = [
  ['#FF2A57', 'Red'], ['#3B82F6', 'Blue'], ['#22C55E', 'Green'], ['#F59E0B', 'Amber'],
  ['#8B5CF6', 'Violet'], ['#14B8A6', 'Teal'], ['#F472B6', 'Pink'], ['#E5E7EB', 'White'],
];

const GENDERS = [['f', 'Female'], ['m', 'Male'], ['u', 'Any']];
const BROWS = [['none', 'None'], ['thin', 'Thin'], ['thick', 'Thick'], ['angled', 'Angled']];
const PERSONALITIES = ['calm', 'cheerful', 'cool', 'playful', 'shy', 'proud'];

// Fallback ids from the shared contract. Used when a manifest is missing or empty.
const FALLBACK = {
  EYES: ['pill', 'round', 'sharp', 'almond', 'sleepy', 'dot', 'star', 'square'],
  MOUTHS: ['smile', 'cat', 'flat', 'grin', 'fang', 'small-o', 'smirk'],
  EXPRESSIONS: ['calm', 'happy', 'laugh', 'giggle', 'love', 'shy', 'proud', 'surprised', 'confused', 'thinking',
    'sad', 'cry', 'pout', 'angry', 'sleepy', 'asleep', 'wink', 'bored', 'determined', 'dizzy', 'smug', 'scared',
    'cold', 'hot', 'sick'],
  ACTIONS: ['wave', 'nod', 'shake-head', 'bow', 'hop', 'spin', 'dance-1', 'dance-2', 'dance-3', 'laugh', 'giggle',
    'sneeze', 'hiccup', 'yawn', 'stretch', 'think', 'idea', 'celebrate', 'oops', 'greet', 'bye', 'shiver',
    'fan-self', 'wipe-sweat', 'peek', 'clap', 'facepalm'],
  STATES: ['idle', 'listening', 'thinking', 'talking', 'working', 'success', 'error', 'sleeping'],
  WEATHER: ['sunny', 'hot', 'cold', 'rain', 'storm', 'snow', 'wind', 'fog'],
};

const FALLBACK_STYLES = [
  ['seira', 'f', false],
  ['seira-long', 'f', true], ['bob', 'f', true], ['twin-tails', 'f', true], ['ponytail', 'f', true],
  ['long-straight', 'f', true], ['bun', 'f', true], ['long-wavy', 'f', true],
  ['short-neat', 'm', true], ['center-part', 'm', true], ['spiky', 'm', true], ['slick-back', 'm', true],
  ['long-tied', 'm', true], ['long-loose', 'm', true], ['buzz', 'm', true], ['messy', 'm', true],
  ['none', 'u', false],
];

const FALLBACK_ACCESSORIES = [
  ['earring', 'ear'], ['glasses', 'face'], ['sunglasses', 'face'], ['headphones', 'ear'], ['ribbon', 'hair'],
  ['hairpin', 'hair'], ['tiara', 'hair'], ['cap', 'top'], ['antenna', 'top'], ['scarf', 'neck'],
  ['bowtie', 'neck'], ['headset-mic', 'ear'],
];

const SEIRA_DEFAULT = {
  id: 'seira', name: 'Seira', gender: 'f', style: 'seira', hairColor: null,
  shell: DEFAULT_SHELL, screen: DEFAULT_SCREEN, eyes: 'pill', eyeColor: '#FF2A57', lashes: true,
  brows: 'none', mouth: 'smile', blush: false, accessories: [], hands: true, personality: 'calm',
};

// ---------- small helpers ----------

export function labelFromId(id) {
  return String(id).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function slugify(text) {
  const s = String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'bot';
}

function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

// Accept an array of strings, an array of { id, label }, or an object keyed by id.
export function normalizeCatalog(source, fallbackIds) {
  let items = [];
  if (Array.isArray(source)) {
    items = source.map((x) => {
      if (typeof x === 'string') return { id: x };
      if (x && typeof x === 'object' && x.id != null) return { ...x, id: String(x.id) };
      return null;
    });
  } else if (source && typeof source === 'object') {
    items = Object.keys(source).map((id) => {
      const v = source[id];
      if (typeof v === 'string') return { id, label: v };
      return { ...(v && typeof v === 'object' ? v : {}), id };
    });
  }
  items = items.filter(Boolean);
  if (!items.length) items = fallbackIds.map((id) => ({ id }));
  const seen = new Set();
  return items
    .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
    .map((it) => ({ ...it, label: it.label || labelFromId(it.id) }));
}

function buildStyles(bases, castList) {
  const meta = new Map(FALLBACK_STYLES.map(([id, gender, recolor]) => [id, { gender, recolor }]));
  const src = bases && bases.styles && typeof bases.styles === 'object' ? bases.styles : null;
  let list = [];
  if (src && Object.keys(src).length) {
    list = Object.keys(src).map((id) => {
      const s = src[id] || {};
      const fb = meta.get(id) || { gender: 'u', recolor: true };
      return {
        id,
        label: s.label || labelFromId(id),
        gender: ['f', 'm', 'u'].includes(s.gender) ? s.gender : fb.gender,
        recolor: typeof s.recolor === 'boolean' ? s.recolor : fb.recolor,
      };
    });
  } else {
    list = FALLBACK_STYLES.map(([id, gender, recolor]) => ({ id, label: labelFromId(id), gender, recolor }));
  }
  // A preset may use a style that a partial manifest does not list yet.
  for (const c of castList) {
    if (c && typeof c.style === 'string' && !list.some((s) => s.id === c.style)) {
      const fb = meta.get(c.style) || { gender: ['f', 'm', 'u'].includes(c.gender) ? c.gender : 'u', recolor: true };
      list.push({ id: c.style, label: labelFromId(c.style), gender: fb.gender, recolor: fb.recolor });
    }
  }
  return list;
}

function buildAccessories(stickers, castList) {
  const slotOf = new Map(FALLBACK_ACCESSORIES);
  const src = stickers && stickers.accessories && typeof stickers.accessories === 'object' ? stickers.accessories : null;
  let list;
  if (src && Object.keys(src).length) {
    list = Object.keys(src).map((id) => {
      const a = src[id] || {};
      return { id, label: a.label || labelFromId(id), slot: a.slot || slotOf.get(id) || id };
    });
  } else {
    list = FALLBACK_ACCESSORIES.map(([id, slot]) => ({ id, label: labelFromId(id), slot }));
  }
  for (const c of castList) {
    for (const id of (c && Array.isArray(c.accessories) ? c.accessories : [])) {
      if (typeof id === 'string' && !list.some((a) => a.id === id)) {
        list.push({ id, label: labelFromId(id), slot: slotOf.get(id) || id });
      }
    }
  }
  return list;
}

// Create a DOM element. Children can be nodes, strings, or arrays of them.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

// ---------- main ----------

export async function mountBuilder(root, options = {}) {
  const { runtime = {}, bases = null, stickers = null, cast = null, baseUrl } = options;

  const eyes = normalizeCatalog(runtime.EYES, FALLBACK.EYES);
  const mouths = normalizeCatalog(runtime.MOUTHS, FALLBACK.MOUTHS);
  const expressions = normalizeCatalog(runtime.EXPRESSIONS, FALLBACK.EXPRESSIONS);
  const actions = normalizeCatalog(runtime.ACTIONS, FALLBACK.ACTIONS);
  const states = normalizeCatalog(runtime.STATES, FALLBACK.STATES);
  const weather = normalizeCatalog(runtime.WEATHER, FALLBACK.WEATHER);

  const castList = (Array.isArray(cast) ? cast : []).filter((c) => c && typeof c === 'object' && c.id);
  const presets = castList.length ? castList : [SEIRA_DEFAULT];
  const styles = buildStyles(bases, castList);
  const accessories = buildAccessories(stickers, castList);
  const styleById = new Map(styles.map((s) => [s.id, s]));
  const accById = new Map(accessories.map((a) => [a.id, a]));

  // ----- config handling -----

  function visibleStyles(gender) {
    return gender === 'u' ? styles : styles.filter((s) => s.gender === gender || s.gender === 'u');
  }

  // Return a valid config built from any input. `notes.count` counts the values that were replaced.
  function sanitize(raw, notes = { count: 0 }) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const base = presets[0] || SEIRA_DEFAULT;
    const fix = (ok, value, fallback) => {
      if (ok) return value;
      if (value !== undefined) notes.count++;
      return fallback;
    };
    const out = {};
    out.name = typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 40) : (notes.count++, 'My Bot');
    out.id = slugify(out.name);
    out.gender = fix(['f', 'm', 'u'].includes(src.gender), src.gender, 'f');
    const styleOk = typeof src.style === 'string' && styleById.has(src.style);
    out.style = styleOk ? src.style : (visibleStyles(out.gender)[0] || styles[0]).id;
    if (!styleOk) notes.count++;
    const recolor = (styleById.get(out.style) || {}).recolor !== false;
    const hair = normalizeHex(src.hairColor);
    out.hairColor = recolor ? (src.hairColor === null || hair ? hair : fix(false, src.hairColor, DEFAULT_HAIR)) : null;
    out.shell = fix(!!normalizeHex(src.shell), normalizeHex(src.shell), DEFAULT_SHELL);
    out.screen = fix(!!normalizeHex(src.screen), normalizeHex(src.screen), DEFAULT_SCREEN);
    out.eyes = fix(eyes.some((e) => e.id === src.eyes), src.eyes, eyes[0].id);
    out.eyeColor = fix(!!normalizeHex(src.eyeColor), normalizeHex(src.eyeColor), base.eyeColor || '#ff2a57');
    out.lashes = fix(typeof src.lashes === 'boolean', src.lashes, false);
    out.brows = fix(BROWS.some((b) => b[0] === src.brows), src.brows, 'none');
    out.mouth = fix(mouths.some((m) => m.id === src.mouth), src.mouth, mouths[0].id);
    out.blush = fix(typeof src.blush === 'boolean', src.blush, false);
    const accs = [];
    const slots = new Set();
    const wanted = Array.isArray(src.accessories) ? src.accessories : (src.accessories === undefined ? [] : (notes.count++, []));
    for (const id of wanted) {
      const a = accById.get(id);
      if (!a || accs.includes(id) || slots.has(a.slot) || accs.length >= MAX_ACCESSORIES) { notes.count++; continue; }
      accs.push(id);
      slots.add(a.slot);
    }
    out.accessories = accs;
    out.hands = fix(typeof src.hands === 'boolean', src.hands, true);
    out.personality = fix(PERSONALITIES.includes(src.personality), src.personality, 'calm');
    const dropped = Object.keys(src).filter((k) => !(k in out) && k !== 'id');
    notes.count += dropped.length;
    return out;
  }

  const initial = sanitize(presets[0]);
  initial.name = presets[0].name || initial.name;
  initial.id = presets[0].id || slugify(initial.name);
  let cfg = initial;
  let lastHair = cfg.hairColor || DEFAULT_HAIR;
  let activePreset = presets[0].id;

  let bot = null;

  async function startBot() {
    try {
      if (typeof runtime.createBot !== 'function') return null;
      const opts = {};
      if (bases) opts.bases = bases;
      if (stickers) opts.stickers = stickers;
      if (baseUrl) opts.baseUrl = baseUrl;
      return await runtime.createBot(stageEl, exportConfig(), opts);
    } catch (err) {
      console.error(err);
      stageEl.append(h('p', { class: 'stage-error', role: 'alert', text: 'The preview could not start. You can still edit and save your character.' }));
      return null;
    }
  }

  function callBot(name, ...args) {
    try {
      if (bot && typeof bot[name] === 'function') return bot[name](...args);
    } catch (err) {
      console.error(err);
    }
    return undefined;
  }

  function exportConfig() {
    return {
      id: cfg.id, name: cfg.name, gender: cfg.gender, style: cfg.style, hairColor: cfg.hairColor,
      shell: cfg.shell, screen: cfg.screen, eyes: cfg.eyes, eyeColor: cfg.eyeColor, lashes: cfg.lashes,
      brows: cfg.brows, mouth: cfg.mouth, blush: cfg.blush, accessories: cfg.accessories.slice(),
      hands: cfg.hands, personality: cfg.personality,
    };
  }

  function currentStyle() {
    return styleById.get(cfg.style) || { recolor: true };
  }

  // Apply a partial change: update state, tell the bot, refresh the controls.
  function change(partial) {
    const p = { ...partial };
    if ('name' in p) cfg.id = slugify(p.name);
    if ('style' in p) {
      const recolor = (styleById.get(p.style) || {}).recolor !== false;
      if (!recolor) p.hairColor = null;
      else if (cfg.hairColor === null && !('hairColor' in p)) p.hairColor = lastHair;
    }
    if ('hairColor' in p && p.hairColor) lastHair = p.hairColor;
    Object.assign(cfg, p);
    const botPart = { ...p };
    delete botPart.name;
    callBot('setConfig', botPart);
    if ('gender' in p) {
      const visible = visibleStyles(cfg.gender);
      renderStyleGrid();
      if (!visible.some((s) => s.id === cfg.style)) {
        change({ style: visible[0].id });
        return;
      }
    }
    sync();
  }

  function loadConfig(next, presetId) {
    cfg = { ...next, accessories: next.accessories.slice() };
    if (cfg.hairColor) lastHair = cfg.hairColor;
    activePreset = presetId || null;
    renderStyleGrid();
    callBot('setConfig', exportConfig());
    sync();
  }

  function loadPreset(id) {
    const p = presets.find((x) => x.id === id);
    if (!p) return false;
    const next = sanitize(p);
    next.name = p.name || next.name;
    next.id = p.id;
    loadConfig(next, p.id);
    return true;
  }

  // ----- DOM: layout -----

  root.classList.add('builder');
  root.textContent = '';
  const stageEl = h('div', { class: 'stage', role: 'img', 'aria-label': 'Character preview' });
  const preview = h('div', { class: 'preview' });
  const panel = h('div', { class: 'panel' });
  const note = h('p', { class: 'note', role: 'status', 'aria-live': 'polite' });
  root.append(
    h('div', { class: 'left' }, stageEl, preview),
    h('div', { class: 'right' }, panel),
  );
  let noteTimer = 0;
  function say(text) {
    note.textContent = text;
    clearTimeout(noteTimer);
    if (text) noteTimer = setTimeout(() => { note.textContent = ''; }, 6000);
  }

  const syncers = [];

  function section(title, ...kids) {
    const hid = nextId('sec');
    return h('section', { class: 'sec', 'aria-labelledby': hid }, h('h2', { id: hid, text: title }), ...kids);
  }

  function group(legend, ...kids) {
    return h('fieldset', { class: 'grp' }, h('legend', { text: legend }), ...kids);
  }

  // A radio choice. `content` is shown inside the label.
  function radio(name, value, content, onPick, extraClass = '') {
    const input = h('input', { type: 'radio', name, value });
    input.addEventListener('change', () => { if (input.checked) onPick(value); });
    const label = h('label', { class: 'opt ' + extraClass }, input, h('span', { class: 'opt-body' }, content));
    return { label, input };
  }

  function colorRow(labelText, getValue, onInput, swatches) {
    const id = nextId('color');
    const input = h('input', { type: 'color', id });
    input.addEventListener('input', () => onInput(input.value));
    const row = h('div', { class: 'color-row' }, h('label', { for: id, text: labelText }), input);
    let buttons = [];
    if (swatches) {
      const wrap = h('div', { class: 'swatches', role: 'group', 'aria-label': labelText + ' presets' });
      buttons = swatches.map(([hex, name]) => {
        const b = h('button', { type: 'button', class: 'swatch', style: `background:${hex}`, title: name, 'aria-label': name, 'aria-pressed': 'false' });
        b.addEventListener('click', () => onInput(hex));
        wrap.append(b);
        return [hex, b];
      });
      row.append(wrap);
    }
    return { row, input, buttons };
  }

  // ----- DOM: preview bar -----

  function chipGroup(title, items, onPick, opts = {}) {
    const chips = new Map();
    const wrap = h('div', { class: 'chips' });
    const list = opts.off ? [{ id: null, label: 'Off' }, ...items] : items;
    for (const it of list) {
      const b = h('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-id': it.id === null ? 'off' : it.id, text: it.label });
      b.addEventListener('click', () => onPick(it.id));
      wrap.append(b);
      chips.set(it.id, b);
    }
    const key = title.toLowerCase();
    const tabId = nextId('tab');
    const panelId = nextId('tabpanel');
    const tab = h('button', { type: 'button', class: 'tab', role: 'tab', id: tabId, 'aria-controls': panelId,
      'aria-selected': 'false', tabindex: '-1', text: title });
    const el = h('div', { class: 'pv-panel', role: 'tabpanel', id: panelId, 'aria-labelledby': tabId, hidden: true }, wrap);
    function setPressed(id) {
      for (const [k, b] of chips) b.setAttribute('aria-pressed', k === id ? 'true' : 'false');
    }
    return { key, el, tab, chips, setPressed };
  }

  const exprGroup = chipGroup('Expressions', expressions, (id) => setExpression(id));
  const actGroup = chipGroup('Actions', actions, (id) => runAction(id));
  const stateGroup = chipGroup('States', states, (id) => setState(id));
  const weatherGroup = chipGroup('Weather', weather, (id) => setWeather(id), { off: true });
  weatherGroup.setPressed(null);
  const tabGroups = [exprGroup, actGroup, stateGroup, weatherGroup];
  const tabList = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Preview' }, tabGroups.map((g) => g.tab));
  preview.append(tabList, ...tabGroups.map((g) => g.el));

  function selectTab(group, focus) {
    for (const g of tabGroups) {
      const on = g === group;
      g.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      g.tab.tabIndex = on ? 0 : -1;
      g.el.hidden = !on;
    }
    if (focus) group.tab.focus();
  }
  tabGroups.forEach((g, i) => {
    g.tab.addEventListener('click', () => selectTab(g, false));
    g.tab.addEventListener('keydown', (ev) => {
      const n = tabGroups.length;
      let j = -1;
      if (ev.key === 'ArrowRight') j = (i + 1) % n;
      else if (ev.key === 'ArrowLeft') j = (i + n - 1) % n;
      else if (ev.key === 'Home') j = 0;
      else if (ev.key === 'End') j = n - 1;
      if (j < 0) return;
      ev.preventDefault();
      selectTab(tabGroups[j], true);
    });
  });
  selectTab(exprGroup, false);

  function setExpression(id) {
    callBot('express', id);
    exprGroup.setPressed(id);
  }

  function setState(id) {
    callBot('setState', id);
    stateGroup.setPressed(id);
  }

  function setWeather(id) {
    callBot('setWeather', id);
    weatherGroup.setPressed(id);
  }

  function setActionsDisabled(flag) {
    for (const b of actGroup.chips.values()) b.disabled = flag;
  }

  async function runAction(id) {
    setActionsDisabled(true);
    actGroup.setPressed(id);
    try {
      await callBot('play', id);
    } catch (err) {
      console.error(err);
    } finally {
      actGroup.setPressed(null);
      setActionsDisabled(false);
    }
  }

  // ----- DOM: panel sections -----

  // Characters
  const presetRadios = new Map();
  const presetWrap = h('div', { class: 'chips', role: 'group', 'aria-label': 'Characters' });
  for (const p of presets) {
    const isMain = p.id === 'seira';
    const b = h('button', { type: 'button', class: 'chip' + (isMain ? ' main' : ''), 'aria-pressed': 'false', 'data-id': p.id },
      p.name || labelFromId(p.id), isMain ? h('span', { class: 'tag', text: 'Main' }) : null);
    b.addEventListener('click', () => loadPreset(p.id));
    presetWrap.append(b);
    presetRadios.set(p.id, b);
  }
  panel.append(section('Characters', presetWrap));

  // Name
  const nameId = nextId('name');
  const nameInput = h('input', { type: 'text', id: nameId, maxlength: '40', autocomplete: 'off' });
  nameInput.addEventListener('input', () => change({ name: nameInput.value }));
  const idHint = h('p', { class: 'hint' });
  panel.append(section('Name', h('div', { class: 'field' }, h('label', { for: nameId, text: 'Character name' }), nameInput), idHint));

  // Body
  const genderRadios = new Map();
  const genderRow = h('div', { class: 'chips' });
  for (const [val, text] of GENDERS) {
    const r = radio('gender', val, text, (v) => change({ gender: v }));
    genderRow.append(r.label);
    genderRadios.set(val, r.input);
  }
  const styleGrid = h('div', { class: 'grid styles' });
  const styleRadios = new Map();
  function renderStyleGrid() {
    styleGrid.textContent = '';
    styleRadios.clear();
    for (const s of visibleStyles(cfg.gender)) {
      const r = radio('style', s.id, s.label, (v) => change({ style: v }));
      styleGrid.append(r.label);
      styleRadios.set(s.id, r.input);
    }
  }
  panel.append(section('Body', group('Gender', genderRow), group('Head style', styleGrid)));

  // Hair
  const hair = colorRow('Hair color', () => cfg.hairColor, (v) => change({ hairColor: v }), HAIR_SWATCHES);
  const nativeBtn = h('button', { type: 'button', class: 'btn small', 'aria-pressed': 'false', text: 'Native' });
  nativeBtn.addEventListener('click', () => change({ hairColor: null }));
  hair.row.append(nativeBtn);
  const hairReason = h('p', { class: 'hint reason' });
  panel.append(section('Hair', hair.row, hairReason));

  // Face
  const eyeRadios = new Map();
  const eyeIcons = new Map();
  const eyeGrid = h('div', { class: 'grid icons' });
  for (const e of eyes) {
    const icon = h('span', { class: 'tile' });
    const r = radio('eyes', e.id, [icon, h('span', { class: 'cap', text: e.label })], (v) => change({ eyes: v }), 'has-icon');
    eyeGrid.append(r.label);
    eyeRadios.set(e.id, r.input);
    eyeIcons.set(e.id, icon);
  }
  const eyeColor = colorRow('Eye color', () => cfg.eyeColor, (v) => change({ eyeColor: v }), EYE_COLORS);
  const lashes = checkbox('Lashes', (v) => change({ lashes: v }));
  const browRadios = new Map();
  const browRow = h('div', { class: 'chips' });
  for (const [val, text] of BROWS) {
    const r = radio('brows', val, text, (v) => change({ brows: v }));
    browRow.append(r.label);
    browRadios.set(val, r.input);
  }
  const mouthRadios = new Map();
  const mouthIcons = new Map();
  const mouthGrid = h('div', { class: 'grid icons' });
  for (const m of mouths) {
    const icon = h('span', { class: 'tile' });
    const r = radio('mouth', m.id, [icon, h('span', { class: 'cap', text: m.label })], (v) => change({ mouth: v }), 'has-icon');
    mouthGrid.append(r.label);
    mouthRadios.set(m.id, r.input);
    mouthIcons.set(m.id, icon);
  }
  const blush = checkbox('Blush', (v) => change({ blush: v }));
  panel.append(section('Face',
    group('Eyes', eyeGrid), eyeColor.row, lashes.el,
    group('Brows', browRow),
    group('Mouth', mouthGrid), blush.el));

  function checkbox(text, onChange) {
    const input = h('input', { type: 'checkbox' });
    input.addEventListener('change', () => onChange(input.checked));
    return { input, el: h('label', { class: 'check' }, input, h('span', { text })) };
  }

  // Colors
  const shell = colorRow('Shell color', () => cfg.shell, (v) => change({ shell: v }));
  const screen = colorRow('Screen color', () => cfg.screen, (v) => change({ screen: v }));
  const resetBtn = h('button', { type: 'button', class: 'btn small', text: 'Reset' });
  resetBtn.addEventListener('click', () => change({ shell: DEFAULT_SHELL, screen: DEFAULT_SCREEN }));
  panel.append(section('Colors', shell.row, screen.row, h('div', { class: 'row' }, resetBtn)));

  // Accessories
  const accChips = new Map();
  const accWrap = h('div', { class: 'chips acc' });
  for (const a of accessories) {
    const input = h('input', { type: 'checkbox', value: a.id });
    const reason = h('span', { class: 'why' });
    const rid = nextId('why');
    reason.id = rid;
    input.addEventListener('change', () => toggleAccessory(a.id, input.checked));
    const label = h('label', { class: 'opt acc-opt' }, input, h('span', { class: 'opt-body' }, a.label, reason));
    accWrap.append(label);
    accChips.set(a.id, { input, reason, label });
  }
  panel.append(section('Accessories', accWrap));

  function toggleAccessory(id, on) {
    const list = cfg.accessories.filter((x) => x !== id);
    if (on) list.push(id);
    change({ accessories: list });
  }

  // Hands and personality
  const hands = checkbox('Show hands', (v) => change({ hands: v }));
  const persRadios = new Map();
  const persRow = h('div', { class: 'chips', role: 'group', 'aria-label': 'Personality' });
  for (const p of PERSONALITIES) {
    const r = radio('personality', p, labelFromId(p), (v) => change({ personality: v }));
    persRow.append(r.label);
    persRadios.set(p, r.input);
  }
  panel.append(section('Hands', hands.el), section('Personality', persRow));

  // Export
  const copyBtn = h('button', { type: 'button', class: 'btn primary', text: 'Copy JSON' });
  const downloadBtn = h('button', { type: 'button', class: 'btn', text: 'Download JSON' });
  const importBtn = h('button', { type: 'button', class: 'btn', text: 'Import JSON' });
  const randomBtn = h('button', { type: 'button', class: 'btn', text: 'Random' });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, tabindex: '-1' });
  copyBtn.addEventListener('click', copyJson);
  downloadBtn.addEventListener('click', downloadJson);
  importBtn.addEventListener('click', () => fileInput.click());
  randomBtn.addEventListener('click', randomize);
  fileInput.addEventListener('change', importFile);
  panel.append(section('Export', h('div', { class: 'row wrap' }, copyBtn, downloadBtn, importBtn, randomBtn, fileInput), note));

  async function copyJson() {
    const text = JSON.stringify(exportConfig(), null, 2);
    try {
      await navigator.clipboard.writeText(text);
      say('Copied.');
    } catch (err) {
      const ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;left:-9999px' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
      say(ok ? 'Copied.' : 'Copy did not work. Use Download JSON instead.');
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(exportConfig(), null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: cfg.id + '.json' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    say('Saved ' + cfg.id + '.json.');
  }

  async function importFile() {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (err) {
      say('This file could not be read. Pick a JSON file from this page.');
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      say('This file does not hold a character.');
      return;
    }
    const notes = { count: 0 };
    const next = sanitize(data, notes);
    if (typeof data.name !== 'string' || !data.name.trim()) next.name = 'My Bot';
    next.id = slugify(next.name);
    loadConfig(next, null);
    say(notes.count ? `Loaded. ${notes.count} ${notes.count === 1 ? 'value was' : 'values were'} changed to fit.` : 'Loaded.');
  }

  function randomize() {
    const gender = pick(['f', 'm']);
    const style = pick(visibleStyles(gender).filter((s) => s.id !== 'none' || Math.random() < 0.1));
    const recolor = style.recolor !== false;
    const accs = [];
    const slots = new Set();
    for (const a of accessories.slice().sort(() => Math.random() - 0.5)) {
      if (accs.length >= pick([0, 1, 2, 3])) break;
      if (slots.has(a.slot)) continue;
      accs.push(a.id);
      slots.add(a.slot);
    }
    const next = sanitize({
      name: 'Random Bot', gender, style: style.id,
      hairColor: recolor ? pick(HAIR_SWATCHES)[0] : null,
      shell: DEFAULT_SHELL, screen: DEFAULT_SCREEN,
      eyes: pick(eyes).id, eyeColor: pick(EYE_COLORS)[0], lashes: Math.random() < 0.5,
      brows: pick(BROWS)[0], mouth: pick(mouths).id, blush: Math.random() < 0.4,
      accessories: accs, hands: Math.random() < 0.8, personality: pick(PERSONALITIES),
    });
    loadConfig(next, null);
    say('Made a new random character.');
  }

  // ----- sync: copy state into every control -----

  function sync() {
    if (nameInput.value !== cfg.name) nameInput.value = cfg.name;
    idHint.textContent = 'File name: ' + cfg.id + '.json';
    for (const [id, b] of presetRadios) b.setAttribute('aria-pressed', id === activePreset ? 'true' : 'false');
    for (const [v, input] of genderRadios) input.checked = v === cfg.gender;
    for (const [v, input] of styleRadios) input.checked = v === cfg.style;

    const st = currentStyle();
    const canColor = st.recolor !== false;
    const shown = cfg.hairColor || lastHair;
    hair.input.value = shown;
    hair.input.disabled = !canColor;
    for (const [hex, b] of hair.buttons) {
      b.disabled = !canColor;
      b.setAttribute('aria-pressed', canColor && cfg.hairColor === hex.toLowerCase() ? 'true' : 'false');
    }
    nativeBtn.disabled = !canColor;
    nativeBtn.setAttribute('aria-pressed', cfg.hairColor === null ? 'true' : 'false');
    hairReason.textContent = canColor ? '' : (cfg.style === 'none' ? MSG_HAIR_NONE : MSG_HAIR_NATIVE);

    for (const [v, input] of eyeRadios) input.checked = v === cfg.eyes;
    for (const [id, icon] of eyeIcons) icon.innerHTML = eyeIcon(id, cfg.eyeColor);
    for (const [id, icon] of mouthIcons) icon.innerHTML = mouthIcon(id, cfg.eyeColor);
    eyeColor.input.value = cfg.eyeColor;
    for (const [hex, b] of eyeColor.buttons) b.setAttribute('aria-pressed', cfg.eyeColor === hex.toLowerCase() ? 'true' : 'false');
    lashes.input.checked = cfg.lashes;
    for (const [v, input] of browRadios) input.checked = v === cfg.brows;
    for (const [v, input] of mouthRadios) input.checked = v === cfg.mouth;
    blush.input.checked = cfg.blush;
    shell.input.value = cfg.shell;
    screen.input.value = cfg.screen;
    hands.input.checked = cfg.hands;
    for (const [v, input] of persRadios) input.checked = v === cfg.personality;

    const usedSlots = new Map();
    for (const id of cfg.accessories) {
      const a = accById.get(id);
      if (a) usedSlots.set(a.slot, id);
    }
    for (const a of accessories) {
      const c = accChips.get(a.id);
      const on = cfg.accessories.includes(a.id);
      c.input.checked = on;
      let why = '';
      if (!on) {
        if (cfg.accessories.length >= MAX_ACCESSORIES) why = MSG_LIMIT;
        else if (usedSlots.has(a.slot)) why = MSG_SLOT;
      }
      c.input.disabled = !!why;
      c.reason.textContent = why;
      if (why) c.input.setAttribute('aria-describedby', c.reason.id);
      else c.input.removeAttribute('aria-describedby');
      c.label.title = why;
    }
  }

  // ----- start -----

  renderStyleGrid();
  sync();
  bot = await startBot();

  // Query keys for tests: preset, expr, state, weather, gender.
  const query = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  if (query.get('preset')) loadPreset(query.get('preset'));
  const qg = query.get('gender');
  if (qg && ['f', 'm', 'u'].includes(qg)) change({ gender: qg });
  // The last of expr, state, or weather in the URL also selects its tab.
  for (const [k, v] of query.entries()) {
    if (k === 'expr' && expressions.some((x) => x.id === v)) { setExpression(v); selectTab(exprGroup, false); }
    else if (k === 'state' && states.some((x) => x.id === v)) { setState(v); selectTab(stateGroup, false); }
    else if (k === 'weather' && weather.some((x) => x.id === v)) { setWeather(v); selectTab(weatherGroup, false); }
  }

  return {
    bot,
    getConfig: exportConfig,
    loadPreset,
    destroy() {
      callBot('destroy');
      root.textContent = '';
      root.classList.remove('builder');
    },
  };
}
