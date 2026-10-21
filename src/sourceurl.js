// The section's page on claudeforcompliance.com (Earl, 2026-10-08: link citations to our site).
// Every register has a page at /regs/<register_id>/ and every section an anchor equal to its
// obligation id after "<register_id>::" (an Update 18 version id "...::update-18" anchors to
// the same section). Always up, section-level, and shows the currency notices.
export const SITE = "https://claudeforcompliance.com";

export function pageUrl(register_id, obligation_id) {
  if (!register_id) return null;
  const anchor = obligation_id ? String(obligation_id).split("::")[1] : null;
  return `${SITE}/regs/${encodeURIComponent(register_id)}/${anchor ? `#${encodeURIComponent(anchor)}` : ""}`;
}

// Microsoft 365 Copilot renders a clickable citation only when the tool result carries a URL
// (plugin manifest response_semantics, 2026-10-08). get_obligation already returns
// source_url; lookup_citation and get_reg get the same field: the regulator's URL of the
// resolved section (else any section of the register -- they share the source document).
export async function sourceUrlOf(env, { obligation_id, register_id } = {}) {
  try {
    const row = obligation_id
      ? await env.CORPUS.prepare("SELECT source_url FROM obligations WHERE obligation_id = ?1 AND source_url <> ''")
        .bind(obligation_id).first()
      : null;
    if (row?.source_url) return row.source_url;
    if (!register_id) return null;
    const r = await env.CORPUS.prepare("SELECT source_url FROM obligations WHERE register_id = ?1 AND source_url <> '' LIMIT 1")
      .bind(register_id).first();
    return r?.source_url || null;
  } catch {
    return null;
  }
}

export async function withSourceUrl(env, result) {
  if (!result || typeof result !== "object" || !result.register_id) return result;
  const obligation_id = result.operative_obligation_id ?? result.obligation_id;
  const page_url = result.page_url ?? pageUrl(result.register_id, obligation_id);
  if (result.source_url) return { ...result, page_url };
  const url = await sourceUrlOf(env, { obligation_id, register_id: result.register_id });
  return { ...result, ...(url ? { source_url: url } : {}), page_url };
}

// verify_quote: the URL of the section the quote matched (matched_obligation_id).
export async function withMatchedSourceUrl(env, result) {
  if (!result || typeof result !== "object" || !result.matched_obligation_id) return result;
  const page_url = pageUrl(result.matched_register_id ?? String(result.matched_obligation_id).split("::")[0],
    result.matched_obligation_id);
  if (result.source_url) return { ...result, page_url };
  const url = await sourceUrlOf(env, { obligation_id: result.matched_obligation_id, register_id: result.matched_register_id });
  return { ...result, ...(url ? { source_url: url } : {}), page_url };
}
