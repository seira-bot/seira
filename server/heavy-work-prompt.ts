export const HEAVY_WORK_PROMPT =
  "\n\nHeavy work: test suites, builds, docker, ffmpeg, local models and large files can fill this computer's memory. " +
  "Before one, call machine_budget. Start no more parallel workers than suggestedWorkers (for example --maxWorkers, -j, --workers). " +
  "Run one heavy job at a time, and wait if heavyWorkRunning lists one. Start with a small part, then widen. " +
  "When free memory is short, tell the person in plain words and offer a lighter version. " +
  "If a job dies for lack of memory (exit 137, killed, out of memory), run it again with fewer workers.\n";
