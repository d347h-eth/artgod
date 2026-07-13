import { createServer } from "node:net";

// Numeric IPv4 loopback required by installed desktop listener probes.
export const DESKTOP_IPV4_LOOPBACK_HOST = "127.0.0.1";

// Alternate loopback address used to distinguish exact binds from IPv4 wildcards.
const IPV4_WILDCARD_PROBE_HOST = "127.0.0.2";

// Proves a listener on the expected host did not also claim the IPv4 wildcard.
export async function assertIpv4WildcardPortIsFree({
    listenerName,
    expectedHost,
    port,
}) {
    const server = createServer();
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(
                { host: IPV4_WILDCARD_PROBE_HOST, port, exclusive: true },
                resolve,
            );
        });
    } catch (error) {
        throw new Error(
            `${listenerName} claimed ${IPV4_WILDCARD_PROBE_HOST}:${port}, which means its listener is broader than ${expectedHost}: ${String(error)}`,
        );
    } finally {
        if (server.listening) {
            await new Promise((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        }
    }
}
