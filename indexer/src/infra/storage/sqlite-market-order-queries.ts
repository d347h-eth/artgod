import {
    ORDER_SOURCE_STATUS as SOURCE,
    ORDER_STATUS as STATUS,
} from "../../domain/orders.js";

const terminal = `source_status IN ('${SOURCE.Filled}','${SOURCE.Cancelled}') OR fillability_status IN ('${STATUS.Filled}','${STATUS.Cancelled}')`;
const inactive = `source_status='${SOURCE.Inactive}'`;
const fields =
    "id,chain_id,collection_id,valid_until,source_status,fillability_status,observed_at,updated_at,block_number";

/** Installed by exclusive startup recovery, never by periodic maintenance. */
export const MARKET_ORDER_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS orders_expiry_idx ON orders(valid_until) WHERE valid_until IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_terminal_cleanup_idx ON orders(updated_at,id) WHERE ${terminal};
CREATE INDEX IF NOT EXISTS orders_inactive_cleanup_idx ON orders(updated_at,id) WHERE ${inactive};
CREATE INDEX IF NOT EXISTS orders_undated_cleanup_idx ON orders(observed_at,id) WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS activities_listing_day_refresh_idx ON activities(listing_day,id) WHERE listing_day IS NOT NULL;
DROP INDEX IF EXISTS orders_maker_revalidation_candidates_idx;
CREATE INDEX orders_maker_revalidation_candidates_idx ON orders(chain_id,maker,source_status,id) WHERE kind='seaport' AND seaport_data_json IS NOT NULL;
DROP INDEX IF EXISTS orders_maker_collection_revalidation_idx;
CREATE INDEX orders_maker_collection_revalidation_idx ON orders(chain_id,maker,collection_id,source_status,id) WHERE kind='seaport' AND side='sell' AND seaport_data_json IS NOT NULL;
`;

/** Separate indexed families avoid an OR across the entire active orderbook. */
export const MARKET_ORDER_CLEANUP_QUERIES = [
    `SELECT ${fields} FROM orders WHERE valid_until<=@now ORDER BY valid_until LIMIT @limit`,
    `SELECT ${fields} FROM orders WHERE (${terminal}) AND updated_at<=datetime(@terminalBefore,'unixepoch') ORDER BY updated_at,id LIMIT @limit`,
    `SELECT ${fields} FROM orders WHERE ${inactive} AND updated_at<=datetime(@inactiveBefore,'unixepoch') ORDER BY updated_at,id LIMIT @limit`,
    `SELECT ${fields} FROM orders WHERE valid_until IS NULL AND observed_at<=@unknownBefore AND NOT EXISTS(SELECT 1 FROM market_order_observations mo WHERE mo.chain_id=orders.chain_id AND mo.collection_id=orders.collection_id AND mo.observed_at>@unknownBefore) ORDER BY observed_at,id LIMIT @limit`,
] as const;
