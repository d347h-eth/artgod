# Dedicated build verification. These official linux/amd64 manifests are reviewed
# inputs; the tag names are context and the digests select the consumed bytes.
# Ubuntu publication: https://hub.docker.com/v2/repositories/library/ubuntu/tags/jammy-20250819
# Node publication: https://hub.docker.com/v2/repositories/library/node/tags/24.3.0-bookworm-slim
ARG UBUNTU_IMAGE=ubuntu:jammy-20250819@sha256:d0afa9fbcf16134b776fbba4a04c31d476eece2d080c66c887fdd2608e4219a9
ARG NODE_BOOTSTRAP_IMAGE=node:24.3.0-bookworm-slim@sha256:abd2c9b915f8f9a5337c62659f654b1090d83598c6725a9e604b225b16f17f39
FROM ${NODE_BOOTSTRAP_IMAGE} AS node-bootstrap
FROM ${UBUNTU_IMAGE}
ARG UBUNTU_IMAGE
ARG NODE_BOOTSTRAP_IMAGE
ARG ARTGOD_REPRO_REVISION
# Conservative publication times round up the tag update, later than the
# selected architecture's upload. Reviewed 2026-10-07, more than 30 days old.
ENV ARTGOD_REPRO_UBUNTU_IMAGE=${UBUNTU_IMAGE} \
    ARTGOD_REPRO_NODE_BOOTSTRAP_IMAGE=${NODE_BOOTSTRAP_IMAGE} \
    ARTGOD_REPRO_UBUNTU_PUBLISHED_AT=2025-09-03T05:04:28Z \
    ARTGOD_REPRO_NODE_BOOTSTRAP_PUBLISHED_AT=2025-07-08T00:41:04Z \
    ARTGOD_RECIPE_REVISION=${ARTGOD_REPRO_REVISION} \
    CARGO_HOME=/home/runner/.cargo \
    CARGO_INCREMENTAL=0
LABEL org.opencontainers.image.revision=${ARTGOD_REPRO_REVISION}

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git build-essential pkg-config \
    libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    libfuse2 libssl-dev libxdo-dev patchelf squashfs-tools file xdg-utils \
    python3 make g++ xz-utils passwd \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash runner

# Copy only the bootstrap executable. The job acquires the canonical Node
# archive through ArtGod's verified input owner before running project builds.
COPY --from=node-bootstrap /usr/local/bin/node /usr/local/libexec/artgod-bootstrap-node
RUN /usr/local/libexec/artgod-bootstrap-node --version
COPY scripts/build/linux-release-reproduction /opt/artgod-reproduction/scripts/build/linux-release-reproduction
COPY scripts/build/secret-output-redaction.mjs /opt/artgod-reproduction/scripts/build/secret-output-redaction.mjs
USER runner
WORKDIR /home/runner
ENTRYPOINT ["bash", "/opt/artgod-reproduction/scripts/build/linux-release-reproduction/entrypoint.sh"]
