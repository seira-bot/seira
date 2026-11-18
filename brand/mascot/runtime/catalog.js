// catalog.js: the id catalogs of the runtime (eyes, mouths, expressions, actions, states, weather).
// Data only. Labels are English. The ids match CONTRACT.md.
//
// A face spec (expressions and internal faces) can have these fields:
//   eyes      eye mode for both eyes: 'base' (the config eye shape) or a mode id (see EYE_MODES)
//   eyesL/R   eye mode for one eye (L = screen left, R = screen right)
//   lid       { in, out, low } part of the eye height cut from the top (inner and outer edge) and the bottom
//   scale     eye scale, a number or [left, right]
//   look      [x, y] gaze offset, -1..1 (+y is down)
//   mouth     mouth id (MOUTHS or MOUTH_MODES)
//   brow      brow tilt: +1 angry (inner end down), -1 sad (inner end up)
//   blush, tears, sweat   0..1
//   tint      'sick' | 'cold' | 'hot'
//   marks     'tremble'
//   dots      true: 3 thinking dots in place of the mouth
//   head      { rx, ry, rz } head offset in radians (+rx = chin down, +ry = turn to the viewer's right, +rz = roll)
//   motion    body motion id while the face shows (see MOTIONS in motion.js)
//   fx        one-shot effect id when the face starts; fxLoop: loop effect id while it shows (see fx.js)

export const EYES = {
  pill: { label: 'Pill' },
  round: { label: 'Round' },
  sharp: { label: 'Sharp' },
  almond: { label: 'Almond' },
  sleepy: { label: 'Sleepy' },
  dot: { label: 'Dot' },
  star: { label: 'Star' },
  square: { label: 'Square' },
};

// Eye modes that expressions use in place of the config eye shape.
export const EYE_MODES = ['arc-up', 'arc-down', 'chevron', 'heart', 'spiral', 'round-big', 'small', 'wavy', 'line', 'dots'];

export const MOUTHS = {
  smile: { label: 'Smile' },
  cat: { label: 'Cat' },
  flat: { label: 'Flat' },
  grin: { label: 'Grin' },
  fang: { label: 'Fang' },
  'small-o': { label: 'Small O' },
  smirk: { label: 'Smirk' },
};

// Mouth shapes that expressions use in place of the config mouth.
export const MOUTH_MODES = ['open', 'open-big', 'open-small', 'frown', 'wavy', 'wavy-small', 'wavy-open', 'wail',
  'zigzag', 'pant', 'pout', 'tiny-o', 'flat-side', 'firm', 'wobbly', 'yawn', 'big-o'];

