export const SEIRA_STATES = [
  "idle",
  "greet",
  "thinking",
  "working",
  "happy",
  "sad",
  "sleep",
  "attention",
] as const;

export type SeiraState = (typeof SEIRA_STATES)[number];

type RuntimeState = "idle" | "listening" | "thinking" | "working" | "success" | "sleeping";

export interface SeiraScript {
  /** Assistant state of the character runtime. */
  runtime: RuntimeState;
  /** Face that holds while the state shows. `null` keeps the face of the runtime state. */
  expression: string | null;
  /** The face falls back to the runtime state after this time. */
  expressionMs?: number;
  /** Action that plays once when the state starts. */
  action: string | null;
  /** Face of the still frame, used in place of the action and the timed face. */
  still: string | null;
}

export const SEIRA_SCRIPTS: Record<SeiraState, SeiraScript> = {
  idle: { runtime: "idle", expression: null, action: null, still: null },
  greet: { runtime: "idle", expression: null, action: "greet", still: "happy" },
  thinking: { runtime: "thinking", expression: null, action: null, still: null },
  working: { runtime: "working", expression: null, action: null, still: null },
  happy: { runtime: "success", expression: null, action: null, still: null },
  sad: { runtime: "idle", expression: "sad", action: null, still: null },
  sleep: { runtime: "sleeping", expression: null, action: null, still: null },
  attention: { runtime: "listening", expression: "surprised", expressionMs: 1400, action: null, still: "surprised" },
};
