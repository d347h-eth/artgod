import { db } from '@artgod/shared/database';

async function main() {
  try {
    console.log('🚀 ArtGod Backend starting...');
    
    // Initialize database
    await db.initialize();
    
    // Test database connection
    const result = await db.query('SELECT NOW() as current_time');
    console.log('📊 Database connected:', result.rows[0].current_time);
    
    console.log('✅ Backend ready on port 3000');
    
    // Keep process running
    process.stdin.resume();
  } catch (error) {
    console.error('❌ Backend startup failed:', error);
    process.exit(1);
  }
}

main();