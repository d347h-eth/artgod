import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const verifierPath = "scripts/docs/verify-documentation.mjs";
const openApiPath = "docs/backend/openapi.yaml";
const registrationPath = "backend/src/http-routes.ts";
const guidePath = "docs/guide.md";

// Deliberate wire/storage fixtures: exercise the CLI's supported source and
// documentation syntax without importing application code or opening its DB.
const openApiSource = `openapi: 3.0.3
info:
    title: Documentation test API
    version: 1.0.0
paths:
    /health/runtime:
        get:
            operationId: getHealth
            responses:
                "200":
                    description: Ready
                    content:
                        application/json:
                            schema:
                                $ref: "#/components/schemas/Status"
    /api/widgets:
        post:
            operationId: createWidget
            security:
                - csrfHeader: []
                  csrfCookie: []
            responses:
                "200":
                    description: Created
                "403":
                    $ref: "#/components/responses/Forbidden"
components:
    securitySchemes:
        csrfHeader:
            type: apiKey
            in: header
            name: x-test-csrf
        csrfCookie:
            type: apiKey
            in: cookie
            name: test_csrf
    responses:
        Forbidden:
            description: Forbidden
    schemas:
        Status:
            type: string
`;
const registrationSource = `registerObservedGet(app, options, "/health/runtime", handler);
registerObservedPost(app, options, TEST_ROUTES.Widgets, handler);
registerObservedGet(app, options, "/*", handler);
`;
const fixtureFiles = {
    "README.md": "# Project\n\n[Docs](docs/README.md)\n",
    "AGENTS.md": "# Agent guidance\n",
    "docs/README.md":
        "# Documentation\n\n[Backend](backend/README.md)\n\n[Guide](guide.md)\n",
    "docs/backend/README.md": "# Backend\n\n[API](openapi.yaml)\n",
    [guidePath]: "# Guide\n\n## Usage\n",
    [openApiPath]: openApiSource,
    [registrationPath]: registrationSource,
    "shared/http/api-security.ts": "",
    "shared/http/bootstrap-routes.ts": "",
    "shared/http/collection-routes.ts":
        'export const TEST_ROUTES = { Widgets: "/api/widgets" } as const;\n',
    "shared/http/trading-routes.ts": "",
};

test("accepts indexed docs, source-owned routes, and guarded mutation contracts", async (t) => {
    const result = await verifyFixture(t);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Documentation verification passed/);
});

test("checks inline links and ignores examples in fenced code", async (t) => {
    const valid = await verifyFixture(t, {
        [guidePath]: "# Guide\n\n```md\n[Example](absent.md)\n```\n",
    });
    assert.equal(valid.status, 0, valid.stderr);
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: "# Guide\n\n[Broken](absent.md)\n",
        }),
        /guide\.md:3: missing link target absent\.md/,
    );
});

test("checks full, collapsed, shortcut, and image reference links at their use", async (t) => {
    for (const reference of [
        "[Read][TARGET]",
        "[target][]",
        "[target]",
        "![Image][target]",
    ]) {
        assertFailure(
            await verifyFixture(t, {
                [guidePath]: `# Guide\n\n${reference}\n\n[target]: absent.md\n`,
            }),
            /guide\.md:3: missing link target absent\.md/,
        );
    }
});

test("reference navigation can satisfy an index, but an unused definition cannot", async (t) => {
    const valid = await verifyFixture(t, {
        "docs/README.md": "# Docs\n\n[Read][guide]\n\n[guide]: guide.md\n",
    });
    assert.equal(valid.status, 0, valid.stderr);
    assertFailure(
        await verifyFixture(t, {
            "docs/README.md": "# Docs\n\n[guide]: guide.md\n",
        }),
        /index does not link guide\.md/,
    );
});

test("checks exact heading fragments and collision suffixes", async (t) => {
    const headings = "# Guide\n\n## Usage\n\n## Usage\n\n## Usage-1\n";
    const valid = await verifyFixture(t, {
        [guidePath]: `${headings}\n[Third](#usage-1-1)\n`,
    });
    assert.equal(valid.status, 0, valid.stderr);
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: `${headings}\n[Wrong case](#Usage)\n`,
        }),
        /missing Markdown anchor #Usage/,
    );
});

test("rejects links escaping the fixture repository", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: "# Guide\n\n[Escape](../../outside.md)\n",
        }),
        /link escapes the project/,
    );
});

test("rejects retired document paths and contributor-machine paths", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            "docs/backend-api.openapi.yaml": "retired\n",
        }),
        /retired documentation path exists/,
    );
    // Assemble the forbidden path so this test is not itself an example to copy.
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: `# Guide\n\n/${"home"}/contributor/repo\n`,
        }),
        /forbidden documentation text/,
    );
});

