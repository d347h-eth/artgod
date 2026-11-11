# Collection Extension Documentation

Collection extensions add collection-owned behavior without moving
collection-specific rules into generic indexer, backend, or UI code.

1. [Collection extension system](01-collection-extensions.md) — registry,
   embedded installation, sync hooks, artifacts, presentation overrides, media,
   and generic boundaries.
2. [Terraforms](02-terraforms.md) — the shipped Terraforms extension, live media,
   customization, event facts, traits, and Hypercastle explorer.
3. [111K Sepolia bootstrap development plan](03-111k-bootstrap.md)
   — retained implementation contract, local verification, explicit deferrals,
   and the user-run Sepolia pilot for v17.

The generic extension contract owns shared hook shapes. An extension module owns
its own keys, event names, trait vocabulary, and presentation rules. Topic docs
retain future boundary details; the
[unified backlog](../planning/01-unified-backlog.md) owns status and priority.
