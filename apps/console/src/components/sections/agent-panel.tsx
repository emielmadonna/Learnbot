"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import ConversationClient from "../../app/app/conversation/conversation-client";
import { UsageSignal } from "../../app/app/usage-signal";
import { AvatarStudio } from "../avatar-studio";
import { brandStyle } from "../app-shell/brand";
import type { AgentConfig, PanelProps, ShellPayload } from "../app-shell/contract";
import { asWorkspace, useDataVersion } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import { ProviderCredentialCard } from "./provider-credential-card";
import type { TenantPlanUsage } from "../../lib/settings/tenant-settings-rpc";
import {
  Button,
  ColorField,
  FileDrop,
  PanelFrame,
  SelectField,
  TextAreaField,
  TextField,
  Toggle,
  contrastRatio,
  normalizeHex,
  passesAA,
} from "../ui";
import sectionStyles from "./sections.module.css";
import styles from "./agent-panel.module.css";

/* ------------------------------------------------------------------ types */

/**
 * Exported so the Settings index (settings-panel.tsx) can drive the same
 * durable configuration record — e.g. the plain-language Length control —
 * without re-implementing defaulting or the save payload shape.
 */
export type Draft = {
  assistantName: string;
  iconGlyph: string;
  logoStorageKey: string | null;
  avatarStorageKey: string | null;
  primaryColor: string;
  accentColor: string;
  surfaceColor: string;
  textColor: string;
  welcomeMessage: string;
  personaInstructions: string;
  tone: string;
  voice: string;
  /** `true` is the durable `"all"` scope; the id list is kept for round-tripping. */
  scopeAll: boolean;
  courseIds: string[];
  /** Generation. Model is one of a platform-allowed set, never free text. */
  model: string;
  temperature: number;
  topP: number;
  maxOutputTokens: number;
  /** Long-form guidance, layered on top of personaInstructions. */
  extendedInstructions: string;
  voiceEnabled: boolean;
  voiceSpeakingRate: number;
  voiceBargeInEnabled: boolean;
  /** Grounding. The refusal wording is a creator field; refusing is not. */
  retrievalCount: number;
  retrievalSimilarityFloor: number;
  noResultsMessage: string;
  escalationEnabled: boolean;
  escalationTrigger: string;
  escalationMessage: string;
};

type ServerState = {
  expectedVersion: number;
  toneOptions: readonly string[];
  modelOptions: readonly string[];
  escalationTriggerOptions: readonly string[];
  defaults: Record<string, unknown>;
  baseline: Draft;
  logoUrl: string | null;
  avatarUrl: string | null;
  liveVersion: number | null;
  draftVersion: number | null;
  updatedAt: string | null;
};

type RevisionSummary = {
  version: number;
  status: "draft" | "published" | "retired";
  assistantName: string;
  welcomeMessage: string;
  tone: string;
  model: string;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FieldKey =
  | "assistantName"
  | "iconGlyph"
  | "welcomeMessage"
  | "personaInstructions"
  | "voice"
  | "courseScope"
  | "extendedInstructions"
  | "temperature"
  | "topP"
  | "maxOutputTokens"
  | "voiceSpeakingRate"
  | "retrievalCount"
  | "retrievalSimilarityFloor"
  | "noResultsMessage"
  | "escalationMessage";

type Errors = Partial<Record<FieldKey, string>>;

type UploadedAsset = { key: string; url: string } | null;
type LearnerPrompt = {
  id: string;
  question: string;
  groundingOutcome: string;
};

/* -------------------------------------------------------------- constants */

const ADMIN_ROLES = new Set(["tenant_owner", "tenant_admin"]);

const FALLBACK_TONES = [
  "neutral",
  "friendly",
  "encouraging",
  "professional",
  "socratic",
  "concise",
] as const;

/** How each stored tone value is described to the person configuring it. */
const TONE_HELP: Record<string, string> = {
  neutral: "Even and factual, with no added warmth or flourish.",
  friendly: "Warm and conversational, still direct.",
  encouraging: "Supportive; acknowledges effort and progress.",
  professional: "Formal, precise and businesslike.",
  socratic: "Leads with guiding questions before giving the answer.",
  concise: "As short as the question allows.",
};

/** Mirrors app_private.agent_allowed_models(). A creator picks from this set
 * only — there is no field anywhere in this panel for an arbitrary model id. */
const FALLBACK_MODELS = [
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
] as const;

const MODEL_HELP: Record<string, string> = {
  "gpt-5.6-terra": "The platform default. Balanced quality and cost.",
  "gpt-5.6-luna": "Fast and economical; best for short, direct answers.",
  "gpt-5.6-sol": "Highest capability; best for dense or difficult material.",
};

/**
 * Plain-language names for the same allowed-model set MODEL_HELP describes.
 * These are curated copy, not measurements — no dollar figure or latency
 * number is attached because neither is exposed to the browser today (see
 * the "Effect of this change" panel below for what IS sourced honestly).
 */
const MODEL_LABEL: Record<string, string> = {
  "gpt-5.6-terra": "Balanced",
  "gpt-5.6-luna": "Fastest",
  "gpt-5.6-sol": "Most capable",
};

const FALLBACK_ESCALATION_TRIGGERS = [
  "manual",
  "always_available",
  "after_no_results",
  "after_repeated_question",
] as const;

const ESCALATION_TRIGGER_LABEL: Record<string, string> = {
  manual: "Manual only",
  always_available: "Always offered",
  after_no_results: "After the assistant can't find an answer",
  after_repeated_question: "After a question repeats without resolving",
};

const ESCALATION_TRIGGER_HELP: Record<string, string> = {
  manual: "A student has to ask for a human; the assistant never offers it.",
  always_available: "A path to a human is shown on every answer.",
  after_no_results:
    "Offered the moment retrieval comes back empty, alongside the refusal.",
  after_repeated_question:
    "Offered once a student asks essentially the same thing again.",
};

/** SVG is rejected by the asset route because it can carry script. */
const ASSET_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

const VOICE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,60}$/u;

/** Server codes become sentences here; a raw code is never shown to a person. */
const CODE_SENTENCES: Record<string, string> = {
  access_denied:
    "Your role cannot change the assistant. Ask a workspace owner to make this change.",
  authentication_required:
    "Your sign-in expired before the change was saved. Reload the page and sign in again.",
  course_scope_invalid:
    "One of the selected courses no longer exists in this workspace. Reload and choose again.",
  idempotency_conflict:
    "A different change was already recorded for this attempt. Reload and try again.",
  invalid_request:
    "The server rejected one of these values. Check the highlighted fields and try again.",
  invalid_origin:
    "This request did not come from an address this workspace trusts, so it was refused before it reached the assistant. Open the console from its usual URL and try again — nothing was saved.",
  membership_not_active:
    "Your membership of this workspace is no longer active, so the change was refused. Ask a workspace owner to reactivate it — nothing was saved.",
  password_change_required:
    "This account still has a temporary password, and nothing can be saved until it is changed. Set a new password, sign in again, then reopen this panel — nothing was saved.",
  request_denied: "The change was refused. Nothing was saved.",
  // 503. Never phrased as the operator's mistake: they did nothing wrong and
  // there is nothing for them to correct.
  request_failed:
    "The assistant service is unavailable right now, so nothing was saved. This is not something you did — wait a moment and try again.",
  revision_not_found:
    "That version no longer exists in this workspace's history. Reload and try again.",
  storage_signing_failed:
    "Storage is unavailable right now, so the image was not uploaded.",
  tenant_not_found: "This workspace is no longer available.",
  tenant_selection_required:
    "No workspace is selected. Reopen the workspace and try again.",
  version_conflict:
    "This configuration was changed somewhere else since you opened it. Reload the latest version before saving, so the other change is not overwritten.",
};

const CONFLICT_SENTENCE = CODE_SENTENCES.version_conflict ?? "";

export function sentenceFor(code: string | null): string {
  const sentence = code === null ? undefined : CODE_SENTENCES[code];
  return sentence ?? "The change could not be completed. Nothing was saved.";
}

