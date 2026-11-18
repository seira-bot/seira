// interact.js: pointer input. The head follows the pointer. Click, tickle, press and hold (poke), and pet.
// host gives: canvas, toWorld(clientX, clientY) -> [x, y], now() -> ms, and trigger(kind, data).
//   kind: 'move' (data: [x, y] or null), 'click', 'tickle', 'poke', 'pet'

const TICKLE_MS = 800;      // window for the direction changes
const TICKLE_TURNS = 4;     // direction changes in the window
const HOLD_MS = 600;        // press and hold time for a poke
const STILL = 0.08;         // world units the pointer can move and still count as a click or a hold

export function overHead(x, y) {
  return (x / 1.18) ** 2 + ((y + 0.15) / 1.4) ** 2 < 1;
}
function overHair(x, y) {
  return Math.abs(x) < 1.2 && y > -1.7 && y < 0.15;
}

export function attachInteraction(host) {
  const el = host.canvas;
  let last = null;           // { x, y, t }
  let dir = 0;
  let turns = [];
  let lastTickle = -1e9;
  let down = null;           // { x, y, t, moved, held }
  let holdTimer = 0;
  let pet = { acc: 0, t: 0 };
  let lastPet = -1e9;

  function move(e) {
    const [x, y] = host.toWorld(e.clientX, e.clientY);
    const t = host.now();
    host.trigger('move', [x, y]);
    if (down) down.moved = Math.max(down.moved, Math.hypot(x - down.x, y - down.y));
    if (last) {
      const dx = x - last.x, dy = y - last.y, dt = Math.max(1, t - last.t) / 1000;
      // Tickle: fast back-and-forth motion over the head.
      if (overHead(x, y) && Math.abs(dx) > 0.015) {
        const d = Math.sign(dx);
        if (dir && d !== dir) turns.push(t);
        dir = d;
        turns = turns.filter((v) => t - v <= TICKLE_MS);
        if (turns.length >= TICKLE_TURNS && t - lastTickle > 350) {
          lastTickle = t;
          turns = [];
          host.trigger('tickle', [x, y]);
        }
      }
      // Pet: a slow stroke from the top of the hair down.
      const speed = Math.hypot(dx, dy) / dt;
      if (overHair(x, y) && dy > 0 && dy > Math.abs(dx) * 1.2 && speed > 0.05 && speed < 2.2) {
        if (t - pet.t > 400) pet.acc = 0;
        pet.acc += dy;
        pet.t = t;
        if (pet.acc >= 0.7 && t - lastPet > 1500) {
          lastPet = t;
          pet.acc = 0;
          host.trigger('pet', [x, y]);
        }
      } else if (dy < -0.01 || speed >= 2.2) {
        pet.acc = 0;
      }
    }
    last = { x, y, t };
  }

  function press(e) {
    const [x, y] = host.toWorld(e.clientX, e.clientY);
    if (!overHead(x, y)) return;
    down = { x, y, t: host.now(), moved: 0, held: false };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (down && down.moved < STILL) {
        down.held = true;
        host.trigger('poke', [down.x, down.y]);
      }
    }, HOLD_MS);
  }

  function release() {
    clearTimeout(holdTimer);
    if (down && !down.held && down.moved < STILL && host.now() - down.t < HOLD_MS) {
      host.trigger('click', [down.x, down.y]);
    }
    down = null;
  }

  function leave() {
    clearTimeout(holdTimer);
    down = null;
    last = null;
    host.trigger('move', null);
  }

  el.addEventListener('pointermove', move);
  el.addEventListener('pointerdown', press);
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', leave);
  el.addEventListener('pointerleave', leave);
  return () => {
    clearTimeout(holdTimer);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerdown', press);
    el.removeEventListener('pointerup', release);
    el.removeEventListener('pointercancel', leave);
    el.removeEventListener('pointerleave', leave);
  };
}
