import {
  createWidgetSupabaseClient,
  isWidgetKey,
  widgetAssetUrl,
  widgetBootstrap,
} from "../../../../lib/supabase/widget-rpc";
import { preflightResponse, requestOrigin, widgetJson, widgetRefusal } from "../cors";

/**
 * GET /api/widget/config?key=wk_...
 *
 * The anonymous bootstrap for an embedded widget. See ../cors.ts for why this
 * route does not use `assertSameOrigin`.
 *
 * The response is exactly what the Shadow-DOM runtime needs to paint itself:
 * branding tokens, launcher configuration, greeting and an empty conversation.
 * It deliberately contains no tenant id, no course id and no persona, and it
 * never returns stored messages — a widget conversation is not resumable, so a
 * guessed conversation reference is not a read capability.
 */
export const dynamic = "force-dynamic";

export function OPTIONS(request: Request) {
  return preflightResponse(request, "GET");
}

export async function GET(request: Request) {
  const origin = requestOrigin(request);
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  // A browser always sends Origin cross-origin. No origin means this is not the
  // embedded context the widget key is authorised for.
  if (origin === null || !isWidgetKey(key)) return widgetRefusal();

  try {
    const supabase = createWidgetSupabaseClient();
    const bootstrap = await widgetBootstrap(supabase, {
      widgetKey: key,
      origin,
    });
    const branding = bootstrap.branding;
    return widgetJson(
      {
        ok: true,
        widget: {
          presentation: bootstrap.widget.presentation,
          anonymousQuestions: bootstrap.widget.anonymousQuestions,
          courses: bootstrap.widget.courses,
        },
        branding: {
          assistantName: branding.assistantName,
          primaryColor: branding.primaryColor,
          accentColor: branding.accentColor,
          surfaceColor: branding.surfaceColor,
          textColor: branding.textColor,
          fontFamily: branding.fontFamily,
          welcomeCopy: branding.welcomeCopy,
          launcherLabel: branding.launcherLabel,
          launcherPosition: branding.launcherPosition,
          launcherShape: bootstrap.widget.launcherShape,
          greetingBubbleEnabled:
            bootstrap.widget.greetingBubbleEnabled,
          greetingBubbleDelaySeconds:
            bootstrap.widget.greetingBubbleDelaySeconds,
          showPoweredBy: bootstrap.widget.showPoweredBy,
          appearanceMode: bootstrap.widget.appearanceMode,
          voiceEnabled: branding.voiceEnabled,
          // Brand assets live in the public `widget-public` bucket under the
          // widget key, so the URL discloses no tenant identifier and needs no
          // session to fetch. A tenant that has uploaded nothing gets null and
          // the runtime falls back to its icon glyph.
          logoUrl: widgetAssetUrl(branding.logoObjectPath),
          avatarUrl: widgetAssetUrl(branding.avatarObjectPath),
          privacyUrl: branding.privacyUrl,
          termsUrl: branding.termsUrl,
          supportUrl: branding.supportUrl,
        },
      },
      origin,
    );
  } catch {
    // Every failure — unknown key, revoked key, disallowed origin, disabled
    // widget, database unavailable — is the same opaque refusal, so this
    // endpoint is not an oracle for which widget keys exist.
    return widgetRefusal();
  }
}
