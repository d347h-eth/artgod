import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME } from "./runtime-build-profile.mjs";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const nativeContract = readFileSync(
    new URL(
        "../../src-tauri/src/runtime/local_build_contract.rs",
        import.meta.url,
    ),
    "utf8",
);
function nativeConstant(name) {
    const match = nativeContract.match(
        new RegExp(`pub const ${name}: &str =\\s*"([^"]+)";`),
    );
    if (!match)
        throw new Error(`Missing local desktop native contract: ${name}`);
    return match[1];
}
export const LOCAL_DESKTOP_FEATURE = nativeConstant("LOCAL_DESKTOP_FEATURE");
export const LOCAL_RUNTIME_RELATIVE_PATH = nativeConstant(
    "LOCAL_RUNTIME_RELATIVE_PATH",
);
export const LOCAL_LINUX_RUNTIME_PATHS = Object.freeze({
    appimage: nativeConstant("LOCAL_LINUX_APPIMAGE_RUNTIME_PATH"),
    deb: nativeConstant("LOCAL_LINUX_DEB_RUNTIME_PATH"),
});
export const LOCAL_ARTIFACT_DIRECTORY = "dist-desktop-local";
export const LOCAL_CARGO_DIRECTORY = "src-tauri/target-local";
export const LOCAL_SIDECAR_DIRECTORY = "src-tauri/binaries-local";
export const LOCAL_PROFILE_MARKER = RUNTIME_BUILD_PROFILE_MARKER_FILE_NAME;
if (nativeConstant("LOCAL_PROFILE_MARKER_NAME") !== LOCAL_PROFILE_MARKER) {
    throw new Error(
        "Local native and JavaScript profile marker names do not match.",
    );
}
export const LOCAL_PROFILE = Object.freeze({
    version: 1,
    profile: LOCAL_DESKTOP_FEATURE,
});

export function localDesktopPaths(rootDir = projectRoot) {
    return {
        artifacts: path.join(rootDir, LOCAL_ARTIFACT_DIRECTORY),
        resources: path.join(rootDir, "src-tauri", LOCAL_RUNTIME_RELATIVE_PATH),
        cargo: path.join(rootDir, LOCAL_CARGO_DIRECTORY),
        sidecars: path.join(rootDir, LOCAL_SIDECAR_DIRECTORY),
    };
}

export function assertLocalProfile(marker, description) {
    if (
        marker?.version !== LOCAL_PROFILE.version ||
        marker?.profile !== LOCAL_PROFILE.profile
    ) {
        throw new Error(
            `${description}: expected ${LOCAL_PROFILE.profile} runtime artifacts.`,
        );
    }
}

export function validateLocalRuntimeMetafile(artifact, metafile) {
    if (artifact === "trading") return;
    const inputs = Object.keys(metafile.inputs).map((input) =>
        input.replaceAll("\\", "/"),
    );
    for (const suffix of [
        "shared/observability/apm.ts",
        "shared/observability/metrics/prometheus.ts",
        "shared/observability/metrics/server.ts",
    ]) {
        if (!inputs.some((input) => input.endsWith(suffix))) {
            throw new Error(
                `${artifact}: local desktop build is missing ${suffix}.`,
            );
        }
    }
    if (
        inputs.some((input) =>
            /shared\/observability\/.*desktop\.ts$/.test(input),
        )
    ) {
        throw new Error(
            `${artifact}: local desktop build resolved a production no-op adapter.`,
        );
    }
}
