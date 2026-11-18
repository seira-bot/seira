import { describe, expect, it } from "vitest";

import { ACTIONS, FACES, STATES } from "../../../brand/mascot/runtime/catalog.js";
import { SEIRA_SCRIPTS, SEIRA_STATES } from "./states";

describe("Seira character states", () => {
  it("offers the states that screens ask for", () => {
    expect([...SEIRA_STATES]).toEqual(["idle", "greet", "thinking", "working", "happy", "sad", "sleep", "attention"]);
    expect(Object.keys(SEIRA_SCRIPTS).sort()).toEqual([...SEIRA_STATES].sort());
  });

  it("maps every state to a runtime state that exists", () => {
    for (const state of SEIRA_STATES) expect(STATES, state).toHaveProperty(SEIRA_SCRIPTS[state].runtime);
  });

  it("maps every state to faces and actions that exist", () => {
    for (const state of SEIRA_STATES) {
      const { expression, action, still } = SEIRA_SCRIPTS[state];
      if (expression) expect(FACES, `${state} face`).toHaveProperty(expression);
      if (action) expect(ACTIONS, `${state} action`).toHaveProperty(action);
      if (still) expect(FACES, `${state} still face`).toHaveProperty(still);
    }
  });

  it("gives a still frame to every state whose motion carries its meaning", () => {
    for (const state of SEIRA_STATES) {
      const { action, expressionMs, still } = SEIRA_SCRIPTS[state];
      if (action || expressionMs) expect(still, state).not.toBeNull();
    }
  });

  it("keeps a timed face short", () => {
    for (const state of SEIRA_STATES) {
      const { expressionMs } = SEIRA_SCRIPTS[state];
      if (expressionMs) expect(expressionMs).toBeLessThanOrEqual(3000);
    }
  });
});
