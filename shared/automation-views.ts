/** The views of the Automations page, in the order its switch shows them. */
export const AUTOMATION_VIEWS = ["list", "calendar", "workflows"] as const;
export type AutomationView = (typeof AUTOMATION_VIEWS)[number];
