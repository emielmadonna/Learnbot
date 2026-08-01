import type { Metadata } from "next";
import { headers } from "next/headers";

import { CorsoMark } from "../../../components/corso/corso-mark";
import {
  createWidgetSupabaseClient,
  isWidgetKey,
  widgetAssetUrl,
  widgetBootstrap,
  type WidgetBootstrapResult,
} from "../../../lib/supabase/widget-rpc";
import { HostedAssistant } from "./hosted-assistant";
import {
  HostedAssistantResolutionError,
  normalizeHostedSlug,
  resolveHostedAssistant,
} from "./hosted-rpc";
import styles from "./hosted.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Course assistant",
  description: "Ask a grounded question about the course.",
  robots: {
    index: false,
    follow: false,
  },
};

type HostedPageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ key?: string | string[] }>;
};

function firstHeaderValue(value: string | null) {
  return value?.split(",", 1)[0]?.trim() ?? "";
}

function configuredPublicOrigin() {
  const candidate = [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
  ]
    .map((value) => value?.trim() ?? "")
    .find(Boolean);
  if (!candidate) return null;

  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      )
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

async function hostedPageOrigin() {
  const requestHeaders = await headers();
  const host =
    firstHeaderValue(requestHeaders.get("x-forwarded-host")) ||
    firstHeaderValue(requestHeaders.get("host"));
  if (!host || /[\s/\\]/u.test(host)) return configuredPublicOrigin();

  const forwardedProtocol = firstHeaderValue(
    requestHeaders.get("x-forwarded-proto"),
  );
  const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/u.test(host);
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : localHost
        ? "http"
        : "https";

  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return configuredPublicOrigin();
  }
}

function requestedWidgetKey(value: string | string[] | undefined) {
  return Array.isArray(value) ? (value[0]?.trim() ?? "") : (value?.trim() ?? "");
}

function publicBootstrap(bootstrap: WidgetBootstrapResult) {
  return {
    widget: {
      anonymousQuestions: bootstrap.widget.anonymousQuestions,
      courses: bootstrap.widget.courses,
      greeting: bootstrap.widget.greeting,
      launcherShape: bootstrap.widget.launcherShape,
      greetingBubbleEnabled: bootstrap.widget.greetingBubbleEnabled,
      greetingBubbleDelaySeconds:
        bootstrap.widget.greetingBubbleDelaySeconds,
      showPoweredBy: bootstrap.widget.showPoweredBy,
      appearanceMode: bootstrap.widget.appearanceMode,
    },
    branding: {
      assistantName: bootstrap.branding.assistantName,
      primaryColor: bootstrap.branding.primaryColor,
      accentColor: bootstrap.branding.accentColor,
      surfaceColor: bootstrap.branding.surfaceColor,
      textColor: bootstrap.branding.textColor,
      fontFamily: bootstrap.branding.fontFamily,
      welcomeCopy: bootstrap.branding.welcomeCopy,
      logoUrl: widgetAssetUrl(bootstrap.branding.logoObjectPath),
      avatarUrl: widgetAssetUrl(bootstrap.branding.avatarObjectPath),
      privacyUrl: bootstrap.branding.privacyUrl,
      termsUrl: bootstrap.branding.termsUrl,
      supportUrl: bootstrap.branding.supportUrl,
    },
  };
}

export default async function HostedAssistantPage({
  params,
  searchParams,
}: HostedPageProps) {
  const [{ slug }, query, origin] = await Promise.all([
    params,
    searchParams,
    hostedPageOrigin(),
  ]);
  const legacyWidgetKey = requestedWidgetKey(query.key);
  const operationToken =
    process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim() ?? "";
  const normalizedSlug = normalizeHostedSlug(slug);

  if (origin === null) {
    return <UnavailableAssistant slug={slug} />;
  }

  let legacyFallbackAllowed = normalizedSlug === null;
  if (normalizedSlug !== null) {
    try {
      const resolution = await resolveHostedAssistant(
        createWidgetSupabaseClient(),
        {
          slug: normalizedSlug,
          origin,
          operationToken,
        },
      );
      return (
        <HostedAssistant
          askEndpoint={`/c/${encodeURIComponent(normalizedSlug)}/ask`}
          bootstrap={publicBootstrap(resolution.bootstrap)}
          friendlySlug={normalizedSlug}
          legacyWidgetKey={null}
        />
      );
    } catch (error) {
      // A reserved slug is authoritative even while unpublished, renamed,
      // revoked or origin-refused. Never let a legacy key bypass that state.
      if (
        !(error instanceof HostedAssistantResolutionError) ||
        error.slugReserved !== false
      ) {
        return <UnavailableAssistant slug={slug} />;
      }
      legacyFallbackAllowed = true;
    }
  }

  if (
    legacyFallbackAllowed &&
    isWidgetKey(legacyWidgetKey) &&
    operationToken.length >= 32
  ) {
    try {
      const bootstrap = await widgetBootstrap(createWidgetSupabaseClient(), {
        widgetKey: legacyWidgetKey,
        origin,
      });
      return (
        <HostedAssistant
          askEndpoint="/api/widget/ask"
          bootstrap={publicBootstrap(bootstrap)}
          friendlySlug={normalizedSlug ?? slug}
          legacyWidgetKey={legacyWidgetKey}
        />
      );
    } catch {
      // Fall through to the same opaque page as every other refusal.
    }
  }

  // Unknown slug, revoked publication/key, disabled assistant, disallowed
  // origin, missing server answer capability and database unavailability are
  // deliberately indistinguishable to a public caller.
  return <UnavailableAssistant slug={slug} />;
}

function UnavailableAssistant({ slug }: { slug: string }) {
  return (
    <main className={styles.unavailable} data-ground="light">
      <div className={styles.unavailableCard}>
        <span className={styles.unavailableMark} aria-hidden="true">
          <CorsoMark size={25} />
        </span>
        <h1>This assistant isn&apos;t available here.</h1>
        <p>
          The public link may be incomplete, disabled, or not approved for this
          website. Ask the course owner for a current link.
        </p>
        <small>
          Public link label: <span>/c/{slug || "course"}</span>
        </small>
      </div>
    </main>
  );
}
