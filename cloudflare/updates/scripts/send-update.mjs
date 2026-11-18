#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    subject: { type: "string" },
    "text-file": { type: "string" },
    "html-file": { type: "string" },
    test: { type: "string" },
    origin: { type: "string", default: "https://updates.seira.bot" },
    "dry-run": { type: "boolean", default: false },
  },
});

const token = process.env.SEIRA_UPDATES_ADMIN_TOKEN;
if (!token) fail("Set SEIRA_UPDATES_ADMIN_TOKEN in the environment.");
const origin = values.origin.replace(/\/+$/, "");

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function call(path, body) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(`Request to ${path} failed with status ${response.status}${payload.error ? ` (${payload.error})` : ""}.`);
  return payload;
}

if (values["dry-run"]) {
  console.log("Subscribers:", JSON.stringify(await call("/admin/stats")));
  process.exit(0);
}

if (!values.subject || !values["text-file"]) fail("Use --subject and --text-file.");
const message = {
  subject: values.subject,
  text: await readFile(values["text-file"], "utf8"),
  ...(values["html-file"] ? { html: await readFile(values["html-file"], "utf8") } : {}),
};

let sent = 0;
const failures = [];
if (values.test) {
  const result = await call("/admin/send", { ...message, test: values.test });
  sent = result.sent;
  failures.push(...result.failed);
} else {
  let after;
  do {
    const result = await call("/admin/send", { ...message, ...(after ? { after } : {}) });
    sent += result.sent;
    failures.push(...result.failed);
    after = result.next;
    console.log(`Sent ${sent} so far.`);
  } while (after);
}

console.log(`Sent: ${sent}. Failed: ${failures.length}.`);
for (const entry of failures) console.log(`  ${entry.email} ${entry.code}`);
if (failures.length) process.exitCode = 1;
