#!/usr/bin/env tsx

import { encodeFunctionData, decodeFunctionResult } from "viem";

// Contract addresses and configuration
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
const TARGET_CONTRACT_ADDRESS = "0x4E1f41613c9084FdB9E34E11fAE9412427480e56"; // Terraforms
const RPC_URL = "http://localhost:42721";

// ==== CONFIGURATION PARAMETERS ====
// Easy to modify for different test scenarios

// Token range
const MIN_TOKEN_ID = 1;
const MAX_TOKEN_ID = 100; // Token range to process

// Strategy selection
const USE_MULTICALL = false; // Toggle: true = use Multicall3, false = direct calls

// Batching configuration
const POST_BATCH_SIZE = 100; // Number of JSON-RPC requests per POST batch

// Multicall-specific configuration (only used when USE_MULTICALL = true)
const TOKENS_PER_MULTICALL = 5; // Number of tokenURI calls aggregated in each multicall

// Test mode: if true, only processes one batch group then stops
const TEST_MODE = true;

// Gas estimation (adjust based on target contract)
const ESTIMATED_GAS_PER_TOKEN = 25_000_000; // Gas per tokenURI call (25M for Terraforms, ~2M for lighter contracts)

// ABI fragments for encoding/decoding
const tokenURIABI = {
    name: "tokenURI",
    type: "function",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
} as const;

const multicall3ABI = {
    name: "aggregate3",
    type: "function",
    inputs: [
        {
            name: "calls",
            type: "tuple[]",
            components: [
                { name: "target", type: "address" },
                { name: "allowFailure", type: "bool" },
                { name: "callData", type: "bytes" },
            ],
        },
    ],
    outputs: [
        {
            name: "returnData",
            type: "tuple[]",
            components: [
                { name: "success", type: "bool" },
                { name: "returnData", type: "bytes" },
            ],
        },
    ],
} as const;

// Storage interface abstraction
interface TokenData {
    tokenId: number;
    tokenURI: string;
    success: boolean;
    error?: string;
}

interface StorageWriter {
    writeBatch(data: TokenData[]): Promise<void>;
}

// Console logger implementation (can be replaced with database writer)
class ConsoleStorageWriter implements StorageWriter {
    async writeBatch(data: TokenData[]): Promise<void> {
        console.log(`📝 Writing batch of ${data.length} tokens:`);

        const successfulTokens = data.filter((t) => t.success);
        const errorTokens = data.filter((t) => !t.success);

        if (successfulTokens.length > 0) {
            console.log(
                `✅ ${successfulTokens.length} successful tokens: ${successfulTokens.map((t) => t.tokenId).join(", ")}`,
            );
            // Show sample of tokenURI data size
            if (successfulTokens.length > 0) {
                const sampleSize = successfulTokens[0].tokenURI.length;
                console.log(
                    `📊 Sample tokenURI size: ${sampleSize.toLocaleString()} characters`,
                );
            }
        }

        if (errorTokens.length > 0) {
            console.log(`❌ ${errorTokens.length} failed tokens:`);
            errorTokens.forEach((token) => {
                console.log(`   Token ${token.tokenId}: ${token.error}`);
            });
        }
        console.log("---");
    }
}

// Core fetching logic
class TerraformDataFetcher {
    private storage: StorageWriter;
    private requestId: number = 1;

    constructor(storage: StorageWriter) {
        this.storage = storage;
    }

    // Create calldata for tokenURI(tokenId) call
    private createTokenURICalldata(tokenId: number): string {
        return encodeFunctionData({
            abi: [tokenURIABI],
            functionName: "tokenURI",
            args: [BigInt(tokenId)],
        });
    }

    // Create direct tokenURI request (no multicall)
    private createDirectRequest(tokenId: number): {
        jsonrpc: string;
        method: string;
        params: any[];
        id: number;
    } {
        return {
            jsonrpc: "2.0",
            method: "eth_call",
            params: [
                {
                    to: TARGET_CONTRACT_ADDRESS,
                    data: this.createTokenURICalldata(tokenId),
                },
                "latest",
            ],
            id: this.requestId++,
        };
    }

    // Create multicall3 request for multiple tokenURI calls
    private createMulticallRequest(tokenIds: number[]): {
        jsonrpc: string;
        method: string;
        params: any[];
        id: number;
    } {
        const calls = tokenIds.map((tokenId) => ({
            target: TARGET_CONTRACT_ADDRESS,
            allowFailure: true,
            callData: this.createTokenURICalldata(tokenId),
        }));

        const calldata = encodeFunctionData({
            abi: [multicall3ABI],
            functionName: "aggregate3",
            args: [calls],
        });

        return {
            jsonrpc: "2.0",
            method: "eth_call",
            params: [
                {
                    to: MULTICALL3_ADDRESS,
                    data: calldata,
                },
                "latest",
            ],
            id: this.requestId++,
        };
    }

