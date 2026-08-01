"use client";

import { useCallback, useEffect, useState, type MouseEvent } from "react";
import type {
  ExportFormat,
  TenantDataPolicy,
  TenantPlanUsage,
} from "../../lib/settings/tenant-settings-rpc";
import type { PanelProps } from "../app-shell/contract";
import { usePanelRouter } from "../app-shell/use-panel-router";
import { Button } from "../ui/button";
import { SelectField, TextField } from "../ui/field";
import styles from "./settings-detail.module.css";

function friendly(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (character) => character.toUpperCase());
}

function errorMessage(code: unknown) {
  if (code === "access_denied") return "Only workspace owners and admins can use this setting.";
  if (code === "version_conflict") {
    return "These settings changed in another session. Reload and try again.";
  }
  if (code === "exports_disabled") return "Data exports are disabled for this workspace.";
  if (code === "authentication_required") return "Sign in again to continue.";
  return "This setting could not be loaded. Please try again.";
}

function BackToSettings() {
  const { openPanel, panelHref } = usePanelRouter();

  function follow(event: MouseEvent<HTMLAnchorElement>) {
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
    openPanel("settings");
  }

  return (
    <a className={styles.back} href={panelHref("settings")} onClick={follow}>
      <span aria-hidden="true">←</span>
      Settings
    </a>
  );
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return { ok: false, code: "request_failed" };
  }
}

function LoadingDetail(props: { eyebrow: string; title: string; copy: string }) {
  return (
    <div className={styles.detail}>
      <BackToSettings />
      <header className={styles.header}>
        <span className={styles.eyebrow}>{props.eyebrow}</span>
        <h2>{props.title}</h2>
        <p>{props.copy}</p>
      </header>
      <div aria-label="Loading settings" className={styles.skeleton} />
    </div>
  );
}

function FailureDetail(props: {
  eyebrow: string;
  title: string;
  copy: string;
  message: string;
  retry(): void;
}) {
  return (
    <div className={styles.detail}>
      <BackToSettings />
      <header className={styles.header}>
        <span className={styles.eyebrow}>{props.eyebrow}</span>
        <h2>{props.title}</h2>
        <p>{props.copy}</p>
      </header>
      <section className={`${styles.card} ${styles.wide}`}>
        <div className={styles.cardHeader}>
          <h3>Settings unavailable</h3>
          <p>{props.message}</p>
        </div>
        <div className={styles.actions}>
          <Button onClick={props.retry} variant="primary">
            Try again
          </Button>
        </div>
      </section>
    </div>
  );
}

