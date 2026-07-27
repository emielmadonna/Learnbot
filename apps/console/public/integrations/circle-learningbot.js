/*!
 * LearningBot embeddable widget bootstrap (PLAN.md Phase 7, JOB 2).
 *
 * PASTE-READY INSTALL SNIPPET — this is the entire integration. Paste this
 * once, anywhere on the page (Circle's custom-code block, a theme header,
 * etc.):
 *
 *   <script
 *     async
 *     src="https://YOUR-LEARNINGBOT-DOMAIN/integrations/circle-learningbot.js"
 *     data-widget-key="wk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
 *   ></script>
 *
 * The widget key comes from the tenant's Studio (Settings → Widget). It is
 * a public, leak-tolerant key — the actual authorization boundary is the
 * (key, origin) pair the server re-checks on every request (see
 * infra/supabase/migrations/20260726093000_widget_delivery.sql).
 *
 * WHAT THIS FILE DOES
 * -------------------
 * 1. Loads `@course-ai/widget-runtime` (packages/widget-runtime) — a
 *    framework-free custom element that owns Shadow DOM isolation, layout,
 *    container-queried sizing, and keyboard/focus handling. This file does
 *    NOT reimplement any of that; it only supplies the transport.
 * 2. Implements a `WidgetRuntimeAdapter` over the two public, anonymous,
 *    origin-allowlisted RPCs already shipped for this: `GET /api/widget/config`
 *    (branding + launcher settings) and `POST /api/widget/ask` (one grounded,
 *    rate-limited turn). No new transport is invented here — this is the
 *    transport those routes already define.
 * 3. Mounts `<course-ai-widget>` and calls `.configure()`.
 *
 * FAILURE MODE
 * ------------
 * Every step is guarded. A malformed key, a network failure, a disallowed
 * origin, a runtime script that fails to load, or an exception anywhere in
 * this file results in the widget simply not appearing — never a thrown
 * error, never a broken host page. `widget-runtime` applies the same rule
 * internally once it is running (`registerCourseAiWidget`'s own guards).
 */
