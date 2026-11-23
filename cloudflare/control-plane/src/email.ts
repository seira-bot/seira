export interface TransactionalEmailSender {
  send(message: {
    to: string;
    from: { email: string; name: string };
    subject: string;
    html: string;
    text: string;
  }): Promise<void>;
}

export interface OTPEmailInput {
  email: string;
  otp: string;
  type: "sign-in" | "email-verification" | "forget-password" | "change-email";
}

type TemplatedType = Exclude<OTPEmailInput["type"], "forget-password">;

const SHARE_WARNING = "Do not share this code with anyone. The Seira team never asks for it.";

const TEMPLATES: Record<TemplatedType, {
  subject: string;
  title: string;
  intro: (email: string) => string;
  ignore: string;
}> = {
  "sign-in": {
    subject: "Your Seira sign-in code",
    title: "Your Seira sign-in code",
    intro: () => "Enter this code in the Seira app:",
    ignore: "Did not ask for this code? Ignore this email. Nothing changes.",
  },
  "email-verification": {
    subject: "Verify your Seira email",
    title: "Verify your email",
    intro: (email) => `Enter this code in Seira to confirm that ${email} is your email:`,
    ignore: "Did not ask for this? Ignore this email. Nothing changes.",
  },
  "change-email": {
    subject: "Confirm your new Seira email",
    title: "Confirm your new email",
    intro: (email) => `Enter this code in Seira to use ${email} for your Seira account:`,
    ignore: "Did not ask for this? Ignore this email. Your account keeps its current email.",
  },
};

const FONT = "Geist,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(template: (typeof TEMPLATES)[TemplatedType], email: string, otp: string) {
  const title = escapeHtml(template.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
    + `<body style="margin:0;padding:0;background:#F3F4F6;font-family:${FONT}">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F3F4F6"><tr><td align="center" style="padding:24px 16px">`
    + `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background:#FFFFFF;border:1px solid #E4E5E8;border-radius:16px">`
    + `<tr><td style="padding:24px 24px 0 24px;font-family:${FONT};font-size:18px;line-height:24px;font-weight:700;color:#0E1116">Seira</td></tr>`
    + `<tr><td style="padding:16px 24px 0 24px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:600;color:#0E1116">${title}</td></tr>`
    + `<tr><td style="padding:12px 24px 0 24px;font-family:${FONT};font-size:16px;line-height:24px;color:#3D434C">${escapeHtml(template.intro(email))}</td></tr>`
    + `<tr><td style="padding:16px 24px 0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="background:#F3F4F6;border:1px solid #E4E5E8;border-radius:12px;padding:16px;font-family:${FONT};font-size:32px;line-height:40px;font-weight:600;letter-spacing:0.08em;color:#0E1116">${escapeHtml(otp)}</td></tr></table></td></tr>`
    + `<tr><td style="padding:16px 24px 0 24px;font-family:${FONT};font-size:16px;line-height:24px;color:#3D434C">${SHARE_WARNING}</td></tr>`
    + `<tr><td style="padding:12px 24px 24px 24px;font-family:${FONT};font-size:13px;line-height:20px;color:#6A707A">${escapeHtml(template.ignore)}</td></tr>`
    + `<tr><td style="padding:16px 24px;border-top:1px solid #E4E5E8;font-family:${FONT};font-size:13px;line-height:20px;color:#6A707A">Seira &middot; <a href="https://seira.bot" style="color:#6A707A;text-decoration:underline">seira.bot</a></td></tr>`
    + `</table></td></tr></table></body></html>`;
}

export function buildOTPEmail(from: string, input: OTPEmailInput & { type: TemplatedType }) {
  const template = TEMPLATES[input.type];
  const text = [
    template.title,
    "",
    template.intro(input.email),
    "",
    input.otp,
    "",
    SHARE_WARNING,
    template.ignore,
    "",
    "--",
    "Seira \u00b7 seira.bot",
    "",
  ].join("\n");
  return {
    to: input.email,
    from: { email: from, name: "Seira" },
    subject: template.subject,
    html: renderHtml(template, input.email, input.otp),
    text,
  };
}

export async function sendOTPEmail(
  sender: TransactionalEmailSender,
  from: string,
  input: OTPEmailInput,
  requestId: string,
): Promise<void> {
  if (input.type === "forget-password") return;
  try {
    await sender.send(buildOTPEmail(from, { ...input, type: input.type }));
  } catch {
    // Authentication responses stay enumeration-safe. Do not log the address,
    // code, provider error, message object, or any other credential material.
    console.error(JSON.stringify({ message: "transactional email send failed", requestId }));
  }
}