    // Process direct tokenURI response
    private processDirectResponse(response: any, tokenId: number): TokenData {
        try {
            if (response.error) {
                return {
                    tokenId,
                    tokenURI: "",
                    success: false,
                    error: `RPC Error: ${response.error.message}`,
                };
            }

            const tokenURI = decodeFunctionResult({
                abi: [tokenURIABI],
                functionName: "tokenURI",
                data: response.result,
            });

            return {
                tokenId,
                tokenURI: tokenURI as string,
                success: true,
            };
        } catch (error) {
            return {
                tokenId,
                tokenURI: "",
                success: false,
                error: `Processing error: ${error instanceof Error ? error.message : "Unknown"}`,
            };
        }
    }

    // Process multicall response and decode tokenURI results
    private processMulticallResponse(
        response: any,
        tokenIds: number[],
    ): TokenData[] {
        try {
            if (response.error) {
                return tokenIds.map((tokenId) => ({
                    tokenId,
                    tokenURI: "",
                    success: false,
                    error: `RPC Error: ${response.error.message}`,
                }));
            }

            const decoded = decodeFunctionResult({
                abi: [multicall3ABI],
                functionName: "aggregate3",
                data: response.result,
            });

            // Successfully decoded multicall response

            return tokenIds.map((tokenId, index) => {
                const result = decoded[index]; // Fixed: decoded is the array directly, not decoded[0]

                if (!result.success) {
                    return {
                        tokenId,
                        tokenURI: "",
                        success: false,
                        error: "Contract call failed",
                    };
                }

                try {
                    const tokenURI = decodeFunctionResult({
                        abi: [tokenURIABI],
                        functionName: "tokenURI",
                        data: result.returnData,
                    });

                    return {
                        tokenId,
                        tokenURI: tokenURI as string,
                        success: true,
                    };
                } catch (decodeError) {
                    return {
                        tokenId,
                        tokenURI: "",
                        success: false,
                        error: `Decode error: ${decodeError instanceof Error ? decodeError.message : "Unknown"}`,
                    };
                }
            });
        } catch (error) {
            return tokenIds.map((tokenId) => ({
                tokenId,
                tokenURI: "",
                success: false,
                error: `Processing error: ${error instanceof Error ? error.message : "Unknown"}`,
            }));
        }
    }

    // Send JSON-RPC batch request
    private async sendBatchRequest(requests: any[]): Promise<any[]> {
        const response = await fetch(RPC_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requests),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        return response.json();
    }

    // Create batches of token IDs
    private createTokenBatches(): number[][] {
        const batches: number[][] = [];

        for (
            let tokenId = MIN_TOKEN_ID;
            tokenId <= MAX_TOKEN_ID;
            tokenId += TOKENS_PER_MULTICALL
        ) {
            const batch: number[] = [];
            for (
                let i = 0;
                i < TOKENS_PER_MULTICALL && tokenId + i <= MAX_TOKEN_ID;
                i++
            ) {
                batch.push(tokenId + i);
            }
            batches.push(batch);
        }

        return batches;
    }

