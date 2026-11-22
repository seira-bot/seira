import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

const CHIP = "max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary";

export function handoffBody(text: string | undefined): string {
  const value = text ?? "";
  const end = value.indexOf("]\n");
  return (end === -1 ? value : value.slice(end + 2)).trim();
}

export function HandoffCard({ message }: { message: Message }) {
  if (!message.handoff) return null;
  return (
    <details className={CHIP} data-testid="handoff-card">
      <summary className="cursor-pointer font-medium">{t("chat.handoff.title", { title: message.handoff.title })}</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{handoffBody(message.text)}</p>
    </details>
  );
}
