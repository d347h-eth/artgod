import {
    BaseError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
} from "viem";
import {
    BOOTSTRAP_SHARED_CONTRACT_REASON as Reason,
    type BootstrapSharedContractFinding,
    type BootstrapProjectScopeSuggestion,
} from "@artgod/shared/bootstrap/probe";
import { EVM_TOKEN_ID_MAX } from "@artgod/shared/evm/token-id";
import {
    BOOTSTRAP_ACTION_LABEL as Action,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutputReporter,
    type BootstrapOutput,
} from "@artgod/shared/bootstrap/operation-output";
import type { BootstrapProbeRpc } from "../viem-bootstrap-contract-probe.js";

// Getter compatibility alone is advisory; project suggestions additionally
// require the permissioned registry and a confirmed sample's project model.
export const ART_BLOCKS_FUNCTION = {
    Registered: "isRegisteredContract",
    NextProject: "nextProjectId",
    Details: "projectDetails",
    State: "projectStateData",
    TokenInfo: "projectTokenInfo",
    TokenProject: "tokenIdToProjectId",
    CoreType: "coreType",
} as const;
// Art Blocks' mint encoding, not a generic decimal-rounding heuristic.
// https://docs.artblocks.io/developer/core-contract/#token-id-structure
export const ART_BLOCKS_PROJECT_TOKEN_STRIDE = 1_000_000n;
export const ART_BLOCKS_V3_CORE_TYPES = [
    "GenArt721CoreV3",
    "GenArt721CoreV3_Engine",
    "GenArt721CoreV3_Engine_Flex",
] as const;
// Official permissioned mainnet registry. Never query this address on other chains.
// https://github.com/ArtBlocks/artblocks-contracts/blob/main/packages/contracts/INFRASTRUCTURE.md#mainnet
export const ART_BLOCKS_MAINNET_REGISTRY = {
    chainId: 1,
    address: "0x2ee7b9bb2e038be7323a119701a191c030a61ec6",
} as const;

type FunctionName =
    (typeof ART_BLOCKS_FUNCTION)[keyof typeof ART_BLOCKS_FUNCTION];
const F = ART_BLOCKS_FUNCTION;
const outputs = {
    [F.Registered]: ["bool"],
    [F.NextProject]: ["uint256"],
    // Decode the common prefix: legacy versions have additional trailing fields.
    [F.Details]: ["string", "string", "string", "string", "string"],
    [F.State]: ["uint256", "uint256"],
    [F.TokenInfo]: ["address", "uint256", "uint256", "uint256"],
    [F.TokenProject]: ["uint256"],
    [F.CoreType]: ["string"],
} as const;

type ReadInput = {
    address: `0x${string}`;
    chainId: number;
    blockNumber: number;
};
const UNSUPPORTED = Symbol("unsupported Art Blocks getter");

function artBlocksReader(
    rpc: Pick<BootstrapProbeRpc, "readContract">,
    input: ReadInput,
    report?: BootstrapOutputReporter,
    step: BootstrapOutput["step"] = Step.SharedContract,
) {
    return async function read(
        functionName: FunctionName,
        argument?: bigint | `0x${string}`,
        address = input.address,
    ): Promise<unknown> {
        const label = `${address} · ${functionName}(${argument ?? ""})`;
        report?.({
            step,
            status: Status.Started,
            message: label,
        });
        try {
            const result = await rpc.readContract({
                address,
                blockNumber: input.blockNumber,
                functionName,
                abi: [
                    {
                        type: "function",
                        name: functionName,
                        stateMutability: "view",
                        inputs:
                            argument === undefined
                                ? []
                                : [
                                      {
                                          type:
                                              typeof argument === "bigint"
                                                  ? "uint256"
                                                  : "address",
                                      },
                                  ],
                        outputs: outputs[functionName].map((type) => ({
                            type,
                        })),
                    },
                ],
                args: argument === undefined ? undefined : [argument],
            });
            report?.({
                step,
                status: Status.Succeeded,
                message: `${label}: ${Array.isArray(result) ? "project record returned" : String(result)}`,
            });
            return result;
        } catch (error) {
            const unsupported =
                error instanceof BaseError &&
                error.walk(
                    (cause) =>
                        cause instanceof ContractFunctionRevertedError ||
                        cause instanceof ContractFunctionZeroDataError,
                );
            report?.({
                step,
                status: unsupported ? Status.Skipped : Status.Failed,
                message: `${label}: ${unsupported ? "getter unavailable" : `read failed; check RPC settings and retry ${step === Step.ProjectScope ? Action.Inspect : Action.Probe}`}`,
            });
            return unsupported ? UNSUPPORTED : undefined;
        }
    };
}

function validCounts(minted: unknown, maximum: unknown): boolean {
    return (
        typeof minted === "bigint" &&
        typeof maximum === "bigint" &&
        minted >= 0n &&
        maximum > 0n &&
        minted <= maximum
    );
}

