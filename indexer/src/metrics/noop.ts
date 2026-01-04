import type { MetricLabels, Metrics } from "./types.js";

export const noopMetrics: Metrics = {
    increment(_name: string, _value?: number, _labels?: MetricLabels) {},
    gauge(_name: string, _value: number, _labels?: MetricLabels) {},
    histogram(_name: string, _value: number, _labels?: MetricLabels) {},
};
