import { bootstrapTradingBot } from "./bot-runtime.js";
import {
    BIDDING_LOG_COMPONENT,
    biddingLog,
    toErrorLogFields,
} from "../utils/bidding-log.js";

void bootstrapTradingBot("bidding").catch((error) => {
    biddingLog.error("Trading bot startup failed", {
        ...toErrorLogFields(error),
        component: BIDDING_LOG_COMPONENT.BiddingBotRuntime,
        action: "startupFailed",
        botKind: "bidding",
    });
    process.exit(1);
});
