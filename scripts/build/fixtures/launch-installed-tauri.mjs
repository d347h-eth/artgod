import { buildLockedTauri } from "../build-tauri.mjs";

// Exercise Windows' direct-Node dispatch with the real installed resolver and
// child CLI. On other hosts this probes the dispatch/loader boundary only.
await buildLockedTauri(["--no-bundle", "--help"], { platform: "win32" });
