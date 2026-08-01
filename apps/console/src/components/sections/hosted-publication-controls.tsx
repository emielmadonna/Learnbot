"use client";

import { useEffect, useMemo, useState } from "react";

import { Button, StateBadge, TextField } from "../ui";
import styles from "./hosted-publication-controls.module.css";

const ENDPOINT = "/api/widget/hosted-publication";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "corso",
  "help",
  "install",
  "onboarding",
  "privacy",
  "security",
  "status",
  "support",
  "terms",
  "widget",
  "www",
]);

type Publication = {
  slug: string;
  status: "published" | "unpublished";
  hostedPath: string;
  publishedAt: string | null;
  unpublishedAt: string | null;
  updatedAt: string;
};

type Snapshot = {
  expectedVersion: number;
  publication: Publication | null;
  hostedOrigin: string;
  hostedUrl: string | null;
  originAllowlistValue: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; snapshot: Snapshot }
  | { status: "error"; message: string };

type PublicationAction = "publish" | "unpublish" | "change_slug";

export type HostedPublicationControlsProps = {
  readonly draftAnonymousAccess: boolean;
  readonly draftEnabled: boolean;
  readonly draftOrigins: readonly string[];
  readonly hidden?: boolean | undefined;
  readonly savedAnonymousAccess: boolean;
  readonly savedEnabled: boolean;
  readonly savedOrigins: readonly string[];
  readonly onAddOrigin: (origin: string) => string | null;
};

const ERROR_COPY: Readonly<Record<string, string>> = {
  access_denied:
    "Only a workspace owner or admin can manage the hosted assistant link.",
  authentication_required:
    "Your session could not be verified. Sign in again, then retry.",
  idempotency_conflict:
    "That request was already used for a different change. Retry the action.",
  invalid_request:
    "The hosted-link request was incomplete. Check the address and retry.",
  invalid_slug:
    "Use 3–63 lowercase letters, numbers, or hyphens. Start and end with a letter or number.",
  origin_not_allowed:
    "Add this Corso address to the saved domain list before publishing.",
  publication_not_found:
    "This workspace does not have a hosted assistant link to change yet.",
  request_failed:
    "The hosted-link service did not answer. Your current link was not changed.",
  slug_change_required:
    "Choose a different address before changing the link.",
  slug_unavailable:
    "That address has already been reserved. Choose another one.",
  tenant_not_found:
    "A workspace could not be selected for this request.",
  tenant_selection_required:
    "Choose a workspace before managing its hosted assistant link.",
  version_conflict:
    "The hosted link changed elsewhere. Reload the latest version before continuing.",
  widget_not_ready:
    "Save the widget as on, allow signed-out visitors, and allow this Corso address before publishing.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codeOf(value: unknown): string | null {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

function nullableTimestamp(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function readSnapshot(value: unknown): Snapshot | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.dataMode !== "durable" ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 0 ||
    typeof value.hostedOrigin !== "string" ||
    typeof value.originAllowlistValue !== "string" ||
    (value.hostedUrl !== null && typeof value.hostedUrl !== "string")
  ) {
    return null;
  }

  if (value.publication === null) {
    return {
      expectedVersion: value.expectedVersion,
      publication: null,
      hostedOrigin: value.hostedOrigin,
      hostedUrl: null,
      originAllowlistValue: value.originAllowlistValue,
    };
  }
  if (!isRecord(value.publication)) return null;
  const publication = value.publication;
  if (
    typeof publication.slug !== "string" ||
    (publication.status !== "published" &&
      publication.status !== "unpublished") ||
    publication.hostedPath !== `/c/${publication.slug}` ||
    !nullableTimestamp(publication.publishedAt) ||
    !nullableTimestamp(publication.unpublishedAt) ||
    typeof publication.updatedAt !== "string" ||
    typeof value.hostedUrl !== "string"
  ) {
    return null;
  }

  return {
    expectedVersion: value.expectedVersion,
    hostedOrigin: value.hostedOrigin,
    hostedUrl: value.hostedUrl,
    originAllowlistValue: value.originAllowlistValue,
    publication: {
      slug: publication.slug,
      status: publication.status,
      hostedPath: publication.hostedPath,
      publishedAt: publication.publishedAt,
      unpublishedAt: publication.unpublishedAt,
      updatedAt: publication.updatedAt,
    },
  };
}

