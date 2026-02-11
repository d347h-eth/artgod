import http from "node:http";
import type { MetricsScrapePort } from "./types.js";

export type MetricsServerConfig = {
    host: string;
    port: number;
    scrape: MetricsScrapePort;
};

export async function startMetricsServer(
    config: MetricsServerConfig,
): Promise<() => Promise<void>> {
    const server = http.createServer(async (req, res) => {
        const method = req.method ?? "GET";
        const path = (req.url ?? "/").split("?")[0] ?? "/";

        if (method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
        }

        if (path === "/healthz") {
            res.statusCode = 200;
            res.end("ok");
            return;
        }

        if (path !== "/metrics") {
            res.statusCode = 404;
            res.end("not found");
            return;
        }

        try {
            const body = await config.scrape.metricsText();
            res.statusCode = 200;
            res.setHeader("Content-Type", config.scrape.contentType);
            res.end(body);
        } catch (error) {
            res.statusCode = 500;
            res.end(`metrics scrape failed: ${String(error)}`);
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => resolve());
    });

    return async () =>
        new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
}
