import {
    inspectOrderProcessing,
    parseOrderInspectionArgs,
} from "./order-processing-inspection.js";

const config = parseOrderInspectionArgs(process.argv.slice(2));
process.stdout.write(
    JSON.stringify(inspectOrderProcessing(config), null, 2) + "\n",
);
