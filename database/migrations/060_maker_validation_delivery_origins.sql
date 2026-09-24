-- A maker pass can be awakened by legacy and targeted consumers. Their ACK
-- floors are independent. Keep one high-water delivery receipt per consumer.
CREATE TABLE maker_validation_delivery_origins (
    run_id TEXT NOT NULL REFERENCES maker_order_revalidation_runs(run_id) ON DELETE CASCADE,
    consumer_name TEXT NOT NULL,
    stream_id TEXT NOT NULL,
    maximum_sequence INTEGER NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
    PRIMARY KEY (run_id, consumer_name)
);
CREATE INDEX maker_validation_unacknowledged
    ON maker_validation_delivery_origins(consumer_name, stream_id, maximum_sequence)
    WHERE acknowledged = 0;
DROP INDEX maker_validation_coverage_cleanup;
-- Legacy inline origins are copied lazily with each touched/cleaned run, avoiding
-- an unbounded migration rewrite on existing installations.
