# Token Sets + Multi‑Trait Offers (Plan)

This doc captures the focused plan to add **fully‑featured token sets** and **multi‑trait (AND) criteria offers**, based on `docs/blueprint/08-token-sets-and-multi-trait-orders.md`. This work is a prerequisite for OpenSea collection/trait offers and must be done before we can claim correct behavior for criteria orders.

---

## Why This Is Required

- OpenSea collection and trait offers are **criteria orders** (Seaport token‑list orders).
- Criteria orders reference a **merkle root** in `identifierOrCriteria`.
- To validate and ingest these orders correctly, we must:
    - Compute membership based on traits (AND semantics).
    - Compute the merkle root from the membership list.
    - Persist token sets and link orders by `token_set_id` + `schema_hash`.

---

## Dependencies (Must Do First)

### 1) Normalized token + trait storage

We cannot resolve token‑set membership without normalized traits.

Required tables:

- `tokens`
- `attribute_keys`
- `attributes`
- `token_attributes`

Required pipeline:

- Parse `token_metadata.attributes_json`.
- Normalize keys/values (trim, stable casing).
- Upsert `attribute_keys`, `attributes`, `token_attributes`.
- Ensure `tokens` rows exist for each token.

This is a partial pull‑forward of the “Metadata Enhancements” phase.

---

## Token‑Set Core (Full‑Featured)

### 2) Token‑set schema + hash

Use the blueprint schema:

```json
{
    "kind": "attribute",
    "data": {
        "collection": "<collection>",
        "attributes": [{ "key": "...", "value": "..." }]
    }
}
```

Rules:

- **Dedup + sort** attributes before hashing.
- `schema_hash = sha256(stable-json(schema))`.

### 3) Membership resolution (AND semantics)

Use the AND‑intersection query:

```
WHERE collection_id = $collection
  AND ((key = k1 AND value = v1) OR (key = k2 AND value = v2) ...)
GROUP BY token_id
HAVING COUNT(DISTINCT (key, value)) = <num_traits>
```

### 4) Merkle root

Compute merkle root over tokenIds:

- TokenIds must be sorted deterministically.
- Root must match Seaport `identifierOrCriteria`.

### 5) Persistence

Tables:

- `token_sets` (id, schema_hash, schema_json, collection_id, attribute_id?)
- `token_sets_tokens` (token_set_id, contract, token_id)

`token_set_id` format:

- `list:<contract>:<merkleRoot>`

Orders must link to **both**:

- `token_set_id`
- `token_set_schema_hash`

---

## Orders Integration

### 6) Orders schema updates

Add to `orders`:

- `token_set_id` (nullable)
- `token_set_schema_hash` (nullable)

For criteria orders:

- `token_id` should be nullable or a sentinel (decide before implementation).

### 7) OpenSea normalizer changes

For `collection_offer` + `trait_offer`:

1. Build schema (with sorted/deduped traits).
2. Resolve token‑set membership and merkle root.
3. Populate `token_set_id` + `token_set_schema_hash` in order upsert.

---

## Validation (Criteria Orders)

During offchain validation:

- Compare the order’s `identifierOrCriteria` to computed `token_set_id` root.
- If mismatch → `fillability_status = invalid`.

---

## Tests (Required)

- Schema hash stability (dedupe + sort)
- AND‑membership query correctness
- Merkle root determinism
- Trait‑offer fixture → token_set rows + order linking

---

## Notes / Decisions Needed

1. `token_id` handling for collection/trait offers:
    - `NULL` (preferred if we can alter schema) vs
    - sentinel string like `criteria`.

2. Trait normalization rules:
    - Key/value lowercasing?
    - Trim whitespace?
    - Decide now to avoid re‑hashing later.

---

## Implementation Status (Current)

### ✅ Schema + persistence

- Added normalized trait tables (`tokens`, `attribute_keys`, `attributes`, `token_attributes`) and token‑set tables (`token_sets`, `token_sets_tokens`).
- Orders now accept `token_set_id` + `token_set_schema_hash` and allow `token_id` to be NULL for criteria orders.

### ✅ Metadata → traits normalization

- Metadata sync now upserts token rows and normalizes traits into `attribute_keys`, `attributes`, `token_attributes`.
- Token attributes are rewritten on every metadata refresh to keep membership accurate.
- Trait normalization trims whitespace but preserves original casing (no lowercase folding yet).

### ✅ Token‑set registry

- Added a sqlite token‑set registry that:
    - Normalizes/dedupes/sorts attributes.
    - Computes schema hash (`sha256(stable-json)`).
    - Computes merkle root via Seaport‑compatible merkle tree logic.
    - Persists token sets and token membership rows.
    - Falls back to the criteria root in the order payload if membership is empty (with logging).

### ✅ OpenSea normalizers

- `collection_offer` + `trait_offer` now normalize into criteria orders and emit a token‑set schema.
- The ingest worker resolves/persists token sets and populates `token_set_id` + `token_set_schema_hash`.

### 🔎 Known limitations

- Criteria root parsing fails when the OpenSea payload provides it as a non‑decimal float (scientific notation).
- If metadata coverage is incomplete, token‑set membership may be empty; we currently fall back to the payload’s criteria root.

---

## Source References (Blueprint)

- `docs/blueprint/08-token-sets-and-multi-trait-orders.md`
