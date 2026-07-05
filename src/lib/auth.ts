import { refresh, type RefreshResult } from "./api.ts";
import { loadSession, saveSession, type Session } from "./store.ts";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

// Minimum remaining lifetime on the access token before we refresh proactively.
const ACCESS_LEEWAY_MS = 30_000;

// In-memory cache for the current process: we fetch an access token once per run
// (or per explicit expiry) and reuse it across the command's API calls.
type CachedAccess = { token: string; expires_at: number };
let cached: CachedAccess | null = null;

function applyRefresh(session: Session, r: Extract<RefreshResult, { type: "success" }>): Session {
  const now = Date.now();
  return {
    ...session,
    refresh_token: r.refresh_token,
    refresh_expires_at: now + r.refresh_token_expires_in * 1000,
  };
}

/**
 * Load the session, refresh the access token if needed, persist any refresh-token
 * rotation to disk, and return `{session, accessToken}`.
 * Throws AuthError if no session exists or refresh fails.
 */
export async function ensureAccessToken(): Promise<{ session: Session; accessToken: string }> {
  const session = await loadSession();
  if (!session) {
    throw new AuthError("Not logged in. Run `falco login` first.");
  }
  if (Date.now() >= session.refresh_expires_at) {
    throw new AuthError(
      "Refresh token expired. Run `falco login` again.",
    );
  }
  if (cached && cached.expires_at - ACCESS_LEEWAY_MS > Date.now()) {
    return { session, accessToken: cached.token };
  }

  const r = await refresh(session.refresh_token);
  if (r.type !== "success") {
    throw new AuthError(
      `Refresh failed (HTTP ${r.status}): ${r.details ?? "unknown error"}. ` +
        `Try \`falco login\` again.`,
    );
  }
  const next = applyRefresh(session, r);
  await saveSession(next);
  cached = { token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 };
  return { session: next, accessToken: r.access_token };
}

export function resetAccessTokenCache(): void {
  cached = null;
}
