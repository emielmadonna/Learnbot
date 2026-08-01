import { after } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  answerGroundedLearningQuestion,
  groundedAnswerRequest,
  LearningProviderError,
  type GroundingSource,
} from "../../../../lib/learning-provider";
import {
  ANSWER_ADAPTER_ID,
  completeWithManagedWidgetProvider,
  resolveAgentDirective,
  streamWithManagedWidgetProvider,
} from "../../../../lib/provider-runtime";
import {
  CLASSIFIER_ADAPTER_ID,
  classifyLearnerQuestionOutcome,
} from "../../../../lib/question-classification";
import {
  createWidgetSupabaseClient,
  isConversationRef,
  isCourseRef,
  isVisitorRef,
  isWidgetKey,
  widgetAsk,
  type WidgetAskMatch,
  WidgetRpcError,
  widgetRecordAnswer,
  widgetRecordQuestionLabel,
  widgetRecordVisualDisclosure,
} from "../../../../lib/supabase/widget-rpc";
import { VISUAL_MEDIA_EXTENSIONS } from "../../../../lib/visuals/secure-media";
import {
  allowedOriginHeaders,
  preflightResponse,
  requestOrigin,
  widgetJson,
  widgetRefusal,
} from "../cors";

/**
 * POST /api/widget/ask
 *
 * One anonymous, grounded turn. See ../cors.ts for why this route does not use
 * `assertSameOrigin`.
 *
 * Order of operations, and why:
 *   1. `widget_ask` re-checks the (key, origin) pair, applies the SQL rate
 *      limits and durably records the visitor's question BEFORE any model call.
 *      A refused request therefore costs nothing and writes nothing.
 *   2. The persona is read back only because this process holds the server-side
 *      conversation operation token. It shapes the answer and is never returned
 *      to the page.
 *   3. `widget_record_answer` stores the assistant turn, gated by that same
 *      token, so a browser cannot forge one. It returns that turn's durable
 *      message id, which is the only id `/api/widget/feedback` accepts and
 *      therefore the only thing the page can honestly rate.
 *   4. Classification is scheduled in `after()`, so it runs once the visitor
 *      already has their answer and can never delay or fail the turn.
 *
 * STREAMING is opt-in on `Accept: text/event-stream`, and is the branch both
 * customer-facing surfaces take: the embedded widget (app/widget.js
 * embed-prelude) and the hosted full-page assistant, which forwards here
 * (c/[slug]/ask/route.ts). A default `Accept` still gets byte-for-byte the JSON
 * response below, which is what keeps `/api/widget/config` consumers, older
 * embeds and any server-to-server caller working unchanged.
 *
 * The SSE contract is the authenticated path's, deliberately not a second one
 * (`buildStreamingResponse` in api/learning/respond/route.ts, pinned by
 * test/streaming-respond-contract.test.ts): a `sources` event FIRST so citation
 * chips resolve while the answer is still arriving, then `delta` events, then a
 * terminal `done`. A stream that ends without `done` is a failed turn -- the
 * visitor is told, and nothing is recorded.
 *
 * Two widget-specific additions to that contract, both forced by what this
 * surface already promises:
 *
 *   - the `sources` event also carries `parts`, because the visual URLs are
 *     handed out there and the disclosure that authorises reading them must be
 *     recorded FIRST (20260731060000); and
 *   - `done` carries `messageId`, the durable id `/api/widget/feedback`
 *     accepts. That means `widget_record_answer` runs inside the stream rather
 *     than in `after()`: a streamed answer with no ratable id would silently
 *     remove the rating control from every streamed turn.
 */
export const dynamic = "force-dynamic";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * At most two visuals per answer, matching the authenticated route's
 * `selectedVisualAssetIds` (api/learning/respond/route.ts). The cap is a
 * product decision, not a technical one: an answer that pastes six diagrams
 * reads as a dump rather than an explanation. It also bounds the disclosure
 * write, which the database caps independently at twelve.
 */
const MAX_ANSWER_VISUALS = 2;

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

