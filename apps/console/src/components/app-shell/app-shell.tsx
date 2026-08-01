"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { UsageSignal } from "../../app/app/usage-signal";
import { CorsoIcon, type CorsoIconName } from "../corso/corso-icon";
import { CorsoMark } from "../corso/corso-mark";
import HomeSection from "../sections/home-section";
import { brandStyle } from "./brand";
import type { PanelKey, ShellPayload } from "./contract";
import { PanelHost } from "./panel-host";
import { PlatformClientPreviewBanner } from "./platform-client-preview-banner";
import {
  CONSOLE_THEME_OPTIONS,
  groundForConsoleTheme,
  readConsoleThemePreference,
  type ConsoleThemePreference,
  writeConsoleThemePreference,
} from "./theme-preference";
import { usePanelRouter } from "./use-panel-router";
import styles from "./shell.module.css";

const ROLE_LABELS: Record<ShellPayload["role"], string> = {
  learner: "Learner",
  creator: "Creator",
  teacher: "Teacher",
  tenant_admin: "Workspace admin",
  tenant_owner: "Workspace owner",
  platform_owner: "Platform owner",
};

function opensElsewhere(event: ReactMouseEvent<HTMLAnchorElement>) {
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.button !== 0
  );
}

function accountInitials(payload: ShellPayload, accountName: string) {
  const source = accountName.trim() || payload.tenant.displayName;
  const parts = source.split(/\s+/u).filter(Boolean).slice(0, 2);
  const initials =
    parts.length === 1
      ? Array.from(parts[0] ?? "").slice(0, 2).join("")
      : parts.map((part) => Array.from(part)[0] ?? "").join("");
  return initials.toUpperCase() || ROLE_LABELS[payload.role].slice(0, 2).toUpperCase();
}

function hasPublishedLearning(payload: ShellPayload) {
  const workspace = payload.workspace as
    | {
        courses?: Array<{
          status?: string;
          modules?: Array<{
            lessons?: Array<{ status?: string; blocks?: unknown[] }>;
          }>;
        }>;
      }
    | null;
  return Boolean(
    workspace?.courses?.some(
      (course) =>
        course.status === "published" &&
        course.modules?.some((module) =>
          module.lessons?.some(
            (lesson) =>
              lesson.status === "published" && (lesson.blocks?.length ?? 0) > 0,
          ),
        ),
    ),
  );
}

type DockDestination = {
  id: string;
  label: string;
  icon: CorsoIconName;
  panel: PanelKey | null;
  extra?: Record<string, string>;
  separator?: boolean;
};

function dockDestinations(
  payload: ShellPayload,
  platformMode: boolean,
): DockDestination[] {
  if (platformMode) {
    const items: DockDestination[] = [
      {
        id: "workspaces",
        label: "Workspaces",
        icon: "workspaces",
        panel: "platform",
      },
      { id: "home", label: "Home", icon: "home", panel: null },
      { id: "learning", label: "Learning", icon: "learning", panel: "course" },
      {
        id: "results",
        label: "Results",
        icon: "results",
        panel: "insights",
        extra: { view: "insights" },
      },
      {
        id: "signals",
        label: "Signals",
        icon: "signals",
        panel: "insights",
        extra: { view: "signals" },
      },
      {
        id: "settings",
        label: "Settings",
        icon: "settings",
        panel: "settings",
      },
    ];
    return items.filter(
      (item) => item.panel === null || payload.sections[item.panel] === true,
    );
  }

  const items: DockDestination[] = [
    { id: "home", label: "Home", icon: "home", panel: null },
    { id: "learning", label: "Learning", icon: "learning", panel: "course" },
    {
      id: "settings",
      label: "Settings",
      icon: "settings",
      panel: "settings",
    },
    {
      id: "conversation",
      label: "Talk to your bot",
      icon: "conversation",
      panel: "agent",
      extra: { mode: "chat", view: "talk" },
      separator: true,
    },
  ];
  return items.filter(
    (item) => item.panel === null || payload.sections[item.panel] === true,
  );
}

export type AppShellProps = {
  payload: ShellPayload;
  accountName: string;
  accountEmail: string | null;
};

