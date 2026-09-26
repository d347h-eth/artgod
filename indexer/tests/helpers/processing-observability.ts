import { AsyncLocalStorage } from "node:async_hooks";
import type { ApmPort } from "@artgod/shared/observability/apm";
import {
    createPrometheusMetrics,
    RUNTIME_METRIC_DEFAULT_LABEL,
} from "@artgod/shared/observability/metrics";
import { DomainProcessingMetrics } from "../../src/infra/observability/domain-processing-metrics.js";

type Span = {
    name: string;
    attributes: Parameters<ApmPort["withSpan"]>[1];
    parent?: Span;
    error?: unknown;
    finished: boolean;
};

/** Records the same error boundary as shared APM without starting exporters. */
export class RecordingProcessingApm implements ApmPort {
    readonly spans: Span[] = [];
    private readonly current = new AsyncLocalStorage<Span>();

    async withSpan<T>(
        name: string,
        attributes: Span["attributes"],
        work: () => Promise<T>,
    ): Promise<T> {
        const span = this.begin(name, attributes);
        try {
            return await this.current.run(span, work);
        } catch (error) {
            span.error = error;
            throw error;
        } finally {
            span.finished = true;
        }
    }

    withSyncSpan<T>(
        name: string,
        attributes: Span["attributes"],
        work: () => T,
    ): T {
        const span = this.begin(name, attributes);
        try {
            return this.current.run(span, work);
        } catch (error) {
            span.error = error;
            throw error;
        } finally {
            span.finished = true;
        }
    }

    private begin(name: string, attributes: Span["attributes"]): Span {
        const span = {
            name,
            attributes,
            parent: this.current.getStore(),
            finished: false,
        };
        this.spans.push(span);
        return span;
    }
}

export async function processingTelemetry(now: () => number = Date.now) {
    const metrics = await createPrometheusMetrics({
        collectProcessMetrics: false,
        defaultLabels: {
            [RUNTIME_METRIC_DEFAULT_LABEL.Worker]: "domain-worker",
            [RUNTIME_METRIC_DEFAULT_LABEL.ChainId]: "1",
        },
    });
    if (!metrics)
        throw new Error("prom-client is required for observability tests");
    const observer = new DomainProcessingMetrics(metrics, now);
    const apm = new RecordingProcessingApm();
    return {
        metrics,
        observer,
        apm,
        hooks: { observer, apm },
        async value(
            name: string,
            labels: Record<string, string> = {},
        ): Promise<number> {
            const scrape = await metrics.metricsText();
            // Assert the real default export prefix at the wire boundary, including no duplicate prefix.
            const prefix = `artgod_indexer_${name}`;
            const values = scrape
                .split("\n")
                .filter(
                    (line) =>
                        (line.startsWith(`${prefix}{`) ||
                            line.startsWith(`${prefix} `)) &&
                        Object.entries(labels).every(([key, value]) =>
                            line.includes(`${key}="${value}"`),
                        ),
                );
            if (values.length !== 1)
                throw new Error(
                    `Expected one sample for ${prefix} ${JSON.stringify(labels)}, found ${values.length}`,
                );
            return Number(values[0]!.slice(values[0]!.lastIndexOf(" ") + 1));
        },
    };
}
