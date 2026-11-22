import { useId, useState } from "react";
import { ImagePlus, Loader2, Shuffle, Trash2 } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { colorSwatch, PICKABLE_STATES, SEIRA_COLOR_LABEL, SEIRA_COLOR_NAMES, type MascotState } from "@/lib/mascot";
import { bodyName, colorName, expressionName } from "@/lib/mascot-names";
import type { LocaleKey } from "@/locales";
import type { Bot } from "@/state/store";
import { PICKER_BODY_IDS, botBodyId, type BotBodyId } from "../../../shared/bot-body";
import { mascotAccessories } from "../../../shared/mascot-accessories";
import { randomPersonLook } from "../../../shared/person-look";
import { SeiraAvatar } from "../Avatar";
import { AvatarImageGenerator } from "../AvatarImageGenerator";
import { AvatarFraming, AVATAR_FILE_TYPES, OrganizationAvatarIcons, type AvatarPatch, type useAvatarImage } from "../avatar-editing";
import { MascotAccessoryPicker } from "../MascotAccessoryPicker";

export type AvatarEditorTab = "seira" | "generate" | "upload";
type Group = "hair" | "face" | "accessories" | "color";

const TABS: ReadonlyArray<readonly [AvatarEditorTab, LocaleKey]> = [
  ["seira", "avatarEditor.tabSeira"],
  ["generate", "botPanel.avatar.tabGenerate"],
  ["upload", "botPanel.avatar.tabUpload"],
];

const GROUPS: ReadonlyArray<readonly [Group, LocaleKey]> = [
  ["hair", "botIdentity.hair"],
  ["face", "botPanel.avatar.face"],
  ["accessories", "botIdentity.accessories"],
  ["color", "botIdentity.color"],
];

