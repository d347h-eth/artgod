import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerUserlandStaticRoutes } from "./userland-static.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
});

describe("registerUserlandStaticRoutes", () => {
    it("serves static assets and falls back to index for SPA paths", async () => {
        const userlandDir = await createUserlandFixture();
        const app = Fastify({ logger: false });
        app.get("/api/ping", async () => ({ ok: true }));
        app.get("/health/runtime", async () => ({ ok: true }));
        registerUserlandStaticRoutes(app, userlandDir);
        await app.ready();

        const root = await app.inject({ method: "GET", url: "/" });
        expect(root.statusCode).toBe(200);
        expect(root.headers["content-type"]).toContain("text/html");
        expect(root.body).toContain('<div id="app">userland</div>');

        const asset = await app.inject({
            method: "GET",
            url: "/assets/app.js",
        });
        expect(asset.statusCode).toBe(200);
        expect(asset.headers["content-type"]).toContain("text/javascript");
        expect(asset.body).toContain("console.log('userland')");

        const spaRoute = await app.inject({
            method: "GET",
            url: "/ethereum/milady",
        });
        expect(spaRoute.statusCode).toBe(200);
        expect(spaRoute.headers["content-type"]).toContain("text/html");

        const api = await app.inject({ method: "GET", url: "/api/ping" });
        expect(api.statusCode).toBe(200);
        expect(api.json()).toEqual({ ok: true });

        const health = await app.inject({
            method: "GET",
            url: "/health/runtime",
        });
        expect(health.statusCode).toBe(200);
        expect(health.json()).toEqual({ ok: true });

        await app.close();
    });

    it("fails fast when static dist is missing", () => {
        const app = Fastify({ logger: false });
        const missingPath = path.join(
            os.tmpdir(),
            `artgod-userland-missing-${Date.now()}`,
        );
        expect(() => registerUserlandStaticRoutes(app, missingPath)).toThrow(
            "USERLAND_UI_DIST_DIR is missing static assets",
        );
    });
});

async function createUserlandFixture(): Promise<string> {
    const dir = await fs.mkdtemp(
        path.join(os.tmpdir(), "artgod-userland-static-"),
    );
    tempDirs.push(dir);
    await fs.mkdir(path.join(dir, "assets"), { recursive: true });
    await fs.writeFile(
        path.join(dir, "index.html"),
        '<!doctype html><html><body><div id="app">userland</div></body></html>',
        "utf8",
    );
    await fs.writeFile(
        path.join(dir, "assets", "app.js"),
        "console.log('userland')",
        "utf8",
    );
    return dir;
}
