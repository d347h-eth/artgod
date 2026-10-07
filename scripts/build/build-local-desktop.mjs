#!/usr/bin/env node
import { buildLocalDesktop } from "./local-desktop-command.mjs";

await buildLocalDesktop(process.argv.slice(2));
