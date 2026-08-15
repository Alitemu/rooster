import type { Config } from 'drizzle-kit';

// drizzle-kit's better-sqlite driver opens this path directly (no file:
// URI parsing like db/client.ts does), so strip the prefix here too.
let dbUrl = process.env.DATABASE_URL || 'file:./rooster.db';
if (dbUrl.startsWith('file:')) {
  dbUrl = dbUrl.slice(5);
}

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  driver: 'better-sqlite',
  dbCredentials: {
    url: dbUrl,
  },
  tablesFilter: ['dienstrooster_*'],
} satisfies Config;
