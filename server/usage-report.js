// Opt-in, aggregate-only usage report written to the customer's own disk.
// Never sent anywhere. Counts per UTC day per name; no query text, no client info.
import fs from "node:fs";
import path from "node:path";

export function createUsageRecorder({ dataDir, now = () => new Date(), renameFile = fs.renameSync }) {
  // pending: { "YYYY-MM-DD": { name: n } }
  let pending = {};

  function record(name) {
    try {
      if (typeof name !== "string" || !(name.startsWith("tool:") || name.startsWith("doc:"))) return;
      const day = now().toISOString().slice(0, 10);
      const d = (pending[day] ||= {});
      d[name] = (d[name] || 0) + 1;
    } catch { /* never throws */ }
  }

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  function loadMonth(file) {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); } catch (err) {
      if (err.code === "ENOENT") return {};
      raw = null;
    }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (isPlainObject(parsed)) return parsed;
      } catch { /* corrupt */ }
    }
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const aside = file.replace(/\.json$/, `.corrupt-${stamp}.json`);
    fs.renameSync(file, aside);
    console.warn(`usage report: ${file} was corrupt; moved to ${aside} and started a fresh file`);
    return {};
  }

  function flush() {
    const days = Object.keys(pending);
    if (!days.length) return;
    const snapshot = pending;
    pending = {};
    const byMonth = {};
    for (const day of days) (byMonth[day.slice(0, 7)] ||= []).push(day);
    for (const [month, ds] of Object.entries(byMonth)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        const file = path.join(dataDir, `usage-${month}.json`);
        const data = loadMonth(file);
        for (const day of ds) {
          if (!isPlainObject(data[day])) data[day] = {};
          for (const [name, n] of Object.entries(snapshot[day])) {
            data[day][name] = (Number.isInteger(data[day][name]) ? data[day][name] : 0) + n;
          }
        }
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
        renameFile(tmp, file);
      } catch (err) {
        // re-queue only this month's counts so the next flush retries them
        for (const day of ds) {
          const t = (pending[day] ||= {});
          for (const [name, n] of Object.entries(snapshot[day])) t[name] = (t[name] || 0) + n;
        }
        console.warn(`usage report flush failed for ${month}: ${err.message}`);
      }
    }
  }

  return { record, flush };
}
