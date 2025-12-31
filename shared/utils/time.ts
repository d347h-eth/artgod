export function toIso(ts?: number | null): string | undefined {
    if (ts === undefined || ts === null) return undefined;
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
}
