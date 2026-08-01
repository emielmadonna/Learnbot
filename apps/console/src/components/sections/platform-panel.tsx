"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { createBrowserSupabaseClient } from "../../lib/supabase/client";
import {
  PlatformRpcError,
  normalizePlatformSlug,
  parsePlatformClientCreation,
  parsePlatformOverview,
  parsePlatformTenantDetail,
  parsePlatformTenantEntry,
  parsePlatformTenantExit,
  parsePlatformTenantStatusChange,
  parseTenantSectionUpdate,
  platformOperationKey,
  platformSectionKeys,
  platformSlugPattern,
} from "../../lib/supabase/platform-rpc";
import type {
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
import { CorsoIcon } from "../corso/corso-icon";
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
  provider_not_configured:
    "Invitation email is not configured for this deployment.",
  invitation_provider_failed:
    "The invitation provider did not confirm delivery.",
  invitation_provisioning_failed:
    "The invitation email was attempted, but workspace access could not be provisioned.",
  owner_identity_conflict:
    "The client owner must use a different identity from the platform administrator.",
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

type ClientCapabilityRow = { key: string; label: string; reason: string };

/**
 * "What the client can change themselves" — the mockup's five independent
 * toggles for bot identity, welcome copy, voice, model choice and invites.
 * None of it is backed by anything: a tenant admin's ability to edit their
 * own bot name/colour/icon, welcome message, voice, model, or to invite
 * others today comes entirely from their role membership (tenant_owner /
 * tenant_admin), with no separate record a platform administrator could use
 * to restrict one client without restricting the role everywhere.
 *
 * Every row below renders disabled with this reason rather than pretending a
 * click would do anything real. See the platform-panel change report for the
 * proposed shape (`tenant_capability_grants` /
 * `platform_admin_set_tenant_capability`, mirroring the existing
 * `platform_admin_set_tenant_section` pattern).
 */
const clientCapabilities: readonly ClientCapabilityRow[] = [
  {
    key: "bot_identity",
    label: "Bot name, colour and icon",
    reason:
      "No capability record exists to separate this from ordinary tenant-admin access — disabled until one does.",
  },
  {
    key: "welcome_message",
    label: "Welcome message and starters",
    reason:
      "Same gap: nothing today distinguishes this from general workspace-settings access.",
  },
  {
    key: "voice_answer_length",
    label: "Voice and answer length",
    reason:
      "Same gap: nothing today distinguishes this from general workspace-settings access.",
  },
  {
    key: "model_choice",
    label: "Which model answers",
    reason:
      "Model choice also changes cost — this needs the same missing record, and should default to off once it exists.",
  },
  {
    key: "invite_members",
    label: "Invite other people to the workspace",
    reason:
      "No capability record exists to separate this from tenant-owner access yet.",
  },
];

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

function tenantInitials(value: string): string {
  const words = value
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length === 0) return "—";
  if (words.length === 1) return words[0]?.slice(0, 2).toUpperCase() ?? "—";
  return `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`.toUpperCase();
}

function needsWorkspaceAttention(tenant: PlatformTenantSummary): boolean {
  return (
    tenant.status !== "suspended" &&
    (tenant.publishedCourses === 0 ||
      tenant.knowledgeChunks === 0 ||
      tenant.members === 0)
  );
}

/**
 * The design calls for a fourth workspace state beyond paused/setup/live: a
 * "Review" workspace — live and launched, but still failing its people,
 * judged by something like a refusal or ungrounded-answer rate. That figure
 * exists per tenant (see `ungroundedQuestions` / `unansweredQuestions` in
 * lib/supabase/analytics-rpc.ts, read inside a single tenant's own Insights
 * panel), but `platform_admin_overview` — the RPC behind `PlatformOverview` —
 * never aggregates it across tenants, and `PlatformTenantSummary` carries no
 * such field today.
 *
 * Rather than invent a threshold over data this panel cannot see, this stays
 * an honest `false` until the platform overview is extended with a windowed,
 * per-tenant figure — e.g. `recentUngroundedShare: number | null` or
 * `recentUnansweredCount: number` on `PlatformTenantSummary`, computed the
 * same way Insights already computes it, just aggregated platform-wide. The
 * visual state (dot, ring, "Review" label) below is built and wired to this
 * predicate, so turning it on is a one-line change once that data exists.
 */