function sentenceFor(code: string | null) {
  return ERROR_COPY[code ?? "request_failed"] ?? ERROR_COPY.request_failed!;
}

export function hostedPublicationSlugError(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(normalized) || RESERVED_SLUGS.has(normalized)) {
    return ERROR_COPY.invalid_slug!;
  }
  return null;
}

function originAllowed(origins: readonly string[], candidate: string) {
  if (origins.includes(candidate)) return true;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return origins.some((entry) => {
    const match = /^https:\/\/\*\.([a-z0-9.-]+)$/u.exec(entry);
    if (
      match?.[1] === undefined ||
      url.protocol !== "https:" ||
      url.port !== ""
    ) {
      return false;
    }
    return url.hostname !== match[1] && url.hostname.endsWith(`.${match[1]}`);
  });
}

export function HostedPublicationControls({
  draftAnonymousAccess,
  draftEnabled,
  draftOrigins,
  hidden,
  onAddOrigin,
  savedAnonymousAccess,
  savedEnabled,
  savedOrigins,
}: HostedPublicationControlsProps) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [reloadToken, setReloadToken] = useState(0);
  const [slug, setSlug] = useState("");
  const [busy, setBusy] = useState<PublicationAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    setError(null);
    setMessage(null);
    setConflict(false);

    async function run() {
      let response: Response;
      try {
        response = await fetch(ENDPOINT, {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
      } catch {
        if (!cancelled) {
          setLoad({ status: "error", message: sentenceFor("request_failed") });
        }
        return;
      }
      const body = await readJson(response);
      if (cancelled) return;
      if (!response.ok) {
        setLoad({ status: "error", message: sentenceFor(codeOf(body)) });
        return;
      }
      const snapshot = readSnapshot(body);
      if (snapshot === null) {
        setLoad({
          status: "error",
          message:
            "The service replied with a hosted-link record this console could not verify.",
        });
        return;
      }
      setLoad({ status: "ready", snapshot });
      setSlug(snapshot.publication?.slug ?? "");
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const snapshot = load.status === "ready" ? load.snapshot : null;
  const publication = snapshot?.publication ?? null;
  const normalizedSlug = slug.trim().toLowerCase();
  const slugError = slug.length === 0 ? null : hostedPublicationSlugError(slug);
  const savedOriginAllowed =
    snapshot !== null &&
    originAllowed(savedOrigins, snapshot.originAllowlistValue);
  const draftOriginAllowed =
    snapshot !== null &&
    originAllowed(draftOrigins, snapshot.originAllowlistValue);
  const publishReady =
    savedEnabled && savedAnonymousAccess && savedOriginAllowed;
  const addressChanged =
    publication !== null && normalizedSlug !== publication.slug;
  const canSubmitSlug =
    normalizedSlug.length > 0 && slugError === null && publishReady;

  const readiness = useMemo(
    () => [
      {
        state: savedEnabled ? "ready" : draftEnabled ? "pending" : "missing",
        label: savedEnabled
          ? "Widget is saved as on"
          : draftEnabled
            ? "Widget is on in unsaved changes"
            : "Widget is saved as off",
      },
      {
        state: savedAnonymousAccess
          ? "ready"
          : draftAnonymousAccess
            ? "pending"
            : "missing",
        label: savedAnonymousAccess
          ? "Signed-out visitors are saved as allowed"
          : draftAnonymousAccess
            ? "Signed-out visitors are allowed in unsaved changes"
            : "Signed-out visitors are not allowed",
      },
      {
        state: savedOriginAllowed
          ? "ready"
          : draftOriginAllowed
            ? "pending"
            : "missing",
        label: savedOriginAllowed
          ? "This Corso address is in the saved domain list"
          : draftOriginAllowed
            ? "This Corso address is in unsaved changes"
            : "This Corso address is not in the domain list",
      },
    ],
    [
      draftAnonymousAccess,
      draftEnabled,
      draftOriginAllowed,
      savedAnonymousAccess,
      savedEnabled,
      savedOriginAllowed,
    ],
  );

  async function runAction(action: PublicationAction) {
    if (snapshot === null) return;
    setBusy(action);
    setError(null);
    setMessage(null);
    setConflict(false);
    setCopied("idle");
    try {
      const response = await fetch(ENDPOINT, {
        body: JSON.stringify({
          action,
          expectedVersion: snapshot.expectedVersion,
          idempotencyKey: crypto.randomUUID(),
          ...(action === "unpublish" ? {} : { slug: normalizedSlug }),
        }),
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = await readJson(response);
      if (!response.ok) {
        const code = codeOf(body);
        if (response.status === 409 && code === "version_conflict") {
          setConflict(true);
        }
        setError(sentenceFor(code));
        return;
      }
      const next = readSnapshot(body);
      if (next === null) {
        setError(
          "The service did not return a verifiable hosted-link record, so this panel will not claim the change landed.",
        );
        return;
      }
      setLoad({ status: "ready", snapshot: next });
      setSlug(next.publication?.slug ?? "");
      setConfirmingUnpublish(false);
      setMessage(
        action === "unpublish"
          ? "The hosted assistant is offline. Its address remains reserved for this workspace."
          : action === "change_slug"
            ? "The hosted assistant now uses its new address. The old address is permanently retired."
            : "The hosted assistant link is live.",
      );
    } catch {
      setError(sentenceFor("request_failed"));
    } finally {
      setBusy(null);
    }
  }

  async function copyLink() {
    if (snapshot?.hostedUrl === null || snapshot?.hostedUrl === undefined) return;
    try {
      await navigator.clipboard.writeText(snapshot.hostedUrl);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  function addHostedOrigin() {
    if (snapshot === null) return;
    const refused = onAddOrigin(snapshot.originAllowlistValue);
    if (refused !== null) {
      setError(refused);
      return;
    }
    setError(null);
    setMessage(
      "Added to the unsaved domain list below. Save widget settings before publishing.",
    );
  }

  return (
    <section className={styles.card} hidden={hidden}>
      <header className={styles.cardHead}>
        <div>
          <p className={styles.eyebrow}>Full-page assistant</p>
          <h3>Hosted assistant link</h3>
        </div>
        {load.status === "loading" ? (
          <StateBadge state="partial">Checking</StateBadge>
        ) : load.status === "error" ? (
          <StateBadge state="restricted">Unavailable</StateBadge>
        ) : publication === null ? (
          <StateBadge state="unknown">Not published</StateBadge>
        ) : (
          <StateBadge
            state={publication.status === "published" ? "known" : "unknown"}
          >
            {publication.status === "published" ? "Live" : "Offline"}
          </StateBadge>
        )}
      </header>

      <p className={styles.lead}>
        Give students a clean, full-page version of your assistant—no website
        installation required. The address belongs permanently to this
        workspace once it is published.
      </p>

      {load.status === "loading" ? (
        <p className={styles.meta}>Reading the hosted link…</p>
      ) : null}

      {load.status === "error" ? (
        <div className={styles.notice} role="alert">
          <p>{load.message}</p>
          <Button onClick={() => setReloadToken((value) => value + 1)} size="sm">
            Check again
          </Button>
        </div>
      ) : null}

      {snapshot !== null ? (
        <>
          <ul className={styles.checklist} aria-label="Publishing requirements">
            {readiness.map((item) => (
              <li data-state={item.state} key={item.label}>
                <span aria-hidden="true">
                  {item.state === "ready"
                    ? "✓"
                    : item.state === "pending"
                      ? "◌"
                      : "○"}
                </span>
                {item.label}
              </li>
            ))}
          </ul>

          {!savedOriginAllowed ? (
            <div className={styles.originCallout}>
              <div>
                <strong>
                  {draftOriginAllowed
                    ? "Save this hosted address"
                    : "Allow this hosted address first"}
                </strong>
                <code>{snapshot.originAllowlistValue}</code>
              </div>
              {draftOriginAllowed ? (
                <span className={styles.pendingLabel}>Awaiting save</span>
              ) : (
                <Button onClick={addHostedOrigin} size="sm">
                  Add to domains
                </Button>
              )}
            </div>
          ) : null}

          {snapshot.hostedUrl !== null ? (
            <div className={styles.linkBlock}>
              <span className={styles.linkLabel}>
                {publication?.status === "published"
                  ? "Your public link"
                  : "Your reserved address"}
              </span>
              <code className={styles.linkValue}>{snapshot.hostedUrl}</code>
              <div className={styles.linkActions}>
                <Button onClick={() => void copyLink()} size="sm">
                  Copy link
                </Button>
                {publication?.status === "published" ? (
                  <a
                    className={styles.openLink}
                    href={snapshot.hostedUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open assistant
                  </a>
                ) : null}
              </div>
              <p aria-live="polite" className={styles.meta}>
                {copied === "done"
                  ? "Copied to the clipboard."
                  : copied === "failed"
                    ? "Clipboard access was refused. Select the address and copy it manually."
                    : ""}
              </p>
            </div>
          ) : null}

          <TextField
            autoCapitalize="none"
            autoComplete="off"
            disabled={busy !== null}
            error={slugError ?? undefined}
            help={`${snapshot.hostedOrigin}/c/${normalizedSlug || "your-course"}`}
            label={publication === null ? "Choose the address" : "Assistant address"}
            onChange={(event) => {
              setSlug(event.target.value);
              setError(null);
              setMessage(null);
            }}
            spellCheck={false}
            value={slug}
          />

          {publication !== null && addressChanged ? (
            <p className={styles.warning}>
              Changing the address takes effect immediately. The old address
              stops working and can never be reused.
            </p>
          ) : null}

          {error !== null ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          {message !== null ? (
            <p className={styles.success} role="status">
              {message}
            </p>
          ) : null}

          {conflict ? (
            <Button
              onClick={() => setReloadToken((value) => value + 1)}
              size="sm"
              variant="danger"
            >
              Reload the latest link
            </Button>
          ) : null}

          <div className={styles.actions}>
            {publication === null ? (
              <Button
                disabled={!canSubmitSlug || busy !== null || conflict}
                loading={busy === "publish"}
                loadingLabel="Publishing…"
                onClick={() => void runAction("publish")}
                variant="primary"
              >
                Publish link
              </Button>
            ) : publication.status === "unpublished" ? (
              <Button
                disabled={
                  !publishReady || addressChanged || busy !== null || conflict
                }
                loading={busy === "publish"}
                loadingLabel="Publishing…"
                onClick={() => void runAction("publish")}
                variant="primary"
              >
                Publish again
              </Button>
            ) : null}

            {publication !== null && addressChanged ? (
              <Button
                disabled={!canSubmitSlug || busy !== null || conflict}
                loading={busy === "change_slug"}
                loadingLabel="Changing…"
                onClick={() => void runAction("change_slug")}
                variant="primary"
              >
                {publication.status === "published"
                  ? "Change live address"
                  : "Change reserved address"}
              </Button>
            ) : null}

            {publication?.status === "published" && !confirmingUnpublish ? (
              <Button
                disabled={busy !== null || conflict}
                onClick={() => setConfirmingUnpublish(true)}
                variant="danger"
              >
                Unpublish
              </Button>
            ) : null}
          </div>

          {publication?.status === "published" && confirmingUnpublish ? (
            <div className={styles.confirm} role="alert">
              <p>
                Students will lose access immediately, but this address stays
                reserved so you can publish it again.
              </p>
              <div className={styles.actions}>
                <Button
                  disabled={busy !== null}
                  onClick={() => setConfirmingUnpublish(false)}
                  size="sm"
                >
                  Keep it live
                </Button>
                <Button
                  disabled={busy !== null || conflict}
                  loading={busy === "unpublish"}
                  loadingLabel="Unpublishing…"
                  onClick={() => void runAction("unpublish")}
                  size="sm"
                  variant="danger"
                >
                  Yes, unpublish
                </Button>
              </div>
            </div>
          ) : null}

          {!publishReady && publication?.status !== "published" ? (
            <p className={styles.meta}>
              Finish the unchecked items and save the widget settings. Publishing
              becomes available as soon as the saved settings are ready.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default HostedPublicationControls;
