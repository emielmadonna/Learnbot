"use client";

import Link from "next/link";
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import styles from "./conversation.module.css";

type CourseOption = {
  courseId: string;
  title: string;
  modules: Array<{
    moduleId: string;
    title: string;
    lessons: Array<{ lessonId: string; title: string }>;
  }>;
};

type SourceEvidence = {
  sourceId: string;
  title: string;
  excerpt: string;
  courseTitle: string | null;
  lessonTitle: string | null;
};

type ConversationMessage = {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string | null;
  sources: SourceEvidence[];
};

type ConversationPayload = {
  conversationId: string | null;
  messages: ConversationMessage[];
};

type JsonRecord = Record<string, unknown>;
type VoicePhase =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";
type VoiceReadiness = "unchecked" | "checking" | "ready" | "unavailable";
type LearningIntent = "explain" | "practice" | "check";

const MAX_VOICE_TURN_MS = 45_000;

const starterPrompts = [
  "What should I learn next?",
  "Explain the key idea in simple terms.",
  "Quiz me on what I just learned.",
];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function normalizeSource(value: unknown, index: number): SourceEvidence | null {
  if (!isRecord(value)) return null;
  const excerpt =
    stringValue(value.excerpt) ??
    stringValue(value.content) ??
    stringValue(value.text);
  if (!excerpt) return null;
  return {
    sourceId:
      stringValue(value.sourceId) ??
      stringValue(value.chunkId) ??
      `source-${index}`,
    title:
      stringValue(value.title) ??
      stringValue(value.lessonTitle) ??
      "Learning source",
    excerpt,
    courseTitle: stringValue(value.courseTitle),
    lessonTitle: stringValue(value.lessonTitle),
  };
}

function normalizeMessage(
  value: unknown,
  index: number,
): ConversationMessage | null {
  if (!isRecord(value)) return null;
  const roleValue =
    stringValue(value.role) ?? stringValue(value.actorType);
  const role =
    roleValue === "assistant"
      ? "assistant"
      : roleValue === "user" ||
          roleValue === "student" ||
          roleValue === "owner" ||
          roleValue === "creator"
        ? "user"
        : null;
  const content =
    stringValue(value.content) ??
    stringValue(value.text) ??
    stringValue(value.body);
  if (!role || !content) return null;
  const structuredContent = isRecord(value.structuredContent)
    ? value.structuredContent
    : null;
  const sourceValue = Array.isArray(value.sources)
    ? value.sources
    : Array.isArray(structuredContent?.sources)
      ? structuredContent.sources
      : [];
  const sources = Array.isArray(sourceValue)
    ? sourceValue
        .map((source, sourceIndex) => normalizeSource(source, sourceIndex))
        .filter((source): source is SourceEvidence => Boolean(source))
    : [];
  return {
    messageId:
      stringValue(value.messageId) ??
      stringValue(value.id) ??
      `message-${index}`,
    role,
    content,
    createdAt:
      stringValue(value.createdAt) ?? stringValue(value.created_at) ?? null,
    sources,
  };
}

function normalizeConversation(value: unknown): ConversationPayload {
  if (!isRecord(value)) return { conversationId: null, messages: [] };
  const data = isRecord(value.data) ? value.data : value;
  const conversation = isRecord(data.conversation)
    ? data.conversation
    : Array.isArray(data.conversations) && isRecord(data.conversations[0])
      ? data.conversations[0]
      : data;
  const messagesValue = Array.isArray(data.messages)
    ? data.messages
    : Array.isArray(conversation.messages)
      ? conversation.messages
      : [];
  const messages = messagesValue
    .map((message, index) => normalizeMessage(message, index))
    .filter((message): message is ConversationMessage => Boolean(message));
  return {
    conversationId:
      stringValue(conversation.conversationId) ??
      stringValue(conversation.id) ??
      stringValue(data.conversationId),
    messages,
  };
}

