// Generated from the desktop-managed settings in config/settings.manifest.toml.
// Do not edit directly; run `yarn config:generate`.

// Exact native Admin schema used by the maintained browser harness.
export const DESKTOP_ADMIN_CONFIG_SCHEMA = {
	groups: [
		{
			id: 'chain-rpc',
			label: 'Chain and RPC',
			fields: [
				{
					key: 'ARTGOD_DB_PATH',
					label: 'artgod db path',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'SQLite database file path; desktop relative paths resolve from app data.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'CHAIN_ID',
					label: 'chain id',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'EVM chain ID used by backend, indexer, and trading runtimes.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'RPC_URL_LIST',
					label: 'rpc endpoints',
					inputKind: 'weighted_endpoint_list',
					secret: false,
					options: [],
					help: 'Weighted Ethereum HTTP JSON-RPC endpoints used by backend, indexer, and trading runtimes.',
					requiredForLaunch: true,
					validation: 'rpc_endpoint_list',
					view: 'basic'
				},
				{
					key: 'RPC_AUTO_SOURCING_TRACKING_POLICY',
					label: 'auto rpc tracking policy',
					inputKind: 'select',
					secret: false,
					options: ['none', 'limited', 'all'],
					help: 'Privacy filter for Admin Chainlist RPC sourcing; stricter policies exclude endpoints with more tracking.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_BACKFILL_URL_LIST',
					label: 'rpc backfill endpoints',
					inputKind: 'weighted_endpoint_list',
					secret: false,
					options: [],
					help: 'Optional weighted HTTP JSON-RPC endpoints used only for historical backfill jobs.',
					requiredForLaunch: false,
					validation: 'rpc_endpoint_list'
				},
				{
					key: 'RPC_WS_URL_LIST',
					label: 'rpc ws endpoints',
					inputKind: 'weighted_endpoint_list',
					secret: false,
					options: [],
					help: 'Optional weighted WebSocket JSON-RPC endpoints for faster new-block detection.',
					requiredForLaunch: false,
					validation: 'websocket_endpoint_list',
					view: 'basic'
				},
				{
					key: 'RPC_HTTP_REQUEST_TIMEOUT_MS',
					label: 'rpc http request timeout ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Per-attempt timeout for HTTP JSON-RPC requests.',
					requiredForLaunch: false,
					validation: 'positive_integer',
					view: 'basic'
				},
				{
					key: 'RPC_RETRY_MAX_ATTEMPTS',
					label: 'rpc retry max attempts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum HTTP JSON-RPC retry attempts before the request fails.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_RETRY_BASE_DELAY_MS',
					label: 'rpc retry base delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Initial backoff delay between HTTP JSON-RPC retry attempts.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_RETRY_MAX_DELAY_MS',
					label: 'rpc retry max delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum backoff delay between HTTP JSON-RPC retry attempts.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_RATE_LIMIT_REQUESTS_PER_SECOND',
					label: 'rpc rate limit requests per second',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum HTTP JSON-RPC requests per endpoint each second; 0 disables throttling.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_RATE_LIMIT_BURST',
					label: 'rpc rate limit burst',
					inputKind: 'text',
					secret: false,
					options: [],
					help: "Burst capacity for each endpoint's HTTP JSON-RPC rate limiter.",
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD',
					label: 'rpc circuit breaker failure threshold',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Consecutive endpoint failures before the HTTP JSON-RPC circuit opens.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'RPC_CIRCUIT_BREAKER_OPEN_MS',
					label: 'rpc circuit breaker open ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long an unhealthy HTTP JSON-RPC endpoint is paused before trial requests resume.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS',
					label: 'rpc circuit breaker half open max requests',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Trial request count allowed while a paused HTTP JSON-RPC endpoint is recovering.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BLOCK_EXPLORER_BASE_URL',
					label: 'block explorer URL base',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Base explorer URL used for lookup links.',
					requiredForLaunch: false,
					validation: 'block_explorer_base_url',
					view: 'basic'
				},
				{
					key: 'BLOCK_EXPLORER_TX_PATH_TEMPLATE',
					label: 'transaction lookup path',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Transaction lookup path; include {tx_hash}.',
					requiredForLaunch: false,
					validation: 'block_explorer_tx_path_template',
					view: 'basic'
				},
				{
					key: 'BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE',
					label: 'address lookup path',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Address lookup path; include {address}.',
					requiredForLaunch: false,
					validation: 'block_explorer_address_path_template',
					view: 'basic'
				},
				{
					key: 'BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE',
					label: 'block lookup path',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Block lookup path; include {block_number}.',
					requiredForLaunch: false,
					validation: 'block_explorer_block_path_template',
					view: 'basic'
				},
				{
					key: 'WETH_ADDRESS',
					label: 'weth address',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Canonical WETH contract address used for bid validation and bidding wallet checks.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'SEAPORT_CONDUIT_CONTROLLER',
					label: 'seaport conduit controller',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Seaport ConduitController contract address used to resolve conduit approvals.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'backend',
			label: 'Backend',
			fields: [
				{
					key: 'BACKEND_HOST',
					label: 'backend host',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Network interface the backend listens on; installed desktop requires exactly 127.0.0.1.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_PORT',
					label: 'backend port',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Port for the local backend API and userland web server.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_ALLOWED_HOSTS',
					label: 'backend allowed hosts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Comma-separated Host headers accepted by the backend.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_ALLOWED_ORIGINS',
					label: 'backend allowed origins',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Comma-separated browser origins allowed to make authenticated backend requests.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_CSRF_COOKIE_SECURE',
					label: 'backend csrf cookie secure',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Requires the CSRF cookie to be sent only over HTTPS; enable for public HTTPS deploys.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS',
					label: 'backend public blockspace cache refresh ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the backend refreshes cached public blockspace data.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'backend-cache',
			label: 'Backend Cache',
			fields: [
				{
					key: 'BACKEND_QUERY_CACHE_PROVIDER',
					label: 'backend query cache provider',
					inputKind: 'select',
					secret: false,
					options: ['disabled', 'memory'],
					help: 'Selects the backend read-query cache; memory helps public read-heavy pages, while disabled keeps reads uncached.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES',
					label: 'backend query cache token preview max entries',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum token-preview responses kept in the backend memory cache.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS',
					label: 'backend query cache token preview fresh ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long cached token previews are served as fresh before background refresh is considered.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS',
					label: 'backend query cache token preview stale ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long cached token previews may be served while a replacement is warming.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY',
					label: 'backend query cache token preview warmup concurrency',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How many token previews the backend warms in parallel after cached collection refreshes.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS',
					label: 'backend public collection cache refresh ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the backend refreshes the cached public collection page.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS',
					label: 'backend public collection preview warm refresh ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the backend warms token previews for the cached public collection page.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'desktop-runtime',
			label: 'Desktop Runtime',
			fields: [
				{
					key: 'USERLAND_UI_DIST_DIR',
					label: 'userland ui dist dir',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Directory containing the built userland UI served by the backend.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'DESKTOP_RESTART_BACKOFF_MS',
					label: 'desktop restart backoff ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Delay before the desktop supervisor restarts the core runtime after a crash.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'DESKTOP_LOG_RETENTION_HOURS',
					label: 'desktop log retention hours',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long desktop app-data log files are retained; logs rotate by UTC day.',
					requiredForLaunch: false,
					validation: 'positive_integer'
				},
				{
					key: 'DESKTOP_WALLET_STORE_DIR',
					label: 'desktop wallet store dir',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Directory where desktop stores encrypted wallet keystore files.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS',
					label: 'desktop bot unlock stabilization delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long the core runtime must stay healthy before Admin shows a bot unlock prompt.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'queue',
			label: 'Queue',
			fields: [
				{
					key: 'NATS_URL',
					label: 'nats url',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'NATS server URL used by backend, indexer, and trading runtimes for queues; installed desktop requires nats://127.0.0.1:<port>.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'NATS_STREAM_PREFIX',
					label: 'nats stream prefix',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Prefix added to NATS streams and durable queue names for this ArtGod instance.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'indexer',
			label: 'Indexer',
			fields: [
				{
					key: 'CACHE_MAX_ENTRIES',
					label: 'cache max entries',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum entries in the indexer in-memory helper cache.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'CACHE_TTL_MS',
					label: 'cache ttl ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long indexer in-memory helper cache entries remain valid.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OFFCHAIN_PERSIST_RAW_OBSERVATIONS',
					label: 'offchain persist raw observations',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Stores raw OpenSea observations for audit/debugging; keep disabled unless you need source payload history.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'PERSIST_RAW_DEBUG_PAYLOADS',
					label: 'persist raw debug payloads',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Stores large raw metadata/order debug payloads in SQLite; keep disabled unless debugging normalization.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'COMMON_IPFS_GATEWAY_ORIGIN',
					label: 'common ipfs gateway origin',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'HTTP origin used to resolve ipfs:// token metadata and media URLs.',
					requiredForLaunch: false,
					validation: 'url'
				},
				{
					key: 'COMMON_MEDIA_CACHE_DIR',
					label: 'common media cache dir',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Token-image cache directory; blank stores cached images beside the SQLite database.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'COMMON_HTTP_FETCH_TIMEOUT_MS',
					label: 'common http fetch timeout ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Per-attempt timeout for retry-safe ordinary HTTP fetches.',
					requiredForLaunch: false,
					validation: 'positive_integer'
				},
				{
					key: 'COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS',
					label: 'common http fetch retry max attempts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum attempts for retry-safe ordinary HTTP fetches.',
					requiredForLaunch: false,
					validation: 'positive_integer'
				},
				{
					key: 'COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS',
					label: 'common http fetch retry base delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Initial exponential-backoff delay for retry-safe ordinary HTTP fetches.',
					requiredForLaunch: false,
					validation: 'positive_integer'
				},
				{
					key: 'COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS',
					label: 'common http fetch retry max delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum exponential-backoff delay for retry-safe ordinary HTTP fetches.',
					requiredForLaunch: false,
					validation: 'positive_integer'
				},
				{
					key: 'REORG_DEPTH',
					label: 'reorg depth',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of recent blocks kept protected from finality assumptions during reorg checks.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BACKFILL_BATCH_SIZE',
					label: 'backfill batch size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Block range size fetched by each backfill sync job.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BACKFILL_WORKER_COUNT',
					label: 'backfill worker count',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of safe historical backfill jobs the sync worker may process in parallel.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'LOG_CHUNK_SIZE',
					label: 'log chunk size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum block span fetched per getLogs chunk during sync.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_SNAPSHOT_BATCH_SIZE',
					label: 'bootstrap snapshot batch size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Token count per ownership snapshot task during collection bootstrap.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_METADATA_BATCH_SIZE',
					label: 'bootstrap metadata batch size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Token count per metadata snapshot task during collection bootstrap.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_METADATA_CONCURRENCY',
					label: 'bootstrap metadata concurrency',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of metadata snapshot tasks processed in parallel by each bootstrap worker lease.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_METADATA_PROCESS_POLL_MS',
					label: 'bootstrap metadata process poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often bootstrap workers poll for metadata tasks when a metadata step is active.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_SCHEDULER_POLL_MIN_MS',
					label: 'bootstrap scheduler poll min ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum delay between bootstrap scheduler polls when work is available.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_SCHEDULER_POLL_MAX_MS',
					label: 'bootstrap scheduler poll max ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum delay between bootstrap scheduler polls when waiting for work.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_STEP_LEASE_MS',
					label: 'bootstrap step lease ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long a bootstrap step lease lasts before another worker may recover it.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_STEP_PROGRESS_STALE_MS',
					label: 'bootstrap step progress stale ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long a bootstrap step can make no progress before it is treated as stale.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY',
					label: 'bootstrap collection extension artifact concurrency',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of collection-extension artifact tasks the worker may process in parallel.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_MS',
					label: 'bootstrap collection extension artifact task lease ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Lease duration for one collection-extension artifact task while it is being rendered or fetched.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS',
					label: 'bootstrap metadata retry max attempts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum retry attempts for failed bootstrap metadata tasks.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS',
					label: 'bootstrap metadata retry base delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Initial backoff delay before retrying failed bootstrap metadata tasks.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS',
					label: 'bootstrap metadata retry max delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum backoff delay before retrying failed bootstrap metadata tasks.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE',
					label: 'bootstrap image cache batch size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Token count per bootstrap image-cache task.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_IMAGE_CACHE_CONCURRENCY',
					label: 'bootstrap image cache concurrency',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of bootstrap image-cache tasks processed in parallel.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES',
					label: 'bootstrap image cache max source bytes',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum remote image byte size accepted for bootstrap image caching.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'METADATA_REFRESH_RANGE_CHUNK_SIZE',
					label: 'metadata refresh range chunk size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Token range size processed by each metadata refresh chunk.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				}
			]
		},
		{
			id: 'opensea',
			label: 'OpenSea',
			fields: [
				{
					key: 'OPENSEA_INTEGRATION_MODE',
					label: 'opensea integration mode',
					inputKind: 'select',
					secret: false,
					options: ['auto', 'enabled', 'disabled'],
					help: 'Controls whether OpenSea workers and OpenSea-dependent bot starts are automatic, required, or disabled.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'OPENSEA_API_KEY',
					label: 'opensea api key',
					inputKind: 'password',
					secret: true,
					options: [],
					help: 'OpenSea API key for indexer order snapshots, streams, and reconcile workers.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'OPENSEA_SNAPSHOT_PAGE_SIZE',
					label: 'opensea snapshot page size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'OpenSea orderbook page size for snapshot and reconcile fetches.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_RECONCILE_INTERVAL_MS',
					label: 'opensea reconcile interval ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often OpenSea reconcile workers refresh orderbooks for live collections.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_STALE_START_THRESHOLD_MS',
					label: 'opensea stale start threshold ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Age after which OpenSea orderbook state is considered stale enough to reconcile on startup.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_STREAM_SUBSCRIPTION_POLL_MS',
					label: 'opensea stream subscription poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often OpenSea stream workers check for collection subscription changes.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_HTTP_RETRY_MAX_ATTEMPTS',
					label: 'opensea http retry max attempts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How many times OpenSea HTTP calls may be attempted before the operation fails.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_HTTP_RETRY_BASE_DELAY_MS',
					label: 'opensea http retry base delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Initial delay before retrying a failed OpenSea HTTP call.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_HTTP_RETRY_MAX_DELAY_MS',
					label: 'opensea http retry max delay ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum delay between retries for a failed OpenSea HTTP call.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_HTTP_RETRY_JITTER_RATIO',
					label: 'opensea http retry jitter ratio',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Randomizes OpenSea HTTP retry delays so repeated failures do not all retry at the same instant.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_RATE_LIMIT_GET_MAX',
					label: 'opensea rate limit get max',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum OpenSea GET requests the app may start immediately.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND',
					label: 'opensea rate limit get refill per second',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How quickly OpenSea GET request capacity refills while the app is running.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_RATE_LIMIT_POST_MAX',
					label: 'opensea rate limit post max',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum OpenSea POST requests the app may start immediately.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND',
					label: 'opensea rate limit post refill per second',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How quickly OpenSea POST request capacity refills while the app is running.',
					requiredForLaunch: false,
					validation: null
				}
			]
		},
		{
			id: 'trading-opensea',
			label: 'Trading OpenSea',
			fields: [
				{
					key: 'OPENSEA_STREAM_SECRET_KEY',
					label: 'opensea stream secret key',
					inputKind: 'password',
					secret: true,
					options: [],
					help: 'OpenSea API key for the bidding bot stream lane; use a separate key when available.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'OPENSEA_BIDDING_SECRET_KEY',
					label: 'opensea bidding secret key',
					inputKind: 'password',
					secret: true,
					options: [],
					help: 'OpenSea API key for bidding order placement and cancellation; use a separate key when available.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'OPENSEA_SNAPSHOT_SECRET_KEY',
					label: 'opensea snapshot secret key',
					inputKind: 'password',
					secret: true,
					options: [],
					help: 'OpenSea API key for bidding collection-offer snapshots; use a separate key when available.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				}
			]
		},
		{
			id: 'trading-observability',
			label: 'Trading Observability',
			fields: [
				{
					key: 'TRADING_METRICS_ENABLED',
					label: 'bidding metrics endpoint',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Exposes bidding runtime metrics on this computer for Prometheus and Grafana after the bidding bot restarts.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'TRADING_METRICS_PORT_BIDDING_BOT',
					label: 'bidding metrics TCP port',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Local TCP port from 1 to 65535 used by the bidding bot metrics endpoint.',
					requiredForLaunch: false,
					validation: 'tcp_port'
				}
			]
		},
		{
			id: 'bidding',
			label: 'Bidding',
			fields: [
				{
					key: 'BIDDING_ENABLED',
					label: 'bidding enabled',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Enables wallet-bound bidding runtime startup when required OpenSea bot keys are configured.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_DRY_RUN',
					label: 'bidding dry run',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: 'Runs the bidding bot without placing or cancelling live orders.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_TRUST_OPENSEA_SIGNED_ZONE_FOR_TRAIT_OFFERS',
					label: 'trust OpenSea SignedZone for trait offers',
					inputKind: 'checkbox',
					secret: false,
					options: [],
					help: "Explicitly allows live trait and multi-trait offers whose target criteria are enforced by OpenSea's pinned SignedZone rather than committed in the maker signature.",
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_WETH_ALLOWANCE_ETH',
					label: 'WETH allowance cap',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Exact OpenSea conduit allowance cap in WETH; setting 0 forces no allowance and revokes any existing approval.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_TX_MIN_PRIORITY_FEE_GWEI',
					label: 'minimum priority fee per gas',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum EIP-1559 priority fee in Gwei per gas for the WETH approval transaction.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_TX_FEE_HISTORY_BLOCKS',
					label: 'bidding tx fee history blocks',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of recent blocks sampled when estimating bidding priority fees.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE',
					label: 'bidding tx fee history reward percentile',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Reward percentile used when estimating bidding priority fees from fee history.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_TX_BASE_FEE_MULTIPLIER',
					label: 'bidding tx base fee multiplier',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Multiplier applied to the current base fee when setting bidding max fees.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_TX_MAX_FEE_GWEI',
					label: 'maximum fee per gas',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum fee in Gwei per gas for the WETH approval transaction.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_WETH_APPROVAL_MAX_GAS_FEE_ETH',
					label: 'maximum network fee for one WETH approval transaction',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum worst-case network gas fee for one WETH approval transaction (explicit gas limit times max fee per gas), in ETH; unrelated to OpenSea or order fees.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_TX_PENDING_NONCE_POLICY',
					label: 'pending transaction policy',
					inputKind: 'select',
					secret: false,
					options: ['fail'],
					help: 'Fail the start before approval when the wallet already has pending transactions.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_SCAN_SLEEP_MS',
					label: 'bidding scan sleep ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Delay between completed full bidding-job scans.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_MAX_CONCURRENT_JOBS',
					label: 'bidding max concurrent jobs',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum bidding jobs processed concurrently by one bot runtime.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_BOOTSTRAP_CONCURRENCY',
					label: 'bidding bootstrap concurrency',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Number of bidding jobs bootstrapped in parallel when the bot starts.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_OFFER_EXPIRATION_SECONDS',
					label: 'bidding offer expiration seconds',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Lifetime in seconds for each newly created OpenSea offer.',
					requiredForLaunch: false,
					validation: null,
					view: 'basic'
				},
				{
					key: 'BIDDING_COLLECTION_OFFERS_POLL_MS',
					label: 'bidding collection offers poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the bidding bot refreshes collection-offer snapshots from OpenSea.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COLLECTION_OFFERS_TTL_MS',
					label: 'bidding collection offers ttl ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum time a collection-offer snapshot is considered fresh inside the bot.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COLLECTION_OFFERS_MAX_TTL_MS',
					label: 'bidding collection offers max ttl ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum adaptive freshness window for collection-offer snapshots.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COLLECTION_OFFERS_ADAPTIVE_TTL_MULTIPLIER',
					label: 'bidding collection offers adaptive ttl multiplier',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Multiplier applied to the last snapshot fetch duration when extending snapshot freshness.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_HOT_REFRESH_BROAD_COOLDOWN_MS',
					label: 'bidding hot refresh broad cooldown ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum delay between broad collection or trait offer hot-refresh passes.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_HOT_REFRESH_BROAD_MAX_PENDING_SIGNATURES',
					label: 'bidding hot refresh broad max pending signatures',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum queued broad collection or trait refresh targets and recently completed targets remembered during cooldown per bidding bot; each group uses this limit.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_HOT_REFRESH_ITEM_COOLDOWN_MS',
					label: 'bidding hot refresh item cooldown ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum delay between exact-token offer hot-refresh passes for the same token.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_HOT_REFRESH_ITEM_MAX_PENDING_SIGNATURES',
					label: 'bidding hot refresh item max pending signatures',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum queued exact-token refresh targets and recently completed token targets remembered during cooldown per bidding bot; each group uses this limit.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COMPETITIVE_TRAIT_MAX_LOOKUP_SELECTORS',
					label: 'bidding competitive trait max lookup selectors',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum expanded trait buckets a competitive-trait job may query during one bid evaluation.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS',
					label: 'bidding bid book projection throttle ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Minimum delay between bid-book projection writes from bot state.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_BID_BOOK_SNAPSHOT_STALE_MS',
					label: 'bidding bid book snapshot stale ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long backend bid books may trust the bot snapshot before falling back to marketplace orders.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_BID_BOOK_NORMAL_LIVE_POLL_MS',
					label: 'bidding bid book normal live poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often bid books refresh while they are reading regular marketplace orders.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_BID_BOOK_COMPETITIVE_LIVE_POLL_MS',
					label: 'bidding bid book competitive live poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often bid books refresh while they are reading the active bidding bot snapshot.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS',
					label: 'bidding runtime heartbeat interval ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the bidding bot writes a heartbeat for backend and UI freshness checks.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_RUNTIME_HEARTBEAT_STALE_MS',
					label: 'bidding runtime heartbeat stale ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How old a bot heartbeat may be before bid books stop treating its snapshot as live.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_ORDER_LOOKUP_MAX_PAGES',
					label: 'bidding order lookup max pages',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum OpenSea pages scanned when looking up existing offers for a bidding job.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COMMAND_POLL_MS',
					label: 'bidding command poll ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the bidding bot scans for DB commands such as pause, resume, or cancel.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COMMAND_BATCH_SIZE',
					label: 'bidding command batch size',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum DB commands claimed per bidding command reconciliation pass.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COMMAND_MAX_ATTEMPTS',
					label: 'bidding command max attempts',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'Maximum attempts before a failed bidding command stops retrying.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_COMMAND_CLAIM_TIMEOUT_MS',
					label: 'bidding command claim timeout ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long a claimed bidding command can run before another pass may recover it.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_FAILED_CANCELLATION_RECONCILE_MS',
					label: 'bidding failed cancellation reconcile ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How often the bidding bot checks unresolved cancellations and refreshes their OpenSea state.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_CANCELLATION_REMEDIATION_RETRY_MS',
					label: 'bidding cancellation remediation retry ms',
					inputKind: 'text',
					secret: false,
					options: [],
					help: 'How long the bidding bot waits between slow retry attempts for failed offer cancellations.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION',
					label: 'bidding criteria refresh traits by collection',
					inputKind: 'textarea',
					secret: false,
					options: [],
					help: 'Optional JSON map of collection IDs to criteria trait types that may force snapshot refresh from hot-path events.',
					requiredForLaunch: false,
					validation: null
				},
				{
					key: 'BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION',
					label: 'bidding token criteria traits by collection',
					inputKind: 'textarea',
					secret: false,
					options: [],
					help: 'Optional JSON map of collection IDs to criteria trait types the bot may match for token jobs; leave empty to match all criteria against token metadata.',
					requiredForLaunch: false,
					validation: null
				}
			]
		}
	],
	defaults: {
		ARTGOD_DB_PATH: 'sqlite/main/db',
		BACKEND_HOST: '127.0.0.1',
		BACKEND_PORT: '42710',
		BACKEND_ALLOWED_HOSTS: '127.0.0.1,localhost,::1',
		BACKEND_ALLOWED_ORIGINS:
			'http://127.0.0.1:42710,http://localhost:42710,http://127.0.0.1:42701,http://localhost:42701,http://tauri.localhost,tauri://localhost',
		BACKEND_CSRF_COOKIE_SECURE: 'false',
		BACKEND_QUERY_CACHE_PROVIDER: 'disabled',
		BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES: '250',
		BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS: '600000',
		BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS: '1200000',
		BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY: '3',
		BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS: '30000',
		BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS: '600000',
		BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS: '60000',
		USERLAND_UI_DIST_DIR: 'frontend/userland',
		DESKTOP_RESTART_BACKOFF_MS: '1500',
		DESKTOP_LOG_RETENTION_HOURS: '48',
		DESKTOP_WALLET_STORE_DIR: 'wallets',
		DESKTOP_BOT_UNLOCK_STABILIZATION_DELAY_MS: '5000',
		CHAIN_ID: '1',
		RPC_URL_LIST: '',
		RPC_AUTO_SOURCING_TRACKING_POLICY: 'none',
		RPC_BACKFILL_URL_LIST: '',
		RPC_WS_URL_LIST: '',
		RPC_HTTP_REQUEST_TIMEOUT_MS: '10000',
		RPC_RETRY_MAX_ATTEMPTS: '10',
		RPC_RETRY_BASE_DELAY_MS: '500',
		RPC_RETRY_MAX_DELAY_MS: '10000',
		RPC_RATE_LIMIT_REQUESTS_PER_SECOND: '5',
		RPC_RATE_LIMIT_BURST: '5',
		RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD: '5',
		RPC_CIRCUIT_BREAKER_OPEN_MS: '5000',
		RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS: '2',
		BLOCK_EXPLORER_BASE_URL: 'https://etherscan.io',
		BLOCK_EXPLORER_TX_PATH_TEMPLATE: '/tx/{tx_hash}',
		BLOCK_EXPLORER_ADDRESS_PATH_TEMPLATE: '/address/{address}',
		BLOCK_EXPLORER_BLOCK_PATH_TEMPLATE: '/block/{block_number}',
		CACHE_MAX_ENTRIES: '5000',
		CACHE_TTL_MS: '30000',
		OFFCHAIN_PERSIST_RAW_OBSERVATIONS: 'false',
		PERSIST_RAW_DEBUG_PAYLOADS: 'false',
		COMMON_IPFS_GATEWAY_ORIGIN: 'https://ipfs.io',
		COMMON_MEDIA_CACHE_DIR: 'media-cache/token-images',
		COMMON_HTTP_FETCH_TIMEOUT_MS: '10000',
		COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS: '3',
		COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS: '250',
		COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS: '2000',
		NATS_URL: 'nats://127.0.0.1:42720',
		NATS_STREAM_PREFIX: 'artgod',
		REORG_DEPTH: '32',
		BACKFILL_BATCH_SIZE: '10',
		BACKFILL_WORKER_COUNT: '1',
		LOG_CHUNK_SIZE: '2000',
		BOOTSTRAP_SNAPSHOT_BATCH_SIZE: '200',
		BOOTSTRAP_METADATA_BATCH_SIZE: '200',
		BOOTSTRAP_METADATA_CONCURRENCY: '8',
		BOOTSTRAP_METADATA_PROCESS_POLL_MS: '5000',
		BOOTSTRAP_SCHEDULER_POLL_MIN_MS: '250',
		BOOTSTRAP_SCHEDULER_POLL_MAX_MS: '5000',
		BOOTSTRAP_STEP_LEASE_MS: '60000',
		BOOTSTRAP_STEP_PROGRESS_STALE_MS: '1800000',
		BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_CONCURRENCY: '2',
		BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_MS: '60000',
		BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS: '3',
		BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS: '100',
		BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS: '1000',
		BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE: '50',
		BOOTSTRAP_IMAGE_CACHE_CONCURRENCY: '4',
		BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES: '26214400',
		METADATA_REFRESH_RANGE_CHUNK_SIZE: '200',
		WETH_ADDRESS: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
		SEAPORT_CONDUIT_CONTROLLER: '0x00000000f9490004c11cef243f5400493c00ad63',
		OPENSEA_INTEGRATION_MODE: 'auto',
		OPENSEA_API_KEY: '',
		OPENSEA_SNAPSHOT_PAGE_SIZE: '200',
		OPENSEA_RECONCILE_INTERVAL_MS: '900000',
		OPENSEA_STALE_START_THRESHOLD_MS: '1800000',
		OPENSEA_STREAM_SUBSCRIPTION_POLL_MS: '5000',
		OPENSEA_HTTP_RETRY_MAX_ATTEMPTS: '5',
		OPENSEA_HTTP_RETRY_BASE_DELAY_MS: '500',
		OPENSEA_HTTP_RETRY_MAX_DELAY_MS: '10000',
		OPENSEA_HTTP_RETRY_JITTER_RATIO: '0.2',
		OPENSEA_RATE_LIMIT_GET_MAX: '4',
		OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND: '1',
		OPENSEA_RATE_LIMIT_POST_MAX: '2',
		OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND: '0.5',
		OPENSEA_STREAM_SECRET_KEY: '',
		OPENSEA_BIDDING_SECRET_KEY: '',
		OPENSEA_SNAPSHOT_SECRET_KEY: '',
		TRADING_METRICS_ENABLED: 'false',
		TRADING_METRICS_PORT_BIDDING_BOT: '42753',
		BIDDING_ENABLED: 'true',
		BIDDING_DRY_RUN: 'false',
		BIDDING_TRUST_OPENSEA_SIGNED_ZONE_FOR_TRAIT_OFFERS: 'false',
		BIDDING_WETH_ALLOWANCE_ETH: '0',
		BIDDING_TX_MIN_PRIORITY_FEE_GWEI: '0.1',
		BIDDING_TX_FEE_HISTORY_BLOCKS: '20',
		BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE: '70',
		BIDDING_TX_BASE_FEE_MULTIPLIER: '1.25',
		BIDDING_TX_MAX_FEE_GWEI: '10',
		BIDDING_WETH_APPROVAL_MAX_GAS_FEE_ETH: '0.01',
		BIDDING_TX_PENDING_NONCE_POLICY: 'fail',
		BIDDING_SCAN_SLEEP_MS: '60000',
		BIDDING_MAX_CONCURRENT_JOBS: '1',
		BIDDING_BOOTSTRAP_CONCURRENCY: '3',
		BIDDING_OFFER_EXPIRATION_SECONDS: '13920',
		BIDDING_COLLECTION_OFFERS_POLL_MS: '60000',
		BIDDING_COLLECTION_OFFERS_TTL_MS: '15000',
		BIDDING_COLLECTION_OFFERS_MAX_TTL_MS: '300000',
		BIDDING_COLLECTION_OFFERS_ADAPTIVE_TTL_MULTIPLIER: '2',
		BIDDING_HOT_REFRESH_BROAD_COOLDOWN_MS: '15000',
		BIDDING_HOT_REFRESH_BROAD_MAX_PENDING_SIGNATURES: '256',
		BIDDING_HOT_REFRESH_ITEM_COOLDOWN_MS: '2000',
		BIDDING_HOT_REFRESH_ITEM_MAX_PENDING_SIGNATURES: '512',
		BIDDING_COMPETITIVE_TRAIT_MAX_LOOKUP_SELECTORS: '64',
		BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS: '15000',
		BIDDING_BID_BOOK_SNAPSHOT_STALE_MS: '120000',
		BIDDING_BID_BOOK_NORMAL_LIVE_POLL_MS: '10000',
		BIDDING_BID_BOOK_COMPETITIVE_LIVE_POLL_MS: '5000',
		BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS: '10000',
		BIDDING_RUNTIME_HEARTBEAT_STALE_MS: '30000',
		BIDDING_ORDER_LOOKUP_MAX_PAGES: '5',
		BIDDING_COMMAND_POLL_MS: '1000',
		BIDDING_COMMAND_BATCH_SIZE: '20',
		BIDDING_COMMAND_MAX_ATTEMPTS: '5',
		BIDDING_COMMAND_CLAIM_TIMEOUT_MS: '300000',
		BIDDING_FAILED_CANCELLATION_RECONCILE_MS: '60000',
		BIDDING_CANCELLATION_REMEDIATION_RETRY_MS: '300000',
		BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION: '{}',
		BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION: '{}'
	}
} as const;
