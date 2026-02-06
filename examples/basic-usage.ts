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
  password: text("password"), // This will be excluded from audits
});

const vehicles = pgTable("vehicles", {
  id: serial("id").primaryKey(),
  make: varchar("make", { length: 100 }),
  model: varchar("model", { length: 100 }),
  year: serial("year"),
  status: varchar("status", { length: 50 }),
});

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL is not set");
  }

  // Connect to database
  const client = new Client(process.env.DATABASE_URL);
  await client.connect();
  const db = drizzle(client);

  // Create audit table (run once)
  await db.execute(createAuditTableSQL);
  console.log("✓ Audit table created");

  // Create audit logger
  const auditLogger = createAuditLogger(db, {
    tables: ["users", "vehicles"],
    excludeFields: ["password"],
    getUserId: () => "user-123", // In real app, get from auth context
    getMetadata: () => ({
      app: "my-app",
      version: "1.0.0",
    }),
  });

  const { db: auditedDb, setContext } = auditLogger;

  // Set context (e.g., from Express middleware)
  setContext({
    userId: "user-123",
    ipAddress: "192.168.1.1",
    userAgent: "Mozilla/5.0...",
  });

  console.log("\n--- INSERT Example ---");
  // Insert a user
  const [newUser] = await auditedDb
    .insert(users)
    .values({
      email: "john@example.com",
      name: "John Doe",
      password: "secret123", // Won't be logged
    })
    .returning();

  console.log("Created user:", newUser);
  console.log("✓ Audit log created automatically");

  console.log("\n--- UPDATE Example ---");
  // Update the user
  const [updatedUser] = await auditedDb
    .update(users)
    .set({ name: "John Smith" })
    .where(eq(users.id, newUser.id))
    .returning();

  console.log("Updated user:", updatedUser);
  console.log("✓ Audit log created with before/after values");

  console.log("\n--- DELETE Example ---");
  // Delete the user
  await auditedDb.delete(users).where(eq(users.id, newUser.id));

  console.log("Deleted user");
  console.log("✓ Audit log created automatically");

  console.log("\n--- With Context Example ---");
  // Run operation with specific context
  await auditLogger.withContext(
    {
      userId: "admin-456",
      metadata: { reason: "bulk import" },
    },
    async () => {
      const [vehicle] = await db
        .insert(vehicles)
        .values({
          make: "Toyota",
          model: "Camry",
          year: 2024,
          status: "active",
        })
        .returning();

      await auditLogger.logInsert("vehicles", vehicle);
      console.log("✓ Vehicle created and logged with admin context");
    },
  );

  // Query audit logs
  console.log("\n--- Querying Audit Logs ---");
  const auditLogs = await db.execute(`
    SELECT * FROM audit_logs 
    ORDER BY created_at DESC 
    LIMIT 5
  `);

  console.log("Recent audit logs:");
  console.log(JSON.stringify(auditLogs.rows, null, 2));

  await client.end();
}

main().catch(console.error);
