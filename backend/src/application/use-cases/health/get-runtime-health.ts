export type RuntimeHealthCheck = {
    key: string;
    status: "pass" | "warn" | "fail";
    message: string;
};

export type GetRuntimeHealthOutput = {
    ok: boolean;
    checks: RuntimeHealthCheck[];
};

type MaybePromise<T> = T | Promise<T>;

export type RuntimeHealthDatabasePort = {
    pingDatabase(): MaybePromise<void>;
};

export type RuntimeHealthQueuePort = {
    assertJobsStreamExists(streamName: string): MaybePromise<void>;
};

export class GetRuntimeHealthUseCase {
    constructor(
        private readonly databasePort: RuntimeHealthDatabasePort,
        private readonly queuePort: RuntimeHealthQueuePort,
        private readonly jobsStreamName: string,
    ) {}

    async getRuntimeHealth(): Promise<GetRuntimeHealthOutput> {
        const checks: RuntimeHealthCheck[] = [
            {
                key: "backendProcess",
                status: "pass",
                message: "Backend process is running",
            },
        ];

        await this.runCheck(checks, "database", "Database ping", async () => {
            await this.databasePort.pingDatabase();
        });

        await this.runQueueCheck(checks);

        return {
            ok: checks.every((check) => check.status !== "fail"),
            checks,
        };
    }

    private async runCheck(
        checks: RuntimeHealthCheck[],
        key: string,
        label: string,
        run: () => Promise<void>,
    ): Promise<void> {
        try {
            await run();
            checks.push({
                key,
                status: "pass",
                message: `${label} check passed`,
            });
        } catch (error) {
            checks.push({
                key,
                status: "fail",
                message: `${label} check failed: ${toErrorMessage(error)}`,
            });
        }
    }

    private async runQueueCheck(checks: RuntimeHealthCheck[]): Promise<void> {
        try {
            await this.queuePort.assertJobsStreamExists(this.jobsStreamName);
            checks.push({
                key: "queue",
                status: "pass",
                message: "NATS jobs stream check passed",
            });
            return;
        } catch (error) {
            const message = toErrorMessage(error);
            if (isJobsStreamMissingError(message, this.jobsStreamName)) {
                checks.push({
                    key: "queue",
                    status: "warn",
                    message:
                        "NATS is reachable, but jobs stream is not created yet",
                });
                return;
            }
            checks.push({
                key: "queue",
                status: "fail",
                message: `NATS jobs stream check failed: ${message}`,
            });
        }
    }
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    if (typeof error === "string" && error.trim().length > 0) {
        return error;
    }
    return "unknown error";
}

function isJobsStreamMissingError(
    message: string,
    jobsStreamName: string,
): boolean {
    return message.includes(`JetStream stream not found: ${jobsStreamName}`);
}
