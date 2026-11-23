import { describe, expect, it } from "vitest";

import { mask } from "../../shared/redact.ts";
import { stripHtmlComments, toolFromConfig } from "./local-agent.ts";

const alpha = "Abcdefghij0123456789Klmnopqrst";
const openaiKey = `${"sk-"}proj-${alpha}`;
const githubKey = `${"gh" + "p_"}${alpha}0123456`;
const slackKey = `${"xox" + "b-"}123456789012-1234567890123-${alpha}`;

describe("toolFromConfig", () => {
  it("keeps a clean url, plain args and placeholders unchanged", () => {
    const url = "https://mcp.example.test/docs?v=2&mode=read&keyword=notes&token_url=https%3A%2F%2Fauth.example.test#top";
    expect(toolFromConfig("docs", { url, headers: { Authorization: "Bearer x" } }))
      .toEqual({ ref: "mcp/docs", name: "docs", transport: "http", url, needsKey: ["Authorization"] });

    const args = [
      "-y", "example-mcp", "--port", "8080", "--key-file", "/etc/mcp/key.pem", "--key", "./server.key",
      "--token", "${GITHUB_TOKEN}", "--api-key", "<your key>", "-e", "GITHUB_TOKEN", "--header", "Authorization: Bearer ${TOKEN}",
      "keyword=search", "https://mcp.example.test/sse?v=2",
    ];
    expect(toolFromConfig("files", { command: "npx", args: [...args], env: { FILES_ROOT: "/data" } }))
      .toEqual({ ref: "mcp/files", name: "files", transport: "stdio", command: "npx", args, needsKey: ["FILES_ROOT"] });
  });

  it("drops url userinfo and secret query values, and names each one as a header", () => {
    const tool = toolFromConfig("search", {
      url: `https://me:${alpha}@mcp.example.test/mcp?api_key=${alpha}&v=2&X-Amz-Signature=${alpha}&token=&keyword=x#access_token=${alpha}`,
      headers: { Authorization: "Bearer x" },
    });
    expect(tool).toEqual({
      ref: "mcp/search", name: "search", transport: "http",
      url: "https://mcp.example.test/mcp?api_key=&v=2&X-Amz-Signature=&token=&keyword=x#access_token=",
      needsKey: ["Authorization", "api_key", "X-Amz-Signature", "access_token"],
    });
    expect(JSON.stringify(tool)).not.toContain(alpha);
  });

  it("strips a token kept as the url user name", () => {
    expect(toolFromConfig("git", { url: `https://${alpha}@mcp.example.test/mcp` }))
      .toMatchObject({ url: "https://mcp.example.test/mcp", needsKey: ["Authorization"] });
  });

  it("masks a key-shaped value anywhere in the url", () => {
    expect(JSON.stringify(toolFromConfig("zap", { url: `https://actions.example.test/mcp/${openaiKey}/sse` }))).not.toContain(alpha);
  });

  it("masks secret args and names each one as an env variable", () => {
    const tool = toolFromConfig("github", {
      command: "npx",
      args: [
        "--api-key", openaiKey,
        `--token=${githubKey}`,
        "--secret", "hunter2hunter2",
        "--password", "pw",
        "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${githubKey}`,
        "--header", `X-Api-Key: ${alpha}`,
        `https://mcp.example.test/sse?apiKey=${alpha}`,
        "--github", githubKey,
        slackKey,
      ],
      env: { API_KEY: "" },
    });
    expect(tool).toEqual({
      ref: "mcp/github", name: "github", transport: "stdio", command: "npx",
      args: [
        "--api-key", mask(openaiKey),
        `--token=${mask(githubKey)}`,
        "--secret", mask("hunter2hunter2"),
        "--password", mask("pw"),
        "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${mask(githubKey)}`,
        "--header", `X-Api-Key: ${mask(alpha)}`,
        "https://mcp.example.test/sse?apiKey=",
        "--github", mask(githubKey),
        mask(slackKey),
      ],
      needsKey: ["API_KEY", "TOKEN", "SECRET", "PASSWORD", "GITHUB_PERSONAL_ACCESS_TOKEN", "X_API_KEY", "GITHUB"],
    });
    expect(JSON.stringify(tool)).not.toContain(alpha);
    expect(JSON.stringify(tool)).not.toContain("hunter2");
  });

  it("masks a key in the command", () => {
    const tool = toolFromConfig("openai", { command: `env OPENAI_API_KEY=${openaiKey} npx example-mcp` });
    expect(tool?.needsKey).toEqual(["API_KEY"]);
    expect(JSON.stringify(tool)).not.toContain(alpha);
  });
});

describe("stripHtmlComments", () => {
  it("removes a comment and one that only forms once an inner comment is removed", () => {
    expect(stripHtmlComments("a<!-- x -->b")).toBe("ab");
    expect(stripHtmlComments("a<!<!-- x -->-- y -->b")).toBe("ab");
  });
});
