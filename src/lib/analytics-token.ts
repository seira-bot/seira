// A build sends analytics only when VITE_SEIRA_POSTHOG_TOKEN holds a PostHog project key at build time.
// The key is write-only and public, so it is safe to ship in the client.
export function analyticsToken(): string | undefined {
  const token = String(import.meta.env.VITE_SEIRA_POSTHOG_TOKEN ?? "").trim();
  return token || undefined;
}

export function analyticsAvailable(): boolean {
  return analyticsToken() !== undefined;
}
