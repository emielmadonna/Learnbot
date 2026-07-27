"use client";

import { createContext, useContext } from "react";
import type { LearningWorkspace } from "../../lib/supabase/learning-rpc";
import type { ShellPayload } from "./contract";

/**
 * `refresh()` on {@link PanelProps} bumps this counter. Panels that load their
 * own durable data include it in their effect dependencies so a refresh
 * re-reads Supabase without remounting (and therefore without losing form
 * state or scroll position).
 */
const DataVersionContext = createContext(0);

export const DataVersionProvider = DataVersionContext.Provider;

export function useDataVersion() {
  return useContext(DataVersionContext);
}

/**
 * `ShellPayload.workspace` is intentionally `unknown` in the shared contract so
 * panel authors are not coupled to the learning RPC shape. Sections that do
 * need it narrow it here, once.
 */
export function asWorkspace(payload: ShellPayload): LearningWorkspace | null {
  const candidate = payload.workspace;
  if (!candidate || typeof candidate !== "object") return null;
  const record = candidate as Partial<LearningWorkspace>;
  return Array.isArray(record.courses) ? (candidate as LearningWorkspace) : null;
}