export const EXPRESSIONS = {
  calm: { label: 'Calm' },
  happy: { label: 'Happy', eyes: 'arc-up', mouth: 'open', head: { rz: 0.05 } },
  laugh: { label: 'Laugh', eyes: 'chevron', mouth: 'open-big', head: { rx: -0.14 }, motion: 'bounce' },
  giggle: { label: 'Giggle', eyes: 'arc-up', mouth: 'open-small', blush: 0.5, head: { rz: 0.1 }, motion: 'wiggle' },
  love: { label: 'Love', eyes: 'heart', mouth: 'smile', blush: 0.6, head: { rz: -0.06 }, motion: 'sway', fx: 'heart' },
  shy: { label: 'Shy', look: [0.6, 0.65], scale: 0.9, mouth: 'wavy-small', blush: 1, head: { rx: 0.12, ry: 0.14, rz: -0.1 } },
  proud: { label: 'Proud', eyes: 'arc-up', mouth: 'smile', head: { rx: -0.16, rz: 0.04 } },
  surprised: { label: 'Surprised', eyes: 'round-big', mouth: 'small-o', head: { rx: -0.06 }, fx: 'exclaim' },
  confused: { label: 'Confused', scale: [0.68, 1.05], look: [0.2, -0.2], mouth: 'wavy', brow: -0.5, head: { rz: 0.17 }, fx: 'question' },
  thinking: { label: 'Thinking', look: [0.75, -0.85], mouth: 'flat-side', head: { rx: -0.06, rz: 0.09 } },
  sad: { label: 'Sad', lid: { in: 0, out: 0.34 }, look: [0, 0.35], brow: -1, mouth: 'frown', head: { rx: 0.14 }, motion: 'droop' },
  cry: { label: 'Cry', eyes: 'arc-down', tears: 1, brow: -1, mouth: 'wail', head: { rx: 0.06 }, motion: 'tremble', fxLoop: 'tear' },
  pout: { label: 'Pout', lid: { in: 0.3, out: 0.3 }, look: [-0.6, 0], mouth: 'pout', blush: 0.4, head: { ry: -0.2, rz: -0.06 } },
  angry: { label: 'Angry', lid: { in: 0.44, out: 0.06 }, brow: 1, mouth: 'frown', head: { rx: 0.08 }, motion: 'tremble', fx: 'anger-mark' },
  sleepy: { label: 'Sleepy', lid: { in: 0.56, out: 0.56 }, look: [0, 0.3], mouth: 'tiny-o', head: { rx: 0.08, rz: 0.12 }, motion: 'sway' },
  asleep: { label: 'Asleep', eyes: 'arc-down', mouth: 'tiny-o', head: { rx: 0.16, rz: 0.1 }, motion: 'breathe', fxLoop: 'zzz' },
  wink: { label: 'Wink', eyesR: 'arc-up', mouth: 'smile', head: { rz: -0.07 } },
  bored: { label: 'Bored', lid: { in: 0.5, out: 0.5 }, look: [0.55, 0.1], mouth: 'flat', head: { rz: -0.1, rx: 0.04 } },
  determined: { label: 'Determined', lid: { in: 0.3, out: 0.12 }, brow: 0.7, mouth: 'firm', head: { rx: 0.07 } },
  dizzy: { label: 'Dizzy', eyes: 'spiral', mouth: 'wavy', motion: 'circle', fxLoop: 'dizzy-star' },
  smug: { label: 'Smug', lid: { in: 0.44, out: 0.44 }, look: [0.35, 0], mouth: 'smirk', head: { rx: -0.09, rz: 0.09 } },
  scared: { label: 'Scared', eyes: 'small', mouth: 'wavy-open', marks: 'tremble', head: { rx: 0.08 }, motion: 'tremble', fx: 'sweat-drop' },
  cold: { label: 'Cold', eyes: 'chevron', mouth: 'zigzag', tint: 'cold', motion: 'shiver' },
  hot: { label: 'Hot', lid: { in: 0.16, out: 0.48 }, brow: -0.4, mouth: 'pant', blush: 0.8, sweat: 1, tint: 'hot', head: { rx: 0.08 }, motion: 'pant' },
  sick: { label: 'Sick', eyes: 'wavy', mouth: 'wobbly', tint: 'sick', head: { rx: 0.06, rz: 0.08 }, motion: 'sway' },
};

