// Shared GitHub Actions API environment keys used by release tooling.
export const ENV_GITHUB_API_URL = "GITHUB_API_URL";
export const ENV_GITHUB_REF_NAME = "GITHUB_REF_NAME";
export const ENV_GITHUB_REPOSITORY = "GITHUB_REPOSITORY";
export const ENV_GITHUB_TOKEN = "GITHUB_TOKEN";
export const ENV_GH_TOKEN = "GH_TOKEN";

const GITHUB_API_VERSION = "2026-03-10";
const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 30 * 1000;

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
    const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${githubToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
    const options = {
        method: request.method ?? "GET",
        redirect: "error",
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
        headers,
    };
    if (request.body !== undefined) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(request.body);
    }

    const response = await fetchImplementation(url, options);
    if (!response?.ok) {
        throw new Error(
            `GitHub ${description} request failed with status ${response?.status ?? "unknown"}.`,
        );
    }
    try {
        return await response.json();
    } catch {
        throw new Error(`GitHub ${description} response was not valid JSON.`);
    }
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
