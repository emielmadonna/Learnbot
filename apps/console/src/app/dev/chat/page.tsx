"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type TransitionEvent as ReactTransitionEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  BRANDING_EVENT,
  DEFAULT_RUNTIME_BRANDING,
  loadRuntimeBranding,
  type RuntimeBranding,
} from "../../../lib/branding-runtime";
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

function LiquidVoiceOrb({
  color,
  isMuted,
  phase,
  stream,
}: {
  color: string;
  isMuted: boolean;
  phase: Exclude<VoicePhase, "off">;
  stream: MediaStream | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  const mutedRef = useRef(isMuted);

  useEffect(() => {
    phaseRef.current = phase;
    mutedRef.current = isMuted;
  }, [isMuted, phase]);

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;
    const contextResult = canvasElement.getContext("2d");
    if (!contextResult) return;
    const canvas = canvasElement;
    const context = contextResult;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const AudioContextConstructor =
      window.AudioContext ??
      (
        window as typeof window & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    const audioContext =
      stream && AudioContextConstructor ? new AudioContextConstructor() : null;
    const analyser = audioContext?.createAnalyser() ?? null;
    let audioAnalysisReady = audioContext?.state === "running";
    let disposed = false;
    const source =
      audioContext && analyser && stream
        ? audioContext.createMediaStreamSource(stream)
        : null;
    if (analyser && source) {
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.76;
      source.connect(analyser);
    }
    if (audioContext?.state === "suspended") {
      void audioContext
        .resume()
        .then(() => {
          if (!disposed) audioAnalysisReady = audioContext.state === "running";
        })
        .catch(() => {
          // Keep the synthetic phase animation when browser audio policy blocks
          // analysis. Voice recognition remains independently available.
          audioAnalysisReady = false;
        });
    }

    const timeData = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;
    const frequencyData = analyser
      ? new Uint8Array(analyser.frequencyBinCount)
      : null;
    let frame = 0;
    let smoothedEnergy = 0.04;
    let smoothedCentroid = 0.42;

    const hex = color.trim().replace("#", "");
    const normalizedHex =
      hex.length === 3
        ? hex
            .split("")
            .map((character) => character + character)
            .join("")
        : hex;
    const parsed = Number.parseInt(normalizedHex, 16);
    const tenantColor =
      normalizedHex.length === 6 && Number.isFinite(parsed)
        ? {
            red: (parsed >> 16) & 255,
            green: (parsed >> 8) & 255,
            blue: parsed & 255,
          }
        : { red: 31, green: 89, blue: 70 };
    const clampChannel = (value: number) =>
      Math.max(0, Math.min(255, Math.round(value)));
    const rgba = (alpha: number, lightness = 0) =>
      `rgba(${clampChannel(tenantColor.red + lightness)}, ${clampChannel(
        tenantColor.green + lightness,
      )}, ${clampChannel(tenantColor.blue + lightness)}, ${alpha})`;
    const coolRgba = (alpha: number) =>
      `rgba(${clampChannel(tenantColor.red * 0.62)}, ${clampChannel(
        tenantColor.green * 0.78,
      )}, ${clampChannel(tenantColor.blue * 0.9 + 72)}, ${alpha})`;

    function addBlobPath(
      target: CanvasRenderingContext2D,
      centerX: number,
      centerY: number,
      radius: number,
      timestamp: number,
      energy: number,
      centroid: number,
    ) {
      const points = Array.from({ length: 72 }, (_, index) => {
        const angle = (index / 72) * Math.PI * 2;
        const movement = reducedMotion ? 0 : timestamp;
        const liquid =
          Math.sin(angle * 2 + movement * 0.0017) * (0.008 + energy * 0.07) +
          Math.sin(angle * 3 - movement * 0.0011 + centroid * 5) *
            (0.006 + energy * 0.045) +
          Math.cos(angle * 5 + movement * 0.0008) * (0.004 + energy * 0.018);
        const radial = radius * (1 + liquid);
        return {
          x: centerX + Math.cos(angle) * radial,
          y:
            centerY +
            Math.sin(angle) *
              radial *
              (0.94 + centroid * 0.025 + Math.cos(angle * 2) * energy * 0.012),
        };
      });
      const first = points[0];
      const last = points.at(-1);
      if (!first || !last) return;
      target.beginPath();
      target.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
      points.forEach((point, index) => {
        const next = points[(index + 1) % points.length];
        if (!next) return;
        target.quadraticCurveTo(
          point.x,
          point.y,
          (point.x + next.x) / 2,
          (point.y + next.y) / 2,
        );
      });
      target.closePath();
    }

    function draw(timestamp: number) {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, canvas.clientWidth);
      const height = Math.max(1, canvas.clientHeight);
      if (
        canvas.width !== Math.round(width * pixelRatio) ||
        canvas.height !== Math.round(height * pixelRatio)
      ) {
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
      }
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      let energy = 0;
      let centroid = 0.42;
      if (
        analyser &&
        audioAnalysisReady &&
        timeData &&
        frequencyData &&
        !mutedRef.current
      ) {
        analyser.getByteTimeDomainData(timeData);
        analyser.getByteFrequencyData(frequencyData);
        let squared = 0;
        let weighted = 0;
        let magnitude = 0;
        for (let index = 0; index < timeData.length; index += 1) {
          const sample = ((timeData[index] ?? 128) - 128) / 128;
          squared += sample * sample;
          const bin = frequencyData[index] ?? 0;
          weighted += index * bin;
          magnitude += bin;
        }
        energy = Math.min(1, Math.sqrt(squared / timeData.length) * 4.4);
        centroid =
          magnitude > 0
            ? Math.min(1, weighted / magnitude / frequencyData.length)
            : centroid;
      } else if (!mutedRef.current && !reducedMotion) {
        const pulse = (Math.sin(timestamp * 0.0024) + 1) / 2;
        energy =
          phaseRef.current === "speaking"
            ? 0.42 + pulse * 0.36
            : phaseRef.current === "thinking"
              ? 0.1 + pulse * 0.1
              : phaseRef.current === "listening"
                ? 0.08 + pulse * 0.12
                : 0.03 + pulse * 0.04;
        centroid =
          phaseRef.current === "speaking"
            ? 0.48 + Math.sin(timestamp * 0.0013) * 0.12
            : 0.38 + Math.sin(timestamp * 0.0008) * 0.06;
      }

      smoothedEnergy += (energy - smoothedEnergy) * 0.18;
      smoothedCentroid += (centroid - smoothedCentroid) * 0.08;
      const centerX = width / 2;
      const centerY = height / 2;
      const radius =
        Math.min(width, height) *
        (0.265 + smoothedEnergy * (reducedMotion ? 0.012 : 0.032));

      context.save();
      context.filter = `blur(${20 + smoothedEnergy * 10}px)`;
      context.fillStyle = rgba(0.14 + smoothedEnergy * 0.06, 48);
      addBlobPath(
        context,
        centerX,
        centerY + radius * 0.18,
        radius * 0.98,
        timestamp,
        smoothedEnergy,
        smoothedCentroid,
      );
      context.fill();
      context.restore();

      const bodyGradient = context.createRadialGradient(
        centerX - radius * 0.34,
        centerY - radius * 0.42,
        radius * 0.08,
        centerX + radius * 0.12,
        centerY + radius * 0.15,
        radius * 1.18,
      );
      bodyGradient.addColorStop(0, "rgba(255,255,255,.95)");
      bodyGradient.addColorStop(0.23, rgba(0.72, 132));
      bodyGradient.addColorStop(
        0.62,
        rgba(0.68 + smoothedEnergy * 0.1, 64),
      );
      bodyGradient.addColorStop(1, coolRgba(0.9));

      addBlobPath(
        context,
        centerX,
        centerY,
        radius,
        timestamp,
        smoothedEnergy,
        smoothedCentroid,
      );
      context.save();
      context.fillStyle = bodyGradient;
      context.shadowColor = rgba(0.22, 18);
      context.shadowBlur = 24;
      context.shadowOffsetY = 16;
      context.fill();
      context.clip();

      const depthBand = context.createLinearGradient(
        centerX,
        centerY - radius,
        centerX,
        centerY + radius,
      );
      depthBand.addColorStop(0, "rgba(255,255,255,.38)");
      depthBand.addColorStop(0.45, rgba(0.02, 120));
      depthBand.addColorStop(0.7, coolRgba(0.18));
      depthBand.addColorStop(1, coolRgba(0.48));
      context.fillStyle = depthBand;
      context.fillRect(
        centerX - radius * 1.2,
        centerY - radius,
        radius * 2.4,
        radius * 2,
      );

      const drift = reducedMotion ? 0 : timestamp * 0.001;
      const cloudLayers = [
        {
          x: -0.3 + Math.sin(drift * 0.7) * 0.08,
          y: -0.34 + Math.cos(drift * 0.5) * 0.06,
          rx: 0.54,
          ry: 0.22,
          color: "rgba(255,255,255,.58)",
        },
        {
          x: 0.26 + Math.cos(drift * 0.55) * 0.08,
          y: -0.05 + Math.sin(drift * 0.8) * 0.06,
          rx: 0.5,
          ry: 0.26,
          color: rgba(0.26, 138),
        },
        {
          x: -0.12 + Math.sin(drift * 0.46) * 0.1,
          y: 0.28 + Math.cos(drift * 0.62) * 0.05,
          rx: 0.62,
          ry: 0.2,
          color: coolRgba(0.2),
        },
      ];
      context.globalCompositeOperation = "soft-light";
      context.filter = `blur(${11 + smoothedEnergy * 4}px)`;
      cloudLayers.forEach((layer) => {
        context.fillStyle = layer.color;
        context.beginPath();
        context.ellipse(
          centerX + radius * layer.x,
          centerY + radius * layer.y,
          radius * layer.rx,
          radius * layer.ry,
          Math.sin(drift * 0.35 + layer.x) * 0.34,
          0,
          Math.PI * 2,
        );
        context.fill();
      });

      context.globalCompositeOperation = "multiply";
      context.filter = "blur(9px)";
      const lowerDepth = context.createRadialGradient(
        centerX + radius * 0.12,
        centerY + radius * 0.68,
        radius * 0.04,
        centerX,
        centerY + radius * 0.46,
        radius * 0.86,
      );
      lowerDepth.addColorStop(0, coolRgba(0.34));
      lowerDepth.addColorStop(0.72, coolRgba(0.1));
      lowerDepth.addColorStop(1, "rgba(255,255,255,0)");
      context.fillStyle = lowerDepth;
      context.fillRect(
        centerX - radius,
        centerY - radius * 0.2,
        radius * 2,
        radius * 1.3,
      );

      context.globalCompositeOperation = "screen";
      context.filter = "blur(8px)";
      context.fillStyle = "rgba(255,255,255,.54)";
      context.beginPath();
      context.ellipse(
        centerX - radius * 0.25,
        centerY - radius * 0.36,
        radius * 0.42,
        radius * 0.16,
        -0.42 + smoothedCentroid * 0.3,
        0,
        Math.PI * 2,
      );
      context.fill();
      context.restore();

      addBlobPath(
        context,
        centerX,
        centerY,
        radius,
        timestamp,
        smoothedEnergy,
        smoothedCentroid,
      );
      context.strokeStyle = "rgba(255,255,255,.28)";
      context.lineWidth = 1;
      context.stroke();

      if (!reducedMotion || analyser) frame = window.requestAnimationFrame(draw);
    }

    frame = window.requestAnimationFrame(draw);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      source?.disconnect();
      analyser?.disconnect();
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close();
      }
    };
  }, [color, stream]);

  return (
    <canvas
      ref={canvasRef}
      className={styles.liquidOrb}
      aria-hidden="true"
    />
  );
}

