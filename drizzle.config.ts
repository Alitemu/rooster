import type { Config } from 'drizzle-kit';

const dbUrl = process.env.DATABASE_URL || 'file:./rooster.db';

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  driver: 'better-sqlite',
  dbCredentials: {
    url: dbUrl,
  },
  tablesFilter: ['dienstrooster_*'],
} satisfies Config;
