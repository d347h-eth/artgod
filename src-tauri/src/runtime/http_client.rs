use reqwest::ClientBuilder;

/// One TLS policy for native HTTP consumers, independent of host CA updates.
/// The locked rustls-webpki verifier also rejects the compromised intermediate
/// keys, including certificates cross-signed by a surviving trusted root.
pub(crate) fn native_http_client_builder() -> Result<ClientBuilder, String> {
    let tls = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|error| format!("Failed to configure native HTTP TLS: {error}"))?
    .with_root_certificates(reviewed_tls_roots())
    .with_no_client_auth();
    Ok(reqwest::Client::builder().tls_backend_preconfigured(tls))
}

fn reviewed_tls_roots() -> rustls::RootCertStore {
    rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::client::danger::ServerCertVerifier;
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};

    #[test]
    fn native_tls_uses_the_reviewed_root_store_without_retired_roots() {
        let roots = reviewed_tls_roots();
        assert!(roots.len() > 100);
        for name in [
            "emSign ECC Root CA - G3",
            "AAA Certificate Services",
            "emSign Root CA - C1",
            "emSign ECC Root CA - C3",
        ] {
            assert!(
                !roots.roots.iter().any(|root| {
                    root.subject
                        .as_ref()
                        .windows(name.len())
                        .any(|part| part == name.as_bytes())
                }),
                "retired root is trusted: {name}"
            );
        }
        native_http_client_builder().unwrap().build().unwrap();
    }

    #[test]
    fn verifier_explicitly_distrusts_the_compromised_intermediate_key() {
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            std::sync::Arc::new(reviewed_tls_roots()),
            std::sync::Arc::new(rustls::crypto::ring::default_provider()),
        )
        .build()
        .unwrap();
        let certificate = CertificateDer::from(
            include_bytes!("../../tests/fixtures/emudhra/em-dv-tls-ca-g3b.der").as_slice(),
        );
        let error = verifier
            .verify_server_cert(
                &certificate,
                &[],
                &ServerName::try_from("example.com").unwrap(),
                &[],
                UnixTime::now(),
            )
            .unwrap_err();
        // This must be active key distrust, rather than an unrelated expiry,
        // hostname, usage or missing-issuer failure.
        assert!(format!("{error:?}").contains("CertDistrusted"), "{error:?}");
    }
}
