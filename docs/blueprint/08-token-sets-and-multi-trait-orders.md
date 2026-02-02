# Token Sets + Multi‑Trait Orders (Reference Blueprint)

This document captures how token sets are represented, persisted, and linked to orders, with special focus on **multi‑trait (AND) criteria orders**. It is written as a reference implementation and uses relative paths from this repository for file lookups.

---

## 1) Core tables and relationships

### token_sets
File: `packages/indexer/src/migrations/1643803474513_token-sets.sql`

Primary key:
- `(id, schema_hash)`

Relevant columns:
- `id` (TEXT) — canonical token set id
- `schema_hash` (BYTEA) — sha256(stable JSON) of the schema
- `schema` (JSONB) — declarative definition of the set
- `collection_id` (TEXT) — collection reference
- `attribute_id` (BIGINT) — only set for single‑trait sets
- `metadata` (JSONB) — includes cached merkle root for dynamic sets

### token_sets_tokens
File: `packages/indexer/src/migrations/1643803474513_token-sets.sql`

Primary key:
- `(token_set_id, contract, token_id)`

Purpose:
- Many‑to‑many bridge between **token_sets** and **tokens**.
- Stores explicit membership list for list‑based sets.

### orders
File: `packages/indexer/src/migrations/1643809164129_orders.sql`

Relevant columns:
- `token_set_id` (TEXT)
- `token_set_schema_hash` (BYTEA)

Orders join to token sets by **both** fields.

### token_attributes, attributes, attribute_keys
Files:
- `packages/indexer/src/migrations/1646736672602_attributes.sql`

These back attribute/trait data and are used to compute membership for attribute‑based token sets.

---

## 2) Normalized relationships

- `token_sets (id, schema_hash)` → `token_sets_tokens (token_set_id)`
  - **1‑to‑many**

- `tokens (contract, token_id)` → `token_sets_tokens (contract, token_id)`
  - **1‑to‑many**

- `token_sets` ↔ `tokens` via `token_sets_tokens`
  - **many‑to‑many**

- `token_sets.collection_id` → `collections.id`
  - **many‑to‑one**

- `token_sets.attribute_id` → `attributes.id`
  - **many‑to‑one**, **only for single‑trait sets**

---

## 3) Schema hash vs merkle root

### schema_hash
File: `packages/indexer/src/orderbook/orders/utils.ts`

- `schema_hash = sha256(stable-json(schema))`
- Fingerprints **how** the set is defined.
- Stored in token_sets, copied into orders as `token_set_schema_hash`.
- Prevents mismatches if a token_set_id is reused for a different schema.

### merkle root
Used for criteria orders (Seaport token‑list). It fingerprints **membership**.

Key usages:
1) **Order building**
   - `packages/indexer/src/orderbook/orders/seaport-base/build/buy/collection.ts`
   - `packages/indexer/src/orderbook/orders/seaport-base/build/buy/attribute.ts`
   - The builder must include `merkleRoot` in order params (`identifierOrCriteria`).

2) **Order ingestion (token_set_id derivation)**
   - `packages/indexer/src/orderbook/orders/seaport-v1.1/index.ts`
   - `packages/indexer/src/orderbook/orders/seaport-v1.4/index.ts`
   - `packages/indexer/src/orderbook/orders/seaport-v1.5/index.ts`
   - `packages/indexer/src/orderbook/orders/seaport-v1.6/index.ts`

   When `kind === "token-list"`, a `merkleRoot` is read from the order and used to set:
   ```
   token_set_id = list:<contract>:<merkleRoot>
   ```

3) **Token set validation**
   - `packages/indexer/src/orderbook/token-sets/token-list/index.ts`

   Schema → tokens → merkle root → `schemaId`.
   Validation ensures:
   ```
   schemaId === token_set_id
   ```

4) **Dynamic sets caching**
   - `packages/indexer/src/orderbook/token-sets/dynamic/collection-non-flagged.ts`

   Merkle root is cached under `token_sets.metadata.merkleRoot` for refresh/checks.

**Conclusion:** Merkle root is not just for uniqueness; it is **the canonical criteria root** used by Seaport token‑list orders and must match the token list implied by the schema.

---

## 4) Token‑list schema (attribute criteria)

A token‑list for traits uses a schema like:

```json
{
  "kind": "attribute",
  "data": {
    "collection": "<collection_id>",
    "attributes": [
      { "key": "Biome", "value": "81" },
      { "key": "Mode", "value": "Terrain" }
    ]
  }
}
```

Files:
- Schema type: `packages/indexer/src/orderbook/token-sets/utils.ts`
- Validation + membership: `packages/indexer/src/orderbook/token-sets/token-list/index.ts`

