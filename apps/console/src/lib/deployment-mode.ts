const FIXTURE_PREVIEW_FLAG = "LEARNINGBOT_FIXTURE_PREVIEW";
const FIXTURE_PREVIEW_ACKNOWLEDGEMENT =
  "LEARNINGBOT_FIXTURE_PREVIEW_ACKNOWLEDGEMENT";
const REQUIRED_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_THIS_USES_EPHEMERAL_FIXTURES";

/**
 * A deliberately narrow escape hatch for a private, non-production preview.
 *
 * This does not make fixture-backed APIs production-safe. Hosts enabling it
 * must also put the entire deployment behind platform-level access control.
 * Requiring two exact values makes accidental production enablement unlikely.
 */
export function fixturePreviewEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    environment[FIXTURE_PREVIEW_FLAG] === "enabled" &&
    environment[FIXTURE_PREVIEW_ACKNOWLEDGEMENT] === REQUIRED_ACKNOWLEDGEMENT
  );
}

export function developmentFixturesAllowed(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return (
    environment.NODE_ENV !== "production" || fixturePreviewEnabled(environment)
  );
}

export const fixturePreviewEnvironment = {
  flag: FIXTURE_PREVIEW_FLAG,
  acknowledgement: FIXTURE_PREVIEW_ACKNOWLEDGEMENT,
  requiredAcknowledgement: REQUIRED_ACKNOWLEDGEMENT,
} as const;
