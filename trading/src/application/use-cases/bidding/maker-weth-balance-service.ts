// Optional WETH balance clamp port for keeping bids inside current wallet liquidity.
export interface MakerWethBalanceService {
    getWethBalance(address: string): Promise<bigint>;
}
