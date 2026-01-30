import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { createAuditLogger, createAuditTableSQL } from "../src/index.js";

// =======================
// Schema
// =======================
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
  role: varchar("role", { length: 50 }),
});

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL is not set");

  const client = new Client(dbUrl);
  await client.connect();
  const db = drizzle(client);

  // =======================
  // Setup
  // =======================
  await db.execute(createAuditTableSQL);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name TEXT,
      role VARCHAR(50)
    )
  `);

  // =====================================================
  // Helper: benchmark inserts
  // =====================================================
  async function benchmark({
    label,
    inserts,
    makeLogger,
  }: {
    label: string;
    inserts: number;
    makeLogger: () => ReturnType<typeof createAuditLogger>;
  }) {
    await db.execute(`TRUNCATE TABLE users RESTART IDENTITY CASCADE`);
    await db.execute(`TRUNCATE TABLE audit_logs RESTART IDENTITY CASCADE`);

    const auditLogger = makeLogger();
    auditLogger.setContext?.({ userId: "bench-user" });
    const auditedDb = auditLogger.db;

    const start = process.hrtime.bigint();

    for (let i = 0; i < inserts; i++) {
      await auditedDb.insert(users).values({
        email: `${label}_${i}@example.com`,
        name: `User ${i}`,
        role: "user",
      });
    }

    // Ensure all logs are flushed
    await auditLogger.shutdown?.();
    await auditLogger.flush?.();

    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    const opsPerSec = Math.round((inserts / ms) * 1000);

    const logs = await db.execute(`SELECT COUNT(*)::int AS count FROM audit_logs`);

    return {
      mode: label,
      inserts,
      ms: ms.toFixed(2),
      "ops/sec": opsPerSec,
      auditLogs: logs.rows[0].count,
    };
  }

  // =====================================================
  // Warmup (important for realistic numbers)
  // =====================================================
  await benchmark({
    label: "warmup",
    inserts: 50,
    makeLogger: () =>
      createAuditLogger(db, {
        tables: ["users"],
        batch: {
          batchSize: 50,
          flushInterval: 1000,
          waitForWrite: true,
        },
        getUserId: () => "bench-user",
      }),
  });

  // =====================================================
  // Real comparison
  // =====================================================
  const INSERTS = 500;

  const immediate = await benchmark({
    label: "immediate",
    inserts: INSERTS,
    makeLogger: () =>
      createAuditLogger(db, {
        tables: ["users"],
        getUserId: () => "bench-user",
      }),
  });

  const batch50 = await benchmark({
    label: "batch-50",
    inserts: INSERTS,
    makeLogger: () =>
      createAuditLogger(db, {
        tables: ["users"],
        batch: {
          batchSize: 50,
          flushInterval: 2000,
          waitForWrite: true, // apples-to-apples
        },
        getUserId: () => "bench-user",
      }),
  });

  const speedup = (Number(immediate.ms) / Number(batch50.ms)).toFixed(2);

  // =====================================================
  // Output (REAL numbers)
  // =====================================================
  console.log("\n⚖️  Real Performance Comparison");
  console.table([immediate, batch50]);
  console.log(`📈 Real speedup: ${speedup}x\n`);

  // =====================================================
  // Cleanup
  // =====================================================
  await db.execute("DROP TABLE IF EXISTS users CASCADE");
  await client.end();

  console.log("✅ Benchmark complete");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
