import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import {
    Chain,
    getChainId,
    getDefaultConduit,
    getOfferPaymentToken,
    getSeaportAddress,
    getSeaportVersion,
    getSignedZone,
} from "@opensea/sdk";
import { getAddress } from "viem";
import { OPENSEA_MAINNET_SECURITY_POLICY } from "@artgod/shared/trading/open-sea-mainnet-security-policy";

describe("OpenSea mainnet security policy", () => {
    it("matches the contracts selected by the pinned OpenSea SDK", () => {
        const conduit = getDefaultConduit(Chain.Mainnet);

        assert.equal(
            Number(getChainId(Chain.Mainnet)),
            OPENSEA_MAINNET_SECURITY_POLICY.chainId,
        );
        assert.equal(
            getAddress(getSeaportAddress(Chain.Mainnet)),
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress),
        );
        assert.equal(
            getSeaportVersion(OPENSEA_MAINNET_SECURITY_POLICY.seaportAddress),
            OPENSEA_MAINNET_SECURITY_POLICY.seaportVersion,
        );
        assert.equal(
            getAddress(getSignedZone(Chain.Mainnet)),
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.signedZoneAddress),
        );
        assert.equal(
            conduit.key.toLowerCase(),
            OPENSEA_MAINNET_SECURITY_POLICY.conduitKey.toLowerCase(),
        );
        assert.equal(
            getAddress(conduit.address),
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.conduitAddress),
        );
        assert.equal(
            getAddress(getOfferPaymentToken(Chain.Mainnet)),
            getAddress(OPENSEA_MAINNET_SECURITY_POLICY.wethAddress),
        );
    });
});
