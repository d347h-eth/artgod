#!/usr/bin/env bash
set -euo pipefail

# Only Bash, Docker and ordinary file utilities are needed on the host. Every
# build input, including this job's recipe, comes from the selected remote SHA.
if [ "$#" -ne 1 ] || [[ ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
    echo "Usage: reproduce-linux-release-docker.sh <published-full-commit-sha>" >&2
    exit 64
fi
revision="$1"
repository_url="https://github.com/d347h-eth/artgod.git"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
mkdir -p "$repo_root/tmp"
run_dir="$(mktemp -d "$repo_root/tmp/linux-release-reproduction.XXXXXXXX")"
container_id=""
printf 'Reproduction evidence: %s\n' "$run_dir"
printf '%s\n' "$revision" > "$run_dir/requested-revision.txt"

finish() {
    local status=$?
    local export_failed=0
    trap - EXIT INT TERM HUP
    set +e
    if [ -z "$container_id" ] && [ -f "$run_dir/container-id.txt" ]; then
        container_id="$(cat "$run_dir/container-id.txt")"
    fi
    if [ -n "$container_id" ] && [[ ! "$container_id" =~ ^[a-f0-9]{64}$ ]]; then
        echo "Invalid container ID; automatic collection is unavailable" >&2
        [ "$status" -ne 0 ] || status=125
        container_id=""
    fi
    if [ -n "$container_id" ]; then
        # Interruption or attachment failure can leave the job running. Stop
        # only this invocation's container before copying its settled files.
        running="$(docker inspect --format '{{.State.Running}}' "$container_id" 2>> "$run_dir/lifecycle.log")" || export_failed=1
        if [ "$running" = true ]; then
            docker stop --time 10 "$container_id" >> "$run_dir/lifecycle.log" 2>&1
            [ "$status" -ne 0 ] || status=125
        fi
        docker inspect --format '{{json .State}}' "$container_id" > "$run_dir/container-state.json" 2>> "$run_dir/lifecycle.log" || export_failed=1
        docker logs --timestamps "$container_id" > "$run_dir/container.log" 2>&1 || export_failed=1
        # docker cp without -a gives exported files to the invoking user.
        docker cp "$container_id:/home/runner/result/." "$run_dir/" >> "$run_dir/export.log" 2>&1 || export_failed=1
        if [ "$export_failed" -eq 0 ]; then
            docker rm "$container_id" >> "$run_dir/lifecycle.log" 2>&1 || export_failed=1
        fi
        if [ "$export_failed" -ne 0 ]; then
            printf 'Collection or cleanup failed; inspect retained job %s and %s\n' "$container_id" "$run_dir" >&2
            [ "$status" -ne 0 ] || status=125
        fi
    fi
    printf 'Reproduction exit status: %s; evidence: %s\n' "$status" "$run_dir"
    exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# A fresh image build records current provisioning. No host source, credentials,
# dependency/tool caches, mounts or local build context are supplied to Docker.
set +e
docker buildx build --platform linux/amd64 --pull --no-cache --load \
    --progress plain \
    --file scripts/build/linux-release-reproduction/Dockerfile \
    --build-arg "ARTGOD_REPRO_REVISION=$revision" \
    --iidfile "$run_dir/runner-image-id.txt" \
    --metadata-file "$run_dir/image-build-metadata.json" \
    "$repository_url#$revision" 2>&1 | tee "$run_dir/image-build.log"
build_statuses=("${PIPESTATUS[@]}")
set -e
[ "${build_statuses[0]}" -eq 0 ] || exit "${build_statuses[0]}"
[ "${build_statuses[1]}" -eq 0 ] || exit "${build_statuses[1]}"
runner_image="$(cat "$run_dir/runner-image-id.txt")"
[[ "$runner_image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Invalid runner image ID" >&2; exit 125; }

# The containment gates deliberately orphan children after hard parent death.
# Docker's init supplies normal signal forwarding and orphan reaping as PID 1.
docker create --platform linux/amd64 --init \
    --cidfile "$run_dir/container-id.txt" \
    --env "ARTGOD_REPRO_REPOSITORY=$repository_url" \
    --env "ARTGOD_REPRO_REVISION=$revision" \
    "$runner_image" > "$run_dir/create.log"
container_id="$(cat "$run_dir/container-id.txt")"
set +e
docker start --attach "$container_id"
attach_status=$?
set -e
[ "$attach_status" -eq 0 ] || exit "$attach_status"
job_status="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
[[ "$job_status" =~ ^[0-9]+$ ]] || { echo "Invalid container exit status" >&2; exit 125; }
exit "$job_status"