/* ---------------------------------------------------------------- parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function hexOr(value: unknown, fallback: string): string {
  const parsed = typeof value === "string" ? normalizeHex(value) : undefined;
  return parsed ?? fallback;
}

function nullableKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function codeOf(value: unknown): string | null {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

/** Short-lived signed read for a stored brand asset. Never guesses a URL. */
async function signedAssetUrl(key: string | null): Promise<string | null> {
  if (key === null) return null;
  try {
    const response = await fetch(
      `/api/agent/asset?key=${encodeURIComponent(key)}`,
      { cache: "no-store", headers: { accept: "application/json" } },
    );
    const body = await readJson(response);
    if (!response.ok || !isRecord(body)) return null;
    return typeof body.url === "string" ? body.url : null;
  } catch {
    return null;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/**
 * One durable configuration version, expressed as editable form state. Missing
 * fields fall back to the server-supplied defaults rather than to invented
 * values, and colours are canonicalised so a lowercase edit of an uppercase
 * stored value does not read as a change.
 */
export function toDraft(
  active: Record<string, unknown> | null,
  defaults: Record<string, unknown>,
): Draft {
  const merged = { ...defaults, ...(active ?? {}) };
  const scope = merged.courseScope;
  return {
    assistantName: text(merged.assistantName, ""),
    iconGlyph: text(merged.iconGlyph, ""),
    logoStorageKey: nullableKey(merged.logoStorageKey),
    avatarStorageKey: nullableKey(merged.avatarStorageKey),
    primaryColor: hexOr(merged.primaryColor, "#2f4bff"),
    accentColor: hexOr(merged.accentColor, "#12b981"),
    surfaceColor: hexOr(merged.surfaceColor, "#f7f8fc"),
    textColor: hexOr(merged.textColor, "#101828"),
    welcomeMessage: text(merged.welcomeMessage, ""),
    personaInstructions: text(merged.personaInstructions, ""),
    tone: text(merged.tone, "neutral"),
    voice: text(merged.voice, ""),
    scopeAll: !Array.isArray(scope),
    courseIds: Array.isArray(scope)
      ? scope.filter((entry): entry is string => typeof entry === "string")
      : [],
    model: text(merged.model, "gpt-5.6-luna"),
    temperature: numberOr(merged.temperature, 0.4),
    topP: numberOr(merged.topP, 1),
    maxOutputTokens: numberOr(merged.maxOutputTokens, 800),
    extendedInstructions: text(merged.extendedInstructions, ""),
    voiceEnabled: boolOr(merged.voiceEnabled, true),
    voiceSpeakingRate: numberOr(merged.voiceSpeakingRate, 1),
    voiceBargeInEnabled: boolOr(merged.voiceBargeInEnabled, true),
    retrievalCount: numberOr(merged.retrievalCount, 6),
    retrievalSimilarityFloor: numberOr(merged.retrievalSimilarityFloor, 0.2),
    noResultsMessage: text(
      merged.noResultsMessage,
      "I couldn't find this in the published learning yet. Try naming the course, lesson, or idea you want to understand.",
    ),
    escalationEnabled: boolOr(merged.escalationEnabled, false),
    escalationTrigger: text(merged.escalationTrigger, "manual"),
    escalationMessage: text(merged.escalationMessage, ""),
  };
}

export function versionOf(row: Record<string, unknown> | null): number | null {
  return row !== null && typeof row.version === "number" ? row.version : null;
}

/**
 * The version an editor must render: the head of the chain. A publish retires
 * the previous live row but leaves older drafts behind, so "draft ?? published"
 * alone would resurrect a stale draft after publishing.
 */
export function pickHead(
  draftRow: Record<string, unknown> | null,
  publishedRow: Record<string, unknown> | null,
  expectedVersion: number,
): Record<string, unknown> | null {
  if (versionOf(draftRow) === expectedVersion) return draftRow;
  if (versionOf(publishedRow) === expectedVersion) return publishedRow;
  const draftVersion = versionOf(draftRow) ?? -1;
  const publishedVersion = versionOf(publishedRow) ?? -1;
  if (draftVersion < 0 && publishedVersion < 0) return null;
  return draftVersion >= publishedVersion ? draftRow : publishedRow;
}

/** Order-independent identity of a draft, so "dirty" never fires spuriously. */
function fingerprint(draft: Draft): string {
  return JSON.stringify({
    ...draft,
    courseIds: draft.scopeAll ? [] : [...draft.courseIds].sort(),
  });
}

/**
 * The exact `/api/agent` POST body for one draft. Exported so any other
 * editor of this same durable record — e.g. the Length control on the
 * Settings index — writes the identical shape `save()` below does, instead
 * of a hand-rolled partial body that could omit a required field.
 */
export function buildAgentSaveBody(
  draft: Draft,
  options: {
    readonly publish: boolean;
    readonly expectedVersion: number;
    readonly idempotencyKey: string;
  },
): Record<string, unknown> {
  return {
    assistantName: draft.assistantName.trim(),
    iconGlyph: draft.iconGlyph.trim() === "" ? null : draft.iconGlyph.trim(),
    primaryColor: draft.primaryColor,
    accentColor: draft.accentColor,
    surfaceColor: draft.surfaceColor,
    textColor: draft.textColor,
    welcomeMessage: draft.welcomeMessage.trim(),
    personaInstructions:
      draft.personaInstructions.trim() === ""
        ? null
        : draft.personaInstructions.trim(),
    tone: draft.tone,
    voice: draft.voice.trim() === "" ? null : draft.voice.trim().toLowerCase(),
    courseScope: draft.scopeAll ? "all" : draft.courseIds,
    logoStorageKey: draft.logoStorageKey,
    avatarStorageKey: draft.avatarStorageKey,
    model: draft.model,
    temperature: draft.temperature,
    topP: draft.topP,
    maxOutputTokens: draft.maxOutputTokens,
    extendedInstructions:
      draft.extendedInstructions.trim() === ""
        ? null
        : draft.extendedInstructions.trim(),
    voiceEnabled: draft.voiceEnabled,
    voiceSpeakingRate: draft.voiceSpeakingRate,
    voiceBargeInEnabled: draft.voiceBargeInEnabled,
    retrievalCount: draft.retrievalCount,
    retrievalSimilarityFloor: draft.retrievalSimilarityFloor,
    noResultsMessage: draft.noResultsMessage.trim(),
    escalationEnabled: draft.escalationEnabled,
    escalationTrigger: draft.escalationTrigger,
    escalationMessage:
      draft.escalationMessage.trim() === ""
        ? null
        : draft.escalationMessage.trim(),
    publish: options.publish,
    expectedVersion: options.expectedVersion,
    idempotencyKey: options.idempotencyKey,
  };
}

/* --------------------------------------------------------------- validation */

function validate(draft: Draft): Errors {
  const errors: Errors = {};
  const name = draft.assistantName.trim();
  if (name.length === 0) errors.assistantName = "Give the assistant a name.";
  else if (name.length > 80) errors.assistantName = "Use 80 characters or fewer.";

  if (draft.iconGlyph.trim().length > 16) {
    errors.iconGlyph = "Use 16 characters or fewer.";
  }

  const welcome = draft.welcomeMessage.trim();
  if (welcome.length === 0) {
    errors.welcomeMessage = "Learners see this first, so it cannot be empty.";
  } else if (welcome.length > 500) {
    errors.welcomeMessage = `Use 500 characters or fewer (currently ${welcome.length}).`;
  }

  if (draft.personaInstructions.trim().length > 4000) {
    errors.personaInstructions = "Use 4000 characters or fewer.";
  }

  const voice = draft.voice.trim().toLowerCase();
  if (voice.length > 0 && !VOICE_PATTERN.test(voice)) {
    errors.voice =
      "Use a lowercase provider voice id: letters, digits, dot, dash or underscore.";
  }

  if (!draft.scopeAll && draft.courseIds.length === 0) {
    errors.courseScope = "Choose at least one course, or answer across all of them.";
  }

  if (draft.extendedInstructions.trim().length > 8000) {
    errors.extendedInstructions = "Use 8000 characters or fewer.";
  }

  if (
    !Number.isFinite(draft.temperature) ||
    draft.temperature < 0 ||
    draft.temperature > 2
  ) {
    errors.temperature = "Use a value between 0 and 2.";
  }
  if (!Number.isFinite(draft.topP) || draft.topP <= 0 || draft.topP > 1) {
    errors.topP = "Use a value greater than 0 and up to 1.";
  }
  if (
    !Number.isInteger(draft.maxOutputTokens) ||
    draft.maxOutputTokens < 64 ||
    draft.maxOutputTokens > 4000
  ) {
    errors.maxOutputTokens = "Use a whole number between 64 and 4000.";
  }
  if (
    !Number.isFinite(draft.voiceSpeakingRate) ||
    draft.voiceSpeakingRate < 0.5 ||
    draft.voiceSpeakingRate > 2
  ) {
    errors.voiceSpeakingRate = "Use a value between 0.5 and 2.";
  }
  if (
    !Number.isInteger(draft.retrievalCount) ||
    draft.retrievalCount < 1 ||
    draft.retrievalCount > 20
  ) {
    errors.retrievalCount = "Use a whole number between 1 and 20.";
  }
  if (
    !Number.isFinite(draft.retrievalSimilarityFloor) ||
    draft.retrievalSimilarityFloor < 0 ||
    draft.retrievalSimilarityFloor > 1
  ) {
    errors.retrievalSimilarityFloor = "Use a value between 0 and 1.";
  }
  const noResults = draft.noResultsMessage.trim();
  if (noResults.length === 0) {
    errors.noResultsMessage =
      "Students see this whenever nothing is found, so it cannot be empty.";
  } else if (noResults.length > 500) {
    errors.noResultsMessage = `Use 500 characters or fewer (currently ${noResults.length}).`;
  }
  const escalationMessage = draft.escalationMessage.trim();
  if (draft.escalationEnabled && escalationMessage.length === 0) {
    errors.escalationMessage =
      "Escalation is on, so students need to see what happens next.";
  } else if (escalationMessage.length > 500) {
    errors.escalationMessage = "Use 500 characters or fewer.";
  }

  return errors;
}

/* ----------------------------------------------------------------- uploads */

/**
 * Signed-URL upload with measurable progress. `fetch` cannot report upload
 * progress, so the transport stays on XHR; nothing else in this file does.
 */
function putWithProgress(
  url: string,
  file: File,
  headers: Record<string, string>,
  onProgress: (ratio: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url, true);
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    });
    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error("Storage rejected the image. It was not saved."));
    });
    request.addEventListener("error", () =>
      reject(new Error("The image never reached storage. Nothing was changed.")),
    );
    request.addEventListener("abort", () =>
      reject(new Error("The upload was cancelled.")),
    );
    request.send(file);
  });
}

/* -------------------------------------------------------------- assistant */

