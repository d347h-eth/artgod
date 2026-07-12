import { getAddress, toHex, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
    parseSecretEnvelope,
    type TradingBotKind,
    type TradingSecretEnvelopeMetadata,
} from "./secret-envelope.js";

// Carries validated public envelope metadata and the one process-lifetime signer capability.
export type TradingSigningAuthority = Readonly<{
    metadata: TradingSecretEnvelopeMetadata;
    signingAccount: PrivateKeyAccount;
}>;

/** Consumes one mutable secret frame and erases every ArtGod-owned raw-key buffer before returning. */
export function consumeTradingSigningAuthority(
    frame: Buffer,
    expectedBotKind: TradingBotKind,
): TradingSigningAuthority {
    let privateKeyBytes: Buffer | undefined;

    try {
        const envelope = parseSecretEnvelope(frame);
        privateKeyBytes = envelope.privateKeyBytes;

        if (envelope.metadata.botKind !== expectedBotKind) {
            throw new Error(
                `Secret envelope bot kind mismatch: expected ${expectedBotKind}, received ${envelope.metadata.botKind}`,
            );
        }

        let expectedAddress: Address;
        try {
            expectedAddress = getAddress(envelope.metadata.address);
        } catch {
            throw new Error("Secret envelope wallet address is invalid");
        }

        let signingAccount: PrivateKeyAccount;
        try {
            // Viem retains this one immutable key representation inside the account closure.
            signingAccount = privateKeyToAccount(toHex(privateKeyBytes));
        } catch {
            throw new Error("Secret envelope private key is invalid");
        }

        if (signingAccount.address !== expectedAddress) {
            throw new Error(
                `Derived address mismatch: expected ${expectedAddress}, received ${signingAccount.address}`,
            );
        }

        return Object.freeze({
            metadata: envelope.metadata,
            signingAccount,
        });
    } finally {
        // Erase the alias explicitly, then wipe metadata and key bytes across the complete frame.
        privateKeyBytes?.fill(0);
        frame.fill(0);
    }
}
