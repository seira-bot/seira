import { useCallback, useState } from "react";

import type { Workflow } from "../../../shared/workflows";
import { t } from "@/lib/i18n";
import { workflowApi } from "@/state/workflows";

let running = false;

/** One new workflow at a time, however many buttons ask. */
export function useCreateWorkflow(onCreated: (workflow: Workflow) => void): { create: () => Promise<void>; failed: boolean } {
  const [failed, setFailed] = useState(false);
  const create = useCallback(async () => {
    if (running) return;
    running = true;
    setFailed(false);
    try {
      onCreated(await workflowApi.create({ name: t("workflow.untitled"), steps: [], connections: [] }));
    } catch {
      setFailed(true);
    } finally {
      running = false;
    }
  }, [onCreated]);
  return { create, failed };
}
