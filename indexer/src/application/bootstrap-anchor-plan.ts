// Resolves the confirmed bootstrap anchor block from current head and reorg depth.
export function resolveBootstrapAnchorBlock(input: {
    headBlock: number;
    reorgDepth: number;
}): number | null {
    const anchorBlock = input.headBlock - Math.max(0, input.reorgDepth);
    return anchorBlock >= 1 ? anchorBlock : null;
}
