import {
    X509Certificate,
    createPrivateKey,
    createPublicKey,
} from "node:crypto";
import {
    mkdir,
    readFile,
    readdir,
    realpath,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { assertWorktreeTemporaryPath } from "./artifacts.mjs";
import {
    assertImageReference,
    runOwnedContainer,
    CONTAINER_MOUNT_TARGET,
} from "./docker.mjs";
import { executeCommand } from "./qemu-replay.mjs";

export { assertImageReference as assertBuilderImageReference } from "./docker.mjs";

const CA_SUBJECT = "/CN=ArtGod Simulation CA";
export const GUEST_CERTIFICATE_HOSTS = Object.freeze([
    "api.opensea.io",
    "stream-api.opensea.io",
    "localhost",
]);
export const GUEST_CERTIFICATE_IP = "127.0.0.1";
export const GUEST_CERTIFICATE_VALIDITY = Object.freeze({
    start: "2020-01-01T00:00:00Z",
    end: "2040-01-01T00:00:00Z",
});

const configuration = `
[ca]
default_ca = simulation_ca
[simulation_ca]
dir = /certs
database = $dir/index.txt
new_certs_dir = $dir/issued
serial = $dir/serial
certificate = $dir/ca.pem
private_key = $dir/ca.key
default_md = sha256
default_days = 7305
policy = supplied_subject
unique_subject = no
copy_extensions = none
[supplied_subject]
commonName = supplied
[ca_extensions]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[server_extensions]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
subjectAltName = @server_names
[server_names]
${GUEST_CERTIFICATE_HOSTS.map((host, index) => `DNS.${index + 1} = ${host}`).join("\n")}
IP.1 = ${GUEST_CERTIFICATE_IP}
`;

function assertKeyMatches(certificate, key, label) {
    const expected = certificate.publicKey.export({
        format: "der",
        type: "spki",
    });
    const actual = createPublicKey(createPrivateKey(key)).export({
        format: "der",
        type: "spki",
    });
    if (!expected.equals(actual))
        throw new Error(`${label} certificate/key mismatch`);
}

/** Inspect actual outputs rather than trusting successful OpenSSL exit codes. */
export async function validateGuestCertificates(directory) {
    const files = Object.fromEntries(
        ["ca.pem", "ca.key", "server.pem", "server.key"].map((name) => [
            name,
            path.join(directory, name),
        ]),
    );
    const [caBytes, caKey, serverBytes, serverKey] = await Promise.all(
        Object.values(files).map((filename) => readFile(filename)),
    );
    const ca = new X509Certificate(caBytes);
    const server = new X509Certificate(serverBytes);
    if (
        !ca.ca ||
        server.ca ||
        !ca.verify(ca.publicKey) ||
        !server.checkIssued(ca) ||
        !server.verify(ca.publicKey)
    )
        throw new Error("Synthetic certificate chain is invalid");
    for (const certificate of [ca, server]) {
        if (
            new Date(certificate.validFrom).toISOString() !==
                new Date(GUEST_CERTIFICATE_VALIDITY.start).toISOString() ||
            new Date(certificate.validTo).toISOString() !==
                new Date(GUEST_CERTIFICATE_VALIDITY.end).toISOString()
        )
            throw new Error(
                "Synthetic certificate validity differs from the fixed guest interval",
            );
    }
    for (const hostname of GUEST_CERTIFICATE_HOSTS)
        if (server.checkHost(hostname) !== hostname)
            throw new Error(
                `Missing synthetic certificate hostname ${hostname}`,
            );
    if (
        server.checkIP(GUEST_CERTIFICATE_IP) !== GUEST_CERTIFICATE_IP ||
        !server.keyUsage?.includes("1.3.6.1.5.5.7.3.1")
    )
        throw new Error(
            "Synthetic server certificate lacks its IP or TLS server usage",
        );
    assertKeyMatches(ca, caKey, "CA");
    assertKeyMatches(server, serverKey, "Server");
    for (const filename of [files["ca.key"], files["server.key"]])
        if ((await stat(filename)).mode & 0o077)
            throw new Error("Synthetic private keys must be owner-only");
    return {
        ca: files["ca.pem"],
        certificate: files["server.pem"],
        key: files["server.key"],
        validity: GUEST_CERTIFICATE_VALIDITY,
        hosts: GUEST_CERTIFICATE_HOSTS,
    };
}

/** Synthetic trust is confined to a fresh guest directory, never host trust stores. */
export async function prepareGuestCertificates({
    builderImage,
    directory,
    execute = executeCommand,
}) {
    assertImageReference(builderImage);
    if (typeof execute !== "function")
        throw new Error("An explicit container command executor is required");
    if (
        typeof directory !== "string" ||
        !directory ||
        /[,\x00-\x1f]/.test(directory)
    )
        throw new Error(
            "Certificate directory must be an explicit Docker-mount-safe path",
        );
    const actual = await realpath(await assertWorktreeTemporaryPath(directory));
    if (!(await stat(actual)).isDirectory())
        throw new Error(
            "Certificates must stay inside the active worktree tmp directory",
        );
    if ((await readdir(actual)).length)
        throw new Error("Certificate directory must be fresh and empty");
    const dockerArtifacts = [];
    const openssl = async (args) => {
        const result = await runOwnedContainer({
            image: builderImage,
            command: ["openssl", ...args],
            execute,
            mounts: [
                {
                    source: actual,
                    target: CONTAINER_MOUNT_TARGET.Certificates,
                    readOnly: false,
                },
            ],
            workdir: CONTAINER_MOUNT_TARGET.Certificates,
            timeoutMs: 30_000,
        });
        dockerArtifacts.push(result.dockerArtifacts);
        return result;
    };
    await mkdir(path.join(actual, "issued"));
    await writeFile(path.join(actual, "ca.cnf"), configuration);
    await writeFile(path.join(actual, "index.txt"), "");
    await writeFile(path.join(actual, "serial"), "1000\n");
    await openssl([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        "ca.key",
    ]);
    await openssl([
        "req",
        "-new",
        "-key",
        "ca.key",
        "-subj",
        CA_SUBJECT,
        "-out",
        "ca.csr",
    ]);
    // A bootstrap certificate only supplies OpenSSL ca's signer identity. The
    // final self-signed CA and leaf both use explicit dates, independent of host time.
    await openssl([
        "req",
        "-new",
        "-x509",
        "-key",
        "ca.key",
        "-subj",
        CA_SUBJECT,
        "-days",
        "1",
        "-addext",
        "subjectKeyIdentifier=hash",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-out",
        "bootstrap.pem",
    ]);
    const dates = [
        "-startdate",
        GUEST_CERTIFICATE_VALIDITY.start.replace(/[-:T]/g, ""),
        "-enddate",
        GUEST_CERTIFICATE_VALIDITY.end.replace(/[-:T]/g, ""),
    ];
    await openssl([
        "ca",
        "-batch",
        "-selfsign",
        "-config",
        "ca.cnf",
        "-cert",
        "bootstrap.pem",
        "-in",
        "ca.csr",
        "-out",
        "ca.pem",
        "-notext",
        "-extensions",
        "ca_extensions",
        ...dates,
    ]);
    await openssl([
        "genpkey",
        "-algorithm",
        "EC",
        "-pkeyopt",
        "ec_paramgen_curve:P-256",
        "-out",
        "server.key",
    ]);
    await openssl([
        "req",
        "-new",
        "-key",
        "server.key",
        "-subj",
        `/CN=${GUEST_CERTIFICATE_HOSTS[0]}`,
        "-out",
        "server.csr",
    ]);
    await openssl([
        "ca",
        "-batch",
        "-config",
        "ca.cnf",
        "-in",
        "server.csr",
        "-out",
        "server.pem",
        "-notext",
        "-extensions",
        "server_extensions",
        ...dates,
    ]);
    return { ...(await validateGuestCertificates(actual)), dockerArtifacts };
}
