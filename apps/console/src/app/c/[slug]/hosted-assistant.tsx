"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";

import { CorsoMark } from "../../../components/corso/corso-mark";
import { RichText } from "../../../components/ui/rich-text";
import styles from "./hosted.module.css";

type Course = {
  courseRef: string;
  title: string;
};

type Bootstrap = {
  widget: {
    anonymousQuestions: boolean;
    courses: Course[];
    greeting: string | null;
    launcherShape: "bubble" | "pill" | "tab";
    greetingBubbleEnabled: boolean;
    greetingBubbleDelaySeconds: number;
    showPoweredBy: boolean;
    appearanceMode: "auto" | "light" | "dark";
  };
  branding: {
    assistantName: string;
    primaryColor: string;
    accentColor: string;
    surfaceColor: string;
    textColor: string;
    fontFamily: "system" | "rounded" | "serif";
    welcomeCopy: string;
    logoUrl: string | null;
    avatarUrl: string | null;
    privacyUrl: string | null;
    termsUrl: string | null;
    supportUrl: string | null;
  };
};

type Source = {
  sourceRef: string;
  title: string;
  courseTitle: string;
  sectionName: string | null;
  excerpt: string;
};

type Message =
  | { id: string; role: "user"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      sources: Source[];
    };

type HostedAssistantProps = {
  askEndpoint: string;
  bootstrap: Bootstrap;
  friendlySlug: string;
  legacyWidgetKey: string | null;
};

type AskSuccess = {
  ok: true;
  conversationRef: string;
  message: {
    content: string;
    sources?: unknown;
  };
};

const promptSuggestions = [
  "Help me find the right lesson",
  "Can you explain this step?",
  "What should I do next?",
] as const;

function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
}

function safeLink(value: string | null) {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function conversationRef() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  let value = "";
  for (const byte of bytes) value += alphabet[byte % alphabet.length];
  return value + value.slice(0, 12);
}

function parseSources(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Source[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.sourceRef !== "string" ||
      typeof record.title !== "string" ||
      typeof record.courseTitle !== "string" ||
      typeof record.excerpt !== "string"
    ) {
      return [];
    }
    return [
      {
        sourceRef: record.sourceRef,
        title: record.title,
        courseTitle: record.courseTitle,
        sectionName:
          typeof record.sectionName === "string" ? record.sectionName : null,
        excerpt: record.excerpt,
      },
    ];
  });
}

function isAskSuccess(value: unknown): value is AskSuccess {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.conversationRef !== "string") {
    return false;
  }
  if (!record.message || typeof record.message !== "object") return false;
  const message = record.message as Record<string, unknown>;
  return typeof message.content === "string";
}

function requestError(status: number, code: unknown, retryAfter: unknown) {
  if (status === 429 || code === "rate_limited") {
    const seconds =
      typeof retryAfter === "number" && retryAfter > 0
        ? Math.ceil(retryAfter)
        : 60;
    return `Too many questions at once. Try again in about ${seconds} seconds.`;
  }
  if (code === "widget_unavailable") {
    return "This assistant is no longer available on this public link.";
  }
  if (code === "widget_unconfigured") {
    return "The course owner still needs to finish setting up answers.";
  }
  return "I couldn’t answer that just now. Your question wasn’t lost—please try again.";
}

function courseScopeLabel(courses: readonly Course[]) {
  if (courses.length === 1) {
    return `Answers only from the ${courses[0]?.title ?? "published"} course`;
  }
  if (courses.length > 1) {
    return `Answers only from ${courses.length} published courses`;
  }
  return "Answers only from published course material";
}

