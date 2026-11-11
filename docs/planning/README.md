# Planning and Backlog

This area is intentionally small. It records remaining work and retains status
history; it does not compete with domain documentation as a description of the
current system.

- [Unified backlog](01-unified-backlog.md) is the single status and priority
  ledger for retained work and completed or superseded history.
- [111K Sepolia bootstrap development plan](../extensions/03-111k-bootstrap.md)
  gives the bounded implementation contract for `BKL-073`. It lives with the
  owning extension documentation and describes proposed work, not current behavior.

Technical context, current limitations, and invariants stay in the owning
domain document. Backlog entries link there instead of embedding design plans
that become stale. When work lands, update the domain documentation first, then
mark the item `Done` or `Superseded` with source evidence.
