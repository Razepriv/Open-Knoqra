import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.MIGRATION_DATABASE_URL ?? 'postgres://knoqra:knoqra@localhost:54329/knoqra',
  },
});
