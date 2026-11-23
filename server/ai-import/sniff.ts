import { AI_IMPORT_LIMITS } from "../../shared/ai-import/limits.ts";
import type { ImportFiles, SourceReader } from "./reader.ts";

/** Asks every reader at once and returns the first one, in list order, that knows the files; null when none does in time. */
export async function sniffSource(files: ImportFiles, readers: readonly SourceReader[], timeoutMs: number = AI_IMPORT_LIMITS.sniffMs): Promise<SourceReader | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"late">((resolve) => { timer = setTimeout(() => resolve("late"), timeoutMs); });
  const answers: Array<boolean | null> = readers.map(() => null);
  const asked = readers.map((reader, index) =>
    Promise.resolve()
      .then(() => reader.sniff(files))
      .then((yes) => yes === true, () => false)
      .then((yes) => { answers[index] = yes; }));
  const first = (): SourceReader | null | undefined => {
    for (let i = 0; i < readers.length; i++) {
      if (answers[i] === null) return undefined;
      if (answers[i]) return readers[i]!;
    }
    return null;
  };
  try {
    for (;;) {
      const found = first();
      if (found !== undefined) return found;
      const pending = asked.filter((_, index) => answers[index] === null);
      if ((await Promise.race([deadline, Promise.race(pending)])) === "late") {
        for (let i = 0; i < readers.length; i++) if (answers[i]) return readers[i]!;
        return null;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}
