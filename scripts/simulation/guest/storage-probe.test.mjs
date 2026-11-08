import assert from "node:assert/strict";
import test from "node:test";
import { inspectStorage } from "./storage-probe.mjs";
import {
    storageProfile,
    STORAGE_PROFILE,
    SCENARIO_DEVICE_ENV,
    VIRTIO_ACCESS_PLATFORM_BIT,
} from "../storage-profile.mjs";

function fixture({
    missingOption = false,
    rootFeature = true,
    highWater = 16,
    missingCounter = false,
} = {}) {
    const expected = storageProfile(STORAGE_PROFILE.VirtioBounce);
    const features = Array(64).fill("0");
    if (rootFeature) features[VIRTIO_ACCESS_PLATFORM_BIT] = "1";
    const files = new Map([
        [
            "/proc/cmdline",
            `root=${expected.rootDevice} ${expected.kernelOptions.filter((_, index) => !missingOption || index > 0).join(" ")}`,
        ],
        ["/sys/block/vda/device/features", features.join("")],
        ["/sys/block/vdb/device/features", "0".repeat(64)],
        ["/sys/kernel/debug/swiotlb/io_tlb_nslabs", "32768"],
        ["/sys/kernel/debug/swiotlb/io_tlb_used", "0"],
        ["/sys/kernel/debug/swiotlb/io_tlb_used_hiwater", String(highWater)],
    ]);
    if (missingCounter)
        files.delete("/sys/kernel/debug/swiotlb/io_tlb_used_hiwater");
    return {
        environment: { [SCENARIO_DEVICE_ENV]: expected.scenarioDevice },
        async readText(filename) {
            assert.ok(
                files.has(filename),
                `Missing actual platform observation ${filename}`,
            );
            return files.get(filename);
        },
    };
}

test("forced bounce requires real writable-device negotiation and positive actual usage", async () => {
    const evidence = await inspectStorage(fixture());
    assert.equal(evidence.requested, true);
    assert.equal(evidence.devices[0].accessPlatform, true);
    assert.equal(evidence.devices[1].accessPlatform, false);
    assert.equal(evidence.swiotlb.io_tlb_used_hiwater, 16);
});
test("flags alone, feature absence and missing or unused pools cannot qualify bounce control", async () => {
    for (const options of [
        { missingOption: true },
        { rootFeature: false },
        { highWater: 0 },
        { missingCounter: true },
    ])
        await assert.rejects(
            inspectStorage(fixture(options)),
            (error) =>
                error.simulation?.failedProperty ===
                "forced-storage-bounce-observed",
        );
});
test("ordinary virtio and PIO guests make no bounce claim or missing-debugfs fallback", async () => {
    const paths = [];
    const evidence = await inspectStorage({
        readText: async (filename) => {
            paths.push(filename);
            return "root=/dev/sda libata.dma=0";
        },
    });
    assert.deepEqual(evidence, { requested: false });
    assert.deepEqual(paths, ["/proc/cmdline"]);
});
