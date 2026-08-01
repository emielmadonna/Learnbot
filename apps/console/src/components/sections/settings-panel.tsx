"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { CorsoIcon, type CorsoIconName } from "../corso/corso-icon";
import type { PanelKey, PanelProps } from "../app-shell/contract";
import { asWorkspace } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import {
  type Draft,
  buildAgentSaveBody,
  codeOf,
  pickHead,
  sentenceFor,
  toDraft,
} from "./agent-panel";
import {
  PlanUsageSettings,
  PrivacyDataSettings,
} from "./settings-detail-views";
import { SegmentedControl } from "../ui";
import styles from "./settings-panel.module.css";

const ADMIN_ROLES = new Set(["tenant_owner", "tenant_admin", "platform_owner"]);

type LengthTier = "short" | "balanced" | "thorough";

/**
 * Plain-language Length maps onto the same durable `maxOutputTokens` field
 * the advanced "Max output tokens" control in Model & grounding edits.
 * Balanced (800) matches the platform default `toDraft` falls back to when
 * nothing is configured; Short and Thorough are picked to sit comfortably
 * inside the 64–4000 validation bounds enforced in agent-panel.tsx.
 */
const LENGTH_TIERS: Record<LengthTier, number> = {
  short: 300,
  balanced: 800,
  thorough: 2000,
};

function tierForTokens(maxOutputTokens: number): LengthTier {
  if (maxOutputTokens <= 500) return "short";
  if (maxOutputTokens <= 1400) return "balanced";
  return "thorough";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

type LengthState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      draft: Draft;
      expectedVersion: number;
      saving: boolean;
    };

/**
 * The mockup's standalone LENGTH segmented control, promoted out of the
 * "Answer length and model" link row so it can be set without opening the
 * full editor. It reads and writes the same durable configuration record
 * agent-panel.tsx does, via the shared `toDraft`/`buildAgentSaveBody` it
 * exports, so a change here is a real publish, not a local-only preference.
 */
function AnswerLengthControl({ refresh }: Pick<PanelProps, "refresh">) {
  const [state, setState] = useState<LengthState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/agent", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        const body = await readJson(response);
        if (!response.ok || !isRecord(body)) {
          throw new Error(sentenceFor(codeOf(body)));
        }
        const defaults = isRecord(body.defaults) ? body.defaults : {};
        const draftRow = isRecord(body.draft) ? body.draft : null;
        const publishedRow = isRecord(body.published) ? body.published : null;
        const expectedVersion =
          typeof body.expectedVersion === "number" ? body.expectedVersion : 0;
        const head = pickHead(draftRow, publishedRow, expectedVersion);
        if (!active) return;
        setState({
          status: "ready",
          draft: toDraft(head, defaults),
          expectedVersion,
          saving: false,
        });
      } catch (error) {
        if (!active) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : sentenceFor(null),
        });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function choose(tier: LengthTier) {
    if (state.status !== "ready" || state.saving) return;
    const nextDraft: Draft = {
      ...state.draft,
      maxOutputTokens: LENGTH_TIERS[tier],
    };
    setState({ ...state, draft: nextDraft, saving: true });
    try {
      const body = buildAgentSaveBody(nextDraft, {
        publish: true,
        expectedVersion: state.expectedVersion,
        idempotencyKey: `length-${crypto.randomUUID()}`,
      });
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await readJson(response);
      if (!response.ok || !isRecord(result)) {
        throw new Error(sentenceFor(codeOf(result)));
      }
      const nextExpectedVersion =
        typeof result.expectedVersion === "number"
          ? result.expectedVersion
          : state.expectedVersion + 1;
      setState({
        status: "ready",
        draft: nextDraft,
        expectedVersion: nextExpectedVersion,
        saving: false,
      });
      await refresh();
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : sentenceFor(null),
      });
    }
  }

  if (state.status === "loading") {
    return (
      <div className={`${styles.row} ${styles.segmentRow}`}>
        <span className={styles.rowLabel}>Length</span>
        <span className={styles.rowValue}>Loading…</span>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={`${styles.row} ${styles.segmentRow}`}>
        <span className={styles.rowLabel}>Length</span>
        <span className={styles.rowValue} role="alert">
          {state.message}
        </span>
      </div>
    );
  }

  return (
    <div className={`${styles.row} ${styles.segmentRow}`}>
      <span className={styles.rowLabel}>Length</span>
      <SegmentedControl
        ariaLabel="Answer length"
        disabled={state.saving}
        onChange={(value) => void choose(value as LengthTier)}
        options={[
          { value: "short", label: "Short" },
          { value: "balanced", label: "Balanced" },
          { value: "thorough", label: "Thorough" },
        ]}
        value={tierForTokens(state.draft.maxOutputTokens)}
      />
    </div>
  );
}

