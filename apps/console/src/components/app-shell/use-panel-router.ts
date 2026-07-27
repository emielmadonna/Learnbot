"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import type { PanelKey } from "./contract";

export const PANEL_KEYS: readonly PanelKey[] = [
  "agent",
  "insights",
  "course",
  "people",
  "platform",
  "widget",
  "settings",
] as const;

export function isPanelKey(value: string | null | undefined): value is PanelKey {
  return typeof value === "string" && (PANEL_KEYS as readonly string[]).includes(value);
}

/**
 * Every hook instance re-reads the address bar when the shell writes to it, so
 * a panel opened in one subtree is visible to the host in the same tick without
 * depending on the router's own history instrumentation.
 */
const LOCATION_EVENT = "app-shell:locationchange";

/** Compare and store one canonical spelling of a query string. */
function normalize(search: string) {
  return new URLSearchParams(search).toString();
}

/**
 * Everything that can change the shell's address announces itself: the browser
 * does it with `popstate`/`hashchange`, and every write in this module ends
 * with {@link LOCATION_EVENT}. The shell never routes any other way, so there
 * is no path by which the document can move without this firing.
 */
function subscribeToLocation(onStoreChange: () => void) {
  window.addEventListener("popstate", onStoreChange);
  window.addEventListener("hashchange", onStoreChange);
  window.addEventListener(LOCATION_EVENT, onStoreChange);
  return () => {
    window.removeEventListener("popstate", onStoreChange);
    window.removeEventListener("hashchange", onStoreChange);
    window.removeEventListener(LOCATION_EVENT, onStoreChange);
  };
}

function readLocationSearch() {
  return normalize(window.location.search);
}

/**
 * A panel's address is exactly its key plus the arguments it was opened with.
 *
 * Nothing is inherited from whatever was open before: a stale `lessonId` or
 * `mode` left over from another panel would otherwise ride along and re-open a
 * screen nobody asked for. It also means clicking a panel link and cmd-clicking
 * it land on the same URL, because the anchor and the handler are built here.
 */
function panelQuery(
  panel: PanelKey,
  extra?: Record<string, string | null | undefined>,
) {
  const next = new URLSearchParams();
  next.set("panel", panel);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== null && value !== undefined && value !== "") next.set(key, value);
  }
  return next;
}

/**
 * Panels are addressed by `?panel=<PanelKey>` plus an optional `&id=`.
 *
 * The URL is the only state: there is no "is a panel open" flag anywhere in the
 * shell, so a deep link, a refresh, a back/forward step and a click all arrive
 * at exactly the same render.
 *
 * The query string is read from the document rather than from
 * `useSearchParams()` alone. `useSearchParams()` reads the router's snapshot,
 * which is empty on the first client render whenever the router has not caught
 * up with the document — a hard navigation into `/app?panel=…`, or a static
 * bailout under the shell's Suspense boundary. Because panel navigation is
 * `history.pushState` rather than a route change, nothing would ever arrive
 * afterwards to correct that first render, and the panel would stay shut until
 * the next interaction. The router value is still used for the server render
 * and for hydration, so the first client paint matches the server exactly and
 * `useSyncExternalStore` re-reads the document immediately after.
 */
export function usePanelRouter() {
  const routerParams = useSearchParams();
  const routerSearch = useMemo(
    () => (routerParams ? normalize(routerParams.toString()) : ""),
    [routerParams],
  );
  const getServerSearch = useCallback(() => routerSearch, [routerSearch]);

  const serialized = useSyncExternalStore(
    subscribeToLocation,
    readLocationSearch,
    getServerSearch,
  );

  const params = useMemo(
    () => new URLSearchParams(serialized),
    [serialized],
  );

  const activePanel = useMemo<PanelKey | null>(() => {
    const value = params.get("panel");
    return isPanelKey(value) ? value : null;
  }, [params]);

  const activeId = params.get("id");

  const write = useCallback((next: URLSearchParams, replace: boolean) => {
    if (typeof window === "undefined") return;
    const query = next.toString();
    // Writing the URL it already holds would only add a dead history entry.
    if (query === normalize(window.location.search)) return;
    const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
    if (replace) window.history.replaceState(null, "", url);
    else window.history.pushState(null, "", url);
    window.dispatchEvent(new Event(LOCATION_EVENT));
  }, []);

  const openPanel = useCallback(
    (
      panel: PanelKey,
      extra?: Record<string, string | null | undefined>,
      options?: { replace?: boolean },
    ) => {
      write(panelQuery(panel, extra), options?.replace === true);
    },
    [write],
  );

  const closePanel = useCallback(
    (options?: { replace?: boolean }) => {
      write(new URLSearchParams(), options?.replace === true);
    },
    [write],
  );

  /** Build a real href so panel entry points stay right-clickable and shareable. */
  const panelHref = useCallback(
    (panel: PanelKey, extra?: Record<string, string | null | undefined>) =>
      `/app?${panelQuery(panel, extra).toString()}`,
    [],
  );

  return { params, activePanel, activeId, openPanel, closePanel, panelHref };
}
