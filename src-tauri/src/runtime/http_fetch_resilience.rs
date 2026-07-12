use std::collections::HashMap;
use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::Serialize;
use serde::de::DeserializeOwned;

use super::env_keys::{
    COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS_ENV_KEY, COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS_ENV_KEY,
    COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS_ENV_KEY, COMMON_HTTP_FETCH_TIMEOUT_MS_ENV_KEY,
};

/// Typed timeout and retry policy for ordinary HTTP fetches in the desktop runtime.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HttpFetchResilienceConfig {
    request_timeout_ms: u64,
    retry_policy: HttpFetchRetryPolicy,
}

/// Bounded retry policy for retry-safe ordinary HTTP requests.
#[derive(Clone, Debug, PartialEq, Eq)]
struct HttpFetchRetryPolicy {
    max_attempts: u64,
    base_delay_ms: u64,
    max_delay_ms: u64,
}

/// Failure classes returned by the shared ordinary-HTTP client.
#[derive(Debug)]
pub(crate) enum HttpFetchError {
    Transport(reqwest::Error),
    Status(reqwest::Error),
    Decode(reqwest::Error),
    RetryDelay(String),
}

/// Reqwest adapter that applies the manifest-owned ordinary-HTTP resilience policy.
pub(crate) struct HttpFetchClient {
    client: Client,
    retry_policy: HttpFetchRetryPolicy,
}

impl HttpFetchResilienceConfig {
    /// Parses the manifest-materialized policy without introducing Rust-side defaults.
    pub(crate) fn from_process_env(values: &HashMap<String, String>) -> Result<Self, String> {
        Ok(Self {
            request_timeout_ms: parse_positive_u64(values, COMMON_HTTP_FETCH_TIMEOUT_MS_ENV_KEY)?,
            retry_policy: HttpFetchRetryPolicy {
                max_attempts: parse_positive_u64(
                    values,
                    COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS_ENV_KEY,
                )?,
                base_delay_ms: parse_positive_u64(
                    values,
                    COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS_ENV_KEY,
                )?,
                max_delay_ms: parse_positive_u64(
                    values,
                    COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS_ENV_KEY,
                )?,
            },
        })
    }

    #[cfg(test)]
    pub(crate) fn test_fixture() -> Self {
        Self {
            request_timeout_ms: 1_000,
            retry_policy: HttpFetchRetryPolicy {
                max_attempts: 3,
                base_delay_ms: 1,
                max_delay_ms: 4,
            },
        }
    }
}

impl HttpFetchClient {
    /// Builds a client whose timeout covers headers and complete response-body consumption.
    pub(crate) fn new(config: &HttpFetchResilienceConfig) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_millis(config.request_timeout_ms))
            .retry(reqwest::retry::never())
            .build()
            .map_err(|error| format!("Failed to create ordinary HTTP client: {error}"))?;
        Ok(Self {
            client,
            retry_policy: config.retry_policy.clone(),
        })
    }

    /// Fetches one retry-safe JSON resource through the shared timeout and retry policy.
    pub(crate) async fn get_json<T, Q>(&self, url: &str, query: &Q) -> Result<T, HttpFetchError>
    where
        T: DeserializeOwned,
        Q: Serialize + ?Sized,
    {
        let mut attempt = 1;
        loop {
            let response = match self.client.get(url).query(query).send().await {
                Ok(response) => response,
                Err(error) => {
                    if is_retryable_transport_error(&error)
                        && self.wait_for_next_attempt(attempt).await?
                    {
                        attempt += 1;
                        continue;
                    }
                    return Err(HttpFetchError::Transport(error));
                }
            };

            if is_retryable_status(response.status()) && self.wait_for_next_attempt(attempt).await?
            {
                attempt += 1;
                continue;
            }

            let response = response
                .error_for_status()
                .map_err(HttpFetchError::Status)?;
            match response.json::<T>().await {
                Ok(payload) => return Ok(payload),
                Err(error) => {
                    if is_retryable_transport_error(&error)
                        && self.wait_for_next_attempt(attempt).await?
                    {
                        attempt += 1;
                        continue;
                    }
                    return if is_retryable_transport_error(&error) {
                        Err(HttpFetchError::Transport(error))
                    } else {
                        Err(HttpFetchError::Decode(error))
                    };
                }
            }
        }
    }

    async fn wait_for_next_attempt(&self, attempt: u64) -> Result<bool, HttpFetchError> {
        if attempt >= self.retry_policy.max_attempts {
            return Ok(false);
        }
        let delay_ms = retry_delay_ms(attempt, &self.retry_policy);
        tauri::async_runtime::spawn_blocking(move || {
            std::thread::sleep(Duration::from_millis(delay_ms));
        })
        .await
        .map_err(|error| {
            HttpFetchError::RetryDelay(format!("Ordinary HTTP retry delay failed: {error}"))
        })?;
        Ok(true)
    }
}