export function AppShell({ payload, accountName, accountEmail }: AppShellProps) {
  const { params, activePanel, openPanel, closePanel, panelHref } =
    usePanelRouter();
  const [accountOpen, setAccountOpen] = useState(false);
  const [themePreference, setThemePreference] =
    useState<ConsoleThemePreference>("auto");
  const accountRef = useRef<HTMLDivElement | null>(null);
  const accountMenuId = useId();
  const theme = useMemo(
    () => ({
      ...brandStyle(payload.agent),
      // Product chrome follows the reference's single Corso action colour.
      // Tenant colours are reapplied inside the assistant/widget previews and
      // hosted learner surface, where branding actually belongs.
      "--brand-primary": "var(--accent)",
      "--brand-accent": "var(--accent)",
      "--brand-on-primary": "var(--surface)",
      "--brand-on-accent": "var(--surface)",
    }),
    [payload.agent],
  );
  const answering = hasPublishedLearning(payload);
  const platformOnly =
    payload.role === "platform_owner" && payload.tenant.tenantId.length === 0;
  // Platform administrators can enter a client workspace without losing their
  // platform authority. The dark PLATFORM chrome belongs only to the
  // cross-workspace control plane; tenant pages must still look and navigate
  // like that client's own product.
  const platformMode =
    payload.role === "platform_owner" &&
    (activePanel === "platform" || platformOnly);
  const dockItems = useMemo(
    () => dockDestinations(payload, platformMode),
    [payload, platformMode],
  );
  // The admin dock's tiles are smaller than the creator dock's, so a single
  // fixed icon size would render oversized inside them. Keep the same
  // optical ratio (~icon 0.48x tile) across both variants instead.
  const isAdminDock = payload.role === "platform_owner";
  const dockIconSize = isAdminDock ? 21 : 26;

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
    setThemePreference(readConsoleThemePreference(storage));
  }, []);

  useEffect(() => {
    if (!accountOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setAccountOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [accountOpen]);

  const openFromMenu = useCallback(
    (key: PanelKey, extra?: Record<string, string>) => {
      setAccountOpen(false);
      openPanel(key, extra);
    },
    [openPanel],
  );

  const handleClose = useCallback(() => closePanel(), [closePanel]);
  const handleDiscard = useCallback(
    () => closePanel({ replace: true }),
    [closePanel],
  );
  const selectTheme = useCallback((next: ConsoleThemePreference) => {
    setThemePreference(next);
    try {
      writeConsoleThemePreference(window.localStorage, next);
    } catch {
      // The visual choice still applies for this session when storage is denied.
    }
  }, []);

  return (
    <div
      className={styles.shell}
      data-ground={
        platformMode ? "light" : groundForConsoleTheme(themePreference)
      }
      data-platform={platformMode || undefined}
      data-theme-preference={themePreference}
      style={theme}
    >
      <UsageSignal eventName="learning.workspace_opened" />
      <a className={styles.skipLink} href="#shell-canvas">
        Skip to content
      </a>

      <header className={styles.header}>
        <a
          className={styles.brand}
          href={platformMode ? "/app?panel=platform" : "/app"}
          aria-label={platformMode ? "Corso platform home" : "Corso home"}
        >
          <span className={styles.brandMark} aria-hidden="true">
            <CorsoMark color="var(--accent-ink)" size={15} />
          </span>
          <span className={styles.brandText}>
            <b>{platformMode ? "Corso" : payload.tenant.displayName}</b>
            <small>
              {platformMode ? (
                "PLATFORM"
              ) : (
                <>
                  <span aria-hidden="true">· </span>
                  {payload.agent.assistantName}
                </>
              )}
            </small>
          </span>
        </a>

        <div className={styles.headerActions}>
          {platformMode ? (
            <nav className={styles.platformHeaderNav} aria-label="Platform">
              <a
                href={panelHref("platform", { view: "billing" })}
                onClick={(event) => {
                  if (opensElsewhere(event)) return;
                  event.preventDefault();
                  openPanel("platform", { view: "billing" });
                }}
              >
                Billing
              </a>
              <a
                href={panelHref("platform", { view: "settings" })}
                onClick={(event) => {
                  if (opensElsewhere(event)) return;
                  event.preventDefault();
                  openPanel("platform", { view: "settings" });
                }}
              >
                Platform settings
              </a>
            </nav>
          ) : null}
          {platformMode ? null : (
            <span
              className={answering ? styles.liveStatus : styles.pendingStatus}
              title={
                answering
                  ? "At least one published lesson is available to answer from."
                  : "No published lesson with content is available yet."
              }
            >
              <i aria-hidden="true" />
              {answering ? "Answering" : "Needs learning"}
            </span>
          )}

          <div className={styles.account} ref={accountRef}>
            <button
              type="button"
              className={styles.avatar}
              aria-haspopup="true"
              aria-expanded={accountOpen}
              aria-controls={accountMenuId}
              onClick={() => setAccountOpen((value) => !value)}
            >
              {payload.agent.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={payload.agent.avatarUrl} alt="" />
              ) : (
                <span aria-hidden="true">
                  {accountInitials(payload, accountName)}
                </span>
              )}
              <span className={styles.visuallyHidden}>Account menu</span>
            </button>

            {accountOpen ? (
              <div
                className={styles.accountMenu}
                id={accountMenuId}
                aria-label="Account"
              >
                <div className={styles.accountIdentity}>
                  <strong>{accountName}</strong>
                  {accountEmail ? <small>{accountEmail}</small> : null}
                  <span className={styles.roleBadge}>
                    {ROLE_LABELS[payload.role]}
                  </span>
                </div>
                {payload.sections.settings ? (
                  <button
                    type="button"
                    className={styles.accountItem}
                    onClick={() => openFromMenu("settings")}
                  >
                    Settings
                  </button>
                ) : null}
                {platformOnly ? null : (
                  <a className={styles.accountItem} href="/onboarding">
                    Workspace setup
                  </a>
                )}
                <div className={styles.themeGroup}>
                  <span className={styles.themeLabel}>Appearance</span>
                  <div
                    aria-label="Console appearance"
                    className={styles.themeOptions}
                    role="radiogroup"
                  >
                    {CONSOLE_THEME_OPTIONS.map((option) => (
                      <button
                        aria-checked={themePreference === option.value}
                        className={styles.themeOption}
                        key={option.value}
                        onClick={() => selectTheme(option.value)}
                        role="radio"
                        type="button"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                <form action="/auth/sign-out" method="post">
                  <button className={styles.accountItem} type="submit">
                    Sign out
                  </button>
                </form>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <PlatformClientPreviewBanner role={payload.role} tenant={payload.tenant} />

      {activePanel === null ? (
        <main className={styles.canvas} id="shell-canvas" tabIndex={-1}>
          <HomeSection payload={payload} accountName={accountName} />
        </main>
      ) : null}

      <PanelHost
        payload={payload}
        activePanel={activePanel}
        params={params}
        onClose={handleClose}
        onDiscard={handleDiscard}
      />

      <nav
        className={
          isAdminDock ? `${styles.dock} ${styles.adminDock}` : styles.dock
        }
        aria-label="Primary"
      >
        {dockItems.map((item) => {
          const itemView = item.extra?.view;
          const activeView = params.get("view");
          const isActive =
            item.panel === null
              ? activePanel === null
              : activePanel === item.panel &&
                (itemView === undefined || itemView === activeView);
          const href =
            item.panel === null ? "/app" : panelHref(item.panel, item.extra);
          return (
            <span
              className={item.separator ? styles.dockSeparated : styles.dockSlot}
              key={item.id}
            >
              <a
                aria-current={isActive ? "page" : undefined}
                aria-label={item.label}
                className={styles.dockItem}
                data-active={isActive || undefined}
                data-label={item.label}
                href={href}
                onClick={(event) => {
                  if (opensElsewhere(event)) return;
                  event.preventDefault();
                  if (item.panel === null) handleClose();
                  else openPanel(item.panel, item.extra);
                }}
              >
                <CorsoIcon name={item.icon} size={dockIconSize} />
              </a>
              <i className={styles.dockIndicator} aria-hidden="true" />
            </span>
          );
        })}
      </nav>
    </div>
  );
}

export default AppShell;
