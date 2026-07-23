import type {
  AssetId,
  ConversationId,
  DocumentId,
  IsoTimestamp,
  JsonObject,
  LessonId,
  MessageId,
  ProtectedObjectRef,
  SessionId,
} from "./common.js";
import type { RequestContext } from "./context.js";

export type ConversationModality = "text" | "voice";
export type MessageRole = "student" | "assistant" | "system" | "tool";
export type ConversationStatus = "active" | "closed" | "deleted";

export interface PageContext {
  readonly url: string;
  readonly title?: string;
  readonly courseId?: string;
  readonly course?: string;
  readonly moduleId?: string;
  readonly module?: string;
  readonly lessonId?: LessonId;
  readonly lesson?: string;
}

export interface Conversation {
  readonly id: ConversationId;
  readonly tenantId: string;
  readonly studentId?: string;
  readonly identityTier: "verified" | "self_reported" | "anonymous";
  readonly status: ConversationStatus;
  readonly activeModality: ConversationModality;
  readonly pageContext?: PageContext;
  readonly startedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type ChatAttachmentKind =
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "document"
  | "presentation"
  | "spreadsheet"
  | "text"
  | "archive"
  | "other";

export type AttachmentProcessingStatus =
  | "pending_upload"
  | "uploaded"
  | "scanning"
  | "processing"
  | "ready"
  | "quarantined"
  | "rejected"
  | "failed"
  | "expired";

export interface ChatAttachment {
  readonly attachmentId: string;
  readonly tenantId: string;
  readonly conversationId: ConversationId;
  readonly messageId?: MessageId;
  readonly kind: ChatAttachmentKind;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentHash?: string;
  readonly status: AttachmentProcessingStatus;
  /** Present only after upload; clients never send arbitrary storage keys. */
  readonly object?: ProtectedObjectRef;
  readonly extractedTextRef?: ProtectedObjectRef;
  readonly previewRef?: ProtectedObjectRef;
  readonly failureCode?: string;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
}

export interface AttachmentUploadIntent {
  readonly conversationId: ConversationId;
  readonly fileName: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly kind?: ChatAttachmentKind;
  readonly contentHash?: string;
}

export interface AttachmentUploadTicket {
  readonly attachment: ChatAttachment;
  readonly method: "PUT" | "POST";
  readonly uploadUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: IsoTimestamp;
  readonly maxSizeBytes: number;
}

export interface TextPart {
  readonly type: "text";
  readonly text: string;
  readonly format: "plain" | "markdown";
}

export interface AttachmentPart {
  readonly type: "attachment";
  readonly attachmentId: string;
  readonly caption?: string;
}

export interface CitationPart {
  readonly type: "citation";
  readonly citationId: string;
  readonly documentId: DocumentId;
  readonly chunkId?: string;
  readonly label: string;
  readonly excerpt?: string;
  readonly lessonId?: LessonId;
  readonly score?: number;
}

export interface DiagramPart {
  readonly type: "diagram";
  readonly assetId: AssetId;
  readonly caption: string;
  readonly altText: string;
  readonly display: "inline" | "lightbox";
}

export interface ToolResultPart {
  readonly type: "tool_result";
  readonly invocationId: string;
  readonly toolName: string;
  readonly content: JsonObject;
}

export type MessagePart =
  | TextPart
  | AttachmentPart
  | CitationPart
  | DiagramPart
  | ToolResultPart;

export interface ConversationMessage {
  readonly id: MessageId;
  readonly tenantId: string;
  readonly conversationId: ConversationId;
  readonly role: MessageRole;
  /** The modality used to create the turn; rendering always remains multimodal. */
  readonly modality: ConversationModality;
  readonly parts: readonly MessagePart[];
  readonly status:
    | "pending"
    | "streaming"
    | "complete"
    | "interrupted"
    | "failed";
  readonly createdAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly replyToMessageId?: MessageId;
  readonly safeMetadata?: JsonObject;
}

export interface SendMessageInput {
  readonly conversationId?: ConversationId;
  readonly sessionId: SessionId;
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  readonly modality: ConversationModality;
  readonly parts: readonly (TextPart | AttachmentPart)[];
  readonly pageContext?: PageContext;
}

export interface ResumeConversationInput {
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly pageContext?: PageContext;
}

export type ConversationStreamEvent =
  | {
      readonly type: "conversation.started";
      readonly conversation: Conversation;
    }
  | {
      readonly type: "message.accepted";
      readonly message: ConversationMessage;
    }
  | {
      readonly type: "response.text.delta";
      readonly messageId: MessageId;
      readonly sequence: number;
      readonly text: string;
    }
  | {
      readonly type: "response.part";
      readonly messageId: MessageId;
      readonly sequence: number;
      readonly part: Exclude<MessagePart, TextPart>;
    }
  | {
      readonly type: "attachment.status";
      readonly attachment: ChatAttachment;
    }
  | {
      readonly type: "response.status";
      readonly messageId: MessageId;
      readonly status: "retrieving" | "thinking" | "speaking" | "degraded";
    }
  | {
      readonly type: "response.completed";
      readonly message: ConversationMessage;
      readonly retrievalConfidence?: number;
    }
  | {
      readonly type: "response.error";
      readonly messageId?: MessageId;
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly fallback: "retry" | "text" | "none";
    };

export type VoiceUiState =
  | "idle"
  | "requesting_permission"
  | "ready"
  | "listening"
  | "thinking"
  | "speaking"
  | "muted"
  | "ending"
  | "text_fallback"
  | "error";

export interface VoiceConversationSettings {
  readonly enabled: boolean;
  readonly modes: readonly ("push_to_talk" | "tap_to_start")[];
  readonly defaultMode: "push_to_talk" | "tap_to_start";
  readonly voiceId: string;
  readonly locale?: string;
  readonly bargeInEnabled: boolean;
  readonly captionsEnabled: boolean;
  readonly recording: "disabled" | "optional" | "required";
}

/**
 * One orchestration surface for text, voice-created text and file-assisted chat.
 * A realtime transport may feed final transcripts into `send`; partial
 * transcripts are never durable messages.
 */
export interface ConversationService {
  createAttachmentUpload(
    context: RequestContext,
    input: AttachmentUploadIntent,
  ): Promise<AttachmentUploadTicket>;
  confirmAttachmentUpload(
    context: RequestContext,
    attachmentId: string,
    contentHash: string,
  ): Promise<ChatAttachment>;
  send(
    context: RequestContext,
    input: SendMessageInput,
  ): AsyncIterable<ConversationStreamEvent>;
  resume(
    context: RequestContext,
    input: ResumeConversationInput,
  ): Promise<Conversation>;
}
