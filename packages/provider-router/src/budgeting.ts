import type { Money } from "@course-ai/contracts";
import type {
  CostReservation,
  CostReservationDecision,
  CostReservationRequest,
  CostReservationService,
} from "./types.js";

function sameMoney(left: Money, right: Money): boolean {
  return (
    left.amount === right.amount && left.currency === right.currency
  );
}

/**
 * Deterministic fixture and single-process guard. Production must replace this
 * with a transactional budget reservation service.
 */
export class InMemoryCostReservationService
  implements CostReservationService
{
  readonly #reservations = new Map<string, CostReservation>();

  async reserve(
    request: CostReservationRequest,
  ): Promise<CostReservationDecision> {
    const existing = this.#reservations.get(request.reservationId);
    if (existing !== undefined) {
      if (!sameMoney(existing.reservedCost, request.estimatedCost)) {
        return { authorized: false, reasonCode: "conflict" };
      }
      return { authorized: true, reservation: existing };
    }
    const reservation: CostReservation = {
      reservationId: request.reservationId,
      reservedCost: request.estimatedCost,
      status: "reserved",
    };
    this.#reservations.set(request.reservationId, reservation);
    return { authorized: true, reservation };
  }

  async commit(reservationId: string, actualCost: Money): Promise<void> {
    const existing = this.#reservations.get(reservationId);
    if (existing === undefined) {
      throw new Error("Cannot commit an unknown cost reservation.");
    }
    if (existing.reservedCost.currency !== actualCost.currency) {
      throw new Error("Reservation and actual cost currencies differ.");
    }
    this.#reservations.set(reservationId, {
      ...existing,
      status: "committed",
    });
  }

  async release(reservationId: string): Promise<void> {
    const existing = this.#reservations.get(reservationId);
    if (existing === undefined) {
      return;
    }
    this.#reservations.set(reservationId, {
      ...existing,
      status: "released",
    });
  }

  get(reservationId: string): CostReservation | undefined {
    return this.#reservations.get(reservationId);
  }
}
