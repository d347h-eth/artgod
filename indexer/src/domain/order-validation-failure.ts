/** Infrastructure uncertainty cannot be recorded as a protocol-invalid order. */
export class OrderValidationSnapshotUnavailable extends Error {
    constructor(message: string, cause?: unknown) {
        super(message, { cause });
        this.name = "OrderValidationSnapshotUnavailable";
    }
}

/** An order-scoped read failed, not a definitive invalidity result. Shared reads,
 * storage and snapshot verification never carry an order handoff identity. */
export class OrderValidationReadUnavailable extends OrderValidationSnapshotUnavailable {
    constructor(
        readonly orderId: string,
        cause: unknown,
    ) {
        super("Order-scoped validation read failed", cause);
        this.name = "OrderValidationReadUnavailable";
    }
}
