import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const frontendRequire = createRequire(
    new URL("../../frontend/package.json", import.meta.url),
);
const pluginRequire = createRequire(
    frontendRequire.resolve("@sveltejs/vite-plugin-svelte"),
);
const merge = pluginRequire("deepmerge");

// The upstream release has no fix for CVE-2026-93753. Exercise the actual
// patched build dependency so a missing/stale Yarn patch fails security CI.
test("deepmerge never gives merged configuration an attacker-controlled prototype", () => {
    const attack = JSON.parse('{"session":{"__proto__":{"admin":true}}}');
    for (const target of [
        {},
        { session: null },
        { session: undefined },
        Object.create(null),
    ]) {
        const result = merge(target, attack);
        assert.equal(result.session.admin, undefined);
        assert.equal(Object.getPrototypeOf(result.session), Object.prototype);
        assert.equal(Object.hasOwn(result.session, "__proto__"), false);
    }
    const hostileTarget = JSON.parse(
        '{"__proto__":{"admin":true},"enabled":true}',
    );
    const result = merge(hostileTarget, { name: "safe" });
    assert.equal(result.admin, undefined);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.deepEqual(result, { enabled: true, name: "safe" });
    assert.equal({}.admin, undefined);
});

test("the security patch preserves nested config, array and symbol merging", () => {
    const symbol = Symbol("config");
    assert.deepEqual(
        merge(
            { nested: { a: 1 }, list: [1], [symbol]: { a: 1 } },
            { nested: { b: 2 }, list: [2], [symbol]: { b: 2 } },
        ),
        { nested: { a: 1, b: 2 }, list: [1, 2], [symbol]: { a: 1, b: 2 } },
    );
});
