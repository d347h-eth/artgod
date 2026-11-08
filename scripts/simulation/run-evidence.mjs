import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { assertWorktreeTemporaryPath, hashFile } from "./artifacts.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_EVENT,
    SIMULATION_EVIDENCE_PREFIX,
} from "./qualification-protocol.mjs";

const MAX_SERIAL_BYTES = 64 * 1024 * 1024;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export async function assertBoundedFile(filename, maximumBytes) {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.size > maximumBytes)
        throw new Error(
            `Expected a bounded regular artifact: ${path.basename(filename)}`,
        );
    return metadata;
}

export async function readArtifactJson(
    filename,
    maximumBytes = 2 * 1024 * 1024,
) {
    await assertBoundedFile(filename, maximumBytes);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
        bytes += chunk.length;
        if (bytes > maximumBytes)
            throw new Error("JSON artifact exceeded its byte limit");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function* serialLines(filename) {
    await assertBoundedFile(filename, MAX_SERIAL_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
        bytes += chunk.length;
        if (bytes > MAX_SERIAL_BYTES)
            throw new Error("Serial evidence exceeded its byte limit");
        pending += decoder.write(chunk);
        while (pending.includes("\n")) {
            const end = pending.indexOf("\n");
            if (end > MAX_LINE_BYTES)
                throw new Error("Serial evidence line exceeded its byte limit");
            yield pending.slice(0, end).replace(/\r$/, "");
            pending = pending.slice(end + 1);
        }
        if (pending.length > MAX_LINE_BYTES)
            throw new Error("Serial evidence line exceeded its byte limit");
    }
    pending += decoder.end();
    if (pending) yield pending.replace(/\r$/, "");
}

/** Common campaign/replay view; false checks alone do not prove a guard was reached. */
export async function readRunEvidence(runDirectory) {
    const directory = await realpath(
        await assertWorktreeTemporaryPath(runDirectory),
    );
    const report = await readArtifactJson(path.join(directory, "report.json"));
    const serial = path.join(directory, "replay-serial.log");
    const fallback = path.join(directory, "record-serial.log");
    let serialPath;
    for (const candidate of [serial, fallback]) {
        try {
            const metadata = await assertBoundedFile(
                candidate,
                MAX_SERIAL_BYTES,
            );
            if (metadata.size > 0) {
                serialPath = candidate;
                break;
            }
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    const before = serialPath ? await hashFile(serialPath) : undefined;
    const events = {};
    let completion;
    for await (const line of serialPath ? serialLines(serialPath) : []) {
        if (line.startsWith(SIMULATION_EVIDENCE_PREFIX)) {
            const event = JSON.parse(
                line.slice(SIMULATION_EVIDENCE_PREFIX.length),
            );
            const keys = Object.keys(event);
            if (
                keys.length !== 1 ||
                !["probe", "result", "failure"].includes(keys[0]) ||
                events[keys[0]]
            )
                throw new Error(
                    "Guest evidence must contain one unambiguous probe/result/failure event",
                );
            events[keys[0]] = event[keys[0]];
        } else if (line.startsWith(QUALIFICATION_PROTOCOL_PREFIX)) {
            const message = JSON.parse(
                line.slice(QUALIFICATION_PROTOCOL_PREFIX.length),
            );
            if (message.event === QUALIFICATION_EVENT.Complete) {
                if (completion)
                    throw new Error(
                        "Guest evidence contains duplicate completion messages",
                    );
                completion = message;
            }
        }
    }
    if (serialPath && (await hashFile(serialPath)) !== before)
        throw new Error("Serial evidence changed during inspection");
    let expectedChecks = [];
    try {
        expectedChecks =
            (
                await readArtifactJson(
                    path.join(directory, "input-manifest.json"),
                )
            ).expectedChecks ?? [];
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const checks =
        completion?.checks ??
        report.guestReportedChecks ??
        events.failure?.checks ??
        events.result?.checks ??
        Object.fromEntries(expectedChecks.map((check) => [check, false]));
    if (report.engineReplayStatus === "passed") {
        if (
            before !== report.serialSha256 ||
            !completion ||
            completion.status !== report.propertyStatus ||
            !isDeepStrictEqual(checks, report.guestReportedChecks)
        )
            throw new Error(
                "Completed run serial/completion no longer matches its report",
            );
        if (report.propertyStatus === "passed") {
            if (
                !events.result ||
                events.failure ||
                !isDeepStrictEqual(events.result.checks, checks) ||
                !events.result.evidence ||
                typeof events.result.evidence !== "object" ||
                !Object.keys(events.result.evidence).length
            )
                throw new Error(
                    "Passing run requires exactly one matching nonempty result evidence frame",
                );
        } else if (report.propertyStatus === "failed") {
            if (
                !events.failure ||
                events.result ||
                typeof events.failure.error !== "string" ||
                !Array.isArray(events.failure.coverage)
            )
                throw new Error(
                    "Failed run requires exactly one matching failure evidence frame",
                );
            for (const [check, passed] of Object.entries(
                events.failure.checks ?? {},
            ))
                if (!Object.hasOwn(checks, check) || checks[check] !== passed)
                    throw new Error(
                        "Failure evidence check results differ from completion",
                    );
            const covered = events.failure.coverage;
            if (
                covered.length !== Object.keys(checks).length ||
                new Set(covered.map((entry) => entry.check)).size !==
                    covered.length ||
                covered.some(
                    (entry) =>
                        !Object.hasOwn(checks, entry.check) ||
                        !["passed", "failed", "unreached"].includes(
                            entry.status,
                        ) ||
                        (entry.status === "passed") !== checks[entry.check],
                )
            )
                throw new Error(
                    "Failure coverage does not match completed check results",
                );
        } else throw new Error("Completed run has no valid property status");
    }
    const evidence = events.failure ?? events.result?.evidence ?? {};
    const explicitCoverage = events.failure?.coverage ?? evidence.coverage;
    const coverage = Array.isArray(explicitCoverage)
        ? explicitCoverage
        : Object.entries(checks).map(([check, passed]) => ({
              check,
              status: passed === true ? "passed" : "unreached",
          }));
    const coverageGaps = Array.isArray(explicitCoverage)
        ? []
        : Object.entries(checks)
              .filter(([, passed]) => passed !== true)
              .map(([check]) => ({
                  check,
                  reason: "False completion check has no explicit reached-state evidence; product result remains failed",
              }));
    return {
        report,
        ...events,
        evidence,
        checks,
        coverage,
        coverageGaps,
        completion,
        serialSha256: before,
    };
}
