import type { AppEnv, MailMessage } from "./common";
import { escapeHtml } from "./common";

export { escapeHtml };

export function textToHtmlParagraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

export function confirmationMessage(env: AppEnv, email: string, token: string): MailMessage {
  const link = `${env.PUBLIC_ORIGIN}/confirm?t=${token}`;
  const line = "You asked for Seira updates in the app.";
  const ignore = "If you didn't ask for this, ignore this email.";
  return {
    from: { email: env.FROM_ADDRESS, name: env.FROM_NAME },
    to: email,
    subject: "Confirm your Seira updates",
    text: `${line}\n\nConfirm your subscription:\n${link}\n\n${ignore}\n`,
    html: `<p>${line}</p><p><a href="${escapeHtml(link)}">Confirm your subscription</a></p><p>${escapeHtml(link)}</p><p>${ignore}</p>`,
  };
}

export function updateMessage(
  env: AppEnv,
  input: { to: string; subject: string; text: string; html?: string; unsubscribeToken?: string },
): MailMessage {
  const base = {
    from: { email: env.FROM_ADDRESS, name: env.FROM_NAME },
    to: input.to,
    subject: input.subject,
  };
  const html = input.html ?? textToHtmlParagraphs(input.text);
  if (!input.unsubscribeToken) return { ...base, text: input.text, html };
  const link = `${env.PUBLIC_ORIGIN}/unsubscribe?t=${input.unsubscribeToken}`;
  return {
    ...base,
    text: `${input.text}\n\n--\nUnsubscribe: ${link}\n`,
    html: `${html}<p style="color:#666;font-size:.85em"><a href="${escapeHtml(link)}">Unsubscribe</a></p>`,
    headers: { "List-Unsubscribe": `<${link}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
