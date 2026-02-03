import { pgTable, serial, text } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createAuditLogger } from "../../src/index.js";

const companyDocument = pgTable("company_document", {
  id: serial("id").primaryKey(),
  fileName: text("file_name"),
});

const schema = { companyDocument };

declare const db: PostgresJsDatabase<typeof schema>;

const auditLogger = createAuditLogger(db, { tables: ["company_document"] });

auditLogger.db.query.companyDocument.findFirst({
  columns: { fileName: true },
});
