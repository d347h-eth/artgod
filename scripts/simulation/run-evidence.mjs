import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { assertWorktreeTemporaryPath, hashFile } from "./artifacts.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_EVENT,
    QUALIFICATION_STATUS,
    SIMULATION_EVIDENCE_PREFIX,
    SIMULATION_EVIDENCE_EVENT,
    CHECK_COVERAGE_STATUS,
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

async function readJsonArtifactBytes(
    filename,
    maximumBytes = 2 * 1024 * 1024,
    readStream = createReadStream,
) {
    await assertBoundedFile(filename, maximumBytes);
    const chunks = [];
    let bytes = 0;
    for await (const chunk of readStream(filename)) {
        bytes += chunk.length;
        if (bytes > maximumBytes)
            throw new Error("JSON artifact exceeded its byte limit");
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function readArtifactJson(
    filename,
    maximumBytes = 2 * 1024 * 1024,
) {
    return JSON.parse(
        (await readJsonArtifactBytes(filename, maximumBytes)).toString("utf8"),
    );
}

/** Bind interpretation and SHA/size to the same bounded byte capture. Callers
 * retain this pin for later disk bookends instead of repinning parsed facts. */
export async function captureArtifactJson(
    filename,
    maximumBytes = 2 * 1024 * 1024,
    { readStream = createReadStream } = {},
) {
    const bytes = await readJsonArtifactBytes(
        filename,
        maximumBytes,
        readStream,
    );
    const value = JSON.parse(bytes.toString("utf8"));
    const pin = {
        path: path.resolve(filename),
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const metadata = await assertBoundedFile(filename, maximumBytes);
    if (
        metadata.size !== pin.sizeBytes ||
        (await hashFile(filename)) !== pin.sha256
    )
        throw new Error("JSON artifact changed during byte capture");
    return { bytes, value, pin };
}

async function* serialLines(filename, onBytes = () => {}) {
    await assertBoundedFile(filename, MAX_SERIAL_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let bytes = 0;
    for await (const chunk of createReadStream(filename)) {
        onBytes(chunk);
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

/** Transport-independent bounded guest frames; completion qualification is separate. */
export async function readGuestEvidence(serialPath) {
    await assertBoundedFile(serialPath, MAX_SERIAL_BYTES);
    const before = await hashFile(serialPath);
    const readHash = createHash("sha256");
    const events = {};
    const processReady = [];
    const generations = new Map();
    let completion;
    for await (const line of serialLines(serialPath, (chunk) =>
        readHash.update(chunk),
    )) {
        if (line.startsWith(SIMULATION_EVIDENCE_PREFIX)) {
            const event = JSON.parse(
                line.slice(SIMULATION_EVIDENCE_PREFIX.length),
            );
            const keys = Object.keys(event);
            if (
                keys.length === 1 &&
                keys[0] === SIMULATION_EVIDENCE_EVENT.ProcessReady
            ) {
                const frame = event[SIMULATION_EVIDENCE_EVENT.ProcessReady];
                if (
                    !frame ||
                    Object.keys(frame).sort().join(",") !==
                        "generation,id,pid" ||
                    !/^[a-z][a-z0-9-]{0,79}$/.test(frame.id ?? "") ||
                    !Number.isSafeInteger(frame.pid) ||
                    frame.pid < 2 ||
                    frame.generation !==
                        (generations.get(frame.id) ?? -1) + 1 ||
                    processReady.length >= 128
                )
                    throw new Error(
                        "Guest readiness evidence has invalid identity or generation",
                    );
                generations.set(frame.id, frame.generation);
                processReady.push(frame);
                continue;
            }
            if (
                keys.length !== 1 ||
                ![
                    SIMULATION_EVIDENCE_EVENT.Probe,
                    SIMULATION_EVIDENCE_EVENT.Result,
                    SIMULATION_EVIDENCE_EVENT.Failure,
                ].includes(keys[0]) ||
                Object.hasOwn(events, keys[0])
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
    if (
        readHash.digest("hex") !== before ||
        (await hashFile(serialPath)) !== before
    )
        throw new Error("Serial evidence changed during inspection");
    return { events, processReady, completion, serialSha256: before };
}

/** A completed transport needs one matching terminal frame; raw false checks
 * alone do not establish which assertion/guard was reached. */
export function assertCompleteGuestEvidence(parsed, { status, checks }) {
    const { events, completion } = parsed;
    if (
        !completion ||
        completion.status !== status ||
        !isDeepStrictEqual(completion.checks, checks)
    )
        throw new Error(
            "Completed run serial/completion no longer matches its report",
        );
    if (status === QUALIFICATION_STATUS.Passed) {
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
    } else if (status === QUALIFICATION_STATUS.Failed) {
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
                    !Object.values(CHECK_COVERAGE_STATUS).includes(
                        entry.status,
                    ) ||
                    (entry.status === CHECK_COVERAGE_STATUS.Passed) !==
                        checks[entry.check],
            )
        )
            throw new Error(
                "Failure coverage does not match completed check results",
            );
    } else throw new Error("Completed run has no valid property status");
    return parsed;
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
    const parsed = serialPath
        ? await readGuestEvidence(serialPath)
        : {
              events: {},
              processReady: [],
              completion: undefined,
              serialSha256: undefined,
          };
    const { events, processReady, completion, serialSha256: before } = parsed;
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
    if (report.engineReplayStatus === QUALIFICATION_STATUS.Passed) {
        if (before !== report.serialSha256)
            throw new Error(
                "Completed run serial/completion no longer matches its report",
            );
        assertCompleteGuestEvidence(parsed, {
            status: report.propertyStatus,
            checks: report.guestReportedChecks,
        });
    }
    const evidence = events.failure ?? events.result?.evidence ?? {};
    const explicitCoverage = events.failure?.coverage ?? evidence.coverage;
    const coverage = Array.isArray(explicitCoverage)
        ? explicitCoverage
        : Object.entries(checks).map(([check, passed]) => ({
              check,
              status:
                  passed === true
                      ? CHECK_COVERAGE_STATUS.Passed
                      : CHECK_COVERAGE_STATUS.Unreached,
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
        processReady,
        evidence,
        checks,
        coverage,
        coverageGaps,
        completion,
        serialSha256: before,
    };
}
