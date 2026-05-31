# Port Catalog

ArtGod-owned development, desktop, deploy, and observability ports live in the `427xx` range. The range reads as "art" in leet and keeps app services, local infra, and metrics endpoints visually grouped.

The runtime env defaults are sourced from `config/settings.manifest.toml` and generated into `.env.example` plus `shared/config/generated-settings-defaults.ts`. Docker/container listeners are declared in the compose and observability config files listed below.

## App Layer

| Port    | Surface                            | Used By                                                 | Source                                                   |
| ------- | ---------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `42700` | Frontend SSR web server            | Deploy `frontend-web` container `PORT`                  | `docker-compose.deploy.yml`                              |
| `42701` | Frontend dev/admin app             | Vite dev server, Tauri `devUrl`, attached Playwright    | `frontend/package.json`, `src-tauri/tauri.conf.json`     |
| `42702` | Private bidding automation E2E app | Vite E2E server                                         | `frontend/package.json`                                  |
| `42703` | Public bidding automation E2E app  | Vite E2E public server                                  | `frontend/package.json`                                  |
| `42704` | Terraforms Hypercastle E2E app     | Vite E2E server                                         | `frontend/package.json`                                  |
| `42710` | Backend HTTP API                   | Backend runtime, deploy Caddy proxy, frontend dev proxy | `config/settings.manifest.toml`, `backend/src/config.ts` |

## Local Infra

| Port    | Surface                    | Used By                                                                             | Source                                                                                        |
| ------- | -------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `42720` | NATS JetStream client port | Desktop bundled NATS, dev compose NATS, deploy NATS, smoke-test NATS container port | `config/settings.manifest.toml`, `docker-compose*.yml`, `src-tauri/src/runtime/supervisor.rs` |
| `42721` | Local RPC HTTP endpoint    | Default one-endpoint `RPC_URL`, smoke-test RPC URL, benchmark helper                | `config/settings.manifest.toml`, `.env.test.example`                                          |
| `42723` | NATS monitoring endpoint   | Dev/deploy compose NATS monitoring listener                                         | `docker-compose*.yml`                                                                         |
| `42724` | Smoke-test NATS host port  | Testcontainers host binding                                                         | `.env.test.example`                                                                           |

## External Node RPC

| Port   | Surface                | Used By                                                | Source                                        |
| ------ | ---------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `8545` | Ethereum JSON-RPC HTTP | Deploy one-endpoint `RPC_URL=http://ethereum-rpc:8545` | External node compose + `.env.deploy.example` |
| `8546` | Ethereum JSON-RPC WS   | Deploy `RPC_WS_URL=ws://ethereum-rpc:8546`             | External node compose + `.env.deploy.example` |

## Observability Services

| Port    | Surface                | Used By                                                 | Source                                                                   |
| ------- | ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `42730` | Loki HTTP API          | Local/deploy Loki, Alloy push URL, Grafana datasource   | `observability/loki/loki-config.yaml`                                    |
| `42731` | Tempo query/API HTTP   | Local/deploy Tempo, Grafana datasource                  | `observability/tempo/tempo-config.yaml`                                  |
| `42732` | Tempo OTLP HTTP ingest | Backend/indexer APM exporters                           | `config/settings.manifest.toml`, `observability/tempo/tempo-config.yaml` |
| `42733` | Pyroscope HTTP API     | Backend/indexer profile exporters, Grafana datasource   | `config/settings.manifest.toml`, `docker-compose*.yml`                   |
| `42734` | Prometheus HTTP UI/API | Local/deploy Prometheus, Grafana datasource             | `docker-compose*.yml`                                                    |
| `42735` | Grafana HTTP UI        | Local host-network Grafana and private deploy host bind | `docker-compose*.yml`                                                    |
| `42736` | Alloy HTTP endpoint    | Local/deploy Alloy listener                             | `docker-compose*.yml`                                                    |

## Metrics Endpoints

| Port    | Runtime                            | Source                          |
| ------- | ---------------------------------- | ------------------------------- |
| `42740` | backend-api                        | `config/settings.manifest.toml` |
| `42741` | scheduler-worker                   | `config/settings.manifest.toml` |
| `42742` | sync-worker                        | `config/settings.manifest.toml` |
| `42743` | reorg-worker                       | `config/settings.manifest.toml` |
| `42744` | domain-worker                      | `config/settings.manifest.toml` |
| `42745` | offchain-ingest-worker             | `config/settings.manifest.toml` |
| `42746` | opensea-stream-worker              | `config/settings.manifest.toml` |
| `42747` | bootstrap-worker                   | `config/settings.manifest.toml` |
| `42748` | dead-letter-worker                 | `config/settings.manifest.toml` |
| `42749` | opensea-bootstrap-worker           | `config/settings.manifest.toml` |
| `42750` | opensea-reconcile-worker           | `config/settings.manifest.toml` |
| `42751` | opensea-reconcile-scheduler-worker | `config/settings.manifest.toml` |
| `42752` | collection-extension-worker        | `config/settings.manifest.toml` |

## Public Edge Exception

The optional bundled Caddy service still publishes `80/tcp`, `443/tcp`, and `443/udp`. Those are public web ingress ports, not ArtGod service ports. Keeping them standard avoids requiring nonstandard public URLs and preserves automatic HTTP-to-HTTPS/ACME behavior.
