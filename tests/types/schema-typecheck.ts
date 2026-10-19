import { pgTable, serial, text } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAuditLogger } from "../../src/index.js";

const companyDocument = pgTable("company_document", {
  id: serial("id").primaryKey(),
  fileName: text("file_name"),
});

const schema = { companyDocument };

declare const db: PostgresJsDatabase<typeof schema>;

const auditLogger = createAuditLogger(db, {
  tables: { company_document: { primaryKey: "id" } },
  fields: { company_document: ["id", "fileName"] },
});

auditLogger.db.query.companyDocument.findFirst({
  columns: { fileName: true },
});

// @ts-expect-error invalid table name
createAuditLogger(db, { tables: { users: { primaryKey: "id" } } });

createAuditLogger(db, {
  tables: { company_document: { primaryKey: "id" } },
  // @ts-expect-error invalid field name
  fields: { company_document: ["nope"] },
});

createAuditLogger(db, {
  tables: {
    // @ts-expect-error invalid primary key column for table
    company_document: { primaryKey: "nope" },
  },
});

createAuditLogger(db, {
  tables: {
    company_document: { primaryKey: "id" },
    // @ts-expect-error invalid table name for tables config
    users: { primaryKey: "id" },
  },
});

// @ts-expect-error invalid table name for logInsert
auditLogger.logInsert("users", { id: 1 });

// @ts-expect-error invalid field for logInsert
auditLogger.logInsert("company_document", { nope: 1 });

// No schema: any table name is accepted
declare const untypedDb: PostgresJsDatabase;
createAuditLogger(untypedDb, { tables: { users: { primaryKey: "id" } } });
