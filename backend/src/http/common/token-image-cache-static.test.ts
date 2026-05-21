import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { registerTokenImageCacheStaticRoutes } from "./token-image-cache-static.js";

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(
        tempDirs
            .splice(0)
            .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
});

describe("registerTokenImageCacheStaticRoutes", () => {
    it("serves cached token images and rejects traversal", async () => {
        const cacheDir = await fs.mkdtemp(
            path.join(os.tmpdir(), "artgod-token-image-static-"),
        );
        tempDirs.push(cacheDir);
        await fs.mkdir(path.join(cacheDir, "1", "2", "3"), {
            recursive: true,
        });
        await fs.writeFile(
            path.join(cacheDir, "1", "2", "3", "token.webp"),
            "cached",
            "utf8",
        );

        const app = Fastify({ logger: false });
        registerTokenImageCacheStaticRoutes(app, cacheDir);
        await app.ready();

        const image = await app.inject({
            method: "GET",
            url: "/media/token-images/1/2/3/token.webp",
        });
        expect(image.statusCode).toBe(200);
        expect(image.headers["content-type"]).toContain("image/webp");
        expect(image.body).toBe("cached");

        const traversal = await app.inject({
            method: "GET",
            url: "/media/token-images/..%2Fsecret.webp",
        });
        expect(traversal.statusCode).toBe(404);

        await app.close();
    });
});
