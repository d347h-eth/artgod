import assert from "node:assert/strict";
import {
    API_CSRF_ROUTE_PATH,
    buildApiCsrfHeaders,
} from "../../../shared/http/api-security.ts";

/** Secured operator input at the real backend's external HTTP boundary. */
export function createOperatorHttp({ origin, fetchFn = fetch }) {
    const url = new URL(origin);
    assert.equal(
        url.origin,
        origin,
        "Use an explicit backend origin without a path",
    );
    let token;
    const json = async (response, action) => {
        assert.equal(
            response.status,
            200,
            `${action}: HTTP ${response.status}: ${await response.clone().text()}`,
        );
        return response.json();
    };
    const get = async (route) =>
        json(await fetchFn(`${origin}${route}`), "Read operator state");
    const write = async (method, route, body) => {
        if (!token) {
            const csrf = await get(API_CSRF_ROUTE_PATH);
            assert.ok(
                typeof csrf.token === "string" && csrf.token.length > 0,
                "The backend must issue an actual CSRF token",
            );
            token = csrf.token;
        }
        return json(
            await fetchFn(`${origin}${route}`, {
                method,
                headers: buildApiCsrfHeaders(origin, token),
                body: JSON.stringify(body),
            }),
            "Apply operator input",
        );
    };
    return {
        get,
        post: (route, body = {}) => write("POST", route, body),
        put: (route, body = {}) => write("PUT", route, body),
    };
}
