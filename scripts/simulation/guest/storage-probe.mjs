import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
    STORAGE_PROFILE,
    storageProfile,
    SCENARIO_DEVICE_ENV,
    VIRTIO_ACCESS_PLATFORM_BIT,
} from "../storage-profile.mjs";

const SWIOTLB_DIRECTORY = "/sys/kernel/debug/swiotlb";

/** Inspect the real Linux DMA path. This does not substitute any workload I/O. */
export async function inspectStorage({
    readText = (filename) => readFile(filename, "utf8"),
    environment = process.env,
} = {}) {
    const commandLine = (await readText("/proc/cmdline")).trim();
    const tokens = commandLine.split(/\s+/);
    const expected = storageProfile(STORAGE_PROFILE.VirtioBounce);
    const requested = expected.kernelOptions.some((option) =>
        tokens.includes(option),
    );
    if (!requested) return { requested: false };
    const evidence = {
        requested: true,
        profile: STORAGE_PROFILE.VirtioBounce,
        commandLine,
        devices: [],
    };
    try {
        for (const option of expected.kernelOptions)
            assert.ok(
                tokens.includes(option),
                `Bounce storage requires active kernel option ${option}`,
            );
        assert.ok(
            tokens.includes(`root=${expected.rootDevice}`),
            "Bounce probe must identify the actual writable root device",
        );
        assert.equal(
            environment[SCENARIO_DEVICE_ENV],
            expected.scenarioDevice,
            "Bounce probe must identify the actual read-only input device",
        );
        for (const device of [expected.rootDevice, expected.scenarioDevice]) {
            const features = (
                await readText(
                    `/sys/block/${path.basename(device)}/device/features`,
                )
            ).trim();
            assert.match(
                features,
                /^[01]{64}$/,
                `Linux must report negotiated feature bits for ${device}`,
            );
            const accessPlatform = features[VIRTIO_ACCESS_PLATFORM_BIT] === "1";
            evidence.devices.push({ device, features, accessPlatform });
            // The scenario disk is read-only. The host profile deliberately
            // changes the writable root's DMA path and retains the input path.
            if (device === expected.rootDevice)
                assert.ok(
                    accessPlatform,
                    "Writable virtio root must negotiate ACCESS_PLATFORM",
                );
        }
        const counters = {};
        for (const name of [
            "io_tlb_nslabs",
            "io_tlb_used",
            "io_tlb_used_hiwater",
        ]) {
            const text = (
                await readText(`${SWIOTLB_DIRECTORY}/${name}`)
            ).trim();
            assert.match(
                text,
                /^\d+$/,
                `Actual SWIOTLB ${name} must be available`,
            );
            const value = Number(text);
            assert.ok(
                Number.isSafeInteger(value),
                `SWIOTLB ${name} must be a bounded integer`,
            );
            counters[name] = value;
        }
        evidence.swiotlb = counters;
        assert.ok(
            counters.io_tlb_nslabs > 0,
            "Forced SWIOTLB requires an allocated bounce pool",
        );
        assert.ok(
            counters.io_tlb_used_hiwater > 0,
            "Real guest I/O must have used the SWIOTLB bounce pool",
        );
        assert.ok(
            counters.io_tlb_used <= counters.io_tlb_nslabs &&
                counters.io_tlb_used_hiwater <= counters.io_tlb_nslabs,
            "SWIOTLB usage must fit its actual pool",
        );
        return evidence;
    } catch (error) {
        error.simulation = {
            ...(error.simulation ?? {}),
            failedProperty: "forced-storage-bounce-observed",
            storageProbe: evidence,
        };
        throw error;
    }
}
