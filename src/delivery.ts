/** An ambiguous transport mutation must never be retried as a known rejection. */
export class DeliveryError extends Error {
  constructor(message: string, public readonly certainty: "rejected" | "uncertain" = "uncertain", public readonly retryAfterMs?: number, options?: ErrorOptions) {
    super(message, options);
    this.name = "DeliveryError";
  }
}