test("rejects malformed and unclosed Mermaid fences", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: "# Guide\n\n```mermaid\nA --> B\n```\n",
        }),
        /Mermaid/,
    );
    assertFailure(
        await verifyFixture(t, {
            [guidePath]: "# Guide\n\n```mermaid\nflowchart LR\n",
        }),
        /unclosed fenced code block/,
    );
});

test("detects missing and stale OpenAPI routes and unresolved source constants", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            [registrationPath]: `${registrationSource}registerObservedGet(app, options, "/api/new", handler);\n`,
        }),
        /missing registered route GET \/api\/new/,
    );
    assertFailure(
        await verifyFixture(t, {
            [registrationPath]: registrationSource.replace(
                /registerObservedPost[^\n]+\n/,
                "",
            ),
        }),
        /route is not registered in source POST \/api\/widgets/,
    );
    assertFailure(
        await verifyFixture(t, {
            [registrationPath]: registrationSource.replace(
                "TEST_ROUTES.Widgets",
                "UNKNOWN_ROUTE",
            ),
        }),
        /unresolved route constant UNKNOWN_ROUTE/,
    );
});

test("checks local component references with either YAML quote style", async (t) => {
    for (const quote of ['"', "'"]) {
        assertFailure(
            await verifyFixture(t, {
                [openApiPath]: openApiSource.replace(
                    '"#/components/schemas/Status"',
                    `${quote}#/components/schemas/Missing${quote}`,
                ),
            }),
            /missing component reference schemas\/Missing/,
        );
    }
});

test("rejects nullable reference wrappers without a local type", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            [openApiPath]: `${openApiSource}        NullableStatus:\n            allOf:\n                - $ref: "#/components/schemas/Status"\n            nullable: true\n`,
        }),
        /nullable schema must declare its own type/,
    );
});

test("nullable enums must explicitly admit the null literal", async (t) => {
    const enumSchema = `${openApiSource}        NullableStatus:\n            type: string\n            enum: [ready, null]\n            nullable: true\n`;
    const valid = await verifyFixture(t, { [openApiPath]: enumSchema });
    assert.equal(valid.status, 0, valid.stderr);
    for (const rejectedEnum of ["[ready]", '[ready, "null"]']) {
        assertFailure(
            await verifyFixture(t, {
                [openApiPath]: enumSchema.replace(
                    "[ready, null]",
                    rejectedEnum,
                ),
            }),
            /nullable enum must include the null literal/,
        );
    }
});

test("requires unique operation identities", async (t) => {
    assertFailure(
        await verifyFixture(t, {
            [openApiPath]: openApiSource.replace(
                "operationId: createWidget",
                "operationId: getHealth",
            ),
        }),
        /duplicate operationId getHealth/,
    );
    assertFailure(
        await verifyFixture(t, {
            [openApiPath]: openApiSource.replace(
                "            operationId: createWidget\n",
                "",
            ),
        }),
        /exactly one operationId/,
    );
});

test("requires both CSRF factors and a forbidden response on mutation methods", async (t) => {
    for (const line of [
        "                - csrfHeader: []\n",
        "                  csrfCookie: []\n",
    ]) {
        assertFailure(
            await verifyFixture(t, {
                [openApiPath]: openApiSource.replace(line, ""),
            }),
            /must require CSRF header and cookie/,
        );
    }
    assertFailure(
        await verifyFixture(t, {
            [openApiPath]: openApiSource.replace(
                '                "403":\n',
                '                "401":\n',
            ),
        }),
        /must document its forbidden response/,
    );
});

async function verifyFixture(t, overrides = {}) {
    const scratchRoot = path.join(projectRoot, "tmp");
    await mkdir(scratchRoot, { recursive: true });
    const fixtureRoot = await mkdtemp(
        path.join(scratchRoot, "documentation-test-"),
    );
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const files = {
        ...fixtureFiles,
        [verifierPath]: await readFile(
            path.join(projectRoot, verifierPath),
            "utf8",
        ),
        ...overrides,
    };
    for (const [relativePath, source] of Object.entries(files)) {
        const target = path.join(fixtureRoot, relativePath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, source, "utf8");
    }
    const result = spawnSync(
        process.execPath,
        [path.join(fixtureRoot, verifierPath)],
        {
            cwd: fixtureRoot,
            encoding: "utf8",
            timeout: 10_000,
        },
    );
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    return result;
}

function assertFailure(result, expectedMessage) {
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, expectedMessage);
}
