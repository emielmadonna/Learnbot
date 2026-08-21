import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ProtectedObjectRef,
  ProviderRequestContext,
} from "@course-ai/contracts";
import { OpenAIImageAdapter } from "@course-ai/provider-router";
import {
  AuthenticationBoundaryError,
  assertSameOrigin,
  classifyAuthBoundaryError,
  getCurrentTenantContext,
  requireVerifiedUser,
} from "../../../../lib/supabase/auth-boundary";
import {
  AgentRpcError,
  requireAgentRpcSuccess,
} from "../../../../lib/supabase/agent-rpc";
import { authenticatedLearningClient } from "../../../../lib/supabase/learning-route";
import {
  recordProviderCost,
  reservationMessage,
  reserveProviderCall,
  type ProviderCapability,
} from "../../../../lib/cost-metering";

/*
 * Generated character avatars (PLAN.md Section 7.1).
 *
 * GET lists a tenant's avatar pose sets (published, pending review, and
 * recent history). POST runs the whole consent -> generate -> record flow in
 * one authenticated call:
 *
 *   1. Record the creator's consent affirmation, verbatim, into
 *      audit_ledger (via agent_avatar_record_consent). This happens BEFORE
 *      any provider spend, and only for a tenant_owner/tenant_admin acting on
 *      their own tenant's photo — there is no path here that can generate a
 *      likeness of a student.
 *   2. Check the tenant's durable budget (learning_reserve_provider_call),
 *      exactly like every other provider call in this codebase.
 *   3. Generate five poses with OpenAIImageAdapter, each metered into
 *      cost_ledger as it completes (learning_record_provider_cost) so a
 *      later pose failing never erases the spend already made.
 *   4. Record the completed set as 'pending_review' (agent_avatar_create_set)
 *      — it is not visible anywhere as the tenant's live avatar until a
 *      separate, explicit review call (see ./review/route.ts) publishes it.
 *
 * This route never touches packages/provider-router's vendor HTTP calls
 * directly — OpenAIImageAdapter owns that — and it never calls the OpenAI or
 * Supabase Storage SDKs from inside the adapter; storage access is injected
 * into the adapter as `objectResolver` / `store`, mirroring how
 * `credentialResolver` is injected in every other adapter in this package.
 */

const adminRoles = new Set(["tenant_owner", "tenant_admin"]);
const allowedSourceMediaTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
]);
const readTtlSeconds = 600;
const generationDeadlineMs = 90_000;

// The two consent affirmations agent_avatar_record_consent accepts, verbatim
// (infra/supabase/migrations/20260726101000_character_avatars.sql). Kept
// here too so the client can present the exact wording the database expects
// without a round trip just to discover it.
const CONSENT_SELF_STATEMENT =
  "This is a photo of me. I consent to generating a stylized character likeness from it.";
const CONSENT_PERMISSION_STATEMENT =
  "This is a photo of someone else who has given me their permission to generate a stylized character likeness from it.";

const POSES = ["idle", "listening", "thinking", "speaking", "unsure"] as const;
type Pose = (typeof POSES)[number];

const CHARACTER_STYLE =
  "A friendly, stylized 3D bobblehead character: a slightly oversized " +
  "rounded head, simple clean shading, a warm neutral palette, plain " +
  "transparent background. A gentle caricature, not a photoreal portrait — " +
  "keep the person's recognizable features (hair, skin tone, glasses if " +
  "present) but simplify and soften them. Square composition, the whole " +
  "character visible and centered.";

const POSE_PROMPTS: Record<Pose, string> = {
  idle: `${CHARACTER_STYLE} Pose: IDLE — standing straight, arms relaxed at its sides, a calm neutral expression, looking directly forward.`,
  listening:
    "Keep this exact character consistent with the attached reference image(s) — same proportions, palette and features. Change only the pose to LISTENING: head tilted slightly to one side as if paying close attention, eyes slightly widened, a small attentive smile.",
  thinking:
    "Keep this exact character consistent with the attached reference image(s) — same proportions, palette and features. Change only the pose to THINKING: one hand near the chin, eyes looking slightly upward and to one side, a thoughtful expression.",
  speaking:
    "Keep this exact character consistent with the attached reference image(s) — same proportions, palette and features. Change only the pose to SPEAKING: mouth open mid-word, one hand raised slightly as if gesturing while explaining something, an animated engaged expression.",
  unsure:
    "Keep this exact character consistent with the attached reference image(s) — same proportions, palette and features. Change only the pose to UNSURE: shoulders raised in a small shrug, palms slightly open and turned upward, eyebrows raised, an apologetic, uncertain expression.",
};

