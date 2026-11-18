// weather.js: the weather reaction of the bot. The data is in WEATHER (catalog.js).
// This module keeps the timers for repeated weather actions (for example fan-self when hot)
// and gives the loop effects, the extra accessories, the held prop, and the wind.

import { WEATHER } from './catalog.js';

export class Weather {
  constructor() { this.set(null); }

  set(id) {
    this.id = id && WEATHER[id] ? id : null;
    this.def = this.id ? WEATHER[this.id] : null;
    this.timers = (this.def?.every || []).map(([action, ms], i) => ({ action, ms, left: ms * (0.45 + 0.2 * i) }));
  }

  get face() { return this.def?.face || null; }
  get motion() { return this.def?.motion || null; }
  get hands() { return this.def?.hands || null; }
  get loops() { return this.def?.fx || []; }
  get acc() { return this.def?.acc || []; }
  get prop() { return this.def?.prop || null; }
  get wind() { return this.def?.wind || 0; }

  // Returns an action id when one is due and the bot is free.
  update(dt, busy) {
    let due = null;
    for (const t of this.timers) {
      t.left -= dt * 1000;
      if (t.left <= 0) {
        if (!busy && !due) { due = t.action; t.left = t.ms; } else t.left = 400;
      }
    }
    return due;
  }
}
