#!/usr/bin/env node
import {
    localDesktopBuildInvocation,
    runLocalBuildCommand,
} from "./local-desktop-command.mjs";

const invocation = localDesktopBuildInvocation(process.argv.slice(2));
await runLocalBuildCommand(invocation.command, invocation.args, {
    env: invocation.env,
});
