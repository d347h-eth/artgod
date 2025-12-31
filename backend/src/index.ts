import { db } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";

async function main() {
  try {
    console.log('🚀 ArtGod Backend starting...');
    
    // Initialize database
    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();
    
    // Test database connection
    const result = db
      .prepare("SELECT datetime('now') as current_time")
      .get() as { current_time: string } | undefined;
    console.log('📊 Database connected:', result?.current_time ?? 'unknown');
    
    console.log('✅ Backend ready on port 3000');
    
    // Keep process running
    process.stdin.resume();
  } catch (error) {
    console.error('❌ Backend startup failed:', error);
    process.exit(1);
  }
}

main();
