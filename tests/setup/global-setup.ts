import "@dotenvx/dotenvx/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { createAuditTableSQL } from "../../src/index.js";

export default async function globalSetup(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = new Client(dbUrl);
  await client.connect();
  const db = drizzle(client);

  await db.execute(createAuditTableSQL);

  await client.end();
}
