import { eventSemanticFingerprint, validateEvent } from "./event-taxonomy.js";
import type {
  EventQuarantineRepository,
  EventRepository,
  IntelligenceClock,
  IntelligenceIdFactory,
} from "./repositories.js";
import type {
  EventIngestionResult,
  QuarantinedEvent,
} from "./types.js";

function optionalStringField(
  raw: unknown,
  key: "eventId" | "tenantId",
): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeQuarantineCopy(raw: unknown): unknown {
  try {
    return structuredClone(raw);
  } catch {
    return {
      uncloneable: true,
      valueType: raw === null ? "null" : typeof raw,
    };
  }
}

export class EventIngestionService {
  constructor(
    private readonly events: EventRepository,
    private readonly quarantine: EventQuarantineRepository,
    private readonly clock: IntelligenceClock,
    private readonly ids: IntelligenceIdFactory,
  ) {}

  async ingest(rawEvents: readonly unknown[]): Promise<EventIngestionResult> {
    const acceptedEventIds: string[] = [];
    const duplicateEventIds: string[] = [];
    const quarantined: QuarantinedEvent[] = [];

    for (const raw of rawEvents) {
      const validation = validateEvent(raw);
      if (!validation.valid) {
        const eventId = optionalStringField(raw, "eventId");
        const tenantId = optionalStringField(raw, "tenantId");
        const record: QuarantinedEvent = {
          quarantineId: this.ids.next("quarantine"),
          ...(eventId === undefined ? {} : { eventId }),
          ...(tenantId === undefined ? {} : { tenantId }),
          reasonCode: validation.reasonCode,
          issues: validation.issues,
          receivedAt: this.clock.now(),
          raw: safeQuarantineCopy(raw),
        };
        await this.quarantine.append(record);
        quarantined.push(record);
        continue;
      }

      const event = validation.event;
      const outcome = await this.events.append(
        event,
        eventSemanticFingerprint(event),
      );
      if (outcome.outcome === "appended") {
        acceptedEventIds.push(event.eventId);
      } else if (outcome.outcome === "duplicate") {
        duplicateEventIds.push(event.eventId);
      } else {
        const record: QuarantinedEvent = {
          quarantineId: this.ids.next("quarantine"),
          eventId: event.eventId,
          tenantId: event.tenantId,
          reasonCode: "idempotency_conflict",
          issues: [outcome.issue],
          receivedAt: this.clock.now(),
          raw: safeQuarantineCopy(raw),
        };
        await this.quarantine.append(record);
        quarantined.push(record);
      }
    }

    return { acceptedEventIds, duplicateEventIds, quarantined };
  }
}
