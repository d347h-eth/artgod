import type { FastifyRequest } from "fastify";
import type {
    GetTokenUriInput,
    GetTokenUriOutput,
} from "../../../application/use-cases/collections/get-token-uri.js";

export type GetTokenUriRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
        token_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetTokenUriHttpAdapter {
    constructor(
        readonly getTokenUriPort: {
            getTokenUri(input: GetTokenUriInput): MaybePromise<GetTokenUriOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetTokenUriRoute>,
    ): Promise<GetTokenUriOutput> =>
        this.getTokenUriPort.getTokenUri({
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tokenRef: request.params.token_ref,
        });
}
