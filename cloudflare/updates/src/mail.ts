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

const FONT = "Geist,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function confirmationMessage(env: AppEnv, email: string, token: string): MailMessage {
  const link = `${env.PUBLIC_ORIGIN}/confirm?t=${token}`;
  const title = "Confirm your Seira updates";
  const line = "You asked for Seira updates in the app. Confirm this email to get news about Seira, such as new versions.";
  const ignore = "Did not ask for this? Ignore this email. You will not get updates.";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
    + `<body style="margin:0;padding:0;background:#F3F4F6;font-family:${FONT}">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6"><tr><td align="center" style="padding:24px 16px">`
    + `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#FFFFFF;border:1px solid #E4E5E8;border-radius:16px">`
    + `<tr><td style="padding:24px 24px 0 24px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:#0E1116">Seira</td></tr>`
    + `<tr><td style="padding:16px 24px 0 24px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;color:#0E1116">${title}</td></tr>`
    + `<tr><td style="padding:12px 24px 0 24px;font-family:${FONT};font-size:16px;line-height:24px;color:#3D434C">${line}</td></tr>`
    + `<tr><td style="padding:24px 24px 0 24px"><a href="${escapeHtml(link)}" style="display:inline-block;background:#0E1116;color:#FFFFFF;font-family:${FONT};font-size:16px;font-weight:600;line-height:48px;height:48px;padding:0 24px;border-radius:999px;text-decoration:none">Confirm subscription</a></td></tr>`
    + `<tr><td style="padding:16px 24px 24px 24px;font-family:${FONT};font-size:13px;line-height:20px;color:#6A707A">${ignore}</td></tr>`
    + `<tr><td style="padding:16px 24px;border-top:1px solid #E4E5E8;font-family:${FONT};font-size:13px;line-height:20px;color:#6A707A">Seira &middot; <a href="https://seira.bot" style="color:#6A707A;text-decoration:underline">seira.bot</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
  return {
    from: { email: env.FROM_ADDRESS, name: env.FROM_NAME },
    to: email,
    subject: title,
    text: `${line}\n\nConfirm your subscription:\n${link}\n\n${ignore}\n\n--\nSeira \u00b7 seira.bot\n`,
    html,
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
