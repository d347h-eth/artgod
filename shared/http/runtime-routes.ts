import routes from "./runtime-routes.json" with { type: "json" };

// Canonical route data also consumed by the Rust supervisor and readiness diagnostics.
export const RUNTIME_API_ROUTES = routes;
