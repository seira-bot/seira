/** The most items a task list reports; a longer list reports this many. */
export const TURN_PLAN_MAX = 50;

/** How far the running turn is through its own task list, for a client's "step 3 of 5". Counts only: never the text of
 * an item. Live only: the bus sends it when `done` or `total` changes, and it is never written to the event log or the
 * message log. `total` is 1 to 50, `done` is 0 to `total`; an empty list sends nothing. */
export interface TurnPlanFields {
  type: "turn.plan";
  done: number;
  total: number;
}
