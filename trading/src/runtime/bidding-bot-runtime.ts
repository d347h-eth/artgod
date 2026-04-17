import { bootstrapTradingBot } from "./bot-runtime.js";

void bootstrapTradingBot("bidding").catch((error) => {
    const message =
        error instanceof Error && error.message.trim().length > 0
            ? error.message
            : "Trading bot startup failed";
    process.stderr.write(`${message}\n`);
    process.exit(1);
});
