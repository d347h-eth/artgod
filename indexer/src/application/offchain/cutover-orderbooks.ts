/** Called with the old producers and order consumers stopped. A crash between
 * the broker pass and the database commit can repeat the bounded broker pass. */
export async function cutoverOrderbooks(
    db: { pending(): boolean; reset(): void },
    broker: { retireLegacyBookJobs(): Promise<number> },
) {
    if (!db.pending()) return { retired: 0, applied: false };
    const retired = await broker.retireLegacyBookJobs();
    db.reset();
    return { retired, applied: true };
}
