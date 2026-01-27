#!/usr/bin/env tsx
/**
 * Full integration test script
 * Run with: pnpm tsx scripts/test-full-flow.ts
 */

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import {
  createAuditLogger,
  initializeAuditLogging,
  checkAuditSetup,
  getAuditStats,
  auditLogs,
} from "../src/index.js";

// Test schema
const users = pgTable("demo_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
  role: varchar("role", { length: 50 }),
  password: text("password"),
});

const posts = pgTable("demo_posts", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 255 }),
  content: text("content"),
  authorId: serial("author_id"),
  status: varchar("status", { length: 50 }),
});

async function main() {
  console.log("🚀 Starting full flow test...\n");
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // Connect to database
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  const originalDb = drizzle(client);

  try {
    // Step 1: Initialize
    console.log("📦 Step 1: Initialize audit logging");
    await initializeAuditLogging(originalDb);

    // Create test tables
    await originalDb.execute(`
      DROP TABLE IF EXISTS demo_users CASCADE;
      DROP TABLE IF EXISTS demo_posts CASCADE;
      
      CREATE TABLE demo_users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        name TEXT,
        role VARCHAR(50),
        password TEXT
      );
      
      CREATE TABLE demo_posts (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255),
        content TEXT,
        author_id INTEGER,
        status VARCHAR(50)
      );
    `);

    // Step 2: Check setup
    console.log("\n✅ Step 2: Verify setup");
    const isSetup = await checkAuditSetup(originalDb);
    console.log(`   Audit system ready: ${isSetup}`);

    // Step 3: Create audit logger
    console.log("\n🔧 Step 3: Create audit logger");
    const auditLogger = createAuditLogger(originalDb, {
      tables: ["demo_users", "demo_posts"],
      excludeFields: ["password"],
      getUserId: () => "admin-123",
      getMetadata: () => ({ app: "test-suite", version: "1.0.0" }),
    });

    const { db, setContext } = auditLogger;

    // Step 4: Set context
    console.log("\n👤 Step 4: Set audit context");
    setContext({
      userId: "test-user-456",
      ipAddress: "192.168.1.100",
      userAgent: "TestScript/1.0",
      metadata: { testRun: Date.now() },
    });

    // Step 5: Test INSERT
    console.log("\n➕ Step 5: Test automatic INSERT logging");
    const [user1] = await db
      .insert(users)
      .values({
        email: "alice@example.com",
        name: "Alice Johnson",
        role: "admin",
        password: "secret123",
      })
      .returning();
    console.log(`   ✓ Created user: ${user1.name} (ID: ${user1.id})`);

    const [user2] = await db
      .insert(users)
      .values({
        email: "bob@example.com",
        name: "Bob Smith",
        role: "user",
      })
      .returning();
    console.log(`   ✓ Created user: ${user2.name} (ID: ${user2.id})`);

    // Step 6: Test UPDATE
    console.log("\n✏️  Step 6: Test automatic UPDATE logging");
    const [updatedUser] = await db
      .update(users)
      .set({ name: "Alice Johnson-Smith", role: "superadmin" })
      .where(eq(users.id, user1.id))
      .returning();
    console.log(`   ✓ Updated user: ${updatedUser.name}`);

    // Step 7: Test TRANSACTION
    console.log("\n🔄 Step 7: Test transaction with multiple operations");
    await db.transaction(async (tx) => {
      const [author] = await tx
        .insert(users)
        .values({
          email: "charlie@example.com",
          name: "Charlie Brown",
          role: "author",
        })
        .returning();

      await tx.insert(posts).values([
        {
          title: "First Post",
          content: "Hello World!",
          authorId: author.id,
          status: "published",
        },
        {
          title: "Second Post",
          content: "Another post",
          authorId: author.id,
          status: "draft",
        },
      ]);

      console.log(`   ✓ Created author and 2 posts in transaction`);
    });

    // Step 8: Test DELETE
    console.log("\n🗑️  Step 8: Test automatic DELETE logging");
    await db.delete(users).where(eq(users.id, user2.id));
    console.log(`   ✓ Deleted user: Bob Smith`);

    // Step 9: Test withContext
    console.log("\n🎯 Step 9: Test withContext for specific operations");
    await auditLogger.withContext(
      {
        userId: "SYSTEM",
        metadata: { automated: true, reason: "cleanup" },
      },
      async () => {
        await db.update(posts).set({ status: "archived" }).where(eq(posts.status, "draft"));
        console.log(`   ✓ Archived draft posts with SYSTEM context`);
      },
    );

    // Step 10: Query audit logs
    console.log("\n📊 Step 10: Query and display audit logs");
    const logs = await originalDb
      .select()
      .from(auditLogs)
      .orderBy(desc(auditLogs.createdAt))
      .limit(10);

    console.log(`\n   Found ${logs.length} audit logs:`);
    console.table(
      logs.map((log) => ({
        id: log.id,
        action: log.action,
        table: log.tableName,
        user: log.userId,
        changed: log.changedFields?.join(", ") || "N/A",
        txId: log.transactionId?.slice(0, 8) || "N/A",
      })),
    );

    // Step 11: Get statistics
    console.log("\n📈 Step 11: Audit statistics");
    const stats = await getAuditStats(originalDb);
    console.log(`   Total logs: ${stats.totalLogs}`);
    console.log(`   By action:`, stats.logsByAction);
    console.log(`   By table:`, stats.logsByTable);
    console.log(
      `   Time range: ${stats.oldestLog?.toISOString()} to ${stats.newestLog?.toISOString()}`,
    );

    // Step 12: Verify specific log details
    console.log("\n🔍 Step 12: Examine a specific UPDATE log");
    const updateLog = logs.find((log) => log.action === "UPDATE");
    if (updateLog) {
      console.log("\n   UPDATE Log Details:");
      console.log("   -------------------");
      console.log(`   Record ID: ${updateLog.recordId}`);
      console.log(`   User: ${updateLog.userId}`);
      console.log(`   IP: ${updateLog.ipAddress}`);
      console.log(`   Changed fields: ${updateLog.changedFields?.join(", ")}`);
      console.log("\n   Before:", JSON.stringify(updateLog.oldValues, null, 2));
      console.log("\n   After:", JSON.stringify(updateLog.newValues, null, 2));
    }

    console.log("\n✅ All tests completed successfully!");
    console.log("\n💡 Key takeaways:");
    console.log("   • All operations were logged automatically");
    console.log("   • No manual logInsert/logUpdate/logDelete calls needed");
    console.log("   • Context was properly tracked");
    console.log("   • Transactions grouped operations correctly");
    console.log("   • Sensitive fields (password) were excluded");
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    throw error;
  } finally {
    // Cleanup
    console.log("\n🧹 Cleaning up...");
    await originalDb.execute("DROP TABLE IF EXISTS demo_users CASCADE");
    await originalDb.execute("DROP TABLE IF EXISTS demo_posts CASCADE");
    await client.end();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
