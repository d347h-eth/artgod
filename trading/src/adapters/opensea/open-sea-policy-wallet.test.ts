import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type { Hex } from "viem";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";
import { BiddingMandate } from "../../domain/bidding-mandate.js";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
} from "../../domain/market/strategy/job.js";
import {
    OpenSeaPolicyViolationError,
    OpenSeaPolicyWallet,
    type OpenSeaOfferSigningAuthorization,
    type OpenSeaPolicyTypedDataSigner,
} from "./open-sea-policy-wallet.js";

const MAKER = "0x00000000000000000000000000000000000000aA";
const COLLECTION = "0x00000000000000000000000000000000000000bB";
const OTHER_COLLECTION = "0x00000000000000000000000000000000000000cC";
const FEE_RECIPIENT = "0x00000000000000000000000000000000000000dD";
const SIGNATURE = `0x${"11".repeat(65)}` as Hex;
const ORDER_HASH = `0x${"22".repeat(32)}` as Hex;
const EXPIRATION_TIME = 2_000_000_000;
const COLLECTION_ID = 1;
const COLLECTION_SLUG = "policy-test-collection";

describe("OpenSeaPolicyWallet", () => {
    it("signs one fully validated token offer without exposing transaction authority", async () => {
        const signedInputs: unknown[] = [];
        const policyWallet = createPolicyWallet({
            signedInputs,
            allowanceCapWei: 100n,
        });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);

        const signature = await policyWallet.authorizeOffer(
            authorization,
            async () => await requestSignature(policyWallet, typedData),
        );

        assert.equal(signature, SIGNATURE);
        assert.equal(signedInputs.length, 1);
        const signedInput = signedInputs[0] as {
            message: { offer: Array<{ startAmount: string }> };
        };
        assert.notEqual(signedInput.message, typedData.message);
        assert.equal(Object.isFrozen(signedInput.message), true);
        typedData.message.offer[0].startAmount = "999";
        assert.equal(signedInput.message.offer[0].startAmount, "100");
        const sdkAccount = policyWallet.walletClient
            .account as unknown as Record<string, unknown>;
        assert.equal(sdkAccount.signTypedData, undefined);
        assert.equal(sdkAccount.signMessage, undefined);
        assert.equal(sdkAccount.signTransaction, undefined);
        assert.equal(sdkAccount.sendTransaction, undefined);
        assert.equal(sdkAccount.writeContract, undefined);
        await assert.rejects(
            async () =>
                await requestWalletAction(
                    policyWallet.walletClient.sendTransaction,
                ),
            OpenSeaPolicyViolationError,
        );
        await assert.rejects(
            async () =>
                await requestWalletAction(
                    policyWallet.walletClient.writeContract,
                ),
            /writeContract is not permitted/,
        );
        await assert.rejects(
            async () =>
                await requestWalletAction(
                    policyWallet.walletClient.signMessage,
                ),
            /signMessage is not permitted/,
        );
        await assert.rejects(
            async () =>
                await requestWalletAction(
                    policyWallet.walletClient.signTransaction,
                ),
            /signTransaction is not permitted/,
        );
        await assert.rejects(
            async () => await requestSignature(policyWallet, typedData),
            /typed-data signature was requested without authorization/,
        );
    });

    it("accepts Seaport's padded hexadecimal uint salt", async () => {
        const signedInputs: unknown[] = [];
        const policyWallet = createPolicyWallet({
            signedInputs,
            allowanceCapWei: 100n,
        });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);
        // Match the final salt representation produced by the pinned Seaport SDK.
        typedData.message.salt = OPENSEA_MAINNET_SECURITY_POLICY.zeroBytes32;

        await policyWallet.authorizeOffer(
            authorization,
            async () => await requestSignature(policyWallet, typedData),
        );

        assert.equal(signedInputs.length, 1);
    });

    it("rejects malformed and out-of-range hexadecimal uint salts", async () => {
        const invalidSalts = ["0x", "0xnot-a-uint", `0x1${"00".repeat(32)}`];

        for (const salt of invalidSalts) {
            const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
            const authorization = tokenAuthorization(100n);
            const typedData = tokenOfferTypedData(authorization);
            typedData.message.salt = salt;

            await assert.rejects(
                () =>
                    policyWallet.authorizeOffer(
                        authorization,
                        async () =>
                            await requestSignature(policyWallet, typedData),
                    ),
                /order salt must be an unsigned integer/,
                salt,
            );
        }
    });

    it("rejects an offer amount above the configured allowance cap before SDK work starts", async () => {
        let workCalls = 0;
        const policyWallet = createPolicyWallet({ allowanceCapWei: 99n });

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(
                    tokenAuthorization(100n),
                    async () => {
                        workCalls += 1;
                        return null;
                    },
                ),
            /exceeds configured WETH allowance cap/,
        );
        assert.equal(workCalls, 0);
    });

    it("rejects an unmandated collection before OpenSea work starts", async () => {
        let workCalls = 0;
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
        const authorization = tokenAuthorization(100n);
        authorization.job = {
            ...authorization.job,
            collectionId: COLLECTION_ID + 1,
        };

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    workCalls += 1;
                    return null;
                }),
            /native bidding mandate rejected offer: collection 2 is not authorized/,
        );
        assert.equal(workCalls, 0);
    });

    it("requires explicit SignedZone trust before trait offer SDK work starts", async () => {
        let workCalls = 0;
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(
                    traitAuthorization(100n),
                    async () => {
                        workCalls += 1;
                        return null;
                    },
                ),
            /requires explicit OpenSea SignedZone trust/,
        );
        assert.equal(workCalls, 0);
    });

    it("allows a pinned SignedZone trait offer after explicit trust is enabled", async () => {
        const signedInputs: unknown[] = [];
        const policyWallet = createPolicyWallet({
            signedInputs,
            allowanceCapWei: 100n,
            trustOpenSeaSignedZoneTraitOffers: true,
        });
        const authorization = traitAuthorization(100n);

        await policyWallet.authorizeOffer(authorization, async () => {
            await requestSignature(
                policyWallet,
                collectionOfferTypedData(authorization),
            );
        });

        assert.equal(signedInputs.length, 1);
    });

    it("rejects SDK drift in signed spend, zone, and target collection", async () => {
        const mutations: Array<{
            label: string;
            mutate(input: ReturnType<typeof tokenOfferTypedData>): void;
        }> = [
            {
                label: "spend",
                mutate: (input) => {
                    input.message.offer[0].startAmount = "101";
                },
            },
            {
                label: "zone",
                mutate: (input) => {
                    (input.message as { zone: string }).zone =
                        OPENSEA_MAINNET_SECURITY_POLICY.zeroAddress;
                },
            },
            {
                label: "collection",
                mutate: (input) => {
                    input.message.consideration[0].token = OTHER_COLLECTION;
                },
            },
            {
                label: "domain fields",
                mutate: (input) => {
                    Object.assign(input.domain, {
                        salt: OPENSEA_MAINNET_SECURITY_POLICY.zeroBytes32,
                    });
                },
            },
        ];

        for (const mutation of mutations) {
            const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
            const authorization = tokenAuthorization(100n);
            const typedData = tokenOfferTypedData(authorization);
            mutation.mutate(typedData);

            await assert.rejects(
                () =>
                    policyWallet.authorizeOffer(
                        authorization,
                        async () =>
                            await requestSignature(policyWallet, typedData),
                    ),
                OpenSeaPolicyViolationError,
                mutation.label,
            );
        }
    });

    it("allows only one typed-data signature per authorized SDK operation", async () => {
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    await requestSignature(policyWallet, typedData);
                    await requestSignature(policyWallet, typedData);
                }),
            /requested more than one signature/,
        );
    });

    it("does not count a failed signer call as an authorized signature", async () => {
        const policyWallet = createPolicyWallet({
            allowanceCapWei: 100n,
            signError: new Error("signer failed"),
        });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    await assert.rejects(
                        () => requestSignature(policyWallet, typedData),
                        /signer failed/,
                    );
                }),
            /completed with 0 signatures/,
        );
    });

    it("does not expose a signature that finishes after SDK work returns", async () => {
        let releaseSigner: (() => void) | undefined;
        const signGate = new Promise<void>((resolve) => {
            releaseSigner = resolve;
        });
        const policyWallet = createPolicyWallet({
            allowanceCapWei: 100n,
            signGate,
        });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);
        let unawaitedSignature: Promise<Hex> | undefined;

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    unawaitedSignature = requestSignature(
                        policyWallet,
                        typedData,
                    );
                }),
            /completed with 0 signatures/,
        );

        releaseSigner?.();
        await assert.rejects(
            async () => await unawaitedSignature!,
            /authorized offer is no longer active/,
        );
    });

    it("rejects a signature task that outlives its authorization", async () => {
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
        const authorization = tokenAuthorization(100n);
        const typedData = tokenOfferTypedData(authorization);
        let releaseDelayedSignature: (() => void) | undefined;
        const delayedStart = new Promise<void>((resolve) => {
            releaseDelayedSignature = resolve;
        });
        let delayedSignature: Promise<Hex> | undefined;

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    delayedSignature = delayedStart.then(
                        async () =>
                            await requestSignature(policyWallet, typedData),
                    );
                }),
            /completed with 0 signatures/,
        );

        releaseDelayedSignature?.();
        await assert.rejects(
            async () => await delayedSignature!,
            /authorized offer is no longer active/,
        );
    });

    it("keeps the authorized target stable if the job object changes during SDK work", async () => {
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });
        const authorization = tokenAuthorization(100n);

        await assert.rejects(
            () =>
                policyWallet.authorizeOffer(authorization, async () => {
                    if (
                        authorization.job.target.type !==
                        BIDDER_TARGET_TYPE.Token
                    ) {
                        throw new Error("expected token target");
                    }
                    authorization.job.target.tokenId = "999";
                    await requestSignature(
                        policyWallet,
                        tokenOfferTypedData(authorization),
                    );
                }),
            /target token id must be 42/,
        );
    });

    it("keeps concurrent signing authorizations isolated", async () => {
        const signedInputs: unknown[] = [];
        const policyWallet = createPolicyWallet({
            signedInputs,
            allowanceCapWei: 100n,
        });
        const first = tokenAuthorization(100n, "42");
        const second = tokenAuthorization(90n, "43");

        await Promise.all([
            policyWallet.authorizeOffer(first, async () => {
                await Promise.resolve();
                await requestSignature(
                    policyWallet,
                    tokenOfferTypedData(first),
                );
            }),
            policyWallet.authorizeOffer(second, async () => {
                await Promise.resolve();
                await requestSignature(
                    policyWallet,
                    tokenOfferTypedData(second),
                );
            }),
        ]);

        assert.equal(signedInputs.length, 2);
    });

    it("signs only the authorized order hash for pinned Seaport offchain cancellation", async () => {
        const policyWallet = createPolicyWallet({ allowanceCapWei: 100n });

        const signature = await policyWallet.authorizeOffchainCancellation(
            OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
            ORDER_HASH,
            async () =>
                await requestSignature(policyWallet, cancellationTypedData()),
        );

        assert.equal(signature, SIGNATURE);

        const wrongHashInput = cancellationTypedData();
        wrongHashInput.message.orderHash = `0x${"33".repeat(32)}`;
        await assert.rejects(
            () =>
                policyWallet.authorizeOffchainCancellation(
                    OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
                    ORDER_HASH,
                    async () =>
                        await requestSignature(policyWallet, wrongHashInput),
                ),
            /cancellation order hash must be/,
        );
    });
});

