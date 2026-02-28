#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");
const frontendDir = path.join(rootDir, "frontend");
const outputDir = path.join(frontendDir, ".svelte-kit", "output");
const clientDir = path.join(outputDir, "client");
const serverIndexPath = path.join(outputDir, "server", "index.js");
const manifestPath = path.join(outputDir, "server", "manifest.js");
const distDir = path.join(frontendDir, "dist");

async function main() {
    const [{ Server }, { manifest }] = await Promise.all([
        import(pathToFileURL(serverIndexPath).href),
        import(pathToFileURL(manifestPath).href),
    ]);

    const server = new Server(manifest);
    await server.init({ env: process.env });

    const response = await server.respond(new Request("http://localhost/"), {
        getClientAddress() {
            return "127.0.0.1";
        },
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(
            `Failed to render frontend root for desktop export: HTTP ${response.status}\n${body}`,
        );
    }
    const html = await response.text();

    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await cp(clientDir, distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.html"), html, "utf-8");
    await writeFile(path.join(distDir, "404.html"), html, "utf-8");
}

main().catch((error) => {
    console.error(String(error));
    process.exit(1);
});
