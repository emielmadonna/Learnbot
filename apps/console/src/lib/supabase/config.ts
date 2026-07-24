export type SupabasePublicConfig = {
  url: string;
  publishableKey: string;
};

export class SupabaseConfigurationError extends Error {
  readonly code = "supabase.configuration_missing";

  constructor(message = "Supabase authentication is not configured.") {
    super(message);
    this.name = "SupabaseConfigurationError";
  }
}

type PublicEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
};

function isAllowedProjectUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost"))
    );
  } catch {
    return false;
  }
}

export function readSupabasePublicConfig(
  environment?: PublicEnvironment,
): SupabasePublicConfig {
  const resolvedEnvironment = environment ?? {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  };
  const url = resolvedEnvironment.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const publishableKey =
    resolvedEnvironment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";

  if (
    !url ||
    !isAllowedProjectUrl(url) ||
    !publishableKey.startsWith("sb_publishable_")
  ) {
    throw new SupabaseConfigurationError();
  }

  return { url, publishableKey };
}
