import type { FastifyRequest } from "fastify";
import type {
    GetCollectionCustomizationInput,
    GetCollectionCustomizationOutput,
} from "../../../application/use-cases/collections/get-collection-customization.js";

export type GetCollectionCustomizationRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class GetCollectionCustomizationHttpAdapter {
    constructor(
        readonly getCollectionCustomizationPort: {
            getCollectionCustomization(
                input: GetCollectionCustomizationInput,
            ): MaybePromise<GetCollectionCustomizationOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<GetCollectionCustomizationRoute>,
    ) => {
        const output =
            await this.getCollectionCustomizationPort.getCollectionCustomization(
                {
                    chainRef: request.params.chain_ref,
                    collectionRef: request.params.collection_ref,
                },
            );
        return output;
    };
}
