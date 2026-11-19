import { PRIVACY_URL, TERMS_URL, openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";

export function LegalLinks() {
  return (
    <>
      <LegalLink href={PRIVACY_URL} label={t("legal.privacy")} />
      <LegalLink href={TERMS_URL} label={t("legal.terms")} />
    </>
  );
}

function LegalLink({ href, label }: { href: string; label: string }) {
  return (
    <button type="button" data-legal-link={href} onClick={() => void openExternalLink(href)} className="text-accent hover:underline">
      {label}
    </button>
  );
}
