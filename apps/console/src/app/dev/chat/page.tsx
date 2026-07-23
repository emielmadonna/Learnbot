"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./page.module.css";

type IconName =
  | "arrow"
  | "attach"
  | "book"
  | "check"
  | "chevron"
  | "close"
  | "expand"
  | "file"
  | "headphones"
  | "mic"
  | "more"
  | "send"
  | "sparkle"
  | "volume";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="m9 18 6-6-6-6" />,
    attach: (
      <path d="m20.5 11.5-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />
    ),
    book: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    close: (
      <>
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </>
    ),
    expand: (
      <>
        <path d="M15 3h6v6" />
        <path d="m21 3-7 7" />
        <path d="M9 21H3v-6" />
        <path d="m3 21 7-7" />
      </>
    ),
    file: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h6" />
      </>
    ),
    headphones: (
      <>
        <path d="M4 14a8 8 0 0 1 16 0" />
        <path d="M18 19h1a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-1Z" />
        <path d="M6 19H5a2 2 0 0 1-2-2v-2a2 2 0 0 1 2-2h1Z" />
      </>
    ),
    mic: (
      <>
        <rect width="8" height="13" x="8" y="2" rx="4" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
        <path d="M12 18v4" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    send: (
      <>
        <path d="m22 2-7 20-4-9-9-4Z" />
        <path d="M22 2 11 13" />
      </>
    ),
    sparkle: (
      <>
        <path d="m12 3-1.2 3.5A4 4 0 0 1 8.5 8.8L5 10l3.5 1.2a4 4 0 0 1 2.3 2.3L12 17l1.2-3.5a4 4 0 0 1 2.3-2.3L19 10l-3.5-1.2a4 4 0 0 1-2.3-2.3Z" />
        <path d="m19 17-.5 1.5L17 19l1.5.5L19 21l.5-1.5L21 19l-1.5-.5Z" />
      </>
    ),
    volume: (
      <>
        <path d="M11 5 6 9H2v6h4l5 4Z" />
        <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        <path d="M19 5a10 10 0 0 1 0 14" />
      </>
    ),
  };

  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {paths[name]}
    </svg>
  );
}

function Waveform() {
  return (
    <span className={styles.waveform} aria-hidden="true">
      {[8, 13, 19, 11, 23, 16, 9, 20, 14, 7, 17, 11].map((height, index) => (
        <span key={index} style={{ height }} />
      ))}
    </span>
  );
}

const sources = [
  {
    number: 1,
    title: "The Consistency Flywheel",
    detail: "Momentum Method · Lesson 3",
  },
  {
    number: 2,
    title: "Designing Your Minimum Day",
    detail: "Momentum Method · Workbook",
  },
];

type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

const demoTenant = {
  id: "tenant_northstar_demo",
  name: "Northstar Academy",
  logoText: "N",
  assistant: {
    name: "Nova",
    role: "Learning companion",
    avatarText: "N",
  },
  learner: {
    name: "Maya",
    avatarText: "MA",
  },
  brand: {
    primary: "#315f50",
    primaryDeep: "#244a3e",
    primarySoft: "#e8f0ec",
    canvas: "#eef2ef",
    avatar: "#e7d4bf",
  },
} as const;

const mockPageContext = {
  url: "/courses/momentum-method/modules/build-your-rhythm/lessons/minimum-day",
  title: "Designing Your Minimum Day",
  course: { id: "course_momentum", title: "Momentum Method" },
  module: { id: "module_rhythm", position: 2, title: "Build Your Rhythm" },
  lesson: { id: "lesson_minimum_day", position: 3, title: "Minimum Day" },
  progress: { completedLessons: 7, totalLessons: 12 },
} as const;

const currentLearning = {
  course: mockPageContext.course.title,
  location: `${mockPageContext.module.position}. ${mockPageContext.module.title} · ${mockPageContext.lesson.position}. ${mockPageContext.lesson.title}`,
  progressLabel: `${mockPageContext.progress.completedLessons}/${mockPageContext.progress.totalLessons} lessons`,
  progressPercent: Math.round(
    (mockPageContext.progress.completedLessons /
      mockPageContext.progress.totalLessons) *
      100,
  ),
};

const voiceStages: readonly Exclude<VoicePhase, "off">[] = [
  "connecting",
  "listening",
  "thinking",
  "speaking",
];

