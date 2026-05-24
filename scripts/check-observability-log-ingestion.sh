#!/usr/bin/env bash
set -euo pipefail

LOKI_URL="${ARTGOD_LOKI_URL:-http://127.0.0.1:42730}"
LOOKBACK="${ARTGOD_OBSERVABILITY_SMOKE_LOOKBACK:-15 minutes ago}"
START_NS="$(date -u -d "$LOOKBACK" +%s%N)"

check_query() {
  local label="$1"
  local query="$2"
  local response

  response="$(
    curl -fsG "$LOKI_URL/loki/api/v1/query_range" \
      --data-urlencode "query=$query" \
      --data-urlencode "start=$START_NS" \
      --data-urlencode "limit=1"
  )"

  if [[ "$response" != *'"result":[{'* ]]; then
    echo "Missing Loki log stream: $label" >&2
    echo "$response" >&2
    return 1
  fi

  echo "Found Loki log stream: $label"
}

check_query \
  "frontend SSR backend API responses" \
  '{app="artgod",runtime="frontend-web",component="FrontendSSR",action="backend_api_response"}'

check_query \
  "backend API query-cache responses" \
  '{app="artgod",runtime="backend-api",component="BackendApi",action="query_cache_response"}'
