import { PGlite } from '@electric-sql/pglite';
import { resolveProjectPath } from '@artgod/shared/utils/paths';

export class Database {
  private static instance: Database;
  private db: PGlite;

  private constructor() {
    // Initialize pglite with persistent storage in shared database directory
    const dbPath = resolveProjectPath('database/artgod.db');
    this.db = new PGlite(dbPath);
  }

  public static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  public async query(sql: string, params?: any[]): Promise<any> {
    return await this.db.query(sql, params);
  }

  public async close(): Promise<void> {
    await this.db.close();
  }

  public async initialize(): Promise<void> {
    console.log('Database initialized with pglite');
    
    // Run migrations on initialization
    const { migrationRunner } = await import('./migrations.ts');
    await migrationRunner.runMigrations();
  }
}

export const db = Database.getInstance();
