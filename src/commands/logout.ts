import { loadSession, clearSession } from "../lib/store.ts";
import { revoke } from "../lib/api.ts";

export async function runLogout(_args: string[]): Promise<number> {
  const session = await loadSession();
  if (!session) {
    console.log("Not logged in; nothing to do.");
    return 0;
  }
  await revoke(session.refresh_token);
  await clearSession();
  console.log("Logged out.");
  return 0;
}