/** The learner-facing conversation, unchanged. */
function AssistantView({
  payload,
  params,
  onConfigure,
}: {
  payload: ShellPayload;
  params: URLSearchParams;
  onConfigure: (() => void) | null;
}) {
  const workspace = asWorkspace(payload);
  const mode = params.get("mode") === "voice" ? "voice" : "text";
  const [learnerPrompts, setLearnerPrompts] = useState<
    { state: "loading" | "ready" | "unavailable"; questions: LearnerPrompt[] }
  >({ state: "loading", questions: [] });
  const [suggestedQuestion, setSuggestedQuestion] = useState<{
    id: string;
    text: string;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/analytics/question-intelligence", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as unknown;
        if (!response.ok || !isRecord(payload) || payload.ok !== true) {
          throw new Error("question_intelligence_unavailable");
        }
        const labels = isRecord(payload.labels) ? payload.labels : null;
        const metrics = labels && isRecord(labels.metrics) ? labels.metrics : null;
        const important =
          metrics && isRecord(metrics.importantQuestions)
            ? metrics.importantQuestions
            : null;
        const value = important && isRecord(important.value) ? important.value : null;
        const candidates = value && Array.isArray(value.questions)
          ? value.questions
          : [];
        const questions = candidates
          .flatMap<LearnerPrompt>((candidate): LearnerPrompt[] => {
            if (!isRecord(candidate)) return [];
            const id =
              typeof candidate.messageId === "string"
                ? candidate.messageId
                : "";
            const question =
              typeof candidate.question === "string"
                ? candidate.question.trim()
                : "";
            if (!id || !question) return [];
            return [
              {
                id,
                question,
                groundingOutcome:
                  typeof candidate.groundingOutcome === "string"
                    ? candidate.groundingOutcome
                    : "unknown",
              },
            ];
          })
          .slice(0, 3);
        setLearnerPrompts({ state: "ready", questions });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLearnerPrompts({ state: "unavailable", questions: [] });
      });
    return () => controller.abort();
  }, []);

  if (!workspace) {
    return (
      <p className={sectionStyles.alert} role="alert">
        The durable learning workspace is unavailable, so the assistant cannot be
        grounded. Nothing was substituted.
      </p>
    );
  }

  return (
    <>
      <header className={styles.talkHeader}>
        <div>
          <p>Talk to your bot</p>
          <h2>{payload.agent.assistantName}</h2>
          <span>
            This is the real grounded conversation. Replies, citations,
            refusals and voice use the same services your learners receive.
          </span>
        </div>
        {onConfigure !== null ? (
          <Button onClick={onConfigure} size="sm">
            Configure
          </Button>
        ) : null}
      </header>
      <div className={styles.talkLayout}>
        <div className={`${sectionStyles.agentFrame} ${styles.talkFrame}`}>
          <UsageSignal eventName="conversation.started" />
          <ConversationClient
            assistantName={payload.agent.assistantName}
            tenantName={payload.tenant.displayName}
            welcomeMessage={payload.agent.welcomeMessage}
            role={workspace.identity.role}
            initialMode={mode}
            initialCourseId={params.get("courseId")}
            initialLessonId={params.get("lessonId")}
            surface="panel"
            courses={workspace.courses.map((course) => ({
              courseId: course.courseId,
              title: course.title,
              modules: course.modules.map((module) => ({
                moduleId: module.moduleId,
                title: module.title,
                lessons: module.lessons.map((lesson) => ({
                  lessonId: lesson.lessonId,
                  title: lesson.title,
                })),
              })),
            }))}
            suggestedQuestion={suggestedQuestion}
          />
        </div>
        <aside className={styles.talkAside}>
          <section>
            <p>Try what they tried</p>
            <h3>Learner questions</h3>
            {learnerPrompts.state === "loading" ? (
              <div className={styles.talkUnavailable}>Loading recorded questions…</div>
            ) : learnerPrompts.state === "unavailable" ? (
              <div className={styles.talkUnavailable}>
                Recorded learner questions could not be loaded.
              </div>
            ) : learnerPrompts.questions.length === 0 ? (
              <div className={styles.talkUnavailable}>
                No privacy-reviewed learner questions were recorded in this
                range.
              </div>
            ) : (
              <div className={styles.talkQuestionList}>
                {learnerPrompts.questions.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() =>
                      setSuggestedQuestion({
                        id: `${entry.id}:${Date.now()}`,
                        text: entry.question,
                      })
                    }
                    type="button"
                  >
                    <span data-outcome={entry.groundingOutcome} aria-hidden="true" />
                    <q>{entry.question}</q>
                  </button>
                ))}
              </div>
            )}
          </section>
          <section>
            <p>Grounding</p>
            <h3>
              {workspace.courses.length === 0
                ? "No courses yet"
                : `${workspace.courses.length} ${workspace.courses.length === 1 ? "course" : "courses"}`}
            </h3>
            <ul className={styles.talkCourseList}>
              {workspace.courses.slice(0, 4).map((course) => (
                <li key={course.courseId}>
                  <span>{course.title}</span>
                  <small>{course.status}</small>
                </li>
              ))}
            </ul>
            {workspace.courses.length > 4 ? (
              <span className={styles.talkMore}>
                +{workspace.courses.length - 4} more
              </span>
            ) : null}
          </section>
        </aside>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------- preview */

/**
 * Miniature of the two surfaces a brand change actually lands on: the
 * persistent workspace header and the assistant conversation. It is themed by
 * the same `brandStyle` derivation the shell uses, applied locally, so the
 * draft is visible before it is saved and no colour is hardcoded here.
 */
