import { db } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";

async function main() {
  try {
    logger.info("Backend starting", {
      component: "Backend",
      action: "main",
    });
    
    // Initialize database
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();
    
    // Test database connection
    const result = db
      .prepare("SELECT datetime('now') as current_time")
      .get() as { current_time: string } | undefined;
    logger.info("Database connected", {
      component: "Backend",
      action: "main",
      currentTime: result?.current_time ?? "unknown",
    });
    
    logger.info("Backend ready", {
      component: "Backend",
      action: "main",
      port: 3000,
    });
    
    // Keep process running
    process.stdin.resume();
  } catch (error) {
    logger.error("Backend startup failed", {
      component: "Backend",
      action: "main",
      error: String(error),
    });
    process.exit(1);
  }
}

main();
