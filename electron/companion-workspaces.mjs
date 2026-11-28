// What a paired phone sees of this computer's workspaces, and what it may ask for. The companion holds the facts and
// answers the phone (companion/src/workspaces.ts); this module sends it the facts and carries out its requests.
import { PHONE_LOCAL_ID } from "./local-profiles.mjs";

export const WORKSPACES_MESSAGE = "seira:companion-workspaces";
export const WORKSPACE_SWITCH_MESSAGE = "seira:companion-workspace-switch";
/** Sent back to the companion when a switch that named an operation ends: `{ type, id, outcome: "done" | "failed" | "superseded" | "cancelled" }`.
 * `id` is the exact operation that ended, and the companion changes that operation only. */
export const WORKSPACE_SWITCH_RESULT_MESSAGE = "seira:companion-workspace-switch-result";
const OPERATION_ID = /^[0-9a-f]{32}$/;

/**
 * @param {{
 *   profiles: { phoneFacts(): Array<{ id: string, state: string }> | null, settling(): { id: string | null, turn?: number } | null,
 *     open(id: string, cause?: object, hurryTurn?: number): Promise<unknown>, computer(cause?: object, hurryTurn?: number): Promise<unknown>, cancel(cause?: object): void,
 *     takenBy?(cause: object): object | null | undefined },
 *   post(message: unknown): boolean,
 *   settled?(): Promise<unknown>,
 *   log?(line: string): void,
 * }} deps `post`: sends one message to the running companion, false when none runs. `settled`: the wait the rail does
 * before it opens a workspace.
 */
export function createCompanionWorkspaces({ profiles, post, settled = async () => {}, log = () => {} }) {
  let last = null;
  const message = () => ({ type: WORKSPACES_MESSAGE, workspaces: profiles.phoneFacts() });
  const profileOf = (id) => (id === PHONE_LOCAL_ID ? null : id);
  const goTo = (id, cause, hurryTurn) => (id === PHONE_LOCAL_ID ? profiles.computer(cause, hurryTurn) : profiles.open(id, cause, hurryTurn));

  const changed = () => { try { push(); } catch (error) { log(`companion workspaces: ${error?.message ?? error}`); } };

  function push() {
    const next = message(), key = JSON.stringify(next);
    if (key === last) return;
    if (post(next)) last = key;
  }

  /** How the switch ended: `done` once the workspace is open or the cancel is made, `failed` when it did not open, `superseded` when a
   * newer switch took over (`goTo` resolves null then). `record` is this request's own entry (see `ending`). */
  async function run(action, id, record) {
    const listed = profiles.phoneFacts()?.find((workspace) => workspace.id === id);
    if (!listed) return "failed";
    if (action === "cancel") { if (profiles.settling()) profiles.cancel(record); return "done"; }
    // A hurry carries on the switch that waits now, and names it by its turn. The profiles module checks that turn against the
    // active one when it applies the hurry, after the wait below; a switch that replaced it in the meantime refuses the hurry.
    const waiting = action === "hurry" ? profiles.settling() : null;
    if (action === "hurry" && waiting?.id !== profileOf(id)) return "failed";
    if (action === "open" && listed.state !== "ready") return "failed";
    await settled();
    const opened = await goTo(id, record, waiting ? waiting.turn : undefined);
    return opened === null ? "superseded" : opened === false ? "failed" : "done";
  }

  const report = (operation, outcome) => { try { if (operation) post({ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id: operation, outcome }); } catch (error) { log(`companion workspaces: could not report a switch (${error?.message ?? error})`); } };

  // Which request took a switch's turn is not worked out here. The profiles module notes it at the moment the turn changes
  // (profiles.takenBy): a phone request passes its own record as the cause, the rail passes none, and a switch ends as
  // taken over by exactly the one that took it. So a request that comes later never takes the credit.

  /** Tells the end of `record`, and of each switch that a hurry request carried on, with the same outcome. */
  function end(record, outcome) {
    if (record.ended) return;
    record.ended = outcome;
    report(record.operation, outcome);
    const carried = record.carries;
    record.carries = [];
    for (const other of carried) end(other, outcome);
  }

  /** A switch that a newer one took over ends as `cancelled` when a cancel request took it, and as `superseded` when another
   * switch or the rail did (`profiles.takenBy`). A request for the same workspace carries it on: this switch ends as that request ends, which may be
   * later. */
  function ending(record, outcome) {
    if (outcome !== "superseded") return end(record, outcome);
    const by = profiles.takenBy?.(record);
    if (by?.action === "cancel") return end(record, "cancelled");
    if (by && by.id === record.id) {
      if (by.ended) return end(record, by.ended);
      by.carries.push(record);
      return undefined;
    }
    return end(record, "superseded");
  }

  return {
    /** The facts to send first to a companion that starts now. */
    initial() { const next = message(); last = JSON.stringify(next); return next; },
    /** The rail changed, or a switch started or ended: send the facts again when they differ from the last sent. */
    changed,
    /** True for a message of this module. A switch that fails leaves the rail as it is and is logged. */
    receive(received) {
      if (received?.type !== WORKSPACE_SWITCH_MESSAGE) return false;
      const { action, id } = received;
      const operation = typeof received.operation === "string" && OPERATION_ID.test(received.operation) ? received.operation : null;
      if (["open", "hurry", "cancel"].includes(action) && typeof id === "string") {
        const record = { operation, action, id, ended: null, carries: [] };
        run(action, id, record)
          .catch((error) => { log(`companion workspaces: ${action} failed (${error?.message ?? error})`); return "failed"; })
          .then((outcome) => { changed(); ending(record, outcome); });
      }
      return true;
    },
  };
}
