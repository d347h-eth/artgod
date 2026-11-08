import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENARIO_KIND, validateScenario } from "./guest/scenario-contract.mjs";

const DEFAULT_DIRECTORY = fileURLToPath(
    new URL("./scenarios/", import.meta.url),
);

/** Every authored data-plane case is a regression; an invalid case cannot vanish. */
export async function discoverRegressionCorpus(directory = DEFAULT_DIRECTORY) {
    const corpus = [];
    const identities = new Set();
    for (const entry of (
        await readdir(directory, { withFileTypes: true })
    ).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.name.endsWith(".json")) continue;
        if (!entry.isFile() || !/^[a-z0-9][a-z0-9-]*\.json$/.test(entry.name))
            throw new Error(
                `Authored scenario must be a regular named JSON file: ${entry.name}`,
            );
        const scenarioFile = path.resolve(directory, entry.name);
        let scenario;
        try {
            scenario = validateScenario(
                JSON.parse(await readFile(scenarioFile, "utf8")),
            );
        } catch (error) {
            throw new Error(
                `Invalid authored scenario ${entry.name}: ${error.message}`,
                { cause: error },
            );
        }
        if (identities.has(scenario.qualificationId))
            throw new Error(
                `Duplicate authored scenario identity: ${scenario.qualificationId}`,
            );
        identities.add(scenario.qualificationId);
        if (scenario.kind === SCENARIO_KIND.DataPlane)
            corpus.push({
                name: entry.name.slice(0, -5),
                scenarioFile,
                scenario,
            });
    }
    if (!corpus.length)
        throw new Error("The authored regression corpus is empty");
    return corpus;
}
