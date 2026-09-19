import { createServer } from 'vite';
import { CONFIG_OBSERVABILITY_HARNESS } from './config-observability-harness.mjs';

// Start the maintained browser harness from its single endpoint contract.
const server = await createServer({
	server: {
		host: CONFIG_OBSERVABILITY_HARNESS.host,
		port: CONFIG_OBSERVABILITY_HARNESS.port,
		strictPort: true
	}
});
await server.listen();

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, async () => {
		await server.close();
		process.exit(0);
	});
}