    // Direct call fetching logic (for comparison testing)
    async fetchAllTokenDataDirect(): Promise<void> {
        const tokenList = [];
        for (let tokenId = MIN_TOKEN_ID; tokenId <= MAX_TOKEN_ID; tokenId++) {
            tokenList.push(tokenId);
        }
        console.log(`Created ${tokenList.length} individual token requests`);

        // Process tokens in batches for JSON-RPC batching
        for (let i = 0; i < tokenList.length; i += POST_BATCH_SIZE) {
            const tokenBatch = tokenList.slice(i, i + POST_BATCH_SIZE);
            const batchNumber = Math.floor(i / POST_BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(tokenList.length / POST_BATCH_SIZE);

            console.log(
                `\n=== Processing direct call batch ${batchNumber}/${totalBatches} ===`,
            );
            console.log(`Direct calls in this batch: ${tokenBatch.length}`);
            console.log(`Total tokens in this batch: ${tokenBatch.length}`);
            console.log(
                `Estimated gas requirement: ${(tokenBatch.length * ESTIMATED_GAS_PER_TOKEN).toLocaleString()} gas`,
            );
            console.log(
                `Token range: [${tokenBatch[0]}-${tokenBatch[tokenBatch.length - 1]}]`,
            );

            // Create direct JSON-RPC batch request
            const rpcRequests = tokenBatch.map((tokenId) =>
                this.createDirectRequest(tokenId),
            );

            try {
                const startTime = Date.now();
                console.log(
                    `Sending ${rpcRequests.length} direct tokenURI calls in single JSON-RPC batch...`,
                );

                // Send batch request to RPC
                const responses = await this.sendBatchRequest(rpcRequests);
                const networkTime = Date.now() - startTime;

                console.log(`Network + Node processing: ${networkTime}ms`);

                const decodeStartTime = Date.now();

                // Process all responses and collect token data
                const allTokenData: TokenData[] = [];
                let successCount = 0;
                let errorCount = 0;

                for (let j = 0; j < responses.length; j++) {
                    const response = responses[j];
                    const tokenId = tokenBatch[j];
                    const tokenData = this.processDirectResponse(
                        response,
                        tokenId,
                    );
                    allTokenData.push(tokenData);

                    if (tokenData.success) successCount++;
                    else errorCount++;
                }

                const decodeTime = Date.now() - decodeStartTime;
                const totalTime = networkTime + decodeTime;

                console.log(`Decoding time: ${decodeTime}ms`);
                console.log(`Total processing time: ${totalTime}ms`);
                console.log(
                    `Results: ${successCount} successful, ${errorCount} errors`,
                );
                console.log(
                    `Success rate: ${((successCount / tokenBatch.length) * 100).toFixed(1)}%`,
                );
                console.log(
                    `Effective throughput: ${(successCount / (totalTime / 1000)).toFixed(2)} successful tokens/second`,
                );
                console.log(
                    `Total throughput: ${(tokenBatch.length / (totalTime / 1000)).toFixed(2)} tokens/second (including failures)`,
                );
                console.log(
                    `Time breakdown: Network+Node: ${networkTime}ms (${((networkTime / totalTime) * 100).toFixed(1)}%), Decoding: ${decodeTime}ms (${((decodeTime / totalTime) * 100).toFixed(1)}%)`,
                );

                // Write to storage
                await this.storage.writeBatch(allTokenData);
            } catch (error) {
                console.error(`Error processing direct call batch:`, error);

                // Create error entries for all tokens in this batch
                const errorTokenData: TokenData[] = tokenBatch.map(
                    (tokenId) => ({
                        tokenId,
                        tokenURI: "",
                        success: false,
                        error: `Batch error: ${error instanceof Error ? error.message : "Unknown"}`,
                    }),
                );

                await this.storage.writeBatch(errorTokenData);
            }

            if (TEST_MODE) {
                console.log("\n=== TEST MODE: Stopping after first batch ===");
                break;
            }
        }
    }

    // Main fetching logic with double batching
    async fetchAllTokenData(): Promise<void> {
        const tokenBatches = this.createTokenBatches();
        console.log(
            `Created ${tokenBatches.length} token batches of ${TOKENS_PER_MULTICALL} tokens each`,
        );

        const totalBatchGroups = Math.ceil(
            tokenBatches.length / POST_BATCH_SIZE,
        );
        const batchesToProcess = TEST_MODE ? 1 : totalBatchGroups;

        console.log(
            `${TEST_MODE ? "TEST MODE: " : ""}Will process ${batchesToProcess} batch group(s) of ${totalBatchGroups} total`,
        );

        // Process batches in groups (double batching)
        for (
            let i = 0;
            i < tokenBatches.length && i / POST_BATCH_SIZE < batchesToProcess;
            i += POST_BATCH_SIZE
        ) {
            const batchGroup = tokenBatches.slice(i, i + POST_BATCH_SIZE);
            const batchNumber = Math.floor(i / POST_BATCH_SIZE) + 1;
            const totalTokensInBatch = batchGroup.reduce(
                (sum, batch) => sum + batch.length,
                0,
            );

            console.log(
                `\n=== Processing batch group ${batchNumber}/${totalBatchGroups} ===`,
            );
            console.log(`Multicalls in this batch: ${batchGroup.length}`);
            console.log(`Total tokens in this batch: ${totalTokensInBatch}`);
            console.log(
                `Estimated gas requirement: ${(totalTokensInBatch * ESTIMATED_GAS_PER_TOKEN).toLocaleString()} gas`,
            );
            console.log(
                `Token ranges: ${batchGroup.map((batch) => `[${batch[0]}-${batch[batch.length - 1]}]`).join(", ")}`,
            );

            // Create JSON-RPC batch request
            const rpcRequests = batchGroup.map((tokenIds) =>
                this.createMulticallRequest(tokenIds),
            );

            try {
                const startTime = Date.now();
                console.log(
                    `Sending ${rpcRequests.length} multicall requests in single JSON-RPC batch...`,
                );

                // Send batch request to RPC
                const responses = await this.sendBatchRequest(rpcRequests);
                const networkTime = Date.now() - startTime;

                console.log(`Network + Node processing: ${networkTime}ms`);

                const decodeStartTime = Date.now();

                // Process all responses and collect token data
                const allTokenData: TokenData[] = [];
                let successCount = 0;
                let errorCount = 0;

                for (let j = 0; j < responses.length; j++) {
                    const response = responses[j];
                    const tokenIds = batchGroup[j];
                    const tokenData = this.processMulticallResponse(
                        response,
                        tokenIds,
                    );
                    allTokenData.push(...tokenData);

                    // Count successes and errors
                    tokenData.forEach((token) => {
                        if (token.success) successCount++;
                        else errorCount++;
                    });
                }

                const decodeTime = Date.now() - decodeStartTime;
                const totalTime = networkTime + decodeTime;

                console.log(`Decoding time: ${decodeTime}ms`);
                console.log(`Total processing time: ${totalTime}ms`);
                console.log(
                    `Results: ${successCount} successful, ${errorCount} errors`,
                );
                console.log(
                    `Success rate: ${((successCount / totalTokensInBatch) * 100).toFixed(1)}%`,
                );
                console.log(
                    `Effective throughput: ${(successCount / (totalTime / 1000)).toFixed(2)} successful tokens/second`,
                );
                console.log(
                    `Total throughput: ${(totalTokensInBatch / (totalTime / 1000)).toFixed(2)} tokens/second (including failures)`,
                );
                console.log(
                    `Time breakdown: Network+Node: ${networkTime}ms (${((networkTime / totalTime) * 100).toFixed(1)}%), Decoding: ${decodeTime}ms (${((decodeTime / totalTime) * 100).toFixed(1)}%)`,
                );

                // Write to storage
                await this.storage.writeBatch(allTokenData);
            } catch (error) {
                console.error(`Error processing batch group:`, error);

                // Create error entries for all tokens in this batch group
                const errorTokenData: TokenData[] = batchGroup
                    .flat()
                    .map((tokenId) => ({
                        tokenId,
                        tokenURI: "",
                        success: false,
                        error: `Batch error: ${error instanceof Error ? error.message : "Unknown"}`,
                    }));

                await this.storage.writeBatch(errorTokenData);
            }

            if (TEST_MODE) {
                console.log("\n=== TEST MODE: Stopping after first batch ===");
                break;
            }
        }
    }
}

// Main execution
async function main() {
    console.log("🚀 Starting NFT token data fetching...");
    console.log("\n==== CONFIGURATION ====");
    console.log(`Contract: ${TARGET_CONTRACT_ADDRESS}`);
    console.log(`Token range: ${MIN_TOKEN_ID} - ${MAX_TOKEN_ID}`);
    console.log(
        `Strategy: ${USE_MULTICALL ? "Multicall3 Aggregation" : "Direct Calls"}`,
    );
    console.log(`POST batch size: ${POST_BATCH_SIZE} requests per batch`);

    if (USE_MULTICALL) {
        console.log(`Tokens per multicall: ${TOKENS_PER_MULTICALL}`);
        console.log(
            `Total tokens per batch: ${TOKENS_PER_MULTICALL * POST_BATCH_SIZE}`,
        );
        console.log(
            `Estimated gas per multicall: ${(TOKENS_PER_MULTICALL * ESTIMATED_GAS_PER_TOKEN).toLocaleString()}`,
        );
    } else {
        console.log(`Total tokens per batch: ${POST_BATCH_SIZE}`);
        console.log(
            `Estimated gas per call: ${ESTIMATED_GAS_PER_TOKEN.toLocaleString()}`,
        );
    }

    console.log(
        `Test mode: ${TEST_MODE ? "ON (single batch only)" : "OFF (full range)"}`,
    );
    console.log("========================\n");

    const storage = new ConsoleStorageWriter();
    const fetcher = new TerraformDataFetcher(storage);

    const startTime = Date.now();
    if (USE_MULTICALL) {
        await fetcher.fetchAllTokenData();
    } else {
        await fetcher.fetchAllTokenDataDirect();
    }
    const endTime = Date.now();

    console.log(`\n✅ Completed in ${(endTime - startTime) / 1000}s`);
}

// Export for potential module usage
export { TerraformDataFetcher, StorageWriter, TokenData };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
