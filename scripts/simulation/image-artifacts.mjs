import path from "node:path";

/** An output overlay may reference only the already admitted immutable guest. */
export function assertExpectedOverlay(info, guestPath, directory) {
    if (info?.format !== "qcow2" || info["backing-filename-format"] !== "qcow2")
        throw new Error("Guest state requires the runner's qcow2 overlay");
    for (const key of ["backing-filename", "full-backing-filename"])
        if (
            typeof info[key] !== "string" ||
            path.resolve(directory, info[key]) !== guestPath
        )
            throw new Error(
                "Guest overlay references an unexpected backing image",
            );
    const inspect = (value) => {
        if (!value || typeof value !== "object") return;
        for (const [key, item] of Object.entries(value)) {
            if (
                (["data-file", "full-data-file", "encrypt"].includes(key) &&
                    item) ||
                (["encrypted", "corrupt", "dirty-flag"].includes(key) &&
                    item === true)
            )
                throw new Error(
                    "Guest overlay has unsafe or incomplete storage metadata",
                );
            inspect(item);
        }
    };
    inspect(info);
}

/** Compare visible capacity and bytes, independently of qcow2 allocation. */
export async function compareGuestDisks({
    run,
    first,
    second,
    guestPath,
    cwd,
}) {
    const infos = [];
    for (const filename of [first, second]) {
        const result = await run(["info", "--output=json", filename]);
        const info = JSON.parse(result.stdout);
        if (
            info.format !== "qcow2" ||
            !Number.isSafeInteger(info["virtual-size"]) ||
            info["virtual-size"] <= 0
        )
            throw new Error(
                "Guest disk comparison requires explicit qcow2 visible sizes",
            );
        if (guestPath)
            assertExpectedOverlay(info, guestPath, path.dirname(filename));
        infos.push(info);
    }
    if (infos[0]["virtual-size"] !== infos[1]["virtual-size"])
        throw new Error("Record/replay guest-visible disk sizes differ");
    await run(["compare", "-q", "-f", "qcow2", "-F", "qcow2", first, second], {
        cwd,
        timeoutMs: 120_000,
    });
}
