import { db } from "@artgod/shared/database";
import { ORDER_SOURCE_STATUS } from "../../domain/orders.js";

export class SqliteOrderSourceStateStore {
    private deactivateAllByContract = db.prepare<{
        chainId: number;
        source: string;
        contract: string;
        inactiveStatus: string;
        activeStatus: string;
    }>(
        "UPDATE orders SET " +
            "source_status = @inactiveStatus, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId " +
            "AND source = @source " +
            "AND contract_address = @contract " +
            "AND source_status = @activeStatus",
    );

    markMissingOrdersInactive(
        chainId: number,
        source: string,
        contract: string,
        activeOrderIds: Iterable<string>,
    ): number {
        const uniqueIds = Array.from(new Set(activeOrderIds));
        if (uniqueIds.length === 0) {
            const result = this.deactivateAllByContract.run({
                chainId,
                source,
                contract,
                inactiveStatus: ORDER_SOURCE_STATUS.Inactive,
                activeStatus: ORDER_SOURCE_STATUS.Active,
            });
            return result.changes;
        }

        const values: Record<string, string | number> = {
            chainId,
            source,
            contract,
            inactiveStatus: ORDER_SOURCE_STATUS.Inactive,
            activeStatus: ORDER_SOURCE_STATUS.Active,
        };
        const placeholders = uniqueIds.map((orderId, index) => {
            const key = `orderId${index}`;
            values[key] = orderId;
            return `@${key}`;
        });
        const sql =
            "UPDATE orders SET " +
            "source_status = @inactiveStatus, " +
            "updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId " +
            "AND source = @source " +
            "AND contract_address = @contract " +
            "AND source_status = @activeStatus " +
            `AND id NOT IN (${placeholders.join(", ")})`;
        return db.prepare(sql).run(values).changes;
    }
}
