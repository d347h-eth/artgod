import type { FastifyRequest } from "fastify";
import type {
    UpdateCollectionBiddingSettingsInput,
    UpdateCollectionBiddingSettingsOutput,
} from "../../../application/use-cases/trading/update-collection-bidding-settings.js";
import { parseRequiredString } from "./trading-job-http.js";

export type UpdateCollectionBiddingSettingsRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
    Body: {
        tierSelectionMode?: unknown;
        defaultDeltaEth?: unknown;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class UpdateCollectionBiddingSettingsHttpAdapter {
    constructor(
        readonly updateCollectionBiddingSettingsPort: {
            updateCollectionBiddingSettings(
                input: UpdateCollectionBiddingSettingsInput,
            ): MaybePromise<UpdateCollectionBiddingSettingsOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<UpdateCollectionBiddingSettingsRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        return await this.updateCollectionBiddingSettingsPort.updateCollectionBiddingSettings(
            input,
        );
    };

    private mapRequestToInput(
        request: FastifyRequest<UpdateCollectionBiddingSettingsRoute>,
    ): UpdateCollectionBiddingSettingsInput {
        const body = request.body ?? {};
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            tierSelectionMode: parseRequiredString(
                body.tierSelectionMode,
                "tierSelectionMode",
            ),
            defaultDeltaEth: parseRequiredString(
                body.defaultDeltaEth,
                "defaultDeltaEth",
            ),
        };
    }
}
