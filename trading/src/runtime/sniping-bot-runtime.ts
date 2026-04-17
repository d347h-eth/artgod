import { bootstrapTradingBot } from "./bot-runtime.js";

void bootstrapTradingBot("sniping").catch((error) => {
    const message =
        error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Trading bot startup failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
