/**
 * JSON-safe values accepted across service and provider boundaries.
 *
 * Secrets and binary bodies intentionally do not fit this type. Pass those by
 * protected reference or through a capability-specific byte stream.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type IsoTimestamp = string;
export type CurrencyCode = string;
export type ContentHash = string;

export type TenantId = string;
export type ActorId = string;
export type RequestId = string;
export type TraceId = string;
export type SessionId = string;
export type ConversationId = string;
export type MessageId = string;
export type CourseId = string;
export type ModuleId = string;
export type LessonId = string;
export type DocumentId = string;
export type ChunkId = string;
export type AssetId = string;

export interface PageInfo<TCursor extends string = string> {
  readonly items: readonly JsonValue[];
  readonly nextCursor?: TCursor;
}

export interface PageRequest<TCursor extends string = string> {
  readonly cursor?: TCursor;
  readonly limit?: number;
}

export interface ProtectedObjectRef {
  readonly objectId: string;
  readonly storageKey: string;
  readonly contentHash: ContentHash;
  readonly sizeBytes: number;
  readonly mediaType: string;
}

export interface ContractError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly safeDetails?: JsonObject;
}

export type Outcome<T, E extends ContractError = ContractError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export type AsyncByteStream = AsyncIterable<Uint8Array>;
