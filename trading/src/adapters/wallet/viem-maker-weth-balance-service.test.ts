import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import { ViemMakerWethBalanceService } from "./viem-maker-weth-balance-service.js";

describe("ViemMakerWethBalanceService", () => {
    it("reads balanceOf from the configured WETH contract", async () => {
        const calls: Array<{
            address: string;
            functionName: string;
            args: string[];
        }> = [];
        const service = new ViemMakerWethBalanceService(
            {
                async readContract(args) {
                    calls.push({
                        address: args.address,
                        functionName: args.functionName,
                        args: [...args.args],
                    });
                    return 42n;
                },
            },
            "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        );

        const balance = await service.getWethBalance(
            "0x00000000000000000000000000000000000000aA",
        );

        assert.equal(balance, 42n);
        assert.deepEqual(calls, [
            {
                address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                functionName: "balanceOf",
                args: ["0x00000000000000000000000000000000000000AA"],
            },
        ]);
    });
});
