import { forwardRef, memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { User } from "lucide-react";
import { cn } from "@/lib/cn";
import { avatarMarks, type AvatarKind } from "@/lib/avatar-marks";
import type { SeiraColor, SeiraMotion, MascotState } from "@/lib/mascot";
import { avatarCropRadius, botAvatarProfile, clampAvatarFocus, clampAvatarZoom, type BotAvatarCrop, type MascotFaceColor } from "../../shared/bot-avatar";
import { botBodyId, type BotBodyId } from "../../shared/bot-body";
import { mascotAccessories, type MascotAccessoryId } from "../../shared/mascot-accessories";
import { t } from "@/lib/i18n";
import type { PersonLook } from "../../shared/person-look";
import { CarvedAvatar, type CarvedAvatarHandle } from "./CarvedAvatar";

export type SeiraAvatarHandle = CarvedAvatarHandle;

export type SeiraAvatarProps = {
  color: SeiraColor;
  state?: MascotState;
  size?: number;
  label?: string;
  motion?: SeiraMotion;
  motionKey?: number;
  gaze?: { x?: number; y?: number };
  trackPointer?: boolean;
  animated?: boolean;
  bodyId?: BotBodyId;
  accessories?: readonly MascotAccessoryId[];
  /** Whose face this is; a decorative mascot has none. */
  kind?: AvatarKind;
};

function SeiraAvatarComponent({ bodyId, ...props }: SeiraAvatarProps, ref: React.Ref<SeiraAvatarHandle>) {
  return <CarvedAvatar ref={ref} body={botBodyId(bodyId)} {...props} />;
}

export const SeiraAvatar = memo(forwardRef(SeiraAvatarComponent));

export type BotAvatarProps = Omit<SeiraAvatarProps, "color"> & {
  bot: {
    name?: string;
    color: SeiraColor;
    avatarUrl?: string | null;
    avatarCrop?: BotAvatarCrop;
    avatarZoom?: number;
    avatarFocusX?: number;
    avatarFocusY?: number;
    mascotBody?: BotBodyId | null;
    mascotFaceColor?: MascotFaceColor | null;
    mascotAccessories?: MascotAccessoryId[] | null;
  };
};

export type BotAvatarOutcome = "flatImage" | "gradientMascot";

/** Mirrored name for name by resolveBotAvatarOutcome in ios/Sources/CompanionCore/BotAvatarRendering.swift. */
export function resolveBotAvatarOutcome(params: {
  avatarCrop: BotAvatarCrop;
  hasUrl: boolean;
  imageFailed: boolean;
}): BotAvatarOutcome {
  const { avatarCrop, hasUrl, imageFailed } = params;
  if (!hasUrl) return "gradientMascot";
  if (avatarCrop === "mascot") return "gradientMascot";
  if (imageFailed) return "gradientMascot";
  return "flatImage";
}

export function BotAvatar({ bot, size = 44, label, ...mascotProps }: BotAvatarProps) {
  const profile = botAvatarProfile(bot);
  const [imageFailed, setImageFailed] = useState(false);
  const worn = useMemo(() => mascotAccessories(bot.mascotAccessories), [bot.mascotAccessories]);

  useEffect(() => setImageFailed(false), [profile.avatarUrl]);

  const outcome = resolveBotAvatarOutcome({
    avatarCrop: profile.avatarCrop,
    hasUrl: Boolean(profile.avatarUrl),
    imageFailed,
  });

  if (outcome !== "flatImage") {
    return (
      <SeiraAvatar
        bodyId={bot.mascotBody ?? undefined}
        {...mascotProps}
        color={bot.color}
        accessories={worn}
        size={size}
        label={label ?? bot.name}
        kind="bot"
      />
    );
  }

  const radius = avatarCropRadius(profile.avatarCrop);
  const zoom = clampAvatarZoom(bot.avatarZoom ?? 1);
  const focusX = clampAvatarFocus(bot.avatarFocusX ?? 0.5);
  const focusY = clampAvatarFocus(bot.avatarFocusY ?? 0.5);
  const origin = `${focusX * 100}% ${focusY * 100}%`;
  return (
    <span
      {...avatarMarks("bot", "picture")}
      className="relative block shrink-0 overflow-hidden bg-raised"
      style={{ width: size, height: size, borderRadius: radius }}
    >
      <img
        src={profile.avatarUrl}
        alt={label ?? (bot.name ? t("avatar.alt", { name: bot.name }) : t("avatar.altFallback"))}
        width={size}
        height={size}
        draggable={false}
        onError={() => setImageFailed(true)}
        className="block size-full max-w-none object-cover"
        style={{
          width: size,
          height: size,
          objectPosition: origin,
          transform: zoom === 1 ? undefined : `scale(${zoom})`,
          transformOrigin: origin,
        }}
      />
    </span>
  );
}

export function InitialsAvatar({
  initials,
  avatarUrl,
  size = 32,
  fallback,
  fontSize,
  className,
}: {
  initials: string;
  avatarUrl?: string;
  size?: number;
  className?: string;
  /** drawn instead of the initials, for a person with no name or email to take them from */
  fallback?: ReactNode;
  fontSize?: number;
}) {
  // A picture that is gone (a restored backup carries the address, not the file) falls back to the initials.
  const [failed, setFailed] = useState<string | null>(null);
  if (avatarUrl && failed !== avatarUrl) {
    return <img {...avatarMarks("person", "picture")} src={avatarUrl} alt="" onError={() => setFailed(avatarUrl)} className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  }
  return (
    <div
      {...avatarMarks("person", "initials")}
      className={cn("flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary font-medium", className)}
      style={{ width: size, height: size, fontSize: fontSize ?? size * 0.38 }}
    >
      {fallback ?? initials}
    </div>
  );
}

/** The person's own face: their photo, else the look saved for them, else a plain person. Never initials or "?". */
export function PersonAvatar({ profile, size = 32, className }: {
  profile?: { avatarUrl?: string; look?: PersonLook };
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const url = profile?.avatarUrl;
  const look = profile?.look;
  if (url && failed !== url) {
    return <img {...avatarMarks("person", "picture")} src={url} alt="" onError={() => setFailed(url)} className={cn("shrink-0 rounded-full object-cover", className)} style={{ width: size, height: size }} />;
  }
  if (look) {
    return (
      <span className={cn("flex shrink-0 items-center justify-center rounded-full", className)} style={{ width: size, height: size }}>
        <SeiraAvatar kind="person" color={look.color} bodyId={look.mascotBody} accessories={look.mascotAccessories} state="happy" size={size} animated={false} />
      </span>
    );
  }
  return (
    <span {...avatarMarks("person", "initials")} aria-hidden="true" className={cn("flex shrink-0 items-center justify-center rounded-full bg-raised text-ink-secondary", className)} style={{ width: size, height: size }}>
      <User size={Math.round(size * 0.55)} aria-hidden="true" />
    </span>
  );
}
