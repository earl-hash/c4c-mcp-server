// Read-only node:sqlite stand-in for the Cloudflare D1 binding, so the unchanged Worker code
// (src/) runs on Node. Only the surface the tools use is implemented: prepare().bind().all()/first()/run().
// run() executes nothing: every Worker write is telemetry, and the shipped corpus holds no usage data.
// A statement binds to the handle current at prepare() time, so a swap() never disturbs
// requests already in flight; the old handle is closed after a grace period.
import { DatabaseSync } from "node:sqlite";

const GRACE_MS = 60_000;

function openHandle(path) {
  return { db: new DatabaseSync(path, { readOnly: true }), stmts: new Map() };
}

function statement(h, sql) {
  let s = h.stmts.get(sql);
  if (!s) { s = h.db.prepare(sql); h.stmts.set(sql, s); }
  return s;
}

export function openCorpus(path, { setTimeout: schedule = setTimeout } = {}) {
  let current = openHandle(path);
  const state = { path };
  return {
    get path() { return state.path; },
    env: {
      CORPUS: {
        prepare(sql) {
          const h = current;
          let args = [];
          const api = {
            bind(...a) { args = a; return api; },
            async all() { return { results: statement(h, sql).all(...args) }; },
            async first() { return statement(h, sql).get(...args) ?? null; },
            async run() { return { success: true }; },
          };
          return api;
        },
      },
    },
    swap(newPath) {
      const old = current;
      current = openHandle(newPath);
      state.path = newPath;
      const t = schedule(() => { try { old.db.close(); } catch { /* already closed */ } }, GRACE_MS);
      t?.unref?.();
    },
    close() {
      try { current.db.close(); } catch { /* already closed */ }
    },
  };
}
