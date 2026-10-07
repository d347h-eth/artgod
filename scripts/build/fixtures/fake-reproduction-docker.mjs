#!/usr/bin/env node
import {
    appendFileSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";

// A Docker boundary fixture for the maintained host launcher. It neither
// executes a project build nor accesses any source/Git tree.
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_DOCKER_CALLS, `${JSON.stringify(args)}\n`);
const imageId = `sha256:${"a".repeat(64)}`;
const containerId = "b".repeat(64);
if (args[0] === "buildx") {
    if (process.env.FAKE_BUILD_FAILURE)
        process.exit(Number(process.env.FAKE_BUILD_FAILURE));
    writeFileSync(args[args.indexOf("--iidfile") + 1], imageId);
    writeFileSync(args[args.indexOf("--metadata-file") + 1], "{}\n");
} else if (args[0] === "create") {
    writeFileSync(args[args.indexOf("--cidfile") + 1], containerId);
    console.log(containerId);
} else if (args[0] === "start") {
    if (process.env.FAKE_START_WAIT) {
        writeFileSync(process.env.FAKE_START_WAIT, "ready");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    process.exit(Number(process.env.FAKE_JOB_STATUS ?? 0));
} else if (args[0] === "inspect") {
    const format = args[args.indexOf("--format") + 1];
    const state = JSON.parse(
        readFileSync(process.env.FAKE_DOCKER_STATE, "utf8"),
    );
    console.log(
        format.includes("Running")
            ? state.running
            : format.includes("ExitCode")
              ? Number(process.env.FAKE_JOB_STATUS ?? 0)
              : JSON.stringify(state),
    );
} else if (args[0] === "stop") {
    writeFileSync(
        process.env.FAKE_DOCKER_STATE,
        JSON.stringify({ running: false }),
    );
} else if (args[0] === "logs") {
    console.log("job diagnostics");
} else if (args[0] === "cp") {
    if (process.env.FAKE_EXPORT_FAILURE) process.exit(23);
    const directory = path.join(args.at(-1), "evidence");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        path.join(directory, "fixture-job.json"),
        JSON.stringify({ exported: true }),
    );
} else if (args[0] !== "rm") {
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
}
