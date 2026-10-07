import path from "node:path";

function project(relativeDirectory) {
    return Object.freeze({
        manifestPath: path.join(relativeDirectory, "Cargo.toml"),
        lockfilePath: path.join(relativeDirectory, "Cargo.lock"),
    });
}

// Independent Cargo roots compiled by desktop packaging and security test lanes.
// A path dependency is covered by its consuming root unless tested independently.
export const DESKTOP_CARGO_PROJECTS = Object.freeze({
    Desktop: project("src-tauri"),
    SecretPrompt: project("src-tauri/sidecars/artgod-secret-prompt"),
    SensitiveProcess: project("src-tauri/crates/artgod-sensitive-process"),
});
