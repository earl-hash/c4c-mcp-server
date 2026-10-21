// Library version and staleness on every tool result (self-hosted edition). Opt-in: the
// Cloudflare Worker never passes library info, so withLibraryInfo(result, null) is a no-op
// and its output is unchanged.
const DAY_MS = 86_400_000;

export function libraryInfo(manifest, now = new Date(), staleDays = 14) {
  const built = Date.parse(manifest?.built_at ?? "");
  const age_days = Number.isFinite(built) ? Math.max(0, Math.floor((now.getTime() - built) / DAY_MS)) : 0;
  return { version: manifest?.version, built_at: manifest?.built_at, age_days, stale: age_days > staleDays };
}

export function staleNotice(info) {
  return `Library last updated ${String(info.built_at).slice(0, 10)}, ${info.age_days} days ago. Check your C4C update subscription.`;
}

const join = (a, b) => (typeof a === "string" && a ? `${a} ${b}` : b);

export function withLibraryInfo(result, info) {
  if (!info || !result || typeof result !== "object") return result;
  const out = { ...result };
  const sc = result.structuredContent;
  if (sc && typeof sc === "object" && !Array.isArray(sc)) {
    out.structuredContent = { ...sc, library: info };
    if (info.stale) out.structuredContent.notice = join(sc.notice, staleNotice(info));
  }
  if (info.stale && !result.isError) {
    const first = result.content?.[0];
    if (first?.type === "text" && typeof first.text === "string") {
      let text;
      try {
        const p = JSON.parse(first.text);
        if (p && typeof p === "object" && !Array.isArray(p)) {
          text = JSON.stringify({ ...p, notice: join(p.notice, staleNotice(info)) });
        }
      } catch { /* non-JSON text */ }
      if (text === undefined) text = `${first.text}\n${staleNotice(info)}`;
      out.content = [{ ...first, text }, ...result.content.slice(1)];
    }
  }
  return out;
}
