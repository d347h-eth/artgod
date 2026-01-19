# Architecture Overview

## Introduction

This blueprint outlines the architecture for a scalable, fault-tolerant EVM indexer. The design adheres to **Hexagonal Architecture (Ports and Adapters)** and **SOLID principles** to ensure testability, maintainability, and loose coupling between core domain logic and external infrastructure (DB, Queue, RPC).

## Core Concepts

### 1. Hexagonal Architecture

The application is divided into three layers:

- **Domain (Core):** Contains business logic, entities, and use cases. It knows _nothing_ about the database, queue, or API.
    - _Entities:_ `Block`, `Transaction`, `Log`, `Order`, `Token`, `Collection`.
    - _Ports (Interfaces):_ `BlockRepository`, `JobQueue`, `RpcProvider`, `CacheService`.
- **Application (Use Cases):** Orchestrates the flow of data.
    - _Use Cases:_ `SyncBlock`, `ProcessLog`, `IngestOrder`, `BackfillRange`.
- **Infrastructure (Adapters):** Implementations of the ports.
    - _Adapters:_ `PostgresBlockRepository`, `RabbitMqJobQueue`, `AlchemyRpcProvider`, `RedisCacheService`.

### 2. Domain Separation

To maintain strict boundaries, the system is modularized into distinct domains:

- **On-Chain Sync:** Listening to blocks, decoding raw logs, handling reorgs.
- **Orderbook:** Ingesting and validating off-chain orders (Seaport, Blur, etc.).
- **Inventory (Ownership):** Tracking ERC721/1155 balances, transfers, and mints.
- **Metadata:** Fetching and processing token/collection metadata.
- **Activities:** Aggregating historical events for analytics.

### 3. Technology Abstractions

The system defines generic interfaces to allow swapping implementations:

- **Storage:** `PersistencePort` (implementations: Postgres, CockroachDB).
- **Queueing:** `MessageQueuePort` (implementations: RabbitMQ, Kafka, SQS).
- **Caching:** `CachePort` (implementations: Redis, Memcached).
- **RPC:** `BlockchainProviderPort` (implementations: Ethers.js, Viem, dedicated RPC endpoints).

## Scalability & Resilience

- **Horizontal Scalability:** Stateless worker nodes consume jobs from the queue. Throughput is increased by adding more consumers.
- **Idempotency:** All processing jobs are designed to be idempotent. Re-running a job for the same block/event results in the same state.
- **Fault Tolerance:**
    - **Dead Letter Queues (DLQ):** Failed jobs are sent to DLQ for manual inspection or delayed retry.
    - **Reorg Handling:** Automatic detection of chain reorganizations with rollback capabilities.
    - **Backpressure:** Queue-based architecture handles load spikes without crashing.

## High-Level Data Flow

1.  **Ingestion:** Block Listeners (Polling/WS) -> `SyncQueue`.
2.  **Processing:** `SyncWorker` fetches block -> Decodes Logs -> Generates `DomainEvents`.
3.  **Persistence:** `DomainEvents` are written to DB in batches.
4.  **Reaction:** New state triggers downstream jobs (e.g., `UpdateTokenBalance` -> `RefreshCollectionStats`).
