import { useEffect, useState } from "react";
import { TEXT_SIZE_STEPS } from "../../shared/app-settings";
import { t } from "@/lib/i18n";
import { CHAT_WIDTH_IDS, applyChatWidth, readChatWidth, type ChatWidthId } from "@/lib/chat-width";
import { FONT_IDS, applyFont, readFont, type FontId } from "@/lib/fonts";
import { parseSidebarToolsLayout, setSidebarToolsLayout, SIDEBAR_TOOLS_LAYOUTS, useSidebarToolsLayout } from "@/lib/sidebar-preferences";
import { SettingRow } from "./SettingsPrimitives";
import { Select } from "./Select";

export function FontRow() {
  const [current, setCurrent] = useState<FontId>(readFont);
  return (
    <SettingRow title={t("settings.font.title")} subtitle={t("settings.font.line")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        aria-label={t("settings.font.aria")}
        onChange={(event) => {
          // SAFETY: the options are rendered from FONT_IDS, so the value is always a member.
          const id = event.target.value as FontId;
          applyFont(id);
          setCurrent(id);
        }}
      >
        {FONT_IDS.map((id) => (
          <option key={id} value={id}>{t(`settings.font.${id}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

export function ChatWidthRow() {
  const [current, setCurrent] = useState<ChatWidthId>(readChatWidth);
  return (
    <SettingRow title={t("settings.chatWidth.title")} subtitle={t("settings.chatWidth.line")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={current}
        aria-label={t("settings.chatWidth.aria")}
        onChange={(event) => {
          const id = CHAT_WIDTH_IDS.find((width) => width === event.target.value);
          if (!id) return;
          applyChatWidth(id);
          setCurrent(id);
        }}
      >
        {CHAT_WIDTH_IDS.map((id) => (
          <option key={id} value={id}>{t(`settings.chatWidth.${id}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

export function SidebarToolsLayoutRow() {
  const layout = useSidebarToolsLayout();
  return (
    <SettingRow title={t("sidebar.toolsLayout.title")} subtitle={t("sidebar.toolsLayout.subtitle")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={layout}
        aria-label={t("sidebar.toolsLayout.chooseAria")}
        onChange={(event) => setSidebarToolsLayout(parseSidebarToolsLayout(event.target.value))}
      >
        {SIDEBAR_TOOLS_LAYOUTS.map((option) => (
          <option key={option} value={option}>{t(`sidebar.toolsLayout.${option}`)}</option>
        ))}
      </Select>
    </SettingRow>
  );
}

const DEFAULT_TEXT_SIZE = 1;

/** The window's text size, a choice of this desktop: not rendered where the desktop app's bridge is absent. */
export function TextSizeRow() {
  const bridge = typeof window === "undefined" ? undefined : window.ogb?.textSize;
  const [current, setCurrent] = useState<number | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    void bridge.get().then((step) => { if (alive) setCurrent(step); }).catch(() => {});
    const stop = bridge.onChange?.((step) => setCurrent(step));
    return () => { alive = false; stop?.(); };
  }, [bridge]);
  if (!bridge || current === null) return null;
  return (
    <SettingRow title={t("settings.textSize.title")} subtitle={t("settings.textSize.line")}>
      <Select size="sm" className="w-full max-w-[240px]"
        value={String(current)}
        aria-label={t("settings.textSize.aria")}
        onChange={(event) => {
          const step = TEXT_SIZE_STEPS.find((candidate) => String(candidate) === event.target.value);
          if (step === undefined) return;
          setCurrent(step);
          void bridge.set(step).then(setCurrent).catch(() => {});
        }}
      >
        {TEXT_SIZE_STEPS.map((step) => {
          const percent = Math.round(step * 100);
          return <option key={step} value={String(step)}>{t(step === DEFAULT_TEXT_SIZE ? "settings.textSize.default" : "settings.textSize.step", { percent })}</option>;
        })}
      </Select>
    </SettingRow>
  );
}
