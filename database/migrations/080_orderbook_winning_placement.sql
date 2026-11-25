-- One feed can describe the same signed order under several native IDs.
-- Store the exact selected publication with the settlement so scopes, price
-- and observation time are always read from the same route.
ALTER TABLE orders ADD COLUMN winning_native_id TEXT;
CREATE INDEX orderbook_withdrawn_placements ON orderbook_members(placement,observed_ms)
    WHERE authority=1 AND withdrawn=1;
-- There are few placements per signed order and many orders per feed. Start
-- each backfill lookup at its settlement and test the stored feed there.
UPDATE orders SET winning_native_id=(
    SELECT native_id FROM orderbook_eligible_routes
    WHERE settlement_id=orders.id AND likely(feed_id=orders.winning_feed_id) LIMIT 1
) WHERE winning_feed_id IS NOT NULL;

DROP TRIGGER book_cancellation_insert;
DROP TRIGGER book_cancellation_update;
DROP TRIGGER book_rehome_offer;

CREATE TRIGGER book_cancellation_insert AFTER INSERT ON trading_bidding_order_cancellations
 WHEN NEW.completed_at IS NOT NULL AND NEW.cancellation_error IS NULL BEGIN
 UPDATE orders SET (winning_feed_id,winning_native_id,source,seller_proceeds,required_fees,source_status)=(
   SELECT r.feed_id,r.native_id,r.venue,r.route_price,json_extract(r.record_json,'$.fees'),
     CASE WHEN r.feed_id IS NULL THEN 'inactive' ELSE 'active' END
   FROM (SELECT 1) LEFT JOIN
   (SELECT * FROM orderbook_eligible_routes WHERE settlement_id=orders.id LIMIT 1) r)
 WHERE order_hash=NEW.order_id AND chain_id=NEW.chain_id
 AND EXISTS (SELECT 1 FROM orderbook_bindings controlled
     WHERE controlled.feed_id=orders.winning_feed_id AND controlled.collection_id=NEW.collection_id)
 AND maker=NEW.maker AND side='buy' AND source='opensea' AND source_status='active'
 AND (NEW.protocol_address IS NULL OR lower(NEW.protocol_address)=lower(protocol_address));
END;
CREATE TRIGGER book_cancellation_update AFTER UPDATE OF completed_at,cancellation_error ON trading_bidding_order_cancellations
 WHEN NEW.completed_at IS NOT NULL AND NEW.cancellation_error IS NULL BEGIN
 UPDATE orders SET (winning_feed_id,winning_native_id,source,seller_proceeds,required_fees,source_status)=(
   SELECT r.feed_id,r.native_id,r.venue,r.route_price,json_extract(r.record_json,'$.fees'),
     CASE WHEN r.feed_id IS NULL THEN 'inactive' ELSE 'active' END
   FROM (SELECT 1) LEFT JOIN
   (SELECT * FROM orderbook_eligible_routes WHERE settlement_id=orders.id LIMIT 1) r)
 WHERE order_hash=NEW.order_id AND chain_id=NEW.chain_id
 AND EXISTS (SELECT 1 FROM orderbook_bindings controlled
     WHERE controlled.feed_id=orders.winning_feed_id AND controlled.collection_id=NEW.collection_id)
 AND maker=NEW.maker AND side='buy' AND source='opensea' AND source_status='active'
 AND (NEW.protocol_address IS NULL OR lower(NEW.protocol_address)=lower(protocol_address));
END;

CREATE TRIGGER book_rehome_offer BEFORE DELETE ON orderbook_bindings BEGIN
    UPDATE collections SET market_revision=market_revision+1 WHERE collection_id IN
        (SELECT collection_id FROM orderbook_bindings WHERE feed_id=OLD.feed_id);
    UPDATE orderbook_members SET collection_id=(
        SELECT MIN(s.collection_id) FROM orderbook_offer_scopes s
        WHERE s.feed_id=orderbook_members.feed_id AND s.native_id=orderbook_members.native_id AND s.collection_id<>OLD.collection_id
    ) WHERE feed_id=OLD.feed_id AND collection_id=OLD.collection_id AND EXISTS (
        SELECT 1 FROM orderbook_offer_scopes s WHERE s.feed_id=orderbook_members.feed_id AND s.native_id=orderbook_members.native_id AND s.collection_id<>OLD.collection_id
    );
    UPDATE orders SET (collection_id,token_set_id,token_set_schema_hash)=(
        SELECT s.collection_id,s.token_set_id,s.schema_hash FROM orderbook_members m
        JOIN orderbook_offer_scopes s USING(feed_id,native_id,collection_id)
        WHERE m.feed_id=OLD.feed_id AND m.native_id=orders.winning_native_id AND m.settlement_id=orders.id AND m.collection_id<>OLD.collection_id LIMIT 1
    ) WHERE collection_id=OLD.collection_id AND winning_feed_id=OLD.feed_id AND token_id IS NULL AND EXISTS (
        SELECT 1 FROM orderbook_members m WHERE m.feed_id=OLD.feed_id AND m.native_id=orders.winning_native_id AND m.settlement_id=orders.id AND m.collection_id<>OLD.collection_id
    );
END;

CREATE TRIGGER book_winning_member_revision AFTER UPDATE OF winning_native_id ON orders
WHEN OLD.winning_feed_id=NEW.winning_feed_id AND OLD.winning_native_id IS NOT NEW.winning_native_id BEGIN
    UPDATE collections SET market_revision=market_revision+1 WHERE collection_id IN (
        SELECT collection_id FROM orderbook_bindings WHERE feed_id=NEW.winning_feed_id
    );
END;
