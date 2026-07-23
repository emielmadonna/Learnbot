import { NextResponse } from "next/server";

import {
  getDevelopmentRuntime,
  serializeDevelopmentError,
} from "../../../../lib/dev-runtime";
import {
  assertDevTenantMatch,
  developmentApiErrorStatus,
  requireDevActorId,
  requireDevSession,
} from "../../../../lib/dev-session-guard";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const ALLOWED_MEDIA_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
]);

function attachmentKind(mediaType: string) {
  if (mediaType === "application/pdf") return "pdf" as const;
  if (mediaType.startsWith("image/")) return "image" as const;
  if (mediaType.includes("presentation") || mediaType.includes("powerpoint")) {
    return "presentation" as const;
  }
  if (mediaType === "text/csv") return "spreadsheet" as const;
  if (mediaType === "text/plain") return "text" as const;
  return "document" as const;
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function POST(request: Request) {
  try {
    const session = await requireDevSession(request, {
      principal: "student",
      permission: "attachment.write",
    });
    const form = await request.formData();
    assertDevTenantMatch(session, form.get("tenantId"));
    const studentId = requireDevActorId(session);
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { code: "FILE_REQUIRED", message: "Choose a file to upload." },
        { status: 400 },
      );
    }
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json(
        {
          code: "FILE_SIZE_REJECTED",
          message: "The file must be between 1 byte and 25 MB.",
        },
        { status: 413 },
      );
    }
    if (!ALLOWED_MEDIA_TYPES.has(file.type)) {
      return NextResponse.json(
        {
          code: "FILE_TYPE_REJECTED",
          message: "The detected file type is not supported.",
        },
        { status: 415 },
      );
    }

    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const contentHash = `sha256:${toHex(digest)}`;
    const context = session.context;
    const services = getDevelopmentRuntime().services;
    const conversation = await services.createConversation(context, {
      idempotencyKey: "student-demo-conversation",
      studentId,
      identityTier: "verified",
      activeModality: "text",
      pageContext: {
        url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
        courseId: "course_momentum",
        course: "Momentum Method",
        moduleId: "module_rhythm",
        module: "Build Your Rhythm",
        lessonId: "lesson_minimum_day",
        lesson: "Minimum Day",
      },
    });
    let attachment = await services.createAttachment(context, {
      idempotencyKey: contentHash,
      conversationId: conversation.id,
      kind: attachmentKind(file.type),
      fileName: file.name,
      mediaType: file.type,
      sizeBytes: file.size,
      contentHash,
    });
    attachment = await services.updateAttachmentStatus(
      context,
      attachment.attachmentId,
      "uploaded",
      `${contentHash}:uploaded`,
    );
    attachment = await services.updateAttachmentStatus(
      context,
      attachment.attachmentId,
      "scanning",
      `${contentHash}:scanning`,
    );

    const textSample =
      file.type.startsWith("text/") && bytes.byteLength < 1_000_000
        ? new TextDecoder().decode(bytes)
        : "";
    if (textSample.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) {
      attachment = await services.updateAttachmentStatus(
        context,
        attachment.attachmentId,
        "quarantined",
        `${contentHash}:quarantined`,
      );
      return NextResponse.json(
        {
          attachment,
          code: "MALWARE_QUARANTINED",
          message: "The file was quarantined and cannot enter the conversation.",
        },
        { status: 422 },
      );
    }

    attachment = await services.updateAttachmentStatus(
      context,
      attachment.attachmentId,
      "processing",
      `${contentHash}:processing`,
    );
    attachment = await services.updateAttachmentStatus(
      context,
      attachment.attachmentId,
      "ready",
      `${contentHash}:ready`,
    );
    return NextResponse.json({
      attachment,
      conversationId: conversation.id,
      promotedToCourseKnowledge: false,
    });
  } catch (error) {
    return NextResponse.json(serializeDevelopmentError(error), {
      status: developmentApiErrorStatus(error),
    });
  }
}
