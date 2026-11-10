import * as filesystem from "node:fs/promises";
import { createHash } from "node:crypto";
import { NATIVE_CORE_CONTEXT_POLICY as POLICY } from "./native-failure-evidence.mjs";

export const NATIVE_KERNEL_HELPER_ASSET = Object.freeze({
    source: "scripts/simulation/guest/native-kernel-helper.mjs",
    guestPath: POLICY.dispatcher,
});
export const NATIVE_KERNEL_HELPER_CHECK = Object.freeze({
    Arguments: "--check-native-core-dispatch",
    Guest: "--check-native-core-guest",
});

/** Linux6.6.71 STATIC_USERMODEHELPER preserves the requested argv; its script
 * interpreter drops original argv0. Only this exact four-argument core request
 * may exec the fixed guest Node. No arbitrary kernel-command forwarding.
 */
export function nativeKernelHelperScript() {
    return `#!/bin/busybox sh
# Private replay-guest static kernel-helper dispatcher, not a host helper.
deny_dispatch() {
    printf 'ArtGod native core helper requires its fixed private replay guest request\\n' >&2
    exit 126
}
check_only=0
check_guest=0
case "\${1-}" in
    '${NATIVE_KERNEL_HELPER_CHECK.Arguments}') check_only=1; shift ;;
    '${NATIVE_KERNEL_HELPER_CHECK.Guest}') check_guest=1; shift ;;
esac
[ "$#" -eq 4 ] || deny_dispatch
[ "$1" = '${POLICY.coordinator}' ] || deny_dispatch
[ "$2" = '${POLICY.collectorArgument}' ] || deny_dispatch
case "$3" in ''|0*|*[!0-9]*) deny_dispatch ;; esac
[ "\${#3}" -le 10 ] && [ "$3" -ge 2 ] && [ "$3" -le 2147483647 ] || deny_dispatch
case "$4" in [1-9]|[1-5][0-9]|6[0-4]) ;; *) deny_dispatch ;; esac
# Host tests exercise the identical argument guard without executing any child.
[ "$check_only" -eq 1 ] && exit 0
[ -x /bin/busybox ] || deny_dispatch
init_exe=$(/bin/busybox readlink /proc/1/exe) || deny_dispatch
busybox_exe=$(/bin/busybox readlink -f /bin/busybox) || deny_dispatch
[ -n "$init_exe" ] && [ "$init_exe" = "$busybox_exe" ] || deny_dispatch
[ "$check_guest" -eq 1 ] && exit 0
exec '${POLICY.executable}' "$@"
`;
}

export const nativeKernelHelperBytes = () =>
    Buffer.from(nativeKernelHelperScript());

/** Fail before changing core policy when a full image lacks its exact helper. */
export async function assertNativeKernelHelper(io = filesystem) {
    const expected = nativeKernelHelperBytes();
    const metadata = await io.lstat(POLICY.dispatcher);
    if (
        !metadata.isFile() ||
        metadata.size !== expected.length ||
        !(metadata.mode & 0o111)
    )
        throw new Error(
            "The private guest requires its exact executable static kernel-helper dispatcher",
        );
    const actual = await io.readFile(POLICY.dispatcher);
    if (!actual.equals(expected))
        throw new Error(
            "Private guest static kernel-helper dispatcher bytes differ",
        );
    return {
        path: POLICY.dispatcher,
        sizeBytes: expected.length,
        sha256: createHash("sha256").update(actual).digest("hex"),
    };
}
