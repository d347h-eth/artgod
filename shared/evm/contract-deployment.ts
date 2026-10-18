export interface ContractDeploymentRpcPort {
    getBytecode(
        address: `0x${string}`,
        blockNumber: number,
        beforeRequest?: () => void,
    ): Promise<`0x${string}` | null>;
}

export type ContractDeploymentSearchProgress = {
    absentBlock: number;
    presentBlock: number | null;
};

export function createContractDeploymentSearchProgress(): ContractDeploymentSearchProgress {
    // -1 is the absent boundary before genesis, never an RPC block number.
    return { absentBlock: -1, presentBlock: null };
}

// Saved boundaries describe successful code reads for the caller's pinned
// snapshot. A null present boundary means the upper block has not been checked.
export function parseContractDeploymentSearchProgress(
    value: unknown,
    upperBlock: number,
): ContractDeploymentSearchProgress | null {
    if (!Number.isSafeInteger(upperBlock) || upperBlock < 0) return null;
    if (!value || typeof value !== "object") return null;
    const { absentBlock, presentBlock: savedPresent } =
        value as Partial<ContractDeploymentSearchProgress>;
    // JSON merge-patch removes null fields; preserve the unconfirmed state.
    const presentBlock = savedPresent ?? null;
    if (!Number.isSafeInteger(absentBlock) || absentBlock! < -1) return null;
    if (presentBlock === null)
        return absentBlock === -1 ? { absentBlock, presentBlock } : null;
    if (
        !Number.isSafeInteger(presentBlock) ||
        presentBlock < 0 ||
        presentBlock > upperBlock ||
        absentBlock! >= presentBlock
    )
        return null;
    return { absentBlock: absentBlock!, presentBlock };
}

// Finds the first block with runtime code. This assumes code presence is
// continuous after deployment; it cannot identify earlier destroyed contracts
// at an address later redeployed. Archive-state failures propagate as errors.
export async function findContractDeploymentBlock(input: {
    rpc: ContractDeploymentRpcPort;
    address: `0x${string}`;
    upperBlock: number;
    progress?: ContractDeploymentSearchProgress;
    // Called only after a successful probe. Persistence failures propagate so
    // callers cannot skip an uncommitted boundary on retry or restart.
    onProgress?: (progress: ContractDeploymentSearchProgress) => void;
}): Promise<number> {
    assertBlockNumber(input.upperBlock);
    const progress = parseContractDeploymentSearchProgress(
        input.progress ?? createContractDeploymentSearchProgress(),
        input.upperBlock,
    );
    if (!progress)
        throw new Error("Invalid contract deployment search progress");
    const hasCode = async (block: number): Promise<boolean> => {
        const code = await input.rpc.getBytecode(input.address, block);
        return code !== null && code !== "0x";
    };

    let absent = progress.absentBlock;
    let present = progress.presentBlock ?? input.upperBlock;
    const checkpoint = () =>
        input.onProgress?.({ absentBlock: absent, presentBlock: present });
    if (progress.presentBlock === null) {
        if (!(await hasCode(present)))
            throw new Error(
                "Contract has no code at the deployment search upper block",
            );
        checkpoint();
    }
    while (present - absent > 1) {
        const middle = absent + Math.floor((present - absent) / 2);
        if (await hasCode(middle)) present = middle;
        else absent = middle;
        checkpoint();
    }
    return present;
}

function assertBlockNumber(block: number): void {
    if (!Number.isSafeInteger(block) || block < 0) {
        throw new Error("Invalid contract deployment block number");
    }
}