(() => {
  "use strict";

  try {
    var currentScript = document.currentScript;
    if (!(currentScript instanceof HTMLScriptElement)) return;

    // Guard against the script being pasted twice (a theme header AND a
    // per-page custom-code block, for example). Set synchronously, before
    // anything async, so two near-simultaneous inclusions cannot both pass.
    if (window.__learningbotWidgetBoot) return;
    window.__learningbotWidgetBoot = true;

    var widgetKey = (currentScript.dataset.widgetKey || currentScript.dataset.key || "").trim();
    if (!/^wk_[0-9a-f]{40}$/.test(widgetKey)) return;

    // The console origin is derived from this very script's own URL, so the
    // same snippet works unmodified across every environment (preview,
    // staging, the tenant's chosen custom domain) without a second
    // configuration value.
    var consoleOrigin = new URL(currentScript.src, window.location.href).origin;

    var STORAGE_PREFIX = "learningbot-widget:" + widgetKey;

    function readStorage(key) {
      try {
        return window.localStorage.getItem(STORAGE_PREFIX + ":" + key);
      } catch (_error) {
        return null;
      }
    }

    function writeStorage(key, value) {
      try {
        window.localStorage.setItem(STORAGE_PREFIX + ":" + key, value);
      } catch (_error) {
        // A visitor blocking storage (private browsing, a strict cookie
        // policy) just loses conversation resume across reloads — never a
        // reason to fail the widget.
      }
    }

    /** 32 lowercase hex characters — satisfies the server's conversation_ref
     * shape (`^[A-Za-z0-9_-]{32,128}$`) with room to spare. */
    function randomRef() {
      var bytes = new Uint8Array(16);
      if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
      }
      var hex = "";
      for (var j = 0; j < bytes.length; j += 1) hex += bytes[j].toString(16).padStart(2, "0");
      return hex;
    }

    function conversationRef() {
      var existing = readStorage("conversation-ref");
      if (existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)) return existing;
      var created = randomRef();
      writeStorage("conversation-ref", created);
      return created;
    }

    async function readJsonResponse(response) {
      var payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      return payload;
    }

    function isRecord(value) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    /**
     * The adapter `widget-runtime` calls into. It owns identity/session
     * exchange, transport and telemetry per the package's own README — here
     * that is exactly the two public routes and nothing else.
     */
    function createConsoleAdapter() {
      return {
        async bootstrap(input) {
          var url = consoleOrigin + "/api/widget/config?key=" + encodeURIComponent(widgetKey);
          var response = await fetch(url, {
            method: "GET",
            credentials: "omit",
            signal: input.signal,
          });
          var payload = await readJsonResponse(response);
          if (!response.ok || !isRecord(payload) || payload.ok !== true) {
            throw new Error("widget_unavailable");
          }
          var branding = isRecord(payload.branding) ? payload.branding : {};
          var widget = isRecord(payload.widget) ? payload.widget : {};
          var ref = conversationRef();
          return {
            conversation: { id: ref, items: [] },
            branding: {
              assistantName: branding.assistantName,
              logoUrl: branding.logoUrl || undefined,
              avatarUrl: branding.avatarUrl || undefined,
              primaryColor: branding.primaryColor,
              accentColor: branding.accentColor,
              surfaceColor: branding.surfaceColor,
              textColor: branding.textColor,
              fontFamily: branding.fontFamily,
              welcomeCopy: branding.welcomeCopy,
              launcherLabel: branding.launcherLabel,
              launcherPosition: branding.launcherPosition,
              // The widget transport below is single-shot HTTP with no
              // realtime/voice session behind it. Advertising voice here
              // would be a claim with no working path — PLAN.md's own rule
              // for what may ship. See "known limits" below.
              voiceEnabled: false,
              privacyUrl: branding.privacyUrl || undefined,
              termsUrl: branding.termsUrl || undefined,
              supportUrl: branding.supportUrl || undefined,
            },
            identity: { tier: "anonymous" },
            learningContext: { status: "unknown" },
          };
        },

        async sendText(input, emit) {
          var response = await fetch(consoleOrigin + "/api/widget/ask", {
            method: "POST",
            credentials: "omit",
            headers: { "content-type": "application/json" },
            signal: input.signal,
            body: JSON.stringify({
              key: widgetKey,
              conversationRef: input.conversationId,
              question: input.text,
            }),
          });
          var payload = await readJsonResponse(response);
          if (!response.ok || !isRecord(payload) || payload.ok !== true) {
            var code = isRecord(payload) && typeof payload.code === "string" ? payload.code : "widget_unavailable";
            var retryAfter = isRecord(payload) && typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : undefined;
            emit({
              type: "error",
              conversationId: input.conversationId,
              code: code,
              recoverable: response.status === 429 || response.status === 503,
            });
            var failure = new Error(code);
            failure.retryAfterSeconds = retryAfter;
            throw failure;
          }
          var message = isRecord(payload.message) ? payload.message : {};
          var sources = Array.isArray(message.sources) ? message.sources : [];
          var itemId = "assistant_" + randomRef();
          var parts = [
            { kind: "text", text: typeof message.content === "string" ? message.content : "" },
          ];
          for (var i = 0; i < sources.length && i < 12; i += 1) {
            var source = sources[i];
            if (!isRecord(source)) continue;
            var title = typeof source.title === "string" && source.title ? source.title : "Source";
            parts.push({
              kind: "source",
              id: "source_" + i + "_" + randomRef(),
              title: title,
              // The widget path never receives a linkable URL for a source —
              // it is a content-hash-backed excerpt, not a page. An empty
              // url is handled safely by the runtime (no href is rendered).
              url: "",
            });
          }
          emit({
            type: "thread.item",
            conversationId: input.conversationId,
            item: {
              id: itemId,
              sequence: Date.now(),
              role: "assistant",
              modality: "text",
              status: "complete",
              parts: parts,
              createdAt: new Date().toISOString(),
            },
          });
        },

        reportHealth: function () {
          // No telemetry endpoint is wired for the embedded widget yet.
          // Swallowing this is intentional — telemetry is never allowed to
          // become a reason the widget throws into the host page.
        },
      };
    }

    function loadRuntimeScript() {
      return new Promise(function (resolve, reject) {
        var existing = window.CourseAiWidgetRuntime;
        if (existing && existing.CourseAiWidgetElement) {
          resolve(existing);
          return;
        }
        var script = document.createElement("script");
        script.src = consoleOrigin + "/integrations/widget-runtime.js";
        script.async = true;
        script.onload = function () {
          if (window.CourseAiWidgetRuntime && window.CourseAiWidgetRuntime.CourseAiWidgetElement) {
            resolve(window.CourseAiWidgetRuntime);
          } else {
            reject(new Error("widget_runtime_unavailable"));
          }
        };
        script.onerror = function () {
          reject(new Error("widget_runtime_load_failed"));
        };
        document.head.appendChild(script);
      });
    }

    loadRuntimeScript()
      .then(function (runtime) {
        runtime.registerCourseAiWidget();
        var element = document.createElement("course-ai-widget");
        element.setAttribute("tenant-key", widgetKey);
        document.body.appendChild(element);
        return element.configure({ tenantKey: widgetKey, adapter: createConsoleAdapter() });
      })
      .catch(function () {
        // Any failure here — the runtime script 404ing, a network error, a
        // disallowed origin, a revoked key — leaves the host page exactly as
        // it was. Nothing is thrown past this boundary.
      });
  } catch (_error) {
    // A misconfigured or unexpected embed failure must never reach the host
    // page, no matter what caused it.
  }
})();