// Faces that actions, states, weather, and interaction use. Not part of the public catalog.
export const FACES = {
  ...EXPRESSIONS,
  pet: { lid: { in: 0.48, out: 0.48, low: 0.22 }, mouth: 'cat', blush: 0.6, head: { rx: 0.12, rz: 0.1 } },
  click: { eyes: 'arc-up', mouth: 'open' },
  poke: { look: [0.6, 0.6], scale: 0.9, mouth: 'wavy-small', blush: 1, head: { rx: 0.12, rz: -0.12 } },
  'sneeze-ah': { lid: { in: 0.42, out: 0.42, low: 0.12 }, brow: -0.6, mouth: 'small-o' },
  'sneeze-ahh': { eyes: 'chevron', brow: -0.8, mouth: 'big-o' },
  'sneeze-choo': { eyes: 'chevron', mouth: 'tiny-o' },
  'sneeze-after': { eyes: 'dots', mouth: 'smile', blush: 0.5 },
  yawn: { eyes: 'arc-down', mouth: 'yawn', tears: 0.25 },
  oops: { eyes: 'chevron', mouth: 'wavy', blush: 0.4, sweat: 1 },
  phew: { eyes: 'arc-up', mouth: 'smile', sweat: 0.6 },
  stars: { eyes: 'star', mouth: 'open' },
  dance: { eyes: 'arc-up', mouth: 'open' },
  cheer: { eyes: 'chevron', mouth: 'open-big' },
  bow: { eyes: 'arc-up', mouth: 'smile' },
  talk: { mouth: 'smile' },
  idea: { eyes: 'round-big', mouth: 'open' },
  hiccup: { eyes: 'round-big', mouth: 'small-o' },
  nope: { eyes: 'arc-down', mouth: 'flat' },
  palm: { lid: { in: 0.5, out: 0.5 }, mouth: 'flat' },
  peek: { look: [0.5, 0.2], mouth: 'wavy-small', blush: 0.7 },
  stretch: { eyes: 'arc-down', mouth: 'big-o' },
  listening: { scale: 1.06, look: [0, -0.1], mouth: 'smile', head: { rx: -0.04, rz: 0.12 } },
  'think-state': { look: [0.75, -0.85], dots: true, head: { rx: -0.06, rz: 0.09 } },
  working: { lid: { in: 0.22, out: 0.08 }, brow: 0.4, look: [0, 0.35], mouth: 'firm', head: { rx: 0.08 } },
  error: { scale: [0.8, 1], mouth: 'wavy', brow: -0.6, sweat: 1, head: { rz: 0.12 } },
  sunny: { lid: { in: 0.36, out: 0.3, low: 0.12 }, mouth: 'smile', head: { rx: -0.08 } },
  rain: { eyes: 'round-big', look: [0, -1], mouth: 'small-o', head: { rx: -0.24 } },
  snow: { eyes: 'arc-up', look: [0, -1], mouth: 'open-small', blush: 0.4, head: { rx: -0.2 } },
  wind: { lid: { in: 0.44, out: 0.38, low: 0.1 }, mouth: 'wavy', head: { ry: 0.22, rz: 0.06 } },
  fog: { lid: { in: 0.4, out: 0.4 }, scale: 0.92, mouth: 'flat-side', brow: -0.4 },
};

// Timed actions. ms is the length; hands: true when the action moves the hands.
export const ACTIONS = {
  wave: { label: 'Wave', ms: 1800, hands: true },
  nod: { label: 'Nod', ms: 1000 },
  'shake-head': { label: 'Shake head', ms: 1100 },
  bow: { label: 'Bow', ms: 1700, hands: true },
  hop: { label: 'Hop', ms: 850 },
  spin: { label: 'Spin', ms: 1300, hands: true },
  'dance-1': { label: 'Dance 1 (head bop)', ms: 2600, hands: true },
  'dance-2': { label: 'Dance 2 (hand roll)', ms: 2600, hands: true },
  'dance-3': { label: 'Dance 3 (disco)', ms: 2600, hands: true },
  laugh: { label: 'Laugh', ms: 2000, hands: true },
  giggle: { label: 'Giggle', ms: 1400, hands: true },
  sneeze: { label: 'Sneeze', ms: 2600, hands: true },
  hiccup: { label: 'Hiccup', ms: 1200 },
  yawn: { label: 'Yawn', ms: 2400, hands: true },
  stretch: { label: 'Stretch', ms: 2400, hands: true },
  think: { label: 'Think', ms: 2600, hands: true },
  idea: { label: 'Idea', ms: 1600, hands: true },
  celebrate: { label: 'Celebrate', ms: 2400, hands: true },
  oops: { label: 'Oops', ms: 1600, hands: true },
  greet: { label: 'Greet', ms: 2000, hands: true },
  bye: { label: 'Bye', ms: 2000, hands: true },
  shiver: { label: 'Shiver', ms: 2000, hands: true },
  'fan-self': { label: 'Fan self', ms: 2000, hands: true },
  'wipe-sweat': { label: 'Wipe sweat', ms: 1900, hands: true },
  peek: { label: 'Peek', ms: 2600, hands: true },
  clap: { label: 'Clap', ms: 1600, hands: true },
  facepalm: { label: 'Facepalm', ms: 1900, hands: true },
};