function createPolicyWallet(options: {
    signedInputs?: unknown[];
    allowanceCapWei: bigint;
    signError?: Error;
    signGate?: Promise<void>;
    trustOpenSeaSignedZoneTraitOffers?: boolean;
    biddingMandate?: BiddingMandate;
}): OpenSeaPolicyWallet {
    const signer: OpenSeaPolicyTypedDataSigner = {
        address: MAKER,
        async signTypedData(input) {
            if (options.signGate) {
                await options.signGate;
            }
            if (options.signError) {
                throw options.signError;
            }
            options.signedInputs?.push(input);
            return SIGNATURE;
        },
    };
    return new OpenSeaPolicyWallet(signer, {
        wethAddress: OPENSEA_MAINNET_SECURITY_POLICY.wethAddress,
        allowanceCapWei: options.allowanceCapWei,
        trustOpenSeaSignedZoneTraitOffers:
            options.trustOpenSeaSignedZoneTraitOffers ?? false,
        biddingMandate: options.biddingMandate ?? createBiddingMandate(),
    });
}

function createBiddingMandate(): BiddingMandate {
    return BiddingMandate.parse(
        {
            chainId: 1,
            collections: [
                {
                    collectionId: COLLECTION_ID,
                    artgodSlug: "policy-test",
                    contractAddress: COLLECTION,
                    openseaSlug: COLLECTION_SLUG,
                    maxUnitBidWei: "100",
                    maxQuantity: 1,
                },
            ],
        },
        1,
    );
}

