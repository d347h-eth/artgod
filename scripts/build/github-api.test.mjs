import assert from "node:assert/strict";
import test from "node:test";
import {
    createGitHubBuildInputFetch,
    ENV_GITHUB_TOKEN,
    GITHUB_METADATA_MEDIA_TYPE,
    requestGitHubJson,
    requestGitHubResponse,
} from "./github-api.mjs";

const apiUrl = "https://api.github.com/repos/example/tools/releases/assets/1";
const token = "github-build-input-test-token";
const timestamp = Date.parse("2026-10-11T00:00:00Z");
const description = "test input";

test("build inputs authenticate API requests without adding credentials to other origins", async () => {
    const requests = [];
    const fetchInput = createGitHubBuildInputFetch({
        environment: { [ENV_GITHUB_TOKEN]: token },
        description,
        fetchImplementation: async (url, options) => {
            requests.push({ url, options });
            return Response.json({});
        },
    });
    await fetchInput(apiUrl, {
        headers: { Accept: "application/octet-stream" },
    });
    for (const url of [
        "https://nodejs.org/dist/index.json",
        "https://raw.githubusercontent.com/example/tools/revision/script.sh",
        "https://api.github.com.example/asset",
    ]) {
        await fetchInput(url);
    }
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(
        requests[0].options.headers.Accept,
        "application/octet-stream",
    );
    assert.ok(requests[0].options.signal instanceof AbortSignal);
    for (const { options } of requests.slice(1))
        assert.equal(new Headers(options.headers).has("authorization"), false);
});

test("local builds without a token make anonymous API requests", async () => {
    await createGitHubBuildInputFetch({
        environment: {},
        description,
        fetchImplementation: async (_url, options) => {
            assert.equal(
                new Headers(options.headers).has("authorization"),
                false,
            );
            assert.equal(options.headers.Accept, GITHUB_METADATA_MEDIA_TYPE);
            return Response.json({});
        },
    })(apiUrl);
});

test("asset redirects retain the byte contract and strip credentials on the CDN request", async () => {
    const cdnUrl = "https://release-assets.githubusercontent.com/reviewed.bin";
    const requests = [];
    const response = await createGitHubBuildInputFetch({
        environment: { [ENV_GITHUB_TOKEN]: token },
        description,
        fetchImplementation: async (url, options) => {
            requests.push({ url, options });
            return url === apiUrl
                ? new Response(null, {
                      status: 302,
                      headers: { location: cdnUrl },
                  })
                : new Response("reviewed bytes");
        },
    })(apiUrl, {
        headers: {
            Accept: "application/octet-stream",
            Authorization: "caller credential",
            Cookie: "caller cookie",
        },
    });
    assert.equal(await response.text(), "reviewed bytes");
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
    assert.equal(requests[1].url, cdnUrl);
    const headers = new Headers(requests[1].options.headers);
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.get("accept"), "application/octet-stream");
});

test("same-origin asset redirects retain API authentication", async () => {
    let requests = 0;
    await createGitHubBuildInputFetch({
        environment: { [ENV_GITHUB_TOKEN]: token },
        description,
        fetchImplementation: async (_url, options) => {
            requests++;
            assert.equal(options.headers.Authorization, `Bearer ${token}`);
            return requests === 1
                ? new Response(null, {
                      status: 307,
                      headers: { location: "/next" },
                  })
                : new Response("bytes");
        },
    })(apiUrl);
    assert.equal(requests, 2);
});

test("redirects must use HTTPS and loops have a finite limit", async () => {
    for (const location of ["http://example.invalid/input", apiUrl]) {
        let requests = 0;
        await assert.rejects(
            createGitHubBuildInputFetch({
                environment: { [ENV_GITHUB_TOKEN]: token },
                description,
                fetchImplementation: async () => {
                    requests++;
                    return new Response(null, {
                        status: 302,
                        headers: { location },
                    });
                },
            })(apiUrl),
            /redirect/,
        );
        assert.equal(requests, location === apiUrl ? 6 : 1);
    }
});