// Assistant states. face: face id; hands: base hand pose; motion: body motion; fx: loop effect.
export const STATES = {
  idle: { label: 'Idle' },
  listening: { label: 'Listening', face: 'listening', lean: 0.1 },
  thinking: { label: 'Thinking', face: 'think-state', hands: 'chin', motion: 'ponder' },
  talking: { label: 'Talking', talk: true, motion: 'talk' },
  working: { label: 'Working', face: 'working', hands: 'type', motion: 'busy', scan: true },
  success: { label: 'Success', face: 'happy', enter: 'hop' },
  error: { label: 'Error', face: 'error', enter: 'shake-head', fx: 'sweat-drop' },
  sleeping: { label: 'Sleeping', face: 'asleep', motion: 'sleep' },
};

// Weather reactions. face, motion, hands as in STATES; fx: loop effects; acc: auto accessories;
// every: idle actions [id, period ms]; wind: wind strength 0..1; prop: a held fx sprite.
export const WEATHER = {
  sunny: { label: 'Sunny', face: 'sunny', fx: ['sun-glint'], acc: ['sunglasses'], motion: 'bask' },
  hot: { label: 'Hot', face: 'hot', motion: 'heat', fx: ['hot-sweat', 'hot-shimmer'], every: [['fan-self', 6500], ['wipe-sweat', 9700]] },
  cold: { label: 'Cold', face: 'cold', motion: 'shiver', hands: 'hug', fx: ['cold-frost', 'cold-breath'], acc: ['scarf'] },
  rain: { label: 'Rain', face: 'rain', motion: 'look-up', hands: 'umbrella', fx: ['rain'], prop: 'umbrella' },
  storm: { label: 'Storm', face: 'scared', motion: 'flinch', hands: 'hug', fx: ['rain', 'lightning', 'wind-lines'], wind: 0.5 },
  snow: { label: 'Snow', face: 'snow', motion: 'shiver-soft', hands: 'catch', fx: ['snow', 'cold-breath'], acc: ['scarf'] },
  wind: { label: 'Wind', face: 'wind', motion: 'lean', fx: ['wind-lines'], wind: 0.9 },
  fog: { label: 'Fog', face: 'fog', motion: 'search', fx: ['fog'] },
};

export const PERSONALITY = {
  calm: { blink: [2600, 5200], glance: 0.15, sway: 1, speed: 1, float: 1, tilt: 0, lid: 0 },
  cheerful: { blink: [2000, 4000], glance: 0.3, sway: 1.35, speed: 1.35, float: 1.3, tilt: 0.04, lid: 0 },
  cool: { blink: [3600, 7000], glance: 0.1, sway: 0.6, speed: 0.8, float: 0.7, tilt: 0, lid: 0.18 },
  playful: { blink: [1800, 3600], glance: 0.5, sway: 1.5, speed: 1.45, float: 1.4, tilt: 0.08, lid: 0 },
  shy: { blink: [1600, 3200], glance: 0.4, sway: 0.7, speed: 0.9, float: 0.8, tilt: -0.05, lid: 0, avoid: true },
  proud: { blink: [3000, 6000], glance: 0.15, sway: 0.8, speed: 0.85, float: 1, tilt: 0, lid: 0.06, chin: -0.08 },
};

// Character config (CONTRACT.md, "Character config schema").
export const DEFAULT_CONFIG = {
  id: 'seira',
  name: 'Seira',
  gender: 'f',
  style: 'seira',
  hairColor: null,
  shell: '#ECEEF1',
  screen: '#0C0F14',
  eyes: 'pill',
  eyeColor: '#FF2A57',
  lashes: true,
  brows: 'none',
  mouth: 'smile',
  blush: false,
  accessories: [],
  hands: true,
  personality: 'calm',
};

// Hair color for a recolor style when the config gives none.
export const DEFAULT_HAIR = '#3B3F4A';
export const DEFAULT_SHELL = '#ECEEF1';
