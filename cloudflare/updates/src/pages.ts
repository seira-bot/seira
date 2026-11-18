import { escapeHtml, textToHtmlParagraphs } from "./mail";

const STYLE = "font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1a1a1a";
const BUTTON = "font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.5rem;background:#1a1a1a;color:#fff;cursor:pointer";

export function page(heading: string, message: string, form?: { action: string; field?: { name: string; value: string }; button: string }, status = 200) {
  const hidden = form?.field ? `<input type="hidden" name="${escapeHtml(form.field.name)}" value="${escapeHtml(form.field.value)}">` : "";
  const control = form
    ? `<form method="post" action="${escapeHtml(form.action)}">${hidden}<button type="submit" style="${BUTTON}">${escapeHtml(form.button)}</button></form>`
    : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Seira updates</title></head>` +
    `<body style="${STYLE}"><h1 style="font-size:1.4rem">${escapeHtml(heading)}</h1>${textToHtmlParagraphs(message)}${control}</body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
