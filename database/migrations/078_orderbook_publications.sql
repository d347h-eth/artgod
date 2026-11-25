-- Several tracked ranges can share one verified OpenSea market on the same contract.
DROP INDEX collections_chain_opensea_slug_uq;
CREATE INDEX collections_market_scopes ON collections(chain_id,opensea_slug,address) WHERE opensea_slug IS NOT NULL;
CREATE TRIGGER collections_market_contract_insert BEFORE INSERT ON collections
 WHEN NEW.opensea_slug IS NOT NULL AND EXISTS (SELECT 1 FROM collections
 WHERE chain_id=NEW.chain_id AND opensea_slug=NEW.opensea_slug AND collection_id<>NEW.collection_id AND lower(address)<>lower(NEW.address))
 BEGIN SELECT RAISE(ABORT,'OpenSea market belongs to a different contract'); END;
CREATE TRIGGER collections_market_contract_update BEFORE UPDATE OF chain_id,opensea_slug,address ON collections
 WHEN NEW.opensea_slug IS NOT NULL AND EXISTS (SELECT 1 FROM collections
 WHERE chain_id=NEW.chain_id AND opensea_slug=NEW.opensea_slug AND collection_id<>NEW.collection_id AND lower(address)<>lower(NEW.address))
 BEGIN SELECT RAISE(ABORT,'OpenSea market belongs to a different contract'); END;
-- Feed generations and binding revisions have independent lifetimes.
CREATE TABLE orderbook_feeds (
  feed_id INTEGER PRIMARY KEY, chain_id INTEGER NOT NULL, venue TEXT NOT NULL,
  market TEXT NOT NULL, contract TEXT NOT NULL, view TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0, binding_revision INTEGER NOT NULL DEFAULT 0,
  accepted_binding_revision INTEGER, last_success_ms INTEGER, last_attempt_ms INTEGER, last_error TEXT, sequence INTEGER,
  UNIQUE(chain_id,venue,market,contract,view)
);
CREATE TABLE orderbook_bindings (
  feed_id INTEGER NOT NULL REFERENCES orderbook_feeds ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections ON DELETE CASCADE,
  PRIMARY KEY(feed_id,collection_id)
) WITHOUT ROWID;
CREATE INDEX orderbook_bindings_collection ON orderbook_bindings(collection_id,feed_id);
CREATE TRIGGER book_binding_added AFTER INSERT ON orderbook_bindings BEGIN
  UPDATE orderbook_feeds SET binding_revision=binding_revision+1,last_attempt_ms=NULL WHERE feed_id=NEW.feed_id;
END;
CREATE TRIGGER book_binding_removed AFTER DELETE ON orderbook_bindings BEGIN
  UPDATE orderbook_feeds SET binding_revision=binding_revision+1 WHERE feed_id=OLD.feed_id;
END;

CREATE TABLE orderbook_members (
  feed_id INTEGER NOT NULL REFERENCES orderbook_feeds ON DELETE CASCADE,
  native_id TEXT NOT NULL, placement TEXT NOT NULL, settlement_id TEXT,
  present INTEGER NOT NULL, eligible INTEGER NOT NULL, authority INTEGER NOT NULL, withdrawn INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL, observed_ms INTEGER NOT NULL,
  terms TEXT NOT NULL, record_json TEXT, route_price TEXT,
  collection_id INTEGER REFERENCES collections ON DELETE SET NULL,
  PRIMARY KEY(feed_id,native_id)
) WITHOUT ROWID;
CREATE INDEX orderbook_members_order ON orderbook_members(settlement_id,collection_id,present,eligible);
CREATE INDEX orderbook_members_placement ON orderbook_members(placement,authority,present);
CREATE INDEX orderbook_members_collection ON orderbook_members(collection_id);
CREATE TABLE orderbook_changes (
  feed_id INTEGER NOT NULL REFERENCES orderbook_feeds ON DELETE CASCADE,
  generation INTEGER NOT NULL, native_id TEXT NOT NULL, change TEXT NOT NULL, observed_ms INTEGER NOT NULL,
  PRIMARY KEY(feed_id,generation,native_id)
) WITHOUT ROWID;

ALTER TABLE orders ADD COLUMN remaining_quantity TEXT;
ALTER TABLE orders ADD COLUMN order_hash TEXT;
ALTER TABLE orders ADD COLUMN seller_proceeds TEXT;
ALTER TABLE orders ADD COLUMN required_fees TEXT;
ALTER TABLE orders ADD COLUMN winning_feed_id INTEGER REFERENCES orderbook_feeds ON DELETE SET NULL;
CREATE INDEX orders_protocol_lookup ON orders(chain_id,protocol_address,order_hash);
ALTER TABLE collections ADD COLUMN market_revision INTEGER NOT NULL DEFAULT 0;

