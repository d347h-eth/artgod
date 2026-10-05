# Changelog

Notable changes for ArtGod users, following
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/).
Earlier releases are available in
[GitHub Releases](https://github.com/d347h-eth/artgod/releases).

## Unreleased

## 0.1.3-alpha - 2026-10-06

Changes since
[v0.1.1-alpha.3](https://github.com/d347h-eth/artgod/releases/tag/v0.1.1-alpha.3).

### Release summary

- Easier collection setup with metadata previews and Art Blocks token ranges.
- Extra target presets for trait-scoped bidding.
- Explore collection sale prices with interactive charts and trait filters.
- Collections automatically recover missing history and refresh all collection data
  after app shutdown and relaunch.
- More reliable market data, bidding, and desktop startup.

### Upgrade notes

**Desktop users do not need to run cleanup manually.** The app handles cleanup
automatically when it starts.

- **Existing listing history, bid/cancellation activity history and sales history
  are permanently deleted.**
  Daily listing history starts afresh. Resync sales history through normal
  backfill. Transfers, artwork, metadata, ownership, settings, wallets, and bidding
  state are kept.
- Large databases may take longer to start. Use Stop to interrupt cleanup or
  `retry start` to resume it after a failure.
- **Custom or standalone hosted installations need manual cleanup.** Follow the
  [hosted upgrade steps](https://github.com/d347h-eth/artgod/blob/main/docs/deploy/01-web-hosted-read-only.md#sqlite-storage-upgrade).

### Added

- Explore collection sale prices on an interactive chart with trait filters,
  token previews, bundle averages, and NFT quantity and ETH volume.
- Preview token metadata and estimate image storage before adding a collection.
- Suggested token ranges for recognized Art Blocks projects.
- Extra targets presets let trait-scoped bidding jobs consider competing offers
  for additional traits.

### Changed

- Listing history keeps one daily entry per NFT and seller, including its last
  recorded price after cancellation or sale.

### Fixed

- Collections automatically fill missing history and keep all collection data up
  to date after app shutdown and relaunch.
- Listings and bids update more reliably after sales, cancellations, and restarts.
- Collection setup shows progress more often while finding NFTs.
- Bidding authorization opens in a shorter, resizable window with visible Next
