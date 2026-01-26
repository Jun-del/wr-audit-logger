import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditContext } from "../types/config.js";

/**
 * Manages audit context using AsyncLocalStorage
 * Allows tracking user context across async operations
 */
export class AuditContextManager {
  private storage = new AsyncLocalStorage<AuditContext>();

  /**
   * Set context for the current async context
   */
  setContext(context: AuditContext): void {
    this.storage.enterWith(context);
  }

  /**
   * Get the current audit context
   */
  getContext(): AuditContext | undefined {
    return this.storage.getStore();
  }

  /**
   * Run a function with a specific audit context
   */
  runWithContext<T>(context: AuditContext, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  /**
   * Merge new context with existing context
   */
  mergeContext(partial: Partial<AuditContext>): void {
    const current = this.getContext() || {};
    this.setContext({ ...current, ...partial });
  }
}
