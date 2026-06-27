// CSRF endpoint and token names shared by browser and CLI API clients.
export const API_CSRF_ROUTE_PATH = "/api/security/csrf";

// Cookie name used by the backend CSRF guard.
export const API_CSRF_COOKIE_NAME = "artgod_csrf";

// Header name used by mutating backend API requests.
export const API_CSRF_HEADER_NAME = "x-artgod-csrf";
