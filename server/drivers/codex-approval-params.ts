import { effectiveApprovalPolicy, effectiveApprovalsReviewer } from "./codex-approval-config.ts";
import { containsControlCharacter, plainRecord } from "./codex-app-approval.ts";
import type { ApprovalMode } from "../../shared/approval-mode.ts";
import type { TurnFolders } from "../folder-access.ts";

export interface CodexApprovalParams {
  thread: Record<string, unknown>;
  turn: Record<string, unknown>;
  /** Legacy settings for an older app-server that rejects the named-profile field. */
  fallback?: Omit<CodexApprovalParams, "fallback">;
}

/** Codex persists these on its native thread, so they are explicit on start, resume and every turn.
 * Codex has no narrower "edits only" sandbox, so a stray Edits value asks. */
export function namedApprovalParams(mode: Exclude<ApprovalMode, "custom">, folders?: TurnFolders): CodexApprovalParams {
  if (mode === "full" && folders?.limited) {
    return {
      thread: { approvalPolicy: "never", approvalsReviewer: "user", sandbox: "workspace-write" },
      turn: { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", networkAccess: true } },
    };
  }
  if (mode === "full") {
    return {
      thread: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: "danger-full-access",
      },
      turn: {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
      },
    };
  }
  return {
    thread: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandbox: "workspace-write",
    },
    turn: {
      approvalPolicy: "on-request",
      approvalsReviewer: mode === "auto" ? "auto_review" : "user",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  };
}

export function withResolvedSandbox(params: CodexApprovalParams, session: unknown): CodexApprovalParams {
  const requested = plainRecord(params.turn.sandboxPolicy);
  if (!requested) return params;
  const sandbox = plainRecord(plainRecord(session)?.sandbox);
  if (!sandbox || typeof sandbox.type !== "string") {
    throw new Error("Codex did not return its resolved sandbox policy. Update Codex, then retry; the turn was not started because its permissions could not be verified.");
  }
  if (sandbox.type !== requested.type) {
    throw new Error("Codex did not apply the requested sandbox mode; cannot safely start the turn.");
  }
  return { ...params, turn: { ...params.turn, sandboxPolicy: sandbox } };
}

/** Each can-change grant joins the workspace-write roots of the turn. Full access already reaches every folder, and a
 * read-only grant is never a root: a turn's roots are the only writable place beyond the working folder. A limited
 * Full turn runs in workspace-write with network access and the working folder as a root. Codex 0.171.0 takes no
 * read-only subfolder in `sandboxPolicy`, so a read-only grant inside a root stays writable there. */
export function withFolderGrants(params: CodexApprovalParams, folders: TurnFolders | undefined, cwd?: string): CodexApprovalParams {
  const policy = plainRecord(params.turn.sandboxPolicy);
  if (!policy || policy.type !== "workspaceWrite" || !folders) return params;
  const limitedFull = folders.limited && params.turn.approvalPolicy === "never";
  const granted = [...(limitedFull && cwd ? [cwd] : []), ...folders.grants.filter((grant) => grant.write).map((grant) => grant.path)];
  if (granted.length === 0 && !limitedFull) return params;
  const roots = Array.isArray(policy.writableRoots) ? policy.writableRoots.filter((root): root is string => typeof root === "string") : [];
  return { ...params, turn: { ...params.turn, sandboxPolicy: { ...policy, ...(limitedFull ? { networkAccess: true } : {}), writableRoots: [...new Set([...roots, ...granted])] } } };
}

function legacyCustomApprovalParams(config: Record<string, unknown>): CodexApprovalParams {
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  const sandbox = config.sandbox_mode === "workspace-write" ||
    config.sandbox_mode === "danger-full-access" ||
    config.sandbox_mode === "read-only"
    ? config.sandbox_mode
    : "read-only";
  let sandboxPolicy: Record<string, unknown>;
  if (sandbox === "danger-full-access") sandboxPolicy = { type: "dangerFullAccess" };
  else if (sandbox === "read-only") sandboxPolicy = { type: "readOnly" };
  else {
    const workspace = config.sandbox_workspace_write && typeof config.sandbox_workspace_write === "object"
      ? config.sandbox_workspace_write as Record<string, unknown>
      : {};
    sandboxPolicy = {
      type: "workspaceWrite",
      ...(Array.isArray(workspace.writable_roots) ? { writableRoots: workspace.writable_roots } : {}),
      ...(typeof workspace.network_access === "boolean" ? { networkAccess: workspace.network_access } : {}),
      ...(typeof workspace.exclude_slash_tmp === "boolean" ? { excludeSlashTmp: workspace.exclude_slash_tmp } : {}),
      ...(typeof workspace.exclude_tmpdir_env_var === "boolean"
        ? { excludeTmpdirEnvVar: workspace.exclude_tmpdir_env_var }
        : {}),
    };
  }
  return {
    thread: { approvalPolicy, approvalsReviewer, sandbox },
    turn: { approvalPolicy, approvalsReviewer, sandboxPolicy },
  };
}

function configuredPermissionProfile(config: Record<string, unknown>): string | null {
  if (typeof config.default_permissions !== "string") return null;
  const profile = config.default_permissions.trim();
  if (!profile || profile.length > 240 || containsControlCharacter(profile)) return null;
  return profile;
}

export function customApprovalParams(raw: unknown): CodexApprovalParams {
  const config = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const fallback = legacyCustomApprovalParams(config);
  const permissions = configuredPermissionProfile(config);
  const approvalPolicy = effectiveApprovalPolicy(config.approval_policy);
  const approvalsReviewer = effectiveApprovalsReviewer(config.approvals_reviewer);
  // Codex 0.151 profiles define the sandbox but not the approval policy: reassert both approval
  // fields so a resumed Full thread cannot keep `never`.
  return permissions
    ? {
        thread: { permissions, approvalPolicy, approvalsReviewer },
        turn: { permissions, approvalPolicy, approvalsReviewer },
        fallback,
      }
    : fallback;
}

export function permissionProfileUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:experimental api|invalid params|unknown field|unknown.*permissions|permissions.*(?:unsupported|sandbox)|cannot.*permissions)/i.test(message);
}
