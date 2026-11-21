import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import type { Workflow } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { useStore } from "@/state/store";
import { keepDraft, loadWorkflows, takeDraft, useWorkflows, workflowApi, type WorkflowDraft } from "@/state/workflows";
import { UndoToast } from "../bot-access/ShareBotButton";
import { WorkflowEditor } from "./WorkflowEditor";
import { WorkflowList } from "./WorkflowList";
import { WorkflowRunView } from "./WorkflowRunView";
import { fromWorkflow } from "./useWorkflowDraft";
import { useCreateWorkflow } from "./useCreateWorkflow";
import { useDelayed } from "./useDelayed";

export function WorkflowsView({ workflowId, workflowRunId, onUseInRoutine }: { workflowId?: string; workflowRunId?: string; onUseInRoutine?: (workflow: Workflow) => void }) {
  const { state, dispatch } = useStore();
  const workflows = useWorkflows();
  const [vanished, setVanished] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ workflow: Workflow; draft: WorkflowDraft; key: number } | null>(null);
  const leaving = useRef<string | null>(null);
  const deletedKey = useRef(0);
  const botName = useCallback((botId: string) => state.bots.find((bot) => bot.id === botId)?.name, [state.bots]);
  const workflow = workflowId ? workflows.workflows.find((candidate) => candidate.id === workflowId) : undefined;
  const loading = !workflows.loaded;
  const showSpinner = useDelayed(loading);

  const editorId = workflow && !workflowRunId ? workflow.id : null;
  const latest = useRef({ workflows: workflows.workflows, routines: state.routines });
  latest.current = { workflows: workflows.workflows, routines: state.routines };
  useEffect(() => {
    if (!editorId) return;
    return () => {
      if (leaving.current === editorId) return;
      const current = latest.current.workflows.find((candidate) => candidate.id === editorId);
      if (!current || current.steps.length > 0 || current.name !== t("workflow.untitled")) return;
      if (latest.current.routines.some((routine) => routine.workflowId === editorId)) return;
      const kept = takeDraft(editorId);
      if (kept && (kept.draft.steps.length > 0 || kept.draft.name !== t("workflow.untitled"))) {
        keepDraft(editorId, kept.draft, kept.base);
        return;
      }
      void workflowApi.remove(editorId).catch(() => {});
    };
  }, [editorId]);

  const open = useCallback((id?: string) => dispatch({ type: "showRoutines", view: "workflows", workflowId: id }), [dispatch]);
  const { create, failed: createFailed } = useCreateWorkflow(useCallback((made: Workflow) => {
    setVanished(false);
    open(made.id);
  }, [open]));
  const onGone = useCallback(() => {
    setVanished(true);
    open();
  }, [open]);
  const onDelete = useCallback(async (removed: Workflow, draft: WorkflowDraft) => {
    leaving.current = removed.id;
    try {
      await workflowApi.remove(removed.id);
    } catch (error) {
      leaving.current = null;
      throw error;
    }
    open();
    setDeleted({ workflow: removed, draft, key: ++deletedKey.current });
  }, [open]);
  const deletedDone = useCallback(() => setDeleted(null), []);
  const undoDelete = useCallback(async () => {
    if (!deleted) return;
    const { workflow: saved, draft } = deleted;
    const made = await workflowApi.create({ name: saved.name, steps: saved.steps, connections: saved.connections });
    if (JSON.stringify(draft) === JSON.stringify(fromWorkflow(saved))) return;
    keepDraft(made.id, draft, made.updatedAt);
    open(made.id);
  }, [deleted, open]);

  let body;
  if (workflowId && workflowRunId) {
    body = <WorkflowRunView key={workflowRunId} workflowId={workflowId} runId={workflowRunId} focusHeading={focusRunId === workflowRunId}
      onAgainStarted={(newRunId, text) => { setFocusRunId(newRunId); setAnnouncement(text); }} />;
  } else if (workflow) {
    body = (
      <WorkflowEditor key={workflow.id} workflow={workflow} usedBy={state.routines.filter((routine) => routine.workflowId === workflow.id)}
        onBack={() => { setVanished(false); open(); }} onGone={onGone} onDelete={onDelete} onUseInRoutine={onUseInRoutine} />
    );
  } else if (loading) {
    body = <div className="flex flex-1 items-center justify-center">{showSpinner && <Loader2 size={20} aria-hidden className="animate-spin text-ink-tertiary motion-reduce:animate-none" />}</div>;
  } else if (workflows.failed && workflows.workflows.length === 0) {
    body = (
      <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-[13px] text-ink-secondary">{t("workflow.loadFailed")}</p>
        <button type="button" onClick={() => void loadWorkflows()} className="ui-button ui-button-primary">{t("common.tryAgain")}</button>
      </div>
    );
  } else {
    const gone = vanished || (Boolean(workflowId) && leaving.current !== workflowId);
    body = <WorkflowList workflows={workflows.workflows} routines={state.routines} botName={botName} gone={gone} onOpen={(id) => { setVanished(false); open(id); }} onNew={() => void create()} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {createFailed && <p role="alert" className="shrink-0 px-4 pt-3 text-[13px] text-danger">{t("workflow.save.failed")}</p>}
      {body}
      <p role="status" className="sr-only">{announcement}</p>
      {deleted && <UndoToast key={deleted.key} text={t("workflow.deleted", { name: deleted.workflow.name })} onUndo={undoDelete} onDone={deletedDone} />}
    </div>
  );
}
