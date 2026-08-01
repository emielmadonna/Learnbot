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

  // ------------------------------------------------------ host identity hook
  //
  // Opt-in, and opt-in by existing: the embedding page declares
  // window.CourseAiWidgetIdentity and the widget starts attributing questions
  // to whoever it names. A page that declares nothing gets exactly the
  // behaviour it got before this hook existed -- anonymous, no reference sent,
  // no extra request field. There is deliberately no second switch (no data-
  // attribute to also set): one of the two being forgotten is a launcher that
  // works perfectly and silently attributes nothing, which is the failure mode
  // this codebase is worst at noticing.
  //
  //   window.CourseAiWidgetIdentity = { ref: "...", displayName: "..." };
  //
  // or a function returning that shape, which is re-read before every
  // question so an identity that resolves after page load is still picked up:
  //
  //   window.CourseAiWidgetIdentity = function () {
  //     if (!window.circleUser) return null;
  //     return {
  //       ref: "circle:" + window.circleUser.id,
  //       displayName: window.circleUser.name,
  //     };
  //   };
  //
  // The function must be synchronous. A promise is not awaited and is
  // discarded, because a question must not wait on the host page.
  //
  // The ref is an opaque account handle, never an email address: an at-sign or
  // whitespace fails the pattern below, and the same pattern is enforced again
  // at /api/widget/ask and a third time inside public.widget_ask. Only a
  // peppered HMAC of it is ever stored, and it is namespaced by the caller so
  // one host's ids cannot collide with another's.
  //
  // The displayName is used for the local header label only. It is never sent
  // anywhere.
  //
  // This is a CLAIM MADE BY THE PAGE and is treated as one. window.circleUser
  // is plain client-side data with no signature, so anyone with devtools can
  // set it to any value; the widget labels the result "Identity not verified"
  // and the server records it as self-reported. Nothing on this path can, or
  // pretends to, verify a person.
  var identityRefPattern = /^[A-Za-z0-9_.:-]{3,180}$/;

  function hostIdentity() {
    var declared;
    try {
      declared = globalThis.CourseAiWidgetIdentity;
      if (typeof declared === "function") declared = declared();
    } catch (error) {
      // A throwing host hook must never take the widget down with it.
      return null;
    }
    if (!declared || typeof declared !== "object") return null;
    var ref = typeof declared.ref === "string" ? declared.ref.trim() : "";
    if (!identityRefPattern.test(ref)) return null;
    var name =
      typeof declared.displayName === "string" ? declared.displayName.trim() : "";
    return { ref: ref, displayName: name ? name.slice(0, 80) : "" };
  }

  var uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  // /api/widget/ask sends message.parts for the visuals an answer was
  // grounded on -- "diagram" for a still image, "video" for MP4 -- and omits
  // the field entirely for a text-only answer. Everything else here is
  // forward-compatibility, so a richer payload needs no shipped build to
  // change: an older widget seeing a part kind it does not render skips it
  // (see the runtime's
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
      if (
        raw.kind === "diagram" &&
        typeof raw.url === "string" &&
        typeof raw.caption === "string"
      ) {
        mapped.push({
          kind: "diagram",
          id: String(raw.id || i),
          caption: raw.caption,
          url: raw.url,
          rasterFallbackUrl:
            typeof raw.rasterFallbackUrl === "string" ? raw.rasterFallbackUrl : undefined,
          // The runtime renders the image only when this is true, and the
          // server sets it only for an asset the tenant marked answerable.
          // Never defaulted to true here.
          approved: raw.approved === true,
        });
      } else if (raw.kind === "video" && typeof raw.url === "string" && typeof raw.title === "string") {
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

  // Sources arrive as their own SSE event before the answer starts, so the
  // citation rows can render while the prose is still being written. They
  // become the same "source" parts the buffered path appends, in the same
  // order, so the thread looks identical either way.
  function sourceParts(rawSources) {
    var parts = [];
    if (!Array.isArray(rawSources)) return parts;
    for (var index = 0; index < rawSources.length; index += 1) {
      var source = rawSources[index];
      if (!source || !source.title) continue;
      parts.push({
        kind: "source",
        id: String(source.sourceRef || index),
        title: String(source.title),
        // No public deep link exists for an anonymous visitor; the citation is
        // shown as evidence, not as a navigable link.
        url: "",
      });
    }
    return parts;
  }

  // Reads the SSE contract /api/widget/ask serves on Accept: text/event-stream
  // -- a "sources" event first, then "delta" events, then a terminal "done"
  // (or "error"). Frames are separated by a blank line, so a partial frame is
  // held until the rest of it arrives rather than parsed as truncated JSON.
  //
  // handlers.onSources/onDelta/onDone are called as frames land; the returned
  // promise resolves true only if a terminal "done" was seen. Anything else --
  // an "error" frame, a dropped connection, a stream that simply stops -- is
  // false, and the caller must not present the turn as a finished answer.
  function readEventStream(response, handlers) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var finished = false;

    function handleFrame(frame) {
      var name = "";
      var data = "";
      var lines = frame.split("\n");
      for (var i = 0; i < lines.length; i += 1) {
        var line = lines[i];
        if (line.indexOf("event:") === 0) name = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) data += line.slice(5).trim();
      }
      if (!data) return;
      var payload;
      try {
        payload = JSON.parse(data);
      } catch (error) {
        return;
      }
      if (!payload || typeof payload !== "object") return;
      if (name === "sources") handlers.onSources(payload);
      else if (name === "delta") handlers.onDelta(payload);
      else if (name === "done") {
        finished = true;
        handlers.onDone(payload);
      }
      // An "error" frame leaves finished false, which is the whole signal.
    }

    function pump() {
      return reader.read().then(function (chunk) {
        if (chunk.done) return finished;
        buffer += decoder.decode(chunk.value, { stream: true });
        var boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          handleFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
        }
        return pump();
      });
    }

    return pump();
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
          // The tier is decided here, on the page, because the claim was made
          // here. "self_reported" is the ceiling and there is no branch that
          // reaches "verified": the runtime renders that tier as "Verified
          // learner", and nothing on this path has verified anybody. The
          // label the visitor sees for a declared identity is "Identity not
          // verified", which is the true statement.
          var declared = hostIdentity();
          var identity = { tier: "anonymous" };
          if (declared) {
            identity = { tier: "self_reported" };
            if (declared.displayName) identity.displayName = declared.displayName;
          }
          return {
            // The widget transcript is never resumed from the server, so this
            // conversation always starts empty. See the route comments.
            conversation: { id: conversationRef(), items: [] },
            branding: payload.branding || {},
            identity: identity,
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
      function failed(code) {
        emit({
          type: "error",
          conversationId: input.conversationId,
          code: code,
          recoverable: true,
        });
      }

      return fetch(apiOrigin + "/api/widget/ask", {
        method: "POST",
        credentials: "omit",
        headers: {
          "content-type": "application/json",
          // Streaming is opt-in on the server and this is the opt-in. A
          // deployment that predates it, or any response the route decides to
          // send whole, comes back as JSON and falls through to the branch
          // below unchanged -- so this is safe to send unconditionally.
          accept: "text/event-stream, application/json",
        },
        body: JSON.stringify(
          (function () {
            var payload = {
              key: script.dataset.tenant,
              conversationRef: input.conversationId,
              question: input.text,
              courseRef: script.dataset.course || null,
            };
            // Re-read per question, not captured at bootstrap: on a Circle
            // page the member object can arrive after the launcher does, and
            // a member can sign out mid-session. Absent identity means the
            // two fields are omitted from the body entirely, so an install
            // that never opted in sends byte-for-byte what it sent before.
            var declared = hostIdentity();
            if (declared) {
              payload.visitorRef = declared.ref;
              payload.visitorTier = "self_reported";
            }
            return payload;
          })(),
        ),
        signal: input.signal,
      })
        .then(function (response) {
          var contentType = (
            response.headers.get("content-type") || ""
          ).toLowerCase();
          if (
            !response.ok ||
            !response.body ||
            contentType.indexOf("text/event-stream") === -1 ||
            typeof TextDecoder === "undefined"
          ) {
            return response.json().then(function (payload) {
              return { streamed: false, ok: response.ok, payload: payload };
            });
          }

          var feedbackRef = "";
          return readEventStream(response, {
            onSources: function (payload) {
              // The answer bubble opens here, before a single token exists:
              // an empty text part for the deltas to land in, then the visuals
              // and citations, in the same order the buffered answer builds
              // them. This is the whole point of the change -- the visitor
              // stops staring at a blank panel while the model writes.
              var parts = [{ kind: "text", text: "" }];
              parts = parts.concat(mapRichParts(payload.parts));
              parts = parts.concat(sourceParts(payload.sources));
              emit({
                type: "thread.item",
                conversationId: input.conversationId,
                item: {
                  id: id,
                  sequence: Date.now(),
                  role: "assistant",
                  modality: "text",
                  status: "streaming",
                  parts: parts,
                  createdAt: new Date().toISOString(),
                },
              });
            },
            onDelta: function (payload) {
              if (typeof payload.text !== "string" || !payload.text) return;
              emit({
                type: "response.delta",
                conversationId: input.conversationId,
                itemId: id,
                text: payload.text,
              });
            },
            onDone: function (payload) {
              // Same rule as the buffered path: only a server-minted UUID can
              // be rated, and its absence means no rating control rather than
              // one that would be refused on every click.
              feedbackRef =
                typeof payload.messageId === "string" &&
                uuidPattern.test(payload.messageId)
                  ? payload.messageId
                  : "";
            },
          }).then(function (complete) {
            if (!complete) {
              // No terminal "done". Whatever text arrived is left on screen --
              // it is real, it was streamed -- but the turn is reported as
              // failed rather than silently presented as a finished answer.
              failed("answer_unavailable");
              return { streamed: true };
            }
            var settled = {
              id: id,
              sequence: Date.now(),
              role: "assistant",
              modality: "text",
              // Empty: the runtime keeps the parts already on the thread when
              // an update carries none, so the streamed text is not discarded.
              parts: [],
              status: "complete",
              createdAt: new Date().toISOString(),
            };
            if (feedbackRef) settled.feedbackRef = feedbackRef;
            emit({
              type: "thread.item",
              conversationId: input.conversationId,
              item: settled,
            });
            emit({
              type: "response.complete",
              conversationId: input.conversationId,
              itemId: id,
            });
            return { streamed: true };
          });
        })
        .then(function (result) {
          if (result.streamed) return;
          if (!result.ok || !result.payload || result.payload.ok !== true) {
            failed(
              result.payload && result.payload.code === "rate_limited"
                ? "rate_limited"
                : "answer_unavailable",
            );
            return;
          }
          var message = result.payload.message || {};
          var parts = [{ kind: "text", text: String(message.content || "") }];
          parts = parts.concat(mapRichParts(message.parts));
          parts = parts.concat(sourceParts(message.sources));
          // message.id is the DURABLE assistant message id, and the only id
          // /api/widget/feedback accepts. It is absent when the database has
          // not been given the migration that returns it, in which case no
          // feedbackRef is set and the runtime renders no rating control --
          // rather than one that would be refused on every click. The local
          // "id" above stays what it always was: an internal correlation
          // handle, meaningful to nothing but this adapter.
          var feedbackRef =
            typeof message.id === "string" && uuidPattern.test(message.id)
              ? message.id
              : "";
          var item = {
            id: id,
            sequence: Date.now(),
            role: "assistant",
            modality: "text",
            status: "complete",
            parts: parts,
            createdAt: String(message.createdAt || new Date().toISOString()),
          };
          if (feedbackRef) item.feedbackRef = feedbackRef;
          emit({
            type: "thread.item",
            conversationId: input.conversationId,
            item: item,
          });
          emit({
            type: "response.complete",
            conversationId: input.conversationId,
            itemId: id,
          });
        })
        .catch(function () {
          failed("answer_unavailable");
        });
    },
    // "Did that help?" for one answer. The runtime only calls this with a
    // feedbackRef the server minted, so the id posted here is always one
    // /api/widget/feedback will accept. A rejection REJECTS: the runtime shows
    // the visitor that the rating did not save rather than pretending it did.
    rateAnswer: function (input) {
      return fetch(apiOrigin + "/api/widget/feedback", {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: script.dataset.tenant,
          conversationRef: input.conversationId,
          messageId: input.feedbackRef,
          rating: input.rating,
        }),
        signal: input.signal,
      }).then(function (response) {
        if (!response.ok) throw new Error("feedback_rejected");
        return response.json().then(function (payload) {
          if (!payload || payload.ok !== true) {
            throw new Error("feedback_rejected");
          }
        });
      });
    },
  };
})();
`;
