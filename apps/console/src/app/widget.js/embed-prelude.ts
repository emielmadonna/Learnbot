/**
 * The host adapter, served ahead of the runtime bundle.
 *
 * `packages/widget-runtime` is deliberately host-agnostic: it defines the
 * `WidgetRuntimeAdapter` contract and implements none of it. This prelude is
 * the Corso implementation of that contract, and it is the only piece of
 * the served script that knows about this platform's endpoints.
 *
 * It is plain ES2020 source (no build step, no dependencies) because it is
 * concatenated in front of the already-built IIFE, which reads
 * `globalThis.CourseAiWidgetAdapter` during its auto-mount.
 *
 * Design notes that matter for security:
 *   - the API origin is taken from the script element's own `src`, so the embed
 *     never has to be told where the platform lives and cannot be pointed at a
 *     different host by page content;
 *   - the conversation reference is generated with `crypto.getRandomValues`
 *     and kept in `sessionStorage`. It is a write-scoped nonce, not a session:
 *     no endpoint returns stored messages, so losing or leaking it exposes
 *     nothing;
 *   - `credentials: "omit"` on every request, so no cookie of the embedding
 *     site or of this platform is ever attached.
 */
export const widgetHostAdapterSource = String.raw`
(function () {
  "use strict";
  var script = document.currentScript;
  var apiOrigin = "";
  try {
    apiOrigin = new URL(script.src, location.href).origin;
  } catch (error) {
    return;
  }
  var storageKey = "course-ai-widget-conversation";

  function conversationRef() {
    var existing = null;
    try {
      existing = sessionStorage.getItem(storageKey);
    } catch (error) {
      existing = null;
    }
    if (existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
    var bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    var created = "";
    var alphabet =
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
    for (var index = 0; index < bytes.length; index += 1) {
      created += alphabet[bytes[index] % alphabet.length];
    }
    created = created + created.slice(0, 12);
    try {
      sessionStorage.setItem(storageKey, created);
    } catch (error) {
      /* Private browsing keeps the ref in memory for this page only. */
    }
    return created;
  }

  function itemId() {
    return "w" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // /api/widget/ask returns only { content, sources } today, so this always
  // maps to []. It exists so this adapter is forward-compatible with a
  // richer payload without a shipped build ever having to change: an older
  // widget seeing a part kind it does not render skips it (see the runtime's
  // NOTE: no backticks below this line. Everything from the String.raw
  // template on line 24 to its close is one template literal, so a stray
  // backtick -- even inside a comment -- ends it early and the rest of the
  // file parses as broken TypeScript.
  // #renderPart), and a server that never sends message.parts at all still
  // gets exactly today's text + source behavior.
  function mapRichParts(rawParts) {
    var mapped = [];
    if (!Array.isArray(rawParts)) return mapped;
    for (var i = 0; i < rawParts.length; i += 1) {
      var raw = rawParts[i];
      if (!raw || typeof raw !== "object") continue;
      if (raw.kind === "video" && typeof raw.url === "string" && typeof raw.title === "string") {
        mapped.push({
          kind: "video",
          id: String(raw.id || i),
          title: raw.title,
          url: raw.url,
          posterUrl: typeof raw.posterUrl === "string" ? raw.posterUrl : undefined,
          durationLabel: typeof raw.durationLabel === "string" ? raw.durationLabel : undefined,
        });
      } else if (raw.kind === "list" && Array.isArray(raw.items)) {
        mapped.push({
          kind: "list",
          heading: typeof raw.heading === "string" ? raw.heading : undefined,
          items: raw.items.filter(function (entry) {
            return typeof entry === "string";
          }),
        });
      } else if (raw.kind === "quote" && typeof raw.text === "string") {
        mapped.push({
          kind: "quote",
          text: raw.text,
          attribution: typeof raw.attribution === "string" ? raw.attribution : undefined,
        });
      } else if (raw.kind === "chart" && Array.isArray(raw.bars)) {
        mapped.push({
          kind: "chart",
          id: String(raw.id || i),
          heading: typeof raw.heading === "string" ? raw.heading : "",
          sourceLabel: typeof raw.sourceLabel === "string" ? raw.sourceLabel : undefined,
          bars: raw.bars
            .filter(function (bar) {
              return bar && typeof bar.label === "string" && typeof bar.value === "number";
            })
            .map(function (bar) {
              return { label: bar.label, value: bar.value };
            }),
          footnote: typeof raw.footnote === "string" ? raw.footnote : undefined,
        });
      } else if (raw.kind === "code" && typeof raw.code === "string") {
        mapped.push({
          kind: "code",
          label: typeof raw.label === "string" ? raw.label : undefined,
          code: raw.code,
          language: typeof raw.language === "string" ? raw.language : undefined,
        });
      } else if (
        raw.kind === "progress" &&
        typeof raw.moduleLabel === "string" &&
        typeof raw.statusLabel === "string"
      ) {
        mapped.push({
          kind: "progress",
          id: String(raw.id || i),
          moduleLabel: raw.moduleLabel,
          statusLabel: raw.statusLabel,
          completedSteps: typeof raw.completedSteps === "number" ? raw.completedSteps : 0,
          totalSteps: typeof raw.totalSteps === "number" ? raw.totalSteps : 0,
          nextLabel: typeof raw.nextLabel === "string" ? raw.nextLabel : undefined,
        });
      } else if (raw.kind === "followups" && Array.isArray(raw.suggestions)) {
        mapped.push({
          kind: "followups",
          suggestions: raw.suggestions.filter(function (entry) {
            return typeof entry === "string";
          }),
        });
      }
      // Any other (or malformed) entry — including kinds this adapter does
      // not know about yet — is silently dropped rather than guessed at.
    }
    return mapped;
  }

  globalThis.CourseAiWidgetAdapter = {
    bootstrap: function (input) {
      var url =
        apiOrigin +
        "/api/widget/config?key=" +
        encodeURIComponent(input.tenantKey);
      return fetch(url, {
        credentials: "omit",
        headers: { accept: "application/json" },
        signal: input.signal,
      })
        .then(function (response) {
          if (!response.ok) throw new Error("widget_unavailable");
          return response.json();
        })
        .then(function (payload) {
          if (!payload || payload.ok !== true) {
            throw new Error("widget_unavailable");
          }
          return {
            // The widget transcript is never resumed from the server, so this
            // conversation always starts empty. See the route comments.
            conversation: { id: conversationRef(), items: [] },
            branding: payload.branding || {},
            identity: { tier: "anonymous" },
            learningContext: { status: "unknown" },
          };
        });
    },
    sendText: function (input, emit) {
      var id = itemId();
      emit({
        type: "thread.item",
        conversationId: input.conversationId,
        item: {
          id: id,
          sequence: Date.now(),
          role: "assistant",
          modality: "text",
          status: "pending",
          parts: [],
          createdAt: new Date().toISOString(),
        },
      });
      return fetch(apiOrigin + "/api/widget/ask", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: script.dataset.tenant,
          conversationRef: input.conversationId,
          question: input.text,
          courseRef: script.dataset.course || null,
        }),
        signal: input.signal,
      })
        .then(function (response) {
          return response.json().then(function (payload) {
            return { ok: response.ok, payload: payload };
          });
        })
        .then(function (result) {
          if (!result.ok || !result.payload || result.payload.ok !== true) {
            emit({
              type: "error",
              conversationId: input.conversationId,
              code:
                result.payload && result.payload.code === "rate_limited"
                  ? "rate_limited"
                  : "answer_unavailable",
              recoverable: true,
            });
            return;
          }
          var message = result.payload.message || {};
          var parts = [{ kind: "text", text: String(message.content || "") }];
          parts = parts.concat(mapRichParts(message.parts));
          var sources = Array.isArray(message.sources) ? message.sources : [];
          for (var index = 0; index < sources.length; index += 1) {
            var source = sources[index];
            if (!source || !source.title) continue;
            parts.push({
              kind: "source",
              id: String(source.sourceRef || index),
              title: String(source.title),
              // No public deep link exists for an anonymous visitor; the
              // citation is shown as evidence, not as a navigable link.
              url: "",
            });
          }
          emit({
            type: "thread.item",
            conversationId: input.conversationId,
            item: {
              id: id,
              sequence: Date.now(),
              role: "assistant",
              modality: "text",
              status: "complete",
              parts: parts,
              createdAt: String(message.createdAt || new Date().toISOString()),
            },
          });
          emit({
            type: "response.complete",
            conversationId: input.conversationId,
            itemId: id,
          });
        })
        .catch(function () {
          emit({
            type: "error",
            conversationId: input.conversationId,
            code: "answer_unavailable",
            recoverable: true,
          });
        });
    },
  };
})();
`;
