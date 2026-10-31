# Public compromised-CA certificate

`em-dv-tls-ca-g3b.der` is the public EM DV TLS CA - G3B certificate from
[Mozilla incident 2083449](https://bugzilla.mozilla.org/show_bug.cgi?id=2083449),
[attachment 9664066](https://bugzilla.mozilla.org/attachment.cgi?id=9664066).
The attachment's PEM certificate was converted to DER without changing its bytes.

SHA-256: `42c4accd12c4f59597925e1a08a7a90102608543809308d50ec427e118ba1493`.
This matches the fingerprint in Mozilla's original incident description.
It contains a public certificate only.

The native TLS regression requires explicit public-key distrust, including
before path building. This prevents a verifier downgrade from appearing safe
merely because this particular certificate lacks a trusted issuer or hostname.
