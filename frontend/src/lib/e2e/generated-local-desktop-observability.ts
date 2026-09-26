// Generated from the canonical manifest and local desktop selection.
// Run yarn config:generate:desktop-local; do not edit.
// Keep the object as JSON so the native schema parity test can read it.
// prettier-ignore
export const LOCAL_DESKTOP_OBSERVABILITY_SCHEMA = {
  "groups": [
    {
      "id": "backend-observability",
      "label": "Backend Observability",
      "fields": [
        {
          "key": "BACKEND_METRICS_ENABLED",
          "label": "backend metrics enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Enables the backend Prometheus metrics endpoint.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_METRICS_PORT",
          "label": "backend metrics port",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Port for the backend Prometheus metrics endpoint.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_APM_ENABLED",
          "label": "backend apm enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Enables backend tracing and profiling exporters.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_APM_SERVICE_NAMESPACE",
          "label": "backend apm service namespace",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Service namespace used to group backend APM signals.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_APM_OTLP_HTTP_URL",
          "label": "backend apm otlp http url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Optional backend-specific OTLP HTTP trace endpoint; blank uses the shared observability endpoint.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "BACKEND_APM_PYROSCOPE_URL",
          "label": "backend apm pyroscope url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Optional backend-specific Pyroscope profiling endpoint; blank uses the shared observability endpoint.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "BACKEND_APM_SPAN_PROFILES_ENABLED",
          "label": "backend apm span profiles enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Links backend span context to profiling samples when tracing and profiling are enabled.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_APM_TRACES_ENABLED",
          "label": "backend apm traces enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Exports backend traces to the configured OTLP endpoint when APM is enabled.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "BACKEND_APM_PROFILES_ENABLED",
          "label": "backend apm profiles enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Exports backend CPU profiles to the configured Pyroscope endpoint when APM is enabled.",
          "requiredForLaunch": false,
          "validation": null
        }
      ]
    },
    {
      "id": "indexer-observability",
      "label": "Indexer Observability",
      "fields": [
        {
          "key": "OBSERVABILITY_OTLP_HTTP_URL",
          "label": "observability otlp http url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Shared OTLP HTTP trace endpoint used when workspace-specific trace endpoints are blank.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "OBSERVABILITY_PYROSCOPE_URL",
          "label": "observability pyroscope url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Shared Pyroscope profiling endpoint used when workspace-specific profile endpoints are blank.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "INDEXER_APM_ENABLED",
          "label": "indexer apm enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Enables tracing and profiling exporters for indexer and OpenSea workers.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_APM_SERVICE_NAMESPACE",
          "label": "indexer apm service namespace",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Service namespace used to group indexer APM signals.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_APM_OTLP_HTTP_URL",
          "label": "indexer apm otlp http url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Optional indexer-specific OTLP HTTP trace endpoint; blank uses the shared observability endpoint.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "INDEXER_APM_PYROSCOPE_URL",
          "label": "indexer apm pyroscope url",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Optional indexer-specific Pyroscope profiling endpoint; blank uses the shared observability endpoint.",
          "requiredForLaunch": false,
          "validation": "url"
        },
        {
          "key": "INDEXER_APM_SPAN_PROFILES_ENABLED",
          "label": "indexer apm span profiles enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Links indexer span context to profiling samples when tracing and profiling are enabled.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_APM_TRACES_ENABLED",
          "label": "indexer apm traces enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Exports indexer traces to the configured OTLP endpoint when APM is enabled.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_APM_PROFILES_ENABLED",
          "label": "indexer apm profiles enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Exports indexer CPU profiles to the configured Pyroscope endpoint when APM is enabled.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_ENABLED",
          "label": "indexer metrics enabled",
          "inputKind": "checkbox",
          "secret": false,
          "options": [],
          "help": "Enables Prometheus metrics endpoints for indexer and OpenSea workers.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_SCHEDULER_WORKER",
          "label": "indexer metrics port scheduler worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the scheduler worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_SYNC_WORKER",
          "label": "indexer metrics port sync worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the sync worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_REORG_WORKER",
          "label": "indexer metrics port reorg worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the reorg worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_DOMAIN_WORKER",
          "label": "indexer metrics port domain worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the domain worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER",
          "label": "indexer metrics port offchain ingest worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the offchain ingest worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER",
          "label": "indexer metrics port opensea stream worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the OpenSea stream worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_BOOTSTRAP_WORKER",
          "label": "indexer metrics port bootstrap worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the collection bootstrap worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_DEAD_LETTER_WORKER",
          "label": "indexer metrics port dead letter worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the dead-letter worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
          "label": "indexer metrics port opensea bootstrap worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the OpenSea bootstrap worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
          "label": "indexer metrics port opensea reconcile worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the OpenSea reconcile worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
          "label": "indexer metrics port opensea reconcile scheduler worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the OpenSea reconcile scheduler worker.",
          "requiredForLaunch": false,
          "validation": null
        },
        {
          "key": "INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER",
          "label": "indexer metrics port collection extension worker",
          "inputKind": "text",
          "secret": false,
          "options": [],
          "help": "Prometheus metrics port for the collection-extension worker.",
          "requiredForLaunch": false,
          "validation": null
        }
      ]
    }
  ],
  "defaults": {
    "BACKEND_METRICS_ENABLED": "false",
    "BACKEND_METRICS_PORT": "42740",
    "BACKEND_APM_ENABLED": "false",
    "BACKEND_APM_SERVICE_NAMESPACE": "artgod.backend",
    "BACKEND_APM_OTLP_HTTP_URL": "",
    "BACKEND_APM_PYROSCOPE_URL": "",
    "BACKEND_APM_SPAN_PROFILES_ENABLED": "true",
    "BACKEND_APM_TRACES_ENABLED": "true",
    "BACKEND_APM_PROFILES_ENABLED": "true",
    "OBSERVABILITY_OTLP_HTTP_URL": "http://127.0.0.1:42732/v1/traces",
    "OBSERVABILITY_PYROSCOPE_URL": "http://127.0.0.1:42733",
    "INDEXER_APM_ENABLED": "false",
    "INDEXER_APM_SERVICE_NAMESPACE": "artgod.indexer",
    "INDEXER_APM_OTLP_HTTP_URL": "",
    "INDEXER_APM_PYROSCOPE_URL": "",
    "INDEXER_APM_SPAN_PROFILES_ENABLED": "true",
    "INDEXER_APM_TRACES_ENABLED": "true",
    "INDEXER_APM_PROFILES_ENABLED": "true",
    "INDEXER_METRICS_ENABLED": "false",
    "INDEXER_METRICS_PORT_SCHEDULER_WORKER": "42741",
    "INDEXER_METRICS_PORT_SYNC_WORKER": "42742",
    "INDEXER_METRICS_PORT_REORG_WORKER": "42743",
    "INDEXER_METRICS_PORT_DOMAIN_WORKER": "42744",
    "INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER": "42745",
    "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER": "42746",
    "INDEXER_METRICS_PORT_BOOTSTRAP_WORKER": "42747",
    "INDEXER_METRICS_PORT_DEAD_LETTER_WORKER": "42748",
    "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER": "42749",
    "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER": "42750",
    "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER": "42751",
    "INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER": "42752"
  }
} as const;
