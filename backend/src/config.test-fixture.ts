import { RPC_ENDPOINT_LIST_ENV_KEY } from "@artgod/shared/config/rpc-endpoints";

// Supplies the minimal valid backend environment shared by config-boundary tests.
export function createBaseEnv(): Record<string, string> {
    return {
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: "42710",
        CHAIN_ID: "1",
        ARTGOD_DB_PATH: "database/sqlite/main/db",
        [RPC_ENDPOINT_LIST_ENV_KEY]:
            '[{"url":"https://rpc-a.example","weight":1}]',
        WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        NATS_URL: "nats://127.0.0.1:42720",
        NATS_STREAM_PREFIX: "artgod",
        BACKEND_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
        BACKEND_ALLOWED_ORIGINS:
            "http://127.0.0.1:42710,http://localhost:42710,http://127.0.0.1:42701,http://localhost:42701",
        BACKEND_CSRF_COOKIE_SECURE: "false",
    };
}
