/**
 * The host adapter, served ahead of the runtime bundle.
 *
 * `packages/widget-runtime` is deliberately host-agnostic: it defines the
 * `WidgetRuntimeAdapter` contract and implements none of it. This prelude is
 * the LearningBot implementation of that contract, and it is the only piece of
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