type CitedVisual = {
  visualAssetId: string;
  title: string;
  altText: string;
  mediaType: string;
  /** Absolute, because this URL is resolved on the customer's page, not ours. */
  url: string;
};

/**
 * The visuals this answer is allowed to show, in retrieval order.
 *
 * `widget_ask` attaches `visualAssetId` / `mediaType` / `altText` to a match
 * only when the underlying asset is still published, active, answerable and
 * validated (20260731070000, and `app_private.visual_source_for_match` before
 * it), so absence here means "not a visual, or no longer showable" and both
 * cases correctly produce no part. Everything the database asserted is still
 * re-checked: an id that is not a UUID and a media type outside the validated
 * allowlist are dropped rather than turned into a URL.
 */
function citedVisuals(
  matches: readonly WidgetAskMatch[],
  requestUrl: string,
  widgetKey: string,
  conversationRef: string,
): CitedVisual[] {
  const selected: CitedVisual[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    if (selected.length >= MAX_ANSWER_VISUALS) break;
    const visualAssetId = match.visualAssetId ?? "";
    const mediaType = match.mediaType ?? "";
    const altText = (match.altText ?? "").trim();
    if (
      !isUuid(visualAssetId) ||
      seen.has(visualAssetId) ||
      !VISUAL_MEDIA_EXTENSIONS.has(mediaType) ||
      altText.length === 0
    ) {
      continue;
    }
    seen.add(visualAssetId);
    // Query-string credentials, because this URL goes in an `<img src>` and
    // those cannot carry headers. See the header of
    // api/widget/visuals/[visualAssetId]/content/route.ts for why that is the
    // safe trade here and what actually authorises the read.
    const url = new URL(
      `/api/widget/visuals/${visualAssetId}/content`,
      requestUrl,
    );
    url.searchParams.set("key", widgetKey);
    url.searchParams.set("conversationRef", conversationRef);
    selected.push({
      visualAssetId,
      title: (match.lessonTitle ?? match.documentTitle ?? "").trim() || altText,
      altText,
      mediaType,
      url: url.toString(),
    });
  }
  return selected;
}

/**
 * The `parts` the widget runtime already knows how to render: `diagram` for a
 * still image, `video` for MP4 (packages/widget-runtime `#renderPart`). The
 * runtime skips any kind an older build does not recognise, and a server that
 * sends no `parts` at all still produces exactly today's text-plus-sources
 * answer, so this is additive in both directions.
 */
function visualParts(visuals: readonly CitedVisual[]) {
  return visuals.map((visual) =>
    visual.mediaType === "video/mp4"
      ? {
          kind: "video" as const,
          id: visual.visualAssetId,
          title: visual.title,
          url: visual.url,
        }
      : {
          kind: "diagram" as const,
          id: visual.visualAssetId,
          caption: visual.altText,
          url: visual.url,
          // The tenant already approved this asset for answers: the database
          // will not surface an id whose `show_in_answers` is off or whose
          // media inspection never completed.
          approved: true,
        },
  );
}

/**
 * Classify one widget question and label it.
 *
 * The anonymous twin of `labelRecordedQuestion` in
 * api/learning/respond/route.ts, and deliberately identical in discipline:
 * every failure names a reason code in the server log, and a fault writes NO
 * label rather than an approximate one.
 *
 * Why this could not simply be a call added to the existing route body:
 * `learning_record_question_label` opens with
 * `app_private.learning_rpc_context()` and so needs a Supabase session, which
 * an anonymous visitor does not have. `widget_record_question_label`
 * (20260731080000) is the server-authorised equivalent — same operation token
 * as the answer write, and the question is named by the turn's idempotency key
 * because the widget path never learns a message id.
 *
 * The classification itself runs through the same Edge Function the answer
 * did, so a widget question costs TWO provider calls: the answer, and this
 * cheap-tier classifier.
 *
 * BOTH are metered, but not from here. `runMeteredCompletion` cannot be used
 * on this route for a reason worth stating precisely, because it was once
 * described wrongly: it is not that the reservation RPCs are session-scoped —
 * `learning_reserve_provider_call` and `learning_record_provider_cost` both
 * accept `target_tenant_id` + `operation_token` and are granted to `anon`
 * exactly for this surface. It is that THIS ROUTE NEVER LEARNS THE TENANT ID,
 * deliberately, so it cannot supply one.
 *
 * `learning-provider-widget-complete` can and does: it resolves the tenant
 * from the widget key, holds the operation token, and is the single seam both
 * calls pass through. Metering lives there — one place, both calls, no extra
 * provider round trips, and the tenant id never moves outward.
 *
 * Only reason codes and the trace id are logged — never the question, the
 * answer, the visitor, or the tenant.
 */
