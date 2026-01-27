import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, serial, text, varchar } from "drizzle-orm/pg-core";
import { Client } from "pg";
import { createAuditLogger, createAuditTableSQL } from "../src/index.js";

// Define your schema
const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: text("name"),
  role: varchar("role", { length: 50 }),
  password: text("password"),
});

const vehicles = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  year: serial("year"),
  status: varchar("status", { length: 50 }),
  ownerId: serial("owner_id"),
});

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // Connect to database
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  const originalDb = drizzle(client);

  // Create audit table (run once)
  await originalDb.execute(createAuditTableSQL);
  console.log("✓ Audit table created");

  // Create audit logger - get the wrapped db instance
  const auditLogger = createAuditLogger(originalDb, {
    tables: ["users", "vehicles"],
    excludeFields: ["password"],
    getUserId: () => "user-123",
    getMetadata: () => ({
      app: "my-app",
      version: "2.0.0",
    }),
  });

  // Use the wrapped db instance - it automatically logs!
  const { db, setContext } = auditLogger;

  // Set context
  setContext({
    userId: "user-123",
    ipAddress: "192.168.1.1",
    userAgent: "Mozilla/5.0...",
  });

  console.log("\n--- AUTOMATIC INSERT ---");
  // Just do a normal insert - it's automatically audited!
  const [newUser] = await db
    .insert(users)
    .values({
      email: "alice@example.com",
      name: "Alice Johnson",
      role: "admin",
      password: "secret123", // This won't be in audit logs
    })
    .returning();

  console.log("Created user:", newUser);
  console.log("✓ Audit log created AUTOMATICALLY");

  console.log("\n--- AUTOMATIC UPDATE ---");
  // Update is automatically audited with before/after values
  const [updatedUser] = await db
    .update(users)
    .set({
      name: "Alice Smith",
      role: "superadmin",
    })
    .where(eq(users.id, newUser.id))
    .returning();

  console.log("Updated user:", updatedUser);
  console.log("✓ Audit log with before/after values created AUTOMATICALLY");

  console.log("\n--- AUTOMATIC DELETE ---");
  // Delete is also automatically audited
  await db.delete(users).where(eq(users.id, newUser.id));

  console.log("Deleted user");
  console.log("✓ Audit log created AUTOMATICALLY");

  console.log("\n--- AUTOMATIC TRANSACTION ---");
  // Transactions work seamlessly - all operations share transaction_id
  await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: "bob@example.com",
        name: "Bob Builder",
        role: "user",
      })
      .returning();

    const [vehicle] = await tx
      .insert(vehicles)
      .values({
        make: "Honda",
        model: "Civic",
        year: 2024,
        status: "active",
        ownerId: user.id,
      })
      .returning();

    console.log("Created user and vehicle in transaction");
    console.log("✓ Both operations logged with same transaction_id");
  });

  console.log("\n--- BULK OPERATIONS ---");
  // Bulk inserts are automatically tracked
  const newVehicles = await db
    .insert(vehicles)
    .values([
      { make: "Toyota", model: "Camry", year: 2024, status: "active" },
      { make: "Ford", model: "F-150", year: 2024, status: "active" },
      { make: "Tesla", model: "Model 3", year: 2024, status: "active" },
    ])
    .returning();

  console.log(`Created ${newVehicles.length} vehicles`);
  console.log("✓ Each vehicle logged automatically");

  console.log("\n--- WITH CONTEXT ---");
  // Use withContext for specific operations
  await auditLogger.withContext(
    {
      userId: "admin-999",
      metadata: { reason: "system_maintenance" },
    },
    async () => {
      await db.update(vehicles).set({ status: "maintenance" }).where(eq(vehicles.status, "active"));

      console.log("✓ Bulk update logged with admin context");
    },
  );

  console.log("\n--- QUERY AUDIT LOGS ---");
  const auditLogs = await originalDb.execute(`
    SELECT 
      id,
      user_id,
      action,
      table_name,
      record_id,
      changed_fields,
      transaction_id,
      created_at
    FROM audit_logs 
    ORDER BY created_at DESC 
    LIMIT 10
  `);

  console.log("\nRecent audit logs:");
  console.table(auditLogs.rows);

  // Show a specific audit log with full details
  if (auditLogs.rows.length > 0) {
    const detailLog = auditLogs.rows.find((log: any) => log.action === "UPDATE");
    if (detailLog) {
      console.log("\n--- Example UPDATE Audit Log ---");
      const fullLog = await originalDb.execute(`
        SELECT * FROM audit_logs WHERE id = ${detailLog.id}
      `);
      console.log(JSON.stringify(fullLog.rows[0], null, 2));
    }
  }

  await client.end();
  console.log("\n✅ Demo complete - all operations were automatically audited!");
}

main().catch(console.error);
