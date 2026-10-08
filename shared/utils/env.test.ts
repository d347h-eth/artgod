import { describe, expect, it } from "vitest";
import { isPositiveInteger, parsePositiveInteger } from "./env.js";

const name = "TEST_POSITIVE_INTEGER";

describe("positive integer configuration", () => {
    it.each(["1", "10485760", String(Number.MAX_SAFE_INTEGER), " 25 "])(
        "retains the exact decimal value %s",
        (value) => {
            expect(isPositiveInteger(value)).toBe(true);
            expect(parsePositiveInteger(value, name)).toBe(Number(value));
        },
    );

    it.each([
        "9007199254740992",
        "9007199254740993",
        "1e7",
        "0x100000",
        "01",
        "+1",
        "1.0",
        "1.5",
        "0",
        "-1",
        "Infinity",
        "NaN",
    ])("rejects an inexact or noncanonical integer %s", (value) => {
        expect(isPositiveInteger(value)).toBe(false);
        expect(() => parsePositiveInteger(value, name)).toThrow(
            `Invalid ${name}`,
        );
    });

    it.each([undefined, "", " "])(
        "uses the validated default for an absent value %s",
        (value) => {
            expect(parsePositiveInteger(value, name, 10)).toBe(10);
            expect(() => parsePositiveInteger(value, name)).toThrow(
                `Missing ${name}`,
            );
        },
    );

    it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
        "rejects an invalid numeric default %s",
        (value) => {
            expect(isPositiveInteger(value)).toBe(false);
            expect(() => parsePositiveInteger(undefined, name, value)).toThrow(
                `Invalid ${name}`,
            );
        },
    );
});
