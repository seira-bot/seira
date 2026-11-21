import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { DeviceSignInProgress, type DeviceSignInStatus } from "./DeviceSignIn";

const OPENAI_BLOSSOM = 'd="M239.184 106.203';
const CODEX_GRADIENT = "#3941FF";

describe("the ChatGPT sign-in marks", () => {
  it("shows the OpenAI logo on the ChatGPT plan welcome", () => {
    const html = renderToStaticMarkup(createElement(ChatGptPlanStatus, { instanceId: "codex" }));
    expect(html).toContain("data-chatgpt-plan-welcome");
    expect(html).toContain(OPENAI_BLOSSOM);
    expect(html).not.toContain(CODEX_GRADIENT);
  });

  it("shows the OpenAI logo, in the button's colour, on Continue with ChatGPT", () => {
    const auth: DeviceSignInStatus = { phase: "waiting", flowId: "fixture-flow", authorizationUrl: "https://auth.openai.com/api/accounts/authorize?client_id=fixture", expiresAt: "2030-01-01T12:00:00.000Z" };
    const html = renderToStaticMarkup(createElement(DeviceSignInProgress, { auth, browserPkce: true }));
    expect(html).toContain("Continue with ChatGPT");
    expect(html).toContain(OPENAI_BLOSSOM);
    expect(html).toMatch(/<svg [^>]*class="[^"]*\bfill-current\b/);
    expect(html).not.toContain(CODEX_GRADIENT);
  });
});
