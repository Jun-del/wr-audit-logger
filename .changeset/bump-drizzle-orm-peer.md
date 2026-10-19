---
"wr-audit-logger": patch
---

Require drizzle-orm `^0.45.2` as a peer dependency. Earlier 0.45.x releases have a SQL injection advisory for improperly escaped SQL identifiers.
