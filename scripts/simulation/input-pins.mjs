import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertImageReference } from "./docker.mjs";
import { storageProfile } from "./storage-profile.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Inputs are deliberately local paths and immutable OCI references, never download URLs. */
export function validateBuildConfiguration(value) {
    if (!value || value.version !== 1)
        throw new Error("Unsupported guest build configuration");
    const keys = [
        "version",
        "runtimeImage",
        "builderImage",
        "busyboxImage",
        "kernel",
        "firmware",
        "natsBinary",
        "qemu",
        "qemuImg",
        "machine",
        "epoch",
        "scenarioFile",
        "storageProfile",
    ];
    if (
        Object.keys(value).some(
            (key) => ![...keys, "toolCapsuleFile"].includes(key),
        ) ||
        keys.some((key) => !(key in value))
    )
        throw new Error(
            `Guest build configuration requires exactly ${keys.join(", ")}`,
        );
    for (const key of ["runtimeImage", "builderImage", "busyboxImage"])
        assertImageReference(value[key]);
    storageProfile(value.storageProfile);
    for (const key of [
        "kernel",
        "firmware",
        "natsBinary",
        "qemu",
        "qemuImg",
        "scenarioFile",
        ...(value.toolCapsuleFile !== undefined ? ["toolCapsuleFile"] : []),
    ])
        if (
            typeof value[key] !== "string" ||
            !value[key] ||
            /[\x00-\x1f]/.test(value[key])
        )
            throw new Error(`${key} path is required`);
    if (!/^pc-i440fx-\d+\.\d+$/.test(value.machine ?? ""))
        throw new Error("A versioned i440fx machine is required");
    if (
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.epoch ?? "") ||
        !Number.isFinite(Date.parse(value.epoch)) ||
        new Date(value.epoch).toISOString().replace(".000Z", "Z") !==
            value.epoch
    )
        throw new Error("An exact UTC epoch is required");
    return value;
}

export const DEFAULT_INPUT_PINS = path.join(
    ROOT,
    "config/simulation-inputs.json",
);

function exactKeys(value, keys, label) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
    )
        throw new Error(`${label} requires exactly ${keys.join(", ")}`);
}

/** One owner for immutable container inputs; host tools remain explicit inputs. */
export function validateInputPins(value) {
    exactKeys(
        value,
        [
            "version",
            "architecture",
            "toolBaseImage",
            "runtimeImage",
            "builderImage",
            "busyboxImage",
            "kernel",
            "nats",
            "machine",
            "epoch",
            "storageProfile",
        ],
        "Simulation input pins",
    );
    if (value.version !== 1 || value.architecture !== "amd64")
        throw new Error("This input profile requires version 1 and amd64");
    for (const key of [
        "runtimeImage",
        "builderImage",
        "busyboxImage",
        "toolBaseImage",
    ])
        assertImageReference(value[key]);
    for (const key of ["kernel", "nats"]) {
        exactKeys(value[key], ["image", "path"], key);
        assertImageReference(value[key].image);
        if (
            typeof value[key].path !== "string" ||
            !value[key].path.startsWith("/") ||
            value[key].path === "/" ||
            path.posix.normalize(value[key].path) !== value[key].path ||
            /[\x00-\x20:]/.test(value[key].path)
        )
            throw new Error(
                `${key} extraction requires an explicit normalized container file path`,
            );
    }
    // Reuse the build owner's machine/epoch/image contract instead of a second
    // interpretation that can drift from the actual launch path.
    validateBuildConfiguration({
        version: 1,
        runtimeImage: value.runtimeImage,
        builderImage: value.builderImage,
        busyboxImage: value.busyboxImage,
        kernel: "kernel",
        natsBinary: "nats-server",
        qemu: "qemu",
        qemuImg: "qemu-img",
        firmware: "firmware",
        scenarioFile: "scenario.json",
        machine: value.machine,
        epoch: value.epoch,
        storageProfile: value.storageProfile,
    });
    return structuredClone(value);
}

/** Read the shared profile without loading guest bundlers or provisioning tools. */
export async function readInputPins(filename = DEFAULT_INPUT_PINS) {
    return validateInputPins(JSON.parse(await readFile(filename, "utf8")));
}