const sources = [
  {
    number: 1,
    title: "Designing Your Minimum Day",
    detail: "Momentum Method · Lesson 2.3",
  },
];

type VoicePhase =
  | "off"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

type VoiceTransport = "browser-realtime" | "interactive-demo";
type VoicePresentation = "text" | "entering" | "voice" | "exiting";
type AttachmentStatus =
  | "idle"
  | "validating"
  | "scanning"
  | "extracting"
  | "ready"
  | "error";

type SpeechRecognitionResultLike = {
  isFinal: boolean;
  0: { transcript: string };
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

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

const defaultCurrentLearning: {
  course: string;
  location: string;
  progressLabel: string;
  progressPercent: number;
} = {
  course: mockPageContext.course.title,
  location: `${mockPageContext.module.position}. ${mockPageContext.module.title} · ${mockPageContext.lesson.position}. ${mockPageContext.lesson.title}`,
  progressLabel: `${mockPageContext.progress.completedLessons}/${mockPageContext.progress.totalLessons} lessons`,
  progressPercent: Math.round(
    (mockPageContext.progress.completedLessons /
      mockPageContext.progress.totalLessons) *
      100,
  ),
};

const voiceLabels: Record<Exclude<VoicePhase, "off">, string> = {
  connecting: "Connecting",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
};

export default function StudentChatPrototype() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const companionRef = useRef<HTMLDivElement>(null);
  const voiceTriggerRef = useRef<HTMLButtonElement>(null);
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
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const shouldListenRef = useRef(false);
  const voicePhaseRef = useRef<VoicePhase>("off");
  const isMutedRef = useRef(false);
  const attachmentTokenRef = useRef(0);
  const voiceResponseRef = useRef("");
  const voiceSessionIdRef = useRef<string | null>(null);
  const voiceGenerationRef = useRef(0);
  const voiceRestartTimersRef = useRef<Set<number>>(new Set());
  const voicePresentationRef = useRef<VoicePresentation>("text");
  const voiceTransitionTimerRef = useRef<number | null>(null);
  const voiceTransitionFramesRef = useRef<Set<number>>(new Set());
  const interruptionTimerRef = useRef<number | null>(null);
  const lastVoicePhaseRef =
    useRef<Exclude<VoicePhase, "off">>("connecting");
  const focusTextAfterVoiceRef = useRef(false);
  const [draft, setDraft] = useState("");
  const [runtimeBranding, setRuntimeBranding] = useState<RuntimeBranding>(
    DEFAULT_RUNTIME_BRANDING,
  );
  const [currentLearning, setCurrentLearning] = useState(defaultCurrentLearning);
  const [voicePhase, setVoicePhase] = useState<VoicePhase>("off");
  const [voiceCaption, setVoiceCaption] = useState("");
  const [voiceFinal, setVoiceFinal] = useState("");
  const [voiceRound, setVoiceRound] = useState(0);
  const [voiceTransport, setVoiceTransport] =
    useState<VoiceTransport>("browser-realtime");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voicePresentation, setVoicePresentation] =
    useState<VoicePresentation>("text");
  const [voiceOrigin, setVoiceOrigin] = useState({
    x: "56%",
    y: "calc(100% - 50px)",
  });
  const [microphoneStream, setMicrophoneStream] =
    useState<MediaStream | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [wasInterrupted, setWasInterrupted] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [companionSize, setCompanionSize] = useState({
    width: 1120,
    height: 900,
  });
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentStatus, setAttachmentStatus] =
    useState<AttachmentStatus>("idle");
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploadedAttachmentId, setUploadedAttachmentId] = useState<string | null>(
    null,
  );
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [followUpAnswer, setFollowUpAnswer] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [followUpSource, setFollowUpSource] = useState(
    sources[0] ?? {
      number: 1,
      title: "Published learning source",
      detail: "Grounded course knowledge",
    },
  );
  const [replyStatus, setReplyStatus] = useState<
    "idle" | "streaming" | "complete" | "error"
  >("idle");
  const [announcement, setAnnouncement] = useState(
    "Assistant is ready. Type, speak, or attach a file.",
  );
  const voiceActive = voicePhase !== "off";
  const voiceVisible = voicePresentation !== "text";
  const renderedVoicePhase =
    voicePhase === "off" ? lastVoicePhaseRef.current : voicePhase;

  function userPrefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  }

  function scheduleVoiceFrame(callback: () => void) {
    const frame = window.requestAnimationFrame(() => {
      voiceTransitionFramesRef.current.delete(frame);
      callback();
    });
    voiceTransitionFramesRef.current.add(frame);
  }

  function clearVoicePresentationSchedule() {
    if (voiceTransitionTimerRef.current !== null) {
      window.clearTimeout(voiceTransitionTimerRef.current);
      voiceTransitionTimerRef.current = null;
    }
    voiceTransitionFramesRef.current.forEach((frame) =>
      window.cancelAnimationFrame(frame),
    );
    voiceTransitionFramesRef.current.clear();
  }

  function completeVoiceExit() {
    if (
      voicePresentationRef.current !== "exiting" ||
      voicePhaseRef.current !== "off"
    ) {
      return;
    }
    clearVoicePresentationSchedule();
    voicePresentationRef.current = "text";
    setVoicePresentation("text");
  }

  function captureVoiceOrigin() {
    const frame = companionRef.current?.getBoundingClientRect();
    const trigger = voiceTriggerRef.current?.getBoundingClientRect();
    if (!frame || !trigger) return;
    setVoiceOrigin({
      x: `${trigger.left + trigger.width / 2 - frame.left}px`,
      y: `${trigger.top + trigger.height / 2 - frame.top}px`,
    });
  }

  function handleVoiceTransitionEnd(
    event: ReactTransitionEvent<HTMLDivElement>,
  ) {
    if (
      event.target === event.currentTarget &&
      event.propertyName === "clip-path" &&
      voicePresentationRef.current === "exiting"
    ) {
      completeVoiceExit();
    }
  }

  useEffect(() => {
    voicePhaseRef.current = voicePhase;
    if (voicePhase !== "off") lastVoicePhaseRef.current = voicePhase;
  }, [voicePhase]);

  useEffect(() => {
    clearVoicePresentationSchedule();

    if (voiceActive) {
      if (
        voicePresentationRef.current === "text" ||
        voicePresentationRef.current === "exiting"
      ) {
        if (userPrefersReducedMotion()) {
          voicePresentationRef.current = "voice";
          setVoicePresentation("voice");
          return;
        }
        voicePresentationRef.current = "entering";
        setVoicePresentation("entering");
        scheduleVoiceFrame(() => {
          scheduleVoiceFrame(() => {
            if (
              voicePhaseRef.current !== "off" &&
              voicePresentationRef.current === "entering"
            ) {
              voicePresentationRef.current = "voice";
              setVoicePresentation("voice");
            }
          });
        });
      }
      return;
    }

    if (voicePresentationRef.current !== "text") {
      voicePresentationRef.current = "exiting";
      setVoicePresentation("exiting");
      if (userPrefersReducedMotion()) {
        completeVoiceExit();
        return;
      }
      voiceTransitionTimerRef.current = window.setTimeout(() => {
        completeVoiceExit();
      }, 460);
    }
  }, [voiceActive]);

  useEffect(() => {
    if (
      voicePresentation !== "text" ||
      !focusTextAfterVoiceRef.current ||
      voicePhaseRef.current !== "off"
    ) {
      return;
    }
    focusTextAfterVoiceRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      messageInputRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [voicePresentation]);

  useEffect(() => {
    if (!diagramOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setDiagramOpen(false);
        setAnnouncement("Diagram closed.");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [diagramOpen]);

  useEffect(() => {
    setRuntimeBranding(loadRuntimeBranding());
    const handleBranding = (event: Event) => {
      const custom = event as CustomEvent<RuntimeBranding>;
      setRuntimeBranding(custom.detail ?? loadRuntimeBranding());
    };
    const handleStorage = () => setRuntimeBranding(loadRuntimeBranding());
    window.addEventListener(BRANDING_EVENT, handleBranding);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener(BRANDING_EVENT, handleBranding);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/dev/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: mockPageContext.url,
        title: mockPageContext.title,
        studentId: "student_maya_demo",
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Context resolution failed.");
        return response.json() as Promise<{
          course?: string;
          module?: string;
          lesson?: string;
          progress?: {
            coursePercentComplete?: number;
            completedLessonIds: readonly string[];
          };
        }>;
      })
      .then((resolved) => {
        setCurrentLearning({
          course: resolved.course ?? defaultCurrentLearning.course,
          location:
            resolved.module && resolved.lesson
              ? `${resolved.module} · ${resolved.lesson}`
              : defaultCurrentLearning.location,
          progressLabel: resolved.progress
            ? `${resolved.progress.completedLessonIds.length}/${mockPageContext.progress.totalLessons} lessons`
            : defaultCurrentLearning.progressLabel,
          progressPercent:
            resolved.progress?.coursePercentComplete ??
            defaultCurrentLearning.progressPercent,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setAnnouncement(
          "Learning context could not be refreshed. Showing the last verified context.",
        );
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    if (voicePhase === "off") return;

    let phaseTimer = 0;
    let streamTimer = 0;

    if (voiceTransport === "interactive-demo" && voicePhase === "connecting") {
      setVoiceCaption("Opening a secure realtime session…");
      phaseTimer = window.setTimeout(() => {
        setVoicePhase("listening");
        setAnnouncement("Realtime voice connected. Listening.");
      }, 700);
    }

    if (voiceTransport === "interactive-demo" && voicePhase === "listening") {
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
      if (voiceTransport === "interactive-demo") {
        phaseTimer = window.setTimeout(() => {
          setVoiceCaption("");
          setVoicePhase("speaking");
          setAnnouncement("Nova is speaking. You can interrupt at any time.");
        }, 950);
      }
    }

    if (voicePhase === "speaking") {
      const generation = voiceGenerationRef.current;
      const response =
        voiceTransport === "browser-realtime" && voiceResponseRef.current
          ? voiceResponseRef.current
          : voiceRound === 0
            ? "Start with one ten-minute planning reset. Once that feels automatic, build from there."
            : "Yes. Make the busy-day version two minutes: open your plan, choose one priority, and stop.";
      if (voiceTransport === "browser-realtime" && "speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(response);
        utterance.rate = 1.03;
        utterance.onboundary = (event) => {
          if (generation !== voiceGenerationRef.current) return;
          setVoiceCaption(response.slice(0, event.charIndex + event.charLength));
        };
        utterance.onend = () => {
          if (generation !== voiceGenerationRef.current) return;
          setVoiceCaption(response);
          setVoiceRound((round) => round + 1);
          setVoiceFinal("");
          setVoicePhase("listening");
          setAnnouncement("Nova finished speaking and is listening again.");
          if (shouldListenRef.current && !isMutedRef.current) {
            const recognition = recognitionRef.current;
            if (recognition) {
              scheduleRecognitionRestart(
                recognition,
                120,
                voiceGenerationRef.current,
              );
            }
          }
        };
        utterance.onerror = () => {
          if (generation !== voiceGenerationRef.current) return;
          setVoiceError("Audio playback failed. The answer remains available as text.");
          setVoicePhase("listening");
        };
        window.speechSynthesis.speak(utterance);
      } else {
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
    }

    return () => {
      window.clearTimeout(phaseTimer);
      window.clearInterval(streamTimer);
    };
  }, [isMuted, voicePhase, voiceRound, voiceTransport]);

  useEffect(() => {
    return () => {
      voiceGenerationRef.current += 1;
      clearVoiceRestartTimers();
      shouldListenRef.current = false;
      recognitionRef.current?.abort();
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      window.speechSynthesis?.cancel();
      handoffVoiceSession("user_requested");
      clearVoicePresentationSchedule();
      if (interruptionTimerRef.current !== null) {
        window.clearTimeout(interruptionTimerRef.current);
      }
    };
  }, []);

  async function acceptFile(file?: File) {
    if (!file) return;
    attachmentTokenRef.current += 1;
    setUploadedAttachmentId(null);
    const token = attachmentTokenRef.current;
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    const supportedExtensions = new Set([
      "pdf",
      "doc",
      "docx",
      "ppt",
      "pptx",
      "txt",
      "csv",
      "png",
      "jpg",
      "jpeg",
    ]);
    if (!supportedExtensions.has(extension)) {
      setAttachment(null);
      setAttachmentStatus("error");
      setAttachmentError(
        "Unsupported file. Use PDF, Word, PowerPoint, text, CSV, PNG or JPEG.",
      );
      setAnnouncement("The selected attachment type is not supported.");
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setAttachment(null);
      setAttachmentStatus("error");
      setAttachmentError("This file is larger than the 25 MB conversation limit.");
      setAnnouncement("The selected attachment is too large.");
      return;
    }
    setAttachment(file);
    setAttachmentError(null);
    setAttachmentStatus("validating");
    setAnnouncement(`${file.name} is validating.`);
    window.setTimeout(() => {
      if (token !== attachmentTokenRef.current) return;
      setAttachmentStatus("scanning");
      setAnnouncement(`${file.name} is being scanned.`);
    }, 350);
    window.setTimeout(() => {
      if (token !== attachmentTokenRef.current) return;
      setAttachmentStatus("extracting");
      setAnnouncement(`${file.name} passed scanning and is being extracted.`);
    }, 900);
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch("/api/dev/attachments", {
        method: "POST",
        body,
      });
      const payload = (await response.json()) as {
        attachment?: { attachmentId: string; status: string };
        message?: string;
      };
      if (token !== attachmentTokenRef.current) return;
      if (!response.ok || payload.attachment?.status !== "ready") {
        setAttachment(null);
        setAttachmentStatus("error");
        setAttachmentError(
          payload.message ?? "The file could not be processed safely.",
        );
        setAnnouncement("Attachment processing failed safely.");
        return;
      }
      setUploadedAttachmentId(payload.attachment.attachmentId);
      setAttachmentStatus("ready");
      setAnnouncement(
        `${file.name} passed validation and scanning and is ready to send.`,
      );
    } catch {
      if (token !== attachmentTokenRef.current) return;
      setAttachment(null);
      setAttachmentStatus("error");
      setAttachmentError("Upload failed. Check the connection and try again.");
      setAnnouncement("Attachment upload failed.");
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    void acceptFile(event.target.files?.[0]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    void acceptFile(event.dataTransfer.files?.[0]);
  }

  async function streamGroundedReply(
    content: string,
    modality: "text" | "voice",
    attachmentId: string | null,
    voiceGeneration?: number,
  ) {
    try {
      const response = await fetch("/api/dev/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          message: content,
          attachmentId,
          modality,
          pageUrl: mockPageContext.url,
          ...(conversationId ? { conversationId } : {}),
          ...(() => {
            try {
              const stored = window.localStorage.getItem(
                "learningbot.dev.activeKnowledge",
              );
              if (!stored) return {};
              const knowledge = JSON.parse(stored) as {
                title?: unknown;
                text?: unknown;
              };
              return typeof knowledge.title === "string" &&
                typeof knowledge.text === "string"
                ? {
                    knowledge: {
                      title: knowledge.title,
                      text: knowledge.text,
                    },
                  }
                : {};
            } catch {
              return {};
            }
          })(),
          idempotencyKey: `message-${Date.now()}`,
        }),
      });
      if (!response.ok) {
        let message = "Chat request failed.";
        try {
          const payload = (await response.json()) as { message?: unknown };
          if (typeof payload.message === "string" && payload.message.trim()) {
            message = payload.message;
          }
        } catch {
          // Keep the bounded fallback message.
        }
        throw new Error(message);
      }
      if (!response.body) throw new Error("Chat request failed.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completedAnswer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line) continue;
          const streamEvent = JSON.parse(line) as {
            type: string;
            text?: string;
            sources?: Array<{ title?: string; detail?: string }>;
            conversationId?: string;
          };
          if (streamEvent.type === "context" && streamEvent.conversationId) {
            setConversationId(streamEvent.conversationId);
          }
          if (streamEvent.type === "delta" && streamEvent.text) {
            completedAnswer += streamEvent.text;
            setFollowUpAnswer((current) => current + streamEvent.text);
          }
          if (streamEvent.type === "completed") {
            setReplyStatus("complete");
            const source = streamEvent.sources?.[0];
            if (source?.title) {
              setFollowUpSource({
                number: 1,
                title: source.title,
                detail: source.detail ?? "Published learning source",
              });
            }
            if (
              modality === "voice" &&
              voiceGeneration === voiceGenerationRef.current &&
              shouldListenRef.current
            ) {
              voiceResponseRef.current = completedAnswer;
              setVoiceCaption("");
              setVoicePhase("speaking");
              setAnnouncement("Nova is speaking. You can interrupt at any time.");
            }
          }
        }
      }
      setAttachment(null);
      setUploadedAttachmentId(null);
      setAttachmentStatus("idle");
      if (modality === "text") {
        setAnnouncement("Nova finished the grounded answer.");
      }
    } catch (error) {
      setReplyStatus("error");
      setFollowUpAnswer(
        error instanceof Error && error.message !== "Chat request failed."
          ? error.message
          : "I could not finish that response. Your message and attachment remain in this conversation, so you can retry safely.",
      );
      if (
        modality === "voice" &&
        voiceGeneration === voiceGenerationRef.current &&
        shouldListenRef.current
      ) {
        setVoicePhase("listening");
      }
      setAnnouncement("The response failed safely and can be retried.");
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (attachment && attachmentStatus !== "ready") {
      setAnnouncement("Wait for attachment processing to finish before sending.");
      return;
    }
    if (!content && !attachment) return;

    const label = content || `Shared ${attachment?.name ?? "a file"}`;
    setFollowUp(label);
    setFollowUpAnswer("");
    setReplyStatus("streaming");
    setDraft("");
    const modality = voiceActive ? "voice" : "text";
    endVoice(false);
    setAnnouncement("Your message was added. Nova is answering.");
    await streamGroundedReply(content, modality, uploadedAttachmentId);
  }

  function startInteractiveDemo(reason: string) {
    handoffVoiceSession("voice_unavailable");
    setMicrophoneStream(null);
    setVoiceTransport("interactive-demo");
    setVoiceError(reason);
    setVoiceRound(0);
    setVoiceFinal("");
    setVoiceCaption("");
    setWasInterrupted(false);
    setIsMuted(false);
    setVoicePhase("connecting");
    setAnnouncement(`Realtime microphone unavailable. ${reason} Interactive demo started.`);
  }

  async function startVoice() {
    captureVoiceOrigin();
    focusTextAfterVoiceRef.current = false;
    const generation = voiceGenerationRef.current + 1;
    voiceGenerationRef.current = generation;
    clearVoiceRestartTimers();
    setMicrophoneStream(null);
    setVoiceRound(0);
    setVoiceFinal("");
    setVoiceCaption("Requesting microphone access…");
    if (interruptionTimerRef.current !== null) {
      window.clearTimeout(interruptionTimerRef.current);
      interruptionTimerRef.current = null;
    }
    setWasInterrupted(false);
    setIsMuted(false);
    setVoiceError(null);
    setVoiceTransport("browser-realtime");
    setVoicePhase("connecting");
    shouldListenRef.current = true;

    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

    if (!Recognition || !navigator.mediaDevices?.getUserMedia) {
      startInteractiveDemo(
        "This browser does not expose live speech recognition.",
      );
      return;
    }

    try {
      let permissionTimedOut = false;
      let timeoutId = 0;
      const permissionRequest = navigator.mediaDevices
        .getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
          },
        })
        .then((stream) => {
          if (permissionTimedOut) {
            stream.getTracks().forEach((track) => track.stop());
            throw new DOMException(
              "Microphone permission timed out.",
              "TimeoutError",
            );
          }
          return stream;
        });
      const permissionTimeout = new Promise<MediaStream>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          permissionTimedOut = true;
          reject(
            new DOMException(
              "Microphone permission timed out.",
              "TimeoutError",
            ),
          );
        }, 8_000);
      });
      const microphoneStream = await Promise.race([
        permissionRequest,
        permissionTimeout,
      ]);
      window.clearTimeout(timeoutId);
      if (generation !== voiceGenerationRef.current) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        return;
      }
      microphoneStreamRef.current = microphoneStream;
      setMicrophoneStream(microphoneStream);
      const sessionResponse = await fetch("/api/dev/voice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const sessionPayload = (await sessionResponse.json()) as {
        ok?: boolean;
        sessionId?: string;
        descriptor?: { credentialKind?: string };
      };
      if (
        !sessionResponse.ok ||
        !sessionPayload.ok ||
        !sessionPayload.sessionId ||
        sessionPayload.descriptor?.credentialKind !== "ephemeral"
      ) {
        const sessionError = new Error("Secure realtime session unavailable.");
        sessionError.name = "VoiceSessionError";
        throw sessionError;
      }
      if (generation !== voiceGenerationRef.current) {
        microphoneStream.getTracks().forEach((track) => track.stop());
        requestVoiceHandoff(
          sessionPayload.sessionId,
          "user_requested",
        );
        return;
      }
      voiceSessionIdRef.current = sessionPayload.sessionId;
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      recognition.onstart = () => {
        if (generation !== voiceGenerationRef.current) {
          recognition.abort();
          return;
        }
        setVoicePhase("listening");
        setVoiceCaption("Listening…");
        setAnnouncement("Realtime microphone connected. Listening.");
      };
      recognition.onresult = (event) => {
        if (generation !== voiceGenerationRef.current) return;
        let partial = "";
        let final = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript?.trim() ?? "";
          if (result?.isFinal) final += `${transcript} `;
          else partial += `${transcript} `;
        }
        if (partial.trim()) setVoiceCaption(partial.trim());
        if (final.trim()) {
          const transcript = final.trim();
          setVoiceFinal(transcript);
          setVoiceCaption(transcript);
          setFollowUp(transcript);
          setFollowUpAnswer("");
          setReplyStatus("streaming");
          recognition.stop();
          setVoicePhase("thinking");
          setAnnouncement("Transcript finalized. Nova is grounding the answer.");
          void streamGroundedReply(
            transcript,
            "voice",
            uploadedAttachmentId,
            generation,
          );
        }
      };
      recognition.onerror = (event) => {
        if (generation !== voiceGenerationRef.current) return;
        if (event.error === "aborted" || event.error === "no-speech") return;
        const message = `Microphone error: ${event.error}. Continue in text or retry voice.`;
        endVoice(false);
        setVoiceError(message);
        setAnnouncement(
          "Realtime voice encountered a microphone error. Text mode is still ready.",
        );
        window.requestAnimationFrame(() => messageInputRef.current?.focus());
      };
      recognition.onend = () => {
        if (
          generation === voiceGenerationRef.current &&
          shouldListenRef.current &&
          !isMutedRef.current &&
          voicePhaseRef.current === "listening"
        ) {
          scheduleRecognitionRestart(recognition, 160, generation);
        }
      };
      recognitionRef.current = recognition;
      recognition.start();
    } catch (error) {
      if (generation !== voiceGenerationRef.current) return;
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      setMicrophoneStream(null);
      const reason =
        error instanceof Error && error.name === "NotAllowedError"
          ? "Microphone permission was not granted."
          : error instanceof Error && error.name === "TimeoutError"
            ? "Microphone permission did not complete. Retry voice when the browser permission is ready."
            : error instanceof Error && error.name === "VoiceSessionError"
              ? "The scoped realtime session could not be opened."
              : "The microphone could not be opened.";
      handoffVoiceSession("voice_unavailable");
      shouldListenRef.current = false;
      setVoiceError(reason);
      focusTextAfterVoiceRef.current = true;
      setVoicePhase("off");
      setAnnouncement(`${reason} Text mode is still ready.`);
    }
  }

  function endVoice(focusText = true) {
    voiceGenerationRef.current += 1;
    clearVoiceRestartTimers();
    shouldListenRef.current = false;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
    setMicrophoneStream(null);
    window.speechSynthesis?.cancel();
    handoffVoiceSession("user_requested");
    setVoicePhase("off");
    setVoiceCaption("");
    setVoiceFinal("");
    setIsMuted(false);
    if (interruptionTimerRef.current !== null) {
      window.clearTimeout(interruptionTimerRef.current);
      interruptionTimerRef.current = null;
    }
    setWasInterrupted(false);
    focusTextAfterVoiceRef.current = focusText;
    setAnnouncement("Voice ended. The same conversation is ready in text.");
  }

  function handoffVoiceSession(
    reason: "user_requested" | "voice_unavailable" | "deadline",
  ) {
    const sessionId = voiceSessionIdRef.current;
    if (!sessionId) return;
    voiceSessionIdRef.current = null;
    requestVoiceHandoff(sessionId, reason);
  }

  function requestVoiceHandoff(
    sessionId: string,
    reason: "user_requested" | "voice_unavailable" | "deadline",
  ) {
    void fetch("/api/dev/voice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "handoff", sessionId, reason }),
      keepalive: true,
    });
  }

  function interruptVoice() {
    window.speechSynthesis?.cancel();
    recognitionRef.current?.abort();
    if (interruptionTimerRef.current !== null) {
      window.clearTimeout(interruptionTimerRef.current);
    }
    setWasInterrupted(true);
    interruptionTimerRef.current = window.setTimeout(() => {
      interruptionTimerRef.current = null;
      setWasInterrupted(false);
    }, 1_200);
    setVoiceRound((round) => round + 1);
    setVoiceFinal("");
    setVoiceCaption("Go ahead — I stopped speaking and I’m listening.");
    setVoicePhase("listening");
    setAnnouncement("Nova was interrupted and stopped speaking.");
    if (voiceTransport === "browser-realtime" && !isMuted) {
      const recognition = recognitionRef.current;
      if (recognition) {
        scheduleRecognitionRestart(
          recognition,
          120,
          voiceGenerationRef.current,
        );
      }
    }
  }

  function clearVoiceRestartTimers() {
    voiceRestartTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    voiceRestartTimersRef.current.clear();
  }

  function scheduleRecognitionRestart(
    recognition: SpeechRecognitionLike,
    delayMs: number,
    generation: number,
  ) {
    const timer = window.setTimeout(() => {
      voiceRestartTimersRef.current.delete(timer);
      if (
        generation !== voiceGenerationRef.current ||
        !shouldListenRef.current ||
        isMutedRef.current ||
        voicePhaseRef.current !== "listening"
      ) {
        return;
      }
      try {
        recognition.start();
      } catch {
        // Recognition is already active.
      }
    }, delayMs);
    voiceRestartTimersRef.current.add(timer);
  }

  function toggleMute() {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    if (voiceTransport === "browser-realtime") {
      if (nextMuted) {
        recognitionRef.current?.stop();
        microphoneStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = false;
        });
      } else {
        microphoneStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
        try {
          recognitionRef.current?.start();
        } catch {
          // Recognition is already active.
        }
      }
    }
    setAnnouncement(nextMuted ? "Microphone muted." : "Microphone unmuted.");
  }

  function toggleExpanded() {
    setIsExpanded((expanded) => !expanded);
    setAnnouncement(
      isExpanded ? "Companion restored." : "Companion expanded.",
    );
  }

  function listenToGroundedAnswer() {
    if (!("speechSynthesis" in window)) {
      setAnnouncement("Speech playback is not available in this browser.");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(
      "A Minimum Day is the smallest credible version of your practice. On a disrupted day, open your plan, choose one priority, and stop after two intentional minutes. After two consistent days, rebuild the fuller practice.",
    );
    utterance.onstart = () =>
      setAnnouncement("Nova is reading the grounded answer aloud.");
    utterance.onend = () =>
      setAnnouncement("Nova finished reading the grounded answer.");
    utterance.onerror = () =>
      setAnnouncement("Speech playback failed; the answer remains available as text.");
    window.speechSynthesis.speak(utterance);
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
    "--tenant-primary": runtimeBranding.primary,
    "--tenant-primary-deep": runtimeBranding.primary,
    "--tenant-primary-soft": runtimeBranding.surface,
    "--tenant-canvas": demoTenant.brand.canvas,
    "--tenant-avatar": runtimeBranding.accent,
    "--companion-width": `${companionSize.width}px`,
    "--companion-height": `${companionSize.height}px`,
    "--companion-x": `${position.x}px`,
    "--companion-y": `${position.y}px`,
  } as CSSProperties;
  const voiceExperienceStyle = {
    "--voice-origin-x": voiceOrigin.x,
    "--voice-origin-y": voiceOrigin.y,
  } as CSSProperties;

  const companionClasses = [
    styles.appFrame,
    voiceVisible ? styles.voiceActiveFrame : "",
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

  const assistantName = runtimeBranding.assistantName;

  function toggleVoice() {
    if (voiceActive) {
      endVoice();
    } else {
      startVoice();
    }
  }

  function retryVoice() {
    if (voiceActive) endVoice(false);
    window.setTimeout(() => void startVoice(), 0);
  }

  return (
    <main className={pageClasses}>
      <div ref={companionRef} className={companionClasses} style={companionStyle}>
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
            href="/"
            aria-label={`${demoTenant.name} learning home`}
          >
            <span className={styles.brandMark} aria-hidden="true">
              {runtimeBranding.logoDataUrl ? (
                <img alt="" src={runtimeBranding.logoDataUrl} />
              ) : (
                runtimeBranding.initials
              )}
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
          {voiceVisible ? (
            <div
              className={styles.voiceExperience}
              data-phase={renderedVoicePhase}
              data-transition={voicePresentation}
              data-interrupted={wasInterrupted ? "true" : undefined}
              style={voiceExperienceStyle}
              role="region"
              aria-label="Voice conversation"
              onTransitionEnd={handleVoiceTransitionEnd}
            >
              <div className={styles.orbStage}>
                <LiquidVoiceOrb
                  color={runtimeBranding.primary}
                  isMuted={isMuted}
                  phase={renderedVoicePhase}
                  stream={microphoneStream}
                />
              </div>

              <div className={styles.srOnly} aria-live="polite" aria-atomic="true">
                {isMuted ? "Muted" : voiceLabels[renderedVoicePhase]}.{" "}
                {voiceCaption || `${assistantName} voice conversation active.`}
              </div>

              <div className={styles.voiceControls}>
                <button
                  type="button"
                  className={isMuted ? styles.controlActive : ""}
                  onClick={
                    voicePhase === "speaking" || voicePhase === "thinking"
                      ? interruptVoice
                      : toggleMute
                  }
                  aria-label={
                    voicePhase === "speaking" || voicePhase === "thinking"
                      ? "Interrupt and listen"
                      : isMuted
                        ? "Unmute microphone"
                        : "Mute microphone"
                  }
                  aria-pressed={isMuted}
                >
                  <Icon name="mic" size={22} />
                </button>
                <button
                  type="button"
                  className={styles.endButton}
                  onClick={() => endVoice()}
                  aria-label="End voice conversation"
                >
                  <Icon name="close" size={22} />
                </button>
              </div>
            </div>
          ) : null}
          <div
            className={styles.textExperience}
            aria-hidden={voiceVisible ? true : undefined}
            inert={voiceVisible ? true : undefined}
          >
              <div className={styles.thread}>
            <div className={styles.dayMarker}>
              <span>Today</span>
            </div>

            <article className={`${styles.messageRow} ${styles.studentRow}`}>
              <div className={styles.studentBubble}>
                I understand the Minimum Day, but I keep falling off after a
                busy week. How small should my restart be?
              </div>
              <span className={styles.messageTime}>10:42</span>
            </article>

            <article className={`${styles.messageRow} ${styles.assistantRow}`}>
              <div className={styles.assistantIdentity}>
                <span className={styles.assistantMark}>
                  {runtimeBranding.logoDataUrl ? (
                    <img alt="" src={runtimeBranding.logoDataUrl} />
                  ) : (
                    runtimeBranding.initials
                  )}
                </span>
              </div>
              <div className={styles.answer}>
                <div className={styles.answerMeta}>
                  <strong>{assistantName}</strong>
                  <span>Course-grounded answer</span>
                </div>

                <p>
                  The Minimum Day does not depend on having perfect weeks. It
                  protects a <em>restart small enough</em> that a disrupted week
                  never becomes a lost month.
                </p>

                <p>
                  In the Momentum Method, your <strong>Minimum Day</strong> is
                  the smallest credible version of the practice that keeps the
                  restart loop intact.
                </p>

                <div className={styles.steps} aria-label="Three-step reset plan">
                  <div>
                    <span>01</span>
                    <p>
                      <strong>Define the floor</strong>
                      Open your plan, choose one priority, and stop after two minutes.
                    </p>
                  </div>
                  <div>
                    <span>02</span>
                    <p>
                      <strong>Protect the restart</strong>
                      Use it on the first day after disruption.
                    </p>
                  </div>
                  <div>
                    <span>03</span>
                    <p>
                      <strong>Build back gradually</strong>
                      Return to fuller practice after two consistent days.
                    </p>
                  </div>
                </div>

                <figure className={styles.diagram}>
                  <div className={styles.diagramCanvas}>
                    <div className={styles.diagramNode}>
                      <span>1</span>
                      <strong>Disruption</strong>
                    </div>
                    <span className={styles.diagramArrow}>
                      <Icon name="arrow" size={18} />
                    </span>
                    <div className={styles.diagramNode}>
                      <span>2</span>
                      <strong>Minimum Day</strong>
                    </div>
                    <span className={styles.diagramArrow}>
                      <Icon name="arrow" size={18} />
                    </span>
                    <div className={styles.diagramNode}>
                      <span>3</span>
                      <strong>Evidence</strong>
                    </div>
                    <span className={styles.diagramArrow}>
                      <Icon name="arrow" size={18} />
                    </span>
                    <div className={styles.diagramNode}>
                      <span>4</span>
                      <strong>Momentum</strong>
                    </div>
                  </div>
                  <figcaption>
                    <span>
                      <strong>The Minimum Day restart loop</strong>
                      Momentum returns through a small action and visible evidence.
                    </span>
                    <button
                      ref={voiceTriggerRef}
                      type="button"
                      aria-label="Open diagram full screen"
                      onClick={() => {
                        setDiagramOpen(true);
                        setAnnouncement("Minimum Day restart-loop diagram opened.");
                      }}
                    >
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
                  design the two-minute version.
                </p>

                <div className={styles.sources}>
                  <span className={styles.sourcesLabel}>Sources</span>
                  <div className={styles.sourceList}>
                    {sources.map((source) => (
                      <button
                        type="button"
                        key={source.number}
                        onClick={() =>
                          setAnnouncement(
                            `${source.title}, ${source.detail}, selected.`,
                          )
                        }
                      >
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
                  <button type="button" onClick={listenToGroundedAnswer}>
                    <Icon name="volume" size={16} />
                    Listen
                  </button>
                  <span>10:42</span>
                </div>
              </div>
            </article>

            {followUp ? (
              <>
                <article className={`${styles.messageRow} ${styles.studentRow}`}>
                  <div className={styles.studentBubble}>{followUp}</div>
                  <span className={styles.messageTime}>Now</span>
                </article>
                <article className={`${styles.messageRow} ${styles.assistantRow}`}>
                  <div className={styles.assistantIdentity}>
                    <span className={styles.assistantMark}>
                      {runtimeBranding.initials}
                    </span>
                  </div>
                  <div className={styles.answer}>
                    <div className={styles.answerMeta}>
                      <strong>{assistantName}</strong>
                      <span>
                        {replyStatus === "streaming"
                          ? "Grounding and streaming…"
                          : replyStatus === "error"
                            ? "Safe retry available"
                            : "Course-grounded answer"}
                      </span>
                    </div>
                    <p>
                      {followUpAnswer ||
                        "Connecting to the grounded conversation service…"}
                    </p>
                    {replyStatus === "complete" ? (
                      <div className={styles.sources}>
                        <span className={styles.sourcesLabel}>Source</span>
                        <div className={styles.sourceList}>
                          <button type="button">
                            <span>1</span>
                            <span>
                              <strong>{followUpSource.title}</strong>
                              <small>{followUpSource.detail}</small>
                            </span>
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </article>
              </>
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
                      {(attachment.size / 1024).toFixed(0)} KB ·{" "}
                      {attachmentStatus === "validating"
                        ? "Validating type and size"
                        : attachmentStatus === "scanning"
                          ? "Malware scanning"
                          : attachmentStatus === "extracting"
                            ? "Extracting safely"
                            : "Ready for this conversation"}
                    </small>
                  </span>
                  <span className={styles.readyBadge}>
                    {attachmentStatus === "ready" ? (
                      <Icon name="check" size={12} />
                    ) : (
                      <span className={styles.phaseSpinner} aria-hidden="true" />
                    )}
                    {attachmentStatus === "ready" ? "Ready" : "Processing"}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      attachmentTokenRef.current += 1;
                      setAttachment(null);
                      setUploadedAttachmentId(null);
                      setAttachmentStatus("idle");
                      setAttachmentError(null);
                      setAnnouncement("Attachment removed.");
                    }}
                    aria-label={`Remove ${attachment.name}`}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              ) : null}
              {attachmentError ? (
                <div className={styles.attachmentError} role="alert">
                  <Icon name="file" size={16} />
                  <span>{attachmentError}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setAttachmentError(null);
                      setAttachmentStatus("idle");
                      fileInputRef.current?.click();
                    }}
                  >
                    Choose another
                  </button>
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
                onPaste={(event) => void acceptFile(event.clipboardData.files?.[0])}
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
                {voicePhase === "off" && voiceError ? (
                  <div className={styles.voiceFallback} role="status">
                    <span>Voice isn’t available.</span>
                    <button type="button" onClick={retryVoice}>
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setVoiceError(null);
                        messageInputRef.current?.focus();
                      }}
                    >
                      Use text
                    </button>
                  </div>
                ) : null}
                <div className={styles.composerActions}>
                  <div>
                    <input
                      ref={fileInputRef}
                      className={styles.srOnly}
                      type="file"
                      onChange={handleFileChange}
                      accept=".pdf,.doc,.docx,.ppt,.pptx,.txt,.csv,.png,.jpg,.jpeg"
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
                          : "Start realtime voice"
                      }
                    >
                      <Icon name="mic" size={18} />
                      <span>Voice</span>
                    </button>
                  </div>
                  <button
                    className={styles.sendButton}
                    type="submit"
                    disabled={
                      (Boolean(attachment) && attachmentStatus !== "ready") ||
                      (!draft.trim() && !attachment)
                    }
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
                {conversationId
                  ? "Thread active · voice, text, and files stay together"
                  : "A thread will stay open across your messages"}
              </span>
              <span>
                {assistantName} can make mistakes. Check important details.
              </span>
            </div>
              </div>
          </div>
        </section>

        {diagramOpen ? (
          <div
            className={styles.diagramModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="diagram-title"
          >
            <div>
              <header>
                <span>
                  <small>Grounded lesson diagram</small>
                  <strong id="diagram-title">The Minimum Day restart loop</strong>
                </span>
                <button
                  type="button"
                  aria-label="Close full-screen diagram"
                  onClick={() => {
                    setDiagramOpen(false);
                    setAnnouncement("Diagram closed.");
                  }}
                >
                  ×
                </button>
              </header>
              <div className={styles.diagramModalFlow}>
                <span><b>1</b>Disruption</span><i aria-hidden="true">→</i>
                <span><b>2</b>Minimum Day</span><i aria-hidden="true">→</i>
                <span><b>3</b>Evidence</span><i aria-hidden="true">→</i>
                <span><b>4</b>Momentum</span>
              </div>
              <p>
                A small credible action creates evidence that the restart
                happened; that evidence supports momentum without requiring a
                perfect week.
              </p>
            </div>
          </div>
        ) : null}

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
