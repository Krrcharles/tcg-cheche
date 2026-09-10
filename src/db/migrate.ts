import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { z } from "zod";

async function main() {
  const url = z
    .url({ protocol: /^postgres(ql)?$/ })
    .safeParse(process.env.DATABASE_URL);
  if (!url.success) {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL.");
  }
  const pool = new pg.Pool({ connectionString: url.data });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "src/db/migrations" });
    console.info("Database migrations applied.");
  } finally {
    await pool.end();
  }
}

void main().catch(() => {
  console.error(
    "Database migration failed. Check DATABASE_URL, connectivity, and migration SQL.",
  );
  process.exitCode = 1;
});
