-- One protocol order may be executable in several local collection ranges.
-- Each association needs its own proven token set while funding and quantity
-- remain on the single settlement row.
CREATE TABLE orderbook_offer_scopes (
    feed_id INTEGER NOT NULL,
    native_id TEXT NOT NULL,
    collection_id INTEGER NOT NULL,
    token_set_id TEXT NOT NULL,
    schema_hash TEXT NOT NULL,
    PRIMARY KEY (feed_id, native_id, collection_id),
    FOREIGN KEY (feed_id, native_id) REFERENCES orderbook_members ON DELETE CASCADE,
    FOREIGN KEY (feed_id, collection_id) REFERENCES orderbook_bindings ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX orders_book_bid_maker ON orders(chain_id,collection_id,lower(maker),source_scope_kind,token_id)
    WHERE side='buy' AND source_status='active' AND fillability_status='fillable';
CREATE INDEX orders_winning_offer_scope ON orders(winning_feed_id,collection_id) WHERE token_id IS NULL;
CREATE INDEX orderbook_offer_scopes_collection
    ON orderbook_offer_scopes(collection_id,feed_id,native_id);

-- Move the validation owner before cascading a detached association. A purge
-- can then delete the former collection's rows without retiring a shared bid.
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
        WHERE m.feed_id=OLD.feed_id AND m.settlement_id=orders.id AND m.collection_id<>OLD.collection_id LIMIT 1
    ) WHERE collection_id=OLD.collection_id AND winning_feed_id=OLD.feed_id AND token_id IS NULL AND EXISTS (
        SELECT 1 FROM orderbook_members m WHERE m.feed_id=OLD.feed_id AND m.settlement_id=orders.id AND m.collection_id<>OLD.collection_id
    );
END;

-- Invalidate the affected local proof immediately when its declared scope changes.
CREATE TRIGGER book_offer_scope_definition AFTER UPDATE OF token_scope_kind,scope_start_token_id,scope_total_supply ON collections
WHEN (OLD.token_scope_kind,OLD.scope_start_token_id,OLD.scope_total_supply) IS NOT
     (NEW.token_scope_kind,NEW.scope_start_token_id,NEW.scope_total_supply) BEGIN
    DELETE FROM orderbook_offer_scopes WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_offer_scope_token_added AFTER INSERT ON collection_scope_tokens BEGIN
    DELETE FROM orderbook_offer_scopes WHERE collection_id=NEW.collection_id;
END;
CREATE TRIGGER book_offer_scope_token_removed AFTER DELETE ON collection_scope_tokens BEGIN
    DELETE FROM orderbook_offer_scopes WHERE collection_id=OLD.collection_id;
END;
CREATE TRIGGER book_offer_revision AFTER UPDATE OF state_revision,source_status,fillability_status,remaining_quantity,winning_feed_id,seller_proceeds ON orders
WHEN OLD.token_id IS NULL AND (OLD.state_revision,OLD.source_status,OLD.fillability_status,OLD.remaining_quantity,OLD.winning_feed_id,OLD.seller_proceeds)
    IS NOT (NEW.state_revision,NEW.source_status,NEW.fillability_status,NEW.remaining_quantity,NEW.winning_feed_id,NEW.seller_proceeds) BEGIN
    UPDATE collections SET market_revision=market_revision+1 WHERE collection_id IN (
        SELECT s.collection_id FROM orderbook_members m JOIN orderbook_offer_scopes s USING(feed_id,native_id)
        WHERE m.settlement_id=NEW.id AND s.collection_id<>NEW.collection_id
    );
END;