function tokenAuthorization(
    totalAmountWei: bigint,
    tokenId = "42",
): OpenSeaOfferSigningAuthorization {
    return {
        job: makeJob({ type: BIDDER_TARGET_TYPE.Token, tokenId }),
        totalAmountWei,
        expirationTime: EXPIRATION_TIME,
    };
}

function traitAuthorization(
    totalAmountWei: bigint,
): OpenSeaOfferSigningAuthorization {
    return {
        job: makeJob({
            type: BIDDER_TARGET_TYPE.Collection,
            quantity: 1,
            traits: [{ type: "Background", value: "Gold" }],
        }),
        totalAmountWei,
        expirationTime: EXPIRATION_TIME,
    };
}

function makeJob(target: BidderJob["target"]): BidderJob {
    return {
        id: "policy-test-job",
        revision: 1,
        network: "eth",
        collectionId: COLLECTION_ID,
        collectionAddress: COLLECTION,
        collectionSlug: COLLECTION_SLUG,
        target,
        config: { floor: 1n, ceiling: 100n, delta: 1n },
        state: {},
    };
}

function tokenOfferTypedData(authorization: OpenSeaOfferSigningAuthorization) {
    if (authorization.job.target.type !== BIDDER_TARGET_TYPE.Token) {
        throw new Error("Expected token authorization");
    }
    return offerTypedData(authorization, {
        itemType: 2,
        token: COLLECTION,
        identifierOrCriteria: authorization.job.target.tokenId,
        startAmount: "1",
        endAmount: "1",
        recipient: MAKER,
    });
}

