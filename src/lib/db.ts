/**
 * Stub db.ts for screenshot-worker repo.
 *
 * The capture worker doesn't need database access — it runs the capture
 * pipeline and sends results back via HTTP callback. This stub exists
 * only to satisfy imports in capture modules that reference @/lib/db.
 *
 * If any capture function tries to use `db`, it will throw at runtime —
 * which is fine because the worker pipeline doesn't touch the database.
 */
export const db = new Proxy({}, {
  get() {
    throw new Error("db is not available in capture-worker mode");
  },
});
