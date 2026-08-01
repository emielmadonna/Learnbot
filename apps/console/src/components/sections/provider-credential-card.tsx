"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button, TextField } from "../ui";
import styles from "./agent-panel.module.css";

type ProviderState = {
  tenantConfigured: boolean;
  credentialSource: "tenant_vault" | "platform_managed";
  keyLast4: string | null;
  updatedAt: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function providerState(value: unknown): ProviderState | null {
  if (!isRecord(value) || value.ok !== true) return null;
  return {
    tenantConfigured: value.tenantConfigured === true,
    credentialSource:
      value.credentialSource === "tenant_vault"
        ? "tenant_vault"
        : "platform_managed",
    keyLast4: typeof value.keyLast4 === "string" ? value.keyLast4 : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
  };
}

export function ProviderCredentialCard() {
  const [state, setState] = useState<ProviderState | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Loading provider status…");

  const load = useCallback(async () => {
    try {
      const result = await fetch("/api/agent/provider", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = providerState(await result.json());
      if (!result.ok || !body) throw new Error();
      setState(body);
      setMessage(
        body.tenantConfigured
          ? `Workspace key ending in ${body.keyLast4 ?? "••••"} is active.`
          : "Platform-managed OpenAI is active. Add a workspace key only if this tenant should own provider billing.",
      );
    } catch {
      setMessage("Provider status is temporarily unavailable.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateProvider(clearApiKey: boolean) {
    setBusy(true);
    setMessage(clearApiKey ? "Removing workspace key…" : "Encrypting workspace key…");
    try {
      const result = await fetch("/api/agent/provider", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          apiKey: clearApiKey ? "" : apiKey,
          clearApiKey,
        }),
      });
      const body = await result.json();
      if (!result.ok || !isRecord(body) || body.ok !== true) throw new Error();
      setApiKey("");
      await load();
    } catch {
      setMessage("The provider key was not changed. Check the key and try again.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (apiKey.trim().length >= 20) void updateProvider(false);
  }

  return (
    <div className={styles.providerCard}>
      {/*
       * A picker grid, not a single fixed card: packages/provider-router only
       * ships OpenAI adapters (responses, embeddings, image, whisper) today,
       * so this genuinely has one option. The grid stays because it is
       * honest about shape — a second provider becomes another card here,
       * not a redesign — and because rendering an Anthropic or
       * bring-your-own-endpoint card that cannot answer a single question
       * would be exactly the inert, clickable-looking row this product
       * avoids elsewhere (see the Import surface).
       */}
      <div className={styles.providerGrid} role="radiogroup" aria-label="Model provider">
        <div aria-checked="true" className={styles.providerOption} data-selected="true" role="radio">
          <div className={styles.providerOptionHead}>
            <span className={styles.providerOptionName}>OpenAI</span>
            <span
              className={styles.providerDot}
              data-active={state !== null ? "true" : "false"}
              aria-hidden="true"
            />
          </div>
          <p className={styles.providerOptionStatus}>
            {state === null
              ? "Checking status…"
              : state.credentialSource === "tenant_vault"
                ? "Connected · encrypted workspace credential"
                : "Connected · platform-managed credential"}
          </p>
        </div>
      </div>
      <p className={styles.providerMessage} role="status">
        {message}
      </p>
      <form className={styles.providerForm} onSubmit={submit}>
        <TextField
          autoComplete="off"
          disabled={busy}
          help="Stored server-side in Supabase Vault. The browser can never read it back."
          label="Workspace OpenAI API key"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder="Paste a new key"
          type="password"
          value={apiKey}
        />
        <div className={styles.providerActions}>
          <Button
            disabled={busy || apiKey.trim().length < 20}
            type="submit"
            variant="primary"
          >
            Save encrypted key
          </Button>
          {state?.tenantConfigured ? (
            <Button
              disabled={busy}
              onClick={() => void updateProvider(true)}
              type="button"
              variant="secondary"
            >
              Use platform-managed key
            </Button>
          ) : null}
        </div>
      </form>
    </div>
  );
}