async function labelWidgetQuestion(
  supabase: SupabaseClient,
  input: {
    readonly widgetKey: string;
    readonly origin: string;
    readonly conversationRef: string;
    readonly questionIdempotencyKey: string;
    readonly requestId: string;
    readonly traceId: string;
    readonly question: string;
    readonly answer: string;
    readonly operationToken: string;
  },
): Promise<void> {
  const outcome = await classifyLearnerQuestionOutcome({
    // Deliberately empty, for the same reason the answer call leaves it empty:
    // the widget path never learns the tenant id and the provider context must
    // not become the one place it leaks.
    tenantId: "",
    actorId: "widget-anonymous",
    requestId: input.requestId,
    traceId: input.traceId,
    idempotencyKey: input.questionIdempotencyKey,
    question: input.question,
    answer: input.answer,
    scopeLabel: null,
    completion: (context, providerRequest) =>
      completeWithManagedWidgetProvider({
        supabase,
        context,
        request: providerRequest,
        adapterId: CLASSIFIER_ADAPTER_ID,
        widgetKey: input.widgetKey,
        origin: input.origin,
        operationToken: input.operationToken,
        actorRef: input.conversationRef,
      }),
  });
  if (!outcome.ok) {
    console.warn(
      `[widget-question-classifier] no label recorded: reason=${outcome.reason}` +
        (outcome.detail === null ? "" : ` detail=${outcome.detail}`) +
        ` trace=${input.traceId}`,
    );
    return;
  }
  const recorded = await widgetRecordQuestionLabel(supabase, {
    widgetKey: input.widgetKey,
    origin: input.origin,
    conversationRef: input.conversationRef,
    questionIdempotencyKey: input.questionIdempotencyKey,
    topicKey: outcome.classification.topicKey,
    topicLabel: outcome.classification.topicLabel,
    intent: outcome.classification.intent,
    importance: outcome.classification.importance,
    classifierKey: outcome.classification.classifierKey,
    classifierVersion: outcome.classification.classifierVersion,
    traceId: input.traceId,
    operationToken: input.operationToken,
  });
  if (!recorded.ok) {
    console.warn(
      `[widget-question-classifier] label rejected by the database: ` +
        `code=${recorded.code ?? "unknown"} trace=${input.traceId}`,
    );
  }
}

/**
 * Streaming is opt-in, exactly as on the authenticated path (`wantsEventStream`
 * in api/learning/respond/route.ts). A caller that does not ask for it gets the
 * JSON body this route has always returned.
 */
function wantsEventStream(request: Request) {
  const accept = request.headers.get("accept") ?? "";
  return accept
    .split(",")
    .some((part) => part.trim().toLowerCase().startsWith("text/event-stream"));
}

function sseBytes(event: string, data: unknown) {
  return new TextEncoder().encode(
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
  );
}

/**
 * The same headers the authenticated stream uses, plus the CORS headers every
 * other response on this route carries. An SSE response that omitted them
 * would be blocked by the browser on the customer's page, which is the only
 * place this endpoint is ever read from.
 */
function widgetStreamHeaders(origin: string) {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "private, no-store",
    Connection: "keep-alive",
    // Some intermediary proxies buffer text/event-stream unless told not to,
    // which would reassemble the answer and defeat the whole change.
    "X-Accel-Buffering": "no",
    ...allowedOriginHeaders(origin),
  };
}

type WidgetStreamOutcome =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false };

