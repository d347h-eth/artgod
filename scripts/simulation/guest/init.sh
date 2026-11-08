#!/bin/busybox sh
# PID 1 for the isolated replay guest. All service networking stays on loopback.
require_scenario_device() {
    case "${ARTGOD_SCENARIO_DEVICE-}" in
        /dev/vda|/dev/vdb) printf '%s\n' "$ARTGOD_SCENARIO_DEVICE" ;;
        *) printf 'ArtGod simulation requires explicit ARTGOD_SCENARIO_DEVICE=/dev/vda or /dev/vdb\n' >&2; return 1 ;;
    esac
}
# Safe host-side validation exercises the same guard without guest side effects.
if [ "${1-}" = '--check-scenario-device' ]; then
    require_scenario_device
    exit $?
fi
if [ "$$" -ne 1 ]; then
    printf 'ArtGod simulation init must run as guest PID 1\n' >&2
    exit 1
fi
export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox mount -t debugfs debugfs /sys/kernel/debug
exec </dev/console >/dev/console 2>&1
/bin/busybox mkdir -p /dev/pts /run /scenario /workbench/state/tmp /workbench/output
/bin/busybox mount -t devpts devpts /dev/pts
/bin/busybox ip link set lo up
export ARTGOD_WORKBENCH_ROOT=/workbench
export TMPDIR=/workbench/state/tmp
if ! scenario_device=$(require_scenario_device) || ! /bin/busybox mount -t ext4 -o ro "$scenario_device" /scenario; then
    printf 'ArtGod simulation requires its explicitly pinned read-only scenario disk\n'
    /bin/busybox sync
    /bin/busybox poweroff -f
    exit 1
fi
/usr/local/bin/node /workbench/guest/guest.mjs /scenario/scenario.json
guest_status=$?
if [ "$guest_status" -ne 0 ]; then
    printf 'ArtGod simulation guest exited with status %s\n' "$guest_status"
fi
/bin/busybox sync
/bin/busybox poweroff -f
exec /bin/busybox sleep 3600
