import type { FastifyReply, FastifyRequest } from "fastify";

export type CommonHttpHandlers = {
    optionsApi: (
        request: FastifyRequest,
        reply: FastifyReply,
    ) => Promise<void>;
};

export function createCommonHttpHandlers(): CommonHttpHandlers {
    return {
        optionsApi: async (_request, reply) => {
            reply.code(204).send();
        },
    };
}