function LivePreview({
  draft,
  tenantName,
  logoUrl,
  avatarUrl,
  scopeSummary,
}: {
  draft: Draft;
  tenantName: string;
  logoUrl: string | null;
  avatarUrl: string | null;
  scopeSummary: string;
}) {
  const name = draft.assistantName.trim() || tenantName;
  const glyph = draft.iconGlyph.trim();
  const mark = (Array.from(name)[0] ?? glyph ?? "?").toUpperCase();
  const theme = useMemo(() => {
    const agent: AgentConfig = {
      assistantName: name,
      logoUrl,
      avatarUrl,
      iconGlyph: glyph,
      primaryColor: draft.primaryColor,
      accentColor: draft.accentColor,
      surfaceColor: draft.surfaceColor,
      textColor: draft.textColor,
      welcomeMessage: draft.welcomeMessage,
      personaInstructions: draft.personaInstructions,
      tone: draft.tone,
      voice: draft.voice,
      courseScope: draft.scopeAll ? "all" : draft.courseIds,
    };
    return brandStyle(agent);
  }, [
    avatarUrl,
    draft.accentColor,
    draft.courseIds,
    draft.personaInstructions,
    draft.primaryColor,
    draft.scopeAll,
    draft.surfaceColor,
    draft.textColor,
    draft.tone,
    draft.voice,
    draft.welcomeMessage,
    glyph,
    logoUrl,
    name,
  ]);

  return (
    <div className={styles.previewColumn}>
      <div className={styles.previewHead}>
        <p className={styles.previewEyebrow}>Live preview</p>
        <p className={styles.previewNote}>
          Updates as you edit, and only here. Learners keep seeing the published
          assistant until you press Publish — saving a draft does not change
          what anyone else gets.
        </p>
      </div>

      <div className={styles.preview} style={theme}>
        <div className={styles.previewShell}>
          <div className={styles.previewHeader}>
            <span className={styles.previewMark}>
              {logoUrl === null ? (
                mark
              ) : (
                // Signed storage URL of unknown size — not routable through next/image.
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={logoUrl} />
              )}
            </span>
            <span className={styles.previewBrandText}>
              <b>{name}</b>
              <small>{tenantName}</small>
            </span>
            <span className={styles.previewNav} aria-hidden="true">
              <span data-active="true">Home</span>
              <span>Learning</span>
              <span>Assistant</span>
            </span>
            <span className={styles.previewAvatar}>
              {avatarUrl === null ? (
                (glyph || mark)
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={avatarUrl} />
              )}
            </span>
          </div>

          <div className={styles.previewChat}>
            <div className={styles.previewChatHead}>
              <span className={styles.previewChatMark}>
                {avatarUrl === null ? (
                  (glyph || mark)
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img alt="" src={avatarUrl} />
                )}
              </span>
              <span className={styles.previewChatTitle}>
                <b>{name}</b>
                <small>
                  {draft.tone}
                  {draft.voice.trim().length > 0
                    ? ` · voice ${draft.voice.trim().toLowerCase()}`
                    : ""}
                </small>
              </span>
            </div>

            <p className={styles.previewAssistantBubble}>
              {draft.welcomeMessage.trim().length > 0
                ? draft.welcomeMessage
                : "Your welcome message appears here."}
            </p>

            <p className={styles.previewLearnerBubble}>
              <span className={styles.previewSampleTag}>Sample</span>
              Can you explain this lesson again?
            </p>

            <p className={styles.previewScope}>
              <span aria-hidden="true">◎</span> Grounded in {scopeSummary}
            </p>

            <div className={styles.previewComposer}>
              <span className={styles.previewGlyph}>{glyph || mark}</span>
              <span className={styles.previewComposerText}>
                Ask a question…
              </span>
              <span className={styles.previewSend} aria-hidden="true">
                ↑
              </span>
            </div>
          </div>
        </div>
      </div>

      <p className={styles.previewFoot}>
        The learner question above is sample text, not a stored conversation.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ effect panel */

/**
 * The mockup's "Effect of this change" column, built only from numbers this
 * workspace already has: `tenant_get_billing_summary` (via the same route
 * PlanUsageSettings reads) for volume and durable billed spend. Two numbers
 * the mockup shows are deliberately absent rather than guessed:
 *   - "If you switch to X" costs nothing without real average tokens per
 *     answer per model, which isn't tracked anywhere queryable here.
 *   - "Median response" is `answerLatencyMs` in the analytics RPC, and that
 *     metric's own type is `AnalyticsMetric<never>` with the comment "Never
 *     known today: no request-start timestamp is persisted." Printing a
 *     number for it would be inventing one outright.
 */
function ModelEffectPanel() {
  const [usage, setUsage] = useState<TenantPlanUsage | "loading" | "error">(
    "loading",
  );

  useEffect(() => {
    let active = true;
    void fetch("/api/settings/plan-usage", { cache: "no-store" })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok || !isRecord(body) || body.ok !== true) {
          throw new Error();
        }
        if (active) setUsage(body as TenantPlanUsage);
      })
      .catch(() => {
        if (active) setUsage("error");
      });
    return () => {
      active = false;
    };
  }, []);

  const money =
    usage !== "loading" && usage !== "error"
      ? (micro: number) =>
          new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: usage.currency,
            maximumFractionDigits: 2,
          }).format(micro / usage.microUnitsPerMajorUnit)
      : null;

  return (
    <div className={styles.previewColumn}>
      <div className={styles.previewHead}>
        <p className={styles.previewEyebrow}>Effect of this change</p>
        <p className={styles.previewNote}>
          What this workspace has actually spent and run this month, read from
          the same durable ledger Plan &amp; usage shows.
        </p>
      </div>
      <div className={styles.effectCard}>
        <div className={styles.effectRow}>
          <span>Operations this month</span>
          <strong>
            {usage === "loading"
              ? "…"
              : usage === "error"
                ? "Not known"
                : usage.callsThisMonth.toLocaleString()}
          </strong>
        </div>
        <div className={styles.effectRow}>
          <span>Billed this month</span>
          <strong>
            {usage === "loading"
              ? "…"
              : usage === "error" || money === null
                ? "Not known"
                : money(usage.monthToDateBilledMicro)}
          </strong>
        </div>
        <div className={styles.effectRow}>
          <span>Median response</span>
          <strong className={styles.effectUnknown}>
            Not known — no per-answer response time is recorded yet
          </strong>
        </div>
      </div>
      <p className={styles.previewFoot}>
        Operations and billed cost cover every provider call this workspace
        makes this month — chat, classification, voice and embeddings — not
        chat answers alone, because the ledger does not split spend by
        capability for this readout.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------ draft preview */

type PreviewResult = {
  refused: boolean;
  answer: string;
  sources: {
    courseTitle: string;
    documentTitle: string;
    lessonTitle: string | null;
    excerpt: string;
  }[];
  model: string | null;
};

/**
 * Runs one real turn against the DRAFT above, in an isolated session (PLAN
 * Section 6.3). It never writes a conversation, never touches audit_ledger and
 * is unaffected by Save/Publish — closing the panel without saving loses
 * nothing here because nothing here was ever "in progress".
 */
function PreviewRunner({
  draft,
  disabled,
}: {
  draft: Draft;
  disabled: boolean;
}) {
  const headingId = useId();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PreviewResult | null>(null);

  const run = useCallback(async () => {
    const trimmed = question.trim();
    if (trimmed.length === 0) {
      setError("Type a question to test the draft with.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/agent/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: trimmed,
          assistantName: draft.assistantName,
          tone: draft.tone,
          personaInstructions: draft.personaInstructions,
          extendedInstructions: draft.extendedInstructions,
          retrievalCount: draft.retrievalCount,
          retrievalSimilarityFloor: draft.retrievalSimilarityFloor,
          noResultsMessage: draft.noResultsMessage,
        }),
      });
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || !isRecord(body.preview)) {
        setError(sentenceFor(codeOf(body)));
        return;
      }
      const preview = body.preview;
      const sources = Array.isArray(preview.sources)
        ? preview.sources.flatMap((entry) =>
            isRecord(entry)
              ? [
                  {
                    courseTitle:
                      typeof entry.courseTitle === "string"
                        ? entry.courseTitle
                        : "",
                    documentTitle:
                      typeof entry.documentTitle === "string"
                        ? entry.documentTitle
                        : "",
                    lessonTitle:
                      typeof entry.lessonTitle === "string"
                        ? entry.lessonTitle
                        : null,
                    excerpt:
                      typeof entry.excerpt === "string" ? entry.excerpt : "",
                  },
                ]
              : [],
          )
        : [];
      setResult({
        refused: preview.refused === true,
        answer: typeof preview.answer === "string" ? preview.answer : "",
        sources,
        model: typeof preview.model === "string" ? preview.model : null,
      });
    } catch {
      setError(
        "The preview did not reach the server. Nothing was saved or sent to a student.",
      );
    } finally {
      setBusy(false);
    }
  }, [draft, question]);

  return (
    <section className={styles.group} aria-labelledby={`${headingId}-preview`}>
      <h3 className={styles.groupTitle} id={`${headingId}-preview`}>
        Preview
      </h3>
      <p className={styles.groupNote}>
        Runs one real, grounded turn against everything above, in an isolated
        session. Nothing here is saved as a conversation, and nothing here is
        ever shown to a student — publish first for that.
      </p>
      <TextField
        disabled={disabled || busy}
        label="Test question"
        onChange={(event) => setQuestion(event.target.value)}
        placeholder="Ask the draft assistant something a student might ask…"
        value={question}
      />
      <div className={styles.closeRow}>
        <Button
          disabled={disabled || busy}
          loading={busy}
          loadingLabel="Running…"
          onClick={() => void run()}
        >
          Run preview
        </Button>
      </div>
      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <div className={styles.previewResult} role="status">
          <p
            className={
              result.refused ? styles.previewRefusal : styles.previewTurn
            }
          >
            {result.answer}
          </p>
          {!result.refused && result.sources.length > 0 ? (
            <ul className={styles.previewSourceList}>
              {result.sources.map((source, index) => (
                <li key={`${source.courseTitle}-${index}`}>
                  <strong>{source.courseTitle}</strong>
                  {" — "}
                  {source.lessonTitle ?? source.documentTitle}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------------------------------------------- history */

/**
 * Every draft save and every publish already appends a new, immutable
 * tenant_branding row rather than rewriting one — that row chain is this
 * assistant's revision log, the same idea `course_revisions` gives course
 * content. This lists it and lets a creator restore an old head, same shape
 * as `learning_rollback_course`.
 */
function RevisionHistory({
  busy,
  expectedVersion,
  onRestored,
}: {
  busy: boolean;
  expectedVersion: number;
  onRestored: (
    nextExpectedVersion: number,
    configuration: Record<string, unknown> | null,
  ) => Promise<void>;
}) {
  const headingId = useId();
  const [open, setOpen] = useState(false);
  const [revisions, setRevisions] = useState<RevisionSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/agent/revisions", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await readJson(response);
      if (!response.ok || !isRecord(body) || !Array.isArray(body.revisions)) {
        setError(sentenceFor(codeOf(body)));
        return;
      }
      setRevisions(body.revisions as RevisionSummary[]);
    } catch {
      setError("History did not reach the server. Nothing changed.");
    } finally {
      setLoading(false);
    }
  }, []);

  const restore = useCallback(
    async (version: number, publish: boolean) => {
      if (
        !window.confirm(
          publish
            ? `Publish version ${version}? This replaces what every student sees right now.`
            : `Restore version ${version} as a new draft? Nobody sees it until you publish.`,
        )
      ) {
        return;
      }
      setRestoring(version);
      setError(null);
      try {
        const response = await fetch("/api/agent/revisions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            targetVersion: version,
            publish,
            expectedVersion,
          }),
        });
        const body = await readJson(response);
        if (!response.ok || !isRecord(body)) {
          setError(sentenceFor(codeOf(body)));
          return;
        }
        const nextExpectedVersion =
          typeof body.expectedVersion === "number"
            ? body.expectedVersion
            : expectedVersion;
        const configuration = isRecord(body.configuration)
          ? body.configuration
          : null;
        await onRestored(nextExpectedVersion, configuration);
        await load();
      } catch {
        setError("The restore did not reach the server. Nothing changed.");
      } finally {
        setRestoring(null);
      }
    },
    [expectedVersion, load, onRestored],
  );

  return (
    <section className={styles.group} aria-labelledby={`${headingId}-history`}>
      <h3 className={styles.groupTitle} id={`${headingId}-history`}>
        History
      </h3>
      <p className={styles.groupNote}>
        Every draft save and every publish is kept. Restoring an old version
        never deletes anything — it appends a new one, exactly like saving
        does.
      </p>
      <div className={styles.closeRow}>
        <Button
          disabled={busy || loading}
          loading={loading}
          loadingLabel="Loading…"
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next && revisions === null) void load();
          }}
        >
          {open ? "Hide history" : "View history"}
        </Button>
      </div>
      {error !== null ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {open && revisions !== null ? (
        revisions.length === 0 ? (
          <p className={styles.groupNote}>No saved versions yet.</p>
        ) : (
          <ul className={styles.revisionList}>
            {revisions.map((revision) => (
              <li className={styles.revisionRow} key={revision.version}>
                <span className={styles.revisionMeta}>
                  <strong>v{revision.version}</strong>
                  <span className={styles.courseStatus}>
                    {revision.status}
                  </span>
                  <span>{new Date(revision.updatedAt).toLocaleString()}</span>
                </span>
                <span className={styles.revisionActions}>
                  <Button
                    disabled={busy || restoring !== null}
                    loading={restoring === revision.version}
                    onClick={() => void restore(revision.version, false)}
                    size="sm"
                  >
                    Restore as draft
                  </Button>
                  <Button
                    disabled={busy || restoring !== null}
                    loading={restoring === revision.version}
                    onClick={() => void restore(revision.version, true)}
                    size="sm"
                    variant="primary"
                  >
                    Publish this version
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------- the editor */

type ConfigView = "overview" | "bot" | "appearance" | "model";

function AgentConfigurator({
  payload,
  close,
  refresh,
  onOpenAssistant,
  view,
}: {
  payload: ShellPayload;
  close: () => void;
  refresh: () => Promise<void>;
  onOpenAssistant: () => void;
  view: ConfigView;
}) {
  const dataVersion = useDataVersion();
  const { openPanel, panelHref } = usePanelRouter();
  const headingId = useId();
  const workspace = asWorkspace(payload);
  const courses = useMemo(
    () =>
      (workspace?.courses ?? []).map((course) => ({
        courseId: course.courseId,
        title: course.title,
        status: course.status,
      })),
    [workspace],
  );

  const [server, setServer] = useState<ServerState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState<"draft" | "publish" | null>(null);
  const [status, setStatus] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [uploadedLogo, setUploadedLogo] = useState<UploadedAsset>(null);
  const [uploadedAvatar, setUploadedAvatar] = useState<UploadedAsset>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const objectUrlsRef = useRef<string[]>([]);
  const operationRef = useRef<{ key: string; fingerprint: string } | null>(null);

  /* -- load ------------------------------------------------------------- */

  useEffect(() => {
    let active = true;
    setLoadError(null);

    async function load() {
      const response = await fetch("/api/agent", {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const body = await readJson(response);
      if (!response.ok) throw new Error(sentenceFor(codeOf(body)));
      if (!isRecord(body)) throw new Error(sentenceFor(null));
      const defaults = isRecord(body.defaults) ? body.defaults : {};
      const draftRow = isRecord(body.draft) ? body.draft : null;
      const publishedRow = isRecord(body.published) ? body.published : null;
      const expectedVersion =
        typeof body.expectedVersion === "number" ? body.expectedVersion : 0;
      const head = pickHead(draftRow, publishedRow, expectedVersion);
      const tones = Array.isArray(body.toneOptions)
        ? body.toneOptions.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const models = Array.isArray(body.modelOptions)
        ? body.modelOptions.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const escalationTriggers = Array.isArray(body.escalationTriggerOptions)
        ? body.escalationTriggerOptions.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const baseline = toDraft(head, defaults);
      // Signed reads are resolved from the head's own keys rather than from the
      // list response, so a superseded draft can never supply the preview image.
      const [logoUrl, avatarUrl] = await Promise.all([
        signedAssetUrl(baseline.logoStorageKey),
        signedAssetUrl(baseline.avatarStorageKey),
      ]);
      const next: ServerState = {
        expectedVersion,
        toneOptions: tones.length > 0 ? tones : [...FALLBACK_TONES],
        modelOptions: models.length > 0 ? models : [...FALLBACK_MODELS],
        escalationTriggerOptions:
          escalationTriggers.length > 0
            ? escalationTriggers
            : [...FALLBACK_ESCALATION_TRIGGERS],
        defaults,
        baseline,
        logoUrl,
        avatarUrl,
        liveVersion: versionOf(publishedRow),
        draftVersion: versionOf(draftRow),
        updatedAt:
          head !== null && typeof head.updatedAt === "string"
            ? head.updatedAt
            : null,
      };
      if (!active) return;
      setServer(next);
      setDraft(next.baseline);
      setConflict(false);
      setUploadedLogo(null);
      setUploadedAvatar(null);
    }

    void load().catch((reason: unknown) => {
      if (!active) return;
      setLoadError(reason instanceof Error ? reason.message : sentenceFor(null));
    });

    return () => {
      active = false;
    };
  }, [dataVersion, reloadToken]);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];
    },
    [],
  );

  /* -- derived ---------------------------------------------------------- */

  const errors = useMemo<Errors>(
    () => (draft === null ? {} : validate(draft)),
    [draft],
  );
  const invalid = Object.keys(errors).length > 0;
  const dirty =
    draft !== null &&
    server !== null &&
    fingerprint(draft) !== fingerprint(server.baseline);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    savingRef.current = saving !== null;
  }, [saving]);

  const logoUrl =
    draft === null || draft.logoStorageKey === null
      ? null
      : uploadedLogo !== null && uploadedLogo.key === draft.logoStorageKey
        ? uploadedLogo.url
        : (server?.logoUrl ?? null);
  const avatarUrl =
    draft === null || draft.avatarStorageKey === null
      ? null
      : uploadedAvatar !== null && uploadedAvatar.key === draft.avatarStorageKey
        ? uploadedAvatar.url
        : (server?.avatarUrl ?? null);

  const scopeSummary =
    draft === null || draft.scopeAll
      ? "every course in this workspace"
      : draft.courseIds.length === 1
        ? (courses.find((course) => course.courseId === draft.courseIds[0])
            ?.title ?? "1 selected course")
        : `${draft.courseIds.length} selected courses`;

  /* -- editing ---------------------------------------------------------- */

  const update = useCallback(
    <Key extends keyof Draft>(key: Key, value: Draft[Key]) => {
      setSaveError(null);
      setStatus("");
      setDraft((current) => {
        if (current === null) return current;
        const next: Draft = { ...current };
        next[key] = value;
        return next;
      });
    },
    [],
  );

  const toggleCourse = useCallback((courseId: string, checked: boolean) => {
    setSaveError(null);
    setStatus("");
    setDraft((current) => {
      if (current === null) return current;
      const ids = new Set(current.courseIds);
      if (checked) ids.add(courseId);
      else ids.delete(courseId);
      return { ...current, courseIds: [...ids] };
    });
  }, []);

  /* -- uploads ---------------------------------------------------------- */

  const uploadAsset = useCallback(
    async (
      kind: "logo" | "avatar",
      file: File,
      onProgress: (ratio: number) => void,
    ): Promise<string> => {
      const created = await fetch("/api/agent/asset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          mediaType: file.type,
          sizeBytes: file.size,
        }),
      });
      const body = await readJson(created);
      if (!created.ok) throw new Error(sentenceFor(codeOf(body)));
      if (!isRecord(body) || !isRecord(body.upload)) {
        throw new Error("Storage did not return a usable upload location.");
      }
      const upload = body.upload;
      const objectKey = nullableKey(body.objectKey);
      const url = nullableKey(upload.url);
      if (objectKey === null || url === null) {
        throw new Error("Storage did not return a usable upload location.");
      }
      const required = isRecord(upload.requiredHeaders)
        ? upload.requiredHeaders
        : {};
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(required)) {
        if (typeof value === "string") headers[name] = value;
      }
      await putWithProgress(url, file, headers, onProgress);
      return objectKey;
    },
    [],
  );

  const handleUpload = useCallback(
    async (
      kind: "logo" | "avatar",
      file: File,
      onProgress: (ratio: number) => void,
    ) => {
      const key = await uploadAsset(kind, file, onProgress);
      const preview = URL.createObjectURL(file);
      objectUrlsRef.current.push(preview);
      if (kind === "logo") {
        setUploadedLogo({ key, url: preview });
        update("logoStorageKey", key);
      } else {
        setUploadedAvatar({ key, url: preview });
        update("avatarStorageKey", key);
      }
      setStatus(
        `${kind === "logo" ? "Logo" : "Avatar"} uploaded. Publish to make it live.`,
      );
    },
    [update, uploadAsset],
  );

  /* -- saving ----------------------------------------------------------- */

  const save = useCallback(
    async (publish: boolean) => {
      if (draft === null || server === null) return;
      if (Object.keys(validate(draft)).length > 0) return;

      // One key per distinct payload: a retry of the same save replays the
      // prior write instead of appending a second configuration version, while
      // an edited payload always gets a fresh key.
      const stamp = fingerprint(draft) + String(publish) + String(server.expectedVersion);
      const previous = operationRef.current;
      const idempotencyKey =
        previous !== null && previous.fingerprint === stamp
          ? previous.key
          : `save-${crypto.randomUUID()}`;
      operationRef.current = { key: idempotencyKey, fingerprint: stamp };

      const body = buildAgentSaveBody(draft, {
        publish,
        expectedVersion: server.expectedVersion,
        idempotencyKey,
      });

      setSaving(publish ? "publish" : "draft");
      setSaveError(null);
      setStatus(publish ? "Publishing…" : "Saving draft…");
      try {
        const response = await fetch("/api/agent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const result = await readJson(response);
        if (!response.ok) {
          const code = codeOf(result);
          if (code === "version_conflict") setConflict(true);
          setSaveError(sentenceFor(code));
          setStatus("");
          return;
        }
        const configuration =
          isRecord(result) && isRecord(result.configuration)
            ? result.configuration
            : null;
        const nextVersion =
          isRecord(result) && typeof result.expectedVersion === "number"
            ? result.expectedVersion
            : server.expectedVersion + 1;
        operationRef.current = null;
        setServer((current) =>
          current === null
            ? current
            : {
                ...current,
                expectedVersion: nextVersion,
                baseline: toDraft(configuration, current.defaults),
                liveVersion: publish ? nextVersion : current.liveVersion,
                draftVersion: publish ? current.draftVersion : nextVersion,
              },
        );
        setDraft((current) =>
          configuration === null
            ? current
            : toDraft(configuration, server.defaults),
        );
        setStatus(
          publish
            ? `Published as version ${nextVersion}. Every surface is using it now.`
            : `Saved as draft version ${nextVersion}. Nobody else can see it yet — ${
                server.liveVersion === null
                  ? "this workspace has never published an assistant"
                  : `learners and every answer still use published version ${server.liveVersion}`
              }.`,
        );
        // Re-reads the shell so the header, colours and every panel below it
        // pick up the new brand without a navigation.
        await refresh();
      } catch {
        setSaveError(
          "The change did not reach the server. Nothing was saved — check your connection and try again.",
        );
        setStatus("");
      } finally {
        setSaving(null);
      }
    },
    [draft, refresh, server],
  );

  /* -- closing ---------------------------------------------------------- */

  const requestClose = useCallback(() => {
    if (
      dirtyRef.current &&
      !window.confirm(
        "This assistant has unsaved changes. Close the panel and discard them?",
      )
    ) {
      return;
    }
    close();
  }, [close]);

  // The shell owns Escape, the scrim and its own close button. Guard them from
  // the capture phase so an accidental dismissal cannot discard unsaved edits.
  useEffect(() => {
    function confirmDiscard() {
      return window.confirm(
        "This assistant has unsaved changes. Close the panel and discard them?",
      );
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (!dirtyRef.current || savingRef.current) return;
      if (confirmDiscard()) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    function onClick(event: MouseEvent) {
      if (!dirtyRef.current || savingRef.current) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const root = rootRef.current;
      if (root !== null && root.contains(target)) return;
      const dismissing =
        target.closest('[role="dialog"]') === null ||
        target.closest("button") !== null;
      if (!dismissing) return;
      if (confirmDiscard()) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  /* -- render ----------------------------------------------------------- */

  if (loadError !== null) {
    return (
      <div className={sectionStyles.stack}>
        <p className={sectionStyles.alert} role="alert">
          {loadError}
        </p>
        <Button onClick={() => setReloadToken((value) => value + 1)}>
          Try again
        </Button>
      </div>
    );
  }

  if (draft === null || server === null) {
    return (
      <p className={sectionStyles.loading} role="status">
        Loading the durable assistant configuration…
      </p>
    );
  }

  const busy = saving !== null;
  const canSave = dirty && !invalid && !busy && !conflict;
  const toneOptions = server.toneOptions.map((tone) => ({
    value: tone,
    label: tone.charAt(0).toUpperCase() + tone.slice(1),
  }));
  const modelOptions = server.modelOptions.map((model) => ({
    value: model,
    label: model,
  }));
  const escalationTriggerOptions = server.escalationTriggerOptions.map(
    (trigger) => ({
      value: trigger,
      label: ESCALATION_TRIGGER_LABEL[trigger] ?? trigger,
    }),
  );
  const liveLabel =
    server.liveVersion === null
      ? "Never published"
      : `Live · version ${server.liveVersion}`;
  const showAppearance = view === "overview" || view === "appearance";
  const showBot = view === "overview" || view === "bot";
  const showModel = view === "overview" || view === "model";

  return (
    <div className={styles.editorRoot} ref={rootRef}>
      <PanelFrame
        autoFocus={false}
        className={styles.frame}
        description="Everything here is stored per workspace. Publish makes the selected identity, behaviour and grounding live; a saved draft stays private."
        eyebrow="Assistant configuration"
        footer={
          <>
            <Button
              disabled={!dirty || busy}
              onClick={() => {
                setDraft(server.baseline);
                setSaveError(null);
                setStatus("Reverted to the saved configuration.");
              }}
            >
              Discard changes
            </Button>
            <Button
              disabled={!canSave}
              loading={saving === "draft"}
              loadingLabel="Saving…"
              onClick={() => void save(false)}
            >
              Save draft
            </Button>
            <Button
              disabled={!canSave}
              loading={saving === "publish"}
              loadingLabel="Publishing…"
              onClick={() => void save(true)}
              variant="primary"
            >
              Publish
            </Button>
          </>
        }
        footerLead={
          <>
            <span>
              {dirty ? "Unsaved changes" : liveLabel}
              {server.draftVersion !== null && server.liveVersion !== server.draftVersion
                ? ` · draft ${server.draftVersion} is not live`
                : ""}
            </span>
            <span aria-live="polite" className={styles.statusLine} role="status">
              {status}
            </span>
          </>
        }
        headerActions={
          <Button onClick={onOpenAssistant} size="sm">
            Try it
          </Button>
        }
        side="inline"
        title={draft.assistantName.trim() || "Your assistant"}
      >
        <nav className={styles.subnav} aria-label="Assistant settings">
          {[
            { key: "overview", label: "Overview" },
            { key: "bot", label: "The bot" },
            { key: "appearance", label: "Appearance" },
            { key: "model", label: "Model & grounding" },
          ].map((item) => {
            const href = panelHref(
              "agent",
              item.key === "overview" ? undefined : { view: item.key },
            );
            return (
              <a
                aria-current={view === item.key ? "page" : undefined}
                className={styles.subnavLink}
                href={href}
                key={item.key}
                onClick={(event) => {
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey ||
                    event.button !== 0
                  ) {
                    return;
                  }
                  event.preventDefault();
                  openPanel(
                    "agent",
                    item.key === "overview" ? undefined : { view: item.key },
                  );
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>
        <div className={styles.layout}>
          <div className={styles.form}>
            {conflict ? (
              <div className={styles.conflict} role="alert">
                <p>{CONFLICT_SENTENCE}</p>
                <Button
                  onClick={() => {
                    setConflict(false);
                    setSaveError(null);
                    setReloadToken((value) => value + 1);
                  }}
                  variant="danger"
                >
                  Reload the latest version
                </Button>
              </div>
            ) : null}

            {saveError !== null && !conflict ? (
              <p className={styles.error} role="alert">
                {saveError}
              </p>
            ) : null}

            {/*
             * A draft is stored, versioned and completely invisible outside
             * this panel: learning_get_workspace prefers the published branding
             * row and the answer path reads only the published row. Saving one
             * must never be mistaken for changing the assistant.
             */}
            {server.draftVersion !== null &&
            server.draftVersion !== server.liveVersion ? (
              <p className={styles.draftNotice} role="status">
                <strong>
                  Draft version {server.draftVersion} is saved, and nobody can
                  see it.
                </strong>
                <span>
                  {server.liveVersion === null
                    ? "This workspace has never published an assistant, so learners still get the default name, colours and welcome, and answers carry no persona of yours. Publish to change that."
                    : `Learners, the chat header and every answer the assistant gives still come from published version ${server.liveVersion}. Publish to replace it.`}
                </span>
              </p>
            ) : null}

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-identity`}
              hidden={!(showAppearance || showBot)}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-identity`}>
                Identity
              </h3>
              <p className={styles.groupNote}>
                The name and mark learners see in the header and in every reply.
              </p>
              <div className={styles.pair}>
                <TextField
                  autoComplete="off"
                  disabled={busy}
                  error={errors.assistantName}
                  label="Assistant name"
                  maxLength={80}
                  onChange={(event) =>
                    update("assistantName", event.target.value)
                  }
                  required
                  value={draft.assistantName}
                />
                <TextField
                  autoComplete="off"
                  disabled={busy}
                  error={errors.iconGlyph}
                  help="Shown when there is no image. One letter or emoji."
                  label="Icon glyph"
                  maxLength={16}
                  onChange={(event) => update("iconGlyph", event.target.value)}
                  value={draft.iconGlyph}
                />
              </div>
              <div className={styles.pair}>
                <FileDrop
                  accept={ASSET_TYPES}
                  disabled={busy}
                  help="Square PNG, JPEG or WebP, up to 2 MB. Used in the workspace header."
                  label="Logo"
                  onRemove={() => {
                    setUploadedLogo(null);
                    update("logoStorageKey", null);
                  }}
                  onUpload={(file, onProgress) =>
                    handleUpload("logo", file, onProgress)
                  }
                  placeholder={draft.iconGlyph.trim() || "Logo"}
                  previewUrl={logoUrl}
                />
                <FileDrop
                  accept={ASSET_TYPES}
                  disabled={busy}
                  help="The face of the assistant in conversation."
                  label="Assistant avatar"
                  onRemove={() => {
                    setUploadedAvatar(null);
                    update("avatarStorageKey", null);
                  }}
                  onUpload={(file, onProgress) =>
                    handleUpload("avatar", file, onProgress)
                  }
                  placeholder={draft.iconGlyph.trim() || "Avatar"}
                  previewUrl={avatarUrl}
                />
              </div>
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-icon`}
              hidden={!showAppearance}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-icon`}>
                Icon
              </h3>
              <p className={styles.groupNote}>
                Shown wherever there is no logo image — prefer an uploaded
                logo above for a wordmark or crest; these are single-glyph
                presets for everyone else.
              </p>
              <div className={styles.iconGrid} role="radiogroup" aria-label="Icon preset">
                {[
                  { glyph: "💬", label: "Chat bubble" },
                  { glyph: "✉️", label: "Message" },
                  { glyph: "📖", label: "Book" },
                  { glyph: "❓", label: "Help" },
                  { glyph: "👤", label: "Person" },
                  { glyph: "💡", label: "Idea" },
                  { glyph: "◎", label: "Corso brand mark (default)" },
                ].map((option) => (
                  <button
                    aria-label={option.label}
                    aria-pressed={draft.iconGlyph.trim() === option.glyph || undefined}
                    className={styles.iconChip}
                    data-selected={
                      draft.iconGlyph.trim() === option.glyph || undefined
                    }
                    disabled={busy}
                    key={option.glyph}
                    onClick={() => update("iconGlyph", option.glyph)}
                    type="button"
                  >
                    {option.glyph}
                  </button>
                ))}
              </div>
            </section>

            <div hidden={!showAppearance}>
              <AvatarStudio
                assistantName={draft.assistantName}
                disabled={busy}
                monogram={
                  (draft.assistantName.trim().charAt(0) ||
                    draft.iconGlyph.trim().charAt(0) ||
                    "A").toUpperCase()
                }
              />
            </div>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-colour`}
              hidden={!showAppearance}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-colour`}>
                Colour
              </h3>
              <p className={styles.groupNote}>
                These four values theme the entire product, not just the chat.
              </p>
              {/*
               * Curated preset values a creator can click instead of typing a
               * hex — content, not UI chrome, so the "never hardcode a hex"
               * rule (which protects this file's own theme surfaces) does not
               * apply to the swatches themselves. They set Primary, the one
               * colour that reaches the launcher, header and chat bubbles.
               */}
              <div className={styles.swatchRow} role="group" aria-label="Preset colours">
                {[
                  "#4a637f",
                  "#1d7a33",
                  "#b45309",
                  "#c53030",
                  "#7b3fa0",
                  "#0e7490",
                  "#1d1d1f",
                ].map((hex) => (
                  <button
                    aria-label={`Use ${hex} as the primary colour`}
                    aria-pressed={
                      normalizeHex(draft.primaryColor) === hex || undefined
                    }
                    className={styles.swatch}
                    data-selected={
                      normalizeHex(draft.primaryColor) === hex || undefined
                    }
                    disabled={busy}
                    key={hex}
                    onClick={() => update("primaryColor", hex)}
                    style={{ background: hex }}
                    type="button"
                  />
                ))}
              </div>
              {(() => {
                const ratio = contrastRatio(draft.primaryColor, "#ffffff");
                return (
                  <p className={styles.contrastReadout}>
                    <span
                      className={styles.contrastDot}
                      data-pass={
                        ratio !== undefined && passesAA(ratio, "ui")
                          ? "true"
                          : "false"
                      }
                      aria-hidden="true"
                    />
                    {ratio === undefined
                      ? "Contrast against white could not be measured — the primary colour is not a readable hex value."
                      : `Contrast against white: ${ratio.toFixed(1)}:1 — ${
                          passesAA(ratio, "ui")
                            ? "clears the 3:1 minimum for UI elements."
                            : "below the 3:1 minimum for UI elements. Darken it for readable buttons and the launcher."
                        }`}
                  </p>
                );
              })()}
              <div className={styles.pair}>
                <ColorField
                  contrastAgainst={draft.surfaceColor}
                  contrastLabel="primary on surface"
                  disabled={busy}
                  label="Primary"
                  onChange={(hex) => update("primaryColor", hex)}
                  value={draft.primaryColor}
                />
                <ColorField
                  contrastAgainst={draft.surfaceColor}
                  contrastLabel="accent on surface"
                  contrastLevel="ui"
                  disabled={busy}
                  label="Accent"
                  onChange={(hex) => update("accentColor", hex)}
                  value={draft.accentColor}
                />
                <ColorField
                  disabled={busy}
                  help="Page and card background."
                  label="Surface"
                  onChange={(hex) => update("surfaceColor", hex)}
                  value={draft.surfaceColor}
                />
                <ColorField
                  contrastAgainst={draft.surfaceColor}
                  contrastLabel="body text on surface"
                  disabled={busy}
                  label="Text"
                  onChange={(hex) => update("textColor", hex)}
                  value={draft.textColor}
                />
              </div>
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-provider`}
              hidden={!showModel}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-provider`}>
                Provider
              </h3>
              <p className={styles.groupNote}>
                OpenAI is available as a platform-managed service or with this
                workspace&apos;s own encrypted key. Removing a workspace key
                returns the assistant to the managed provider automatically.
              </p>
              <ProviderCredentialCard />
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-generation`}
              hidden={!showModel}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-generation`}>
                Generation
              </h3>
              <p className={styles.groupNote}>
                Retrieval is identical whichever model you pick — only the
                writing changes. The defaults are tuned for this assistant
                already; most workspaces never need to touch these.
              </p>
              <div
                aria-label="Model"
                className={styles.modelCards}
                role="radiogroup"
              >
                {modelOptions.map((option) => {
                  const isDefault = server.defaults.model === option.value;
                  return (
                    <label
                      className={styles.modelCard}
                      data-selected={draft.model === option.value || undefined}
                      key={option.value}
                    >
                      <input
                        checked={draft.model === option.value}
                        disabled={busy}
                        name={`${headingId}-model`}
                        onChange={() => update("model", option.value)}
                        type="radio"
                      />
                      <span className={styles.modelCardBody}>
                        <strong>
                          {MODEL_LABEL[option.value] ?? option.label}
                          {isDefault ? " — recommended" : ""}
                        </strong>
                        <small>
                          {MODEL_HELP[option.value] ??
                            "Chosen from the platform-allowed set only."}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className={styles.groupNote}>
                Cost and typical response time aren&rsquo;t shown per option:
                neither the price book (<code>cost-metering.ts</code>) nor
                per-answer timing is exposed to this panel today, and a
                guessed figure would be worse than none.
              </p>

              <div className={styles.sliderField}>
                <div className={styles.sliderHead}>
                  <span className={styles.sliderLabel}>Creativity</span>
                  <span className={styles.sliderValue}>
                    {draft.temperature.toFixed(2)}
                  </span>
                </div>
                <input
                  aria-describedby={`${headingId}-creativity-note`}
                  aria-label="Creativity"
                  className={styles.slider}
                  disabled={busy}
                  max={2}
                  min={0}
                  onChange={(event) =>
                    update("temperature", Number(event.target.value))
                  }
                  step={0.05}
                  type="range"
                  value={draft.temperature}
                />
                <p className={styles.sliderCaption} id={`${headingId}-creativity-note`}>
                  Low is right for a course bot. Above about 1.0 it starts
                  paraphrasing your lessons instead of quoting them.
                </p>
                {errors.temperature !== undefined ? (
                  <p className={styles.error} role="alert">
                    {errors.temperature}
                  </p>
                ) : null}
              </div>

              <TextField
                disabled={busy}
                error={errors.topP}
                help="Narrows how many candidate words the model considers. Leave at 1 unless you know you want less."
                label="Top-p"
                max={1}
                min={0.01}
                onChange={(event) =>
                  update("topP", Number(event.target.value))
                }
                step={0.01}
                type="number"
                value={draft.topP}
              />

              <details className={styles.disclosureRow}>
                <summary>
                  <span>Longest answer</span>
                  <span className={styles.disclosureValue}>
                    {draft.maxOutputTokens.toLocaleString()} tokens
                  </span>
                </summary>
                <div className={styles.disclosureBody}>
                  <TextField
                    disabled={busy}
                    error={errors.maxOutputTokens}
                    help="Upper bound on how long a single answer can run, in tokens (there is no honest words-per-token conversion to show instead)."
                    label="Max output tokens"
                    max={4000}
                    min={64}
                    onChange={(event) =>
                      update("maxOutputTokens", Number(event.target.value))
                    }
                    step={1}
                    type="number"
                    value={draft.maxOutputTokens}
                  />
                </div>
              </details>
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-voice`}
              hidden={!showBot}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-voice`}>
                How it speaks
              </h3>
              <TextAreaField
                disabled={busy}
                error={errors.welcomeMessage}
                help={`The first thing a learner reads. ${draft.welcomeMessage.trim().length}/500 characters.`}
                label="Welcome message"
                maxLength={500}
                onChange={(event) => update("welcomeMessage", event.target.value)}
                required
                rows={3}
                value={draft.welcomeMessage}
              />
              <TextAreaField
                disabled={busy}
                error={errors.personaInstructions}
                help="Private guidance for the assistant: voice, emphasis and framing. It never overrides grounding or citation rules, and learners never see it."
                label="Persona instructions"
                maxLength={4000}
                onChange={(event) =>
                  update("personaInstructions", event.target.value)
                }
                rows={5}
                value={draft.personaInstructions}
              />
              <TextAreaField
                disabled={busy}
                error={errors.extendedInstructions}
                help={`Longer, free-form guidance for edge cases the fields above don't cover. Same rule as persona instructions: it layers on top of the platform's grounding and safety rules and can never replace them. ${draft.extendedInstructions.trim().length}/8000 characters.`}
                label="Additional instructions"
                maxLength={8000}
                onChange={(event) =>
                  update("extendedInstructions", event.target.value)
                }
                rows={6}
                value={draft.extendedInstructions}
              />
              <div className={styles.pair}>
                <SelectField
                  disabled={busy}
                  help={TONE_HELP[draft.tone] ?? "How the assistant is asked to sound."}
                  label="Tone"
                  onChange={(event) => update("tone", event.target.value)}
                  options={toneOptions}
                  value={draft.tone}
                />
                <TextField
                  autoComplete="off"
                  disabled={busy}
                  error={errors.voice}
                  help="Spoken voice id from your provider, e.g. harbor. Leave empty to use the workspace default."
                  label="Voice"
                  maxLength={61}
                  onChange={(event) => update("voice", event.target.value)}
                  spellCheck={false}
                  value={draft.voice}
                />
              </div>
              <Toggle
                bordered
                checked={draft.voiceEnabled}
                description="Off: this assistant only ever appears as text, even if the host page offers a microphone."
                disabled={busy}
                label="Offer voice at all"
                onChange={(checked) => update("voiceEnabled", checked)}
              />
              {draft.voiceEnabled ? (
                <div className={styles.pair}>
                  <TextField
                    disabled={busy}
                    error={errors.voiceSpeakingRate}
                    help="1 is normal pace. Below 1 is slower, above 1 is faster."
                    label="Speaking rate"
                    max={2}
                    min={0.5}
                    onChange={(event) =>
                      update("voiceSpeakingRate", Number(event.target.value))
                    }
                    step={0.05}
                    type="number"
                    value={draft.voiceSpeakingRate}
                  />
                  <Toggle
                    bordered
                    checked={draft.voiceBargeInEnabled}
                    description="On: a student can start talking while the assistant is still speaking and it stops to listen."
                    disabled={busy}
                    label="Allow barge-in"
                    onChange={(checked) =>
                      update("voiceBargeInEnabled", checked)
                    }
                  />
                </div>
              ) : null}
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-scope`}
              hidden={!showBot}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-scope`}>
                What it can answer about
              </h3>
              <Toggle
                bordered
                checked={draft.scopeAll}
                description="Off: pick the exact courses this assistant may draw on."
                disabled={busy}
                label="Answer across every course"
                onChange={(checked) => update("scopeAll", checked)}
              />
              {draft.scopeAll ? null : courses.length === 0 ? (
                <p className={styles.groupNote}>
                  This workspace has no courses yet, so there is nothing to scope
                  to. Leave the switch on until a course exists.
                </p>
              ) : (
                <fieldset className={styles.courseList}>
                  <legend className={styles.courseLegend}>
                    Courses in scope
                  </legend>
                  {courses.map((course) => (
                    <label className={styles.courseRow} key={course.courseId}>
                      <input
                        checked={draft.courseIds.includes(course.courseId)}
                        disabled={busy}
                        onChange={(event) =>
                          toggleCourse(course.courseId, event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span className={styles.courseTitle}>{course.title}</span>
                      <span className={styles.courseStatus}>
                        {course.status}
                      </span>
                    </label>
                  ))}
                  {errors.courseScope !== undefined ? (
                    <p className={styles.error} role="alert">
                      {errors.courseScope}
                    </p>
                  ) : null}
                </fieldset>
              )}
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-grounding`}
              hidden={!showModel}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-grounding`}>
                Grounding
              </h3>
              <p className={styles.groupNote}>
                How the assistant searches its own material before it
                answers, and what a student sees when nothing turns up.
                Refusing on an empty search is not optional here — only the
                wording of that refusal is yours to set.
              </p>
              <div className={styles.sliderField}>
                <div className={styles.sliderHead}>
                  <span className={styles.sliderLabel}>
                    Source match threshold
                  </span>
                  <span className={styles.sliderValue}>
                    {draft.retrievalSimilarityFloor.toFixed(2)}
                  </span>
                </div>
                <input
                  aria-describedby={`${headingId}-threshold-note`}
                  aria-label="Source match threshold"
                  className={styles.slider}
                  disabled={busy}
                  max={1}
                  min={0}
                  onChange={(event) =>
                    update(
                      "retrievalSimilarityFloor",
                      Number(event.target.value),
                    )
                  }
                  step={0.05}
                  type="range"
                  value={draft.retrievalSimilarityFloor}
                />
                <p className={styles.sliderCaption} id={`${headingId}-threshold-note`}>
                  Below this, a passage is treated as not found and the
                  assistant refuses instead of answering. Lower it and you get
                  more answers — and more wrong ones.
                </p>
                {errors.retrievalSimilarityFloor !== undefined ? (
                  <p className={styles.error} role="alert">
                    {errors.retrievalSimilarityFloor}
                  </p>
                ) : null}
              </div>

              <details className={styles.disclosureRow}>
                <summary>
                  <span>Sources per answer</span>
                  <span className={styles.disclosureValue}>
                    Up to {draft.retrievalCount}
                  </span>
                </summary>
                <div className={styles.disclosureBody}>
                  <TextField
                    disabled={busy}
                    error={errors.retrievalCount}
                    help="How many passages are retrieved for each question."
                    label="Passages retrieved"
                    max={20}
                    min={1}
                    onChange={(event) =>
                      update("retrievalCount", Number(event.target.value))
                    }
                    step={1}
                    type="number"
                    value={draft.retrievalCount}
                  />
                </div>
              </details>
              <TextAreaField
                disabled={busy}
                error={errors.noResultsMessage}
                help={`Shown whenever the search above comes back empty. ${draft.noResultsMessage.trim().length}/500 characters.`}
                label="Nothing found message"
                maxLength={500}
                onChange={(event) =>
                  update("noResultsMessage", event.target.value)
                }
                required
                rows={2}
                value={draft.noResultsMessage}
              />
            </section>

            <section
              className={styles.group}
              aria-labelledby={`${headingId}-escalation`}
              hidden={!showBot}
            >
              <h3 className={styles.groupTitle} id={`${headingId}-escalation`}>
                Escalation
              </h3>
              <Toggle
                bordered
                checked={draft.escalationEnabled}
                description="Off: a student who needs a human has no path to one from inside the assistant."
                disabled={busy}
                label="Offer a path to a human"
                onChange={(checked) => update("escalationEnabled", checked)}
              />
              {draft.escalationEnabled ? (
                <>
                  <SelectField
                    disabled={busy}
                    help={
                      ESCALATION_TRIGGER_HELP[draft.escalationTrigger] ??
                      "When the option to escalate appears."
                    }
                    label="When it's offered"
                    onChange={(event) =>
                      update("escalationTrigger", event.target.value)
                    }
                    options={escalationTriggerOptions}
                    value={draft.escalationTrigger}
                  />
                  <TextAreaField
                    disabled={busy}
                    error={errors.escalationMessage}
                    help={`Exactly what a student reads when this is offered. ${draft.escalationMessage.trim().length}/500 characters.`}
                    label="What the student sees"
                    maxLength={500}
                    onChange={(event) =>
                      update("escalationMessage", event.target.value)
                    }
                    required
                    rows={2}
                    value={draft.escalationMessage}
                  />
                </>
              ) : null}
            </section>

            <div hidden={view === "appearance"}>
              <PreviewRunner disabled={busy} draft={draft} />
            </div>

            <div hidden={view !== "overview"}>
              <RevisionHistory
                busy={busy}
                expectedVersion={server.expectedVersion}
                onRestored={async (nextExpectedVersion, configuration) => {
                  setServer((current) =>
                    current === null
                      ? current
                      : {
                          ...current,
                          expectedVersion: nextExpectedVersion,
                          baseline: toDraft(configuration, current.defaults),
                          liveVersion:
                            configuration !== null &&
                            configuration.status === "published"
                              ? nextExpectedVersion
                              : current.liveVersion,
                          draftVersion:
                            configuration !== null &&
                            configuration.status === "draft"
                              ? nextExpectedVersion
                              : current.draftVersion,
                        },
                  );
                  setDraft(
                    configuration === null
                      ? null
                      : toDraft(configuration, server.defaults),
                  );
                  setStatus(`Restored version ${nextExpectedVersion}.`);
                  await refresh();
                }}
              />
            </div>

            <p className={styles.boundary}>
              <strong>Nothing here is invented.</strong> Every field is read from
              and written to this workspace&rsquo;s durable configuration record.
              A save appends a new version rather than overwriting the last one,
              and a conflicting change elsewhere stops the save instead of
              silently winning.
            </p>

            <div className={styles.closeRow}>
              <Button onClick={requestClose}>Close panel</Button>
            </div>
          </div>

          {view === "model" ? (
            <ModelEffectPanel />
          ) : (
            <LivePreview
              avatarUrl={avatarUrl}
              draft={draft}
              logoUrl={logoUrl}
              scopeSummary={scopeSummary}
              tenantName={payload.tenant.displayName}
            />
          )}
        </div>
      </PanelFrame>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

/**
 * Assistant panel.
 *
 * For a workspace owner or admin this is the configuration editor: name, mark,
 * colours, copy, persona, tone, voice and course scope, all persisted through
 * `tenant_update_agent_configuration` with optimistic concurrency. Everyone
 * else — and any deep link that asked for a conversation (`?mode=voice`,
 * `?mode=chat`) — gets the grounded conversation, hosted unchanged.
 */
export function AgentPanel({ payload, params, close, refresh }: PanelProps) {
  const { openPanel } = usePanelRouter();
  const workspace = asWorkspace(payload);
  const role = workspace?.identity.role ?? payload.role;
  const canConfigure = ADMIN_ROLES.has(role);
  const mode = params.get("mode");
  const requestedView = params.get("view");
  const wantsConversation =
    mode === "voice" || mode === "chat" || requestedView === "talk";
  const view: ConfigView =
    requestedView === "bot" ||
    requestedView === "appearance" ||
    requestedView === "model"
      ? requestedView
      : "overview";

  if (!canConfigure || wantsConversation) {
    return (
      <AssistantView
        onConfigure={
          canConfigure ? () => openPanel("agent", { mode: null }) : null
        }
        params={params}
        payload={payload}
      />
    );
  }

  return (
    <AgentConfigurator
      close={close}
      onOpenAssistant={() => openPanel("agent", { mode: "chat" })}
      payload={payload}
      refresh={refresh}
      view={view}
    />
  );
}

export default AgentPanel;
