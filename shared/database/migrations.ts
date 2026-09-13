import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { db } from "./db.js";

export class MigrationRunner {
    constructor(private migrationsDir: string) {}

    async runMigrations(): Promise<void> {
        await this.ensureMigrationsTable();
        const files = await this.getMigrationFiles();
        for (const file of files) {
            const name = path.basename(file);
            // Avoid taking the global writer lock for migrations already applied.
            if (this.hasRun(name)) continue;
            await this.runSingle(file, name);
        }
    }

    private async ensureMigrationsTable() {
        db.prepare<[]>(
            "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, executed_at TEXT DEFAULT CURRENT_TIMESTAMP)",
        ).run();
    }

    private async getMigrationFiles(): Promise<string[]> {
        try {
            const entries = await fs.readdir(this.migrationsDir);
            return entries
                .filter((f) => f.endsWith(".sql"))
                .sort()
                .map((f) => path.join(this.migrationsDir, f));
        } catch (e: any) {
            if (e && e.code === "ENOENT") return [];
            throw e;
        }
    }

    private hasRun(name: string): boolean {
        const stmt = db.prepare<[string]>(
            "SELECT 1 FROM migrations WHERE name = ? LIMIT 1",
        );
        const row = stmt.get(name) as any;
        return !!row;
    }

    private async runSingle(filePath: string, name: string) {
        const sql = await fs.readFile(filePath, "utf8");
        // Recheck under the write lock so concurrent runtime startups stay idempotent.
        const applyMigration = db.writeTransaction(() => {
            if (this.hasRun(name)) {
                return false;
            }
            db.exec(sql);
            const insert = db.prepare<[string]>(
                "INSERT INTO migrations (name) VALUES (?)",
            );
            insert.run(name);
            return true;
        });
        if (applyMigration()) {
            process.stdout.write(`Applied migration: ${name}\n`);
        }
    }
}

export function createMigrationRunner(): MigrationRunner {
    const dir = resolveProjectPath("database/migrations");
    return new MigrationRunner(dir);
}