type Destination = {
  panel: PanelKey;
  extra?: Record<string, string>;
};

type NavItem = {
  label: string;
  icon: CorsoIconName;
  destination: Destination | undefined;
};

function friendlyTone(tone: string) {
  if (tone === "friendly" || tone === "encouraging") return "Warm";
  if (tone === "concise") return "Direct";
  return "Neutral";
}

function initials(value: string) {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  return (parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "");
}

export function SettingsPanel({ payload, params, refresh }: PanelProps) {
  const { openPanel, panelHref } = usePanelRouter();
  const workspace = asWorkspace(payload);
  const role = workspace?.identity.role ?? payload.role;
  const canConfigure = ADMIN_ROLES.has(role);
  const view = params.get("view");

  if (view === "plan-usage" && canConfigure) return <PlanUsageSettings />;
  if (view === "privacy-data" && canConfigure) {
    return <PrivacyDataSettings refresh={refresh} />;
  }

  const navigate = (
    event: MouseEvent<HTMLAnchorElement>,
    destination: Destination,
  ) => {
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
    openPanel(destination.panel, destination.extra);
  };

  function PanelLink({
    destination,
    className,
    children,
    ariaLabel,
  }: {
    destination: Destination;
    className: string | undefined;
    children: ReactNode;
    ariaLabel?: string;
  }) {
    return (
      <a
        aria-label={ariaLabel}
        className={className}
        href={panelHref(destination.panel, destination.extra)}
        onClick={(event) => navigate(event, destination)}
      >
        {children}
      </a>
    );
  }

  const navItems: NavItem[] = [
    {
      label: "The bot",
      icon: "conversation",
      destination: canConfigure
        ? { panel: "agent", extra: { view: "bot" } }
        : undefined,
    },
    {
      label: "Appearance",
      icon: "settings",
      destination: canConfigure
        ? { panel: "agent", extra: { view: "appearance" } }
        : undefined,
    },
    {
      label: "Install",
      icon: "publish",
      destination:
        canConfigure && payload.sections.widget
          ? { panel: "widget", extra: { view: "install" } }
          : undefined,
    },
    {
      label: "People",
      icon: "people",
      destination: payload.sections.people ? { panel: "people" } : undefined,
    },
    {
      label: "Plan & usage",
      icon: "results",
      destination: canConfigure
        ? { panel: "settings", extra: { view: "plan-usage" } }
        : undefined,
    },
    {
      label: "Privacy & data",
      icon: "workspaces",
      destination: canConfigure
        ? { panel: "settings", extra: { view: "privacy-data" } }
        : undefined,
    },
  ];

  const answerFrom =
    payload.agent.courseScope === "all"
      ? "every published course"
      : `${payload.agent.courseScope.length} selected ${
          payload.agent.courseScope.length === 1 ? "course" : "courses"
        }`;
  const answering = (workspace?.courses ?? []).some(
    (course) =>
      course.status === "published" &&
      course.modules.some((module) =>
        module.lessons.some(
          (lesson) =>
            lesson.status === "published" && lesson.blocks.length > 0,
        ),
      ),
  );

  return (
    <div className={styles.settings}>
      <aside className={styles.sidebar} aria-label="Settings sections">
        <nav>
          {navItems.map((item, index) =>
            index === 0 ? (
              <div
                aria-current="page"
                className={`${styles.navItem} ${styles.navActive}`}
                key={item.label}
              >
                <CorsoIcon name={item.icon} size={18} />
                <span>{item.label}</span>
              </div>
            ) : item.destination ? (
              <PanelLink
                className={styles.navItem}
                destination={item.destination}
                key={item.label}
              >
                <CorsoIcon name={item.icon} size={18} />
                <span>{item.label}</span>
              </PanelLink>
            ) : (
              <div
                aria-disabled="true"
                className={`${styles.navItem} ${styles.navDisabled}`}
                key={item.label}
              >
                <CorsoIcon name={item.icon} size={18} />
                <span>{item.label}</span>
              </div>
            ),
          )}
          <a
            className={styles.navItem}
            href="/auth/change-password?mode=manual&next=%2Fapp%3Fpanel%3Dsettings"
          >
            <CorsoIcon name="people" size={18} />
            <span>Your account</span>
          </a>
        </nav>
      </aside>

      <main className={styles.content}>
        <header className={styles.header}>
          <h1>The bot</h1>
          <p>
            How it introduces itself, what it sounds like, and what it does
            when it doesn&apos;t know.
          </p>
        </header>

        <SettingsGroup label="Identity">
          <PanelLink
            ariaLabel="Change assistant avatar"
            className={`${styles.row} ${styles.avatarRow}`}
            destination={{ panel: "agent", extra: { view: "appearance" } }}
          >
            <span
              className={styles.avatar}
              style={{ background: payload.agent.primaryColor }}
            >
              {payload.agent.avatarUrl ? (
                // Signed workspace asset; it cannot be statically optimized.
                // eslint-disable-next-line @next/next/no-img-element
                <img alt="" src={payload.agent.avatarUrl} />
              ) : (
                initials(payload.agent.assistantName).toUpperCase()
              )}
            </span>
            <span className={styles.rowCopy}>
              <strong>Avatar</strong>
              <small>Shown at the top of every conversation.</small>
            </span>
            <span className={styles.outlineButton}>Change</span>
          </PanelLink>

          <PanelLink
            className={styles.row}
            destination={{ panel: "agent", extra: { view: "bot" } }}
          >
            <span className={styles.rowLabel}>Name</span>
            <span className={styles.rowValue}>{payload.agent.assistantName}</span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </PanelLink>

          <PanelLink
            className={styles.row}
            destination={{ panel: "agent", extra: { view: "appearance" } }}
          >
            <span className={styles.rowLabel}>Accent colour</span>
            <span className={styles.colorValue}>
              <i style={{ background: payload.agent.primaryColor }} />
              <code>{payload.agent.primaryColor.toUpperCase()}</code>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </PanelLink>

          <PanelLink
            className={`${styles.row} ${styles.messageRow}`}
            destination={{ panel: "agent", extra: { view: "bot" } }}
          >
            <span className={styles.rowLabel}>Welcome message</span>
            <span className={styles.message}>{payload.agent.welcomeMessage}</span>
          </PanelLink>
        </SettingsGroup>

        <SettingsGroup label="How it answers">
          <PanelLink
            className={`${styles.row} ${styles.segmentRow}`}
            destination={{ panel: "agent", extra: { view: "bot" } }}
          >
            <span className={styles.rowLabel}>Voice</span>
            <span className={styles.segments}>
              {["Warm", "Neutral", "Direct"].map((option) => (
                <span
                  data-active={
                    friendlyTone(payload.agent.tone) === option || undefined
                  }
                  key={option}
                >
                  {option}
                </span>
              ))}
            </span>
          </PanelLink>

          <AnswerLengthControl refresh={refresh} />

          <PanelLink
            className={styles.row}
            destination={{ panel: "agent", extra: { view: "model" } }}
          >
            <span className={styles.rowCopy}>
              <strong>Model</strong>
              <small>Model choice, retrieval depth and the exact token limit.</small>
            </span>
            <span className={styles.rowValue}>Configure</span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </PanelLink>

          <div className={styles.row}>
            <span className={styles.rowCopy}>
              <strong>Always show which lesson it used</strong>
              <small>
                Students can open the source under any grounded answer.
              </small>
            </span>
            {/*
             * There is no draft field anywhere for this — citing sources is
             * not optional platform behaviour, so a switch that looks
             * flippable would be a lie. It reads as status, matching the
             * `role="status"` it already carried.
             */}
            <span className={styles.statusPill} role="status">
              <i className={styles.statusDot} aria-hidden="true" />
              Always on
            </span>
          </div>

          <div className={styles.row}>
            <span className={styles.rowCopy}>
              <strong>Ask for a helpful / not helpful rating</strong>
              <small>
                Shown under every answer today — there is no per-workspace
                switch yet to turn it off.
              </small>
            </span>
            {/*
             * TASK A.1: the widget and learning chat already collect this
             * rating unconditionally (conversation-client.tsx, api/widget/
             * feedback, api/learning/feedback, all on top of the
             * 20260731061000 migration's answer_feedback table). What is
             * genuinely missing is a per-tenant ON/OFF column to gate that
             * prompt: public.tenant_branding needs a
             * `feedback_prompt_enabled boolean not null default true`
             * column, the same shape as its existing `voice_enabled` /
             * `escalation_enabled`, wired through
             * `tenant_update_agent_configuration` (requested_*) and
             * `agent_directive_for_tenant` (as `feedbackPromptEnabled`), and
             * the widget/conversation UI would need to read it before
             * rendering the rating buttons. None of that exists yet, so this
             * renders as status rather than an enabled control that would
             * silently do nothing.
             */}
            <span className={styles.statusPill} role="status">
              <i className={styles.statusDot} aria-hidden="true" />
              Always on
            </span>
          </div>

          <PanelLink
            className={`${styles.row} ${styles.messageRow}`}
            destination={{ panel: "agent", extra: { view: "model" } }}
          >
            <span className={styles.rowLabel}>When it doesn&apos;t know</span>
            <span className={styles.message}>
              The assistant refuses rather than guessing. Open Model &amp;
              grounding to edit the exact wording learners see.
            </span>
          </PanelLink>
        </SettingsGroup>

        <p className={styles.advancedNote}>
          Off-limits topics, escalation and allowed collections live under
          Model &amp; grounding.
        </p>

        <SettingsGroup label="Availability">
          <PanelLink className={styles.row} destination={{ panel: "course" }}>
            <span className={styles.rowCopy}>
              <strong>Answering students</strong>
              <small>
                {answering
                  ? `Live from ${answerFrom}.`
                  : "Publish a lesson with content before students can get grounded answers."}
              </small>
            </span>
            {/*
             * This is derived from whether a published lesson has content
             * (see `answering` above), not a stored pause switch — there is
             * no "answering_paused" field anywhere in this codebase. A
             * switch look here would promise an off/on control that doesn't
             * exist, so it reads as status instead.
             */}
            <span
              className={styles.statusPill}
              data-tone={answering ? undefined : "off"}
              role="status"
            >
              <i className={styles.statusDot} aria-hidden="true" />
              {answering ? "Live" : "Not answering yet"}
            </span>
          </PanelLink>
          <PanelLink
            className={styles.row}
            destination={{ panel: "agent", extra: { view: "model" } }}
          >
            <span className={styles.rowCopy}>
              <strong>Advanced</strong>
              <small>Off-limits topics, escalation and allowed courses.</small>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </PanelLink>
        </SettingsGroup>

        <SettingsGroup label="Plan & usage">
          <PanelLink
            className={`${styles.row} ${styles.planRow}`}
            destination={{ panel: "settings", extra: { view: "plan-usage" } }}
          >
            <span className={styles.rowCopy}>
              <strong>Current workspace plan</strong>
              <small>
                Live subscription, billed usage and operating safeguards.
              </small>
            </span>
            <span className={styles.outlineButton}>View usage</span>
          </PanelLink>
          <PanelLink
            className={styles.row}
            destination={{ panel: "settings", extra: { view: "privacy-data" } }}
          >
            <span className={styles.rowLabel}>Privacy &amp; data</span>
            <span className={styles.rowValue}>Retention and exports</span>
            <span className={styles.chevron} aria-hidden="true">
              ›
            </span>
          </PanelLink>
        </SettingsGroup>
      </main>
    </div>
  );
}

function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <h2>{label}</h2>
      <div className={styles.groupCard}>{children}</div>
    </section>
  );
}

export default SettingsPanel;
