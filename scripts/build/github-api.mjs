import { setTimeout as waitForDelay } from "node:timers/promises";

// Shared GitHub Actions API environment keys used by release tooling.
export const ENV_GITHUB_API_URL = "GITHUB_API_URL";
export const ENV_GITHUB_REF_NAME = "GITHUB_REF_NAME";
export const ENV_GITHUB_REPOSITORY = "GITHUB_REPOSITORY";
export const ENV_GITHUB_TOKEN = "GITHUB_TOKEN";
export const ENV_GH_TOKEN = "GH_TOKEN";

const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 30 * 1000;
const GITHUB_READ_MAX_ATTEMPTS = 3;
const GITHUB_READ_MAX_WAIT_MS = 60 * 1000;
const GITHUB_RETRY_BASE_DELAY_MS = 1000;
const GITHUB_MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
export const GITHUB_METADATA_MEDIA_TYPE = "application/vnd.github+json";

// Resolves GitHub.com or the runner-provided GitHub Enterprise API base URL.
export function resolveGitHubApiBaseUrl(environment) {
    return environment[ENV_GITHUB_API_URL]?.trim() || DEFAULT_GITHUB_API_URL;
}

// Parses GitHub's owner/repository wire value before constructing API paths.
export function parseGitHubRepository(value) {
    const [owner, name, ...extraParts] = value.split("/");
    if (!owner || !name || extraParts.length > 0) {
        throw new Error(
            `${ENV_GITHUB_REPOSITORY} must use owner/repository form.`,
        );
    }
    return Object.freeze({ owner, name });
}

// Constructs a repository-scoped API URL with encoded ownership components.
export function createGitHubApiUrl(apiBaseUrl, repository, relativePath) {
    return `${apiBaseUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${relativePath}`;
}

// Performs a bounded JSON request without exposing failure response bodies.
export async function requestGitHubJson(
    fetchImplementation,
    url,
    githubToken,
    description,
    request = {},
) {
    const options = {
        method: request.method ?? "GET",
        redirect: "error",
        headers: {},
    };
    if (request.body !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(request.body);
    }

    const response = await requestGitHubResponse({
        fetchImplementation,
        url,
        githubToken,
        description,
        request: options,
    });
    try {
        return await response.json();
    } catch {
        throw new Error(`GitHub ${description} response was not valid JSON.`);
    }
}

// Retry only reads, never release mutations. Provider wait hints are respected in
// full; a wait exceeding the budget fails rather than retrying before it is due.
export async function requestGitHubResponse({
    fetchImplementation = fetch,
    url,
    githubToken,
    description,
    request = {},
    wait = waitForDelay,
    now = Date.now,
}) {
    const method = (request.method ?? "GET").toUpperCase();
    const readOnly = method === "GET" || method === "HEAD";
    const headers = Object.fromEntries(new Headers(request.headers));
    headers.Accept = headers.accept ?? GITHUB_METADATA_MEDIA_TYPE;
    delete headers.accept;
    delete headers.authorization;
    delete headers["x-github-api-version"];
    headers["X-GitHub-Api-Version"] = GITHUB_API_VERSION;
    if (headers["content-type"]) {
        headers["Content-Type"] = headers["content-type"];
        delete headers["content-type"];
    }
    const token = githubToken?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    let waitedMs = 0;

    for (let attempt = 1; ; attempt++) {
        const timeout = AbortSignal.timeout(GITHUB_API_TIMEOUT_MS);
        let response;
        try {
            response = await fetchImplementation(url, {
                ...request,
                method,
                headers,
                signal: request.signal
                    ? AbortSignal.any([request.signal, timeout])
                    : timeout,
            });
        } catch {
            const delayMs = GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            if (
                !readOnly ||
                request.signal?.aborted ||
                attempt >= GITHUB_READ_MAX_ATTEMPTS ||
                waitedMs + delayMs > GITHUB_READ_MAX_WAIT_MS
            ) {
                throw new Error(
                    `GitHub ${description} request failed before receiving a response.`,
                );
            }
            await wait(delayMs);
            waitedMs += delayMs;
            continue;
        }
        if (
            response?.ok ||
            (request.redirect === "manual" &&
                REDIRECT_STATUSES.has(response?.status))
        ) {
            return response;
        }

        const remaining = integerHeader(response, "x-ratelimit-remaining");
        const reset = integerHeader(response, "x-ratelimit-reset");
        const retryAfter = retryAfterMs(response, now());
        const rateLimited =
            response?.status === 429 ||
            (response?.status === 403 &&
                (remaining === 0 || retryAfter !== undefined));
        const delayMs = Math.max(
            GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
            retryAfter ?? 0,
            rateLimited && remaining === 0 && reset !== undefined
                ? reset * 1000 - now()
                : 0,
            rateLimited && retryAfter === undefined && remaining !== 0
                ? GITHUB_READ_MAX_WAIT_MS
                : 0,
            rateLimited && remaining === 0 && reset === undefined
                ? GITHUB_READ_MAX_WAIT_MS
                : 0,
        );
        await response?.body?.cancel();
        if (
            readOnly &&
            !request.signal?.aborted &&
            (rateLimited || TRANSIENT_STATUSES.has(response?.status)) &&
            attempt < GITHUB_READ_MAX_ATTEMPTS &&
            waitedMs + delayMs <= GITHUB_READ_MAX_WAIT_MS
        ) {
            await wait(delayMs);
            waitedMs += delayMs;
            continue;
        }
        const diagnostics = [
            remaining !== undefined
                ? `rate_limit_remaining=${remaining}`
                : null,
            reset !== undefined ? `rate_limit_reset=${reset}` : null,
            retryAfter !== undefined ? `retry_after_ms=${retryAfter}` : null,
        ].filter(Boolean);
        throw new Error(
            `GitHub ${description} request failed with status ${response?.status ?? "unknown"}.${diagnostics.length ? ` ${diagnostics.join(", ")}.` : ""}`,
        );
    }
}

