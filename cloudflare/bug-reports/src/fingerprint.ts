import { sha256Hex } from "./common";

const PROBLEMS_HEADING = "## Recent problems in this conversation, newest last";
const LOG_HEADING = "## Server warnings and errors, newest last";
const GENERIC_KINDS = new Set(["ERROR", "EXCEPTION"]);
const KIND = /\b([A-Z][A-Za-z0-9]*(?:Error|Exception)|E[A-Z]{2,}(?:_[A-Z]+)*)\b/g;
const FRAME =
  /\bat\s{1,20}(?:async\s{1,20})?(?:([^\s()]{1,300})\s{1,20}\(([^()\s]{1,300}:\d{1,9}(?::\d{1,9})?)\)|([^\s()]{0,300}[\\/.][^\s()]{0,300}:\d{1,9}(?::\d{1,9})?))/;
const LINE_SCAN_LIMIT = 1000;

export interface FingerprintHint {
  kind?: string | undefined;
  step?: string | undefined;
  frame?: string | undefined;
}

export interface Fingerprint {
  hash: string;
  kind: string;
  step: string;
  frame: string;
}

export function normalize(value: string, max = 200) {
  return value
    .toLowerCase()
    .replace(/«[^»]*»/g, "#")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "#")
    .replace(/\b[0-9a-f]{6,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function section(diagnostics: string, heading: string) {
  const start = diagnostics.indexOf(heading);
  if (start < 0) return "";
  const rest = diagnostics.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

function newestProblem(problems: string) {
  const lines = problems.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? "").slice(0, LINE_SCAN_LIMIT);
    const tool = /\btool (\S+) failed(?:: (.*))?/.exec(line);
    if (tool) return { step: `tool:${tool[1]}`, detail: tool[2] ?? "" };
    const turn = /\bturn failed: (.*)/.exec(line);
    if (turn) return { step: "turn", detail: turn[1] ?? "" };
  }
  return { step: "", detail: "" };
}

const newestFirst = (text: string) => text.split(/\r?\n/).reverse().map((line) => line.slice(0, LINE_SCAN_LIMIT));

function kindIn(text: string) {
  for (const line of newestFirst(text)) {
    for (const match of line.matchAll(KIND)) {
      if (!GENERIC_KINDS.has(match[1]!)) return match[1]!;
    }
  }
  return "";
}

function frameIn(text: string) {
  let match: RegExpExecArray | null = null;
  for (const line of newestFirst(text)) {
    match = FRAME.exec(line);
    if (match) break;
  }
  if (!match) return "";
  const fn = match[1] ?? "";
  const location = match[2] ?? match[3] ?? "";
  const file = (
    location
      .replace(/(?::\d+){1,2}$/, "")
      .replace(/[?#].*$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  ).replace(/-(?=[A-Za-z0-9]*[A-Z0-9])[A-Za-z0-9]{6,}(?=\.[A-Za-z0-9]+$)/, "");
  return normalize(`${fn} ${file}`);
}

export async function fingerprintOf(input: {
  description: string;
  diagnostics: string;
  hint?: FingerprintHint | undefined;
}): Promise<Fingerprint> {
  let kind: string;
  let step: string;
  let frame: string;

  if (input.hint) {
    kind = normalize(input.hint.kind ?? "");
    step = normalize(input.hint.step ?? "");
    frame = normalize(input.hint.frame ?? "");
  } else {
    const logs = section(input.diagnostics, LOG_HEADING);
    const problem = newestProblem(section(input.diagnostics, PROBLEMS_HEADING));
    step = normalize(problem.step);
    const named = kindIn(problem.detail) || kindIn(logs);
    kind = named ? normalize(named) : normalize(problem.detail, 80);
    frame = frameIn(logs) || frameIn(input.diagnostics);
  }

  if (!kind && !step && !frame) {
    const first = input.description.split(/\r?\n/).find((line) => line.trim()) ?? "";
    step = normalize(first);
  }

  const hash = (await sha256Hex(`v1\n${kind}\n${step}\n${frame}`)).slice(0, 16);
  return { hash, kind, step, frame };
}
