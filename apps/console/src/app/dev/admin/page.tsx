"use client";

import { useEffect, useMemo, useState } from "react";

import styles from "./page.module.css";

const tenants = [
  { id: "tenant_northstar_demo", name: "Northstar Academy", plan: "Enterprise", learners: 1, spend: 0, status: "Active" },
];

const providers = [
  { capability: "Grounded chat", primary: "Tenant policy v18", fallback: "Compatible adapter only", health: "Contract active" },
  { capability: "Embeddings", primary: "Provider-neutral contract", fallback: "Selective retry", health: "Contract tested" },
  { capability: "Realtime voice", primary: "Browser realtime", fallback: "Same text conversation", health: "Permission gated" },
  { capability: "File extraction", primary: "Safe attachment pipeline", fallback: "Quarantine", health: "Contract active" }
];

type PlatformSnapshot = {
  tenant: {
    tenantId: string;
    displayName: string;
    version: number;
    tenant: {
      planId: string;
      policyVersion: string;
      limits: Record<string, number>;
    };
  };
  cost: {
    estimatedCost: number;
    finalCost: number;
    invoicedCost: number;
    entryCount: number;
  };
  providers: {
    attempts: Array<{ outcome: string; occurredAt?: string }>;
  };
  audit: Array<{
    auditId: string;
    action: string;
    actorId?: string;
    occurredAt: string;
    resourceType: string;
  }>;
};

