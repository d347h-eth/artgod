import assert from "node:assert/strict";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { executeCommand } from "./qemu-replay.mjs";
import { readInputPins } from "./input-pins.mjs";
import {
    assertBuilderImageReference,
    prepareGuestCertificates,
    validateGuestCertificates,
} from "./guest-certificates.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// Deliberate pinned build-image fixture; this test never pulls or installs it.
const BUILDER_IMAGE = (await readInputPins()).builderImage;

async function freshDirectory() {
    const parent = path.join(ROOT, "tmp", "simulation-certificate-tests");
    await mkdir(parent, { recursive: true });
    return await mkdtemp(path.join(parent, "run-"));
}

test("synthetic TLS setup refuses unpinned images and nonempty directories before executing", async () => {
    for (const image of ["node:latest", "node@sha256:bad", undefined])
        assert.throws(() => assertBuilderImageReference(image));
    const directory = await freshDirectory();
    await writeFile(path.join(directory, "existing"), "retain this fixture");
    let calls = 0;
    await assert.rejects(
        prepareGuestCertificates({
            builderImage: BUILDER_IMAGE,
            directory,
            execute: async () => {
                calls++;
            },
        }),
        /fresh and empty/,
    );
    assert.equal(calls, 0);
    assert.equal(
        await readFile(path.join(directory, "existing"), "utf8"),
        "retain this fixture",
    );
});

test("provisioned builder creates fixed-date certificates that pass real TLS verification only with their synthetic CA", async () => {
    const directory = await freshDirectory();
    const calls = [];
    const execute = async (binary, args, options) => {
        calls.push(args);
        return await executeCommand(binary, args, options);
    };
    const result = await prepareGuestCertificates({
        builderImage: BUILDER_IMAGE,
        directory,
        execute,
    });
    const creations = calls.filter((args) => args[0] === "create");
    assert.equal(creations.length, 7);
    assert.equal(result.dockerArtifacts.length, 7);
    for (const args of creations) {
        assert.ok(args.includes("--read-only"));
        assert.equal(args[args.indexOf("--network") + 1], "none");
        assert.ok(args.includes(BUILDER_IMAGE));
        assert.ok(!args.includes("sh"));
    }
    const [ca, cert, key] = await Promise.all(
        [result.ca, result.certificate, result.key].map((filename) =>
            readFile(filename),
        ),
    );
    const server = https.createServer({ cert, key }, (_request, response) =>
        response.end("synthetic verified endpoint"),
    );
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const request = (trust) =>
        new Promise((resolve, reject) => {
            const req = https.get(
                {
                    host: "127.0.0.1",
                    port: server.address().port,
                    servername: "api.opensea.io",
                    ca: trust,
                    rejectUnauthorized: true,
                },
                (response) => {
                    let body = "";
                    response.setEncoding("utf8");
                    response.on("data", (data) => {
                        body += data;
                    });
                    response.on("end", () => resolve(body));
                },
            );
            req.once("error", reject);
            req.setTimeout(3000, () =>
                req.destroy(new Error("Synthetic TLS request timed out")),
            );
        });
    try {
        assert.equal(await request(ca), "synthetic verified endpoint");
        await assert.rejects(
            request(undefined),
            /unable to verify|self.signed/i,
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    await writeFile(result.key, await readFile(path.join(directory, "ca.key")));
    await assert.rejects(
        validateGuestCertificates(directory),
        /Server certificate\/key mismatch/,
    );
});
