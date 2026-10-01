use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase", deny_unknown_fields)]
pub(crate) struct RuntimeApiRoutes {
    pub default_chain: String,
    pub health: String,
}

/// Shared with the backend route registration and WebView probe, without a parallel path literal.
pub(crate) fn runtime_api_routes() -> &'static RuntimeApiRoutes {
    static ROUTES: OnceLock<RuntimeApiRoutes> = OnceLock::new();
    ROUTES.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/http/runtime-routes.json"))
            .expect("checked-in runtime routes must match the native HTTP contract")
    })
}
