// Shared minimum and cutoff calculation for Cargo and executable build inputs.
export const DEFAULT_MINIMUM_AGE_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export function calculateCutoffDate(now, minimumAgeDays) {
    return new Date(now.getTime() - minimumAgeDays * MILLISECONDS_PER_DAY);
}
