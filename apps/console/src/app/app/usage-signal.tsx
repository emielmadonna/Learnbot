"use client";

import { useEffect } from "react";

export function recordUsageEvent(
  eventName: string,
  properties: Record<string, unknown> = {},
  idempotencyKey = `usage:${crypto.randomUUID()}`,
) {
  return fetch("/api/learning/events", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ eventName, properties, idempotencyKey }),
  }).catch(() => null);
}

export function UsageSignal({
  eventName,
  properties = {},
}: {
  eventName: string;
  properties?: Record<string, unknown>;
}) {
  useEffect(() => {
    const sessionKey = `learningbot:usage:${eventName}:${JSON.stringify(properties)}`;
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "1");
    void recordUsageEvent(eventName, properties, sessionKey);
  }, [eventName, properties]);
  return null;
}