-- Cover lifecycle, revalidation, purge, and stream writes as well as snapshots.
CREATE TRIGGER order_market_insert AFTER INSERT ON orders BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER order_market_change AFTER UPDATE OF state_revision,winning_feed_id,seller_proceeds,required_fees,source_status,fillability_status,price,currency,remaining_quantity ON orders
WHEN (OLD.state_revision,OLD.winning_feed_id,OLD.seller_proceeds,OLD.required_fees,OLD.source_status,OLD.fillability_status,OLD.price,OLD.currency,OLD.remaining_quantity)
  IS NOT (NEW.state_revision,NEW.winning_feed_id,NEW.seller_proceeds,NEW.required_fees,NEW.source_status,NEW.fillability_status,NEW.price,NEW.currency,NEW.remaining_quantity) BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id IN (NEW.collection_id,OLD.collection_id);
END;
CREATE TRIGGER order_market_delete AFTER DELETE ON orders BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=OLD.collection_id;
END;

CREATE TRIGGER book_scope_changed AFTER UPDATE OF token_scope_kind,scope_start_token_id,scope_total_supply,address,opensea_slug,opensea_status ON collections
WHEN (OLD.token_scope_kind,OLD.scope_start_token_id,OLD.scope_total_supply,OLD.address,OLD.opensea_slug) IS NOT
     (NEW.token_scope_kind,NEW.scope_start_token_id,NEW.scope_total_supply,NEW.address,NEW.opensea_slug) OR (OLD.opensea_status IS NULL)<>(NEW.opensea_status IS NULL) BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
 UPDATE orderbook_feeds SET binding_revision=binding_revision+1,last_attempt_ms=NULL
 WHERE feed_id IN (SELECT feed_id FROM orderbook_bindings WHERE collection_id=NEW.collection_id);
 DELETE FROM orderbook_bindings WHERE collection_id=NEW.collection_id AND feed_id IN (
   SELECT feed_id FROM orderbook_feeds WHERE contract<>lower(NEW.address) OR (venue='opensea' AND (market IS NOT NEW.opensea_slug OR NEW.opensea_status IS NULL)));
END;
CREATE TRIGGER book_token_scope_insert AFTER INSERT ON collection_scope_tokens BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
 UPDATE orderbook_feeds SET binding_revision=binding_revision+1,last_attempt_ms=NULL WHERE feed_id IN (SELECT feed_id FROM orderbook_bindings WHERE collection_id=NEW.collection_id);
END;
CREATE TRIGGER book_token_scope_delete AFTER DELETE ON collection_scope_tokens BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=OLD.collection_id;
 UPDATE orderbook_feeds SET binding_revision=binding_revision+1,last_attempt_ms=NULL WHERE feed_id IN (SELECT feed_id FROM orderbook_bindings WHERE collection_id=OLD.collection_id);
END;

CREATE INDEX orders_market_start ON orders(chain_id,collection_id,valid_from);
CREATE INDEX orders_market_expiry ON orders(chain_id,collection_id,valid_until);

-- A populated installation requires the coordinated broker/SQLite cutover.
-- Empty databases can start the new workers immediately.
CREATE TABLE orderbook_cutover (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), pending INTEGER NOT NULL, completed_ms INTEGER
);
INSERT INTO orderbook_cutover(singleton,pending) SELECT 1,
 EXISTS(SELECT 1 FROM orders) OR EXISTS(SELECT 1 FROM opensea_orderbook_runs) OR
 EXISTS(SELECT 1 FROM offchain_order_observations) OR EXISTS(SELECT 1 FROM market_order_retirements) OR
 EXISTS(SELECT 1 FROM market_order_observations) OR EXISTS(SELECT 1 FROM collections WHERE opensea_status IS NOT NULL) OR
 EXISTS(SELECT 1 FROM maker_order_revalidation_runs) OR EXISTS(SELECT 1 FROM queue_outbox WHERE job_kind LIKE 'orders.%');