function collectionOfferTypedData(
    authorization: OpenSeaOfferSigningAuthorization,
) {
    return offerTypedData(authorization, {
        itemType: 4,
        token: COLLECTION,
        identifierOrCriteria: "0",
        startAmount: "1",
        endAmount: "1",
        recipient: MAKER,
    });
}

function offerTypedData(
    authorization: OpenSeaOfferSigningAuthorization,
    targetItem: {
        itemType: number;
        token: string;
        identifierOrCriteria: string;
        startAmount: string;
        endAmount: string;
        recipient: string;
    },
) {
    return {
        domain: {
            chainId: OPENSEA_MAINNET_SECURITY_POLICY.chainId,
            name: OPENSEA_MAINNET_SECURITY_POLICY.seaportName,
            version: OPENSEA_MAINNET_SECURITY_POLICY.seaportVersion,
            verifyingContract: OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
        },
        types: {
            OrderComponents: [
                { name: "offerer", type: "address" },
                { name: "zone", type: "address" },
                { name: "offer", type: "OfferItem[]" },
                { name: "consideration", type: "ConsiderationItem[]" },
                { name: "orderType", type: "uint8" },
                { name: "startTime", type: "uint256" },
                { name: "endTime", type: "uint256" },
                { name: "zoneHash", type: "bytes32" },
                { name: "salt", type: "uint256" },
                { name: "conduitKey", type: "bytes32" },
                { name: "counter", type: "uint256" },
            ],
            OfferItem: [
                { name: "itemType", type: "uint8" },
                { name: "token", type: "address" },
                { name: "identifierOrCriteria", type: "uint256" },
                { name: "startAmount", type: "uint256" },
                { name: "endAmount", type: "uint256" },
            ],
            ConsiderationItem: [
                { name: "itemType", type: "uint8" },
                { name: "token", type: "address" },
                { name: "identifierOrCriteria", type: "uint256" },
                { name: "startAmount", type: "uint256" },
                { name: "endAmount", type: "uint256" },
                { name: "recipient", type: "address" },
            ],
        },
        primaryType: "OrderComponents",
        message: {
            offerer: MAKER,
            zone: OPENSEA_MAINNET_SECURITY_POLICY.signedZoneAddress,
            offer: [
                {
                    itemType: 1,
                    token: OPENSEA_MAINNET_SECURITY_POLICY.wethAddress,
                    identifierOrCriteria: "0",
                    startAmount: authorization.totalAmountWei.toString(),
                    endAmount: authorization.totalAmountWei.toString(),
                },
            ],
            consideration: [
                targetItem,
                {
                    itemType: 1,
                    token: OPENSEA_MAINNET_SECURITY_POLICY.wethAddress,
                    identifierOrCriteria: "0",
                    startAmount: "5",
                    endAmount: "5",
                    recipient: FEE_RECIPIENT,
                },
            ],
            orderType: 3,
            startTime: "1",
            endTime: authorization.expirationTime.toString(),
            zoneHash: OPENSEA_MAINNET_SECURITY_POLICY.zeroBytes32,
            salt: "0",
            conduitKey: OPENSEA_MAINNET_SECURITY_POLICY.conduitKey,
            counter: "0",
        },
    };
}

function cancellationTypedData() {
    return {
        domain: {
            chainId: OPENSEA_MAINNET_SECURITY_POLICY.chainId,
            name: OPENSEA_MAINNET_SECURITY_POLICY.seaportName,
            version: OPENSEA_MAINNET_SECURITY_POLICY.seaportVersion,
            verifyingContract: OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress,
        },
        types: {
            OrderHash: [{ name: "orderHash", type: "bytes32" }],
        },
        primaryType: "OrderHash",
        message: { orderHash: ORDER_HASH as string },
    };
}

async function requestSignature(
    policyWallet: OpenSeaPolicyWallet,
    input: unknown,
): Promise<Hex> {
    const signTypedData = policyWallet.walletClient
        .signTypedData as unknown as (input: unknown) => Promise<Hex>;
    return await signTypedData(input);
}

async function requestWalletAction(action: unknown): Promise<unknown> {
    return await (action as () => Promise<unknown>)();
}