/**
 * One streamed widget turn.
 *
 * Everything that happened after the answer on the JSON path still happens
 * here, in the same order and for the same reasons: the visual disclosure is
 * recorded before any media URL reaches the page, the assistant turn is
 * durably recorded before `done` (so the answer stays ratable), and
 * classification is scheduled in `after()` so it can never delay the visitor.
 *
 * What is deliberately NOT here is any second copy of the prompt: the request
 * comes from `groundedAnswerRequest`, the same builder the buffered path uses.
 */
function buildStreamingWidgetResponse(params: {
  request: Request;
  supabase: SupabaseClient;
  widgetKey: string;
  origin: string;
  conversationRef: string;
  turnId: string;
  traceId: string;
  operationToken: string;
  question: string;
  assistantName: string;
  directive: unknown;
  retrievalMode: string;
  sources: readonly GroundingSource[];
  evidence: readonly Record<string, unknown>[];
  visuals: readonly CitedVisual[];
}) {
  let resolveOutcome!: (outcome: WidgetStreamOutcome) => void;
  const outcome = new Promise<WidgetStreamOutcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const idempotencyKey = `widget-turn:${params.turnId}`;
  // Bound locally so every write below names the same client the buffered
  // path names, and reads as one seam rather than two.
  const supabase = params.supabase;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // The disclosure is what authorises the visitor to read these bytes at
        // all (20260731060000): without a row, /api/widget/visuals/:id/content
        // answers `visual_not_found` even for the visitor the assistant just
        // showed it to. So it is recorded BEFORE the URLs are handed out, and
        // if it fails the answer degrades to text rather than shipping URLs
        // that would render as broken images.
        let disclosed: readonly CitedVisual[] = params.visuals;
        if (params.visuals.length > 0) {
          try {
            await widgetRecordVisualDisclosure(supabase, {
              widgetKey: params.widgetKey,
              origin: params.origin,
              conversationRef: params.conversationRef,
              visualAssetIds: params.visuals.map(
                (visual) => visual.visualAssetId,
              ),
              operationToken: params.operationToken,
            });
          } catch {
            disclosed = [];
          }
        }

        // Sources resolve before generation and are sent first, so citation
        // chips and grounded visuals render while the answer is still arriving.
        controller.enqueue(
          sseBytes("sources", {
            conversationRef: params.conversationRef,
            sources: params.evidence,
            parts: visualParts(disclosed),
            retrievalMode: params.retrievalMode,
          }),
        );

        /*
         * The tenant's own directive, resolved once for this stream and never
         * a module constant. On the authenticated path a hardcoded refusal
         * meant a creator could set one in the console, watch it work in
         * Preview, and never have it reach a learner; this path must not
         * reintroduce that.
         *
         * NOTE (measured, not assumed): `widget_ask` currently projects only
         * `personaInstructions` and `tone` into `directive`
         * (20260731070000_widget_answer_visual_parts.sql), so
         * `noResultsMessage` and `model` still fall back to the platform
         * defaults here -- identically to the buffered path above, which
         * resolves the same directive inside
         * `answerGroundedLearningQuestion`. Widening that projection is a
         * database change, not a change here, and the moment it lands both
         * paths pick the tenant's wording up with no further edit.
         */
        const streamDirective = resolveAgentDirective(params.directive);

        let text = "";
        let provider = "grounding-boundary";
        let adapterId = "no-source-safe-answer";
        let providerRequestRef = params.turnId;
        let terminal: "done" | "error" | "none" = "none";
        let errorPayload: { code: string; retryable: boolean } | null = null;

        if (params.sources.length === 0) {
          // The grounding boundary. No provider is called, so there is nothing
          // to stream token by token -- but the refusal still travels as a
          // delta so the client has exactly one code path for an answer.
          text = streamDirective.noResultsMessage;
          controller.enqueue(sseBytes("delta", { text }));
          terminal = "done";
        } else {
          for await (const event of streamWithManagedWidgetProvider({
            supabase,
            context: {
              // Deliberately empty, as everywhere else on this route: the
              // widget path never learns the tenant id, and the provider
              // context must not become the one place it leaks. The Edge
              // Function resolves it from the widget key and meters there.
              tenantId: "",
              actorId: "widget-anonymous",
              requestId: params.turnId,
              traceId: params.traceId,
              idempotencyKey: params.turnId,
              fundingSource: "platform",
              deadlineMs: Date.now() + 30_000,
            },
            request: groundedAnswerRequest({
              assistantName: params.assistantName,
              question: params.question,
              intent: "explain",
              scopeLabel: null,
              personaInstructions: streamDirective.personaInstructions,
              tone: streamDirective.tone,
              history: [],
              sources: params.sources,
              model: streamDirective.model,
            }),
            adapterId: ANSWER_ADAPTER_ID,
            widgetKey: params.widgetKey,
            origin: params.origin,
            operationToken: params.operationToken,
            actorRef: params.conversationRef,
            // A visitor closing the tab aborts the Edge Function's stream and
            // the provider call behind it. This is live spend metered per
            // token, not just a UI concern.
            signal: params.request.signal,
          })) {
            if (event.type === "delta") {
              text += event.text;
              controller.enqueue(sseBytes("delta", { text: event.text }));
              continue;
            }
            if (event.type === "error") {
              terminal = "error";
              errorPayload = {
                code: event.code,
                retryable: event.retryable,
              };
              continue;
            }
            terminal = "done";
            provider = event.provider;
            adapterId = event.adapterId;
            providerRequestRef = event.providerRequestRef;
          }
        }

        const trimmed = text.trim();
        if (terminal !== "done" || trimmed === "") {
          // A stream that fails or ends without a terminal event -- closed tab,
          // provider fault, budget refusal -- must not be presented as a
          // finished answer, and nothing is recorded for it.
          controller.enqueue(
            sseBytes(
              "error",
              errorPayload ?? { code: "answer_unavailable", retryable: true },
            ),
          );
          controller.close();
          resolveOutcome({ ok: false });
          return;
        }

        /*
         * Recorded BEFORE `done`, unlike the authenticated stream which
         * persists in `after()`. The difference is not stylistic: this is the
         * call that mints the durable message id, and that id is the only one
         * `widget_record_answer_feedback` accepts. Deferring it would leave
         * every streamed answer with no ratable id and therefore no rating
         * control at all.
         */
        let messageId: string | null = null;
        try {
          const answerRecord = await widgetRecordAnswer(supabase, {
            widgetKey: params.widgetKey,
            origin: params.origin,
            conversationRef: params.conversationRef,
            answer: trimmed,
            sources: params.evidence,
            providerKey: `${provider}:${adapterId}`.slice(0, 100),
            providerRequestRef,
            idempotencyKey,
            traceId: params.traceId,
            operationToken: params.operationToken,
          });
          messageId = answerRecord.messageId;
        } catch (error) {
          // The visitor keeps the answer they already watched arrive; the
          // transcript never gets it. There is no synchronous response left to
          // surface this on, and retrying would risk a second provider call.
          // It is logged rather than lost -- and no rating control is offered,
          // because there is no id a rating could name.
          console.warn(
            `[widget-stream-persist] the recorded turn was dropped: ` +
              `${error instanceof Error ? error.message : "unknown"} ` +
              `trace=${params.traceId}`,
          );
        }

        controller.enqueue(
          sseBytes("done", {
            conversationRef: params.conversationRef,
            // Omitted entirely when the database returned none, so a widget
            // running against an un-migrated deployment shows no rating
            // control rather than one that refuses every click.
            ...(messageId === null ? {} : { messageId }),
            retrievalMode: params.retrievalMode,
            provider: { provider, adapterId },
          }),
        );
        controller.close();
        resolveOutcome({ ok: true, text: trimmed });
      } catch {
        try {
          controller.close();
        } catch {
          // Already closed or cancelled by the visitor disconnecting.
        }
        resolveOutcome({ ok: false });
      }
    },
    cancel() {
      // The reader disconnected (tab closed, navigation, network drop).
      resolveOutcome({ ok: false });
    },
  });

  // Classification runs once the stream has settled and only if it settled
  // successfully, so it can never delay the visitor's turn and never labels a
  // question whose answer was never recorded.
  after(async () => {
    const settled = await outcome;
    if (!settled.ok) return;
    try {
      await labelWidgetQuestion(supabase, {
        widgetKey: params.widgetKey,
        origin: params.origin,
        conversationRef: params.conversationRef,
        questionIdempotencyKey: idempotencyKey,
        requestId: `classify:${params.turnId}`,
        traceId: params.traceId,
        question: params.question,
        answer: settled.text,
        operationToken: params.operationToken,
      });
    } catch (error) {
      console.warn(
        `[widget-question-classifier] labelling threw: ` +
          `${error instanceof Error ? error.message : "unknown"} ` +
          `trace=${params.traceId}`,
      );
    }
  });

  return new Response(stream, {
    headers: widgetStreamHeaders(params.origin),
  });
}

