import { Workflow as WorkflowIcon } from "lucide-react";
import type { Dispatch } from "react";

import { WORKFLOW_LIMITS } from "../../../shared/workflows";
import { ACTION_ICON, type MessageMenuItem } from "@/components/MessageActions";
import { createWorkflowOnce } from "@/components/workflow/useCreateWorkflow";
import { t } from "@/lib/i18n";
import { ui } from "@/lib/ui-anchor";
import { ApiError, type Action, type Message } from "@/state/store";
import { loadWorkflows, workflowApi } from "@/state/workflows";

/** The server sends `turnSucceeded`; the renderer's `Message` does not name it. */
export const finishedReply = (message: Message & { turnSucceeded?: boolean }): boolean =>
  message.role === "bot" && message.kind === "text" && message.turnTerminal === true && message.turnSucceeded !== false
  && !message.id.startsWith("optimistic-") && Boolean(message.text?.trim())
  && (message.requestMessageId !== undefined || message.from?.botId !== undefined);

const workflowsOff = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.body?.error !== "asleep";

function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (workflowsOff(error)) return t("workflow.draw.unavailable");
    if (error.status === 404) return t("workflow.draw.gone");
    if (error.status === 403) return t("workflow.draw.notAllowed");
    if (error.status === 409 && error.body?.code === "workflow_draw_no_request") return t("workflow.draw.noRequest");
  }
  return t("workflow.draw.failed");
}

export async function drawWorkflow(target: { threadId: string; messageId: string }, dispatch: Dispatch<Action>): Promise<void> {
  const note = (text: string) => dispatch({ type: "notice", notice: { kind: "note", botName: null, text } });
  try {
    let left = 0, cut = 0;
    const workflow = await createWorkflowOnce(async () => {
      const drawn = await workflowApi.draft(target.threadId, target.messageId);
      left = drawn.omitted;
      cut = drawn.trimmed;
      return { ...drawn.draft, name: drawn.draft.name || t("workflow.untitled") };
    });
    if (!workflow) return;
    dispatch({ type: "showRoutines", view: "workflows", workflowId: workflow.id });
    const said = [
      left > 0 ? t(left === 1 ? "workflow.draw.omitted.one" : "workflow.draw.omitted.other", { count: left }) : "",
      cut > 0 ? t("workflow.draw.tooMany", { count: WORKFLOW_LIMITS.steps }) : "",
    ].filter(Boolean);
    if (said.length) note(said.join(" "));
  } catch (error) {
    note(failure(error));
    if (workflowsOff(error)) void loadWorkflows({ background: true });
  }
}

export function drawWorkflowItem(draw: { threadId: string; reply: Message; dispatch: Dispatch<Action> }): MessageMenuItem {
  return {
    key: "draw-workflow",
    ui: ui("message.draw-workflow"),
    icon: <WorkflowIcon {...ACTION_ICON} />,
    label: t("workflow.draw.action"),
    idleOnly: true,
    onSelect: () => { void drawWorkflow({ threadId: draw.threadId, messageId: draw.reply.id }, draw.dispatch); },
  };
}
