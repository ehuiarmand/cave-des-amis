function fmt(value) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(value) || 0));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function isoDateToDdMmYyyy(iso) {
  const s = String(iso ?? "").trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || "—");
}
