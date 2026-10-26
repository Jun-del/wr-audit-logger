---
"wr-audit-logger": minor
---

Fix package exports so CommonJS consumers get CommonJS types. `require` now resolves `dist/index.d.cts` and `import` resolves `dist/index.d.mts`; previously both used the ESM declarations, which TypeScript flagged as "masquerading as ESM" under `node16`/`nodenext` resolution. `wr-audit-logger/package.json` is now exported.

Remove the optional `pg` peer dependency. The library never imports `pg`; install whichever Postgres driver your drizzle setup uses.

**Breaking:** the default export is removed. Use the named export instead:

```ts
// before
import createAuditLogger from "wr-audit-logger";
// after
import { createAuditLogger } from "wr-audit-logger";
```