fn parse_positive_u64(values: &HashMap<String, String>, key: &str) -> Result<u64, String> {
    let raw = values
        .get(key)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing required env key in desktop config: {key}"))?;
    let parsed = raw
        .parse::<u64>()
        .map_err(|error| format!("Invalid desktop config value for {key}: {error}"))?;
    if parsed == 0 {
        return Err(format!(
            "Invalid desktop config value for {key}: must be positive"
        ));
    }
    Ok(parsed)
}

fn is_retryable_transport_error(error: &reqwest::Error) -> bool {
    error.is_timeout() || error.is_connect() || error.is_request() || error.is_body()
}

fn is_retryable_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::REQUEST_TIMEOUT
            | StatusCode::TOO_EARLY
            | StatusCode::TOO_MANY_REQUESTS
            | StatusCode::INTERNAL_SERVER_ERROR
            | StatusCode::BAD_GATEWAY
            | StatusCode::SERVICE_UNAVAILABLE
            | StatusCode::GATEWAY_TIMEOUT
    )
}

fn retry_delay_ms(attempt: u64, policy: &HttpFetchRetryPolicy) -> u64 {
    let exponent = u32::try_from(attempt.saturating_sub(1)).unwrap_or(u32::MAX);
    policy
        .base_delay_ms
        .saturating_mul(2u64.saturating_pow(exponent))
        .min(policy.max_delay_ms)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    use super::*;

    const HTTP_OK_JSON: &str = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"value\":\"ok\"}";
    const HTTP_SERVICE_UNAVAILABLE: &str =
        "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    const HTTP_NOT_FOUND: &str =
        "HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";

    #[derive(Debug, serde::Deserialize)]
    struct TestPayload {
        value: String,
    }

    #[test]
    fn parses_manifest_materialized_http_fetch_policy() {
        let values = policy_values("1500", "4", "125", "900");

        let config = HttpFetchResilienceConfig::from_process_env(&values).unwrap();

        assert_eq!(config.request_timeout_ms, 1_500);
        assert_eq!(config.retry_policy.max_attempts, 4);
        assert_eq!(config.retry_policy.base_delay_ms, 125);
        assert_eq!(config.retry_policy.max_delay_ms, 900);
    }

    #[test]
    fn rejects_missing_or_non_positive_http_fetch_policy() {
        let missing = HashMap::new();
        assert!(HttpFetchResilienceConfig::from_process_env(&missing).is_err());

        let zero_timeout = policy_values("0", "3", "25", "100");
        assert!(HttpFetchResilienceConfig::from_process_env(&zero_timeout).is_err());

        let invalid_attempts = policy_values("1000", "many", "25", "100");
        assert!(HttpFetchResilienceConfig::from_process_env(&invalid_attempts).is_err());
    }

    #[test]
    fn retry_delay_uses_bounded_exponential_backoff() {
        let policy = HttpFetchRetryPolicy {
            max_attempts: 5,
            base_delay_ms: 100,
            max_delay_ms: 250,
        };

        assert_eq!(retry_delay_ms(1, &policy), 100);
        assert_eq!(retry_delay_ms(2, &policy), 200);
        assert_eq!(retry_delay_ms(3, &policy), 250);
        assert_eq!(retry_delay_ms(u64::MAX, &policy), 250);
    }

    #[test]
    fn retries_transport_and_retryable_status_before_success() {
        let server = TestHttpServer::start(vec![
            TestResponse::Close,
            TestResponse::Reply(HTTP_SERVICE_UNAVAILABLE),
            TestResponse::Reply(HTTP_OK_JSON),
        ]);
        let client = HttpFetchClient::new(&test_config(500, 3)).unwrap();

        let payload = tauri::async_runtime::block_on(
            client.get_json::<TestPayload, _>(&server.url, &[] as &[(&str, &str)]),
        )
        .unwrap();

        assert_eq!(payload.value, "ok");
        assert_eq!(server.request_count(), 3);
    }

    #[test]
    fn stops_after_configured_retryable_status_attempts() {
        let server = TestHttpServer::start(vec![
            TestResponse::Reply(HTTP_SERVICE_UNAVAILABLE),
            TestResponse::Reply(HTTP_SERVICE_UNAVAILABLE),
        ]);
        let client = HttpFetchClient::new(&test_config(500, 2)).unwrap();

        let error = tauri::async_runtime::block_on(
            client.get_json::<TestPayload, _>(&server.url, &[] as &[(&str, &str)]),
        )
        .unwrap_err();

        assert!(matches!(error, HttpFetchError::Status(_)));
        assert_eq!(server.request_count(), 2);
    }

    #[test]
    fn does_not_retry_non_retryable_status() {
        let server = TestHttpServer::start(vec![TestResponse::Reply(HTTP_NOT_FOUND)]);
        let client = HttpFetchClient::new(&test_config(500, 3)).unwrap();

        let error = tauri::async_runtime::block_on(
            client.get_json::<TestPayload, _>(&server.url, &[] as &[(&str, &str)]),
        )
        .unwrap_err();

        assert!(matches!(error, HttpFetchError::Status(_)));
        assert_eq!(server.request_count(), 1);
    }

    #[test]
    fn request_timeout_covers_stalled_json_response_body() {
        let server = TestHttpServer::start(vec![TestResponse::StallBody]);
        let client = HttpFetchClient::new(&test_config(100, 1)).unwrap();

        let error = tauri::async_runtime::block_on(
            client.get_json::<TestPayload, _>(&server.url, &[] as &[(&str, &str)]),
        )
        .unwrap_err();

        let HttpFetchError::Transport(error) = error else {
            panic!("stalled body should surface as a transport timeout");
        };
        assert!(error.is_timeout());
        assert_eq!(server.request_count(), 1);
    }

    fn policy_values(
        timeout_ms: &str,
        max_attempts: &str,
        base_delay_ms: &str,
        max_delay_ms: &str,
    ) -> HashMap<String, String> {
        HashMap::from([
            (
                COMMON_HTTP_FETCH_TIMEOUT_MS_ENV_KEY.to_owned(),
                timeout_ms.to_owned(),
            ),
            (
                COMMON_HTTP_FETCH_RETRY_MAX_ATTEMPTS_ENV_KEY.to_owned(),
                max_attempts.to_owned(),
            ),
            (
                COMMON_HTTP_FETCH_RETRY_BASE_DELAY_MS_ENV_KEY.to_owned(),
                base_delay_ms.to_owned(),
            ),
            (
                COMMON_HTTP_FETCH_RETRY_MAX_DELAY_MS_ENV_KEY.to_owned(),
                max_delay_ms.to_owned(),
            ),
        ])
    }

    fn test_config(request_timeout_ms: u64, max_attempts: u64) -> HttpFetchResilienceConfig {
        HttpFetchResilienceConfig {
            request_timeout_ms,
            retry_policy: HttpFetchRetryPolicy {
                max_attempts,
                base_delay_ms: 1,
                max_delay_ms: 1,
            },
        }
    }

    enum TestResponse {
        Close,
        Reply(&'static str),
        StallBody,
    }

    struct TestHttpServer {
        url: String,
        request_count: Arc<AtomicUsize>,
        stop: Arc<AtomicBool>,
        thread: Option<JoinHandle<()>>,
    }

    impl TestHttpServer {
        fn start(responses: Vec<TestResponse>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind test HTTP server");
            listener
                .set_nonblocking(true)
                .expect("set test HTTP server nonblocking");
            let address = listener.local_addr().expect("read test HTTP address");
            let request_count = Arc::new(AtomicUsize::new(0));
            let stop = Arc::new(AtomicBool::new(false));
            let thread_request_count = request_count.clone();
            let thread_stop = stop.clone();
            let thread = thread::spawn(move || {
                let mut responses = VecDeque::from(responses);
                while !thread_stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            thread_request_count.fetch_add(1, Ordering::SeqCst);
                            read_request(&mut stream);
                            match responses.pop_front() {
                                Some(TestResponse::Close) | None => {}
                                Some(TestResponse::Reply(response)) => {
                                    stream
                                        .write_all(response.as_bytes())
                                        .expect("write test HTTP response");
                                }
                                Some(TestResponse::StallBody) => {
                                    stream
                                        .write_all(
                                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"value\":",
                                        )
                                        .expect("write partial test HTTP body");
                                    thread::sleep(Duration::from_millis(300));
                                }
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(error) => panic!("test HTTP server failed: {error}"),
                    }
                }
            });
            Self {
                url: format!("http://{address}/catalog"),
                request_count,
                stop,
                thread: Some(thread),
            }
        }

        fn request_count(&self) -> usize {
            let deadline = Instant::now() + Duration::from_millis(200);
            loop {
                let count = self.request_count.load(Ordering::SeqCst);
                if count > 0 || Instant::now() >= deadline {
                    return count;
                }
                thread::sleep(Duration::from_millis(1));
            }
        }
    }

    impl Drop for TestHttpServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            if let Some(thread) = self.thread.take() {
                thread.join().expect("join test HTTP server");
            }
        }
    }

    fn read_request(stream: &mut TcpStream) {
        stream
            .set_read_timeout(Some(Duration::from_millis(200)))
            .expect("set test request read timeout");
        let mut request = [0u8; 4096];
        let _ = stream.read(&mut request);
    }
}
