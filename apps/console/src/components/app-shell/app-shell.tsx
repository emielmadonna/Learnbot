"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { UsageSignal } from "../../app/app/usage-signal";
import HomeSection from "../sections/home-section";
import { brandInitial, brandStyle } from "./brand";
import type { PanelKey, ShellPayload } from "./contract";
import { PanelHost } from "./panel-host";
import { panelRegistry } from "./panel-registry";
import { usePanelRouter } from "./use-panel-router";
import styles from "./shell.module.css";

const NAV_ORDER: readonly PanelKey[] = [
  "course",
  "agent",
  "insights",
  "people",
  "widget",
  "platform",
] as const;

const ROLE_LABELS: Record<ShellPayload["role"], string> = {
  learner: "Learner",
  creator: "Creator",
  teacher: "Teacher",
  tenant_admin: "Workspace admin",
  tenant_owner: "Workspace owner",
  platform_owner: "Platform owner",
};

/**
 * Panel entry points are real anchors. A modified or non-primary click belongs
 * to the browser — new tab, new window, saved link — so the shell leaves it
 * alone and the href does the work.
 */
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
  const initials = parts.map((part) => Array.from(part)[0] ?? "").join("");
  return initials.toUpperCase() || ROLE_LABELS[payload.role].slice(0, 2).toUpperCase();
}

export type AppShellProps = {
  payload: ShellPayload;
  accountName: string;
  accountEmail: string | null;
};

/**
 * The one persistent surface of the product.
 *
 * `/app` never navigates: the header, nav and canvas stay mounted while every
 * other destination arrives as a slide-in panel addressed by `?panel=`.
 */
export function AppShell({ payload, accountName, accountEmail }: AppShellProps) {
  const { params, activePanel, openPanel, closePanel, panelHref } = usePanelRouter();
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement | null>(null);
  const accountMenuId = useId();

  const theme = useMemo(() => brandStyle(payload.agent), [payload.agent]);
  const initial = brandInitial(payload.agent, payload.tenant.displayName);

  const navItems = useMemo(
    () =>
      NAV_ORDER.filter((key) => payload.sections[key] === true).map((key) => ({
        key,
        label: panelRegistry[key].navLabel,
      })),
    [payload.sections],
  );

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

  // Opening a panel from the account menu should dismiss the menu.
  const openFromMenu = useCallback(
    (key: PanelKey) => {
      setAccountOpen(false);
      openPanel(key);
    },
    [openPanel],
  );

  // Closing is something the person did: it leaves a history entry, so Back
  // re-opens the panel they just closed.
  const handleClose = useCallback(() => closePanel(), [closePanel]);

  // Dropping an address the workspace cannot honour is not a navigation, so it
  // rewrites the current entry instead of adding one.
  const handleDiscard = useCallback(
    () => closePanel({ replace: true }),
    [closePanel],
  );

  return (
    <div className={styles.shell} style={theme}>
      <UsageSignal eventName="learning.workspace_opened" />
      <a className={styles.skipLink} href="#shell-canvas">
        Skip to content
      </a>

      <header className={styles.header}>
        <a className={styles.brand} href="/app" aria-label={`${payload.agent.assistantName} home`}>
          <span className={styles.brandMark} aria-hidden="true">
            {payload.agent.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={payload.agent.logoUrl} alt="" />
            ) : (
              initial
            )}
          </span>
          <span className={styles.brandText}>
            <b>{payload.agent.assistantName}</b>
            <small>{payload.tenant.displayName}</small>
          </span>
        </a>

        <nav className={styles.nav} aria-label="Workspace">
          <a
            className={styles.navItem}
            href="/app"
            aria-current={activePanel === null ? "page" : undefined}
            data-active={activePanel === null || undefined}
            onClick={(event) => {
              if (opensElsewhere(event)) return;
              event.preventDefault();
              handleClose();
            }}
          >
            Home
          </a>
          {navItems.map((item) => (
            <a
              key={item.key}
              className={styles.navItem}
              href={panelHref(item.key)}
              aria-current={activePanel === item.key ? "page" : undefined}
              data-active={activePanel === item.key || undefined}
              onClick={(event) => {
                if (opensElsewhere(event)) return;
                event.preventDefault();
                openPanel(item.key);
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className={styles.headerActions}>
          <a
            className={styles.voiceAction}
            href={panelHref("agent", { mode: "voice" })}
            onClick={(event) => {
              if (opensElsewhere(event)) return;
              event.preventDefault();
              openPanel("agent", { mode: "voice" });
            }}
          >
            <span className={styles.liveDot} aria-hidden="true" />
            Voice
          </a>

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
                <span aria-hidden="true">{accountInitials(payload, accountName)}</span>
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
                  <span className={styles.roleBadge}>{ROLE_LABELS[payload.role]}</span>
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
                <a className={styles.accountItem} href="/onboarding">
                  Workspace setup
                </a>
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

      <main className={styles.canvas} id="shell-canvas" tabIndex={-1}>
        <HomeSection payload={payload} accountName={accountName} />
      </main>

      <PanelHost
        payload={payload}
        activePanel={activePanel}
        params={params}
        onClose={handleClose}
        onDiscard={handleDiscard}
      />
    </div>
  );
}

export default AppShell;
