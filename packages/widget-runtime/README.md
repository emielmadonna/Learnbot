# `@course-ai/widget-runtime`

Framework-free embeddable Student companion runtime. It ships as both an ESM
module and an auto-mounting IIFE, registers `<course-ai-widget>`, renders into a
Shadow DOM root, and contains no provider SDKs or tenant-specific branding.

## Runtime boundary

The Widget owns:

- launcher, desktop panel, reversible expanded view and mobile safe-area sheet;
- keyboard/pointer movement and bounded resize with per-tenant persistence;
- one ordered conversation across text, voice, attachments and presentation;
- dynamic, validated semantic branding tokens;
- exact anonymous, self-reported and verified identity disclosure;
- honest resolved, stale, ambiguous and unknown learning-context labels;
- attachment/source/approved-diagram presentation;
- host-safe rendering and sanitized health codes.

The host application supplies a `WidgetRuntimeAdapter`. That adapter owns
identity/session exchange, authenticated API transport, server-side conversation
resume, SSE/WebSocket streaming, upload signing/scanning/extraction, realtime
media capture/playback, provider routing and durable telemetry. The runtime only
exposes typed events and controls for those capabilities. It does not implement a
voice provider, retain raw audio, hold API credentials, or promote chat
attachments into course knowledge.

Only the conversation identifier, pending draft, modality preference and widget
layout are stored locally. Message history is resumed by the adapter so that
server retention and tenant policy remain authoritative.

## Embed

```html
<script>
  window.CourseAiWidgetAdapter = myTenantSafeAdapter;
</script>
<script
  src="https://cdn.example.com/widget.iife.js"
  data-tenant="pk_live_example"
></script>
```

Or use ESM:

```ts
import {
  CourseAiWidgetElement,
  registerCourseAiWidget,
  type WidgetRuntimeAdapter,
} from "@course-ai/widget-runtime";

registerCourseAiWidget();
const widget = document.createElement("course-ai-widget") as CourseAiWidgetElement;
document.body.append(widget);
await widget.configure({ tenantKey: "pk_live_example", adapter });
```

The adapter must validate the public Tenant key server-side and must never trust
host-provided identity, context, attachment or asset approval claims by itself.

## Commands

```bash
pnpm --filter @course-ai/widget-runtime typecheck
pnpm --filter @course-ai/widget-runtime test
pnpm --filter @course-ai/widget-runtime build
pnpm --filter @course-ai/widget-runtime size
```

The build fails when either distributable reaches 50KB gzipped or contains
dynamic-code primitives.