function normalizeResponse(
  value: unknown,
  fallbackConversationId: string | null,
): {
  conversationId: string | null;
  message: ConversationMessage | null;
} {
  if (!isRecord(value)) {
    return { conversationId: fallbackConversationId, message: null };
  }
  const data = isRecord(value.data) ? value.data : value;
  const candidate =
    data.message ?? data.assistantMessage ?? data.response ?? data.answer;
  let message = normalizeMessage(candidate, 0);
  if (!message) {
    const content =
      stringValue(data.content) ??
      stringValue(data.text) ??
      stringValue(data.answer);
    if (content) {
      const sources = Array.isArray(data.sources)
        ? data.sources
            .map((source, index) => normalizeSource(source, index))
            .filter((source): source is SourceEvidence => Boolean(source))
        : [];
      message = {
        messageId: stringValue(data.messageId) ?? crypto.randomUUID(),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        sources,
      };
    }
  } else if (!message.sources.length && Array.isArray(data.sources)) {
    message.sources = data.sources
      .map((source, index) => normalizeSource(source, index))
      .filter((source): source is SourceEvidence => Boolean(source));
  }
  return {
    conversationId:
      stringValue(data.conversationId) ?? fallbackConversationId,
    message,
  };
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function requestErrorMessage(response: Response, payload: unknown) {
  if (response.status === 401) return "Your session has expired.";
  if (response.status === 403) return "This workspace denied the request.";
  if (response.status === 409)
    return "Select a workspace before starting a conversation.";
  if (isRecord(payload)) {
    const message =
      stringValue(payload.message) ??
      (isRecord(payload.error) ? stringValue(payload.error.message) : null);
    if (message) return message;
  }
  return "The learning assistant could not respond. Your message was not lost.";
}

export default function ConversationClient({
  assistantName,
  tenantName,
  welcomeMessage,
  role,
  initialMode,
  initialCourseId,
  initialLessonId,
  courses,
}: {
  assistantName: string;
  tenantName: string;
  welcomeMessage: string;
  role: string;
  initialMode: "text" | "voice";
  initialCourseId: string | null;
  initialLessonId: string | null;
  courses: CourseOption[];
}) {
  const [mode, setMode] = useState<"text" | "voice">(initialMode);
  const [learningIntent, setLearningIntent] =
    useState<LearningIntent>("explain");
  const [selectedCourseId, setSelectedCourseId] = useState(
    courses.some((course) => course.courseId === initialCourseId)
      ? initialCourseId ?? ""
      : "",
  );
  const [selectedLessonId, setSelectedLessonId] = useState(
    initialLessonId ?? "",
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("idle");
  const [voiceReadiness, setVoiceReadiness] = useState<VoiceReadiness>(
    initialMode === "voice" ? "checking" : "unchecked",
  );
  const [voiceTranscript, setVoiceTranscript] = useState("");
  const [voiceAnswer, setVoiceAnswer] = useState("");
  const [playbackNeedsGesture, setPlaybackNeedsGesture] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const feedEndRef = useRef<HTMLDivElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const discardRecordingRef = useRef(false);
  const voiceGenerationRef = useRef(0);
  const voiceRequestRef = useRef<AbortController | null>(null);
  const playbackRef = useRef<HTMLAudioElement | null>(null);
  const playbackUrlRef = useRef<string | null>(null);
  const voiceDeadlineRef = useRef<number | null>(null);
  const voiceStartedAtRef = useRef(0);
  const voiceDurationRef = useRef(0);
  const voiceMimeTypeRef = useRef("");
  const conversationStartKeyRef = useRef(
    `conversation:${crypto.randomUUID()}`,
  );
  const retryTurnRef = useRef<{ content: string; key: string } | null>(null);

  const selectedCourse = courses.find(
    (course) => course.courseId === selectedCourseId,
  );
  const lessons = useMemo(
    () =>
      selectedCourse?.modules.flatMap((module) =>
        module.lessons.map((lesson) => ({
          ...lesson,
          moduleTitle: module.title,
        })),
      ) ?? [],
    [selectedCourse],
  );

  useEffect(() => {
    if (
      selectedLessonId &&
      !lessons.some((lesson) => lesson.lessonId === selectedLessonId)
    ) {
      setSelectedLessonId("");
    }
  }, [lessons, selectedLessonId]);

  useEffect(() => {
    let active = true;
    async function loadConversation() {
      const parameters = new URLSearchParams();
      if (selectedCourseId) parameters.set("courseId", selectedCourseId);
      if (selectedLessonId) parameters.set("lessonId", selectedLessonId);
      const suffix = parameters.size ? `?${parameters.toString()}` : "";
      try {
        const response = await fetch(
          `/api/learning/conversations${suffix}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        const payload = await readJson(response);
        if (!active) return;
        if (response.status === 401) {
          window.location.assign(
            `/auth/sign-in?error=authentication_required&next=${encodeURIComponent("/app/conversation")}`,
          );
          return;
        }
        if (response.status === 409) {
          window.location.assign("/onboarding");
          return;
        }
        if (!response.ok) {
          setError(requestErrorMessage(response, payload));
          return;
        }
        const normalized = normalizeConversation(payload);
        if (!normalized.conversationId) {
          conversationStartKeyRef.current =
            `conversation:${crypto.randomUUID()}`;
        }
        setConversationId(normalized.conversationId);
        setMessages(normalized.messages);
      } catch {
        if (active) {
          setError(
            "Conversation history is temporarily unavailable. No demo data was substituted.",
          );
        }
      } finally {
        if (active) setLoadingHistory(false);
      }
    }
    void loadConversation();
    return () => {
      active = false;
    };
  }, [selectedCourseId, selectedLessonId]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    const nextHeight = Math.min(textarea.scrollHeight, 140);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > 140 ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (mode === "voice" && voiceReadiness === "checking") {
      void checkVoiceReadiness();
    }
  }, [mode, voiceReadiness]);

  useEffect(() => {
    return () => {
      voiceGenerationRef.current += 1;
      voiceRequestRef.current?.abort();
      if (voiceDeadlineRef.current !== null) {
        window.clearTimeout(voiceDeadlineRef.current);
      }
      discardRecordingRef.current = true;
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      playbackRef.current?.pause();
      if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
    };
  }, []);

  async function ensureConversation(signal?: AbortSignal) {
    if (conversationId) return conversationId;
    const response = await fetch("/api/learning/conversations", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      signal: signal ?? null,
      body: JSON.stringify({
        courseId: selectedCourseId || null,
        lessonId: selectedLessonId || null,
        idempotencyKey: conversationStartKeyRef.current,
      }),
    });
    const payload = await readJson(response);
    if (response.status === 401) {
      window.location.assign(
        `/auth/sign-in?error=authentication_required&next=${encodeURIComponent("/app/conversation")}`,
      );
      throw new Error("authentication_required");
    }
    if (response.status === 409) {
      window.location.assign("/onboarding");
      throw new Error("workspace_required");
    }
    if (!response.ok) {
      throw new Error(requestErrorMessage(response, payload));
    }
    const normalized = normalizeConversation(payload);
    if (!normalized.conversationId) {
      throw new Error("The conversation could not be created.");
    }
    setConversationId(normalized.conversationId);
    return normalized.conversationId;
  }

  async function submitMessage(
    text: string,
    modality: "text" | "voice" = "text",
    signal?: AbortSignal,
  ): Promise<{
    conversationId: string;
    message: ConversationMessage;
  } | null> {
    const content = text.trim();
    if (!content || sending) return null;
    const turnKey =
      retryTurnRef.current?.content === content
        ? retryTurnRef.current.key
        : `turn:${crypto.randomUUID()}`;
    retryTurnRef.current = { content, key: turnKey };
    setDraft("");
    setError(null);
    const optimisticMessage: ConversationMessage = {
      messageId: `pending-${crypto.randomUUID()}`,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
      sources: [],
    };
    setMessages((current) => [...current, optimisticMessage]);
    setSending(true);
    try {
      const activeConversationId = await ensureConversation(signal);
      const response = await fetch("/api/learning/respond", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        signal: signal ?? null,
        body: JSON.stringify({
          conversationId: activeConversationId,
          message: content,
          courseId: selectedCourseId || null,
          lessonId: selectedLessonId || null,
          intent: learningIntent,
          idempotencyKey: turnKey,
          modality,
        }),
      });
      const payload = await readJson(response);
      if (response.status === 401) {
        window.location.assign(
          `/auth/sign-in?error=authentication_required&next=${encodeURIComponent("/app/conversation")}`,
        );
        return null;
      }
      if (!response.ok) {
        throw new Error(requestErrorMessage(response, payload));
      }
      const normalized = normalizeResponse(payload, activeConversationId);
      if (!normalized.message) {
        throw new Error("The assistant returned an invalid response.");
      }
      setConversationId(normalized.conversationId);
      setMessages((current) => [...current, normalized.message!]);
      retryTurnRef.current = null;
      return {
        conversationId: normalized.conversationId ?? activeConversationId,
        message: normalized.message,
      };
    } catch (caught) {
      if (modality === "text") setDraft(content);
      setMessages((current) =>
        current.filter(
          (message) => message.messageId !== optimisticMessage.messageId,
        ),
      );
      if (
        caught instanceof Error &&
        !["authentication_required", "workspace_required"].includes(
          caught.message,
        )
      ) {
        setError(caught.message);
      }
      return null;
    } finally {
      setSending(false);
      if (modality === "text") textareaRef.current?.focus();
    }
  }

  function releasePlayback() {
    const audio = playbackRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.src = "";
    }
    playbackRef.current = null;
    setPlaybackNeedsGesture(false);
    if (playbackUrlRef.current) {
      URL.revokeObjectURL(playbackUrlRef.current);
      playbackUrlRef.current = null;
    }
  }

  function releaseMicrophone() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    if (voiceDeadlineRef.current !== null) {
      window.clearTimeout(voiceDeadlineRef.current);
      voiceDeadlineRef.current = null;
    }
  }

  function redirectVoiceBoundary(response: Response) {
    if (response.status === 401) {
      window.location.assign(
        `/auth/sign-in?error=authentication_required&next=${encodeURIComponent("/app/conversation?mode=voice")}`,
      );
      return true;
    }
    if (response.status === 409) {
      window.location.assign("/onboarding");
      return true;
    }
    return false;
  }

  async function checkVoiceReadiness() {
    try {
      const response = await fetch("/api/learning/voice/transcribe", {
        cache: "no-store",
        credentials: "same-origin",
      });
      if (redirectVoiceBoundary(response)) return;
      const payload = await readJson(response);
      if (!response.ok) {
        setVoiceReadiness("unavailable");
        setVoicePhase("error");
        setError(requestErrorMessage(response, payload));
        return;
      }
      setVoiceReadiness("ready");
      setVoicePhase("idle");
      setError(null);
    } catch {
      setVoiceReadiness("unavailable");
      setVoicePhase("error");
      setError(
        "Voice readiness could not be verified. Continue in text or retry voice.",
      );
    }
  }

  function enterVoiceMode() {
    setMode("voice");
    setVoiceReadiness("checking");
    setVoicePhase("idle");
    setError(null);
  }

  function voiceFailure(message: string, generation: number) {
    if (generation !== voiceGenerationRef.current) return;
    releaseMicrophone();
    releasePlayback();
    setError(message);
    setVoicePhase("error");
  }

  async function speakSavedAnswer(
    activeConversationId: string,
    message: ConversationMessage,
    generation: number,
    signal: AbortSignal,
  ) {
    const response = await fetch("/api/learning/voice/speak", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      signal,
      body: JSON.stringify({
        conversationId: activeConversationId,
        messageId: message.messageId,
      }),
    });
    if (redirectVoiceBoundary(response)) {
      throw new DOMException("Session boundary changed", "AbortError");
    }
    if (!response.ok) {
      const payload = await readJson(response);
      throw new Error(
        requestErrorMessage(response, payload) ||
          "The answer is saved, but audio is unavailable.",
      );
    }
    const audioBlob = await response.blob();
    if (
      generation !== voiceGenerationRef.current ||
      signal.aborted
    ) {
      return;
    }
    const playbackUrl = URL.createObjectURL(audioBlob);
    const playback = new Audio(playbackUrl);
    playbackRef.current = playback;
    playbackUrlRef.current = playbackUrl;
    setPlaybackNeedsGesture(false);
    playback.onended = () => {
      if (generation !== voiceGenerationRef.current) return;
      releasePlayback();
      setVoicePhase("idle");
    };
    playback.onerror = () => {
      voiceFailure(
        "The answer is saved, but this browser could not play its audio.",
        generation,
      );
    };
    setVoicePhase("speaking");
    try {
      await playback.play();
    } catch (caught) {
      if (
        caught instanceof DOMException &&
        caught.name === "NotAllowedError" &&
        generation === voiceGenerationRef.current
      ) {
        setPlaybackNeedsGesture(true);
        setVoicePhase("idle");
        return;
      }
      throw caught;
    }
  }

  async function resumeBlockedPlayback() {
    const playback = playbackRef.current;
    if (!playback) return;
    const generation = voiceGenerationRef.current;
    try {
      setPlaybackNeedsGesture(false);
      setVoicePhase("speaking");
      await playback.play();
    } catch {
      voiceFailure(
        "The browser still blocked playback. The answer remains available in text.",
        generation,
      );
    }
  }

  function clientAudioFilename(mimeType: string) {
    const normalized = mimeType.toLowerCase().split(";")[0];
    if (normalized === "audio/mp4" || normalized === "audio/m4a") {
      return "voice-turn.m4a";
    }
    if (normalized === "audio/aac") return "voice-turn.aac";
    return "voice-turn.webm";
  }

  async function processVoiceRecording(
    blob: Blob,
    generation: number,
    durationMs: number,
    mimeType: string,
  ) {
    const requestController = new AbortController();
    voiceRequestRef.current = requestController;
    try {
      const body = new FormData();
      body.set(
        "audio",
        new File([blob], clientAudioFilename(mimeType), { type: mimeType }),
      );
      body.set("durationMs", String(durationMs));
      const transcriptionResponse = await fetch(
        "/api/learning/voice/transcribe",
        {
          method: "POST",
          credentials: "same-origin",
          body,
          signal: requestController.signal,
        },
      );
      if (redirectVoiceBoundary(transcriptionResponse)) {
        throw new DOMException("Session boundary changed", "AbortError");
      }
      const transcriptionPayload = await readJson(transcriptionResponse);
      if (!transcriptionResponse.ok) {
        throw new Error(
          requestErrorMessage(transcriptionResponse, transcriptionPayload),
        );
      }
      const transcript = isRecord(transcriptionPayload)
        ? stringValue(transcriptionPayload.transcript)?.trim()
        : null;
      if (!transcript) {
        throw new Error("I did not catch that. Please try speaking again.");
      }
      if (generation !== voiceGenerationRef.current) return;
      setVoiceTranscript(transcript);
      setVoicePhase("thinking");
      const turn = await submitMessage(
        transcript,
        "voice",
        requestController.signal,
      );
      if (!turn || generation !== voiceGenerationRef.current) {
        if (!requestController.signal.aborted) {
          throw new Error(
            "The grounded answer could not be completed. Try again or continue in text.",
          );
        }
        return;
      }
      setVoiceAnswer(turn.message.content);
      await speakSavedAnswer(
        turn.conversationId,
        turn.message,
        generation,
        requestController.signal,
      );
    } catch (caught) {
      if (
        generation === voiceGenerationRef.current &&
        !(caught instanceof DOMException && caught.name === "AbortError")
      ) {
        voiceFailure(
          caught instanceof Error
            ? caught.message
            : "The voice turn could not be completed.",
          generation,
        );
      }
    } finally {
      if (voiceRequestRef.current === requestController) {
        voiceRequestRef.current = null;
      }
    }
  }

  function stopVoiceRecording() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      voiceDurationRef.current = Math.min(
        MAX_VOICE_TURN_MS,
        Math.max(100, Math.round(performance.now() - voiceStartedAtRef.current)),
      );
      setVoicePhase("transcribing");
      recorder.stop();
    }
  }

  async function startVoiceRecording() {
    if (voicePhase === "recording") {
      stopVoiceRecording();
      return;
    }
    if (["requesting", "transcribing", "thinking"].includes(voicePhase)) {
      return;
    }
    if (voiceReadiness !== "ready") {
      setVoiceReadiness("checking");
      return;
    }
    releasePlayback();
    voiceRequestRef.current?.abort();
    const generation = voiceGenerationRef.current + 1;
    voiceGenerationRef.current = generation;
    setError(null);
    setVoiceTranscript("");
    setVoiceAnswer("");
    setVoicePhase("requesting");

    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      ) {
        throw new Error(
          "This browser does not support secure microphone recording. Continue in text or use a current browser.",
        );
      }
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4;codecs=mp4a.40.2",
        "audio/mp4",
        "audio/aac",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      if (!mimeType) {
        throw new Error(
          "This browser cannot create a supported secure voice recording.",
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (generation !== voiceGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaStreamRef.current = stream;
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      discardRecordingRef.current = false;
      voiceStartedAtRef.current = performance.now();
      voiceDurationRef.current = 0;
      voiceMimeTypeRef.current = recorder.mimeType || mimeType;
      recorder.ondataavailable = (event) => {
        if (event.data.size) audioChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        voiceFailure(
          "The microphone stopped unexpectedly. Please try the voice turn again.",
          generation,
        );
      };
      recorder.onstop = () => {
        const chunks = audioChunksRef.current;
        const discard = discardRecordingRef.current;
        const durationMs =
          voiceDurationRef.current ||
          Math.min(
            MAX_VOICE_TURN_MS,
            Math.max(
              100,
              Math.round(performance.now() - voiceStartedAtRef.current),
            ),
          );
        const recordedMimeType = voiceMimeTypeRef.current || mimeType;
        releaseMicrophone();
        if (discard || generation !== voiceGenerationRef.current) return;
        const recording = new Blob(chunks, { type: recordedMimeType });
        if (recording.size < 64) {
          voiceFailure(
            "I did not catch any audio. Please try the voice turn again.",
            generation,
          );
          return;
        }
        void processVoiceRecording(
          recording,
          generation,
          durationMs,
          recordedMimeType,
        );
      };
      recorder.start(250);
      setVoicePhase("recording");
      voiceDeadlineRef.current = window.setTimeout(
        stopVoiceRecording,
        MAX_VOICE_TURN_MS - 250,
      );
    } catch (caught) {
      voiceFailure(
        caught instanceof DOMException && caught.name === "NotAllowedError"
          ? "Microphone access was not allowed. You can enable it in the browser or continue in text."
          : caught instanceof Error
            ? caught.message
            : "The microphone could not start.",
        generation,
      );
    }
  }

  function leaveVoiceMode() {
    voiceGenerationRef.current += 1;
    voiceRequestRef.current?.abort();
    voiceRequestRef.current = null;
    discardRecordingRef.current = true;
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
    releaseMicrophone();
    releasePlayback();
    setVoicePhase("idle");
    setVoiceReadiness("unchecked");
    setMode("text");
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(draft);
  }

  function onDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage(draft);
    }
  }

  function resetConversationContext() {
    voiceGenerationRef.current += 1;
    voiceRequestRef.current?.abort();
    voiceRequestRef.current = null;
    discardRecordingRef.current = true;
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
    releaseMicrophone();
    releasePlayback();
    setVoicePhase("idle");
    setVoiceTranscript("");
    setVoiceAnswer("");
    setConversationId(null);
    setMessages([]);
    setLoadingHistory(true);
    setError(null);
    retryTurnRef.current = null;
    conversationStartKeyRef.current = `conversation:${crypto.randomUUID()}`;
  }

  const voiceCopy: Record<
    VoicePhase,
    { eyebrow: string; heading: string; description: string }
  > = {
    idle: {
      eyebrow: "PUSH-TO-TALK",
      heading: "Ready when you are.",
      description:
        "Tap the microphone, ask one question, then tap again. This uses the same grounded conversation as text.",
    },
    requesting: {
      eyebrow: "MICROPHONE",
      heading: "Opening your microphone…",
      description:
        "Your browser will ask for permission. Raw audio is sent for transcription and is not stored by LearningBot.",
    },
    recording: {
      eyebrow: "LISTENING",
      heading: "I’m listening.",
      description:
        "Tap again when you are finished. Voice turns stop automatically after 45 seconds.",
    },
    transcribing: {
      eyebrow: "TRANSCRIBING",
      heading: "Turning speech into text…",
      description:
        "The recording stays ephemeral. The transcript will become a normal message in this conversation.",
    },
    thinking: {
      eyebrow: "GROUNDING",
      heading: `Finding the answer with ${assistantName}…`,
      description:
        "The transcript is being answered from your workspace’s published learning and saved with its sources.",
    },
    speaking: {
      eyebrow: "SPEAKING",
      heading: `${assistantName} is answering.`,
      description:
        "This is an AI-generated voice. Tap the microphone to interrupt and ask the next question.",
    },
    error: {
      eyebrow: "VOICE PAUSED",
      heading: "Let’s try that again.",
      description:
        "Your text conversation is still available, and any completed grounded answer remains saved.",
    },
  };
  const currentVoiceCopy =
    voiceReadiness === "checking"
      ? {
          eyebrow: "VOICE CHECK",
          heading: "Checking voice availability…",
          description:
            "The microphone stays off until this signed-in workspace and its provider configuration are verified.",
        }
      : voiceReadiness === "unavailable"
        ? {
            eyebrow: "VOICE UNAVAILABLE",
            heading: "Voice is not ready here.",
            description:
              "No recording was started. Continue in text or retry the voice readiness check.",
          }
        : voiceCopy[voicePhase];
  const voiceButtonLabel =
    voiceReadiness !== "ready"
      ? "Voice is not ready"
      : voicePhase === "recording"
      ? "Stop recording"
      : voicePhase === "speaking"
        ? "Interrupt and record a new voice turn"
        : voicePhase === "requesting"
          ? "Opening microphone"
          : voicePhase === "transcribing" || voicePhase === "thinking"
            ? "Voice turn is processing"
            : "Start voice turn";
  const voiceContextLocked =
    sending ||
    (mode === "voice" &&
      (voiceReadiness === "checking" ||
        !["idle", "error"].includes(voicePhase)));

  return (
    <div className={styles.workspace}>
      <aside className={styles.contextRail}>
        <Link className={styles.brand} href="/app">
          <span className={styles.brandMark}>E</span>
          <span>
            <b>{assistantName}</b>
            <small>{tenantName}</small>
          </span>
        </Link>
        <Link className={styles.backLink} href="/app">
          <span aria-hidden="true">←</span> Learning home
        </Link>
        <section className={styles.contextCard}>
          <p>Ground this conversation</p>
          <label>
            <span>Course</span>
            <select
              value={selectedCourseId}
              onChange={(event) => {
                resetConversationContext();
                setSelectedCourseId(event.target.value);
                setSelectedLessonId("");
              }}
              disabled={voiceContextLocked}
            >
              <option value="">All published learning</option>
              {courses.map((course) => (
                <option key={course.courseId} value={course.courseId}>
                  {course.title}
                </option>
              ))}
            </select>
          </label>
          {selectedCourse ? (
            <label>
              <span>Lesson</span>
              <select
                value={selectedLessonId}
                onChange={(event) => {
                  resetConversationContext();
                  setSelectedLessonId(event.target.value);
                }}
                disabled={voiceContextLocked}
              >
                <option value="">Entire course</option>
                {lessons.map((lesson) => (
                  <option key={lesson.lessonId} value={lesson.lessonId}>
                    {lesson.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <small>
            Answers use only learning that is published for this workspace.
          </small>
        </section>
        <div className={styles.identity}>
          <span>{role.slice(0, 2).toUpperCase()}</span>
          <div>
            <b>Private workspace</b>
            <small>Signed in · {tenantName}</small>
          </div>
        </div>
      </aside>

      <section className={styles.conversation}>
        <header className={styles.header}>
          <Link href="/app" className={styles.mobileBack} aria-label="Back">
            ←
          </Link>
          <div className={styles.assistantIdentity}>
            <span
              className={`${styles.orb} ${sending ? styles.orbThinking : ""}`}
              aria-hidden="true"
            />
            <span>
              <b>{assistantName}</b>
              <small>{sending ? "Thinking with your learning…" : "Learning companion"}</small>
            </span>
          </div>
          <div className={styles.modeSwitch} aria-label="Conversation mode">
            <button
              className={mode === "text" ? styles.modeActive : ""}
              type="button"
              onClick={leaveVoiceMode}
            >
              Text
            </button>
            <button
              className={mode === "voice" ? styles.modeActive : ""}
              type="button"
              onClick={enterVoiceMode}
            >
              <span aria-hidden="true">●</span> Voice
            </button>
          </div>
        </header>

        {mode === "voice" ? (
          <section className={styles.voiceNotice} aria-labelledby="voice-heading">
            <span
              className={`${styles.voiceOrb} ${styles[`voiceOrb_${voicePhase}`]}`}
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
            </span>
            <div aria-live="polite">
              <p>{currentVoiceCopy.eyebrow}</p>
              <h1 id="voice-heading">{currentVoiceCopy.heading}</h1>
              <span>
                {currentVoiceCopy.description}
              </span>
            </div>
            {voiceTranscript ? (
              <div className={styles.voiceTurn}>
                <small>You asked</small>
                <p>{voiceTranscript}</p>
                {voiceAnswer ? (
                  <>
                    <small>{assistantName} answered</small>
                    <p>{voiceAnswer}</p>
                  </>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <p className={styles.voiceError} role="alert">
                {error}
              </p>
            ) : null}
            {playbackNeedsGesture ? (
              <button
                className={styles.playAnswer}
                type="button"
                onClick={() => void resumeBlockedPlayback()}
              >
                Play {assistantName}&apos;s answer
              </button>
            ) : null}
            {voiceReadiness === "unavailable" ? (
              <button
                className={styles.retryVoice}
                type="button"
                onClick={() => setVoiceReadiness("checking")}
              >
                Retry voice check
              </button>
            ) : null}
            <button
              className={`${styles.voiceButton} ${
                voicePhase === "recording" ? styles.voiceButtonRecording : ""
              }`}
              type="button"
              onClick={() => void startVoiceRecording()}
              disabled={
                voiceReadiness !== "ready" ||
                ["requesting", "transcribing", "thinking"].includes(voicePhase)
              }
              aria-label={voiceButtonLabel}
            >
              <span aria-hidden="true">●</span>
            </button>
            <small className={styles.voiceDisclosure}>
              Push-to-talk, not realtime · AI-generated voice · raw audio is not
              retained
            </small>
            <button
              className={styles.continueText}
              type="button"
              onClick={leaveVoiceMode}
            >
              Continue in text
            </button>
          </section>
        ) : (
          <>
            <div className={styles.feed} aria-live="polite">
              {loadingHistory ? (
                <div className={styles.loading}>
                  <span className={styles.orb} aria-hidden="true" />
                  <p>Opening your conversation…</p>
                </div>
              ) : messages.length ? (
                messages.map((message) => (
                  <article
                    className={
                      message.role === "user"
                        ? styles.userMessage
                        : styles.assistantMessage
                    }
                    key={message.messageId}
                  >
                    {message.role === "assistant" ? (
                      <span className={styles.messageOrb} aria-hidden="true" />
                    ) : null}
                    <div>
                      <p>{message.content}</p>
                      {message.sources.length ? (
                        <details className={styles.sources}>
                          <summary>
                            {message.sources.length} learning{" "}
                            {message.sources.length === 1 ? "source" : "sources"}
                          </summary>
                          <div>
                            {message.sources.map((source) => (
                              <article key={source.sourceId}>
                                <b>{source.title}</b>
                                {source.courseTitle || source.lessonTitle ? (
                                  <small>
                                    {[source.courseTitle, source.lessonTitle]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  </small>
                                ) : null}
                                <p>{source.excerpt}</p>
                              </article>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </article>
                ))
              ) : (
                <section className={styles.welcome}>
                  <span className={styles.welcomeOrb} aria-hidden="true" />
                  <p>LEARN WITH {assistantName.toUpperCase()}</p>
                  <h1>What would you like to understand?</h1>
                  <span>{welcomeMessage}</span>
                  <div>
                    {starterPrompts.map((prompt) => (
                      <button
                        type="button"
                        key={prompt}
                        onClick={() => void submitMessage(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {sending ? (
                <article className={styles.assistantMessage}>
                  <span
                    className={`${styles.messageOrb} ${styles.orbThinking}`}
                    aria-hidden="true"
                  />
                  <div className={styles.thinkingDots} aria-label={`${assistantName} is thinking`}>
                    <i />
                    <i />
                    <i />
                  </div>
                </article>
              ) : null}
              <div ref={feedEndRef} />
            </div>

            <footer className={styles.composerArea}>
              {error ? (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              ) : null}
              <div
                className={styles.learningModes}
                aria-label="Choose how to learn"
              >
                {(
                  [
                    ["explain", "Explain", "Teach the idea clearly"],
                    ["practice", "Practice", "Work through a scenario"],
                    ["check", "Check me", "Test understanding one step at a time"],
                  ] as const
                ).map(([intent, label, description]) => (
                  <button
                    type="button"
                    key={intent}
                    aria-pressed={learningIntent === intent}
                    title={description}
                    onClick={() => setLearningIntent(intent)}
                    disabled={sending || loadingHistory}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <form className={styles.composer} onSubmit={onSubmit}>
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onDraftKeyDown}
                  placeholder={
                    learningIntent === "practice"
                      ? "Describe what you want to practice…"
                      : learningIntent === "check"
                        ? "Ask for a knowledge check or answer the current question…"
                        : `Ask ${assistantName} about your learning…`
                  }
                  aria-label={`Message ${assistantName}`}
                  rows={1}
                  maxLength={4000}
                  disabled={sending || loadingHistory}
                />
                <button
                  className={styles.micButton}
                  type="button"
                  onClick={enterVoiceMode}
                  aria-label="Open voice mode"
                >
                  <span aria-hidden="true">●</span>
                </button>
                <button
                  className={styles.sendButton}
                  type="submit"
                  disabled={!draft.trim() || sending || loadingHistory}
                  aria-label="Send message"
                >
                  ↑
                </button>
              </form>
              <p>
                {selectedCourse
                  ? `Grounded in ${selectedCourse.title}`
                  : "Grounded in your published learning"}
                <span aria-hidden="true"> · </span>
                Check the cited source when accuracy matters.
              </p>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}
