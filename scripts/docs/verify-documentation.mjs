#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);

// Canonical documentation entrypoints checked alongside the docs tree.
const ROOT_DOCUMENT_PATHS = Object.freeze(["README.md", "AGENTS.md"]);
const DOCUMENTATION_ROOT_PATH = "docs";
const DOCUMENT_INDEX_FILE_NAME = "README.md";
const MARKDOWN_FILE_EXTENSION = ".md";

// Source-owned HTTP contracts compared with the generated human reference.
const HTTP_ROUTE_REGISTRATION_PATH = "backend/src/http-routes.ts";
const OPENAPI_DOCUMENT_PATH = "docs/backend/openapi.yaml";
const HTTP_ROUTE_OWNER_PATHS = Object.freeze([
    "shared/http/api-security.ts",
    "shared/http/bootstrap-routes.ts",
    "shared/http/collection-routes.ts",
    "shared/http/trading-routes.ts",
]);
const MUTATING_HTTP_METHODS = new Set(["post", "put", "patch", "delete"]);

// These path forms make documentation machine-specific or revive retired WIP.
const FORBIDDEN_DOCUMENT_TEXT = Object.freeze([
    "docs/progress/",
    "/home/",
    "/root/",
]);
const RETIRED_DOCUMENT_PATHS = Object.freeze([
    "docs/backend-api.openapi.yaml",
    "docs/indexer/17-bootstrap-concurrency-audit.md",
]);
const RETIRED_DOCUMENT_NAME_PATTERN =
    /(^|[-_.])(gap|gaps|plan|roadmap|wip)([-_.]|$)/i;

// Mermaid fences must start with a real diagram declaration.
const MERMAID_DECLARATION_PATTERN =
    /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|timeline|mindmap|gitGraph|C4\w+|sankey-beta|xychart-beta|block-beta|architecture-beta|packet-beta|kanban)\b/;

async function main() {
    const errors = [];
    const docsRoot = path.join(projectRoot, DOCUMENTATION_ROOT_PATH);
    const docsMarkdownPaths = await listFilesRecursively(docsRoot, (filePath) =>
        filePath.endsWith(MARKDOWN_FILE_EXTENSION),
    );
    const documentPaths = [
        ...ROOT_DOCUMENT_PATHS.map((relativePath) =>
            path.join(projectRoot, relativePath),
        ),
        ...docsMarkdownPaths,
    ].sort();
    const documentSources = new Map(
        await Promise.all(
            documentPaths.map(async (filePath) => [
                filePath,
                await readFile(filePath, "utf8"),
            ]),
        ),
    );

    checkRetiredDocumentation(documentSources, errors);
    await checkRetiredDocumentPaths(errors);
    await checkDocumentationIndexes(docsMarkdownPaths, documentSources, errors);
    await checkMarkdownLinks(documentSources, errors);
    checkMermaidBlocks(documentSources, errors);
    await checkOpenApiRouteParity(errors);
    await checkOpenApiReferences(errors);
    await checkOpenApiOperationIds(errors);
    await checkOpenApiMutationSecurity(errors);

    if (errors.length > 0) {
        console.error(`Documentation verification failed (${errors.length}):`);
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exitCode = 1;
        return;
    }

    console.log(
        `Documentation verification passed for ${documentPaths.length} Markdown files.`,
    );
}

async function checkRetiredDocumentPaths(errors) {
    for (const relativePath of RETIRED_DOCUMENT_PATHS) {
        try {
            await stat(path.join(projectRoot, relativePath));
            errors.push(`${relativePath}: retired documentation path exists`);
        } catch (error) {
            if (error?.code !== "ENOENT") {
                throw error;
            }
        }
    }
}

async function listFilesRecursively(rootPath, includeFile) {
    const entries = await readdir(rootPath, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map(async (entry) => {
            const entryPath = path.join(rootPath, entry.name);
            if (entry.isDirectory()) {
                return listFilesRecursively(entryPath, includeFile);
            }
            return entry.isFile() && includeFile(entryPath) ? [entryPath] : [];
        }),
    );
    return nested.flat().sort();
}

