import { useCallback, useState } from "react";

import type { Workflow, WorkflowInput } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { workflowApi } from "@/state/workflows";

let running = false;

/** One new workflow at a time, however many buttons or chats ask. A second ask while one runs gives `null`. */
export async function createWorkflowOnce(input: WorkflowInput | (() => Promise<WorkflowInput>)): Promise<Workflow | null> {
  if (running) return null;
  running = true;
  try {
    return await workflowApi.create(typeof input === "function" ? await input() : input);
  } finally {
    running = false;
  }
}

export function useCreateWorkflow(onCreated: (workflow: Workflow) => void): { create: () => Promise<void>; failed: boolean } {
  const [failed, setFailed] = useState(false);
  const create = useCallback(async () => {
    setFailed(false);
    try {
      const workflow = await createWorkflowOnce({ name: t("workflow.untitled"), steps: [], connections: [] });
      if (workflow) onCreated(workflow);
    } catch {
      setFailed(true);
    }
  }, [onCreated]);
  return { create, failed };
}
