import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readInputPins, validateBuildConfiguration } from "./input-pins.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("shared input reads validate the current profile and do not share mutable state", async () => {
    const pins = await readInputPins();
    pins.kernel.path = "/changed";
    assert.notEqual((await readInputPins()).kernel.path, "/changed");
    const parent = path.join(ROOT, "tmp/simulation-input-pin-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
    const filename = path.join(directory, "inputs.json");
    await writeFile(filename, JSON.stringify({ ...pins, machine: "pc" }));
    await assert.rejects(readInputPins(filename), /versioned/);
    await writeFile(
        filename,
        JSON.stringify({ ...pins, builderImage: "node:latest" }),
    );
    await assert.rejects(readInputPins(filename), /immutable/);
});

test("guest build inputs use the same machine, epoch and immutable image contract", async () => {
    const pins = await readInputPins();
    const input = {
        version: 1,
        runtimeImage: pins.runtimeImage,
        builderImage: pins.builderImage,
        busyboxImage: pins.busyboxImage,
        kernel: "kernel",
        firmware: "firmware",
        natsBinary: "nats-server",
        qemu: "qemu",
        qemuImg: "qemu-img",
        machine: pins.machine,
        storageProfile: pins.storageProfile,
        epoch: pins.epoch,
        scenarioFile: "scenario.json",
    };
    assert.deepEqual(validateBuildConfiguration(input), input);
    assert.throws(
        () =>
            validateBuildConfiguration({
                ...input,
                epoch: "2026-02-30T00:00:00Z",
            }),
        /exact UTC/,
    );
    assert.throws(
        () =>
            validateBuildConfiguration({ ...input, qemuArgs: ["-enable-kvm"] }),
        /exactly/,
    );
});
