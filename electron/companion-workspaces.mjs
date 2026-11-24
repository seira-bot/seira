// What a paired phone sees of this computer's workspaces, and what it may ask for. The companion holds the facts and
// answers the phone (companion/src/workspaces.ts); this module sends it the facts and carries out its requests.
import { PHONE_LOCAL_ID } from "./local-profiles.mjs";

export const WORKSPACES_MESSAGE = "seira:companion-workspaces";
export const WORKSPACE_SWITCH_MESSAGE = "seira:companion-workspace-switch";
/** Sent back to the companion when a switch that named an operation ends: `{ type, id, outcome: "done" | "failed" | "superseded" }`. */
export const WORKSPACE_SWITCH_RESULT_MESSAGE = "seira:companion-workspace-switch-result";
const OPERATION_ID = /^[0-9a-f]{32}$/;

/**
 * @param {{
 *   profiles: { phoneFacts(): Array<{ id: string, state: string }> | null, settling(): { id: string | null } | null,
 *     open(id: string): Promise<unknown>, computer(): Promise<unknown>, cancel(): void },
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
  const goTo = (id) => (id === PHONE_LOCAL_ID ? profiles.computer() : profiles.open(id));

  const changed = () => { try { push(); } catch (error) { log(`companion workspaces: ${error?.message ?? error}`); } };

  function push() {
    const next = message(), key = JSON.stringify(next);
    if (key === last) return;
    if (post(next)) last = key;
  }

  /** How the switch ended: `done` once the workspace is open or the cancel is made, `failed` when it did not open, `superseded` when a
   * newer switch took over (`goTo` resolves null then). */
  async function run(action, id) {
    const listed = profiles.phoneFacts()?.find((workspace) => workspace.id === id);
    if (!listed) return "failed";
    if (action === "cancel") { if (profiles.settling()) profiles.cancel(); return "done"; }
    if (action === "hurry" && profiles.settling()?.id !== profileOf(id)) return "failed";
    if (action === "open" && listed.state !== "ready") return "failed";
    await settled();
    const opened = await goTo(id);
    return opened === null ? "superseded" : opened === false ? "failed" : "done";
  }

  const report = (operation, outcome) => { try { if (operation) post({ type: WORKSPACE_SWITCH_RESULT_MESSAGE, id: operation, outcome }); } catch (error) { log(`companion workspaces: could not report a switch (${error?.message ?? error})`); } };

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
        run(action, id)
          .catch((error) => { log(`companion workspaces: ${action} failed (${error?.message ?? error})`); return "failed"; })
          .then((outcome) => { changed(); report(operation, outcome); });
      }
      return true;
    },
  };
}