function needsWorkspaceReview(_tenant: PlatformTenantSummary): boolean {
  return false;
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
const invitationEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

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

type ClientDraft = {
  displayName: string;
  slug: string;
  slugTouched: boolean;
  assistantName: string;
  primaryColor: string;
  accentColor: string;
  region: string;
  plan: PlatformClientPlan;
  knowledgeStart: KnowledgeStart;
  ownerDisplayName: string;
  ownerEmail: string;
};

type KnowledgeStart = "course" | "youtube" | "circle" | "paste" | "qa";

const knowledgeStarts: readonly {
  value: KnowledgeStart;
  label: string;
  description: string;
}[] = [
  {
    value: "course",
    label: "Write a course now",
    description: "Start with a private course and publish it when it is ready.",
  },
  {
    value: "youtube",
    label: "Connect YouTube videos",
    description: "Choose real videos or a playlist in the new workspace.",
  },
  {
    value: "circle",
    label: "Connect a learning account",
    description: "Import selected courses from the workspace's own Circle account.",
  },
  {
    value: "paste",
    label: "Paste text",
    description: "Add a syllabus, transcript, guide, or FAQ.",
  },
  {
    value: "qa",
    label: "Questions and answers",
    description: "Author the questions learners ask most often.",
  },
];

function knowledgeStartLabel(value: KnowledgeStart): string {
  return knowledgeStarts.find((item) => item.value === value)?.label ?? "Add learning";
}

function knowledgeStartDestination(value: KnowledgeStart): string {
  if (value === "course" || value === "qa") {
    return "/app?panel=course&view=library&intent=create";
  }
  return `/app?panel=course&view=import&source=${encodeURIComponent(value)}`;
}

type IssuedClaim = {
  claimId: string;
  tenantId: string;
  slug: string;
  displayName: string;
  token: string | null;
  expiresAt: string | null;
  ownerEmail: string;
  ownerDisplayName: string;
  knowledgeStart: KnowledgeStart;
  invitationStatus: "sent" | "failed";
  invitationError: string | null;
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
  const requestedView = params.get("view");
  const panelView =
    selectedTenantId !== null
      ? "client"
      : requestedView === "add-client"
        ? "add-client"
        : requestedView === "billing"
          ? "billing"
          : requestedView === "settings"
            ? "settings"
            : "workspaces";

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
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState<
    "all" | "attention" | "paused"
  >("all");

  const [createOpen, setCreateOpen] = useState(false);
  const [createStep, setCreateStep] = useState(1);
  const [draft, setDraft] = useState<ClientDraft | null>(null);
  const [createKey, setCreateKey] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [takenSlug, setTakenSlug] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedClaim | null>(null);
  const [copied, setCopied] = useState(false);
  const [billingOverview, setBillingOverview] =
    useState<BillingOverview | null>(null);
  const [billingOverviewState, setBillingOverviewState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [billingOverviewError, setBillingOverviewError] = useState<
    string | null
  >(null);
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

  useEffect(() => {
    if (
      panelView !== "add-client" ||
      createOpen ||
      draft !== null ||
      issued !== null
    ) {
      return;
    }
    setDraft({
      displayName: "",
      slug: "",
      slugTouched: false,
      assistantName: "",
      primaryColor: normalizeHex(payload.agent.primaryColor) ?? neutralSeed,
      accentColor: normalizeHex(payload.agent.accentColor) ?? neutralSeed,
      region: "",
      plan: "unconfirmed",
      knowledgeStart: "course",
      ownerDisplayName: "",
      ownerEmail: "",
    });
    setCreateKey(platformOperationKey("platform-client"));
    setCreateStep(1);
    setCreateOpen(true);
    setCreateError(null);
    setTakenSlug(null);
  }, [
    createOpen,
    draft,
    issued,
    panelView,
    payload.agent.accentColor,
    payload.agent.primaryColor,
  ]);

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
    setBillingOverviewState("loading");
    void (async () => {
      try {
        const parsed = parseBillingOverview(await billingRead(""));
        if (!active) return;
        setBillingOverview(parsed);
        setBillingOverviewError(null);
        setBillingOverviewState("ready");
      } catch (error) {
        if (!active) return;
        setBillingOverview(null);
        setBillingOverviewError(describe(error));
        setBillingOverviewState("failed");
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
      openPanel("platform", { id: tenantId, view: "client" });
    },
    [openPanel],
  );

  const closeClient = useCallback(() => {
    setConfirmation(null);
    openPanel("platform", { id: null, view: "workspaces" });
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

  async function enterClient(
    tenantId: string,
    displayName: string,
    destination = "/app",
  ) {
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
      if (refreshed) {
        try {
          window.sessionStorage.setItem(
            "platform-client-preview",
            entry.tenantId,
          );
        } catch {
          // The durable session remains authoritative when storage is blocked.
        }
      }
      setNotice(
        refreshed
          ? `You are now operating inside ${entry.displayName}. This entry is audited.`
          : `${entry.displayName} was entered, but this browser session still carries the previous claims. Refresh the secure session to finish the switch.`,
      );
      await refresh();
      if (refreshed) window.location.assign(destination);
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
      try {
        window.sessionStorage.removeItem("platform-client-preview");
      } catch {
        // The durable exit remains authoritative when storage is blocked.
      }
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
      knowledgeStart: "course",
      ownerDisplayName: "",
      ownerEmail: "",
    });
    // One key per form session: a retry after a failure is the same request,
    // so it can never provision two workspaces.
    setCreateKey(platformOperationKey("platform-client"));
    setCreateStep(1);
    setCreateOpen(true);
    setCreateError(null);
    setTakenSlug(null);
    setIssued(null);
    setNotice(null);
    setActionError(null);
    openPanel("platform", { id: null, view: "add-client" });
  }

  function closeCreate() {
    setCreateOpen(false);
    setDraft(null);
    setCreateKey(null);
    setCreateError(null);
    setTakenSlug(null);
    setCreateStep(1);
    setIssued(null);
    setCopied(false);
    openPanel("platform", { id: null, view: "workspaces" });
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
    const ownerDisplayName = draft.ownerDisplayName.trim();
    const ownerEmail = draft.ownerEmail.trim().toLowerCase();
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
      const invitationBody = await platformWrite({
        action: "client.inviteOwner",
        tenantId: creation.tenantId,
        email: ownerEmail,
        displayName: ownerDisplayName,
        idempotencyKey: `${createKey}:owner-invitation`.slice(0, 200),
      });
      const invitation =
        invitationBody &&
        typeof invitationBody === "object" &&
        !Array.isArray(invitationBody)
          ? (invitationBody as Record<string, unknown>)
          : null;
      const invitationSent =
        invitation?.ok === true &&
        invitation.deliveryStatus === "sent";
      const invitationError =
        typeof invitation?.providerMessage === "string"
          ? invitation.providerMessage
          : typeof invitation?.code === "string"
            ? codeMessages[invitation.code] ??
              `The invitation provider failed (${invitation.code}).`
            : "The invitation provider did not confirm delivery.";

      setCreateOpen(false);
      setDraft(null);
      setCreateKey(null);
      setCreateError(null);
      setTakenSlug(null);
      setIssued({
        claimId: creation.claim?.claimId ?? "",
        tenantId: creation.tenantId,
        slug: creation.slug,
        displayName: creation.displayName,
        token,
        expiresAt: creation.claim?.expiresAt ?? null,
        ownerEmail,
        ownerDisplayName,
        knowledgeStart: draft.knowledgeStart,
        invitationStatus: invitationSent ? "sent" : "failed",
        invitationError: invitationSent ? null : invitationError,
      });
      setCopied(false);
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

  async function retryOwnerInvitation(result: IssuedClaim) {
    setCreateBusy(true);
    setActionError(null);
    try {
      const invitationBody = await platformWrite({
        action: "client.inviteOwner",
        tenantId: result.tenantId,
        email: result.ownerEmail,
        displayName: result.ownerDisplayName,
        idempotencyKey: platformOperationKey("owner-invitation"),
      });
      const invitation =
        invitationBody &&
        typeof invitationBody === "object" &&
        !Array.isArray(invitationBody)
          ? (invitationBody as Record<string, unknown>)
          : null;
      if (
        invitation?.ok !== true ||
        invitation.deliveryStatus !== "sent"
      ) {
        const message =
          typeof invitation?.providerMessage === "string"
            ? invitation.providerMessage
            : typeof invitation?.code === "string"
              ? codeMessages[invitation.code] ??
                `The invitation provider failed (${invitation.code}).`
              : "The invitation provider did not confirm delivery.";
        setIssued((current) =>
          current === null
            ? current
            : {
                ...current,
                invitationStatus: "failed",
                invitationError: message,
              },
        );
        return;
      }
      setIssued((current) =>
        current === null
          ? current
          : {
              ...current,
              token: null,
              invitationStatus: "sent",
              invitationError: null,
            },
      );
      await refresh();
    } catch (error) {
      setIssued((current) =>
        current === null
          ? current
          : {
              ...current,
              invitationStatus: "failed",
              invitationError: describe(error),
            },
      );
    } finally {
      setCreateBusy(false);
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
              Start preview
            </Button>
          </>
        }
        onClose={() => setConfirmation(null)}
        side="inline"
        title={`Preview ${target.displayName}?`}
      >
        <div className={styles.confirmBody}>
          <p className={styles.groupHint}>
            You are about to preview{" "}
            <strong>{target.displayName}</strong> — a client workspace that is
            not your own.
          </p>
          <ul className={styles.confirmList}>
            <li>Your session context switches to this client until you exit.</li>
            <li>The entry is recorded as an audited platform session.</li>
            <li>
              You remain yourself through a host-provisioned tenant-admin
              membership. No client user is impersonated.
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
            <div className={styles.sectionHead}>
              <p className={styles.groupHint}>
                A section that is off disappears from this client’s workspace
                for everyone in it. Changes apply immediately.
              </p>
              <Button
                disabled={entered || busy !== null}
                onClick={() =>
                  setConfirmation({
                    kind: "enter",
                    tenantId: client.tenant.tenantId,
                    displayName: client.tenant.displayName,
                  })
                }
                size="sm"
              >
                Preview client workspace
              </Button>
            </div>
            <div className={styles.switches}>
              {platformSectionKeys.map((sectionKey, index) => {
                const section = enabledByKey.get(sectionKey);
                const updated = formatWhen(section?.updatedAt);
                const copy = sectionCopy[sectionKey];
                const bordered = index < platformSectionKeys.length - 1;

                // The assistant is the one section every client workspace is
                // built around — there is no coherent state where a tenant
                // keeps its workspace but the assistant itself goes dark. This
                // row is locked rather than borrowed from the interactive
                // Toggle, so nobody can click something that was never really
                // optional.
                if (sectionKey === "agent") {
                  return (
                    <div
                      className={cx(
                        styles.lockedSwitch,
                        bordered && styles.lockedSwitchBordered,
                      )}
                      key={sectionKey}
                    >
                      <span className={styles.lockedSwitchCopy}>
                        <span className={styles.lockedSwitchLabelRow}>
                          <span className={styles.lockedSwitchLabel}>
                            {copy.label}
                          </span>
                          <span className={styles.lockedSwitchBadge}>
                            Always on
                          </span>
                        </span>
                        <span className={styles.lockedSwitchDescription}>
                          {copy.description} Every workspace needs its
                          assistant — it can’t be switched off from here.
                        </span>
                      </span>
                      <span
                        aria-hidden="true"
                        className={styles.lockedSwitchTrack}
                      >
                        <i />
                      </span>
                    </div>
                  );
                }

                return (
                  <Toggle
                    bordered={bordered}
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

          <section className={styles.detailGroup}>
            <h5 className={styles.groupTitle}>
              What the client can change themselves
            </h5>
            <p className={styles.groupHint}>
              A real permission surface the design calls for, but nothing has
              shipped to back it yet — every row below is disabled rather than
              pretending a click here would do anything.
            </p>
            <div className={styles.switches}>
              {clientCapabilities.map((item, index) => (
                <div
                  className={cx(
                    styles.lockedSwitch,
                    index < clientCapabilities.length - 1 &&
                      styles.lockedSwitchBordered,
                  )}
                  key={item.key}
                >
                  <span className={styles.lockedSwitchCopy}>
                    <span className={styles.lockedSwitchLabelRow}>
                      <span className={styles.lockedSwitchLabel}>
                        {item.label}
                      </span>
                      <span
                        className={cx(
                          styles.lockedSwitchBadge,
                          styles.lockedSwitchBadgeWarn,
                        )}
                      >
                        Not wired
                      </span>
                    </span>
                    <span className={styles.lockedSwitchDescription}>
                      {item.reason}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cx(
                      styles.lockedSwitchTrack,
                      styles.lockedSwitchTrackOff,
                    )}
                  >
                    <i />
                  </span>
                </div>
              ))}
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
    draft.ownerDisplayName.trim().length > 0 &&
    invitationEmailPattern.test(draft.ownerEmail.trim()) &&
    platformSlugPattern.test(trimmedSlug) &&
    slugError === undefined;
  const canContinueCreate =
    draft !== null &&
    (createStep === 1
      ? draft.displayName.trim().length > 0 &&
        platformSlugPattern.test(trimmedSlug) &&
        slugError === undefined
      : createStep === 2
        ? draft.assistantName.trim().length > 0
        : createStep === 4
          ? draft.ownerDisplayName.trim().length > 0 &&
            invitationEmailPattern.test(draft.ownerEmail.trim())
          : true);

  const createView =
    !createOpen || draft === null ? null : (
      <section className={styles.createCard} aria-label="Add a client">
        <header className={styles.createHeader}>
          <button
            aria-label="Back to workspaces"
            className={styles.createBack}
            disabled={createBusy}
            onClick={closeCreate}
            type="button"
          >
            ‹
          </button>
          <span className={styles.createHeaderTitle}>
            {draft.displayName.trim() || "Add a client"}
          </span>
          <span className={styles.createCount}>{createStep} of 4</span>
        </header>

        <div className={styles.createProgress} aria-hidden="true">
          {[1, 2, 3, 4].map((step) => (
            <i data-complete={step <= createStep || undefined} key={step} />
          ))}
        </div>

        <div className={styles.createBody}>
          {createStep === 1 ? (
            <>
              <p className={styles.createKicker}>Step 1 · Who</p>
              <h3 className={styles.createTitle}>Who is this for?</h3>
              <p className={styles.createDescription}>
                The name your client calls their programme.
              </p>
              <div className={styles.form}>
                <TextField
                  autoComplete="organization"
                  autoFocus
                  help="People inside the workspace see this name."
                  label="Client or programme name"
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
                  help="Permanent. Lowercase letters, numbers and hyphens."
                  label="Workspace address"
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
                <p className={styles.addressPreview}>
                  corso.app/{trimmedSlug || "workspace"}
                </p>
              </div>
            </>
          ) : null}

          {createStep === 2 ? (
            <>
              <p className={styles.createKicker}>Step 2 · The bot</p>
              <h3 className={styles.createTitle}>Name and colour it</h3>
              <p className={styles.createDescription}>
                This is what students see. The client can change it later.
              </p>
              <div className={styles.form}>
                <TextField
                  autoComplete="off"
                  autoFocus
                  help="What the assistant calls itself in this workspace."
                  label="Bot name"
                  onChange={(event) =>
                    updateDraft({ assistantName: event.target.value })
                  }
                  required
                  value={draft.assistantName}
                />
                <div className={styles.formRow}>
                  <ColorField
                    contrastAgainst={seededSurface}
                    contrastLabel="primary on the client surface"
                    help="Buttons and highlights."
                    label="Primary colour"
                    onChange={(hex) => updateDraft({ primaryColor: hex })}
                    value={draft.primaryColor}
                  />
                  <ColorField
                    contrastAgainst={seededSurface}
                    contrastLabel="accent on the client surface"
                    help="Secondary emphasis."
                    label="Accent colour"
                    onChange={(hex) => updateDraft({ accentColor: hex })}
                    value={draft.accentColor}
                  />
                </div>
              </div>
            </>
          ) : null}

          {createStep === 3 ? (
            <>
              <p className={styles.createKicker}>Step 3 · Knowledge</p>
              <h3 className={styles.createTitle}>Give it something to know</h3>
              <p className={styles.createDescription}>
                Choose the first real source to configure. The new workspace
                stays blank until you enter it and finish that source.
              </p>
              <div className={styles.knowledgeChoices}>
                {knowledgeStarts.map((item) => (
                  <label
                    className={styles.knowledgeChoice}
                    data-selected={draft.knowledgeStart === item.value || undefined}
                    key={item.value}
                  >
                    <input
                      checked={draft.knowledgeStart === item.value}
                      name="knowledgeStart"
                      onChange={() => updateDraft({ knowledgeStart: item.value })}
                      type="radio"
                      value={item.value}
                    />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </>
          ) : null}

          {createStep === 4 ? (
            <>
              <p className={styles.createKicker}>Step 4 · Owner</p>
              <h3 className={styles.createTitle}>Who owns this workspace?</h3>
              <p className={styles.createDescription}>
                This person receives a secure email invitation and chooses
                their own password.
              </p>
              <div className={styles.form}>
                <div className={styles.formRow}>
                  <TextField
                    autoComplete="name"
                    autoFocus
                    help="Shown inside the workspace."
                    label="Owner name"
                    onChange={(event) =>
                      updateDraft({ ownerDisplayName: event.target.value })
                    }
                    required
                    value={draft.ownerDisplayName}
                  />
                  <TextField
                    autoComplete="email"
                    help="Supabase sends the invitation to this address."
                    label="Owner email"
                    onChange={(event) =>
                      updateDraft({ ownerEmail: event.target.value })
                    }
                    required
                    type="email"
                    value={draft.ownerEmail}
                  />
                </div>
              </div>
              <dl className={styles.createReview}>
                <div>
                  <dt>Programme</dt>
                  <dd>{draft.displayName}</dd>
                </div>
                <div>
                  <dt>Address</dt>
                  <dd>corso.app/{trimmedSlug}</dd>
                </div>
                <div>
                  <dt>Bot</dt>
                  <dd>{draft.assistantName}</dd>
                </div>
                <div>
                  <dt>First source</dt>
                  <dd>{knowledgeStartLabel(draft.knowledgeStart)}</dd>
                </div>
                <div>
                  <dt>Owner</dt>
                  <dd>{draft.ownerEmail.trim() || "Not entered"}</dd>
                </div>
              </dl>
              <div className={styles.createInfo}>
                <strong>The workspace starts empty.</strong>
                <span>
                  No sample courses, files, sources or learner activity are
                  created. The owner adds the first learning material after
                  accepting the invitation.
                </span>
              </div>
            </>
          ) : null}

          {createError === null ? null : (
            <p className={styles.failure} role="alert">
              {createError}
            </p>
          )}
        </div>

        <footer className={styles.createFooter}>
          <Button
            disabled={createBusy}
            onClick={
              createStep === 1
                ? closeCreate
                : () => setCreateStep((step) => Math.max(1, step - 1))
            }
          >
            {createStep === 1 ? "Cancel" : "‹ Back"}
          </Button>
          {createStep < 4 ? (
            <div className={styles.createFooterRight}>
              {createStep === 3 ? (
                // Nothing on this step is actually required — the workspace
                // is created empty regardless of which source stays selected
                // (see the "workspace starts empty" notice on step 4). Skip
                // and Continue both just advance the step; Skip exists so
                // someone who doesn't want to engage with the picker isn't
                // made to feel like they have to.
                <Button
                  disabled={createBusy}
                  onClick={() => setCreateStep((step) => Math.min(4, step + 1))}
                >
                  Skip
                </Button>
              ) : null}
              <Button
                disabled={!canContinueCreate}
                onClick={() => setCreateStep((step) => Math.min(4, step + 1))}
                variant="primary"
              >
                Continue
              </Button>
            </div>
          ) : (
            <Button
              disabled={!canCreate}
              loading={createBusy}
              loadingLabel="Creating…"
              onClick={() => void createClient()}
              variant="primary"
            >
              Create workspace
            </Button>
          )}
        </footer>
      </section>
    );

  /* --- workspace creation result ---------------------------------------- */

  const issuedExpiry = issued === null ? null : formatWhen(issued.expiresAt);
  const issuedView =
    issued === null ? null : (
      <section className={styles.createdCard} role="status">
        <span aria-hidden="true" className={styles.createdCheck}>
          ✓
        </span>
        <p className={styles.createKicker}>Workspace created</p>
        <h3 className={styles.createdTitle}>
          {issued.displayName} is ready
        </h3>
        <p className={styles.createdCopy}>
          {issued.invitationStatus === "sent"
            ? `A secure owner invitation was sent to ${issued.ownerEmail}. The workspace contains no sample learning content.`
            : `The workspace was created, but the invitation provider did not confirm delivery to ${issued.ownerEmail}.`}
        </p>
        {issued.invitationStatus === "sent" ? (
          <p className={styles.issuedNote}>
            The durable invitation is pending until the owner chooses a
            password. No temporary password or owner code needs to be shared.
          </p>
        ) : (
          <>
            <p className={styles.failure} role="alert">
              {issued.invitationError}
            </p>
            <Button
              loading={createBusy}
              loadingLabel="Retrying…"
              onClick={() => void retryOwnerInvitation(issued)}
            >
              Retry invitation
            </Button>
            {issued.token === null ? (
              <p className={styles.issuedNote}>
                The one-time recovery code is not recoverable from this replay.
                Retry email delivery here.
              </p>
            ) : (
              <>
                <p className={styles.issuedNote}>
                  Recovery only: deliver this single-use owner code over a
                  trusted channel if email cannot be restored.
                  {issuedExpiry === null
                    ? ""
                    : ` It expires ${issuedExpiry}.`}
                </p>
                <div className={styles.tokenRow}>
                  <code className={styles.token}>{issued.token}</code>
                  <Button
                    onClick={() => void copyToken(issued.token as string)}
                    size="sm"
                  >
                    {copied ? "Copied" : "Copy recovery code"}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
        <div className={styles.issuedActions}>
          <Button
            loading={busy?.kind === "enter"}
            loadingLabel="Entering…"
            onClick={() =>
              void enterClient(
                issued.tenantId,
                issued.displayName,
                knowledgeStartDestination(issued.knowledgeStart),
              )
            }
            variant="primary"
          >
            Enter workspace and add source
          </Button>
          <Button
            onClick={() => {
              setIssued(null);
              setCopied(false);
              openClient(issued.tenantId);
            }}
          >
            Client controls
          </Button>
          <Button onClick={closeCreate}>All clients</Button>
        </div>
      </section>
    );

  /* --- render ---------------------------------------------------------- */

  const clientCard = (tenant: PlatformTenantSummary) => {
    const entered = session?.tenantId === tenant.tenantId;
    const updated = formatWhen(tenant.updatedAt);
    const paused = tenant.status === "suspended";
    const attention = needsWorkspaceAttention(tenant);
    const review = needsWorkspaceReview(tenant);
    const state = paused
      ? "paused"
      : review
        ? "review"
        : attention
          ? "setup"
          : "live";
    const stateLabel = paused
      ? "Paused"
      : review
        ? "Review"
        : attention
          ? "Setup"
          : "Live";
    const summary = paused
      ? "The workspace is suspended. Its content is retained."
      : tenant.publishedCourses === 0
        ? "No published course yet."
        : tenant.knowledgeChunks === 0
          ? `${tenant.publishedCourses.toLocaleString()} published ${
              tenant.publishedCourses === 1 ? "course" : "courses"
            } · no grounded knowledge yet.`
          : `${tenant.publishedCourses.toLocaleString()} published ${
              tenant.publishedCourses === 1 ? "course" : "courses"
            } · ${tenant.members.toLocaleString()} active ${
              tenant.members === 1 ? "person" : "people"
            }.`;
    return (
      <article
        className={styles.client}
        data-entered={entered ? "true" : undefined}
        data-review={review ? "true" : undefined}
        data-status={tenant.status}
        key={tenant.tenantId}
      >
        <div className={styles.clientHead}>
          <span
            className={styles.clientMonogram}
            data-live={state === "live" || undefined}
          >
            {tenantInitials(tenant.displayName)}
          </span>
          <div>
            <h5 className={styles.clientName}>{tenant.displayName}</h5>
            <p className={styles.meta}>
              {tenant.assistantName || "Not named yet"}
            </p>
          </div>
          <span className={styles.workspaceState} data-state={state}>
            <i aria-hidden="true" />
            {stateLabel}
          </span>
        </div>

        {entered ? (
          <span className={styles.insideTag}>You are inside</span>
        ) : null}

        <p className={styles.clientSummary}>{summary}</p>

        <div className={styles.clientFoot}>
          <span className={styles.meta}>
            {updated === null ? "No recorded activity" : `Active ${updated}`}
          </span>
          <button
            className={styles.openClient}
            onClick={() => openClient(tenant.tenantId)}
            type="button"
          >
            {attention && !paused ? "Finish setup" : "Open"} ›
          </button>
        </div>
      </article>
    );
  };

  const attentionCount =
    overview?.tenants.filter(
      (tenant) => needsWorkspaceAttention(tenant) || needsWorkspaceReview(tenant),
    ).length ?? 0;
  const visibleTenants =
    overview?.tenants.filter((tenant) => {
      const query = workspaceQuery.trim().toLocaleLowerCase();
      const matchesQuery =
        query.length === 0 ||
        tenant.displayName.toLocaleLowerCase().includes(query) ||
        tenant.assistantName.toLocaleLowerCase().includes(query) ||
        tenant.slug.toLocaleLowerCase().includes(query);
      const matchesFilter =
        workspaceFilter === "all" ||
        (workspaceFilter === "paused"
          ? tenant.status === "suspended"
          : needsWorkspaceAttention(tenant) || needsWorkspaceReview(tenant));
      return matchesQuery && matchesFilter;
    }) ?? [];

  return (
    <div className={styles.root} data-view={panelView}>
      {bar}

      {session !== null && panelView !== "add-client" ? (
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

      {panelView === "billing" ? (
        <section className={styles.platformPage}>
          <div className={styles.intro}>
            <div className={styles.introCopy}>
              <h3 className={styles.title}>Billing</h3>
              <p className={styles.lede}>
                Durable provider cost, billed usage, subscriptions and budget
                position across every client workspace.
              </p>
            </div>
            <Button onClick={() => openPanel("platform", { view: "workspaces" })}>
              Workspaces
            </Button>
          </div>
          {billingOverviewState === "loading" ? (
            <p className={styles.loading} role="status">
              Loading billing from the control plane…
            </p>
          ) : billingOverviewState === "failed" ||
            billingOverview === null ? (
            <p className={styles.failure} role="alert">
              {billingOverviewError ?? "Billing could not be loaded."}
            </p>
          ) : (
            <>
              <div className={styles.billingTotals}>
                <article>
                  <span>Provider cost</span>
                  <strong>
                    {formatMoney(
                      billingOverview.totals.windowTrueCostMicro,
                      "USD",
                    )}
                  </strong>
                  <small>Last {billingOverview.windowDays} days</small>
                </article>
                <article>
                  <span>Billed usage</span>
                  <strong>
                    {formatMoney(
                      billingOverview.totals.windowBilledMicro,
                      "USD",
                    )}
                  </strong>
                  <small>Durable metered amount</small>
                </article>
                <article>
                  <span>Awaiting report</span>
                  <strong>
                    {formatMoney(
                      billingOverview.totals.windowUnreportedMicro,
                      "USD",
                    )}
                  </strong>
                  <small>Not yet sent to Stripe</small>
                </article>
              </div>
              <div className={styles.billingTenants}>
                {billingOverview.tenants.map((tenant) => (
                  <article key={tenant.tenantId}>
                    <div>
                      <b>{tenant.displayName}</b>
                      <span>
                        {tenant.plan.replaceAll("_", " ")} ·{" "}
                        {tenant.subscriptionStatus.replaceAll("_", " ")}
                      </span>
                    </div>
                    <strong>
                      {formatMoney(
                        tenant.windowBilledMicro,
                        tenant.currency,
                      )}
                    </strong>
                    <button
                      onClick={() => openClient(tenant.tenantId)}
                      type="button"
                    >
                      Open ›
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      ) : panelView === "settings" ? (
        <section className={styles.platformPage}>
          <div className={styles.intro}>
            <div className={styles.introCopy}>
              <h3 className={styles.title}>Platform settings</h3>
              <p className={styles.lede}>
                The launch boundaries that apply before any client workspace
                receives learning or access.
              </p>
            </div>
            <Button onClick={() => openPanel("platform", { view: "workspaces" })}>
              Workspaces
            </Button>
          </div>
          <div className={styles.platformPolicies}>
            <article>
              <span>New workspace content</span>
              <strong>Empty by default</strong>
              <p>
                No courses, sources, assistants answers or Estie data are
                copied into a new tenant.
              </p>
            </article>
            <article>
              <span>Owner access</span>
              <strong>Verified invitation</strong>
              <p>
                Owners receive a time-limited email and create their own
                password before membership activates.
              </p>
            </article>
            <article>
              <span>Tenant boundary</span>
              <strong>Database enforced</strong>
              <p>
                Learning, analytics, signals, credentials and media remain
                scoped to the selected tenant.
              </p>
            </article>
          </div>
        </section>
      ) : panelView === "add-client" ? (
        <div className={styles.createPage}>
          <div className={styles.createPageIntro}>
            <p className={styles.eyebrow}>Platform owner</p>
            <h3 className={styles.title}>Add a client</h3>
            <p className={styles.lede}>
              Four clear steps. Advanced controls stay inside the workspace
              after creation.
            </p>
          </div>
          {issuedView ?? createView}
        </div>
      ) : (
        <>
          {panelView === "workspaces" ? (
            <section className={styles.intro}>
              <div className={styles.introCopy}>
                <h3 className={styles.title}>Workspaces</h3>
                <p className={styles.lede}>
                  {overview === null
                    ? "Loading workspaces…"
                    : `${overview.totals.tenants.toLocaleString()} ${
                        overview.totals.tenants === 1
                          ? "workspace"
                          : "workspaces"
                      }. ${
                        attentionCount === 0
                          ? "Everything is ready."
                          : `${attentionCount.toLocaleString()} ${
                              attentionCount === 1 ? "wants" : "want"
                            } your attention.`
                      }`}
                </p>
              </div>
              <div className={styles.introActions}>
                <Button
                  disabled={busy !== null || createOpen}
                  onClick={openCreate}
                  variant="primary"
                >
                  <span aria-hidden="true">＋</span>
                  Add a client
                </Button>
              </div>
            </section>
          ) : null}

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
            panelView === "workspaces" ? (
            <>
              <div className={styles.workspaceTools}>
                <label className={styles.workspaceSearch}>
                  <CorsoIcon name="search" size={15} />
                  <span className={styles.srOnly}>Search workspaces</span>
                  <input
                    onChange={(event) =>
                      setWorkspaceQuery(event.target.value)
                    }
                    placeholder="Search"
                    type="search"
                    value={workspaceQuery}
                  />
                </label>
                <div
                  aria-label="Filter workspaces"
                  className={styles.workspaceFilters}
                  role="group"
                >
                  {(
                    [
                      ["all", "All"],
                      ["attention", "Needs attention"],
                      ["paused", "Paused"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      aria-pressed={workspaceFilter === value}
                      key={value}
                      onClick={() => setWorkspaceFilter(value)}
                      type="button"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <section aria-label="Client workspaces">
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
                ) : visibleTenants.length === 0 ? (
                  <EmptyState
                    action={
                      <Button
                        onClick={() => {
                          setWorkspaceFilter("all");
                          setWorkspaceQuery("");
                        }}
                      >
                        Clear filters
                      </Button>
                    }
                    compact
                    description="Try another name or show all workspace states."
                    headline="No matching workspaces"
                  />
                ) : (
                  <div className={styles.clients}>
                    {visibleTenants.map(clientCard)}
                    {workspaceFilter === "all" &&
                    workspaceQuery.trim().length === 0 ? (
                      <button
                        className={styles.addClientCard}
                        onClick={openCreate}
                        type="button"
                      >
                        <span aria-hidden="true">+</span>
                        <strong>Add a client</strong>
                        <small>
                          Workspace, bot and owner invitation in about two
                          minutes.
                        </small>
                      </button>
                    ) : null}
                  </div>
                )}
              </section>
            </>
          ) : (
            renderDetail()
            )
          ) : null}
        </>
      )}

      {panelView === "client" ? (
        <section className={styles.boundary}>
          <strong>Operational control without surveillance.</strong>
          <span>
            This view carries counts, statuses, timestamps and section flags
            only. Prompt text, conversation content, learning-source bodies,
            exports and credentials never cross into it.
          </span>
        </section>
      ) : null}
    </div>
  );
}

export default PlatformPanel;
