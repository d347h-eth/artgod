# tech stack
	Tauri: cross-platform distribution
		packs all components and creates app binary
		runs in system tray - enables access to basic configuration over OS window with a web view
	Node.js: backend
		API
		async workers (child_process)
	Svelte: frontend
		opened by user in OS native browser at "localhost:427906"
	pglite: local DB
		migrations
		user settings
		contracts/projects data
		worker jobs

# application configuration accessible immediately in native OS window
	management of a list of Ethereum JSON-RPC gateways for the indexer worker (with some defaults provided)
	P1/future requirement: secure wallet management for the market making/trading functionality (to explore: https://docs.apeworx.io/ape/stable/userguides/accounts.html#live-network-accounts)

# backend API (nodeJS)
	has to serve Svelte frontend
	pushes events to Svelte UI (simple SSE)
	exposes API to read the indexed blockchain data
	exposes API to write tasks for the indexer and trader workers

# indexer (backend worker)
	using ponder (https://github.com/ponder-sh/ponder)
	blockchain processing pipeline with customized indexing per each project (Terraforms, WCSG, Angelus)
	backfill mode (clean and start fresh sync from the block a certain contract/project has been deployed at)
	data export per project (exported data to be packed within distributable binary to skip backfilling and save time)
	live sync (to follow blockchain in real-time)

# aux
	notifications
		in-app/OS notifications
		3rd party apps
			telegram
			discord

# trader (backend worker) - P1/future requirement
	integration with orderbooks (ask/bid)
		Seaport OS (direct)
		Blur (over Reservoir)
		Payment Processor (TBD)
	strats
		bidding
			one ID
			many IDs
			collection
			trait (not possible for Blur due to Reservoir API limitation / OS: TBD)
			at fixed value
			with value changing over time/curve
			lowest winning bid with ceiling
		listing
			TBD
		sniping
			TBD
