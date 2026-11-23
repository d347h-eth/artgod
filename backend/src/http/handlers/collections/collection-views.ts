import type { FastifyRequest } from "fastify";
import { PRICE_HISTORY_QUERY } from "@artgod/shared/http/collection-routes";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type { CollectionViewsUseCase } from "../../../application/use-cases/collections/collection-views.js";
import {
    catalogRequest,
    positiveInteger,
} from "../../common/trait-catalog-query.js";
import { getSearchParams } from "../../common/request-query.js";

export type CollectionViewsRoute = {
    Params: { chain_ref: string; collection_ref: string; run_id?: string };
};
export class CollectionViewsHttpAdapter {
    constructor(
        private readonly useCase: CollectionViewsUseCase,
        private readonly includeRebuildDetails: boolean,
    ) {}
    private input(request: FastifyRequest<CollectionViewsRoute>) {
        return {
            chainRef: request.params.chain_ref,
            collectionRef: request.params.collection_ref,
            ...catalogRequest(request),
        };
    }
    discover = async (request: FastifyRequest<CollectionViewsRoute>) => {
        const discovery = this.useCase.discover({
            ...this.input(request),
            tokenId:
                getSearchParams(request).get(PRICE_HISTORY_QUERY.TokenId) ??
                undefined,
        });
        if (this.includeRebuildDetails) return discovery;
        // Public coverage describes what readers can see. Worker errors belong to the operator.
        return {
            ...discovery,
            views: discovery.views.map(({ latestRun, ...view }) => view),
        };
    };
    rebuild = async (request: FastifyRequest<CollectionViewsRoute>) => {
        const body = request.body ?? {};
        if (
            typeof body !== "object" ||
            Array.isArray(body) ||
            ("mapperVersion" in body && typeof body.mapperVersion !== "string")
        )
            throw new ReadModelBadRequestError("Invalid rebuild request");
        return this.useCase.rebuild({
            ...this.input(request),
            mapperVersion:
                "mapperVersion" in body
                    ? (body.mapperVersion as string)
                    : undefined,
            retryRunId:
                "retryRunId" in body
                    ? positiveInteger(body.retryRunId)
                    : undefined,
        });
    };
    progress = async (request: FastifyRequest<CollectionViewsRoute>) =>
        this.useCase.progress({
            ...this.input(request),
            runId: positiveInteger(request.params.run_id),
        });
}
