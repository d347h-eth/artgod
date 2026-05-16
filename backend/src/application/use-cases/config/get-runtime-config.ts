import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";

export type GetRuntimeConfigOutput = {
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
};

export class GetRuntimeConfigUseCase {
    constructor(
        private readonly openseaIntegration: OpenSeaIntegrationStatus,
    ) {}

    getConfig(): GetRuntimeConfigOutput {
        return {
            integrations: {
                opensea: this.openseaIntegration,
            },
        };
    }
}
