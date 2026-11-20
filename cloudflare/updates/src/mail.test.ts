import { describe, expect, it } from "vitest";

import type { AppEnv } from "./common";
import { confirmationMessage } from "./mail";

const env = { PUBLIC_ORIGIN: "https://updates.example.test", FROM_ADDRESS: "updates@example.test", FROM_NAME: "Seira" } as AppEnv;
const TOKEN = "A".repeat(43);
const LINK = `https://updates.example.test/confirm?t=${TOKEN}`;

describe("confirmation mail", () => {
  const message = confirmationMessage(env, "ana@example.test", TOKEN);

  it("keeps the subject and says what the mail is for", () => {
    expect(message.subject).toBe("Confirm your Seira updates");
    expect(message.html).toContain("You asked for Seira updates in the app. Confirm this email to get news about Seira, such as new versions.");
    expect(message.html).toContain("Did not ask for this? Ignore this email. You will not get updates.");
  });

  it("puts the link in a Confirm subscription button and nowhere else in the HTML", () => {
    expect(message.html).toContain(`href="${LINK}"`);
    expect(message.html).toContain(">Confirm subscription</a>");
    expect(message.html.split(LINK)).toHaveLength(2);
    expect(message.html).toContain('href="https://seira.bot"');
  });

  it("keeps the link in the plain text", () => {
    expect(message.text).toBe([
      "You asked for Seira updates in the app. Confirm this email to get news about Seira, such as new versions.", "",
      "Confirm your subscription:", LINK, "",
      "Did not ask for this? Ignore this email. You will not get updates.", "",
      "--", "Seira · seira.bot", "",
    ].join("\n"));
  });
});