for (const { name, status, headers, expectedDelay } of [
    { name: "transient HTTP failure", status: 503, expectedDelay: 1000 },
    {
        name: "quota Retry-After",
        status: 429,
        headers: { "retry-after": "2" },
        expectedDelay: 2000,
    },
    {
        name: "primary quota reset",
        status: 403,
        headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(timestamp / 1000 + 5),
        },
        expectedDelay: 5000,
    },
    {
        name: "both quota hints",
        status: 403,
        headers: {
            "retry-after": "1",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(timestamp / 1000 + 5),
        },
        expectedDelay: 5000,
    },
    {
        name: "HTTP-date Retry-After",
        status: 429,
        headers: { "retry-after": new Date(timestamp + 5000).toUTCString() },
        expectedDelay: 5000,
    },
    { name: "quota without hints", status: 429, expectedDelay: 60000 },
]) {
    test(`read retries respect ${name}`, async () => {
        let attempts = 0;
        const waits = [];
        const response = await requestGitHubResponse({
            url: apiUrl,
            githubToken: token,
            description,
            now: () => timestamp,
            wait: async (delay) => waits.push(delay),
            fetchImplementation: async () => {
                attempts++;
                return attempts === 1
                    ? new Response(null, { status, headers })
                    : new Response("success");
            },
        });
        assert.equal(await response.text(), "success");
        assert.equal(attempts, 2);
        assert.deepEqual(waits, [expectedDelay]);
    });
}

test("rate limits beyond the wait budget fail with safe diagnostics without retrying early", async () => {
    let attempts = 0;
    await assert.rejects(
        requestGitHubResponse({
            url: apiUrl,
            githubToken: token,
            description,
            now: () => timestamp,
            wait: async () =>
                assert.fail("must not retry before the distant reset"),
            fetchImplementation: async () => {
                attempts++;
                return new Response(`secret response ${token}`, {
                    status: 403,
                    headers: {
                        "x-ratelimit-remaining": "0",
                        "x-ratelimit-reset": String(timestamp / 1000 + 3600),
                    },
                });
            },
        }),
        (error) => {
            assert.match(
                error.message,
                /status 403.*rate_limit_remaining=0.*rate_limit_reset=/,
            );
            assert.ok(!error.message.includes(token));
            assert.ok(!error.message.includes("secret response"));
            return true;
        },
    );
    assert.equal(attempts, 1);
});

test("ordinary permission failures are not retried", async () => {
    for (const status of [401, 403, 404]) {
        let attempts = 0;
        await assert.rejects(
            requestGitHubResponse({
                url: apiUrl,
                description,
                wait: async () =>
                    assert.fail("terminal response must not retry"),
                fetchImplementation: async () => {
                    attempts++;
                    return new Response(null, { status });
                },
            }),
            new RegExp(`status ${status}`),
        );
        assert.equal(attempts, 1);
    }
});

test("transient reads have an attempt limit and quota retries have a total wait budget", async () => {
    for (const [status, expectedAttempts, expectedWaits] of [
        [503, 3, [1000, 2000]],
        [429, 2, [60000]],
    ]) {
        let attempts = 0;
        const waits = [];
        await assert.rejects(
            requestGitHubResponse({
                url: apiUrl,
                description,
                wait: async (delay) => waits.push(delay),
                fetchImplementation: async () => {
                    attempts++;
                    return new Response(null, { status });
                },
            }),
            new RegExp(`status ${status}`),
        );
        assert.equal(attempts, expectedAttempts);
        assert.deepEqual(waits, expectedWaits);
    }
});

test("network read failures retry without exposing fetch errors or credentials", async () => {
    let attempts = 0;
    const waits = [];
    await assert.rejects(
        requestGitHubResponse({
            url: apiUrl,
            githubToken: token,
            description,
            wait: async (delay) => waits.push(delay),
            fetchImplementation: async () => {
                attempts++;
                throw new TypeError(`network failure containing ${token}`);
            },
        }),
        (error) => {
            assert.match(error.message, /before receiving a response/);
            assert.ok(!error.message.includes(token));
            return true;
        },
    );
    assert.equal(attempts, 3);
    assert.deepEqual(waits, [1000, 2000]);
});

test("release mutations remain single-attempt and preserve the JSON request contract", async () => {
    for (const status of [403, 429, 503]) {
        let attempts = 0;
        await assert.rejects(
            requestGitHubJson(
                async (_url, options) => {
                    attempts++;
                    assert.equal(options.method, "PATCH");
                    assert.equal(options.redirect, "error");
                    assert.equal(
                        options.headers["Content-Type"],
                        "application/json",
                    );
                    assert.deepEqual(JSON.parse(options.body), {
                        draft: false,
                    });
                    return new Response(null, {
                        status,
                        headers: { "retry-after": "1" },
                    });
                },
                apiUrl,
                token,
                "publish release",
                { method: "PATCH", body: { draft: false } },
            ),
            new RegExp(`status ${status}`),
        );
        assert.equal(attempts, 1);
    }
});

test("already cancelled reads do not schedule retries", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        requestGitHubResponse({
            url: apiUrl,
            description,
            request: { signal: controller.signal },
            wait: async () => assert.fail("cancelled work must not retry"),
            fetchImplementation: async () => {
                throw new TypeError("cancelled");
            },
        }),
        /before receiving a response/,
    );
});