export function HostedAssistant({
  askEndpoint,
  bootstrap,
  friendlySlug,
  legacyWidgetKey,
}: HostedAssistantProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [selectedCourse, setSelectedCourse] = useState<string | null>(
    bootstrap.widget.courses.length === 1
      ? (bootstrap.widget.courses[0]?.courseRef ?? null)
      : null,
  );
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefersDark, setPrefersDark] = useState(false);
  const conversation = useRef("");
  const requestController = useRef<AbortController | null>(null);
  const requestVersion = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);

  const branding = bootstrap.branding;
  const logoUrl = branding.logoUrl;
  const avatarUrl = branding.avatarUrl;
  const privacyUrl = safeLink(branding.privacyUrl);
  const termsUrl = safeLink(branding.termsUrl);
  const supportUrl = safeLink(branding.supportUrl);
  const canAsk = bootstrap.widget.anonymousQuestions;
  const dark =
    bootstrap.widget.appearanceMode === "dark" ||
    (bootstrap.widget.appearanceMode === "auto" && prefersDark);

  const pageStyle = useMemo(
    () =>
      ({
        "--hosted-accent": safeColor(branding.primaryColor, "#4a637f"),
        "--hosted-accent-2": safeColor(branding.accentColor, "#4a637f"),
        "--hosted-surface": dark
          ? "#171b1a"
          : safeColor(branding.surfaceColor, "#ffffff"),
        "--hosted-text": dark
          ? "#f4f7f6"
          : safeColor(branding.textColor, "#1d1d1f"),
        "--brand-primary": safeColor(branding.primaryColor, "#4a637f"),
        "--brand-accent": safeColor(branding.accentColor, "#4a637f"),
        "--hosted-font":
          branding.fontFamily === "rounded"
            ? "ui-rounded, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
            : branding.fontFamily === "serif"
              ? "ui-serif, Georgia, serif"
              : "-apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif",
      }) as CSSProperties,
    [
      branding.accentColor,
      branding.fontFamily,
      branding.primaryColor,
      branding.surfaceColor,
      branding.textColor,
      dark,
    ],
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => setPrefersDark(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [isSending, messages]);

  useEffect(
    () => () => {
      requestController.current?.abort();
    },
    [],
  );

  function startNewConversation() {
    requestVersion.current += 1;
    requestController.current?.abort();
    requestController.current = null;
    conversation.current = conversationRef();
    setMessages([]);
    setQuestion("");
    setError(null);
    setIsSending(false);
  }

  async function ask(rawQuestion: string) {
    const trimmed = rawQuestion.trim();
    if (
      !canAsk ||
      trimmed.length < 2 ||
      trimmed.length > 2_000 ||
      isSending ||
      requestController.current !== null
    ) {
      return;
    }

    if (!conversation.current) conversation.current = conversationRef();
    const controller = new AbortController();
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    requestController.current = controller;
    const userMessage: Message = {
      id: `user-${crypto.randomUUID()}`,
      role: "user",
      content: trimmed,
    };
    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setError(null);
    setIsSending(true);

    try {
      const response = await fetch(askEndpoint, {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ...(legacyWidgetKey === null ? {} : { key: legacyWidgetKey }),
          conversationRef: conversation.current,
          question: trimmed,
          courseRef: selectedCourse,
        }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (requestVersion.current !== version) return;

      if (!response.ok || !isAskSuccess(payload)) {
        const errorPayload =
          payload && typeof payload === "object"
            ? (payload as Record<string, unknown>)
            : null;
        setError(
          requestError(
            response.status,
            errorPayload?.code,
            errorPayload?.retryAfterSeconds,
          ),
        );
        return;
      }

      setMessages((current) => [
        ...current,
        {
          id: `assistant-${crypto.randomUUID()}`,
          role: "assistant",
          content: payload.message.content,
          sources: parseSources(payload.message.sources),
        },
      ]);
    } catch {
      if (requestVersion.current !== version) return;
      setError("I couldn’t reach the course right now. Check your connection and try again.");
    } finally {
      if (requestVersion.current === version) {
        requestController.current = null;
        setIsSending(false);
      }
    }
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  const welcome =
    bootstrap.widget.greeting?.trim() ||
    branding.welcomeCopy.trim() ||
    "Ask a question and I’ll point you to the exact lesson—or tell you when it isn’t covered yet.";
  const showWelcome = messages.length === 0;

  return (
    <main
      className={styles.page}
      data-ground={dark ? "dark" : "light"}
      style={pageStyle}
    >
      <header className={styles.header}>
        <div className={styles.identity}>
          <BrandAvatar
            alt=""
            imageUrl={logoUrl ?? avatarUrl}
            size="small"
          />
          <div>
            <h1>{branding.assistantName}</h1>
            <p>{courseScopeLabel(bootstrap.widget.courses)}</p>
          </div>
        </div>
        <button
          className={styles.newConversation}
          onClick={startNewConversation}
          type="button"
        >
          New conversation
        </button>
      </header>

      <section
        aria-label={`Conversation with ${branding.assistantName}`}
        className={styles.conversation}
      >
        {showWelcome ? (
          <div className={styles.welcome}>
            <BrandAvatar alt="" imageUrl={avatarUrl ?? logoUrl} size="large" />
            <div className={styles.welcomeCopy}>
              <h2>What are you working on?</h2>
              <p>{welcome}</p>
            </div>

            {bootstrap.widget.courses.length > 1 ? (
              <fieldset className={styles.coursePicker}>
                <legend>Choose a course, or search all published courses</legend>
                <button
                  aria-pressed={selectedCourse === null}
                  onClick={() => setSelectedCourse(null)}
                  type="button"
                >
                  All courses
                </button>
                {bootstrap.widget.courses.map((course) => (
                  <button
                    aria-pressed={selectedCourse === course.courseRef}
                    key={course.courseRef}
                    onClick={() => setSelectedCourse(course.courseRef)}
                    type="button"
                  >
                    {course.title}
                  </button>
                ))}
              </fieldset>
            ) : null}

            {canAsk ? (
              <div aria-label="Suggested questions" className={styles.suggestions}>
                {promptSuggestions.map((prompt) => (
                  <button key={prompt} onClick={() => void ask(prompt)} type="button">
                    {prompt}
                  </button>
                ))}
              </div>
            ) : (
              <p className={styles.closedNotice}>
                This course owner is not accepting anonymous questions on public
                links.
              </p>
            )}
          </div>
        ) : (
          <div
            aria-live="polite"
            className={styles.transcript}
            role="log"
          >
            {messages.map((message) =>
              message.role === "user" ? (
                <article className={styles.userTurn} key={message.id}>
                  <p>{message.content}</p>
                </article>
              ) : (
                <article className={styles.assistantTurn} key={message.id}>
                  <BrandAvatar alt="" imageUrl={avatarUrl ?? logoUrl} size="turn" />
                  <div className={styles.answer}>
                    <RichText
                      citationCount={message.sources.length}
                      citationHrefPrefix={`#source-${message.id}-`}
                      className={styles.answerProse}
                      markdown={message.content}
                    />
                    {message.sources.length > 0 ? (
                      <section
                        aria-label="Sources"
                        className={styles.sources}
                      >
                        <h2>Sources</h2>
                        <div className={styles.sourceGrid}>
                          {message.sources.map((source, index) => (
                            <article
                              className={styles.sourceCard}
                              id={`source-${message.id}-${index + 1}`}
                              key={`${message.id}-${index}-${source.sourceRef}`}
                            >
                              <span>{index + 1}</span>
                              <div>
                                <strong>{source.title}</strong>
                                <p>
                                  {source.courseTitle}
                                  {source.sectionName
                                    ? ` · ${source.sectionName}`
                                    : ""}
                                </p>
                                {source.excerpt ? (
                                  <blockquote>{source.excerpt}</blockquote>
                                ) : null}
                              </div>
                            </article>
                          ))}
                        </div>
                      </section>
                    ) : null}
                  </div>
                </article>
              ),
            )}
            {isSending ? (
              <div className={styles.thinking} role="status">
                <BrandAvatar alt="" imageUrl={avatarUrl ?? logoUrl} size="turn" />
                <span>
                  <i />
                  <i />
                  <i />
                </span>
                <em>Checking the published course…</em>
              </div>
            ) : null}
            {error ? (
              <div className={styles.error} role="alert">
                <p>{error}</p>
                <button onClick={() => setError(null)} type="button">
                  Dismiss
                </button>
              </div>
            ) : null}
            <div ref={transcriptEnd} />
          </div>
        )}
      </section>

      <footer className={styles.composerArea}>
        <form className={styles.composer} onSubmit={submitQuestion}>
          <label className={styles.visuallyHidden} htmlFor="hosted-question">
            Ask about the course
          </label>
          <input
            autoComplete="off"
            disabled={!canAsk || isSending}
            id="hosted-question"
            maxLength={2_000}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder={
              canAsk
                ? "Ask about the course…"
                : "Anonymous questions are turned off"
            }
            value={question}
          />
          <button
            aria-label="Send question"
            disabled={!canAsk || isSending || question.trim().length < 2}
            type="submit"
          >
            <svg
              aria-hidden="true"
              fill="none"
              height="18"
              viewBox="0 0 24 24"
              width="18"
            >
              <path
                d="M12 19V6M6 12l6-6 6 6"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2.4"
              />
            </svg>
          </button>
        </form>
        <div className={styles.disclosure}>
          <span>Answers come only from published course material</span>
          {bootstrap.widget.showPoweredBy ? (
            <>
              <b aria-hidden="true">·</b>
              <span>Powered by Corso</span>
            </>
          ) : null}
          {privacyUrl ? (
            <>
              <b aria-hidden="true">·</b>
              <a
                href={privacyUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                How your questions are used
              </a>
            </>
          ) : null}
          {termsUrl ? (
            <>
              <b aria-hidden="true">·</b>
              <a
                href={termsUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                Terms
              </a>
            </>
          ) : null}
          {supportUrl ? (
            <>
              <b aria-hidden="true">·</b>
              <a
                href={supportUrl}
                referrerPolicy="no-referrer"
                rel="noopener noreferrer nofollow"
                target="_blank"
              >
                Support
              </a>
            </>
          ) : null}
        </div>
        <p className={styles.linkBoundary}>
          {legacyWidgetKey === null
            ? `Published assistant · /c/${friendlySlug}`
            : `Legacy public-key link · /c/${friendlySlug}`}
        </p>
      </footer>
    </main>
  );
}

function BrandAvatar({
  alt,
  imageUrl,
  size,
}: {
  alt: string;
  imageUrl: string | null;
  size: "small" | "large" | "turn";
}) {
  return (
    <span className={styles.avatar} data-size={size}>
      {imageUrl ? (
        // The URL is assembled only from the configured Supabase public asset
        // bucket and an encoded object path; arbitrary external images never
        // reach this element.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={alt} src={imageUrl} />
      ) : (
        <CorsoMark size={size === "large" ? 34 : size === "small" ? 18 : 17} />
      )}
    </span>
  );
}
