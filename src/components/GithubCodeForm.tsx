import { useState } from "react";
import { Loader2 } from "lucide-react";

import { completeGithub, GithubCodeError } from "@/lib/github-app";
import { t } from "@/lib/i18n";

const field = "h-8 min-w-0 flex-1 rounded-full bg-inset px-3 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none focus:ring-1 focus:ring-accent";

/** "Enter the code from GitHub": for a browser that cannot come back to this server by itself. */
export function GithubCodeForm({ className = "mt-2" }: { className?: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const finish = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await completeGithub(code);
      setCode("");
    } catch (cause) {
      setError(cause instanceof GithubCodeError ? cause.message : t("github.error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={className}>
      <form data-github-code className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); void finish(); }}>
        <input
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder={t("github.codeLabel")}
          aria-label={t("github.codeLabel")}
          className={field}
        />
        <button type="submit" disabled={busy || !code.trim()} className="inline-flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[13px] font-medium leading-5 text-accent-ink disabled:opacity-40">
          {busy ? <Loader2 size={14} className="animate-spin" /> : t("github.codeFinish")}
        </button>
      </form>
      {error && <p role="alert" className="mt-1.5 text-[12px] text-danger">{error}</p>}
    </div>
  );
}
