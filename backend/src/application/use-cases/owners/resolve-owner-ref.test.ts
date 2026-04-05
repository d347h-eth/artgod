import { describe, expect, it, vi } from "vitest";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import { ResolveOwnerRefUseCase } from "./resolve-owner-ref.js";

describe("ResolveOwnerRefUseCase", () => {
    it("returns raw owner addresses without ENS lookup", async () => {
        const ensPort = {
            resolveEnsAddress: vi.fn(),
        };
        const useCase = new ResolveOwnerRefUseCase(
            1,
            createChainResolverPort(1),
            ensPort,
        );

        await expect(
            useCase.resolveOwnerRef({
                chainRef: "ethereum",
                value: "0xAbCDEFabcdefABCDEFabcdefabcdefABCDEFabcd",
            }),
        ).resolves.toEqual({
            input: "0xAbCDEFabcdefABCDEFabcdefabcdefABCDEFabcd",
            resolvedAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        });
        expect(ensPort.resolveEnsAddress).not.toHaveBeenCalled();
    });

    it("resolves .eth names through the ENS port", async () => {
        const ensPort = {
            resolveEnsAddress: vi
                .fn()
                .mockResolvedValue(
                    "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
                ),
        };
        const useCase = new ResolveOwnerRefUseCase(
            1,
            createChainResolverPort(1),
            ensPort,
        );

        await expect(
            useCase.resolveOwnerRef({
                chainRef: "ethereum",
                value: "Vitalik.eth",
            }),
        ).resolves.toEqual({
            input: "Vitalik.eth",
            resolvedAddress: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        });
        expect(ensPort.resolveEnsAddress).toHaveBeenCalledWith("vitalik.eth");
    });

    it("rejects ENS lookups off Ethereum mainnet", async () => {
        const useCase = new ResolveOwnerRefUseCase(
            1,
            createChainResolverPort(8453),
            {
                resolveEnsAddress: vi.fn(),
            },
        );

        await expect(
            useCase.resolveOwnerRef({
                chainRef: "base",
                value: "vitalik.eth",
            }),
        ).rejects.toBeInstanceOf(ReadModelBadRequestError);
    });

    it("returns not found when ENS name has no address", async () => {
        const useCase = new ResolveOwnerRefUseCase(
            1,
            createChainResolverPort(1),
            {
                resolveEnsAddress: vi.fn().mockResolvedValue(null),
            },
        );

        await expect(
            useCase.resolveOwnerRef({
                chainRef: "ethereum",
                value: "missing.eth",
            }),
        ).rejects.toBeInstanceOf(ReadModelNotFoundError);
    });
});

function createChainResolverPort(publicChainId: number) {
    return {
        resolveChainRef() {
            return {
                id: publicChainId,
                type: "evm",
                publicChainId,
                slug: publicChainId === 1 ? "ethereum" : "base",
                name: publicChainId === 1 ? "Ethereum" : "Base",
            };
        },
    };
}