// Authenticate only GitHub.com API requests. Redirected asset bytes and other
// origins never receive the API token; ordinary local builds need no token.
export function createGitHubBuildInputFetch({
    fetchImplementation = fetch,
    environment = process.env,
    description,
    wait = waitForDelay,
    now = Date.now,
}) {
    const githubToken = environment[ENV_GITHUB_TOKEN];
    return async (url, request = {}) => {
        if (new URL(url).origin !== DEFAULT_GITHUB_API_URL)
            return fetchImplementation(url, request);
        let currentUrl = url;
        for (let redirects = 0; ; redirects++) {
            const response = await requestGitHubResponse({
                fetchImplementation,
                url: currentUrl,
                githubToken,
                description,
                request: { ...request, redirect: "manual" },
                wait,
                now,
            });
            if (!REDIRECT_STATUSES.has(response.status)) return response;
            await response.body?.cancel();
            const location = response.headers.get("location");
            if (!location || redirects >= GITHUB_MAX_REDIRECTS)
                throw new Error(`GitHub ${description} asset redirect failed.`);
            const nextUrl = new URL(location, currentUrl);
            if (nextUrl.protocol !== "https:")
                throw new Error(
                    `GitHub ${description} asset redirect must use HTTPS.`,
                );
            if (nextUrl.origin !== DEFAULT_GITHUB_API_URL) {
                const headers = new Headers(request.headers);
                for (const name of [
                    "authorization",
                    "proxy-authorization",
                    "cookie",
                ])
                    headers.delete(name);
                return fetchImplementation(nextUrl.href, {
                    ...request,
                    headers,
                });
            }
            currentUrl = nextUrl.href;
        }
    };
}

function integerHeader(response, name) {
    const value = response?.headers?.get(name);
    return /^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value))
        ? Number(value)
        : undefined;
}

function retryAfterMs(response, now) {
    const value = response?.headers?.get("retry-after");
    if (!value) return undefined;
    const milliseconds = /^\d+(\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value) - now;
    return Number.isFinite(milliseconds) && milliseconds >= 0
        ? milliseconds
        : undefined;
}

// Requires an object-shaped JSON response at a GitHub API boundary.
export function assertGitHubJsonRecord(value, description) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${description} is missing or malformed.`);
    }
}

// Reads a required non-empty GitHub Actions environment value.
export function requireEnvironmentValue(environment, key) {
    const value = environment[key];
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
        throw new Error(`Missing environment variable ${key}.`);
    }
    return normalized;
}
