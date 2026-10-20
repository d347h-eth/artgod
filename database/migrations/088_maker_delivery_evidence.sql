-- Independent/null-payload runs belong to the unsupported pre-cutover format.
-- Remove only that format and its linked wakeups so old unique identities cannot
-- obstruct current admission. Do not reinterpret or reconstruct its obligations.
DELETE FROM queue_outbox
WHERE outbox_id IN (
    SELECT wakeup_outbox_id FROM maker_order_revalidation_runs
    WHERE scope_key IS NULL
       OR source_payload_json IS NULL
       OR requested_payload_json IS NULL
);
DELETE FROM maker_order_revalidation_runs
WHERE scope_key IS NULL
   OR source_payload_json IS NULL
   OR requested_payload_json IS NULL;

-- Current admissions already retain every origin in the per-consumer table.
-- Keep its independent stream/ACK proofs, including main and gap consumers.
DROP INDEX maker_order_revalidation_completed;
ALTER TABLE maker_order_revalidation_runs DROP COLUMN origin_stream_id;
ALTER TABLE maker_order_revalidation_runs DROP COLUMN origin_consumer;
ALTER TABLE maker_order_revalidation_runs DROP COLUMN origin_sequence;
