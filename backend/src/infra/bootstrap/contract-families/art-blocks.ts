import {
    BaseError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
} from "viem";
import {
    BOOTSTRAP_SHARED_CONTRACT_REASON as Reason,
    type BootstrapSharedContractFinding,
} from "@artgod/shared/bootstrap/probe";
import {
    BOOTSTRAP_ACTION_LABEL as Action,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import type { BootstrapProbeRpc } from "../viem-bootstrap-contract-probe.js";

// Family recognition is advisory. These getters do not establish provenance,
// project boundaries, mint caps or the collection the user intends to import.
export const ART_BLOCKS_FUNCTION = {
    Registered: "isRegisteredContract",
    NextProject: "nextProjectId",
    Details: "projectDetails",
    State: "projectStateData",
    TokenInfo: "projectTokenInfo",
} as const;
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
} as const;

/** Bounded recognition, never project enumeration; no off-chain APIs. */
export async function probeArtBlocksSharedContract(
    rpc: Pick<BootstrapProbeRpc, "readContract">,
    input: { address: `0x${string}`; chainId: number; blockNumber: number },
    report?: BootstrapOutputReporter,
): Promise<BootstrapSharedContractFinding | null> {
    async function read(
        functionName: FunctionName,
        argument?: bigint | `0x${string}`,
        address = input.address,
    ): Promise<unknown> {
        const label = `${address} · ${functionName}(${argument ?? ""})`;
        report?.({
            step: Step.SharedContract,
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
                step: Step.SharedContract,
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
                step: Step.SharedContract,
                status: unsupported ? Status.Skipped : Status.Failed,
                message: `${label}: ${unsupported ? "getter unavailable" : `read failed; check RPC settings and retry ${Action.Probe}`}`,
            });
            return undefined;
        }
    }
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
                    "Art Blocks Core Registry recognizes this multi-project contract. Specify the collection's token range or list manually.",
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
    const validCounts = (minted: unknown, maximum: unknown) =>
        typeof minted === "bigint" &&
        typeof maximum === "bigint" &&
        minted >= 0n &&
        maximum > 0n &&
        minted <= maximum;
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
