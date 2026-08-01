"use client";

import { useEffect, useState } from "react";
import { createBrowserSupabaseClient } from "../../lib/supabase/client";
import { Button } from "../ui/button";
import type { ShellPayload } from "./contract";
import styles from "./shell.module.css";

type PreviewSession = {
  displayName: string;
  enteredAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readBody(response: Response) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    throw new Error(
      isRecord(body) && typeof body.code === "string"
        ? body.code
        : "request_failed",
    );
  }
  return body;
}

export function PlatformClientPreviewBanner({
  tenant,
  role,
}: {
  tenant: ShellPayload["tenant"];
  role: ShellPayload["role"];
}) {
  const [session, setSession] = useState<PreviewSession | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!tenant.tenantId) return;
    // The platform entry is DURABLE and server-side: `/api/platform` is the
    // authority on whether this caller has an active, audited session in this
    // tenant. This used to gate on a `sessionStorage` key first, which made the
    // only route back to the control plane ephemeral — closing the tab, opening
    // a second one, or restarting the browser lost the flag while the server
    // still held the entry open. The admin was then left inside the client
    // workspace with no way out, because `resolveAppAccessMode` keeps returning
    // `tenant_workspace` for as long as a tenant is selected.
    //
    // Gate on the role instead. It comes from `platform_admin_is_authorized`
    // on the server, survives any browser state, and keeps ordinary members
    // from firing a platform-only read they would only be denied.
    if (role !== "platform_owner") return;
    const controller = new AbortController();
    void fetch(
      `/api/platform?tenantId=${encodeURIComponent(tenant.tenantId)}`,
      {
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      },
    )
      .then(readBody)
      .then((body) => {
        const sessions = Array.isArray(body.activePlatformSessions)
          ? body.activePlatformSessions
          : [];
        const caller = sessions.find(
          (candidate) => isRecord(candidate) && candidate.isCaller === true,
        );
        if (!isRecord(caller)) return;
        setSession({
          displayName:
            isRecord(body.tenant) &&
            typeof body.tenant.displayName === "string"
              ? body.tenant.displayName
              : tenant.displayName,
          enteredAt:
            typeof caller.enteredAt === "string" ? caller.enteredAt : null,
        });
      })
      .catch(() => {
        // Ordinary tenant members are expected to be denied this platform-only
        // read. Silence that result; the banner only exists for an active,
        // audited platform entry.
      });
    return () => controller.abort();
  }, [role, tenant.displayName, tenant.tenantId]);

  async function exitPreview() {
    setLeaving(true);
    setFailure(null);
    try {
      const response = await fetch("/api/platform", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "exit" }),
      });
      await readBody(response);
      const supabase = createBrowserSupabaseClient();
      const { error } = await supabase.auth.refreshSession();
      if (error) throw error;
      try {
        window.sessionStorage.removeItem("platform-client-preview");
      } catch {
        // The durable exit succeeded even if this browser blocks storage.
      }
      window.location.assign("/app");
    } catch {
      setFailure(
        "The preview could not be closed securely. Refresh the session and try again.",
      );
      setLeaving(false);
    }
  }

  if (session === null) return null;

  return (
    <aside className={styles.clientPreviewBanner} aria-label="Client preview">
      <span className={styles.clientPreviewCopy}>
        <strong>Client preview · {session.displayName}</strong>
        <span>
          You are still signed in as yourself with an audited tenant-admin
          membership. No client user is being impersonated.
        </span>
        {failure ? (
          <span className={styles.clientPreviewError} role="alert">
            {failure}
          </span>
        ) : null}
      </span>
      <Button
        loading={leaving}
        loadingLabel="Returning…"
        onClick={exitPreview}
        variant="secondary"
      >
        Return to platform
      </Button>
    </aside>
  );
}

export default PlatformClientPreviewBanner;