-- Withdrawals affect relays of the same placement. A bot cancellation applies
-- to its exact OpenSea placement, including during an outage at that venue.
CREATE VIEW orderbook_eligible_routes AS
 SELECT m.*, json_extract(m.placement, '$[1]') AS venue
 FROM orderbook_members m JOIN orderbook_bindings b
 ON b.feed_id=m.feed_id AND b.collection_id=m.collection_id
 WHERE m.present=1 AND m.eligible=1 AND NOT EXISTS (
   SELECT 1 FROM orderbook_members a WHERE a.placement=m.placement
   AND a.authority=1 AND a.withdrawn=1 AND a.feed_id<>m.feed_id
   AND (m.authority=0 OR a.observed_ms>m.observed_ms) AND NOT EXISTS (
     SELECT 1 FROM orderbook_members r WHERE r.placement=a.placement AND
     r.authority=1 AND r.present=1 AND r.eligible=1 AND r.observed_ms>=a.observed_ms))
 AND (json_extract(m.placement,'$[1]')<>'opensea' OR NOT EXISTS (
   SELECT 1 FROM trading_bidding_order_cancellations c
   WHERE c.order_id=json_extract(m.record_json,'$.order.orderId')
   AND c.chain_id=json_extract(m.placement,'$[0]') AND c.collection_id=m.collection_id
   AND c.maker=json_extract(m.record_json,'$.order.maker')
   AND (c.protocol_address IS NULL OR lower(c.protocol_address)=lower(json_extract(m.record_json,'$.order.seaportData.protocolAddress')))
   AND c.completed_at IS NOT NULL AND c.cancellation_error IS NULL))
 ORDER BY CASE WHEN json_extract(m.record_json,'$.order.side')='buy' THEN -length(m.route_price) ELSE length(m.route_price) END,
 CASE WHEN json_extract(m.record_json,'$.order.side')='buy' THEN m.route_price END DESC,
 m.route_price,m.authority DESC,m.feed_id,m.native_id;

-- A local cancellation may arrive between reads. Feed evidence is retained;
-- recompute the affected bid immediately using the publication's route selector.
CREATE TRIGGER book_cancellation_insert AFTER INSERT ON trading_bidding_order_cancellations
 WHEN NEW.completed_at IS NOT NULL AND NEW.cancellation_error IS NULL BEGIN
 UPDATE orders SET (winning_feed_id,source,seller_proceeds,required_fees,source_status)=(
   SELECT r.feed_id,r.venue,r.route_price,json_extract(r.record_json,'$.fees'),
     CASE WHEN r.feed_id IS NULL THEN 'inactive' ELSE 'active' END
   FROM (SELECT 1) LEFT JOIN
   (SELECT * FROM orderbook_eligible_routes WHERE settlement_id=orders.id LIMIT 1) r)
 WHERE order_hash=NEW.order_id AND chain_id=NEW.chain_id AND collection_id=NEW.collection_id
 AND maker=NEW.maker AND side='buy' AND source='opensea' AND source_status='active'
 AND (NEW.protocol_address IS NULL OR lower(NEW.protocol_address)=lower(protocol_address));
END;
CREATE TRIGGER book_cancellation_update AFTER UPDATE OF completed_at,cancellation_error ON trading_bidding_order_cancellations
 WHEN NEW.completed_at IS NOT NULL AND NEW.cancellation_error IS NULL BEGIN
 UPDATE orders SET (winning_feed_id,source,seller_proceeds,required_fees,source_status)=(
   SELECT r.feed_id,r.venue,r.route_price,json_extract(r.record_json,'$.fees'),
     CASE WHEN r.feed_id IS NULL THEN 'inactive' ELSE 'active' END
   FROM (SELECT 1) LEFT JOIN
   (SELECT * FROM orderbook_eligible_routes WHERE settlement_id=orders.id LIMIT 1) r)
 WHERE order_hash=NEW.order_id AND chain_id=NEW.chain_id AND collection_id=NEW.collection_id
 AND maker=NEW.maker AND side='buy' AND source='opensea' AND source_status='active'
 AND (NEW.protocol_address IS NULL OR lower(NEW.protocol_address)=lower(protocol_address));
END;

CREATE INDEX orders_book_bid_scopes ON orders(chain_id,collection_id,source_scope_kind,token_id)
 WHERE side='buy' AND source_status='active' AND fillability_status='fillable';
CREATE INDEX orderbook_changes_age ON orderbook_changes(observed_ms);
CREATE INDEX orderbook_absent_age ON orderbook_members(observed_ms) WHERE present=0;
CREATE TRIGGER book_tokens_insert AFTER INSERT ON tokens BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_tokens_delete AFTER DELETE ON tokens BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=OLD.collection_id;
END;
CREATE TRIGGER book_nft_balances_insert AFTER INSERT ON nft_balances BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_nft_balances_delete AFTER DELETE ON nft_balances BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=OLD.collection_id;
END;
CREATE TRIGGER book_nft_balances_update AFTER UPDATE OF amount ON nft_balances WHEN NEW.amount IS NOT OLD.amount BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_token_attributes_insert AFTER INSERT ON token_attributes BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_token_attributes_delete AFTER DELETE ON token_attributes BEGIN
 UPDATE collections SET market_revision=market_revision+1 WHERE collection_id=OLD.collection_id;
END;
