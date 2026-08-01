import { randomUUID } from "node:crypto";
import {
  SourceConnectorError,
  connectorErrorResponse,
  connectorRequestContext,
  connectorRpc,
  createSourceConnectorServiceClient,
  requiredUuid,
} from "../../../../../lib/source-connectors/server";
import {
  YouTubeSourceError,
  resolveYouTubeLearningSource,
} from "../../../../../lib/source-connectors/youtube";

export async function POST(request: Request) {
  try {
    const context = await connectorRequestContext(request, { mutation: true });
    const input = (await request.json()) as {
      courseId?: unknown;
      url?: unknown;
      replaceActiveKnowledge?: unknown;
    };
    if (typeof input.url !== "string" || input.url.length > 2_000) {
      throw new SourceConnectorError("invalid_youtube_url");
    }

    let source;
    try {
      source = await resolveYouTubeLearningSource(input.url);
    } catch (error) {
      if (error instanceof YouTubeSourceError) {
        throw new SourceConnectorError(error.code, 422);
      }
      throw new SourceConnectorError("youtube_provider_unavailable", 502);
    }

    const createDestination =
      input.courseId === undefined ||
      input.courseId === null ||
      input.courseId === "" ||
      input.courseId === "new";
    let courseId: string;
    if (createDestination) {
      const created = await connectorRpc(
        context.supabase,
        "learning_create_source_course",
        {
          requested_title: source.title,
          requested_source_kind: "youtube",
          requested_external_ref: source.videoId,
          requested_idempotency_key: `source-course:youtube:${source.videoId}`,
        },
      );
      courseId = requiredUuid(created.courseId);
    } else {
      courseId = requiredUuid(input.courseId);
    }

    const service = createSourceConnectorServiceClient();
    const result = await connectorRpc(
      service,
      "learning_source_connector_sync",
      {
        caller_auth_user_id: context.userId,
        target_tenant_id: context.tenantId,
        target_course_id: courseId,
        source_kind: "youtube",
        external_ref: source.videoId,
        source_name: source.title,
        source_configuration: {
          videoId: source.videoId,
          videoUrl: source.videoUrl,
          authorName: source.authorName,
          captionBacked: true,
        },
        source_documents: [source.document],
        source_content_hash: source.contentHash,
        replace_active_knowledge: input.replaceActiveKnowledge === true,
        requested_idempotency_key: `youtube:${source.videoId}:${randomUUID()}`,
        source_credential_vault_ref: null,
      },
    );
    return Response.json(
      {
        ...result,
        source: {
          kind: "youtube",
          externalRef: source.videoId,
          name: source.title,
          captionBacked: true,
        },
        destination: {
          courseId,
          created: createDestination,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return connectorErrorResponse(error);
  }
}