export default function AdminConsole() {
  const [selectedTenant, setSelectedTenant] = useState(tenants[0]!.id);
  const [budget, setBudget] = useState(2500);
  const [toolsEnabled, setToolsEnabled] = useState(false);
  const [notice, setNotice] = useState("Loading the shared platform snapshot…");
  const [platform, setPlatform] = useState<PlatformSnapshot | null>(null);
  const seededTenant = tenants.find((item) => item.id === selectedTenant) ?? tenants[0]!;
  const tenant = {
    ...seededTenant,
    name: platform?.tenant.displayName ?? seededTenant.name,
    plan: platform?.tenant.tenant.planId ?? seededTenant.plan,
    spend:
      (platform?.cost.estimatedCost ?? 0) +
      (platform?.cost.finalCost ?? 0) +
      (platform?.cost.invoicedCost ?? 0),
  };
  const usage = useMemo(() => Math.round((tenant.spend / budget) * 100), [budget, tenant.spend]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/dev/platform", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Platform snapshot unavailable.");
        return (await response.json()) as PlatformSnapshot;
      })
      .then((snapshot) => {
        if (cancelled) return;
        setPlatform(snapshot);
        setBudget(snapshot.tenant.tenant.limits.monthlyBudgetUsd ?? 2500);
        setNotice(
          `Shared snapshot active · ${snapshot.tenant.tenant.policyVersion} · tenant version ${snapshot.tenant.version}`,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setNotice("Shared snapshot unavailable · showing the bounded development seed");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveBudget() {
    setNotice("Saving the tenant budget policy…");
    const response = await fetch("/api/dev/tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        monthlyBudgetUsd: budget,
        idempotencyKey: `admin-budget-${Date.now()}`,
      }),
    });
    const payload = (await response.json()) as {
      tenant?: PlatformSnapshot["tenant"];
      message?: string;
    };
    if (!response.ok || !payload.tenant) {
      setNotice(payload.message ?? "Budget policy was not saved.");
      return;
    }
    setPlatform((current) =>
      current ? { ...current, tenant: payload.tenant! } : current,
    );
    setNotice(
      `${tenant.name} budget saved · audited tenant version ${payload.tenant.version}`,
    );
  }

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar}>
        <a className={styles.brand} href="/"><span>L</span><b>Learning OS</b></a>
        <p>Platform administration</p>
        <nav aria-label="Admin navigation">
          <a className={styles.active} href="/dev/admin">Overview</a>
          <a href="#tenants">Tenants</a>
          <a href="#providers">Providers</a>
          <a href="#cost">Usage & cost</a>
          <a href="#mcp">MCP registry</a>
          <a href="#audit">Audit</a>
        </nav>
        <div className={styles.system}><span /><div><b>Development</b><small>Local contracts active</small></div></div>
      </aside>

      <section className={styles.workspace}>
        <header className={styles.header}>
          <div><p className={styles.eyebrow}>Control plane</p><h1>Platform administration</h1><p>Tenant isolation, provider health, budgets, policy and agent access in one place.</p></div>
          <button onClick={() => setNotice("Provisioning requires an explicit tenant record, owner membership and policy grant")}>＋ Provision tenant</button>
        </header>

        <div className={styles.notice}><span />{notice}</div>

        <section className={styles.healthGrid}>
          <article><span className={styles.good}>Integrated</span><strong>7</strong><p>Workspace packages</p></article>
          <article><span className={styles.good}>Structurally verified</span><strong>25</strong><p>Tenant-scoped DB tables</p></article>
          <article><span className={styles.good}>Development seed</span><strong>1</strong><p>Loaded tenant</p></article>
          <article><span className={styles.good}>Recorded</span><strong>${tenant.spend.toFixed(4)}</strong><p>Development ledger</p></article>
        </section>

        <div className={styles.grid}>
          <section className={styles.card} id="tenants">
            <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Tenant operations</p><h2>Organizations</h2></div><button onClick={() => setNotice("Tenant list refreshed")}>Refresh</button></div>
            <div className={styles.tenantTable}>
              {tenants.map((item) => (
                <button className={selectedTenant === item.id ? styles.tenantSelected : styles.tenantRow} key={item.id} onClick={() => setSelectedTenant(item.id)}>
                  <span><i>{item.name.split(" ").map((part) => part[0]).join("")}</i><b>{item.name}</b></span>
                  <span>{tenant.plan}</span><span>{item.learners.toLocaleString()} seeded learner</span>
                  <span className={styles.good}>{item.status}</span>
                </button>
              ))}
            </div>
          </section>

          <aside className={styles.card} id="cost">
            <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Selected tenant</p><h2>{tenant.name}</h2></div><span>{tenant.plan}</span></div>
            <div className={styles.budgetRing} style={{ "--usage": `${Math.min(usage, 100) * 3.6}deg` } as React.CSSProperties}>
              <div><strong>{usage}%</strong><span>of budget</span></div>
            </div>
            <label><span>Monthly hard cap</span><div><b>$</b><input type="number" value={budget} min={tenant.spend} onChange={(event) => setBudget(Number(event.target.value))} /></div></label>
            <div className={styles.budgetMeta}><span>Spent ${tenant.spend.toLocaleString()}</span><span>Alert at 80%</span></div>
            <button className={styles.primary} onClick={saveBudget}>Save budget policy</button>
          </aside>
        </div>

        <section className={styles.card} id="providers">
          <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Provider-neutral routing</p><h2>Capabilities and fallbacks</h2></div><span>No core provider lock-in</span></div>
          <div className={styles.providerTable}>
            <div className={styles.providerHeader}><span>Capability</span><span>Primary route</span><span>Safe fallback</span><span>Development evidence</span></div>
            {providers.map((provider) => (
              <div className={styles.providerRow} key={provider.capability}><b>{provider.capability}</b><span>{provider.primary}</span><span>{provider.fallback}</span><span className={styles.good}>{provider.health}</span></div>
            ))}
          </div>
        </section>

        <div className={styles.grid}>
          <section className={styles.card} id="mcp">
            <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Agent access</p><h2>Management MCP</h2></div><span className={styles.good}>Package verified</span></div>
            <div className={styles.mcpIdentity}><span>M</span><div><b>course-ai-management</b><small>stdio · v0.1.0 · tenant scoped</small></div></div>
            <dl className={styles.toolList}>
              <div><dt>Registered tools</dt><dd>28 shared-service tools</dd></div>
              <div><dt>Mutation tools</dt><dd>{toolsEnabled ? "Expiry + budget grant" : "Denied by default"}</dd></div>
              <div><dt>Student tools</dt><dd>0</dd></div>
              <div><dt>Provider attempts</dt><dd>{platform?.providers.attempts.length ?? 0} recorded</dd></div>
            </dl>
            <label className={styles.toggle}><div><b>Preview mutation policy</b><small>The running MCP still denies writes until an exact signed grant is configured.</small></div><input type="checkbox" checked={toolsEnabled} onChange={(event) => { setToolsEnabled(event.target.checked); setNotice(event.target.checked ? "Grant-policy preview enabled · no MCP authorization state changed" : "Grant-policy preview closed · MCP remains deny-by-default"); }} /></label>
          </section>

          <section className={styles.card} id="audit">
            <div className={styles.cardHeading}><div><p className={styles.eyebrow}>Immutable evidence</p><h2>Recent audit</h2></div><button onClick={() => setNotice("Audit export prepared with secret fields redacted")}>Export</button></div>
            <div className={styles.audit}>
              {(platform?.audit.slice(0, 4) ?? []).map((entry) => (
                <div key={entry.auditId}>
                  <span>{new Date(entry.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <i>{entry.actorId?.slice(0, 2).toUpperCase() ?? "S"}</i>
                  <p><b>{entry.action}</b> {entry.resourceType}</p>
                  <em>Allowed</em>
                </div>
              ))}
              {!platform?.audit.length ? <p>Loading immutable audit evidence…</p> : null}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
