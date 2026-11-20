import { FileText } from "lucide-react";

export function WhatItDoes({ value, onChange, placeholder, label }: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <div className="flex items-start gap-4">
      <FileText size={18} className="mt-2.5 shrink-0 text-ink-secondary" />
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} aria-label={label} placeholder={placeholder} className="min-w-0 flex-1 resize-y rounded-xl border border-hairline/50 bg-inset px-3.5 py-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-tertiary focus:border-accent" />
    </div>
  );
}
