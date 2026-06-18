import type { FastifyRequest } from "fastify";
import type { ApplyBootstrapRunStepActionOutput } from "../../../application/use-cases/bootstrap/apply-bootstrap-run-step-action.js";
import {
    parseBootstrapRunId,
    parseBootstrapStepAction,
    parseBootstrapStepKey,
} from "./request-parsing.js";

export type ApplyBootstrapRunStepActionRoute = {
    Params: {
        chain_ref: string;
        run_id: string;
        step_key: string;
        action: string;
    };
};

type MaybePromise<T> = T | Promise<T>;

export class ApplyBootstrapRunStepActionHttpAdapter {
    constructor(
        private readonly applyBootstrapRunStepActionPort: {
            applyStepAction(input: {
                chainRef: string;
                runId: number;
                stepKey: ReturnType<typeof parseBootstrapStepKey>;
                action: ReturnType<typeof parseBootstrapStepAction>;
            }): MaybePromise<ApplyBootstrapRunStepActionOutput>;
        },
    ) {}

    readonly handle = async (
        request: FastifyRequest<ApplyBootstrapRunStepActionRoute>,
    ) => {
        return this.applyBootstrapRunStepActionPort.applyStepAction({
            chainRef: request.params.chain_ref,
            runId: parseBootstrapRunId(request.params.run_id),
            stepKey: parseBootstrapStepKey(request.params.step_key),
            action: parseBootstrapStepAction(request.params.action),
        });
    };
}
