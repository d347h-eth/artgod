import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
    validateScenario,
    EXTERNAL_ACTION,
    VALIDATION_RELEASE,
    RUNTIME_PROFILE,
} from "./scenario-contract.mjs";

for (const filename of (
    await readdir(new URL("../scenarios/", import.meta.url))
)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const name = filename.slice(0, -5);
    test(`the ${name} manifest establishes its complete named journey`, async () => {
        const source = JSON.parse(
            await readFile(
                new URL(`../scenarios/${name}.json`, import.meta.url),
                "utf8",
            ),
        );
        assert.deepEqual(validateScenario(source), source);
        assert.throws(
            () =>
                validateScenario({
                    ...source,
                    expectedChecks: source.expectedChecks.slice(1),
                }),
            /every check/,
        );
        assert.throws(
            () =>
                validateScenario({
                    ...source,
                    environment: { NATS_URL: "nats://operator" },
                }),
            /Unknown scenario field/,
        );
    });
}

test("a committed-before-fork witness cannot run the canonical switch before release", async () => {
    const source = JSON.parse(
        await readFile(
            new URL(
                "../scenarios/fork-committed-validation.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    assert.equal(source.validationRelease, VALIDATION_RELEASE.BeforeRollback);
    assert.throws(
        () =>
            validateScenario({
                ...source,
                schedule: [
                    EXTERNAL_ACTION.CanonicalSwitch,
                    EXTERNAL_ACTION.ReleaseValidation,
                    EXTERNAL_ACTION.RestoreInventory,
                    EXTERNAL_ACTION.StreamListing,
                ],
            }),
        /release before/,
    );
});

test("provider budgets and endpoint selection are typed finite fixture inputs", async () => {
    const source = JSON.parse(
        await readFile(
            new URL(
                "../scenarios/weighted-provider-disagreement.json",
                import.meta.url,
            ),
            "utf8",
        ),
    );
    assert.equal(source.runtimeProfile, RUNTIME_PROFILE.Default);
    assert.equal(source.rpcProviders.length, 2);
    assert.throws(
        () =>
            validateScenario({ ...source, runtimeProfile: "silent-unlimited" }),
        /Runtime profile/,
    );
    assert.throws(
        () => validateScenario({ ...source, rpcProviders: ["a", "a"] }),
        /RPC provider/,
    );
});

test("unsupported journeys and hidden external inputs fail rather than qualify a smaller workload", async () => {
    const source = JSON.parse(
        await readFile(
            new URL("../scenarios/baseline.json", import.meta.url),
            "utf8",
        ),
    );
    assert.throws(
        () => validateScenario({ ...source, journey: "future-p2p" }),
        /supported journey/,
    );
    assert.throws(
        () =>
            validateScenario({
                ...source,
                world: { rpcUrl: "https://operator" },
            }),
        /Unknown external world field/,
    );
});
