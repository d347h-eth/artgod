#!/usr/bin/env node
import { devLocalDesktop } from "./local-desktop-command.mjs";

await devLocalDesktop(process.argv.slice(2));
