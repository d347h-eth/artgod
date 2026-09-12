# ArtGod Documentation

This directory is the current operating and engineering reference for ArtGod.
The root [README](../README.md) explains the product and routes new readers;
this page routes maintainers and agents to the owning topic.

## Start Here

| Need                                              | Read                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| Public-alpha scope and user workflow              | [Project](project/README.md)                             |
| Local setup, builds, and validation               | [Local development](development/01-local-development.md) |
| Backend HTTP boundary                             | [Backend](backend/README.md)                             |
| Indexing, bootstrap, queues, and storage          | [Indexer](indexer/README.md)                             |
| Bidding jobs and marketplace execution            | [Trading](trading/README.md)                             |
| Collection-specific behavior                      | [Extensions](extensions/README.md)                       |
| Product language, interactions, and UI testing    | [UI](ui/README.md)                                       |
| Desktop supervision, wallet custody, and releases | [Desktop](desktop/README.md)                             |
| Hosted read-only deployment                       | [Deploy](deploy/01-web-hosted-read-only.md)              |
| Runtime ports                                     | [Port catalog](ports/01-port-catalog.md)                 |
| JSON-RPC inventory                                | [RPC catalog](rpc/01-http-rpc-interaction-catalog.md)    |
| Cross-domain flows                                | [Diagrams](diagrams/README.md)                           |
| Remaining work and retained status history        | [Planning](planning/README.md)                           |

## Documentation Contract

- Domain documents describe the software that exists now. A current limitation
  may be followed by a clearly labelled future direction, but proposed behavior
  must never read like implemented behavior.
- The [unified backlog](planning/01-unified-backlog.md) owns priority and status.
  Domain documents own the technical context needed to understand each item.
- Source code owns executable contracts. In particular,
  `backend/src/http-routes.ts`, shared route modules, the settings manifest,
  migrations, and package scripts take precedence when prose drifts.
- Every directory with several reading branches has a `README.md` index. Keep
  those indexes useful to humans and agents: state the reading order, ownership,
  and boundary between neighboring topics.
- Diagrams explain relationships that prose does not show efficiently. Update
  the diagram and its surrounding prose together when a represented flow
  changes.
- Documentation must not contain contributor-machine paths, obsolete progress
  directories, or links to files that do not exist. Run `yarn check:docs` before
  review.

## Updating Documentation

1. Start with this index and the owning topic index.
2. Verify claims against the current composition root, domain contracts,
   adapters, migrations, configuration manifest, and tests.
3. Update all affected views of the contract: prose, diagrams, OpenAPI, examples,
   navigation, and backlog status.
4. Run the focused package checks plus `yarn check:docs`, and run Prettier over
   every changed supported file. `yarn format:check` is the repository-wide
   formatting baseline check.

`check:docs` checks local inline/reference links, heading anchors, topic-index
coverage, retired paths, Mermaid fence/declaration structure, and selected
OpenAPI route/reference/security/nullability contracts. It is a dependency-free structural
check for the repository's Markdown and four-space YAML conventions, not a full
Markdown/Mermaid/OpenAPI parser or a test of runtime response schemas. Source
review and owning API tests are still required. Changes to the checker must
also pass `yarn test:docs`; CI runs both commands before dependency installation.