const safeCodes = new Set([
  "access_denied",
  "consent_required",
  "idempotency_conflict",
  "invalid_request",
  "invalid_state",
  "not_found",
  "provider_failed",
  "provider_not_configured",
  "request_denied",
  // The RPC itself could not run at all — unavailable dependency, never
  // reported as a rejected request or a failed sign-in.
  "request_failed",
  "source_photo_unavailable",
  "spend_refused",
  "storage_write_failed",
  "tenant_not_found",
  "tenant_selection_required",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(error: unknown) {
  if (error instanceof AuthenticationBoundaryError) {
    const failure = classifyAuthBoundaryError(error);
    return NextResponse.json(
      { ok: false, code: failure.code },
      { status: failure.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  const code =
    error instanceof AgentRpcError && safeCodes.has(error.code)
      ? error.code
      : "request_denied";
  const status =
    code === "access_denied"
      ? 403
      : code === "tenant_selection_required" || code === "idempotency_conflict"
        ? 409
        : code === "provider_not_configured" ||
            code === "provider_failed" ||
            code === "request_failed"
          ? 503
          : code === "spend_refused"
            ? 429
            : code === "not_found"
              ? 404
              : 400;
  return NextResponse.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

async function requireTenantAdmin(request: Request, mutation: boolean) {
  const supabase = await authenticatedLearningClient(request, { mutation });
  const user = await requireVerifiedUser(supabase);
  const context = await getCurrentTenantContext(supabase);
  if (!context.selected || !context.tenantId) {
    throw new AgentRpcError("tenant_selection_required");
  }
  if (!context.identityRole || !adminRoles.has(context.identityRole)) {
    throw new AgentRpcError("access_denied");
  }
  return { supabase, user, tenantId: context.tenantId, identityRole: context.identityRole };
}

function providerCredential(): string | null {
  const credential = process.env.OPENAI_API_KEY?.trim();
  return credential && credential.length >= 20 ? credential : null;
}

/** Read by this route only: LEARNINGBOT_AVATAR_IMAGE_MODEL (.env.example). */
function avatarImageModel(): string {
  return process.env.LEARNINGBOT_AVATAR_IMAGE_MODEL?.trim() || "gpt-image-1";
}

/**
 * Read by this route only: LEARNINGBOT_AVATAR_IMAGE_PRICE_MICRO
 * (.env.example). Micro-USD per generated pose image. cost-metering.ts's
 * shared price book
 * (LEARNINGBOT_MODEL_PRICES) prices text and per-unit models only and cannot
 * be extended here without editing a file another session owns right now, so
 * this route keeps its own small, overridable estimate — deliberately a
 * plausible-but-conservative overstatement, same philosophy as
 * cost-metering.ts's UNKNOWN_MODEL_PRICE: spend should be overstated, never
 * hidden.
 */
function avatarImagePriceMicro(): number {
  const raw = process.env.LEARNINGBOT_AVATAR_IMAGE_PRICE_MICRO?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 70_000;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // A view's backing buffer can be a SharedArrayBuffer, which
  // crypto.subtle.digest's BufferSource type does not accept. Copying is
  // cheap at these sizes (single images) and keeps the type honest.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function extensionFor(mediaType: string): string {
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "image/jpeg") return "jpg";
  return "png";
}

async function signStorageUrl(
  supabase: SupabaseClient,
  key: string | null | undefined,
): Promise<string | null> {
  if (typeof key !== "string" || key.length === 0) return null;
  const signed = await supabase.storage
    .from("tenant-private")
    .createSignedUrl(key, readTtlSeconds);
  if (signed.error || !signed.data) return null;
  return signed.data.signedUrl;
}

type PoseRecord = { storageKey: string; revisedPrompt?: string };

async function signAvatarSet(
  supabase: SupabaseClient,
  set: Record<string, unknown>,
) {
  const poses = isRecord(set.poses) ? set.poses : {};
  const status = typeof set.status === "string" ? set.status : "";
  const shouldSign = status === "pending_review" || status === "published";
  const sourceUrl = shouldSign
    ? await signStorageUrl(
        supabase,
        typeof set.sourcePhotoStorageKey === "string"
          ? set.sourcePhotoStorageKey
          : null,
      )
    : null;
  const poseEntries = await Promise.all(
    POSES.map(async (pose) => {
      const entry = isRecord(poses[pose]) ? (poses[pose] as PoseRecord) : null;
      const storageKey = entry?.storageKey ?? null;
      const url = shouldSign ? await signStorageUrl(supabase, storageKey) : null;
      return [pose, { storageKey, revisedPrompt: entry?.revisedPrompt ?? null, url }] as const;
    }),
  );
  return {
    ...set,
    sourcePhotoUrl: sourceUrl,
    poses: Object.fromEntries(poseEntries),
  };
}

export async function GET(request: Request) {
  try {
    const { supabase } = await requireTenantAdmin(request, false);
    const response = await supabase.rpc("agent_list_avatar_sets");
    if (response.error) throw new AgentRpcError("request_failed");
    const result = requireAgentRpcSuccess(response.data);
    const sets = Array.isArray(result.sets) ? result.sets : [];
    const signed = await Promise.all(
      sets.filter(isRecord).map((set) => signAvatarSet(supabase, set)),
    );
    return NextResponse.json(
      { ok: true, dataMode: "durable", sets: signed },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const { supabase, user, tenantId } = await requireTenantAdmin(request, true);

    const body = (await request.json()) as unknown;
    if (!isRecord(body)) throw new AgentRpcError("invalid_request");
    const sourcePhotoStorageKey =
      typeof body.sourcePhotoStorageKey === "string"
        ? body.sourcePhotoStorageKey.trim()
        : "";
    const sourcePhotoMediaType =
      typeof body.sourcePhotoMediaType === "string"
        ? body.sourcePhotoMediaType.trim().toLowerCase()
        : "";
    const consentStatement =
      isRecord(body.consent) && typeof body.consent.statement === "string"
        ? body.consent.statement.trim()
        : "";
    const assetPrefix = `${tenantId}/branding/`;
    if (
      sourcePhotoStorageKey.length === 0 ||
      sourcePhotoStorageKey.length > 1024 ||
      sourcePhotoStorageKey.includes("..") ||
      !sourcePhotoStorageKey.startsWith(assetPrefix) ||
      !allowedSourceMediaTypes.has(sourcePhotoMediaType) ||
      (consentStatement !== CONSENT_SELF_STATEMENT &&
        consentStatement !== CONSENT_PERMISSION_STATEMENT)
    ) {
      throw new AgentRpcError("invalid_request");
    }

    const configuredCredential = providerCredential();
    if (!configuredCredential) throw new AgentRpcError("provider_not_configured");
    // Re-bound so the OpenAIImageAdapter closures below (defined in a hoisted
    // function declaration) see a `string`, not the wider
    // `string | null` TypeScript keeps for a variable narrowed only by an
    // earlier control-flow check.
    const credential: string = configuredCredential;

    const operationId = crypto.randomUUID();
    const requestId = `agent-avatar:${operationId}`;
    const traceId = `agent-avatar:${operationId}`;

    // Step 1: consent, recorded before any spend.
    const consentResponse = await supabase.rpc("agent_avatar_record_consent", {
      source_photo_storage_key: sourcePhotoStorageKey,
      consent_statement: consentStatement,
      request_id: requestId,
      trace_id: traceId,
      idempotency_key: `agent-avatar-consent:${operationId}`,
    });
    if (consentResponse.error) throw new AgentRpcError("request_failed");
    const consent = requireAgentRpcSuccess(consentResponse.data);
    const consentAuditId = consent.consentAuditId;
    if (typeof consentAuditId !== "string") {
      throw new AgentRpcError("request_failed");
    }

    // Step 2: durable budget check, identical to every other provider call.
    // "avatar.generate" is not yet in cost-metering.ts's ProviderCapability
    // union — that file is owned by a concurrent session right now — but the
    // RPCs behind reserveProviderCall/recordProviderCost accept any
    // capability key of 1-100 characters, so this is safe at runtime; add it
    // to the union the next time cost-metering.ts is touched.
    const capability = "avatar.generate" as ProviderCapability;
    const reservation = await reserveProviderCall(supabase, {
      capability,
      subjectKey: user.id,
    });
    if (!reservation.allowed) {
      return NextResponse.json(
        {
          ok: false,
          code: "spend_refused",
          reason: reservation.code,
          message: reservationMessage(reservation.code),
          retryAfterSeconds: reservation.retryAfterSeconds,
        },
        {
          status: reservation.code === "tenant_suspended" ? 403 : 429,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    // Step 3: download the consent photo once; it is both the first
    // reference image and the object the RPC ties consent to.
    const downloaded = await supabase.storage
      .from("tenant-private")
      .download(sourcePhotoStorageKey);
    if (downloaded.error || !downloaded.data) {
      throw new AgentRpcError("source_photo_unavailable");
    }
    const sourceBytes = new Uint8Array(await downloaded.data.arrayBuffer());
    const sourceRef: ProtectedObjectRef = {
      objectId: crypto.randomUUID(),
      storageKey: sourcePhotoStorageKey,
      contentHash: await sha256Hex(sourceBytes),
      sizeBytes: sourceBytes.byteLength,
      mediaType: sourcePhotoMediaType,
    };

    const byteCache = new Map<string, Uint8Array>([
      [sourceRef.storageKey, sourceBytes],
    ]);
    const objectResolver = async (
      _context: ProviderRequestContext,
      ref: ProtectedObjectRef,
    ): Promise<Uint8Array> => {
      const cached = byteCache.get(ref.storageKey);
      if (cached) return cached;
      const fetched = await supabase.storage
        .from("tenant-private")
        .download(ref.storageKey);
      if (fetched.error || !fetched.data) {
        throw new Error("reference_object_unavailable");
      }
      const bytes = new Uint8Array(await fetched.data.arrayBuffer());
      byteCache.set(ref.storageKey, bytes);
      return bytes;
    };

    const model = avatarImageModel();
    const priceMicro = avatarImagePriceMicro();
    const avatarSetAssetId = crypto.randomUUID();

    function buildAdapter(pose: Pose) {
      return new OpenAIImageAdapter({
        id: `openai-image-avatar-${pose}`,
        model,
        credentialResolver: async () => credential,
        objectResolver,
        store: async (_ctx, bytes, mediaType) => {
          const storageKey = [
            tenantId,
            "branding",
            user.id,
            avatarSetAssetId,
            `avatar-pose-${pose}.${extensionFor(mediaType)}`,
          ].join("/");
          const upload = await supabase.storage
            .from("tenant-private")
            .upload(storageKey, bytes, { contentType: mediaType, upsert: false });
          if (upload.error) throw new Error("storage_write_failed");
          byteCache.set(storageKey, bytes);
          return {
            objectId: crypto.randomUUID(),
            storageKey,
            contentHash: await sha256Hex(bytes),
            sizeBytes: bytes.byteLength,
            mediaType,
          };
        },
        estimateUsageCost: async () => ({
          amount: priceMicro / 1_000_000,
          currency: "USD",
        }),
      });
    }

    const poses: Partial<Record<Pose, PoseRecord>> = {};
    let idleRef: ProtectedObjectRef | null = null;
    for (const pose of POSES) {
      const context: ProviderRequestContext = {
        tenantId,
        actorId: user.id,
        requestId: `${requestId}:${pose}`,
        traceId,
        idempotencyKey: `${operationId}:${pose}`,
        fundingSource: "platform",
        deadlineMs: Date.now() + generationDeadlineMs,
      };
      const references =
        pose === "idle"
          ? [sourceRef]
          : idleRef
            ? [sourceRef, idleRef]
            : [sourceRef];
      const outcome = await buildAdapter(pose).generate(context, {
        prompt: POSE_PROMPTS[pose],
        width: 1024,
        height: 1024,
        outputMediaType: "image/png",
        references,
      });
      if (!outcome.ok) {
        throw new AgentRpcError("provider_failed");
      }
      // Metered as each pose completes, so a later pose failing never erases
      // the spend already made on the poses that succeeded.
      await recordProviderCost(supabase, {
        capability,
        providerKey: `${outcome.result.provider}:${outcome.result.adapterId}`,
        modelKey: outcome.result.modelOrSku ?? model,
        quantity: 1,
        unit: "images",
        costMicro: priceMicro,
        traceId,
        idempotencyKey: `cost:avatar.generate:${operationId}:${pose}`,
        requestId: context.requestId,
        metadata: {
          pose,
          latencyMs: outcome.result.latencyMs,
        },
      });
      const record: PoseRecord = {
        storageKey: outcome.result.value.object.storageKey,
        ...(outcome.result.value.revisedPrompt === undefined
          ? {}
          : { revisedPrompt: outcome.result.value.revisedPrompt }),
      };
      poses[pose] = record;
      if (pose === "idle") idleRef = outcome.result.value.object;
    }

    // Step 4: record the completed, still-unpublished set.
    const createResponse = await supabase.rpc("agent_avatar_create_set", {
      consent_audit_id: consentAuditId,
      source_photo_storage_key: sourcePhotoStorageKey,
      poses,
      provider_key: "openai",
      model_key: model,
      request_id: requestId,
      trace_id: traceId,
      idempotency_key: `agent-avatar-create:${operationId}`,
    });
    if (createResponse.error) throw new AgentRpcError("request_failed");
    const created = requireAgentRpcSuccess(createResponse.data);
    const avatarSet = isRecord(created.avatarSet) ? created.avatarSet : {};
    const signed = await signAvatarSet(supabase, avatarSet);

    return NextResponse.json(
      { ok: true, dataMode: "durable", avatarSet: signed },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

// The exact accepted consent wording, so the Studio UI can present it
// without a round trip just to discover it.