/** Bounded recognition, never project enumeration; no off-chain APIs. */
export async function probeArtBlocksSharedContract(
    rpc: Pick<BootstrapProbeRpc, "readContract">,
    input: ReadInput,
    report?: BootstrapOutputReporter,
): Promise<BootstrapSharedContractFinding | null> {
    const read = artBlocksReader(rpc, input, report);
    if (input.chainId === ART_BLOCKS_MAINNET_REGISTRY.chainId) {
        const registered = await read(
            F.Registered,
            input.address,
            ART_BLOCKS_MAINNET_REGISTRY.address,
        );
        if (registered === true) {
            report?.({
                step: Step.SharedContract,
                status: Status.Succeeded,
                message:
                    "Art Blocks Core Registry recognizes this multi-project contract. Inspect a token from the intended project for range suggestions, or specify its range or list manually.",
            });
            return {
                reason: Reason.Registry,
                registryAddress: ART_BLOCKS_MAINNET_REGISTRY.address,
            };
        }
    }
    // Recognize compatible forks without trusting a self-reported name/coreType.
    // One populated project plus both project getters is evidence of the project
    // model, including a currently single-project contract. Never assume start=0.
    const next = await read(F.NextProject);
    if (typeof next !== "bigint" || next <= 0n) return null;
    const projectId = next - 1n;
    const details = await read(F.Details, projectId);
    if (
        !Array.isArray(details) ||
        details.length < 5 ||
        !details.slice(0, 5).every((value) => typeof value === "string") ||
        !details[0].trim()
    )
        return null;
    const state = await read(F.State, projectId);
    let compatible = Array.isArray(state) && validCounts(state[0], state[1]);
    if (!compatible) {
        const info = await read(F.TokenInfo, projectId);
        compatible =
            Array.isArray(info) &&
            typeof info[0] === "string" &&
            /^0x[0-9a-f]{40}$/i.test(info[0]) &&
            typeof info[1] === "bigint" &&
            validCounts(info[2], info[3]);
    }
    if (!compatible) return null;
    report?.({
        step: Step.SharedContract,
        status: Status.Succeeded,
        message: `Art Blocks-compatible project getters · project #${projectId}. Likely shared contract; specify the collection's token range or list manually.`,
    });
    return { reason: Reason.ProjectInterface, registryAddress: null };
}

/** Called only after sample ownership is confirmed at the same pinned block.
 * Registry membership is checked here, never accepted from the browser or an
 * earlier probe. Compatible unregistered forks keep manual scope control.
 */
export async function inspectArtBlocksProjectScope(
    rpc: Pick<BootstrapProbeRpc, "readContract">,
    input: ReadInput & { tokenId: string },
    report?: BootstrapOutputReporter,
): Promise<BootstrapProjectScopeSuggestion | null> {
    if (input.chainId !== ART_BLOCKS_MAINNET_REGISTRY.chainId) return null;
    const read = artBlocksReader(rpc, input, report, Step.ProjectScope);
    if (
        (await read(
            F.Registered,
            input.address,
            ART_BLOCKS_MAINNET_REGISTRY.address,
        )) !== true
    )
        return null;

    const unavailable = (message: string) => {
        report?.({
            step: Step.ProjectScope,
            status: Status.Skipped,
            message: `${message} Specify this collection's token range or list manually.`,
        });
        return null;
    };
    const tokenId = BigInt(input.tokenId);
    const projectId = tokenId / ART_BLOCKS_PROJECT_TOKEN_STRIDE;
    const start = projectId * ART_BLOCKS_PROJECT_TOKEN_STRIDE;
    // V3 also exposes tokenIdToProjectId. Select the counter ABI by core type,
    // never by the presence of that getter. Explorations reports the flagship type.
    const coreType = await read(F.CoreType);
    const v3 = ART_BLOCKS_V3_CORE_TYPES.some((type) => type === coreType);
    if (coreType === undefined)
        return unavailable(
            `Contract type could not be read. Retry ${Action.Inspect}.`,
        );
    if (!v3 && coreType !== UNSUPPORTED)
        return unavailable(
            "Registered contract has no supported project lookup.",
        );
    const mapped = await read(F.TokenProject, tokenId);
    if (typeof mapped === "bigint") {
        if (mapped !== projectId)
            return unavailable(
                "Token project mapping does not match the supported Art Blocks encoding.",
            );
    } else if (mapped !== UNSUPPORTED || !v3) {
        // A failed mapping read must not switch to a different ABI/interpretation.
        return unavailable(
            `Token project lookup failed. Retry ${Action.Inspect}.`,
        );
    }
    let counts: unknown;
    if (v3) {
        counts = await read(F.State, projectId);
    } else {
        const info = await read(F.TokenInfo, projectId);
        counts = Array.isArray(info) ? info.slice(2, 4) : null;
    }
    if (!Array.isArray(counts) || !validCounts(counts[0], counts[1]))
        return unavailable(
            `Project counts are unavailable or inconsistent. Retry ${Action.Inspect}.`,
        );
    const [minted, maximum] = counts as [bigint, bigint];
    if (
        maximum > ART_BLOCKS_PROJECT_TOKEN_STRIDE ||
        tokenId - start >= minted ||
        start + maximum - 1n > EVM_TOKEN_ID_MAX
    )
        return unavailable(
            "Sample token and project counts do not define a supported token range.",
        );

    const details = await read(F.Details, projectId);
    const projectName =
        Array.isArray(details) && typeof details[0] === "string"
            ? details[0].trim() || null
            : null;
    const result: BootstrapProjectScopeSuggestion = {
        projectId: projectId.toString(),
        projectName,
        startTokenId: start.toString(),
        mintedTokenCount: Number(minted),
        maxTokenCount: Number(maximum),
    };
    report?.({
        step: Step.ProjectScope,
        status: Status.Succeeded,
        message: `${projectName ? `${projectName} · ` : ""}Art Blocks project #${projectId} · sample #${tokenId} · first token ID ${start} · ${minted} minted · configured maximum ${maximum} · minted IDs ${start}–${start + minted - 1n}. Review and apply the project range suggestions.`,
    });
    return result;
}
