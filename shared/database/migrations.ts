import { readFileSync, readdirSync } from 'fs';
import { resolveProjectPath } from '@artgod/shared/utils/paths';
import { Database } from './db.ts';

export class MigrationRunner {
  private db: Database;

  constructor() {
    this.db = Database.getInstance();
  }

  async runMigrations(): Promise<void> {
    try {
      console.log('🔄 Running database migrations...');

      // Get all migration files
      const migrationFiles = this.getMigrationFiles();
      
      for (const file of migrationFiles) {
        await this.runMigration(file);
      }

      console.log('✅ All migrations completed successfully');
    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    }
  }

  private getMigrationFiles(): string[] {
    const migrationsDir = resolveProjectPath('database/migrations');
    return readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();
  }

  private async runMigration(filename: string): Promise<void> {
    const migrationName = filename.replace('.sql', '');
    
    // Check if migration already ran (handle case where migrations table doesn't exist yet)
    let alreadyExecuted = false;
    try {
      const result = await this.db.query(
        'SELECT id FROM migrations WHERE name = $1',
        [migrationName]
      );
      alreadyExecuted = result.rows.length > 0;
    } catch (error) {
      // If migrations table doesn't exist, assume migration hasn't run yet
      alreadyExecuted = false;
    }

    if (alreadyExecuted) {
      console.log(`⏭️  Skipping ${migrationName} (already executed)`);
      return;
    }

    console.log(`🔧 Running migration: ${migrationName}`);
    
    // Read and execute migration
    const migrationPath = resolveProjectPath(`database/migrations/${filename}`);
    const sql = readFileSync(migrationPath, 'utf8');
    
    // Split SQL into individual statements and execute them separately
    // PGlite doesn't support multiple commands in a prepared statement
    const statements = sql
      .split(';')
      .map(stmt => {
        // Remove comment lines and trim
        const lines = stmt.split('\n')
          .filter(line => !line.trim().startsWith('--') && line.trim().length > 0);
        return lines.join('\n').trim();
      })
      .filter(stmt => stmt.length > 0);
    
    for (const statement of statements) {
      if (statement.trim().length > 0) {
        await this.db.query(statement);
      }
    }
    
    console.log(`✅ Completed migration: ${migrationName}`);
  }
}

export const migrationRunner = new MigrationRunner();