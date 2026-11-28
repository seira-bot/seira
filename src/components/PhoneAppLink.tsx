import { openExternalLink, PLAY_STORE_URL } from "@/lib/app-links";
import { productName } from "@/lib/brand";
import { t } from "@/lib/i18n";

export function PhoneAppLink({ className = "" }: { className?: string }) {
  return (
    <button type="button" data-phone-app-link="" onClick={() => void openExternalLink(PLAY_STORE_URL)}
      className={`text-[12px] text-accent hover:underline ${className}`}>
      {t("phone.code.getAndroid", { app: productName() })}
    </button>
  );
}
