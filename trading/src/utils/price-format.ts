// Formats integer token amounts for display without leaking adapter-specific libs into domain code.
export function formatPrice(amount: bigint | number, decimals: number): string {
    const raw = typeof amount === "bigint" ? amount : BigInt(Math.trunc(amount));
    const sign = raw < 0n ? "-" : "";
    const abs = raw < 0n ? -raw : raw;

    if (decimals <= 0) {
        return `${sign}${abs.toString()}.0000`;
    }

    const scale = 10n ** BigInt(decimals);
    const whole = abs / scale;
    const fraction = abs % scale;
    const fractionDigits = fraction
        .toString()
        .padStart(decimals, "0")
        .slice(0, 4)
        .padEnd(4, "0");

    return `${sign}${whole.toString()}.${fractionDigits}`;
}
