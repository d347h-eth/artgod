# Deferred: Chain Identity Refactor (Internal PK vs Public Chain ID)

This document captures a **deferred** refactor to make multi-chain ingest safe and explicit by separating internal chain identity from public network chain IDs. The goal is to support multiple inbound orderbook streams (OpenSea, Blur, etc.) and prevent cross-chain collisions while keeping a single shared data model.

---

## Motivation

- Offchain payloads can include **chain identifiers** (name/slug or public chain ID), but internal storage should use a single **canonical internal reference**.
- Multiple streams can emit orders for different chains; relying on implicit chain scoping is fragile.
- Long-term, ArtGod may support non‑EVM chains, so we should not treat “chain_id” as both internal PK and external network ID.

---

## Terminology (Future)

- **`chain_pk`**: internal chain primary key (local to ArtGod instance).
- **`public_chain_id`**: canonical external chain ID (EVM chain ID like 1, 10, 137).
- **`chain_name` / `slug`**: human-friendly identifiers used by external sources and UI.

**Naming policy (future refactor):**

- All _internal_ tables should use `chain_pk`.
- All references to _external_ IDs should be named `public_chain_id`.
- Any inbound payload chain mapping must resolve to `chain_pk`.

---

## Proposed Schema (Chains Table)

Table: `chains`

- `id` (PK, internal) **→ referenced as `chain_pk` in all other tables**
- `type` (`"evm"` for now)
- `public_chain_id` (EVM chain ID)
- `slug` (UI/URL slug)
- `name` (human-readable)

Constraints (recommended):

- `UNIQUE (type, public_chain_id)`
- `UNIQUE (type, slug)`

---

## Mapping Strategy (Inbound Payloads)

### OpenSea (example)

Payload `chain` can be:

- `"ethereum"` (string), or
- `{ "name": "ethereum" }` (object).

**Mapping path:**

1. `payload.chain` → `chain_name`
2. `chain_name` → `public_chain_id` via cached lookup
3. `public_chain_id` → `chain_pk` via cached lookup
4. `chain_pk` → `public_chain_id` via cached lookup
5. Use `chain_pk` for all persistence + queue payloads

### Cache Strategy

- Load all `chains` rows once at boot.
- Build a mapping of:
    - `name/slug → chain_pk`
    - `public_chain_id → chain_pk`
    - `chain_pk → public_chain_id`
- Reject or ignore payloads that cannot be mapped.

---

## Refactor Scope (When Implemented)

### Renames (future)

**Every current `chain_id` column becomes `chain_pk`**:

- `blocks`
- `transactions`
- `sync_state`
- `nft_transfer_events`
- `nft_balances`
- `orders`
- `token_metadata`
- `activities`
- `fills`
- `collections`
- `nft_balance_snapshots`
- `token_sets` / `token_sets_tokens` / `tokens` / `attributes` / `attribute_keys` / `token_attributes`
- any other indexer tables using chain scope

**New `public_chain_id` column** where external IDs are needed.

### Code Surface

- Queue payloads should carry `chain_pk` (not `public_chain_id`).
- Any inbound payload mapping should resolve external chain → internal `chain_pk`.
- Config should support selecting chain by `public_chain_id` or `slug`.

---

## Pros / Cons (Reason for Deferral)

**Pros**

- Safe multi-stream ingest without accidental cross-chain contamination.
- Clear distinction between internal PK and external chain IDs.
- Future-proof for non‑EVM chains.

**Cons**

- Large refactor surface (every table, query, and payload).
- Requires mapping for every inbound payload.
- Extra joins or lookups at ingest time.

**Decision**

- Defer until multi‑chain ingest is actively required.
- Keep single-chain assumptions for now to avoid unnecessary churn.

---

## Implementation Notes (When Un‑Deferred)

1. Add `chains` table + seed rows for supported EVM chains.
2. Add mapping utility (chain name/id → `chain_pk`).
3. Migrate all tables and queries to `chain_pk`.
4. Update all queue payloads and config to use `chain_pk`.
5. Add validation guard in offchain normalizers (drop mismatched chain events).
