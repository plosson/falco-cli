import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, chmod, unlink } from "node:fs/promises";

export type Session = {
  refresh_token: string;
  refresh_expires_at: number;
  organization_id: string;
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
  };
};

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "falco-cli") : join(homedir(), ".config", "falco-cli");
}

export function sessionPath(): string {
  return join(configDir(), "session.json");
}

export async function loadSession(): Promise<Session | null> {
  const path = sessionPath();
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    const raw = await file.text();
    const parsed = JSON.parse(raw) as Session;
    if (
      typeof parsed.refresh_token === "string" &&
      typeof parsed.refresh_expires_at === "number" &&
      typeof parsed.organization_id === "string" &&
      parsed.user &&
      typeof parsed.user.email === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  const dir = configDir();
  const path = sessionPath();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await Bun.write(path, JSON.stringify(session, null, 2));
  await chmod(path, 0o600);
}

export async function clearSession(): Promise<void> {
  const path = sessionPath();
  try {
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
