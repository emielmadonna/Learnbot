"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { createBrowserSupabaseClient } from "../../lib/supabase/client";
import {
  PlatformRpcError,
  isPlatformClientPlan,
  normalizePlatformSlug,
  parsePlatformClientClaimRevocation,
  parsePlatformClientClaims,
  parsePlatformClientCreation,
  parsePlatformOverview,
  parsePlatformTenantDetail,
  parsePlatformTenantEntry,
  parsePlatformTenantExit,
  parsePlatformTenantStatusChange,
  parseTenantSectionUpdate,
  platformClientPlans,
  platformOperationKey,
  platformSectionKeys,
  platformSlugPattern,
} from "../../lib/supabase/platform-rpc";
import type {
  PlatformClientClaim,
  PlatformClientPlan,
  PlatformOverview,
  PlatformSectionKey,
  PlatformTenantDetail,
  PlatformTenantSummary,
  TenantSection,
} from "../../lib/supabase/platform-rpc";
import {
  billingPlans,
  billingSubscriptionStatuses,
  isBillingPlan,
  isBillingSubscriptionStatus,
  parseBillingOverview,
  parseBillingTenantDetail,
  parseMarginPolicyUpdate,
  parseSectionOverrideClear,
  parseSubscriptionUpdate,
} from "../../lib/billing/billing-rpc";
import type {
  BillingOverview,
  BillingPlan,
  BillingSubscriptionStatus,
  BillingTenantDetail,
} from "../../lib/billing/billing-rpc";
import type { PanelProps } from "../app-shell/contract";
import { useDataVersion } from "../app-shell/shell-data";
import { usePanelRouter } from "../app-shell/use-panel-router";
import {
  Button,
  ColorField,
  EmptyState,
  PanelFrame,
  SelectField,
  StateBadge,
  StatTile,
  TextField,
  Toggle,
  normalizeHex,
} from "../ui";
import type { StatState } from "../ui";
import { cx } from "../ui/cx";
import styles from "./platform-panel.module.css";

/* ------------------------------------------------------------------ *
 * Transport
 *
 * Every read and write goes through /api/platform, which re-checks
 * `platform_admin_is_authorized` before it touches an RPC. The parsers from
 * lib/supabase/platform-rpc are reused verbatim so the browser accepts exactly
 * the shapes the server produced — and throws PlatformRpcError otherwise.
 * ------------------------------------------------------------------ */

const codeMessages: Record<string, string> = {
  access_denied:
    "This account is not authorized to administer client workspaces.",
  claim_not_found: "That owner code no longer exists.",
  claim_not_pending:
    "That owner code is no longer outstanding — it was already redeemed or revoked.",
  authentication_required:
    "The secure session expired. Sign in again to continue.",
  invalid_request: "That request was rejected as malformed.",
  invalid_response:
    "The platform control plane returned a response this console does not recognize.",
  membership_conflict:
    "A conflicting membership blocks this operation for that client.",
  principal_not_linked:
    "This account is not linked to a platform principal, so it cannot enter a client workspace.",
  request_failed:
    "The platform control plane rejected the request. Client controls stay unavailable until the tenant-section migration is applied.",
  slug_conflict:
    "That workspace URL is already taken by another client. Choose a different one.",
  tenant_not_found: "That client workspace no longer exists.",
  tenant_selection_required:
    "Select a workspace before running platform operations.",
  tenant_unavailable: "That client workspace is not available to enter.",
  section_not_found: "That section does not exist on this workspace.",
  stripe_not_configured:
    "Stripe is not configured on this deployment. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_METERED_PRICE_ID to enable checkout and the billing portal.",
  plan_not_configured:
    "This plan has no Stripe price configured. Set its STRIPE_PRICE_* environment variable first.",
  stripe_customer_missing:
    "This client has no Stripe customer on file yet — start a checkout before opening the billing portal.",
};

function describe(error: unknown): string {
  if (error instanceof PlatformRpcError) {
    return (
      codeMessages[error.code] ?? `The request was denied (${error.code}).`
    );
  }
  return "The platform control plane could not be reached. Nothing was changed.";
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return { ok: false, code: "request_failed" };
  }
}