export function AvatarEditor({ bot, activeState, image, variant, nameLabel, onPatch }: {
  bot: Bot;
  activeState: MascotState;
  image: ReturnType<typeof useAvatarImage>;
  variant: "popover" | "card" | "welcome";
  nameLabel?: string;
  onPatch: (patch: AvatarPatch) => void;
}) {
  const { fileRef, crop, uploading, generating, busy, error, upload, removeImage, generate } = image;
  const showsImage = crop !== "mascot" && Boolean(bot.avatarUrl);
  const [tab, setTab] = useState<AvatarEditorTab>(showsImage ? "upload" : "seira");
  const [group, setGroup] = useState<Group>(PICKER_BODY_IDS.length > 1 ? "hair" : "face");
  const panelId = useId();
  const compact = variant === "welcome";
  const body = botBodyId(bot.mascotBody);
  const pick = (patch: AvatarPatch) => onPatch(crop === "mascot" ? patch : { ...patch, avatarCrop: "mascot" });
  const surprise = () => {
    const { mascotBody, mascotAccessories: worn, color } = randomPersonLook(Math.random, showsImage ? null : {
      mascotBody: body,
      mascotAccessories: [...mascotAccessories(bot.mascotAccessories)],
      color: bot.color,
    });
    pick({ mascotBody, mascotAccessories: worn, color });
  };

  const tile = (selected: boolean) => cn(
    "flex items-center justify-center rounded-xl disabled:opacity-50",
    compact ? "h-11" : "h-[58px]",
    selected ? "bg-ink/[0.08] ring-[1.5px] ring-inset ring-ink/25" : "hover:bg-ink/[0.05]",
  );
  const size = compact ? 30 : 40;

  const hairTile = (id: BotBodyId) => (
    <button
      key={id}
      type="button"
      disabled={busy}
      aria-pressed={!showsImage && body === id}
      aria-label={t("mascot.useHair", { name: bodyName(id) })}
      title={bodyName(id)}
      data-avatar-hair={id}
      onClick={() => pick({ mascotBody: id })}
      className={tile(!showsImage && body === id)}
    >
      <SeiraAvatar color={bot.color} bodyId={id} size={size} animated={false} trackPointer={false} />
    </button>
  );

  const faceTile = (expression: MascotState) => (
    <button
      key={expression}
      type="button"
      disabled={busy}
      aria-pressed={!showsImage && activeState === expression}
      aria-label={t("mascot.useExpression", { expression: expressionName(expression) })}
      title={expressionName(expression)}
      data-avatar-face={expression}
      onClick={() => pick({ mascotExpression: expression })}
      className={tile(!showsImage && activeState === expression)}
    >
      <SeiraAvatar
        color={bot.color}
        bodyId={body}
        accessories={mascotAccessories(bot.mascotAccessories)}
        state={expression}
        size={size}
        animated={false}
        trackPointer={false}
      />
    </button>
  );

  return (
    <div data-avatar-editor data-look={variant}>
      <div role="tablist" aria-label={t("botIdentity.avatar")} className="flex items-center gap-0.5">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={panelId}
            data-avatar-tab={id}
            onClick={() => setTab(id)}
            className={cn(
              "rounded-lg px-[11px] py-[5px] text-[13px]",
              tab === id ? "bg-ink/[0.08] font-medium text-ink" : "text-ink-secondary hover:text-ink",
            )}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {error && <div role="alert" className="mt-2 text-[12px] text-danger">{error}</div>}

      <div id={panelId} role="tabpanel" className="mt-3">
        {tab === "seira" && (
          <>
            <div role="group" aria-label={t("avatarEditor.tabSeira")} className="flex flex-wrap items-center gap-1">
              {GROUPS.filter(([id]) => id !== "hair" || PICKER_BODY_IDS.length > 1).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  data-avatar-group={id}
                  aria-pressed={group === id}
                  onClick={() => setGroup(id)}
                  className={cn(
                    "rounded-full px-2.5 py-1 text-[12px]",
                    group === id ? "bg-ink/[0.15] text-ink" : "bg-ink/[0.04] text-ink-secondary hover:text-ink",
                  )}
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <div className="mt-3">
              {group === "hair" && PICKER_BODY_IDS.length > 1 && (
                <div className="grid grid-cols-5 gap-1.5" role="group" aria-label={t("botIdentity.hair")}>
                  {PICKER_BODY_IDS.map(hairTile)}
                </div>
              )}
              {group === "face" && (
                <div className="grid grid-cols-5 gap-1.5" role="group" aria-label={t("botPanel.avatar.face")}>
                  {PICKABLE_STATES.map(faceTile)}
                </div>
              )}
              {group === "accessories" && <MascotAccessoryPicker bot={bot} disabled={busy} compact={compact} onPatch={pick} />}
              {group === "color" && (
                <div className="flex flex-wrap justify-center gap-2 px-1 py-1" role="group" aria-label={t("botIdentity.color")}>
                  {SEIRA_COLOR_NAMES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      disabled={busy}
                      aria-pressed={bot.color === color}
                      aria-label={t("mascot.useColor", { color: colorName(color) })}
                      title={t(SEIRA_COLOR_LABEL[color])}
                      data-avatar-color={color}
                      onClick={() => pick({ color })}
                      className={cn(
                        "size-6 rounded-full disabled:opacity-50",
                        bot.color === color && "ring-2 ring-ink/80 ring-offset-2 ring-offset-menu",
                      )}
                      style={{ background: colorSwatch(color) }}
                    />
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              data-avatar-surprise
              disabled={busy}
              onClick={surprise}
              className="mx-auto mt-3 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] text-ink-secondary hover:bg-ink/[0.05] hover:text-ink disabled:opacity-50"
            >
              <Shuffle size={13} aria-hidden="true" />
              {t("avatarEditor.surprise")}
            </button>
          </>
        )}

        {tab === "generate" && (
          <AvatarImageGenerator
            botLabel={nameLabel ?? (bot.title || bot.name)}
            disabled={uploading}
            generating={generating}
            onGenerate={generate}
          />
        )}

        {tab === "upload" && (
          <>
            <OrganizationAvatarIcons busy={busy} onUpload={(file) => void upload(file)} />
            {showsImage && <AvatarFraming bot={bot} disabled={busy} onPatch={onPatch} />}
            <input
              ref={fileRef}
              type="file"
              accept={AVATAR_FILE_TYPES}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void upload(event.target.files?.[0])}
            />
            <button
              type="button"
              data-avatar-drop
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                void upload(event.dataTransfer.files?.[0]);
              }}
              className="flex w-full flex-col items-center gap-1.5 rounded-xl border-[1.5px] border-dashed border-ink/15 px-3 py-6 text-center text-[13px] text-ink-secondary hover:border-ink/25 hover:text-ink disabled:opacity-50"
            >
              {uploading ? <Loader2 size={22} className="animate-spin" /> : <ImagePlus size={22} />}
              <span>{t("botPanel.avatar.drop")}</span>
              <span className="text-[12px] text-ink-tertiary">{t("botPanel.avatar.types")}</span>
            </button>
            {bot.avatarUrl && (
              <div className="mt-2.5 flex items-center justify-center gap-2">
                {!showsImage && (
                  <button
                    type="button"
                    data-avatar-use-picture
                    disabled={busy}
                    onClick={() => onPatch({ avatarCrop: "circle" })}
                    className="rounded-lg bg-control px-3 py-1.5 text-[13px] text-ink hover:bg-raised-hover disabled:opacity-50"
                  >
                    {t("avatarEditor.usePicture")}
                  </button>
                )}
                <button
                  type="button"
                  data-avatar-remove
                  disabled={busy}
                  onClick={removeImage}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={13} aria-hidden="true" />
                  {t("botPanel.avatar.remove")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
