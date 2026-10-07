#!/usr/bin/env bash
set -euo pipefail
mkdir -p /home/runner/result/evidence
exec > >(tee /home/runner/result/job.log) 2>&1
exec /usr/local/libexec/artgod-bootstrap-node /opt/artgod-reproduction/scripts/build/linux-release-reproduction/job.mjs
