import { login, getUserMe } from "../lib/api.ts";
import { saveSession, type Session } from "../lib/store.ts";
import { prompt, promptHidden, promptChoice } from "../lib/prompt.ts";

export async function runLogin(_args: string[]): Promise<number> {
  const email = (await prompt("Email: ")).trim();
  if (!email) {
    console.error("Aborted: email is required.");
    return 1;
  }
  const password = await promptHidden("Password: ");
  if (!password) {
    console.error("Aborted: password is required.");
    return 1;
  }

  let result = await login({ username: email, password });
  if (result.type === "two_factor_required") {
    const code = (await prompt("2FA code: ")).trim();
    result = await login({ username: email, password, twoFaCode: code });
  }

  if (result.type !== "success") {
    if (result.type === "two_factor_required") {
      console.error("2FA code required but not provided.");
      return 1;
    }
    if (result.error === "invalid_credentials") {
      console.error("Invalid credentials.");
    } else if (result.error === "invalid_two_factor_code") {
      console.error("Invalid 2FA code.");
    } else {
      console.error(`Login failed (${result.status} ${result.error}).`);
      if (result.details) console.error(result.details);
    }
    return 1;
  }

  // Fetch user + orgs for the org picker.
  const me = await getUserMe(result.access_token);
  if (!me.ok) {
    console.error(`GET /user/me failed (${me.status}): ${me.bodyText.slice(0, 400)}`);
    return 1;
  }
  const { organizations, id, email: emailOut, firstName, lastName } = me.data;
  if (!organizations || organizations.length === 0) {
    console.error("No organizations returned for this account.");
    return 1;
  }

  const chosen = await promptChoice(
    `\nAvailable organizations (${organizations.length}):`,
    organizations,
    (o) => `${o.name}${o.vatNumber ? ` — ${o.vatNumber}` : ""} (${o.id})`,
  );

  const now = Date.now();
  const session: Session = {
    refresh_token: result.refresh_token,
    refresh_expires_at: now + result.refresh_token_expires_in * 1000,
    organization_id: chosen.id,
    user: { id, email: emailOut, firstName, lastName },
  };
  await saveSession(session);

  const expiresOn = new Date(session.refresh_expires_at).toISOString().slice(0, 10);
  console.log(`\nLogged in as ${firstName} ${lastName} <${emailOut}>.`);
  console.log(`Active org: ${chosen.name} (${chosen.id})`);
  console.log(`Session valid until ${expiresOn} (auto-renewed on each use).`);
  return 0;
}
