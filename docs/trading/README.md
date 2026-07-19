# Trading Documentation

Trading is a local, policy-driven command system. The backend persists intent;
the supervised bot evaluates state and talks to marketplace and chain APIs.

1. [Bidding runtime and jobs](01-bidding-runtime-and-jobs.md) — process
   composition, durable jobs and commands, wallet handoff, execution,
   cancellation, reconciliation, and metrics.
2. [Bidding automation capabilities](02-bidding-automation-capabilities.md) —
   user-visible targets, price tiers, settings, authorization, and API/UI
   coverage.
3. [Market data and scaling](03-market-data-and-scaling.md) — bid-book inputs,
   snapshot tiers, fallback behavior, and current scaling limits.

Wallet custody is documented under
[Desktop](../desktop/03-wallet-keystore-and-bot-unlock.md). Topic documents
retain the technical constraints for important future work; the
[unified backlog](../planning/01-unified-backlog.md) owns its status and
priority.
