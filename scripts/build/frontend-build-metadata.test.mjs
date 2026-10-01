import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readFrontendBuildCommit } from "./frontend-build-metadata.mjs";

const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
);
const fixtureRoot = path.join(rootDir, "tmp");
mkdirSync(fixtureRoot, { recursive: true });

function git(cwd, ...args) {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

function repository() {
    // Retain fixtures under the active worktree for review.
    const fixture = mkdtempSync(
        path.join(fixtureRoot, "frontend-build-metadata-"),
    );
    const repo = path.join(fixture, "repo");
    mkdirSync(repo);
    git(repo, "init", "--quiet");
    git(repo, "config", "user.name", "Build metadata fixture");
    git(repo, "config", "user.email", "build-fixture@example.invalid");
    return { fixture, repo };
}

function commitFile(repo, value) {
    writeFileSync(path.join(repo, "fixture.txt"), value);
    git(repo, "add", "fixture.txt");
    git(
        repo,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--no-gpg-sign",
        "--quiet",
        "-m",
        value,
    );
    return git(repo, "rev-parse", "HEAD");
}

test("Admin requires commit metadata while an archive web build can omit it", () => {
    const { repo } = repository();
    assert.throws(
        () => readFrontendBuildCommit(repo, { required: true }),
        /requires a Git checkout/,
    );
    assert.equal(readFrontendBuildCommit(repo, { required: false }), "");
});

test("reads the linked checkout revision rather than its parent repository revision", () => {
    const { fixture, repo } = repository();
    const parentCommit = commitFile(repo, "parent");
    const linked = path.join(fixture, "linked");
    git(repo, "worktree", "add", "--quiet", "--detach", linked, parentCommit);
    const linkedCommit = commitFile(linked, "linked");
    assert.notEqual(linkedCommit, parentCommit);
    assert.equal(
        readFrontendBuildCommit(repo, { required: true }),
        parentCommit,
    );
    assert.equal(
        readFrontendBuildCommit(linked, { required: true }),
        linkedCommit,
    );
    assert.equal(
        git(linked, "cat-file", "commit", linkedCommit).includes("gpgsig"),
        false,
    );
});
