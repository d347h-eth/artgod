/** CPU model is pinned with the emulator; neither value selects host passthrough. */
export const CPU_MODEL = Object.freeze({
    Nehalem: "Nehalem",
    Max: "max",
});

export function cpuModel(value) {
    if (!Object.values(CPU_MODEL).includes(value))
        throw new Error(
            "An explicit supported simulation cpu model is required",
        );
    return value;
}