export function PlanUsageSettings() {
  const [usage, setUsage] = useState<TenantPlanUsage | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void fetch("/api/settings/plan-usage", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok || body.ok !== true) {
          throw new Error(
            typeof body.code === "string" ? body.code : "request_failed",
          );
        }
        setUsage(body as TenantPlanUsage);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(errorMessage(error instanceof Error ? error.message : null));
      });
    return () => controller.abort();
  }, [requestVersion]);

  if (usage === null && failure === null) {
    return (
      <LoadingDetail
        copy="Your workspace plan, current billed usage and configured operating safeguards."
        eyebrow="Workspace"
        title="Plan & usage"
      />
    );
  }

  if (usage === null) {
    return (
      <FailureDetail
        copy="Your workspace plan, current billed usage and configured operating safeguards."
        eyebrow="Workspace"
        message={failure ?? "This setting could not be loaded."}
        retry={() => setRequestVersion((version) => version + 1)}
        title="Plan & usage"
      />
    );
  }

  const money = (micro: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: usage.currency,
      maximumFractionDigits: 2,
    }).format(micro / usage.microUnitsPerMajorUnit);
  const statusTone =
    usage.dunningStage === "dark"
      ? "danger"
      : usage.dunningStage === "grace"
        ? "warning"
        : undefined;

  return (
    <div className={styles.detail}>
      <BackToSettings />
      <header className={styles.header}>
        <span className={styles.eyebrow}>Workspace</span>
        <h2>Plan & usage</h2>
        <p>
          Live plan status, billed usage and the operating safeguards configured
          for this workspace.
        </p>
      </header>

      {usage.message ? (
        <div className={styles.notice}>
          <strong>Billing attention needed</strong>
          <p>{usage.message}</p>
        </div>
      ) : null}

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.planTitleRow}>
              <h3>{friendly(usage.plan)} plan</h3>
              {/*
               * TASK B / "Change plan": Stripe hosted Checkout exists
               * (lib/billing/stripe.ts createCheckoutSession) but the only
               * route that calls it — POST /api/billing action
               * "checkout.create" — requires isPlatformAdmin(supabase) and
               * is meant for a platform operator changing SOMEONE ELSE'S
               * tenant, not this workspace's own owner/admin changing their
               * own plan. There is no tenant-scoped checkout route in this
               * repo today, so this stays disabled rather than pointing a
               * tenant_owner at a route that will 403 them.
               */}
              <Button disabled variant="secondary">
                Change plan
              </Button>
            </div>
            <div className={styles.statusLine}>
              <span className={styles.pill} data-tone={statusTone}>
                {friendly(usage.subscriptionStatus)}
              </span>
              {usage.cancelAtPeriodEnd ? (
                <span className={styles.pill} data-tone="warning">
                  Ends this period
                </span>
              ) : null}
            </div>
          </div>
          <p>
            {usage.currentPeriodEnd
              ? `Current period ends ${new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                }).format(new Date(usage.currentPeriodEnd))}.`
              : "No billing period end is currently recorded."}
          </p>
          <p className={styles.finePrint}>
            Changing a plan is a platform-admin action today — ask a platform
            administrator, or wait until a self-serve checkout is wired up
            for workspace owners.
          </p>
          <div>
            <p className={styles.sectionLabel}>Enabled sections</p>
            <div className={styles.sectionPills}>
              {usage.enabledSections.map((section) => (
                <span className={styles.pill} key={section}>
                  {friendly(section)}
                </span>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3>Current usage</h3>
            <p>Tenant-safe billed totals and operation counts.</p>
          </div>
          {/*
           * TASK B usage bar: the mockup shows progress toward a monthly
           * question quota this platform does not track (no per-plan
           * monthly call cap exists — `limits.maxCallsPerDay` is a daily
           * count, not monthly). What IS real and durable is the monthly
           * dollar safeguard, so the bar tracks spend against that instead
           * of inventing a question cap. It only renders once a safeguard
           * is actually configured.
           */}
          {usage.limits.monthlyBudgetMicro !== null ? (
            <div className={styles.usageBar}>
              <div className={styles.usageBarHead}>
                <span>
                  {money(usage.monthToDateBilledMicro)} of{" "}
                  {money(usage.limits.monthlyBudgetMicro)} monthly safeguard
                </span>
                <span>
                  {usage.limits.monthlyBudgetMicro > 0
                    ? `${Math.min(
                        100,
                        Math.round(
                          (usage.monthToDateBilledMicro /
                            usage.limits.monthlyBudgetMicro) *
                            100,
                        ),
                      )}%`
                    : "—"}
                </span>
              </div>
              <div className={styles.usageBarTrack}>
                <i
                  style={{
                    width: `${
                      usage.limits.monthlyBudgetMicro > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (usage.monthToDateBilledMicro /
                                usage.limits.monthlyBudgetMicro) *
                                100,
                            ),
                          )
                        : usage.monthToDateBilledMicro > 0
                          ? 100
                          : 0
                    }%`,
                  }}
                />
              </div>
            </div>
          ) : (
            <p className={styles.finePrint}>
              No monthly budget safeguard is configured for this workspace, so
              there is nothing to show a usage bar against.
            </p>
          )}
          <div className={styles.metricGrid}>
            <div className={styles.metric}>
              <span>Billed today</span>
              <strong>{money(usage.dayToDateBilledMicro)}</strong>
            </div>
            <div className={styles.metric}>
              <span>Billed this month</span>
              <strong>{money(usage.monthToDateBilledMicro)}</strong>
            </div>
            <div className={styles.metric}>
              <span>Operations today</span>
              <strong>{usage.callsToday.toLocaleString()}</strong>
            </div>
            <div className={styles.metric}>
              <span>Operations this month</span>
              <strong>{usage.callsThisMonth.toLocaleString()}</strong>
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3>Billing</h3>
            <p>
              Managed through Stripe&rsquo;s hosted Checkout and Billing
              Portal — this product never collects a card number itself.
            </p>
          </div>
          {/*
           * TASK B / "Payment method" and "Invoices": both live inside
           * Stripe's hosted Billing Portal (createBillingPortalSession in
           * lib/billing/stripe.ts), which already exists — but again only
           * behind the platform-admin-only POST /api/billing route, and
           * `tenant_get_billing_summary` (this page's own data source) never
           * returns a Stripe customer id to the tenant. Needs: a
           * tenant-scoped portal route that resolves the caller's OWN
           * tenant_id from their session (never a client-supplied id) and
           * checks tenant_owner/tenant_admin instead of isPlatformAdmin.
           * Until that exists, these stay disabled rather than linking
           * tenant staff into a 403.
           */}
          <div className={styles.billingRow}>
            <span className={styles.billingCopy}>
              <strong>Payment method</strong>
              <small>Opens Stripe&rsquo;s Billing Portal once this workspace has a route into it.</small>
            </span>
            <Button disabled variant="secondary">
              Manage
            </Button>
          </div>
          <div className={styles.billingRow}>
            <span className={styles.billingCopy}>
              <strong>Invoices</strong>
              <small>The same Billing Portal session lists these — same missing route.</small>
            </span>
            <Button disabled variant="secondary">
              View
            </Button>
          </div>
        </section>

        <section className={`${styles.card} ${styles.wide}`}>
          <div className={styles.cardHeader}>
            <h3>Operating safeguards</h3>
            <p>
              Limits configured by the platform for this workspace. Financial
              safeguards are not compared with billed totals because they
              measure a different internal operating basis.
            </p>
          </div>
          <div className={styles.metricGrid}>
            <div className={styles.metric}>
              <span>Daily safeguard</span>
              <strong>
                {usage.limits.dailyBudgetMicro === null
                  ? "Not configured"
                  : money(usage.limits.dailyBudgetMicro)}
              </strong>
            </div>
            <div className={styles.metric}>
              <span>Monthly safeguard</span>
              <strong>
                {usage.limits.monthlyBudgetMicro === null
                  ? "Not configured"
                  : money(usage.limits.monthlyBudgetMicro)}
              </strong>
            </div>
            <div className={styles.metric}>
              <span>Operations per day</span>
              <strong>
                {usage.limits.maxCallsPerDay?.toLocaleString() ?? "Not configured"}
              </strong>
            </div>
            <div className={styles.metric}>
              <span>Operations per minute</span>
              <strong>
                {usage.limits.maxCallsPerMinute?.toLocaleString() ??
                  "Not configured"}
              </strong>
            </div>
          </div>
          <p className={styles.finePrint}>
            Usage is generated from durable billing and operation ledgers.
            Provider cost and platform margin are never exposed in this view.
          </p>
        </section>
      </div>
    </div>
  );
}

export function PrivacyDataSettings({ refresh }: Pick<PanelProps, "refresh">) {
  const [policy, setPolicy] = useState<TenantDataPolicy | null>(null);
  const [retentionDays, setRetentionDays] = useState("365");
  const [exportsEnabled, setExportsEnabled] = useState(true);
  const [defaultFormat, setDefaultFormat] = useState<ExportFormat>("json");
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  const load = useCallback(() => {
    const controller = new AbortController();
    setFailure(null);
    void fetch("/api/settings/data-policy", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await readJson(response);
        if (!response.ok || body.ok !== true) {
          throw new Error(
            typeof body.code === "string" ? body.code : "request_failed",
          );
        }
        const next = body as TenantDataPolicy;
        setPolicy(next);
        setRetentionDays(String(next.retentionDays));
        setExportsEnabled(next.exportsEnabled);
        setDefaultFormat(next.defaultExportFormat);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFailure(errorMessage(error instanceof Error ? error.message : null));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => load(), [load, requestVersion]);

  async function save() {
    if (!policy) return;
    const retention = Number(retentionDays);
    if (!Number.isInteger(retention) || retention < 30 || retention > 3650) {
      setFailure("Choose a retention period between 30 and 3,650 days.");
      return;
    }
    setSaving(true);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/data-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          retentionDays: retention,
          exportsEnabled,
          defaultExportFormat: defaultFormat,
          expectedVersion: policy.recordVersion,
        }),
      });
      const body = await readJson(response);
      if (!response.ok || body.ok !== true) {
        throw new Error(
          typeof body.code === "string" ? body.code : "request_failed",
        );
      }
      const next = body as TenantDataPolicy;
      setPolicy(next);
      setRetentionDays(String(next.retentionDays));
      setNotice("Privacy settings saved.");
      await refresh();
    } catch (error) {
      setFailure(errorMessage(error instanceof Error ? error.message : null));
    } finally {
      setSaving(false);
    }
  }

  async function download(format: ExportFormat) {
    setExporting(format);
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch("/api/settings/data-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });
      if (!response.ok) {
        const body = await readJson(response);
        throw new Error(
          typeof body.code === "string" ? body.code : "request_failed",
        );
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      const disposition = response.headers.get("Content-Disposition");
      const match = disposition?.match(/filename="([^"]+)"/u);
      anchor.href = url;
      anchor.download = match?.[1] ?? `workspace-data-export.${format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      const truncated = response.headers.get("X-Export-Truncated") === "true";
      setNotice(
        truncated
          ? "Export downloaded. The snapshot reached the 10,000-record limit."
          : "Export downloaded.",
      );
    } catch (error) {
      setFailure(errorMessage(error instanceof Error ? error.message : null));
    } finally {
      setExporting(null);
    }
  }

  if (policy === null && failure === null) {
    return (
      <LoadingDetail
        copy="Control the workspace retention target and create audited, tenant-scoped data exports."
        eyebrow="Workspace"
        title="Privacy & data"
      />
    );
  }

  if (policy === null) {
    return (
      <FailureDetail
        copy="Control the workspace retention target and create audited, tenant-scoped data exports."
        eyebrow="Workspace"
        message={failure ?? "This setting could not be loaded."}
        retry={() => setRequestVersion((version) => version + 1)}
        title="Privacy & data"
      />
    );
  }

  return (
    <div className={styles.detail}>
      <BackToSettings />
      <header className={styles.header}>
        <span className={styles.eyebrow}>Workspace</span>
        <h2>Privacy & data</h2>
        <p>
          Set a durable retention target and download a tenant-scoped snapshot.
          Every policy change and export is written to the audit ledger.
        </p>
      </header>

      <div className={styles.grid}>
        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3>Retention policy</h3>
            <p>
              The target used by workspace retention operations. Saving this
              policy does not immediately delete data.
            </p>
          </div>
          <div className={styles.form}>
            <TextField
              help="Between 30 days and 10 years."
              label="Retention period in days"
              max={3650}
              min={30}
              onChange={(event) => setRetentionDays(event.target.value)}
              step={1}
              type="number"
              value={retentionDays}
            />
            <SelectField
              label="Default export format"
              onChange={(event) =>
                setDefaultFormat(event.target.value as ExportFormat)
              }
              options={[
                { value: "json", label: "JSON" },
                { value: "csv", label: "CSV" },
              ]}
              value={defaultFormat}
            />
            <div className={styles.switchRow}>
              <span className={styles.switchCopy}>
                <strong>Allow workspace exports</strong>
                <small>
                  Owners and admins can download the bounded snapshot below.
                </small>
              </span>
              <label className={styles.switch}>
                <input
                  aria-label="Allow workspace exports"
                  checked={exportsEnabled}
                  onChange={(event) => setExportsEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span aria-hidden="true" />
              </label>
            </div>
            <div className={styles.actions}>
              <Button
                loading={saving}
                loadingLabel="Saving…"
                onClick={save}
                variant="primary"
              >
                Save policy
              </Button>
            </div>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <h3>Export workspace data</h3>
            <p>
              Includes workspace, membership, course, progress, conversation
              and usage-event records. Credentials, storage keys and provider
              accounting are excluded.
            </p>
          </div>
          <div className={styles.actions}>
            <Button
              disabled={!exportsEnabled || exporting !== null}
              loading={exporting === "json"}
              loadingLabel="Preparing JSON…"
              onClick={() => download("json")}
              variant={defaultFormat === "json" ? "primary" : "secondary"}
            >
              Download JSON
            </Button>
            <Button
              disabled={!exportsEnabled || exporting !== null}
              loading={exporting === "csv"}
              loadingLabel="Preparing CSV…"
              onClick={() => download("csv")}
              variant={defaultFormat === "csv" ? "primary" : "secondary"}
            >
              Download CSV
            </Button>
          </div>
          {!exportsEnabled ? (
            <p className={styles.status}>
              Save the policy with workspace exports enabled to download data.
            </p>
          ) : null}
          <p className={styles.finePrint}>
            Exports are capped at 10,000 records and clearly marked if
            truncated. There is no destructive purge control on this page.
          </p>
        </section>
      </div>

      {failure ? (
        <p className={styles.status} data-tone="error" role="alert">
          {failure}
        </p>
      ) : null}
      {notice ? (
        <p className={styles.status} data-tone="success" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
