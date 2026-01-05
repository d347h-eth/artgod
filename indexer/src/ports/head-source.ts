export interface HeadSourcePort {
    start(
        onHead: (head: number) => void,
        onError?: (error: unknown) => void,
    ): Promise<() => Promise<void>>;
}
