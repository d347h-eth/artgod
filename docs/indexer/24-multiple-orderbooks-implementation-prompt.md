# Implement multiple orderbooks in ArtGod

Implement the [multi-orderbook design](21-multiple-orderbooks.md). Deliver one
local book of listings and cash offers from OpenSea and VVV on the existing
collection and token pages. The core projection chooses the best offer by the
amount the seller receives after required fees. The bidding bot uses OpenSea.

## Start the session

Read `$HOME/AGENTS.md`, the repository’s `AGENTS.md`, and the Documentation
Map in the root README. From the primary ArtGod checkout, create a new worktree
from local `main` and bring the design commits into the implementation branch.

```sh
git worktree add -b feature/multi-orderbook-implementation tmp/worktrees/multi-orderbook-implementation main
git -C tmp/worktrees/multi-orderbook-implementation merge --no-gpg-sign --no-edit feature/multi-orderbook-design
```

Work in that new checkout. Make logical commits with
`git commit --no-gpg-sign`. Use `git rebase --no-gpg-sign` for any rebase.
Keep running notes and verification results in the implementation worktree’s
`tmp/` directory. Read the design, [VVV adapter](22-vvv-orderbook-adapter.md)
and [discovery notes](23-orderbook-discovery.md) together. The discovery notes
give the saved input paths and hashes in the `feature/vvv-orderbook-access`
worktree. Trace the current implementation before changing each owner.

## Build and verify the plan

1. Reuse the OpenSea reconcile scheduler and reconciler as the two shared
   orderbook workers. They start with the composition and wait when there is
   no eligible market. Move the existing OpenSea initial-read duties and their
   progress reporting into the reconciler. Exercise the idle, OpenSea-only,
   VVV-only, and combined cases. Verify that 111K becoming live activates its
   catalogued VVV market and that startup recovers an already-live collection.
   See the [worker design](21-multiple-orderbooks.md#run-two-shared-orderbook-workers).
2. Test the VVV adapter early in the packaged shared reconciler. Fetch from
   inside its browser session as the standalone probe did. Verify successive
   scheduled reads, worker restart and recovery after an interrupted read.
   Check OpenSea can refresh while VVV is unavailable. If a supported setup
   cannot do this in the shared reconciler, show the failure and block VVV
   enablement there. Adding a worker requires a separate decision.
3. Carry each bound market through ingestion, validation and publication into
   SQLite. Record additions, changes and removals per feed. A successful VVV
   book that omits a previously seen order withdraws its VVV placement in that
   refresh. A failed read keeps the previous eligible quote and its last
   successful observation time. Deduplicate the same signed order across
   venues. Publish the combined prices and daily seller history atomically.
   Exercise the alpha reset against a disposable database and broker with both
   order and unrelated work pending.
4. Verify the result through the normal collection and token routes. Listings
   show the buyer’s full cost in the winning currency. Offers show the
   seller’s proceeds. Check that removing the cheapest listing moves the card
   to the price on the surviving venue. Exercise the bot’s fresh, fresh-empty
   and fallback views and its existing OpenSea-only bidding and cancellation
   behavior. NFT barter stays deferred.
5. Run the remaining [acceptance cases](21-multiple-orderbooks.md#acceptance-before-enabling-additional-feeds),
   the affected package tests and the project’s runtime registry, settings and
   documentation checks. Verify the changed UI through the project harness.
   Update the affected domain and runtime references to match the delivered
   behavior. Report which checks used saved books, which ran against the
   packaged worker, and any concrete blocker, with the final branch and
   absolute worktree path.
