import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Everything the suite reads from the environment, in one place, with the
 * rule that a missing value makes a test SKIP with a reason and never makes it
 * pass vacuously or invent a default that points at a real tenant.
 *
 *   E2E_BASE_URL             console origin under test (default local dev)
 *   E2E_BROWSER_CHANNEL      chrome (default) | chromium | msedge
 *   E2E_WIDGET_KEY           a wk_ key whose allow-list contains E2E_BASE_URL's
 *                            origin — the embed and ask-contract tests need it
 *   E2E_HOSTED_SLUG          a published hosted-assistant slug (/c/<slug>)
 *   E2E_<PERSONA>_EMAIL /    sign-in credentials for learner, teacher, admin;
 *   E2E_<PERSONA>_PASSWORD   a persona with neither is skipped
 *   E2E_TEACHER_TENANT       optional tenant name to pick on the selection page
 *   E2E_ALLOW_MUTATIONS      "1" lets teacher/admin journeys create and change
 *                            things (courses, widget settings, tenants). Off by
 *                            default so a run against production reads only.
 *   E2E_ALLOW_RATE_LIMIT_PROBE  "1" lets the ask-contract test hammer the key
 *                            until it is rate limited (locks that tenant's real
 *                            visitors out for up to a minute — never on prod)
 */
export type Persona = "learner" | "teacher" | "admin";

function read(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const authDirectory = resolve(__dirname, "../../.auth");

export const env = {
  ci: Boolean(read("CI")),
  baseUrl: read("E2E_BASE_URL") ?? "http://127.0.0.1:3000",
  browserChannel: read("E2E_BROWSER_CHANNEL") ?? "chrome",
  widgetKey: read("E2E_WIDGET_KEY"),
  hostedSlug: read("E2E_HOSTED_SLUG"),
  allowMutations: read("E2E_ALLOW_MUTATIONS") === "1",
  allowRateLimitProbe: read("E2E_ALLOW_RATE_LIMIT_PROBE") === "1",
  teacherTenant: read("E2E_TEACHER_TENANT"),

  credentials(persona: Persona): { email: string; password: string } | null {
    const prefix = `E2E_${persona.toUpperCase()}`;
    const email = read(`${prefix}_EMAIL`);
    const password = read(`${prefix}_PASSWORD`);
    return email && password ? { email, password } : null;
  },

  storageStatePath(persona: Persona): string {
    return resolve(authDirectory, `${persona}.json`);
  },

  /** True when the setup project signed this persona in during this run. */
  personaReady(persona: Persona): boolean {
    const marker = resolve(authDirectory, `${persona}.ready`);
    return existsSync(marker);
  },

  markPersona(persona: Persona, ready: boolean): void {
    mkdirSync(authDirectory, { recursive: true });
    const marker = resolve(authDirectory, `${persona}.ready`);
    if (ready) writeFileSync(marker, new Date().toISOString());
    else if (existsSync(marker)) writeFileSync(marker, "");
    if (!ready && !existsSync(env.storageStatePath(persona))) {
      // Playwright refuses to start a project whose storageState file is
      // missing, so an absent persona gets an empty, valid state and its
      // tests skip on the marker instead.
      writeFileSync(
        env.storageStatePath(persona),
        JSON.stringify({ cookies: [], origins: [] }),
      );
    }
  },

  /**
   * Playwright loads a project's storageState when a test's context opens,
   * and a missing file is a hard error. Make every persona's file exist —
   * empty, which signs nobody in — before any project starts, so running one
   * persona project on its own is a clean skip rather than a crash.
   */
  ensureStorageStates(): void {
    mkdirSync(authDirectory, { recursive: true });
    for (const persona of ["learner", "teacher", "admin"] as const) {
      const path = env.storageStatePath(persona);
      if (!existsSync(path)) writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    }
  },

  get origin(): string {
    return new URL(env.baseUrl).origin;
  },
};

/** The refusal every public widget endpoint returns, byte for byte. */
export const OPAQUE_REFUSAL = { ok: false, code: "widget_unavailable" } as const;

/** A syntactically valid widget key that no tenant will ever own. */
export const BOGUS_WIDGET_KEY = `wk_${"0".repeat(40)}`;

/** A conversation reference in the shape the prelude generates. */
export function conversationRef(): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** `e2e-<stamp>` names so anything a journey creates is findable and disposable. */
export function disposableName(kind: string): string {
  return `e2e-${kind}-${Date.now().toString(36)}`;
}
