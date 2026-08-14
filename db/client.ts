/**
 * Database Client
 *
 * Initializes better-sqlite3 connection with WAL mode
 */

import Database from 'better-sqlite3';
import path from 'path';

// Get database path from environment or use default
const dbPath = process.env.DATABASE_URL || 'file:./rooster.db';

// Extract file path (handle both file:// and file: formats)
let filePath = dbPath;
if (filePath.startsWith('file:')) {
  filePath = filePath.slice(5);
  // Remove leading slashes if it's a file: URI
  if (filePath.startsWith('//')) {
    filePath = filePath.slice(2);
  }
}

// Ensure absolute path
if (!path.isAbsolute(filePath)) {
  filePath = path.resolve(process.cwd(), filePath);
}

// Initialize database
const db = new Database(filePath);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Enable foreign keys
db.pragma('foreign_keys = ON');

export { db };