export function OPTIONS(request: Request) {
  return preflightResponse(request, "POST");
}

export async function POST(request: Request) {
  const origin = requestOrigin(request);
  if (origin === null) return widgetRefusal();

  try {
    const input = (await request.json()) as unknown;
    if (!isRecord(input)) return widgetRefusal(400);
    const key = typeof input.key === "string" ? input.key.trim() : "";
    const conversationRef =
      typeof input.conversationRef === "string" ? input.conversationRef : "";
    const question =
      typeof input.question === "string" ? input.question.trim() : "";
    const courseRef = isCourseRef(input.courseRef) ? input.courseRef : null;
    // Who the embedding page says is asking.
    //
    // Both halves must be present and well formed or neither is forwarded:
    // a reference with no tier is an unlabelled claim, and a tier with no
    // reference is a label with nothing under it. `"self_reported"` is the
    // only tier this boundary accepts — see `isVisitorRef` and
    // `WidgetVisitorTier` for why `"verified"` cannot be reached from a page
    // script, and why the database refuses it as well rather than trusting
    // this route to have checked.
    //
    // Nothing below logs `visitorRef`, and nothing may start: the whole point
    // of hashing it behind a per-install pepper in the database is defeated
    // by a plaintext copy in a log line. The refusal path returns the same
    // generic 400 the route already returns, so a malformed reference tells a
    // prober nothing new.
    const visitorTier =
      input.visitorTier === "self_reported" ? "self_reported" : null;
    const visitorRef =
      visitorTier !== null && isVisitorRef(input.visitorRef)
        ? input.visitorRef
        : null;
    if (
      !isWidgetKey(key) ||
      !isConversationRef(conversationRef) ||
      question.length < 2 ||
      question.length > 2_000
    ) {
      return widgetRefusal(400);
    }

    const operationToken =
      process.env.LEARNINGBOT_CONVERSATION_OPERATION_TOKEN?.trim() ?? "";
    if (operationToken.length < 32) {
      // Without the operation token the assistant turn could not be recorded,
      // so refuse before charging the tenant for a model call.
      return Response.json(
        { ok: false, code: "widget_unconfigured" },
        {
          status: 503,
          headers: {
            "Cache-Control": "private, no-store",
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }

    const turnId = crypto.randomUUID();
    const traceId = `widget-response:${turnId}`;
    const supabase = createWidgetSupabaseClient();

    const askInput = {
      widgetKey: key,
      origin,
      question,
      conversationRef,
      courseRef,
      idempotencyKey: `widget-turn:${turnId}`,
      traceId,
      operationToken,
    };

    /**
     * The identity is carried on a best-effort basis, and only the identity.
     *
     * Migrations on this project are applied by hand, so a deployment can be
     * running this code against a database that has not been given
     * 20260731090000 yet. In that state `widget_ask` has no `visitor_ref`
     * argument, PostgREST cannot match the call, and `widgetAsk` reports
     * `request_failed`. Retrying once without the identity turns that into a
     * normal anonymous turn instead of a visitor whose question vanishes
     * because of an analytics feature.
     *
     * The retry is the same turn, not a second one: `idempotencyKey` and
     * `traceId` are unchanged, and `widget_ask` writes the question under that
     * key, so a first call that somehow did land is deduplicated rather than
     * doubled.
     */
    const asked = await (async () => {
      if (visitorRef === null) return widgetAsk(supabase, askInput);
      try {
        const identified = await widgetAsk(supabase, {
          ...askInput,
          visitorRef,
          visitorTier,
        });
        // An identity was sent and the database says it counted nobody. That
        // is not the same as nobody having identified themselves, and it must
        // not read as one: the likely cause is a missing
        // app_private.surface_attribution_settings row, which makes
        // surface_visitor_key return null and drop the identity without
        // failing anything.
        if (identified.learnerCounted !== true) {
          console.warn(
            `[widget-identity] an identity was sent and none was recorded. ` +
              `Check app_private.surface_attribution_settings. ` +
              `trace=${traceId}`,
          );
        }
        return identified;
      } catch (error) {
        if (
          !(error instanceof WidgetRpcError) ||
          error.code !== "request_failed"
        ) {
          throw error;
        }
        // Deliberately names no reference and no visitor. It reports that
        // attribution was lost and why to look, which is the whole content.
        console.warn(
          `[widget-identity] the database refused the identified call; ` +
            `retrying anonymously. Apply 20260731090000 if this persists. ` +
            `trace=${traceId}`,
        );
        return widgetAsk(supabase, askInput);
      }
    })();

    const visuals = citedVisuals(
      asked.matches,
      request.url,
      key,
      conversationRef,
    );
    const visualsByAssetId = new Map(
      visuals.map((visual) => [visual.visualAssetId, visual]),
    );

    const sources: GroundingSource[] = asked.matches.map((match) => {
      const visual =
        match.visualAssetId === undefined
          ? undefined
          : visualsByAssetId.get(match.visualAssetId);
      return {
        // The widget never receives course, document or lesson UUIDs, so the
        // grounding record carries the opaque source ref instead. The content
        // hash still ties every cited excerpt back to an exact stored chunk.
        chunkId: match.sourceRef,
        courseId: "",
        courseTitle: match.courseTitle,
        documentId: "",
        documentTitle: match.documentTitle,
        contentHash: match.contentHash,
        excerpt: match.excerpt.replace(/<\/?b>/giu, ""),
        lessonId: null,
        lessonTitle: match.lessonTitle,
        sectionName: match.sectionName,
        // Told to the model as well as shown to the visitor, so the prose can
        // refer to the picture instead of describing it blind. Same shape the
        // authenticated route builds; `sourceContext` in lib/learning-provider
        // reads `title` and `altText` from it.
        ...(visual
          ? {
              visual: {
                visualAssetId: visual.visualAssetId,
                title: visual.title,
                altText: visual.altText,
                mediaType: visual.mediaType as NonNullable<
                  GroundingSource["visual"]
                >["mediaType"],
                url: visual.url,
              },
            }
          : {}),
      };
    });

    /*
     * Built here, above the branch, because both the streamed and the buffered
     * answer must cite exactly the same evidence: this is what is shown to the
     * visitor AND what `widget_record_answer` stores as the turn's grounding,
     * which is in turn what the classifier reads to decide whether the answer
     * was grounded at all.
     */
    const evidence = sources.map((source) => ({
      sourceRef: source.chunkId,
      title: source.lessonTitle ?? source.documentTitle,
      courseTitle: source.courseTitle,
      sectionName: source.sectionName,
      excerpt: source.excerpt,
      contentHash: source.contentHash,
    }));

    if (wantsEventStream(request)) {
      return buildStreamingWidgetResponse({
        request,
        supabase,
        widgetKey: key,
        origin,
        conversationRef,
        turnId,
        traceId,
        operationToken,
        question,
        assistantName: asked.assistantName,
        directive: asked.directive,
        retrievalMode: asked.retrievalMode,
        sources,
        evidence,
        visuals,
      });
    }

    const answer = await answerGroundedLearningQuestion({
      assistantName: asked.assistantName,
      // Deliberately empty: the widget path never learns the tenant id, and the
      // provider context must not become the one place it leaks.
      tenantId: "",
      actorId: "widget-anonymous",
      requestId: turnId,
      traceId,
      idempotencyKey: turnId,
      question,
      intent: "explain",
      scopeLabel: null,
      personaInstructions: asked.directive?.personaInstructions ?? null,
      tone: asked.directive?.tone ?? null,
      history: [],
      sources,
      completion: (context, providerRequest) =>
        completeWithManagedWidgetProvider({
          supabase,
          context,
          request: providerRequest,
          adapterId: ANSWER_ADAPTER_ID,
          widgetKey: key,
          origin,
          operationToken,
          actorRef: conversationRef,
        }),
    });

    const answerRecord = await widgetRecordAnswer(supabase, {
      widgetKey: key,
      origin,
      conversationRef,
      answer: answer.answer,
      sources: evidence,
      providerKey: `${answer.provider}:${answer.adapterId}`.slice(0, 100),
      providerRequestRef: answer.providerRequestRef,
      idempotencyKey: `widget-turn:${turnId}`,
      traceId,
      operationToken,
    });

    // The disclosure is what authorises the visitor to read these bytes at all
    // (20260731060000): without a row, /api/widget/visuals/:id/content answers
    // `visual_not_found` even for the visitor the assistant just showed it to.
    // So it is recorded BEFORE the URLs are handed out, and if it fails the
    // answer degrades to text rather than shipping URLs that would render as
    // broken images. The assistant turn is already durably recorded by this
    // point, so a failure here must not turn a delivered answer into an error.
    let disclosed = visuals;
    if (visuals.length > 0) {
      try {
        await widgetRecordVisualDisclosure(supabase, {
          widgetKey: key,
          origin,
          conversationRef,
          visualAssetIds: visuals.map((visual) => visual.visualAssetId),
          operationToken,
        });
      } catch {
        disclosed = [];
      }
    }

    // Classification runs after the answer is durably recorded and after this
    // response is sent, so it can never delay or fail the visitor's turn. A
    // classifier that is unavailable, slow or off-schema simply produces no
    // label, and the question is then reported as unclassified — which is what
    // the whole widget surface has been reporting, for every question, because
    // until now nothing here ever asked for one.
    after(async () => {
      try {
        await labelWidgetQuestion(supabase, {
          widgetKey: key,
          origin,
          conversationRef,
          questionIdempotencyKey: `widget-turn:${turnId}`,
          requestId: `classify:${turnId}`,
          traceId,
          question,
          answer: answer.answer,
          operationToken,
        });
      } catch (error) {
        // A label is optional; the recorded turn is not. Never surface this to
        // the visitor — but do not lose it either, or an unlabelled question
        // stays unexplainable.
        console.warn(
          `[widget-question-classifier] labelling threw: ` +
            `${error instanceof Error ? error.message : "unknown"} ` +
            `trace=${traceId}`,
        );
      }
    });

    return widgetJson(
      {
        ok: true,
        conversationRef,
        message: {
          // The durable message id, and the ONLY id
          // `widget_record_answer_feedback` accepts. Omitted entirely when the
          // database did not return one, so a widget running against an
          // un-migrated deployment shows no rating control rather than one
          // that refuses every click.
          ...(answerRecord.messageId === null
            ? {}
            : { id: answerRecord.messageId }),
          role: "assistant",
          content: answer.answer,
          createdAt: new Date().toISOString(),
          sources: evidence,
          parts: visualParts(disclosed),
        },
        retrievalMode: asked.retrievalMode,
      },
      origin,
    );
  } catch (error) {
    if (error instanceof WidgetRpcError && error.code === "rate_limited") {
      const retryAfter = error.retryAfterSeconds ?? 60;
      return Response.json(
        { ok: false, code: "rate_limited", retryAfterSeconds: retryAfter },
        {
          status: 429,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": String(retryAfter),
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }
    if (error instanceof LearningProviderError) {
      return Response.json(
        { ok: false, code: "answer_unavailable", retryable: error.retryable },
        {
          status: 503,
          headers: {
            "Cache-Control": "private, no-store",
            ...allowedOriginHeaders(origin),
          },
        },
      );
    }
    // Anything else — including a disallowed origin or an unknown key — is the
    // same opaque refusal with no CORS headers at all.
    return widgetRefusal();
  }
}