function checkRetiredDocumentation(documentSources, errors) {
    for (const [filePath, source] of documentSources) {
        const projectPath = toProjectPath(filePath);
        if (projectPath.startsWith(`${DOCUMENTATION_ROOT_PATH}/progress/`)) {
            errors.push(`${projectPath}: retired progress document`);
        }
        if (
            projectPath.startsWith(`${DOCUMENTATION_ROOT_PATH}/`) &&
            !projectPath.startsWith(`${DOCUMENTATION_ROOT_PATH}/planning/`) &&
            RETIRED_DOCUMENT_NAME_PATTERN.test(path.basename(projectPath))
        ) {
            errors.push(`${projectPath}: retired plan/WIP-style filename`);
        }

        for (const forbiddenText of FORBIDDEN_DOCUMENT_TEXT) {
            for (const lineNumber of findLineNumbers(source, forbiddenText)) {
                errors.push(
                    `${projectPath}:${lineNumber}: forbidden documentation text ${JSON.stringify(forbiddenText)}`,
                );
            }
        }
    }
}

async function checkDocumentationIndexes(
    docsMarkdownPaths,
    documentSources,
    errors,
) {
    const pathsByDirectory = new Map();
    for (const filePath of docsMarkdownPaths) {
        const directoryPath = path.dirname(filePath);
        const directPaths = pathsByDirectory.get(directoryPath) ?? [];
        directPaths.push(filePath);
        pathsByDirectory.set(directoryPath, directPaths);
    }

    for (const [directoryPath, directPaths] of pathsByDirectory) {
        if (directPaths.length < 2) {
            continue;
        }
        const indexPath = path.join(directoryPath, DOCUMENT_INDEX_FILE_NAME);
        const directoryProjectPath = toProjectPath(directoryPath);
        const indexSource = documentSources.get(indexPath);
        if (indexSource === undefined) {
            errors.push(
                `${directoryProjectPath}: multiple Markdown documents require ${DOCUMENT_INDEX_FILE_NAME}`,
            );
            continue;
        }

        const linkedPaths = resolveLocalMarkdownLinkPaths(
            indexPath,
            indexSource,
        );
        for (const directPath of directPaths) {
            if (directPath === indexPath || linkedPaths.has(directPath)) {
                continue;
            }
            errors.push(
                `${toProjectPath(indexPath)}: index does not link ${path.basename(directPath)}`,
            );
        }
    }
}

function resolveLocalMarkdownLinkPaths(sourcePath, source) {
    const resolvedPaths = new Set();
    for (const link of extractMarkdownLinks(source)) {
        const parsed = parseLocalLink(link.target);
        if (!parsed || !parsed.pathPart) {
            continue;
        }
        resolvedPaths.add(
            path.resolve(path.dirname(sourcePath), decodePath(parsed.pathPart)),
        );
    }
    return resolvedPaths;
}

async function checkMarkdownLinks(documentSources, errors) {
    const headingCache = new Map();
    for (const [sourcePath, source] of documentSources) {
        for (const link of extractMarkdownLinks(source)) {
            const parsed = parseLocalLink(link.target);
            if (!parsed) {
                continue;
            }
            const sourceProjectPath = toProjectPath(sourcePath);
            const targetPath = parsed.pathPart
                ? path.resolve(
                      path.dirname(sourcePath),
                      decodePath(parsed.pathPart),
                  )
                : sourcePath;
            const targetProjectPath = toProjectPath(targetPath);
            if (targetProjectPath.startsWith("../")) {
                errors.push(
                    `${sourceProjectPath}:${link.lineNumber}: link escapes the project: ${link.target}`,
                );
                continue;
            }

            let targetStats;
            try {
                targetStats = await stat(targetPath);
            } catch {
                errors.push(
                    `${sourceProjectPath}:${link.lineNumber}: missing link target ${link.target}`,
                );
                continue;
            }

            const resolvedTargetPath = targetStats.isDirectory()
                ? path.join(targetPath, DOCUMENT_INDEX_FILE_NAME)
                : targetPath;
            if (!parsed.fragment || !resolvedTargetPath.endsWith(".md")) {
                continue;
            }

            let anchors = headingCache.get(resolvedTargetPath);
            if (!anchors) {
                try {
                    anchors = collectHeadingAnchors(
                        await readFile(resolvedTargetPath, "utf8"),
                    );
                    headingCache.set(resolvedTargetPath, anchors);
                } catch {
                    errors.push(
                        `${sourceProjectPath}:${link.lineNumber}: cannot read anchor target ${link.target}`,
                    );
                    continue;
                }
            }
            const fragment = decodeFragment(parsed.fragment).toLowerCase();
            if (!anchors.has(fragment)) {
                errors.push(
                    `${sourceProjectPath}:${link.lineNumber}: missing Markdown anchor #${parsed.fragment} in ${toProjectPath(resolvedTargetPath)}`,
                );
            }
        }
    }
}

