import { useEffect, useState } from "react";
import { useStore } from "@/state/store";
import { useOwnerOrAdmin } from "./use-owner-or-admin";
import { readMembership } from "./membership";
import { teamOfConfig } from "@/state/team-chats";

export interface InviteEnvironment {
  emailSignIn: boolean;
  cloudTeam: boolean;
}

let environment: Promise<InviteEnvironment | null> | null = null;

/** Read once per page load; null while the server does not answer. */
export function readInviteEnvironment(): Promise<InviteEnvironment | null> {
  environment ??= fetch("/.well-known/seira/environment")
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { capabilities?: { emailSignIn?: unknown; cloudTeam?: unknown } } | null) => body && typeof body === "object"
      ? { emailSignIn: body.capabilities?.emailSignIn === true, cloudTeam: body.capabilities?.cloudTeam === true }
      : null)
    .catch(() => null);
  return environment;
}

export function mayInviteHere(input: { admin: boolean | null; desktop: boolean; config: unknown; environment: InviteEnvironment | null }): boolean {
  const config = (input.config ?? null) as { cloudHome?: unknown } | null;
  return input.admin === true
    && !input.desktop
    && config !== null
    && config.cloudHome !== true
    && teamOfConfig(config) === null
    && readMembership(config).authority === "local"
    && input.environment !== null
    && !input.environment.cloudTeam
    && input.environment.emailSignIn;
}

/** True only for an owner or admin on a self-hosted server that signs people in by email. Unknown is false. */
export function useMayInvite(): boolean {
  const admin = useOwnerOrAdmin();
  const { state } = useStore();
  const [env, setEnv] = useState<InviteEnvironment | null>(null);
  useEffect(() => {
    let alive = true;
    void readInviteEnvironment().then((found) => { if (alive) setEnv(found); });
    return () => { alive = false; };
  }, []);
  return mayInviteHere({ admin, desktop: typeof window !== "undefined" && Boolean(window.ogb), config: state.config, environment: env });
}
