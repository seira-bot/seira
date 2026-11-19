import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ advanced: false }));
vi.mock("@/lib/interface-mode", () => ({ useAdvancedMode: () => mode.advanced }));

const { ToolActivity } = await import("./ToolActivity");
const { ActivityRun } = await import("./ActivityRun");

const render = (tool: Parameters<typeof ToolActivity>[0]["tool"]) => renderToStaticMarkup(createElement(ToolActivity, { tool }));

afterEach(() => {
  mode.advanced = false;
});

describe("ToolActivity in Simple mode", () => {
  it("names the step in plain words and keeps the tool's own name in the details", () => {
    const html = render({ name: "mcp__omb__computer_batch", ok: true, input: '{"actions":[]}' });
    expect(html).toContain("Use the screen · Completed · Tool details");
    expect(html).toMatch(/<span class="min-w-0 max-w-\[30rem\] truncate leading-5 font-medium">Use the screen<\/span>/);
    expect(html).toContain('data-testid="tool-name"');
    expect(html).toContain("mcp__omb__computer_batch");
  });

  it("shows the line the harness wrote for an MCP server change, in both modes, with the tool's name in the details", () => {
    const tool = { name: "mcp__agents__mcp_server", label: "Added MCP server linear · Turned on · Test: needs sign-in", ok: true };
    for (const advanced of [false, true]) {
      mode.advanced = advanced;
      const html = render(tool);
      expect(html, `advanced ${advanced}`).toContain("Added MCP server linear · Turned on · Test: needs sign-in · Completed · Tool details");
      expect(html, `advanced ${advanced}`).toMatch(/data-testid="tool-name">mcp__agents__mcp_server</);
    }
  });

  it("says which MCP server failed and why on the row itself, whole, in both modes, with the tool's name in the details", () => {
    const problem = "mail needs you to sign in before its tools work. Open Apps → MCP servers and sign in to it.";
    for (const advanced of [false, true]) {
      mode.advanced = advanced;
      const html = render({ name: "mcp__mail__search_threads", ok: false, problem, output: "Error dialing http://127.0.0.1:18080/b/REDACTED/mcp-mail" });
      expect(html, `advanced ${advanced}`).toContain(`<span class="min-w-0 max-w-[30rem] leading-5 font-medium">${problem}</span>`);
      expect(html, `advanced ${advanced}`).toMatch(/data-testid="tool-name">mcp__mail__search_threads</);
    }
  });

  it("keeps the problem line off a step that did not fail", () => {
    expect(render({ name: "mcp__mail__search_threads", ok: true, problem: "mail needs you to sign in." })).not.toContain("mail needs you to sign in.");
  });

  it("keeps a command off the row, where it reads as a plain step", () => {
    const html = render({ name: "Bash", ok: false, summary: "pnpm test --filter api", input: "pnpm test --filter api" });
    expect(html).toContain("Run a command · Failed · Tool details");
    expect(html).not.toContain('title="pnpm test --filter api"');
  });

  it("names a Composio slug by its action", () => {
    expect(render({ name: "GITHUB_GET_A_COMMIT", ok: true })).toContain("Get a commit · Completed");
  });
});

describe("ToolActivity in Advanced mode", () => {
  it("shows the tool name and command on the row, as before", () => {
    mode.advanced = true;
    const html = render({ name: "Bash", ok: true, summary: "pnpm test", input: "pnpm test" });
    expect(html).toContain("Bash · Completed · Tool details");
    expect(html).toMatch(/truncate leading-5 font-mono">Bash<\/span>/);
    expect(html).toContain('title="pnpm test"');
    expect(html).not.toContain('data-testid="tool-name"');
  });
});

describe("ActivityRun", () => {
  const steps = [
    { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Bash", ok: true, summary: "ls" } },
    { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "ls -la /tmp", ok: true, summary: "ls -la /tmp" } },
    { id: "c", at: 3, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__omb__screenshot", ok: true } },
  ];

  it("sums a folded run up in plain words in Simple mode", () => {
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toContain("3 steps · Run a command ×2, Look at the screen");
  });

  it("heads Advanced mode's card with the time worked and the step count", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, label: "Worked for 29s", children: null }));
    expect(html).toContain("Worked for 29s");
    expect(html).toContain("3 steps");
    expect(html).not.toContain("Run a command");
  });

  it("says Working while the turn runs and Failed when a step failed", () => {
    mode.advanced = true;
    const working = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, status: "working", children: null }));
    expect(working).toContain("Working…");
    expect(working).toContain('data-run-status="working"');
    const failed = renderToStaticMarkup(createElement(ActivityRun, { messages: [{ ...steps[0]!, tool: { name: "Bash", ok: false } }], children: null }));
    expect(failed).toContain("Failed");
    expect(failed).toContain("1 step");
  });

  it("draws the steps under Advanced mode's card as timeline rows", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: createElement(ToolActivity, { tool: { name: "Bash", ok: true, summary: "ls" } }) }));
    expect(html).toContain("data-step-timeline");
    expect(html).toContain("data-step-row");
    expect(html).toMatch(/font-mono text-\[13px\] font-medium[^>]*>Bash<\/span>/);
  });

  it("shows Running on a live step row", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, status: "working", children: createElement(ToolActivity, { tool: { name: "Bash" }, live: true }) }));
    expect(html).toContain("Running");
  });

  it("keeps a trace link at the foot of the open card", () => {
    mode.advanced = true;
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, trace: { id: "t", at: 1 }, children: null }));
    expect(html).toContain('data-testid="view-trace"');
  });
});

describe("ActivityRun at narrow widths", () => {
  it("opens Advanced mode's work card by default and keeps Simple's closed", () => {
    const steps = [{ id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Read", ok: true } }];
    mode.advanced = true;
    const open = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: createElement("i", { "data-step": "" }) }));
    expect(open).toContain("data-activity-run");
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("data-step");
    mode.advanced = false;
    const closed = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: createElement("i", { "data-step": "" }) }));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("data-step");
  });

  it("lets the run's row shrink and truncate its summary instead of running off the screen", () => {
    const steps = [
      { id: "a", at: 1, role: "bot" as const, kind: "activity" as const, tool: { name: "Read", ok: true } },
      { id: "b", at: 2, role: "bot" as const, kind: "activity" as const, tool: { name: "mcp__omb__screenshot", ok: true } },
    ];
    const html = renderToStaticMarkup(createElement(ActivityRun, { messages: steps, children: null }));
    expect(html).toMatch(/<div data-activity-run[^>]*>[\s\S]*?<div class="min-w-0 max-w-\[44rem\] flex-1 overflow-hidden /);
    expect(html).toMatch(/<button[^>]*class="flex h-10 w-full items-center [^"]*"/);
    expect(html).toMatch(/<span class="[^"]*\btruncate\b[^"]*">2 steps/);
  });
});
