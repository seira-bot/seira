export const HEAVY_WORK_PROMPT =
  "\n\nHeavy work: test suites, builds, docker, video, local models, many browsers and large files can fill this computer. " +
  "Before one, call machine_budget with its task. If fit is too_small, tell the person before you start, also at Full access: what this computer has, what the job needs, and the lighter way or another computer; then wait for their answer. " +
  "If fit is tight, say so in one line and use the lighter way. " +
  "Start no more parallel workers than suggestedWorkers (for example --maxWorkers, -j, --workers). " +
  "Run one heavy job at a time, and wait if heavyWorkRunning lists one. Start with a small part, then widen. " +
  "If a job dies for lack of memory (exit 137, killed, out of memory), run it again with fewer workers.\n";