async function platformRead(search: string): Promise<unknown> {
  const response = await fetch(`/api/platform${search}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  return readBody(response);
}

async function platformWrite(input: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/platform", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readBody(response);
}

async function billingRead(search: string): Promise<unknown> {
  const response = await fetch(`/api/billing${search}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  return readBody(response);
}

async function billingWrite(input: Record<string, unknown>): Promise<unknown> {
  const response = await fetch("/api/billing", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return readBody(response);
}

/**
 * `enter` and `exit` change the tenant claim on the durable session, so the
 * browser token has to be re-minted before the shell re-renders. This mirrors
 * `refreshClaimsWhenRequired` on the server, which the `/auth/refresh` route
 * uses. Returns false when the refresh did not happen — the caller then offers
 * the `/auth/refresh` fallback rather than pretending the context switched.
 */
async function refreshBrowserClaims(): Promise<boolean> {
  try {
    const supabase = createBrowserSupabaseClient();
    const { error } = await supabase.auth.refreshSession();
    return error === null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

const sectionCopy: Record<
  PlatformSectionKey,
  { label: string; description: string }
> = {
  agent: {
    label: "Assistant",
    description: "Grounded conversation and voice for this client's people.",
  },
  insights: {
    label: "Insights",
    description: "Readiness and adoption reporting for client administrators.",
  },
  course: {
    label: "Learning",
    description: "Courses, lessons and authoring inside the client workspace.",
  },
  people: {
    label: "People",
    description: "Controlled access: accounts, roles and adoption totals.",
  },
  platform: {
    label: "Platform",
    description:
      "Cross-tenant operating view. Normally off for a client workspace.",
  },
  settings: {
    label: "Settings",
    description: "Workspace profile, branding and account controls.",
  },
};

function statusState(status: string): StatState {
  if (status === "active") return "known";
  if (status === "suspended") return "restricted";
  return "partial";
}

function formatWhen(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function readinessLabel(value: boolean): { state: StatState; text: string } {
  return value
    ? { state: "known", text: "Ready" }
    : { state: "partial", text: "Not yet" };
}

/* --- new-client provisioning ---------------------------------------- *
 *
 * The seeded surface below mirrors the value the provisioning migration writes
 * into tenant_branding, so the contrast verdict shown while choosing colours is
 * the verdict the client will actually get. It is a documented seed, not a
 * brand colour: the panel's own chrome is themed only from --brand-*.
 */

const seededSurface = "#F7F8FC";

// Used only when the current workspace reports a colour this console cannot
// parse. A neutral grey is honest; borrowing another tenant's hue is not.
const neutralSeed = "#767676";

const planCopy: Record<PlatformClientPlan, string> = {
  unconfirmed: "Unconfirmed",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

/* --- billing, margin and Stripe entitlement --------------------------- *
 *
 * Every figure this section shows — true cost, margin, billed amount — is
 * platform-admin-only in the database (PLAN.md S10.2). This panel is that
 * boundary's one legitimate reader.
 */

const billingPlanCopy: Record<BillingPlan, string> = {
  unconfirmed: "Unconfirmed",
  starter: "Starter",
  growth: "Growth",
  enterprise: "Enterprise",
};

const subscriptionStatusCopy: Record<
  BillingSubscriptionStatus,
  { label: string; state: StatState }
> = {
  none: { label: "No subscription", state: "partial" },
  trialing: { label: "Trialing", state: "known" },
  active: { label: "Active", state: "known" },
  past_due: { label: "Past due", state: "restricted" },
  canceled: { label: "Canceled", state: "partial" },
  incomplete: { label: "Incomplete", state: "partial" },
  incomplete_expired: { label: "Incomplete (expired)", state: "restricted" },
  unpaid: { label: "Unpaid", state: "restricted" },
  paused: { label: "Paused", state: "partial" },
};

const dunningStageCopy: Record<
  string,
  { label: string; state: StatState; description: string }
> = {
  none: {
    label: "Healthy",
    state: "known",
    description: "Billing is current. Nothing is degraded.",
  },
  grace: {
    label: "Grace period",
    state: "restricted",
    description:
      "A payment failed. Every section stays on until the grace window ends.",
  },
  dark: {
    label: "Sections dark",
    state: "restricted",
    description:
      "The grace window elapsed. Premium sections are suppressed until billing is resolved — the assistant and course sections are never touched by billing.",
  },
};

function microToMajor(microUnits: number): number {
  return microUnits / 1_000_000;
}

function formatMoney(microUnits: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(microToMajor(microUnits));
  } catch {
    return `$${microToMajor(microUnits).toFixed(2)}`;
  }
}

const claimStatusCopy: Record<string, { state: StatState; text: string }> = {
  pending: { state: "known", text: "Outstanding" },
  claimed: { state: "known", text: "Redeemed" },
  revoked: { state: "restricted", text: "Revoked" },
  expired: { state: "partial", text: "Expired" },
};

type ClientDraft = {
  displayName: string;
  slug: string;
  slugTouched: boolean;
  assistantName: string;
  primaryColor: string;
  accentColor: string;
  region: string;
  plan: PlatformClientPlan;
};

type IssuedClaim = {
  claimId: string;
  tenantId: string;
  slug: string;
  displayName: string;
  token: string;
  expiresAt: string | null;
};

function slugProblem(value: string): string | undefined {
  if (value.length === 0) return undefined;
  if (!platformSlugPattern.test(value)) {
    return "Use 2–63 characters: lowercase letters, numbers and hyphens, starting with a letter or number.";
  }
  return undefined;
}

type EnteredSession = {
  tenantId: string;
  displayName: string;
  slug: string;
  enteredAt: string | null;
};

type Busy =
  | null
  | { kind: "section"; sectionKey: PlatformSectionKey }
  | { kind: "status" }
  | { kind: "enter" }
  | { kind: "exit" };

type Confirmation =
  | null
  | { kind: "enter"; tenantId: string; displayName: string }
  | {
      kind: "status";
      tenantId: string;
      displayName: string;
      next: "active" | "suspended";
    };

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

/**
 * Platform panel — real control over client accounts.
 *
 * Authorization is enforced twice over: the shell only offers this section when
 * `platform_admin_is_authorized` returned true on the server, and every request
 * below is re-checked by `/api/platform` before an RPC runs.
 *
 * The data boundary is deliberate. Counts, statuses, timestamps and section
 * flags cross it; prompt text, conversation content, source bodies and
 * credentials never do.
 */
export function PlatformPanel({ payload, refresh }: PanelProps) {
  const { params, openPanel } = usePanelRouter();
  const dataVersion = useDataVersion();
  const selectedTenantId = params.get("id");

  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [overviewState, setOverviewState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [overviewError, setOverviewError] = useState<string | null>(null);

  const [detail, setDetail] = useState<PlatformTenantDetail | null>(null);
  const [detailState, setDetailState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [detailError, setDetailError] = useState<string | null>(null);

  const [session, setSession] = useState<EnteredSession | null>(null);
  const [claimsStale, setClaimsStale] = useState(false);

  const [busy, setBusy] = useState<Busy>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [typedName, setTypedName] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [takenSlug, setTakenSlug] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedClaim | null>(null);
  const [copied, setCopied] = useState(false);
  const [claims, setClaims] = useState<PlatformClientClaim[] | null>(null);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [claimsVersion, setClaimsVersion] = useState(0);
  const [revoking, setRevoking] = useState<string | null>(null);

  const [billingOverview, setBillingOverview] = useState<BillingOverview | null>(
    null,
  );
  const [billingDetail, setBillingDetail] = useState<BillingTenantDetail | null>(
    null,
  );
  const [billingDetailState, setBillingDetailState] = useState<
    "idle" | "loading" | "ready" | "failed"
  >("idle");
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [marginDraft, setMarginDraft] = useState<{
    marginMultiplier: string;
    fixedMarkupMicro: string;
    floorMicro: string;
  } | null>(null);
  const [marginBusy, setMarginBusy] = useState(false);
  const [subscriptionDraft, setSubscriptionDraft] = useState<{
    plan: BillingPlan;
    subscriptionStatus: BillingSubscriptionStatus;
  } | null>(null);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<BillingPlan>("starter");
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [portalBusy, setPortalBusy] = useState(false);
  const [clearingOverride, setClearingOverride] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  /* --- outstanding owner claims ------------------------------------- *
   *
   * Status and expiry only. The control plane never returns a token here, so
   * there is nothing for this view to leak.
   */

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const parsed = parsePlatformClientClaims(
          await platformWrite({ action: "client.claims" }),
        );
        if (!active) return;
        setClaims(parsed.claims);
        setClaimsError(null);
      } catch (error) {
        if (!active) return;
        setClaims(null);
        setClaimsError(describe(error));
      }
    })();
    return () => {
      active = false;
    };
  }, [dataVersion, claimsVersion]);

  /* --- overview --------------------------------------------------- */

  useEffect(() => {
    let active = true;
    setOverviewState("loading");
    void (async () => {
      try {
        const parsed = parsePlatformOverview(await platformRead(""));
        if (!active) return;
        setOverview(parsed);
        setOverviewError(null);
        setOverviewState("ready");
      } catch (error) {
        if (!active) return;
        setOverview(null);
        setOverviewError(describe(error));
        setOverviewState("failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [dataVersion]);

  /* --- billing overview: true cost, margin and billed amount --------
   *
   * A separate, independent fetch from the platform overview above: it can
   * fail (a missing tenant_subscriptions/tenant_margin_policies row on a
   * freshly migrated database, for instance) without taking down the rest
   * of the client-account surface, and the reverse.
   */

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const parsed = parseBillingOverview(await billingRead(""));
        if (!active) return;
        setBillingOverview(parsed);
      } catch {
        if (active) setBillingOverview(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [dataVersion]);

  /* --- am I inside a client workspace right now? -------------------
   *
   * The durable answer, not a local flag: the tenant detail RPC reports the
   * platform sessions currently inside a workspace and marks the caller's own.
   * A failure here (for example while the tenant-section migration is still
   * unapplied) simply means no banner — never a wrong one.
   */

  const currentTenantId = payload.tenant.tenantId;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const parsed = parsePlatformTenantDetail(
          await platformRead(`?tenantId=${encodeURIComponent(currentTenantId)}`),
        );
        if (!active) return;
        const caller = parsed.activePlatformSessions.find(
          (candidate) => candidate.isCaller,
        );
        setSession(
          caller === undefined
            ? null
            : {
                tenantId: parsed.tenant.tenantId,
                displayName: parsed.tenant.displayName,
                slug: parsed.tenant.slug,
                enteredAt: caller.enteredAt,
              },
        );
      } catch {
        if (active) setSession(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [currentTenantId, dataVersion]);

  /* --- selected client detail -------------------------------------- */

  const loadDetail = useCallback(async (tenantId: string) => {
    setDetailState("loading");
    try {
      const parsed = parsePlatformTenantDetail(
        await platformRead(`?tenantId=${encodeURIComponent(tenantId)}`),
      );
      setDetail(parsed);
      setDetailError(null);
      setDetailState("ready");
      return parsed;
    } catch (error) {
      setDetail(null);
      setDetailError(describe(error));
      setDetailState("failed");
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (selectedTenantId === null) {
      setDetail(null);
      setDetailError(null);
      setDetailState("idle");
      return;
    }
    void (async () => {
      const tenantId = selectedTenantId;
      setDetailState("loading");
      try {
        const parsed = parsePlatformTenantDetail(
          await platformRead(`?tenantId=${encodeURIComponent(tenantId)}`),
        );
        if (!active) return;
        setDetail(parsed);
        setDetailError(null);
        setDetailState("ready");
      } catch (error) {
        if (!active) return;
        setDetail(null);
        setDetailError(describe(error));
        setDetailState("failed");
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedTenantId, dataVersion]);

  const loadBillingDetail = useCallback(async (tenantId: string) => {
    setBillingDetailState("loading");
    try {
      const parsed = parseBillingTenantDetail(
        await billingRead(`?tenantId=${encodeURIComponent(tenantId)}`),
      );
      setBillingDetail(parsed);
      setBillingError(null);
      setBillingDetailState("ready");
      setMarginDraft({
        marginMultiplier: String(parsed.margin.marginMultiplier),
        fixedMarkupMicro: String(parsed.margin.fixedMarkupMicro),
        floorMicro: String(parsed.margin.floorMicro),
      });
      setSubscriptionDraft({
        plan: parsed.subscription.plan,
        subscriptionStatus: parsed.subscription.subscriptionStatus,
      });
      return parsed;
    } catch (error) {
      setBillingDetail(null);
      setBillingError(describe(error));
      setBillingDetailState("failed");
      setMarginDraft(null);
      setSubscriptionDraft(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let active = true;
    if (selectedTenantId === null) {
      setBillingDetail(null);
      setBillingError(null);
      setBillingDetailState("idle");
      setMarginDraft(null);
      setSubscriptionDraft(null);
      return;
    }
    void (async () => {
      const tenantId = selectedTenantId;
      setBillingDetailState("loading");
      try {
        const parsed = parseBillingTenantDetail(
          await billingRead(`?tenantId=${encodeURIComponent(tenantId)}`),
        );
        if (!active) return;
        setBillingDetail(parsed);
        setBillingError(null);
        setBillingDetailState("ready");
        setMarginDraft({
          marginMultiplier: String(parsed.margin.marginMultiplier),
          fixedMarkupMicro: String(parsed.margin.fixedMarkupMicro),
          floorMicro: String(parsed.margin.floorMicro),
        });
        setSubscriptionDraft({
          plan: parsed.subscription.plan,
          subscriptionStatus: parsed.subscription.subscriptionStatus,
        });
      } catch (error) {
        if (!active) return;
        setBillingDetail(null);
        setBillingError(describe(error));
        setBillingDetailState("failed");
        setMarginDraft(null);
        setSubscriptionDraft(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [selectedTenantId, dataVersion]);

  /* --- actions ------------------------------------------------------ */

  const openClient = useCallback(
    (tenantId: string) => {
      setActionError(null);
      setNotice(null);
      setConfirmation(null);
      openPanel("platform", { id: tenantId });
    },
    [openPanel],
  );

  const closeClient = useCallback(() => {
    setConfirmation(null);
    openPanel("platform", { id: null });
  }, [openPanel]);

  async function toggleSection(
    tenantId: string,
    sectionKey: PlatformSectionKey,
    enabled: boolean,
  ) {
    setBusy({ kind: "section", sectionKey });
    setActionError(null);
    setNotice(null);
    try {
      const update = parseTenantSectionUpdate(
        await platformWrite({ action: "section", tenantId, sectionKey, enabled }),
      );
      // Reflect exactly what the control plane returned, not what was asked for.
      setDetail((current) =>
        current === null || current.tenant.tenantId !== update.tenantId
          ? current
          : {
              ...current,
              sections: [
                ...current.sections.filter(
                  (section) => section.sectionKey !== update.section.sectionKey,
                ),
                update.section,
              ],
            },
      );
      setNotice(
        `${sectionCopy[update.section.sectionKey].label} is now ${
          update.section.enabled ? "active" : "off"
        } for this client.`,
      );
    } catch (error) {
      setActionError(describe(error));
      // The durable state is authoritative; re-read rather than guess.
      await loadDetail(tenantId);
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(
    tenantId: string,
    displayName: string,
    next: "active" | "suspended",
  ) {
    setBusy({ kind: "status" });
    setActionError(null);
    setNotice(null);
    try {
      const change = parsePlatformTenantStatusChange(
        await platformWrite({ action: "status", tenantId, status: next }),
      );
      setConfirmation(null);
      setTypedName("");
      setNotice(
        change.changed
          ? `${displayName} is now ${change.status}.`
          : `${displayName} was already ${change.status}.`,
      );
      await loadDetail(tenantId);
      await refresh();
    } catch (error) {
      setActionError(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function enterClient(tenantId: string, displayName: string) {
    setBusy({ kind: "enter" });
    setActionError(null);
    setNotice(null);
    try {
      const entry = parsePlatformTenantEntry(
        await platformWrite({ action: "enter", tenantId }),
      );
      setConfirmation(null);
      const refreshed = entry.claimsRefreshRequired
        ? await refreshBrowserClaims()
        : true;
      setClaimsStale(!refreshed);
      setSession({
        tenantId: entry.tenantId,
        displayName: entry.displayName,
        slug: entry.slug,
        enteredAt: entry.enteredAt,
      });
      setNotice(
        refreshed
          ? `You are now operating inside ${entry.displayName}. This entry is audited.`
          : `${entry.displayName} was entered, but this browser session still carries the previous claims. Refresh the secure session to finish the switch.`,
      );
      await refresh();
    } catch (error) {
      setActionError(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function exitClient() {
    setBusy({ kind: "exit" });
    setActionError(null);
    setNotice(null);
    try {
      const exit = parsePlatformTenantExit(
        await platformWrite({ action: "exit" }),
      );
      const refreshed = await refreshBrowserClaims();
      setClaimsStale(!refreshed);
      setSession(null);
      setNotice(
        exit.exited
          ? "You left the client workspace and are back in your own platform context."
          : "There was no client workspace to leave.",
      );
      await refresh();
    } catch (error) {
      setActionError(describe(error));
    } finally {
      setBusy(null);
    }
  }

  /* --- adding a client ----------------------------------------------- *
   *
   * The colour seeds come from the operating workspace's own published agent,
   * so a new client starts from something real rather than an invented hue.
   * When that value cannot be parsed the seed falls back to a neutral grey —
   * never to another tenant's brand.
   */

  function openCreate() {
    setDraft({
      displayName: "",
      slug: "",
      slugTouched: false,
      assistantName: "",
      primaryColor: normalizeHex(payload.agent.primaryColor) ?? neutralSeed,
      accentColor: normalizeHex(payload.agent.accentColor) ?? neutralSeed,
      region: "",
      plan: "unconfirmed",
    });
    // One key per form session: a retry after a failure is the same request,
    // so it can never provision two workspaces.
    setCreateKey(platformOperationKey("platform-client"));
    setCreateOpen(true);
    setCreateError(null);
    setTakenSlug(null);
    setNotice(null);
    setActionError(null);
  }

  function closeCreate() {
    setCreateOpen(false);
    setDraft(null);
    setCreateKey(null);
    setCreateError(null);
    setTakenSlug(null);
  }

  function updateDraft(patch: Partial<ClientDraft>) {
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  }

  async function createClient() {
    if (draft === null || createKey === null) return;
    const slug = draft.slug.trim();
    const displayName = draft.displayName.trim();
    const assistantName = draft.assistantName.trim();
    const region = draft.region.trim();
    setCreateBusy(true);
    setCreateError(null);
    setTakenSlug(null);
    try {
      const creation = parsePlatformClientCreation(
        await platformWrite({
          action: "client.create",
          slug,
          displayName,
          assistantName,
          primaryColor: draft.primaryColor,
          accentColor: draft.accentColor,
          idempotencyKey: createKey,
          region: region.length === 0 ? null : region,
          plan: draft.plan,
        }),
      );
      const token = creation.claim?.token ?? null;
      closeCreate();
      if (token === null) {
        // A replay of an earlier attempt. The code was disclosed once, then;
        // it is not recoverable, and saying otherwise would be a lie.
        setNotice(
          `${creation.displayName} was already created by an earlier attempt. Its owner code was shown once at that moment and cannot be re-issued — revoke it below if it never reached the client.`,
        );
      } else {
        setIssued({
          claimId: creation.claim?.claimId ?? "",
          tenantId: creation.tenantId,
          slug: creation.slug,
          displayName: creation.displayName,
          token,
          expiresAt: creation.claim?.expiresAt ?? null,
        });
        setCopied(false);
      }
      setClaimsVersion((version) => version + 1);
      await refresh();
    } catch (error) {
      if (error instanceof PlatformRpcError && error.code === "slug_conflict") {
        setTakenSlug(slug);
      }
      setCreateError(describe(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function copyToken(token: string) {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
      setActionError(
        "This browser did not allow the clipboard. Select the code above and copy it manually.",
      );
    }
  }

  async function revokeClaim(claim: PlatformClientClaim) {
    setRevoking(claim.claimId);
    setActionError(null);
    setNotice(null);
    try {
      const revoked = parsePlatformClientClaimRevocation(
        await platformWrite({
          action: "client.revokeClaim",
          claimId: claim.claimId,
        }),
      );
      setIssued((current) =>
        current !== null && current.claimId === revoked.claimId ? null : current,
      );
      setNotice(
        `The owner code for ${claim.displayName} is revoked and can never be redeemed. Create a replacement workspace if that client still needs access.`,
      );
      setClaimsVersion((version) => version + 1);
    } catch (error) {
      setActionError(describe(error));
    } finally {
      setRevoking(null);
    }
  }

  /* --- billing actions ------------------------------------------------ */

  async function saveMarginPolicy(tenantId: string) {
    if (marginDraft === null) return;
    const marginMultiplier = Number(marginDraft.marginMultiplier);
    const fixedMarkupMicro = Number(marginDraft.fixedMarkupMicro);
    const floorMicro = Number(marginDraft.floorMicro);
    if (
      !Number.isFinite(marginMultiplier) ||
      !Number.isFinite(fixedMarkupMicro) ||
      !Number.isFinite(floorMicro)
    ) {
      setBillingError("Margin, markup and floor must all be numbers.");
      return;
    }
    setMarginBusy(true);
    setBillingError(null);
    setBillingNotice(null);
    try {
      await billingWrite({
        action: "margin.set",
        tenantId,
        marginMultiplier,
        fixedMarkupMicro,
        floorMicro,
      }).then(parseMarginPolicyUpdate);
      setBillingNotice("Margin policy updated. New usage bills at the new rate.");
      await loadBillingDetail(tenantId);
    } catch (error) {
      setBillingError(describe(error));
    } finally {
      setMarginBusy(false);
    }
  }

  async function saveSubscriptionOverride(tenantId: string) {
    if (subscriptionDraft === null) return;
    setSubscriptionBusy(true);
    setBillingError(null);
    setBillingNotice(null);
    try {
      await billingWrite({
        action: "subscription.set",
        tenantId,
        plan: subscriptionDraft.plan,
        subscriptionStatus: subscriptionDraft.subscriptionStatus,
        note: "Set manually from the platform billing panel.",
      }).then(parseSubscriptionUpdate);
      setBillingNotice(
        "Subscription state set manually. Sections were restored to full plan entitlement.",
      );
      await loadBillingDetail(tenantId);
    } catch (error) {
      setBillingError(describe(error));
    } finally {
      setSubscriptionBusy(false);
    }
  }

  async function startCheckout(tenantId: string) {
    setCheckoutBusy(true);
    setBillingError(null);
    setBillingNotice(null);
    try {
      const result = await billingWrite({
        action: "checkout.create",
        tenantId,
        plan: checkoutPlan,
      });
      if (
        result !== null &&
        typeof result === "object" &&
        "checkoutUrl" in result &&
        typeof (result as { checkoutUrl: unknown }).checkoutUrl === "string"
      ) {
        window.open((result as { checkoutUrl: string }).checkoutUrl, "_blank", "noopener");
        setBillingNotice(
          "Hosted Stripe Checkout opened in a new tab. No card details ever pass through this console.",
        );
      } else {
        throw new PlatformRpcError("invalid_response");
      }
    } catch (error) {
      setBillingError(describe(error));
    } finally {
      setCheckoutBusy(false);
    }
  }

  async function openPortal(tenantId: string) {
    setPortalBusy(true);
    setBillingError(null);
    setBillingNotice(null);
    try {
      const result = await billingWrite({ action: "portal.create", tenantId });
      if (
        result !== null &&
        typeof result === "object" &&
        "portalUrl" in result &&
        typeof (result as { portalUrl: unknown }).portalUrl === "string"
      ) {
        window.open((result as { portalUrl: string }).portalUrl, "_blank", "noopener");
      } else {
        throw new PlatformRpcError("invalid_response");
      }
    } catch (error) {
      setBillingError(describe(error));
    } finally {
      setPortalBusy(false);
    }
  }

  async function clearSectionOverride(tenantId: string, sectionKey: string) {
    setClearingOverride(sectionKey);
    setBillingError(null);
    setBillingNotice(null);
    try {
      await billingWrite({
        action: "section.override.clear",
        tenantId,
        sectionKey,
      }).then(parseSectionOverrideClear);
      setBillingNotice(`${sectionKey} was returned to plan control.`);
      await loadBillingDetail(tenantId);
      await loadDetail(tenantId);
    } catch (error) {
      setBillingError(describe(error));
    } finally {
      setClearingOverride(null);
    }
  }

  /* --- the entered-workspace bar ------------------------------------ *
   *
   * Rendered into document.body, above every other layer, so the fact that
   * you are operating inside somebody else's workspace is impossible to miss
   * and the way out is always one click away.
   *
   * The two controls here are plain buttons rather than the Button primitive on
   * purpose: the bar sits outside the shell's brand scope and must stay white
   * on a fixed alert red, whatever a tenant's palette is. A brand-themed button
   * on this bar would be exactly the wrong signal.
   */

  const bar =
    session === null || !mounted
      ? null
      : createPortal(
          <div className={styles.bar} role="status">
            <span className={styles.barCopy}>
              <span aria-hidden="true" className={styles.barDot} />
              <span>
                <span className={styles.barLabel}>
                  Inside a client workspace{" "}
                </span>
                <span className={styles.barName}>{session.displayName}</span>
                <span> · every action here is audited against this client.</span>
              </span>
            </span>
            <span className={styles.barActions}>
              {claimsStale ? (
                <form
                  action="/auth/refresh"
                  className={styles.barForm}
                  method="post"
                >
                  <button
                    className={cx(styles.barButton, styles.barButtonQuiet)}
                    type="submit"
                  >
                    Refresh secure session
                  </button>
                </form>
              ) : null}
              <button
                className={styles.barButton}
                disabled={busy?.kind === "exit"}
                onClick={() => void exitClient()}
                type="button"
              >
                {busy?.kind === "exit" ? "Leaving…" : "Exit client workspace"}
              </button>
            </span>
          </div>,
          document.body,
        );

  /* --- confirmations ------------------------------------------------- */

  let confirmationView: ReactNode = null;
  if (confirmation !== null && confirmation.kind === "enter") {
    const target = confirmation;
    confirmationView = (
      <PanelFrame
        autoFocus={false}
        className={styles.confirm}
        eyebrow="Confirm a privileged action"
        footer={
          <>
            <Button
              onClick={() => setConfirmation(null)}
              disabled={busy?.kind === "enter"}
            >
              Cancel
            </Button>
            <Button
              loading={busy?.kind === "enter"}
              loadingLabel="Entering…"
              onClick={() =>
                void enterClient(target.tenantId, target.displayName)
              }
              variant="primary"
            >
              Enter {target.displayName}
            </Button>
          </>
        }
        onClose={() => setConfirmation(null)}
        side="inline"
        title={`Enter ${target.displayName}?`}
      >
        <div className={styles.confirmBody}>
          <p className={styles.groupHint}>
            You are about to operate inside{" "}
            <strong>{target.displayName}</strong> — a client workspace that is
            not your own.
          </p>
          <ul className={styles.confirmList}>
            <li>Your session context switches to this client until you exit.</li>
            <li>The entry is recorded as an audited platform session.</li>
            <li>
              Everything you do next is attributed to work inside this client.
            </li>
          </ul>
        </div>
      </PanelFrame>
    );
  } else if (confirmation !== null && confirmation.kind === "status") {
    const target = confirmation;
    const suspending = target.next === "suspended";
    const typedMatches =
      typedName.trim().toLowerCase() === target.displayName.trim().toLowerCase();
    confirmationView = (
      <PanelFrame
        autoFocus={false}
        className={cx(styles.confirm, suspending && styles.confirmDanger)}
        eyebrow={suspending ? "Confirm a suspension" : "Confirm reactivation"}
        footer={
          <>
            <Button
              disabled={busy?.kind === "status"}
              onClick={() => {
                setConfirmation(null);
                setTypedName("");
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={suspending && !typedMatches}
              loading={busy?.kind === "status"}
              loadingLabel={suspending ? "Suspending…" : "Activating…"}
              onClick={() =>
                void changeStatus(
                  target.tenantId,
                  target.displayName,
                  target.next,
                )
              }
              variant={suspending ? "danger" : "primary"}
            >
              {suspending
                ? `Suspend ${target.displayName}`
                : `Activate ${target.displayName}`}
            </Button>
          </>
        }
        onClose={() => {
          setConfirmation(null);
          setTypedName("");
        }}
        side="inline"
        title={
          suspending
            ? `Suspend ${target.displayName}?`
            : `Activate ${target.displayName}?`
        }
      >
        <div className={styles.confirmBody}>
          {suspending ? (
            <>
              <p className={styles.groupHint}>
                Suspension cuts off <strong>every person</strong> in this client
                workspace immediately — learners, authors and administrators
                alike. Their content is retained, but nobody can sign in to it
                until the workspace is activated again.
              </p>
              <p className={styles.confirmName}>{target.displayName}</p>
              <TextField
                autoComplete="off"
                autoFocus
                label="Type the client name to confirm"
                help="The suspension button stays disabled until this matches exactly."
                onChange={(event) => setTypedName(event.target.value)}
                spellCheck={false}
                value={typedName}
              />
            </>
          ) : (
            <p className={styles.groupHint}>
              Activating restores sign-in for everyone in{" "}
              <strong>{target.displayName}</strong>. Section flags are not
              changed by this — whatever was switched off stays off.
            </p>
          )}
        </div>
      </PanelFrame>
    );
  }

  /* --- billing: true cost, margin, billed amount, plan, subscription -- *
   *
   * Every figure below is platform-admin-only at the SQL boundary
   * (`platform_admin_tenant_billing_detail`) — a creator reaches only
   * `tenant_get_billing_summary`, which this panel never calls. See PLAN.md
   * S10.2 and S10.4.
   */

  function renderBillingSection(tenantId: string) {
    if (billingDetailState === "loading" || billingDetailState === "idle") {
      return (
        <section className={styles.detailGroup}>
          <h5 className={styles.groupTitle}>Billing</h5>
          <p className={styles.loading} role="status">
            Loading billing detail…
          </p>
        </section>
      );
    }

    if (billingDetailState === "failed" || billingDetail === null) {
      return (
        <section className={styles.detailGroup}>
          <h5 className={styles.groupTitle}>Billing</h5>
          <p className={styles.failure} role="alert">
            {billingError ?? "Billing detail could not be loaded."}
          </p>
        </section>
      );
    }

    const b = billingDetail;
    const statusCopy =
      subscriptionStatusCopy[b.subscription.subscriptionStatus];
    const dunningCopy = dunningStageCopy[b.subscription.dunningStage] ?? {
      label: b.subscription.dunningStage,
      state: "partial" as StatState,
      description: "",
    };
    // "platform" is excluded: it is the platform-owner console section, never
    // billing-governed, and `platform_admin_clear_tenant_section_override`
    // refuses it outright — showing a "return to plan control" button that
    // would only ever fail is worse than not showing it.
    const overriddenSections = b.sections.filter(
      (section) =>
        section.source === "manual_override" && section.sectionKey !== "platform",
    );

    return (
      <section className={styles.detailGroup}>
        <div className={styles.sectionHead}>
          <div>
            <p className={styles.eyebrow}>Billing</p>
            <h4 className={styles.subtitle}>Margin, plan and subscription</h4>
          </div>
          <span className={styles.meta}>
            {b.windowDays}-day window · updated{" "}
            {formatWhen(b.generatedAt) ?? "just now"}
          </span>
        </div>

        <div className={styles.tiles}>
          <StatTile
            label="True provider cost"
            sublabel={`Last ${b.windowDays} days · platform-admin only`}
            value={formatMoney(b.usage.windowTrueCostMicro, b.margin.currency)}
          />
          <StatTile
            label="Margin"
            sublabel={`×${b.margin.marginMultiplier} + ${formatMoney(
              b.margin.fixedMarkupMicro,
              b.margin.currency,
            )}, floor ${formatMoney(b.margin.floorMicro, b.margin.currency)}`}
            value={`${b.margin.marginMultiplier}×`}
          />
          <StatTile
            label="Model tier"
            sublabel="Biggest lever on margin"
            value={b.modelTier ?? "Platform default"}
          />
          <StatTile
            label="Monthly budget headroom"
            sublabel={
              b.budget.monthlyBudgetMicro === null
                ? "No budget policy set"
                : `${formatMoney(b.budget.monthSpendMicro, b.margin.currency)} spent`
            }
            value={
              b.budget.monthlyBudgetMicro === null
                ? "—"
                : formatMoney(
                    Math.max(
                      b.budget.monthlyBudgetMicro - b.budget.monthSpendMicro,
                      0,
                    ),
                    b.margin.currency,
                  )
            }
          />
        </div>

        <div className={styles.readiness}>
          <div className={styles.readinessRow}>
            <span>Plan</span>
            <StateBadge state="known">
              {billingPlanCopy[b.subscription.plan] +
                (b.subscription.planSource === "manual" ? " · manual" : "")}
            </StateBadge>
          </div>
          <div className={styles.readinessRow}>
            <span>Subscription</span>
            <StateBadge state={statusCopy.state}>{statusCopy.label}</StateBadge>
          </div>
          <div className={styles.readinessRow}>
            <span>Dunning</span>
            <StateBadge state={dunningCopy.state}>
              {dunningCopy.label}
            </StateBadge>
          </div>
        </div>
        {b.subscription.dunningStage !== "none" ? (
          <p className={styles.groupHint}>{dunningCopy.description}</p>
        ) : null}
        {b.subscription.dunningStage === "grace" &&
        b.subscription.gracePeriodEndsAt !== null ? (
          <p className={styles.groupHint}>
            Grace window ends {formatWhen(b.subscription.gracePeriodEndsAt)}.
          </p>
        ) : null}

        {overriddenSections.length > 0 ? (
          <div className={styles.form}>
            <p className={styles.groupHint}>
              These sections were set by hand and no longer follow the plan
              automatically:
            </p>
            {overriddenSections.map((section) => (
              <div className={styles.readinessRow} key={section.sectionKey}>
                <span>
                  {sectionCopy[section.sectionKey as PlatformSectionKey]
                    ?.label ?? section.sectionKey}{" "}
                  — {section.enabled ? "on" : "off"}
                </span>
                <Button
                  disabled={clearingOverride !== null}
                  loading={clearingOverride === section.sectionKey}
                  loadingLabel="Returning…"
                  onClick={() =>
                    void clearSectionOverride(tenantId, section.sectionKey)
                  }
                  size="sm"
                >
                  Return to plan control
                </Button>
              </div>
            ))}
          </div>
        ) : null}

        <div className={styles.formRow}>
          <TextField
            help="Multiplies true cost. 1.0 bills at cost; comping an account can go below 1.0."
            label="Margin multiplier"
            min="0"
            onChange={(event) =>
              setMarginDraft((current) =>
                current === null
                  ? current
                  : { ...current, marginMultiplier: event.target.value },
              )
            }
            step="0.01"
            type="number"
            value={marginDraft?.marginMultiplier ?? ""}
          />
          <TextField
            help="Micro-units of currency added per reported usage row."
            label="Fixed markup (micro)"
            min="0"
            onChange={(event) =>
              setMarginDraft((current) =>
                current === null
                  ? current
                  : { ...current, fixedMarkupMicro: event.target.value },
              )
            }
            step="1"
            type="number"
            value={marginDraft?.fixedMarkupMicro ?? ""}
          />
          <TextField
            help="Never bills a row below this, in micro-units."
            label="Floor (micro)"
            min="0"
            onChange={(event) =>
              setMarginDraft((current) =>
                current === null
                  ? current
                  : { ...current, floorMicro: event.target.value },
              )
            }
            step="1"
            type="number"
            value={marginDraft?.floorMicro ?? ""}
          />
        </div>
        <div className={styles.clientActions}>
          <Button
            loading={marginBusy}
            loadingLabel="Saving…"
            onClick={() => void saveMarginPolicy(tenantId)}
            size="sm"
            variant="primary"
          >
            Save margin policy
          </Button>
        </div>

        <div className={styles.formRow}>
          <SelectField
            help="Stripe drives this automatically once a subscription exists. Setting it here is a manual comp or debug override."
            label="Plan (manual override)"
            onChange={(event) =>
              setSubscriptionDraft((current) =>
                current === null || !isBillingPlan(event.target.value)
                  ? current
                  : { ...current, plan: event.target.value }
              )
            }
            options={billingPlans.map((value) => ({
              value,
              label: billingPlanCopy[value],
            }))}
            value={subscriptionDraft?.plan ?? "unconfirmed"}
          />
          <SelectField
            help="Also resets dunning and restores full plan entitlement."
            label="Subscription status (manual override)"
            onChange={(event) =>
              setSubscriptionDraft((current) =>
                current === null ||
                !isBillingSubscriptionStatus(event.target.value)
                  ? current
                  : { ...current, subscriptionStatus: event.target.value }
              )
            }
            options={billingSubscriptionStatuses.map((value) => ({
              value,
              label: subscriptionStatusCopy[value].label,
            }))}
            value={subscriptionDraft?.subscriptionStatus ?? "none"}
          />
        </div>
        <div className={styles.clientActions}>
          <Button
            loading={subscriptionBusy}
            loadingLabel="Saving…"
            onClick={() => void saveSubscriptionOverride(tenantId)}
            size="sm"
          >
            Set subscription manually
          </Button>
        </div>

        <div className={styles.formRow}>
          <SelectField
            help="Opens hosted Stripe Checkout in a new tab. No card details ever reach this console."
            label="Start checkout for"
            onChange={(event) =>
              isBillingPlan(event.target.value) &&
              event.target.value !== "unconfirmed" &&
              setCheckoutPlan(event.target.value)
            }
            options={billingPlans
              .filter((value) => value !== "unconfirmed")
              .map((value) => ({ value, label: billingPlanCopy[value] }))}
            value={checkoutPlan}
          />
        </div>
        <div className={styles.clientActions}>
          <Button
            loading={checkoutBusy}
            loadingLabel="Opening…"
            onClick={() => void startCheckout(tenantId)}
            size="sm"
            variant="primary"
          >
            Start Stripe Checkout
          </Button>
          <Button
            disabled={b.subscription.stripeCustomerId === null}
            loading={portalBusy}
            loadingLabel="Opening…"
            onClick={() => void openPortal(tenantId)}
            size="sm"
          >
            Open billing portal
          </Button>
        </div>
        <p className={styles.groupHint}>
          Checkout and the billing portal need Stripe configured on this
          deployment — if they are not, the button reports that clearly
          instead of failing silently.
        </p>

        {billingNotice !== null ? (
          <p className={styles.notice} role="status">
            {billingNotice}
          </p>
        ) : null}
        {billingError !== null ? (
          <p className={styles.failure} role="alert">
            {billingError}
          </p>
        ) : null}
      </section>
    );
  }

  /* --- detail view ---------------------------------------------------- */

  function renderDetail() {
    if (detailState === "loading" || detailState === "idle") {
      return (
        <p className={styles.loading} role="status">
          Loading client controls…
        </p>
      );
    }

    if (detailState === "failed" || detail === null) {
      return (
        <EmptyState
          action={
            <Button onClick={closeClient} variant="secondary">
              Back to all clients
            </Button>
          }
          description={
            detailError ??
            "The client detail could not be read. No substitute values were shown."
          }
          headline="Client controls are unavailable"
          tone="error"
        />
      );
    }

    const client = detail;
    const entered = session?.tenantId === client.tenant.tenantId;
    const suspended = client.tenant.status === "suspended";
    const lastActivity = formatWhen(client.lastActivityAt);
    const enabledByKey = new Map<PlatformSectionKey, TenantSection>(
      client.sections.map((section) => [section.sectionKey, section] as const),
    );
    const readinessRows: Array<{ label: string; ready: boolean }> = [
      { label: "Branding configured", ready: client.readiness.hasBranding },
      {
        label: "A published course",
        ready: client.readiness.hasPublishedCourse,
      },
      { label: "Grounded knowledge", ready: client.readiness.hasKnowledge },
      { label: "Active members", ready: client.readiness.hasActiveMembers },
    ];

    return (
      <PanelFrame
        autoFocus={false}
        description={`${client.tenant.assistantName} · ${client.tenant.slug}${
          client.tenant.region === null ? "" : ` · ${client.tenant.region}`
        }`}
        eyebrow="Client workspace"
        footer={
          entered ? (
            <Button
              loading={busy?.kind === "exit"}
              loadingLabel="Leaving…"
              onClick={() => void exitClient()}
              variant="primary"
            >
              Exit this client workspace
            </Button>
          ) : (
            <Button
              disabled={suspended || busy !== null}
              onClick={() =>
                setConfirmation({
                  kind: "enter",
                  tenantId: client.tenant.tenantId,
                  displayName: client.tenant.displayName,
                })
              }
              variant="primary"
            >
              Enter client workspace
            </Button>
          )
        }
        footerLead={
          lastActivity === null
            ? "No recorded activity yet"
            : `Last activity ${lastActivity}`
        }
        headerActions={
          <StateBadge state={statusState(client.tenant.status)}>
            {client.tenant.status}
          </StateBadge>
        }
        onClose={closeClient}
        closeLabel="Back to all clients"
        side="inline"
        title={client.tenant.displayName}
      >
        <div className={styles.detail}>
          {entered ? (
            <div className={styles.inside}>
              <span className={styles.insideCopy}>
                <span className={styles.insideLabel}>
                  You are inside this workspace
                </span>
                <span className={styles.insideMeta}>
                  Entered{" "}
                  {formatWhen(session?.enteredAt) ?? "in the current session"}.
                  Leave it before operating on another client.
                </span>
              </span>
              <Button
                loading={busy?.kind === "exit"}
                loadingLabel="Leaving…"
                onClick={() => void exitClient()}
                variant="primary"
              >
                Exit now
              </Button>
            </div>
          ) : null}

          {confirmationView}

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>Workspace</h5>
            <div className={styles.tiles}>
              <StatTile
                label="People"
                sublabel={`${client.counts.admins} with administrative access`}
                value={client.counts.members.toLocaleString()}
              />
              <StatTile
                label="Courses"
                sublabel={`${client.counts.publishedCourses} published`}
                value={client.counts.courses.toLocaleString()}
              />
              <StatTile
                label="Knowledge"
                sublabel={`${client.counts.sources.toLocaleString()} sources`}
                value={`${client.counts.knowledgeChunks.toLocaleString()} chunks`}
              />
              <StatTile
                label="Conversations"
                sublabel="Counted only. Content is never exposed here."
                value={client.counts.conversations.toLocaleString()}
              />
            </div>
          </section>

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>Readiness</h5>
            <p className={styles.groupHint}>
              Onboarding is <strong>{client.readiness.onboardingStatus}</strong>
              {formatWhen(client.readiness.launchedAt) === null
                ? " · not launched yet"
                : ` · launched ${formatWhen(client.readiness.launchedAt) ?? ""}`}
              .
            </p>
            <div className={styles.readiness}>
              {readinessRows.map((row) => {
                const verdict = readinessLabel(row.ready);
                return (
                  <div className={styles.readinessRow} key={row.label}>
                    <span>{row.label}</span>
                    <StateBadge state={verdict.state}>
                      {verdict.text}
                    </StateBadge>
                  </div>
                );
              })}
            </div>
          </section>

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>Active sections</h5>
            <p className={styles.groupHint}>
              A section that is off disappears from this client’s workspace for
              everyone in it. Changes apply immediately.
            </p>
            <div className={styles.switches}>
              {platformSectionKeys.map((sectionKey, index) => {
                const section = enabledByKey.get(sectionKey);
                const updated = formatWhen(section?.updatedAt);
                const copy = sectionCopy[sectionKey];
                return (
                  <Toggle
                    bordered={index < platformSectionKeys.length - 1}
                    checked={section?.enabled === true}
                    description={
                      updated === null
                        ? copy.description
                        : `${copy.description} Changed ${updated}.`
                    }
                    disabled={busy !== null}
                    key={sectionKey}
                    label={copy.label}
                    onChange={(next) =>
                      void toggleSection(
                        client.tenant.tenantId,
                        sectionKey,
                        next,
                      )
                    }
                  />
                );
              })}
            </div>
          </section>

          {renderBillingSection(client.tenant.tenantId)}

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>Active platform sessions</h5>
            {client.activePlatformSessions.length === 0 ? (
              <EmptyState
                compact
                description="No platform administrator is operating inside this client right now."
                headline="Nobody is inside"
              />
            ) : (
              <ul className={styles.sessions}>
                {client.activePlatformSessions.map((entry) => (
                  <li
                    className={styles.session}
                    data-caller={entry.isCaller ? "true" : undefined}
                    key={entry.sessionId}
                  >
                    <span className={styles.sessionId}>
                      {entry.isCaller
                        ? "This session"
                        : `Session ${shortId(entry.sessionId)}`}
                    </span>
                    <span>
                      Entered {formatWhen(entry.enteredAt) ?? "recently"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>Account status</h5>
            <div className={styles.danger}>
              <span className={styles.dangerCopy}>
                <strong>
                  {suspended
                    ? "This client is suspended."
                    : "This client is active."}
                </strong>
                <span>
                  {suspended
                    ? "Nobody in this workspace can sign in. Activating restores access for everyone at once."
                    : "Suspending cuts off every person in this workspace immediately. Content is retained."}
                </span>
              </span>
              <Button
                disabled={busy !== null}
                onClick={() =>
                  setConfirmation({
                    kind: "status",
                    tenantId: client.tenant.tenantId,
                    displayName: client.tenant.displayName,
                    next: suspended ? "active" : "suspended",
                  })
                }
                variant={suspended ? "primary" : "danger"}
              >
                {suspended ? "Activate client" : "Suspend client"}
              </Button>
            </div>
          </section>
        </div>
      </PanelFrame>
    );
  }

  /* --- the add-client form --------------------------------------------- */

  const trimmedSlug = draft === null ? "" : draft.slug.trim();
  const slugError =
    draft === null
      ? undefined
      : takenSlug !== null && takenSlug === trimmedSlug
        ? "That workspace URL is already taken by another client."
        : slugProblem(trimmedSlug);
  const canCreate =
    draft !== null &&
    !createBusy &&
    draft.displayName.trim().length > 0 &&
    draft.assistantName.trim().length > 0 &&
    platformSlugPattern.test(trimmedSlug) &&
    slugError === undefined;

  const createView =
    !createOpen || draft === null ? null : (
      <PanelFrame
        autoFocus={false}
        className={styles.confirm}
        description="Creates the workspace, seeds its assistant branding, and mints a single-use owner code. The client redeems that code to become the owner of their own account."
        eyebrow="Onboard a client"
        footer={
          <>
            <Button disabled={createBusy} onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              disabled={!canCreate}
              loading={createBusy}
              loadingLabel="Creating…"
              onClick={() => void createClient()}
              variant="primary"
            >
              Create workspace
            </Button>
          </>
        }
        footerLead="Nothing is written until you create."
        onClose={closeCreate}
        side="inline"
        title="Add a client"
      >
        <div className={styles.form}>
          <TextField
            autoComplete="organization"
            help="The client's own name for their workspace. People inside it see this."
            label="Company name"
            onChange={(event) => {
              const next = event.target.value;
              updateDraft({
                displayName: next,
                slug: draft.slugTouched
                  ? draft.slug
                  : normalizePlatformSlug(next),
              });
            }}
            required
            value={draft.displayName}
          />

          <TextField
            autoComplete="off"
            error={slugError}
            help="Lowercase letters, numbers and hyphens. Permanent — it identifies the workspace everywhere."
            label="Workspace URL"
            onChange={(event) =>
              updateDraft({
                slug: event.target.value
                  .toLowerCase()
                  .replace(/[^a-z0-9-]+/gu, "-")
                  .slice(0, 63),
                slugTouched: true,
              })
            }
            required
            spellCheck={false}
            value={draft.slug}
          />

          <TextField
            autoComplete="off"
            help="What the assistant calls itself in this client's workspace."
            label="Assistant name"
            onChange={(event) =>
              updateDraft({ assistantName: event.target.value })
            }
            required
            value={draft.assistantName}
          />

          <div className={styles.formRow}>
            <ColorField
              contrastAgainst={seededSurface}
              contrastLabel="primary on the client's surface"
              help="Buttons and highlights inside the client workspace."
              label="Primary colour"
              onChange={(hex) => updateDraft({ primaryColor: hex })}
              value={draft.primaryColor}
            />
            <ColorField
              contrastAgainst={seededSurface}
              contrastLabel="accent on the client's surface"
              help="Secondary emphasis."
              label="Accent colour"
              onChange={(hex) => updateDraft({ accentColor: hex })}
              value={draft.accentColor}
            />
          </div>

          <div className={styles.formRow}>
            <TextField
              autoComplete="off"
              help="Optional. Recorded on the tenant; it moves no data by itself."
              label="Region"
              onChange={(event) => updateDraft({ region: event.target.value })}
              value={draft.region}
            />
            <SelectField
              help="Recorded on the workspace. Change it later from the client's account."
              label="Plan"
              onChange={(event) =>
                updateDraft({
                  plan: isPlatformClientPlan(event.target.value)
                    ? event.target.value
                    : "unconfirmed",
                })
              }
              options={platformClientPlans.map((plan) => ({
                value: plan,
                label: planCopy[plan],
              }))}
              value={draft.plan}
            />
          </div>

          {createError === null ? null : (
            <p className={styles.failure} role="alert">
              {createError}
            </p>
          )}
        </div>
      </PanelFrame>
    );

  /* --- the one-time owner code ------------------------------------------ *
   *
   * The only moment this value is readable. The control plane stored a SHA-256
   * digest of it and nothing else, so once this card is dismissed the code is
   * genuinely gone — the copy here says exactly that, because a reassuring
   * "you can find it later" would be false.
   */

  const issuedExpiry = issued === null ? null : formatWhen(issued.expiresAt);
  const issuedView =
    issued === null ? null : (
      <section className={styles.issued} role="status">
        <div className={styles.issuedHead}>
          <span className={styles.issuedLabel}>One-time owner code</span>
          <StateBadge state="restricted">Shown once</StateBadge>
        </div>
        <p className={styles.issuedName}>
          {issued.displayName} · {issued.slug}
        </p>
        <code className={styles.token}>{issued.token}</code>
        <div className={styles.issuedActions}>
          <Button
            onClick={() => void copyToken(issued.token)}
            variant="primary"
          >
            {copied ? "Copied" : "Copy code"}
          </Button>
          <Button
            onClick={() => {
              setIssued(null);
              setCopied(false);
            }}
          >
            I have delivered it
          </Button>
        </div>
        <p className={styles.issuedNote}>
          Only a one-way hash of this code was stored, so it cannot be looked up
          or re-sent. Dismissing this card is the last time anyone can read it.
          Deliver it to the client&rsquo;s named owner over a channel you trust —
          whoever redeems it becomes the owner of{" "}
          <strong>{issued.displayName}</strong>.
          {issuedExpiry === null ? "" : ` It expires ${issuedExpiry}.`}
        </p>
      </section>
    );

  /* --- outstanding owner codes ------------------------------------------ */

  const claimsView = (
    <section className={styles.detailGroup}>
      <div className={styles.sectionHead}>
        <div>
          <p className={styles.eyebrow}>Onboarding</p>
          <h4 className={styles.subtitle}>Owner codes</h4>
        </div>
        <span className={styles.meta}>
          Status and expiry only. The codes themselves are not recoverable.
        </span>
      </div>
      {claimsError !== null ? (
        <p className={styles.failure} role="alert">
          {claimsError}
        </p>
      ) : claims === null ? (
        <p className={styles.loading} role="status">
          Loading owner codes…
        </p>
      ) : claims.length === 0 ? (
        <EmptyState
          action={
            <Button onClick={openCreate} variant="primary">
              Add client
            </Button>
          }
          compact
          description="An owner code appears here for every client workspace you create, until the client redeems it."
          headline="No owner codes outstanding"
        />
      ) : (
        <ul className={styles.claims}>
          {claims.map((claim) => {
            const verdict = claimStatusCopy[claim.status] ?? {
              state: "partial" as StatState,
              text: claim.status,
            };
            const expiry = formatWhen(claim.expiresAt);
            const redeemed = formatWhen(claim.claimedAt);
            const revocable =
              claim.status === "pending" || claim.status === "expired";
            return (
              <li
                className={styles.claim}
                data-status={claim.status}
                key={claim.claimId}
              >
                <span className={styles.claimCopy}>
                  <span className={styles.claimName}>{claim.displayName}</span>
                  <span className={styles.meta}>
                    {claim.slug}
                    {redeemed !== null
                      ? ` · redeemed ${redeemed}`
                      : expiry === null
                        ? ""
                        : claim.status === "expired"
                          ? ` · expired ${expiry}`
                          : ` · expires ${expiry}`}
                  </span>
                </span>
                <span className={styles.claimActions}>
                  <StateBadge state={verdict.state}>{verdict.text}</StateBadge>
                  {revocable ? (
                    <Button
                      loading={revoking === claim.claimId}
                      loadingLabel="Revoking…"
                      onClick={() => void revokeClaim(claim)}
                      size="sm"
                      variant="danger"
                    >
                      Revoke
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  /* --- render ---------------------------------------------------------- */

  const clientCard = (tenant: PlatformTenantSummary) => {
    const entered = session?.tenantId === tenant.tenantId;
    const updated = formatWhen(tenant.updatedAt);
    const billing = billingOverview?.tenants.find(
      (entry) => entry.tenantId === tenant.tenantId,
    );
    return (
      <article
        className={styles.client}
        data-entered={entered ? "true" : undefined}
        data-status={tenant.status}
        key={tenant.tenantId}
      >
        <div className={styles.clientHead}>
          <div>
            <h5 className={styles.clientName}>{tenant.displayName}</h5>
            <p className={styles.meta}>
              {tenant.assistantName} · {tenant.slug}
              {tenant.region === null ? "" : ` · ${tenant.region}`}
            </p>
          </div>
          <StateBadge state={statusState(tenant.status)}>
            {tenant.status}
          </StateBadge>
        </div>

        {entered ? (
          <span className={styles.insideTag}>You are inside</span>
        ) : null}

        <dl className={styles.clientStats}>
          <div>
            <dt>Courses</dt>
            <dd>
              {tenant.publishedCourses}/{tenant.courses} published
            </dd>
          </div>
          <div>
            <dt>People</dt>
            <dd>{tenant.members.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Knowledge</dt>
            <dd>{tenant.knowledgeChunks.toLocaleString()} chunks</dd>
          </div>
          <div>
            <dt>Sources</dt>
            <dd>{tenant.sources.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Billed</dt>
            <dd>
              {billing === undefined
                ? "—"
                : formatMoney(billing.windowBilledMicro, billing.currency)}
            </dd>
          </div>
        </dl>

        <p className={styles.meta}>
          {updated === null ? "No recorded activity" : `Last activity ${updated}`}
        </p>

        <div className={styles.clientActions}>
          <Button
            onClick={() => openClient(tenant.tenantId)}
            size="sm"
            variant="primary"
          >
            Open client controls
          </Button>
          {entered ? (
            <Button
              loading={busy?.kind === "exit"}
              loadingLabel="Leaving…"
              onClick={() => void exitClient()}
              size="sm"
            >
              Exit workspace
            </Button>
          ) : null}
        </div>
      </article>
    );
  };

  return (
    <div className={styles.root}>
      {bar}

      <section className={styles.intro}>
        <div className={styles.introCopy}>
          <p className={styles.eyebrow}>Platform owner</p>
          <h3 className={styles.title}>Control the client accounts.</h3>
          <p className={styles.lede}>
            Every number below comes from the durable LearningBot database.
            Switch sections on or off per client, suspend or restore an account,
            and enter a workspace when you have to operate inside it.
          </p>
        </div>
        <div className={styles.introActions}>
          <Button
            disabled={busy !== null || createOpen}
            onClick={openCreate}
            size="sm"
            variant="primary"
          >
            Add client
          </Button>
          <Button
            disabled={busy !== null}
            onClick={() => void refresh()}
            size="sm"
          >
            Reload
          </Button>
        </div>
      </section>

      {session !== null ? (
        <div className={styles.inside}>
          <span className={styles.insideCopy}>
            <span className={styles.insideLabel}>
              Operating inside a client workspace
            </span>
            <span className={styles.insideName}>{session.displayName}</span>
            <span className={styles.insideMeta}>
              {session.slug}
              {formatWhen(session.enteredAt) === null
                ? ""
                : ` · entered ${formatWhen(session.enteredAt) ?? ""}`}
              . This is an audited platform session.
            </span>
          </span>
          <Button
            loading={busy?.kind === "exit"}
            loadingLabel="Leaving…"
            onClick={() => void exitClient()}
            variant="primary"
          >
            Exit client workspace
          </Button>
        </div>
      ) : null}

      {createView}
      {issuedView}

      {notice === null ? null : (
        <p className={styles.notice} role="status">
          {notice}
        </p>
      )}
      {actionError === null ? null : (
        <p className={styles.failure} role="alert">
          {actionError}
        </p>
      )}

      {overviewState === "loading" ? (
        <p className={styles.loading} role="status">
          Loading the durable control plane…
        </p>
      ) : null}

      {overviewState === "failed" ? (
        <div className={styles.failure} role="alert">
          {overviewError ??
            "The durable platform summary could not be loaded. No fixture data was substituted."}
        </div>
      ) : null}

      {overviewState === "ready" && overview !== null ? (
        <>
          <section className={styles.tiles} aria-label="Platform totals">
            <StatTile
              label="Client workspaces"
              sublabel={`${overview.totals.activeTenants} active`}
              value={overview.totals.tenants.toLocaleString()}
            />
            <StatTile
              label="Courses"
              sublabel="Across isolated tenants"
              value={overview.totals.courses.toLocaleString()}
            />
            <StatTile
              label="Knowledge sources"
              sublabel={`${overview.totals.knowledgeChunks.toLocaleString()} grounded chunks`}
              value={overview.totals.sources.toLocaleString()}
            />
            <StatTile
              label="Managed people"
              sublabel="Active memberships"
              value={overview.totals.members.toLocaleString()}
            />
          </section>

          {selectedTenantId === null ? (
            <>
              <section className={styles.detailGroup}>
                <div className={styles.sectionHead}>
                  <div>
                    <p className={styles.eyebrow}>Clients</p>
                    <h4 className={styles.subtitle}>Live workspaces</h4>
                  </div>
                  <span className={styles.meta}>
                    Updated {formatWhen(overview.generatedAt) ?? "just now"}
                  </span>
                </div>
                {overview.tenants.length === 0 ? (
                  <EmptyState
                    action={
                      <Button onClick={openCreate} variant="primary">
                        Add your first client
                      </Button>
                    }
                    description="No client workspace exists on this control plane yet."
                    headline="No clients"
                  />
                ) : (
                  <div className={styles.clients}>
                    {overview.tenants.map(clientCard)}
                  </div>
                )}
              </section>
              {claimsView}
            </>
          ) : (
            renderDetail()
          )}
        </>
      ) : null}

      <section className={styles.boundary}>
        <strong>Operational control without surveillance.</strong>
        <span>
          This view carries counts, statuses, timestamps and section flags only.
          Prompt text, conversation content, learning-source bodies, exports and
          credentials never cross into it — entering a client workspace is the
          audited path to tenant-scoped work.
        </span>
      </section>
    </div>
  );
}

export default PlatformPanel;