function extractMarkdownLinks(source) {
    const visibleSource = stripFencedCode(source);
    const links = [];
    const linkPattern = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;
    for (const match of visibleSource.matchAll(linkPattern)) {
        links.push({
            target: normalizeMarkdownLinkTarget(match[1]),
            lineNumber: lineNumberAt(visibleSource, match.index ?? 0),
        });
    }
    return links;
}

function normalizeMarkdownLinkTarget(rawTarget) {
    const target = rawTarget.trim();
    if (target.startsWith("<")) {
        const closingIndex = target.indexOf(">");
        return closingIndex >= 0 ? target.slice(1, closingIndex) : target;
    }
    return target.split(/\s+(?=["'])/, 1)[0];
}

function parseLocalLink(target) {
    if (
        !target ||
        target.startsWith("/") ||
        target.startsWith("//") ||
        /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
        return null;
    }
    const hashIndex = target.indexOf("#");
    const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : "";
    const beforeFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
    const queryIndex = beforeFragment.indexOf("?");
    const pathPart =
        queryIndex >= 0 ? beforeFragment.slice(0, queryIndex) : beforeFragment;
    return { pathPart, fragment };
}

function collectHeadingAnchors(source) {
    const visibleSource = stripFencedCode(source);
    const anchors = new Set();
    const slugCounts = new Map();
    for (const line of visibleSource.split(/\r?\n/)) {
        const match = line.match(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        if (!match) {
            continue;
        }
        const baseSlug = githubHeadingSlug(match[1]);
        if (!baseSlug) {
            continue;
        }
        const count = slugCounts.get(baseSlug) ?? 0;
        slugCounts.set(baseSlug, count + 1);
        anchors.add(count === 0 ? baseSlug : `${baseSlug}-${count}`);
    }
    return anchors;
}

function githubHeadingSlug(heading) {
    return heading
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/[`*_~]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s/g, "-");
}

function checkMermaidBlocks(documentSources, errors) {
    for (const [filePath, source] of documentSources) {
        const projectPath = toProjectPath(filePath);
        const lines = source.split(/\r?\n/);
        let activeFence = null;
        let mermaidStartLine = null;
        let mermaidLines = [];

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index];
            const fence = line.match(/^\s*(`{3,}|~{3,})([^`]*)$/);
            if (!activeFence && fence) {
                activeFence = fence[1];
                if (fence[2].trim().toLowerCase() === "mermaid") {
                    mermaidStartLine = index + 1;
                    mermaidLines = [];
                }
                continue;
            }
            if (
                activeFence &&
                new RegExp(
                    `^\\s*${escapeRegExp(activeFence[0])}{${activeFence.length},}\\s*$`,
                ).test(line)
            ) {
                if (mermaidStartLine !== null) {
                    checkMermaidDeclaration(
                        projectPath,
                        mermaidStartLine,
                        mermaidLines,
                        errors,
                    );
                }
                activeFence = null;
                mermaidStartLine = null;
                mermaidLines = [];
                continue;
            }
            if (activeFence && mermaidStartLine !== null) {
                mermaidLines.push(line);
            }
        }

        if (activeFence) {
            errors.push(`${projectPath}: unclosed fenced code block`);
        }
    }
}

function checkMermaidDeclaration(projectPath, startLine, lines, errors) {
    const firstMeaningfulLine = lines.find((line) => line.trim().length > 0);
    if (
        !firstMeaningfulLine ||
        !MERMAID_DECLARATION_PATTERN.test(firstMeaningfulLine.trim())
    ) {
        errors.push(
            `${projectPath}:${startLine}: Mermaid block has no supported diagram declaration`,
        );
    }
}

async function checkOpenApiRouteParity(errors) {
    const registeredRoutes = await readRegisteredHttpRoutes(errors);
    const openApiSource = await readFile(
        path.join(projectRoot, OPENAPI_DOCUMENT_PATH),
        "utf8",
    );
    const openApiRoutes = readOpenApiRoutes(openApiSource, errors);

    for (const route of registeredRoutes) {
        if (!openApiRoutes.has(route)) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}: missing registered route ${route}`,
            );
        }
    }
    for (const route of openApiRoutes) {
        if (!registeredRoutes.has(route)) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}: undocumented source route ${route}`,
            );
        }
    }
}

async function readRegisteredHttpRoutes(errors) {
    const routeConstants = new Map();
    for (const ownerPath of HTTP_ROUTE_OWNER_PATHS) {
        const ownerSource = await readFile(
            path.join(projectRoot, ownerPath),
            "utf8",
        );
        collectRouteConstants(ownerSource, routeConstants);
    }

    const routeSource = await readFile(
        path.join(projectRoot, HTTP_ROUTE_REGISTRATION_PATH),
        "utf8",
    );
    const routes = new Set();
    const registrationPattern =
        /registerObserved(Get|Post|Put|Patch|Delete|Options)(?:<[\s\S]*?>)?\(\s*app,\s*options,\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*))/g;
    for (const match of routeSource.matchAll(registrationPattern)) {
        const method = match[1].toUpperCase();
        const routeToken = match[2] ?? match[3];
        const sourceRoute = match[2] ?? routeConstants.get(routeToken);
        if (!sourceRoute) {
            errors.push(
                `${HTTP_ROUTE_REGISTRATION_PATH}:${lineNumberAt(routeSource, match.index ?? 0)}: unresolved route constant ${routeToken}`,
            );
            continue;
        }
        // Fastify wildcard handlers have no equivalent OpenAPI path template.
        if (!sourceRoute.includes("*")) {
            routes.add(`${method} ${normalizeFastifyRoute(sourceRoute)}`);
        }
    }
    return routes;
}

function collectRouteConstants(source, routeConstants) {
    const scalarPattern = /export const ([A-Z][A-Z0-9_]*)\s*=\s*"([^"]+)"/g;
    for (const match of source.matchAll(scalarPattern)) {
        routeConstants.set(match[1], match[2]);
    }

    const objectPattern =
        /export const ([A-Z][A-Z0-9_]*)\s*=\s*\{([\s\S]*?)\}\s*as const/g;
    for (const objectMatch of source.matchAll(objectPattern)) {
        const entryPattern = /([A-Za-z][A-Za-z0-9_]*)\s*:\s*"([^"]+)"/g;
        for (const entryMatch of objectMatch[2].matchAll(entryPattern)) {
            routeConstants.set(
                `${objectMatch[1]}.${entryMatch[1]}`,
                entryMatch[2],
            );
        }
    }
}

function normalizeFastifyRoute(route) {
    return route.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
}

function readOpenApiRoutes(source, errors) {
    const routes = new Set();
    const routeCounts = new Map();
    let inPaths = false;
    let currentPath = null;

    for (const [index, line] of source.split(/\r?\n/).entries()) {
        if (line === "paths:") {
            inPaths = true;
            continue;
        }
        if (line === "components:") {
            break;
        }
        if (!inPaths) {
            continue;
        }
        const pathMatch = line.match(/^ {4}(\/[^:]*):\s*$/);
        if (pathMatch) {
            currentPath = pathMatch[1];
            continue;
        }
        const methodMatch = line.match(
            /^ {8}(get|post|put|patch|delete|options):\s*$/,
        );
        if (!methodMatch || !currentPath) {
            continue;
        }
        const route = `${methodMatch[1].toUpperCase()} ${currentPath}`;
        const count = (routeCounts.get(route) ?? 0) + 1;
        routeCounts.set(route, count);
        routes.add(route);
        if (count > 1) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${index + 1}: duplicate operation ${route}`,
            );
        }
    }
    return routes;
}

