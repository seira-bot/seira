// The agents tools' internal calls that need only the capability's bot and conversation, its body and its folders: research,
// the helper models' decide and extract, Seira's notifications, the usage limits and publishing an app. Runs inside index.ts's /api/internal/ block, after the
// capability bearer is checked; each route answers its own paths and passes the rest on.
import type { AppPublisher } from "../host/app-publisher.ts";
import { createAppHostingInternalRoutes } from "./app-hosting.ts";
import { createEngineLimitsRoutes, type EngineLimitsDeps } from "./engine-limits.ts";
import { createMachineBudgetRoutes } from "./machine-budget.ts";
import type { BudgetSource } from "../machine-room.ts";
import { createHelperToolRoutes, type HelperToolContext, type HelperToolDeps } from "./helper-tools.ts";
import { createSeiraNotificationRoutes, type LiveNotificationsDeps } from "./seira-notifications.ts";
import { PASS } from "./table.ts";
import { createXResearchInternalRoutes, type XResearchDeps } from "./x-research.ts";

export function createInternalToolRoutes(deps: { helpers: HelperToolDeps; xResearch: XResearchDeps; notifications: LiveNotificationsDeps; engineLimits: EngineLimitsDeps; appPublisher: AppPublisher; machineBudget?: BudgetSource }) {
  const routes = [createXResearchInternalRoutes(deps.xResearch), createHelperToolRoutes(deps.helpers), createSeiraNotificationRoutes(deps.notifications), createEngineLimitsRoutes(deps.engineLimits), createMachineBudgetRoutes(deps.machineBudget), createAppHostingInternalRoutes(deps.appPublisher)];
  return async (ctx: HelperToolContext & { threadId: string }): Promise<typeof PASS | void> => {
    for (const route of routes) if (await route(ctx) !== PASS) return;
    return PASS;
  };
}