const voiceLabels: Record<Exclude<VoicePhase, "off">, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export default function StudentChatPrototype() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const resizeRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    width: number;
    height: number;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("off");
  const [voiceCaption, setVoiceCaption] = useState("");
  const [voiceFinal, setVoiceFinal] = useState("");
  const [voiceRound, setVoiceRound] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [companionSize, setCompanionSize] = useState({
    width: 1120,
    height: 900,
  });
  const [attachment, setAttachment] = useState<File | null>(null);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState(
    "Assistant is ready. Type, speak, or attach a file.",
  );
  const voiceActive = voicePhase !== "off";

  useEffect(() => {
    if (voicePhase === "off") return;

    let phaseTimer = 0;
    let streamTimer = 0;

    if (voicePhase === "connecting") {
      setVoiceCaption("Opening a secure realtime session…");
      phaseTimer = window.setTimeout(() => {
        setVoicePhase("listening");
        setAnnouncement("Realtime voice connected. Listening.");
      }, 700);
    }

    if (voicePhase === "listening") {
      if (isMuted) {
        setVoiceCaption("Microphone muted — unmute when you are ready.");
      } else {
        const partials =
          voiceRound === 0
            ? [
                "I want to rebuild…",
                "I want to rebuild my planning habit…",
                "I want to rebuild my planning habit without overcomplicating it.",
              ]
            : [
                "Actually…",
                "Actually, can we make it even smaller?",
                "Actually, can we make it even smaller for busy days?",
              ];
        let partialIndex = 0;
        setVoiceCaption(partials[partialIndex] ?? "");
        streamTimer = window.setInterval(() => {
          partialIndex += 1;
          setVoiceCaption(partials[partialIndex] ?? partials.at(-1) ?? "");
        }, 520);
        phaseTimer = window.setTimeout(() => {
          setVoiceFinal(partials.at(-1) ?? "");
          setVoicePhase("thinking");
          setAnnouncement("Transcript finalized. Nova is thinking.");
        }, partials.length * 520 + 420);
      }
    }

    if (voicePhase === "thinking") {
      setVoiceCaption("Grounding your question in this lesson…");
      phaseTimer = window.setTimeout(() => {
        setVoiceCaption("");
        setVoicePhase("speaking");
        setAnnouncement("Nova is speaking. You can interrupt at any time.");
      }, 950);
    }

    if (voicePhase === "speaking") {
      const response =
        voiceRound === 0
          ? "Start with one ten-minute planning reset. Once that feels automatic, build from there."
          : "Yes. Make the busy-day version two minutes: open your plan, choose one priority, and stop.";
      const words = response.split(" ");
      let wordIndex = 0;
      streamTimer = window.setInterval(() => {
        wordIndex += 1;
        setVoiceCaption(words.slice(0, wordIndex).join(" "));
      }, 90);
      phaseTimer = window.setTimeout(() => {
        setVoiceRound((round) => round + 1);
        setVoiceFinal("");
        setVoicePhase("listening");
        setAnnouncement("Nova finished speaking and is listening again.");
      }, words.length * 90 + 1500);
    }

    return () => {
      window.clearTimeout(phaseTimer);
      window.clearInterval(streamTimer);
    };
  }, [isMuted, voicePhase, voiceRound]);

  function acceptFile(file?: File) {
    if (!file) return;
    setAttachment(file);
    setAnnouncement(`${file.name} is attached and ready to send.`);
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    acceptFile(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    acceptFile(event.dataTransfer.files?.[0]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content && !attachment) return;

    const label = content || `Shared ${attachment?.name ?? "a file"}`;
    setFollowUp(label);
    setDraft("");
    setAttachment(null);
    endVoice(false);
    setAnnouncement("Your message was added to the conversation.");
  }

  function startVoice() {
    setVoiceRound(0);
    setVoiceFinal("");
    setVoiceCaption("");
    setWasInterrupted(false);
    setIsMuted(false);
    setVoicePhase("connecting");
    setAnnouncement("Connecting to simulated realtime voice.");
  }

  function endVoice(focusText = true) {
    setVoicePhase("off");
    setVoiceCaption("");
    setVoiceFinal("");
    setIsMuted(false);
    setAnnouncement("Voice ended. The same conversation is ready in text.");
    if (focusText) {
      window.requestAnimationFrame(() => messageInputRef.current?.focus());
    }
  }

  function interruptVoice() {
    setWasInterrupted(true);
    setVoiceRound((round) => round + 1);
    setVoiceFinal("");
    setVoiceCaption("Go ahead — I stopped speaking and I’m listening.");
    setVoicePhase("listening");
    setAnnouncement("Nova was interrupted and stopped speaking.");
  }

  function toggleExpanded() {
    setIsExpanded((expanded) => !expanded);
    setAnnouncement(
      isExpanded ? "Companion restored." : "Companion expanded.",
    );
  }

  function handleMoveStart(event: PointerEvent<HTMLElement>) {
    if (
      isExpanded ||
      (event.target as HTMLElement).closest("button, a, input, textarea")
    ) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsMoving(true);
  }

  function handleMove(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPosition({
      x: Math.max(
        -window.innerWidth / 2,
        Math.min(window.innerWidth / 2, drag.originX + event.clientX - drag.startX),
      ),
      y: Math.max(
        -window.innerHeight / 2,
        Math.min(
          window.innerHeight / 2,
          drag.originY + event.clientY - drag.startY,
        ),
      ),
    });
  }

  function handleMoveEnd(event: PointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsMoving(false);
    setAnnouncement("Companion moved.");
  }

  function handleMoveKey(event: KeyboardEvent<HTMLElement>) {
    if (!event.altKey || isExpanded) return;
    const move = event.shiftKey ? 32 : 12;
    const delta = {
      ArrowLeft: { x: -move, y: 0 },
      ArrowRight: { x: move, y: 0 },
      ArrowUp: { x: 0, y: -move },
      ArrowDown: { x: 0, y: move },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    setPosition((current) => ({
      x: current.x + delta.x,
      y: current.y + delta.y,
    }));
    setAnnouncement("Companion moved with the keyboard.");
  }

  function handleResizeStart(event: PointerEvent<HTMLButtonElement>) {
    if (isExpanded) return;
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: companionSize.width,
      height: companionSize.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  }

  function handleResize(event: PointerEvent<HTMLButtonElement>) {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setCompanionSize({
      width: Math.max(
        700,
        Math.min(1320, resize.width + event.clientX - resize.startX),
      ),
      height: Math.max(
        620,
        Math.min(980, resize.height + event.clientY - resize.startY),
      ),
    });
  }

  function handleResizeEnd(event: PointerEvent<HTMLButtonElement>) {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    setIsResizing(false);
    setAnnouncement("Companion resized.");
  }

  function handleResizeKey(event: KeyboardEvent<HTMLButtonElement>) {
    const resize = event.shiftKey ? 48 : 18;
    const delta = {
      ArrowLeft: { width: -resize, height: 0 },
      ArrowRight: { width: resize, height: 0 },
      ArrowUp: { width: 0, height: -resize },
      ArrowDown: { width: 0, height: resize },
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    setCompanionSize((current) => ({
      width: Math.max(700, Math.min(1320, current.width + delta.width)),
      height: Math.max(620, Math.min(980, current.height + delta.height)),
    }));
  }

  const companionStyle = {
    "--tenant-primary": demoTenant.brand.primary,
    "--tenant-primary-deep": demoTenant.brand.primaryDeep,
    "--tenant-primary-soft": demoTenant.brand.primarySoft,
    "--tenant-canvas": demoTenant.brand.canvas,
    "--tenant-avatar": demoTenant.brand.avatar,
    "--companion-width": `${companionSize.width}px`,
    "--companion-height": `${companionSize.height}px`,
    "--companion-x": `${position.x}px`,
    "--companion-y": `${position.y}px`,
  } as CSSProperties;

  const activeVoiceStage =
    voicePhase === "off" ? -1 : voiceStages.indexOf(voicePhase);

  const voiceDescription =
    voicePhase === "connecting"
      ? "Negotiating low-latency audio"
      : voicePhase === "listening"
        ? isMuted
          ? "Microphone muted"
          : "Streaming partial transcript"
        : voicePhase === "thinking"
          ? "Retrieving lesson context"
          : voicePhase === "speaking"
            ? "Streaming audio · barge-in ready"
            : "";

  const companionClasses = [
    styles.appFrame,
    isExpanded ? styles.expanded : "",
    isMoving ? styles.moving : "",
    isResizing ? styles.resizing : "",
  ]
    .filter(Boolean)
    .join(" ");

  const pageClasses = [
    styles.page,
    isExpanded ? styles.pageExpanded : "",
  ]
    .filter(Boolean)
    .join(" ");

  const assistantName = demoTenant.assistant.name;

  function toggleVoice() {
    if (voiceActive) {
      endVoice();
    } else {
      startVoice();
    }
  }

  return (
    <main className={pageClasses}>
      <div className={companionClasses} style={companionStyle}>
        <div className={styles.sheetGrabber} aria-hidden="true" />
        <header
          className={styles.topbar}
          onPointerDown={handleMoveStart}
          onPointerMove={handleMove}
          onPointerUp={handleMoveEnd}
          onPointerCancel={handleMoveEnd}
          onKeyDown={handleMoveKey}
          tabIndex={0}
          aria-label="Companion window. Hold Alt and use arrow keys to move."
        >
          <a
            className={styles.brand}
            href="#"
            aria-label={`${demoTenant.name} learning home`}
          >
            <span className={styles.brandMark} aria-hidden="true">
              {demoTenant.logoText}
            </span>
            <span>
              <strong>{assistantName}</strong>
              <small>{demoTenant.name}</small>
            </span>
          </a>

          <div className={styles.contextPicker}>
            <span className={styles.courseIcon}>
              <Icon name="book" size={16} />
            </span>
            <span>
              <small>{currentLearning.location}</small>
              <strong>{currentLearning.course}</strong>
              <span className={styles.progressTrack} aria-hidden="true">
                <span style={{ width: `${currentLearning.progressPercent}%` }} />
              </span>
            </span>
            <span className={styles.progressLabel}>
              {currentLearning.progressLabel}
            </span>
          </div>

          <div className={styles.headerActions}>
            <button
              type="button"
              aria-label={
                isExpanded ? "Restore companion window" : "Expand companion window"
              }
              aria-pressed={isExpanded}
              onClick={toggleExpanded}
            >
              <Icon name="expand" size={17} />
            </button>
            <button type="button" aria-label="More conversation options">
              <Icon name="more" size={19} />
            </button>
            <span
              className={styles.avatar}
              aria-label={`Signed in as ${demoTenant.learner.name}`}
            >
              {demoTenant.learner.avatarText}
            </span>
          </div>
        </header>

        <section
          className={styles.conversation}
          aria-label={`Conversation with ${assistantName}`}
        >
          <div className={styles.thread}>
            <div className={styles.dayMarker}>
              <span>Today</span>
            </div>

            <article className={`${styles.messageRow} ${styles.studentRow}`}>
              <div className={styles.studentBubble}>
                I understand the consistency flywheel, but I keep falling off
                after a busy week. How do I make it work in real life?
              </div>
              <span className={styles.messageTime}>10:42</span>
            </article>

            <article className={`${styles.messageRow} ${styles.assistantRow}`}>
              <div className={styles.assistantIdentity}>
                <span className={styles.assistantMark}>
                  {demoTenant.assistant.avatarText}
                </span>
              </div>
              <div className={styles.answer}>
                <div className={styles.answerMeta}>
                  <strong>{assistantName}</strong>
                  <span>Course-grounded answer</span>
                </div>

                <p>
                  The flywheel does not depend on having perfect weeks. It
                  depends on making your <em>restart small enough</em> that a
                  disrupted week never becomes a lost month.
                </p>

                <p>
                  In the Momentum Method, Estie calls this your{" "}
                  <strong>Minimum Day</strong>: the smallest version of the habit
                  that still keeps your identity and momentum intact.
                </p>

                <div className={styles.steps} aria-label="Three-step reset plan">
                  <div>
                    <span>01</span>
                    <p>
                      <strong>Define the floor</strong>
                      Choose a version that takes ten minutes or less.
                    </p>
                  </div>
                  <div>
                    <span>02</span>
                    <p>
                      <strong>Protect the restart</strong>
                      Put it on the first calm day after disruption.
                    </p>
                  </div>
                  <div>
                    <span>03</span>
                    <p>
                      <strong>Build back gradually</strong>
                      Return to full pace only after two Minimum Days.
                    </p>
                  </div>
                </div>

                <figure className={styles.diagram}>
                  <div className={styles.diagramCanvas}>
                    <div className={styles.diagramNode}>
                      <span>1</span>
                      <strong>Tiny action</strong>
                    </div>
                    <span className={styles.diagramArrow}>
                      <Icon name="arrow" size={18} />
                    </span>
                    <div className={styles.diagramNode}>
                      <span>2</span>
                      <strong>Evidence</strong>
                    </div>
                    <span className={styles.diagramArrow}>
                      <Icon name="arrow" size={18} />
                    </span>
                    <div className={styles.diagramNode}>
                      <span>3</span>
                      <strong>Momentum</strong>
                    </div>
                  </div>
                  <figcaption>
                    <span>
                      <strong>The Consistency Flywheel</strong>
                      Momentum grows from evidence, not intensity.
                    </span>
                    <button type="button" aria-label="Open diagram full screen">
                      <Icon name="expand" size={16} />
                    </button>
                  </figcaption>
                </figure>

                <div className={styles.tryThis}>
                  <span className={styles.tryIcon}>
                    <Icon name="check" size={17} />
                  </span>
                  <p>
                    <strong>Try this now</strong>
                    Write one Minimum Day for the habit you are rebuilding. Make
                    it almost too easy to skip.
                  </p>
                </div>

                <p>
                  What habit are you trying to make consistent? I can help you
                  design the ten-minute version.
                </p>

                <div className={styles.sources}>
                  <span className={styles.sourcesLabel}>Sources</span>
                  <div className={styles.sourceList}>
                    {sources.map((source) => (
                      <button type="button" key={source.number}>
                        <span>{source.number}</span>
                        <span>
                          <strong>{source.title}</strong>
                          <small>{source.detail}</small>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.answerActions}>
                  <button type="button">
                    <Icon name="volume" size={16} />
                    Listen
                  </button>
                  <span>10:42</span>
                </div>
              </div>
            </article>

            {followUp ? (
              <article className={`${styles.messageRow} ${styles.studentRow}`}>
                <div className={styles.studentBubble}>{followUp}</div>
                <span className={styles.messageTime}>Now</span>
              </article>
            ) : null}
          </div>

          <div className={styles.composerDock}>
            <form className={styles.composer} onSubmit={handleSubmit}>
              {attachment ? (
                <div className={styles.attachmentCard}>
                  <span className={styles.fileIcon}>
                    <Icon name="file" size={18} />
                  </span>
                  <span>
                    <strong>{attachment.name}</strong>
                    <small>
                      {(attachment.size / 1024).toFixed(0)} KB · Ready to send
                    </small>
                  </span>
                  <span className={styles.readyBadge}>
                    <Icon name="check" size={12} /> Ready
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachment(null);
                      setAnnouncement("Attachment removed.");
                    }}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ) : null}

              {voicePhase !== "off" ? (
                <div
                  className={styles.voicePanel}
                  data-phase={voicePhase}
                  role="region"
                  aria-label="Simulated realtime voice conversation"
                >
                  <div className={styles.voiceStatus}>
                    <span className={styles.listeningOrb}>
                      {voicePhase === "speaking" ? (
                        <Icon name="volume" size={18} />
                      ) : (
                        <Icon name="mic" size={18} />
                      )}
                    </span>
                    <span>
                      <span className={styles.realtimeBadge}>
                        <span /> Simulated realtime
                      </span>
                      <strong>{voiceLabels[voicePhase]}</strong>
                      <small>{voiceDescription}</small>
                    </span>
                    {voicePhase === "listening" || voicePhase === "speaking" ? (
                      <Waveform />
                    ) : (
                      <span className={styles.phaseSpinner} aria-hidden="true" />
                    )}
                  </div>

                  <div className={styles.voiceRail} aria-label="Voice turn progress">
                    {voiceStages.map((stage, index) => (
                      <span
                        className={
                          index === activeVoiceStage
                            ? styles.voiceStageActive
                            : index < activeVoiceStage
                              ? styles.voiceStageComplete
                              : ""
                        }
                        key={stage}
                      >
                        <i />
                        {voiceLabels[stage]}
                      </span>
                    ))}
                  </div>

                  <div
                    className={styles.liveCaption}
                    aria-live="polite"
                    aria-atomic="true"
                  >
                    <span>
                      {voicePhase === "speaking"
                        ? assistantName
                        : voicePhase === "thinking"
                          ? "System"
                          : "You"}
                    </span>
                    <p>
                      {voiceCaption || "Audio response is starting…"}
                      {(voicePhase === "listening" ||
                        voicePhase === "speaking") &&
                      !isMuted ? (
                        <i aria-hidden="true" />
                      ) : null}
                    </p>
                    {voiceFinal && voicePhase === "thinking" ? (
                      <small>Final transcript: “{voiceFinal}”</small>
                    ) : null}
                    {wasInterrupted && voicePhase === "listening" ? (
                      <small className={styles.interruptedNote}>
                        Playback interrupted · listening resumed
                      </small>
                    ) : null}
                  </div>

                  <div className={styles.voiceControls}>
                    <button
                      type="button"
                      className={isMuted ? styles.controlActive : ""}
                      onClick={() => {
                        setIsMuted((muted) => !muted);
                        setAnnouncement(
                          isMuted ? "Microphone unmuted." : "Microphone muted.",
                        );
                      }}
                      aria-pressed={isMuted}
                    >
                      <Icon name="mic" size={14} />
                      {isMuted ? "Unmute" : "Mute"}
                    </button>
                    {voicePhase === "speaking" ||
                    voicePhase === "thinking" ? (
                      <button
                        type="button"
                        className={styles.interruptButton}
                        onClick={interruptVoice}
                      >
                        <span aria-hidden="true">■</span>
                        Interrupt
                      </button>
                    ) : null}
                    <button type="button" onClick={() => endVoice()}>
                      Text mode
                    </button>
                    <button
                      type="button"
                      className={styles.endButton}
                      onClick={() => endVoice()}
                    >
                      End
                    </button>
                  </div>
                </div>
              ) : null}

              <div
                className={`${styles.inputArea} ${
                  isDragging ? styles.dragging : ""
                }`}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
                onPaste={(event) => acceptFile(event.clipboardData.files?.[0])}
              >
                {isDragging ? (
                  <div className={styles.dropOverlay}>Drop to add to this message</div>
                ) : null}
                <textarea
                  ref={messageInputRef}
                  aria-label={`Message ${assistantName}`}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  placeholder="Ask about this lesson…"
                  rows={1}
                  value={draft}
                />
                <div className={styles.composerActions}>
                  <div>
                    <input
                      ref={fileInputRef}
                      className={styles.srOnly}
                      type="file"
                      onChange={handleFileChange}
                      accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.csv,image/*,audio/*,video/*"
                    />
                    <button
                      type="button"
                      className={styles.toolButton}
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Attach a file"
                    >
                      <Icon name="attach" size={18} />
                    </button>
                    <button
                      type="button"
                      className={`${styles.voiceButton} ${
                        voiceActive ? styles.voiceButtonActive : ""
                      }`}
                      onClick={toggleVoice}
                      aria-pressed={voiceActive}
                      aria-label={
                        voiceActive
                          ? "Switch voice conversation back to text"
                          : "Start simulated realtime voice"
                      }
                    >
                      <Icon name="mic" size={18} />
                      <span>Voice</span>
                    </button>
                  </div>
                  <button
                    className={styles.sendButton}
                    type="submit"
                    disabled={!draft.trim() && !attachment}
                    aria-label="Send message"
                  >
                    <Icon name="send" size={17} />
                  </button>
                </div>
              </div>
            </form>

            <div className={styles.composerFooter}>
              <span>
                <Icon name="headphones" size={14} />
                Voice, text, and files stay in one conversation
              </span>
              <span>
                {assistantName} can make mistakes. Check important details.
              </span>
            </div>
          </div>
        </section>

        <div className={styles.srOnly} aria-live="polite">
          {announcement}
        </div>
        <button
          type="button"
          className={styles.resizeHandle}
          aria-label="Resize companion. Use arrow keys; hold Shift for larger steps."
          onPointerDown={handleResizeStart}
          onPointerMove={handleResize}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onKeyDown={handleResizeKey}
        >
          <span />
          <span />
          <span />
        </button>
      </div>
    </main>
  );
}