async function checkOpenApiReferences(errors) {
    const source = await readFile(
        path.join(projectRoot, OPENAPI_DOCUMENT_PATH),
        "utf8",
    );
    const definitions = new Set();
    let componentKind = null;
    for (const line of source.split(/\r?\n/)) {
        const kindMatch = line.match(
            /^ {4}(securitySchemes|parameters|responses|schemas):\s*$/,
        );
        if (kindMatch) {
            componentKind = kindMatch[1];
            continue;
        }
        const definitionMatch = line.match(/^ {8}([A-Za-z][A-Za-z0-9_]*):\s*$/);
        if (componentKind && definitionMatch) {
            const definition = `${componentKind}/${definitionMatch[1]}`;
            if (definitions.has(definition)) {
                errors.push(
                    `${OPENAPI_DOCUMENT_PATH}: duplicate component definition ${definition}`,
                );
            }
            definitions.add(definition);
        }
    }

    const referencePattern =
        /\$ref:\s*"#\/components\/(securitySchemes|parameters|responses|schemas)\/([A-Za-z][A-Za-z0-9_]*)"/g;
    for (const match of source.matchAll(referencePattern)) {
        const reference = `${match[1]}/${match[2]}`;
        if (!definitions.has(reference)) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${lineNumberAt(source, match.index ?? 0)}: missing component reference ${reference}`,
            );
        }
    }
}

async function checkOpenApiOperationIds(errors) {
    const source = await readFile(
        path.join(projectRoot, OPENAPI_DOCUMENT_PATH),
        "utf8",
    );
    const lines = source.split(/\r?\n/);
    const operationIds = new Map();
    let currentPath = null;

    for (let index = 0; index < lines.length; index += 1) {
        const pathMatch = lines[index].match(/^ {4}(\/[^:]*):\s*$/);
        if (pathMatch) {
            currentPath = pathMatch[1];
            continue;
        }

        const methodMatch = lines[index].match(
            /^ {8}(get|post|put|patch|delete|options):\s*$/,
        );
        if (!methodMatch || !currentPath) {
            continue;
        }

        const operation = `${methodMatch[1].toUpperCase()} ${currentPath}`;
        const operationIdMatches = [];
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            if (/^ {0,8}\S/.test(lines[cursor])) break;
            const operationIdMatch = lines[cursor].match(
                /^ {12}operationId:\s*([A-Za-z][A-Za-z0-9_]*)\s*$/,
            );
            if (operationIdMatch) {
                operationIdMatches.push({
                    id: operationIdMatch[1],
                    lineNumber: cursor + 1,
                });
            }
        }

        if (operationIdMatches.length !== 1) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${index + 1}: ${operation} must declare exactly one operationId`,
            );
            continue;
        }

        const [{ id, lineNumber }] = operationIdMatches;
        const previousOperation = operationIds.get(id);
        if (previousOperation) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${lineNumber}: duplicate operationId ${id} (${previousOperation} and ${operation})`,
            );
            continue;
        }
        operationIds.set(id, operation);
    }
}

async function checkOpenApiMutationSecurity(errors) {
    const source = await readFile(
        path.join(projectRoot, OPENAPI_DOCUMENT_PATH),
        "utf8",
    );
    const lines = source.split(/\r?\n/);
    let currentPath = null;

    for (let index = 0; index < lines.length; index += 1) {
        const pathMatch = lines[index].match(/^ {4}(\/[^:]*):\s*$/);
        if (pathMatch) {
            currentPath = pathMatch[1];
            continue;
        }

        const methodMatch = lines[index].match(
            /^ {8}(get|post|put|patch|delete|options):\s*$/,
        );
        if (
            !methodMatch ||
            !currentPath?.startsWith("/api/") ||
            !MUTATING_HTTP_METHODS.has(methodMatch[1])
        ) {
            continue;
        }

        const operationLines = [];
        for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
            if (/^ {0,8}\S/.test(lines[cursor])) break;
            operationLines.push(lines[cursor]);
        }
        const operationSource = operationLines.join("\n");
        const operation = `${methodMatch[1].toUpperCase()} ${currentPath}`;

        if (!/^ {12}security:\s*$/m.test(operationSource)) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${index + 1}: ${operation} must declare CSRF security`,
            );
        }
        if (
            !/^ {16}- csrfHeader: \[\]\s*$/m.test(operationSource) ||
            !/^ {18}csrfCookie: \[\]\s*$/m.test(operationSource)
        ) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${index + 1}: ${operation} must require CSRF header and cookie`,
            );
        }
        if (!/^ {16}"403":\s*$/m.test(operationSource)) {
            errors.push(
                `${OPENAPI_DOCUMENT_PATH}:${index + 1}: ${operation} must document its forbidden response`,
            );
        }
    }
}

function stripFencedCode(source) {
    const lines = source.split(/\r?\n/);
    let activeFence = null;
    return lines
        .map((line) => {
            const opening = line.match(/^\s*(`{3,}|~{3,})/);
            if (!activeFence && opening) {
                activeFence = opening[1];
                return "";
            }
            if (
                activeFence &&
                new RegExp(
                    `^\\s*${escapeRegExp(activeFence[0])}{${activeFence.length},}\\s*$`,
                ).test(line)
            ) {
                activeFence = null;
                return "";
            }
            return activeFence ? "" : line;
        })
        .join("\n");
}

function findLineNumbers(source, needle) {
    const lineNumbers = [];
    let offset = 0;
    while (offset < source.length) {
        const index = source.indexOf(needle, offset);
        if (index < 0) {
            break;
        }
        lineNumbers.push(lineNumberAt(source, index));
        offset = index + needle.length;
    }
    return lineNumbers;
}

function lineNumberAt(source, index) {
    return source.slice(0, index).split("\n").length;
}

function decodePath(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function decodeFragment(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function toProjectPath(filePath) {
    return path.relative(projectRoot, filePath).split(path.sep).join("/");
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await main();
