/**
 * Custom audit delivery failed after a successful database commit.
 * Do not retry the business transaction: its changes are already committed.
 * Delivery may have partially succeeded; recovery needs an idempotent writer.
 */
export class AuditDeliveryError extends Error {
  readonly code = "AUDIT_DELIVERY_FAILED_AFTER_COMMIT";
  readonly committed = true;

  constructor(
    readonly transactionId: string,
    cause: unknown,
  ) {
    super(
      "Database transaction committed, but custom audit delivery failed. Do not retry the transaction.",
      { cause },
    );
    this.name = "AuditDeliveryError";
  }
}
