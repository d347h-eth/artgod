import {
    BOOTSTRAP_OUTPUT_STATUS as Status,
    type BootstrapOutput,
    type BootstrapOutputReporter,
} from "@artgod/shared/bootstrap/operation-output";
import {
    HTTP_FETCH_PHASE,
    type HttpFetchObserver,
} from "@artgod/shared/network/http-fetch-observation";

/** Keep the exact public URL selectable while excluding private request configuration. */
export function bootstrapResourceObserver(
    report: BootstrapOutputReporter | undefined,
    step: BootstrapOutput["step"],
): HttpFetchObserver | undefined {
    if (!report) return undefined;
    return (event) => {
        const response =
            event.status === undefined
                ? (event.reason ?? "Request failed")
                : `HTTP ${event.status}`;
        switch (event.phase) {
            case HTTP_FETCH_PHASE.Request:
                report({
                    step,
                    status: Status.Started,
                    url: event.url,
                    message: `GET · attempt ${event.attempt}/${event.maxAttempts}`,
                });
                break;
            case HTTP_FETCH_PHASE.Response:
                report({
                    step,
                    status:
                        event.status! >= 400 ? Status.Failed : Status.Succeeded,
                    url: event.url,
                    message: response,
                });
                break;
            case HTTP_FETCH_PHASE.Retry:
                report({
                    step,
                    status: Status.Retrying,
                    url: event.url,
                    message: `${response} · retry ${event.attempt + 1}/${event.maxAttempts} in ${event.delayMs} ms`,
                });
                break;
            case HTTP_FETCH_PHASE.Failure:
                report({
                    step,
                    status: Status.Failed,
                    url: event.url,
                    message: `${response} · stopped after ${event.attempt} attempt(s). Open this URL to check access, then retry.`,
                });
        }
    };
}
