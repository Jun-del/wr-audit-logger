---
"wr-audit-logger": minor
---

Support drizzle-orm 1.x (`^1.0.0-rc.4`) alongside 0.45. On 1.x, table names and columns are type-checked against the tables in `relations`. `createAuditLogger` now infers types from the database instance, and its returned `db` has the same type as the one passed in.
