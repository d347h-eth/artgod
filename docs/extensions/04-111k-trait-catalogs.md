# 111K collection views and trait catalogs

The collection opens on **All**, including NFTs awaiting classification.
**Artworks** opens on **All blocks** and includes artworks from every classified
block. Choose a block to narrow the results. Eggs, crates, warehouses and
relics each have their own view. Opening a classified token directly selects
its current view. **Unclassified** contains accepted metadata whose type or
block cannot be resolved. A newly observed block appears as soon as the
indexer accepts its canonical traits.

## Source and projection

A fresh 111K bootstrap establishes view membership as each metadata observation
succeeds. Existing databases first populated on an older release acquire
membership on subsequent accepted observations. The local rebuild operates on
members that already have a saved revision.

The [metadata store](../../indexer/src/infra/metadata/sqlite-metadata-store.ts)
replaces the canonical links, advances the collection revision clock and
retains projection work in the observation transaction. Each token belongs to
one current view. Refreshes remove its old projection immediately. Its card
remains available while traits are pending. The collection-extension worker
loads the saved pairs, runs the selected mapper locally and writes the tree
and flat values together. A lease and revision fence discard superseded work.

The normalized pairs retain case and distinct values for the same key.
Normalization removes duplicate identical pairs and source ordering.
Debug retention continues to govern the original URI and JSON columns.
Content readiness and network retries follow the
[metadata backlog](../indexer/20-metadata-pending-backlog.md).

## Mappings

| View                               | Token presentation                                                                                                                                                                                                                              | Filterable fields                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| DriMi, other blocks and type views | Each source key and value retains its own identity.                                                                                                                                                                                             | All normalized source pairs.                                                                                                            |
| Plane of Existence                 | Character slots group under their character name. A repeated name gets a local suffix. Known property labels preserve meaning such as left and right wield. Legacy artwork references, unknown fields and conflicting names remain inspectable. | Collection attribution and recognized flat scene properties. Numbered scene families and character properties are readable in the tree. |
| Backrooms 2                        | Painting title and artist share the source slot. Partial pairs show the missing half. The tree separates room properties from a painting list that preserves repeated titles.                                                                   | Collection attribution and unnumbered room properties.                                                                                  |

Field IDs, labels, provenance and exact marketplace bindings have separate roles
in the [shared contract](../../shared/types/trait-catalog.ts). The extension
owns the [classification](../../shared/extensions/111k-traits.ts) and
[structured mappers](../../shared/extensions/111k-structured-traits.ts).
Changing the mapper version makes it available for a local rebuild. An older
active generation continues to use its recorded version until publication.

## Browse and bidding

Discovery returns opaque view IDs, selector groups, the active generation,
and counts of classified, ready and failed projections. Token, holder, activity,
chart and facet reads use current membership. Facet counts measure distinct
NFTs. Historical events use the token's current view. The published generation
identifies the catalog used by continuations and frontend navigation.

Token kinds appear above the collection section tabs. Artworks adds a block picker
in the same row. The picker sorts block names alphabetically regardless
of case and preserves their original spelling. The selected controls show
the browsing scope once.
Opening an NFT resolves its trait catalog from its token ID. Trait links use
that catalog. Returning to the collection restores the section and scope from
which the reader opened the NFT.
The sidebar lists only traits that can filter the current view. Open an NFT
to inspect its character, artwork and scene details. The token page shows the
standard trait table first. Below it, the centered projection tree opens its
first level. Open an individual entry or choose **Expand all** to see every level.

A specific block or token type pins its exact canonical criterion when all
members share one. For example,
selecting DriMi and a blue background targets both `collection block = DriMi`
and `01 Background = blue`. Clearing ordinary filters preserves the pin.
Exact-token actions use the token ID. A native bid-book bucket retains its
complete target when redrafted. The original canonical traits determine native
order and token-set applicability even when the presentation groups a field
under an entity.

The lowercase and title-case collection-block keys can classify the same block.
ArtGod prefers `collection block` when every member has that exact pair, then
checks `Collection Block`. If neither pair is shared across all members, the
view has no universal pinned criterion. A filter-driven trait bid requires a complete,
unambiguous native mapping. All blocks is a union of views with no single
marketplace criterion. It supports bidding on matching token IDs. In All,
ordinary native trait filters can target a trait bid if every selected pair is
supported. A view with an unresolved pin remains browsable.
Local metadata gaps produce unresolved offer applicability.

## Offline rebuild

Open **Customization** in the selected view to inspect mapper versions and
start a rebuild. The worker enumerates current members in bounded pages.
Canonical writes during the rebuild schedule the active and building
generations. The new generation publishes in one transaction after coverage
of current revisions is complete. Failure leaves the previous generation
available. Retry resumes from durable local work. Collection removal and
rollback invalidate dependent rows through the
[catalog schema](../../database/migrations/078_trait_catalogs.sql).

## API and verification

Use `GET /api/:chain_ref/:collection_ref/collection-views` for discovery.
Omit scope parameters for All. Pass the discovered parent ID as `view_group`
to browse all its child blocks. Both aggregates use canonical metadata. Their
default facets are the type and collection-block keys declared by the extension.
Pass the returned `view` and `generation` for a leaf. Its default catalog is
`derived`. Specify `trait_catalog=canonical` to inspect metadata-source facts
in that leaf. Collections without a view capability
retain their existing default presentation. Local rebuild writes use the
ordinary mutation checks. Public read-only deployments expose view selection.
See the [HTTP contract](../backend/openapi.yaml).

| Plan package                               | Implementation and local verification                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1. Contracts and persistence              | Separate associations, source identity, append-only schema and canonical multivalue reads. SQLite fixtures exercise rollback and collection purge.                                                                                                                                                                                                             |
| P2. Ingestion                              | Shared bootstrap and domain composition, durable retry, classification and generation fencing. The [lifecycle tests](../../indexer/tests/trait-catalog.test.ts) exercise bootstrap metadata, later mint, hatch, restart and source removal.                                                                                                                    |
| P3. Catalog reads and native compatibility | View-scoped reads, scoped settings, native selection and reverse bindings, both bid-book sources, batches and reapply. Coverage includes [read-model tests](../../shared/read-models/collections.test.ts), [bid-book tests](../../backend/src/infra/trading/sqlite-bidding-bid-book-repository.test.ts) and [HTTP integration](../../backend/src/api.test.ts). |
| P4. Views and rebuilds                     | The [browser journey](../../frontend/e2e/collection-views.spec.ts) covers DriMi selection, native draft creation, navigation and rebuild retry/publication with fixture API responses.                                                                                                                                                                         |
| P5. Structured traits                      | [Mapper fixtures](../../shared/extensions/111k-structured-traits.test.ts) cover conflicting labels, partial pairs and repeated instances. The [Backrooms browser test](../../frontend/e2e/structured-traits.spec.ts) loads 1,447 paintings on the token page, opens the list and finds the last artist.                                                        |

The static Userland build and fixture-backed desktop and mobile browser checks
passed. The [preview journey](../../frontend/e2e/preview-traits.spec.ts)
covers the muted summary and flat trait pages. The projection tree is available
on token detail.
Packaged desktop and user-run mainnet bootstrap qualification remain open.
Further per-block mappings and predicates spanning multiple properties of one
entity instance are deferred.
