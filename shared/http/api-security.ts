// CSRF endpoint and token names shared by browser and CLI API clients.
export const API_CSRF_ROUTE_PATH = "/api/security/csrf";

// Cookie name used by the backend CSRF guard.
export const API_CSRF_COOKIE_NAME = "artgod_csrf";

// Header name used by mutating backend API requests.
export const API_CSRF_HEADER_NAME = "x-artgod-csrf";

/** Explicit CSRF credentials for non-browser API clients, whose fetch has no cookie jar. */
export function buildApiCsrfHeaders(
    origin: string,
    token: string,
): Record<string, string> {
    return {
        "content-type": "application/json",
        cookie: `${API_CSRF_COOKIE_NAME}=${token}`,
        origin,
        [API_CSRF_HEADER_NAME]: token,
    };
}