Multi‑trait schemas are now supported via `attributes: {key, value}[]`.

---

## 5) Multi‑trait (AND) criteria logic

### OpenSea WS parsing
File: `packages/indexer/src/websockets/opensea/handlers/trait_offer.ts`

- Uses `trait_criteria` if present; otherwise `trait_criteria_list`.
- Dedupes and **sorts** attributes to ensure stable schema hashing.
- Emits `attributes[]` in `OpenseaOrderParams`.

### Token set derivation (AND semantics)
Files:
- `packages/indexer/src/orderbook/orders/seaport-v1.1/index.ts`
- `packages/indexer/src/orderbook/orders/seaport-v1.4/index.ts`
- `packages/indexer/src/orderbook/orders/seaport-v1.5/index.ts`
- `packages/indexer/src/orderbook/orders/seaport-v1.6/index.ts`

The query uses OR filters plus a HAVING clause:

```sql
WHERE collection_id = $collection
  AND ((key = k1 AND value = v1) OR (key = k2 AND value = v2) ...)
GROUP BY token_id
HAVING COUNT(DISTINCT (key, value)) = <num_traits>
```

This enforces **intersection** (AND) across all traits.

### Token set validation
File: `packages/indexer/src/orderbook/token-sets/token-list/index.ts`

- Recomputes membership using the same AND query.
- Recomputes merkle root and validates token_set_id.

---

## 6) Exact rows written for multi‑trait token‑list

1) **token_sets**
   - `id`: `list:<contract>:<merkleRoot>`
   - `schema_hash`: sha256(schema)
   - `schema`: JSON (all traits)
   - `collection_id`: collection
   - `attribute_id`: NULL (multi‑trait)

2) **token_sets_tokens**
   - One row per token in the set:
     `(token_set_id, contract, token_id)`

3) **orders**
   - `token_set_id` and `token_set_schema_hash` filled
   - Join to token_sets uses **both** columns

---

## 7) Why both token_set_id and schema_hash are required

- `token_set_id` is derived from merkle root (membership).
- `schema_hash` is derived from schema (definition).
- Using both ensures:
  - membership and schema are consistent
  - accidental collisions are prevented
  - orders remain linked to the exact schema used to compute the set

---

## 8) Notes for greenfield implementation

- Treat token‑list criteria as **first‑class sets**: they must be persisted and validated.
- **Sort and dedupe** trait attributes before hashing.
- The merkle root is a contract‑level criteria root (Seaport); do not drop it.
- Multi‑trait criteria must use AND semantics; avoid OR or "first trait" shortcuts.
- Persist both the **schema hash** and the **merkle‑root‑based set id**.

---

## 9) Suggested quick verification queries

Confirm token set rows exist:
```sql
SELECT id, schema_hash, schema, collection_id, attribute_id
FROM token_sets
WHERE id = 'list:<contract>:<merkleRoot>';
```

Confirm membership:
```sql
SELECT token_id
FROM token_sets_tokens
WHERE token_set_id = 'list:<contract>:<merkleRoot>'
ORDER BY token_id
LIMIT 20;
```

Confirm order link:
```sql
SELECT id, token_set_id, token_set_schema_hash
FROM orders
WHERE token_set_id = 'list:<contract>:<merkleRoot>'
LIMIT 20;
```

---

## 10) Primary reference files

- Token set schema + types:
  - `packages/indexer/src/orderbook/token-sets/utils.ts`

- Token list validation + persistence:
  - `packages/indexer/src/orderbook/token-sets/token-list/index.ts`

- Dynamic collection set (merkle root caching):
  - `packages/indexer/src/orderbook/token-sets/dynamic/collection-non-flagged.ts`

- OpenSea WS trait offers:
  - `packages/indexer/src/websockets/opensea/handlers/trait_offer.ts`

- Seaport order ingestion (token‑list paths):
  - `packages/indexer/src/orderbook/orders/seaport-v1.1/index.ts`
  - `packages/indexer/src/orderbook/orders/seaport-v1.4/index.ts`
  - `packages/indexer/src/orderbook/orders/seaport-v1.5/index.ts`
  - `packages/indexer/src/orderbook/orders/seaport-v1.6/index.ts`

- Order build path (merkle root injection):
  - `packages/indexer/src/orderbook/orders/seaport-base/build/buy/collection.ts`
  - `packages/indexer/src/orderbook/orders/seaport-base/build/buy/attribute.ts`

- Migrations:
  - `packages/indexer/src/migrations/1643803474513_token-sets.sql`
  - `packages/indexer/src/migrations/1643809164129_orders.sql`
  - `packages/indexer/src/migrations/1646736672602_attributes.sql`
