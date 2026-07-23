# Edge API

Cloudflare Worker boundary for:

- tenant identification and session tokens;
- unified text/voice/file conversation orchestration;
- streaming chat events;
- validated telemetry and webhooks;
- authorized signed asset access;
- capability-router invocation.

It must depend on shared contracts and router interfaces, not named provider SDKs. Implementation begins after the request, attachment and provider contracts are validated.
