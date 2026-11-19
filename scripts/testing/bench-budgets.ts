import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BUDGET_KINDS = ["count", "time", "memory"] as const;
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export interface Budget { metric: string; max: number; kind: BudgetKind }
export interface BudgetEntry extends Budget { value?: number; reason?: "above" | "missing" }
export interface BudgetReport { passed: BudgetEntry[]; failed: BudgetEntry[]; skipped: BudgetEntry[] }

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_BUDGETS_FILE = join(ROOT, "scripts", "bench-desktop-budgets.json");

export function pointerSegments(pointer: string): string[] {
  if (!pointer.startsWith("/")) throw new Error(`budget metric "${pointer}" is not a JSON Pointer`);
  return pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function readPointer(root: unknown, pointer: string): unknown {
  let node = root;
  for (const segment of pointerSegments(pointer)) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

export function parseKinds(list: string | undefined): BudgetKind[] | undefined {
  if (!list) return undefined;
  const kinds = list.split(",").map((kind) => kind.trim()).filter(Boolean);
  for (const kind of kinds) if (!(BUDGET_KINDS as readonly string[]).includes(kind)) throw new Error(`unknown budget kind "${kind}"; kinds: ${BUDGET_KINDS.join(", ")}`);
  return kinds as BudgetKind[];
}

export function checkBudgets(result: Record<string, unknown>, budgets: readonly Budget[], kinds?: readonly BudgetKind[]): BudgetReport {
  const report: BudgetReport = { passed: [], failed: [], skipped: [] };
  for (const budget of budgets) {
    const phase = pointerSegments(budget.metric)[0]!;
    if ((kinds && !kinds.includes(budget.kind)) || result[phase] === undefined) {
      report.skipped.push({ ...budget });
      continue;
    }
    const value = readPointer(result, budget.metric);
    if (typeof value !== "number" || !Number.isFinite(value)) report.failed.push({ ...budget, reason: "missing" });
    else if (value > budget.max) report.failed.push({ ...budget, value, reason: "above" });
    else report.passed.push({ ...budget, value });
  }
  return report;
}

export function formatReport(report: BudgetReport): string {
  const lines = report.failed.map((entry) => entry.reason === "missing"
    ? `FAIL ${entry.metric}: missing from the result (limit ${entry.max}, ${entry.kind})`
    : `FAIL ${entry.metric}: ${entry.value} is above the limit ${entry.max} (${entry.kind})`);
  lines.push(`budgets: ${report.passed.length} passed, ${report.failed.length} failed, ${report.skipped.length} skipped`);
  return lines.join("\n");
}

export const budgetExitCode = (report: BudgetReport): number => (report.failed.length ? 1 : 0);

export function parseBudgets(text: string, source = "budgets file"): Budget[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch (error) { throw new Error(`${source} is not valid JSON: ${(error as Error).message}`); }
  const list = (data as { budgets?: unknown } | null)?.budgets;
  if (!Array.isArray(list)) throw new Error(`${source} must be an object with a "budgets" array`);
  const seen = new Set<string>();
  return list.map((item, index): Budget => {
    const where = `${source}: budget ${index + 1}`;
    if (item === null || typeof item !== "object") throw new Error(`${where} must be an object`);
    const { metric, max, kind } = item as Record<string, unknown>;
    if (typeof metric !== "string") throw new Error(`${where} needs a string "metric"`);
    pointerSegments(metric);
    if (typeof max !== "number" || !Number.isFinite(max)) throw new Error(`${where} needs a numeric "max"`);
    if (typeof kind !== "string" || !(BUDGET_KINDS as readonly string[]).includes(kind)) throw new Error(`${where} needs "kind" to be one of ${BUDGET_KINDS.join(", ")}`);
    if (seen.has(metric)) throw new Error(`${where} repeats the metric ${metric}`);
    seen.add(metric);
    return { metric, max, kind: kind as BudgetKind };
  });
}

export function loadBudgets(file: string): Budget[] {
  return parseBudgets(readFileSync(file, "utf8"), file);
}

function main(argv: string[]): number {
  const files: string[] = [];
  let kindList: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--kinds") kindList = argv[++i];
    else files.push(argv[i]!);
  }
  if (!files[0]) {
    process.stderr.write("usage: bench-budgets.ts <result.json> [budgets.json] [--kinds count,memory]\n");
    return 2;
  }
  const budgets = loadBudgets(files[1] ? resolve(files[1]) : DEFAULT_BUDGETS_FILE);
  const result = JSON.parse(readFileSync(resolve(files[0]), "utf8")) as Record<string, unknown>;
  const report = checkBudgets(result, budgets, parseKinds(kindList));
  process.stdout.write(`${formatReport(report)}\n`);
  return budgetExitCode(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`bench-budgets: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
