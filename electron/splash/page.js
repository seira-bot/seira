import { createBot } from "../../brand/mascot/runtime/bot.js";
import { createLine, eyeTarget } from "./line.js";

const root = document.documentElement;
const card = document.querySelector("main");
const botEl = card.querySelector(".bot");
const reduced = root.dataset.reducedMotion === "true" || matchMedia("(prefers-reduced-motion: reduce)").matches;
const line = createLine({ reduced });
let bot = null;

const dropCharacter = () => {
  try { bot?.destroy(); } catch {}
  bot = null;
  card.classList.remove("live");
};

window.startupScreen?.onProgress?.(({ step, finished }) => {
  if (step) line.reach(step);
  if (finished && !line.finished) {
    line.finish();
    try { bot?.setState("success"); bot?.lookAt(0, 0); } catch { dropCharacter(); }
    card.classList.add("finished");
  }
});

const kit = window.__SEIRA_KIT;
if (kit) {
  createBot(botEl, { personality: "cheerful" }, { bases: kit.bases, stickers: kit.stickers, reduced, manual: true })
    .then((made) => {
      bot = made;
      bot.setState("idle");
      bot.express("happy", { ms: 1000 });
      bot.lookAt(0, 0);
      bot.tick(0);
      card.classList.add("live");
    })
    .catch(dropCharacter);
}

let last = 0;
const frame = (now) => {
  const dt = last ? Math.min(100, now - last) : 16;
  last = now;
  const p = line.tick(dt);
  card.style.setProperty("--p", p.toFixed(4));
  if (bot) {
    try {
      if (!line.finished) { const [x, y] = eyeTarget(p); bot.lookAt(x, y); }
      bot.tick(reduced ? 0 : dt);
    } catch { dropCharacter(); }
  }
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
