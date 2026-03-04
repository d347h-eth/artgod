import type { FastifyRequest } from "fastify";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import type {
    CreateBootstrapRunInput,
    CreateBootstrapRunOutput,
} from "../../../application/use-cases/bootstrap/types.js";

export type CreateBootstrapRunRoute = {
    Params: {
        chain_ref: string;
    };
    Body: {
        slug?: string;
        address?: string;
        standard?: string;
        metadataMode?: string;
        supportsEnumerable?: boolean;
        manualInput?: {
            mode?: string;
            tokenIds?: unknown;
            startTokenId?: unknown;
            totalSupply?: unknown;
        };
        deploymentBlock?: number;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class CreateBootstrapRunHttpAdapter {
    constructor(
        private readonly createBootstrapRunPort: {
            createRun(
                input: CreateBootstrapRunInput,
            ): MaybePromise<CreateBootstrapRunOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<CreateBootstrapRunRoute>,
    ) => {
        const input = this.mapRequestToInput(request);
        const output = await this.createBootstrapRunPort.createRun(input);
        return this.mapOutputToResponse(output);
    };

    private mapRequestToInput(
        request: FastifyRequest<CreateBootstrapRunRoute>,
    ): CreateBootstrapRunInput {
        const body = request.body ?? {};
        const slug = mustString(body.slug, "slug");
        const address = mustString(body.address, "address");
        const standard = mustString(body.standard, "standard");
        const metadataMode = mustString(body.metadataMode, "metadataMode");
        const supportsEnumerable = body.supportsEnumerable;
        if (typeof supportsEnumerable !== "boolean") {
            throw new ReadModelBadRequestError(
                "supportsEnumerable must be boolean",
            );
        }

        const manualInput = parseManualInput(body.manualInput);
        const deploymentBlock = parseOptionalPositiveInteger(
            body.deploymentBlock,
            "deploymentBlock",
        );

        return {
            chainRef: request.params.chain_ref,
            slug,
            address,
            standard: standard as "erc721",
            metadataMode: metadataMode as "strict" | "best_effort",
            supportsEnumerable,
            manualInput,
            deploymentBlock: deploymentBlock ?? undefined,
        };
    }

    private mapOutputToResponse(
        output: CreateBootstrapRunOutput,
    ): CreateBootstrapRunOutput {
        return output;
    }
}

function mustString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new ReadModelBadRequestError(`${field} is required`);
    }
    return value.trim();
}

function parseOptionalPositiveInteger(
    value: unknown,
    field: string,
): number | null {
    if (value === undefined || value === null) return null;
    if (!Number.isInteger(value) || Number(value) <= 0) {
        throw new ReadModelBadRequestError(`${field} must be a positive integer`);
    }
    return Number(value);
}

function parseManualInput(value: unknown): CreateBootstrapRunInput["manualInput"] {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (!value || typeof value !== "object") {
        throw new ReadModelBadRequestError("manualInput must be an object");
    }
    const source = value as {
        mode?: unknown;
        tokenIds?: unknown;
        startTokenId?: unknown;
        totalSupply?: unknown;
    };
    if (source.mode === "manual_token_ids") {
        if (!Array.isArray(source.tokenIds)) {
            throw new ReadModelBadRequestError(
                "manualInput.tokenIds must be an array",
            );
        }
        const tokenIds = source.tokenIds.map((tokenId) => {
            if (typeof tokenId !== "string" || !tokenId.trim()) {
                throw new ReadModelBadRequestError(
                    "manualInput.tokenIds contains invalid token id",
                );
            }
            return tokenId.trim();
        });
        return {
            mode: "manual_token_ids",
            tokenIds,
        };
    }
    if (source.mode === "manual_range") {
        if (
            typeof source.startTokenId !== "string" ||
            !source.startTokenId.trim()
        ) {
            throw new ReadModelBadRequestError(
                "manualInput.startTokenId is required",
            );
        }
        if (
            !Number.isInteger(source.totalSupply) ||
            Number(source.totalSupply) <= 0
        ) {
            throw new ReadModelBadRequestError(
                "manualInput.totalSupply must be a positive integer",
            );
        }
        return {
            mode: "manual_range",
            startTokenId: source.startTokenId.trim(),
            totalSupply: Number(source.totalSupply),
        };
    }
    throw new ReadModelBadRequestError("Invalid manualInput.mode");
}
