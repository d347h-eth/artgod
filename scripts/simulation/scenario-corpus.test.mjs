import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverRegressionCorpus } from "./scenario-corpus.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
async function fixture() {
    await mkdir(path.join(root, "tmp/corpus-tests"), { recursive: true });
    const directory = await mkdtemp(
        path.join(root, "tmp/corpus-tests/corpus-"),
    );
    const baseline = JSON.parse(
        await readFile(
            path.join(root, "scripts/simulation/scenarios/baseline.json"),
            "utf8",
        ),
    );
    const qualification = JSON.parse(
        await readFile(
            path.join(root, "scripts/simulation/scenarios/qualification.json"),
            "utf8",
        ),
    );
    return { directory, baseline, qualification };
}

test("new authored data-plane cases are discovered without a second registration list", async () => {
    const { directory, baseline, qualification } = await fixture();
    await writeFile(
        path.join(directory, "qualification.json"),
        JSON.stringify(qualification),
    );
    await writeFile(
        path.join(directory, "baseline.json"),
        JSON.stringify(baseline),
    );
    assert.equal((await discoverRegressionCorpus(directory)).length, 1);
    await writeFile(
        path.join(directory, "additional.json"),
        JSON.stringify({ ...baseline, qualificationId: "additional-case" }),
    );
    const found = await discoverRegressionCorpus(directory);
    assert.deepEqual(
        found.map((entry) => entry.name),
        ["additional", "baseline"],
    );
});

test("invalid and duplicate authored cases cannot silently disappear", async () => {
    const { directory, baseline } = await fixture();
    await writeFile(
        path.join(directory, "baseline.json"),
        JSON.stringify(baseline),
    );
    await writeFile(
        path.join(directory, "duplicate.json"),
        JSON.stringify(baseline),
    );
    await assert.rejects(
        discoverRegressionCorpus(directory),
        /Duplicate authored/,
    );
    await writeFile(
        path.join(directory, "duplicate.json"),
        JSON.stringify({
            ...baseline,
            qualificationId: "bad",
            journey: "unimplemented",
        }),
    );
    await assert.rejects(
        discoverRegressionCorpus(directory),
        /supported journey/,
    );
});

test("empty corpora and symlinked cases fail explicitly", async () => {
    const { directory } = await fixture();
    await assert.rejects(discoverRegressionCorpus(directory), /empty/);
    await symlink(
        path.join(root, "scripts/simulation/scenarios/baseline.json"),
        path.join(directory, "linked.json"),
    );
    await assert.rejects(discoverRegressionCorpus(directory), /regular named/);
});
