"""Bloquer les ventes serveuse tant qu'elle n'est pas en service (créneau ou relais autorisé)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "app-orders.js"
HTML = ROOT / "index.html"

OLD_BLOCKED = """/** Module Ventes indisponible aujourd'hui (serveuse en repos). */
function serveuseVentesModuleBlocked(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  // Créneau actif (nuit après minuit), relais ou dernière vendeuse → pas un jour de repos.
  if (staffIsOnDutyNow(siteId)) return false;
  return serveuseIsRestDay(today(), siteId);
}"""

NEW_BLOCKED = """/** Module Ventes indisponible tant que la serveuse n'est pas en service. */
function serveuseVentesModuleBlocked(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  return !staffIsOnDutyNow(siteId);
}"""

OLD_BLOCKS_SALE = """/** Message si serveuse hors créneau ou jour de repos (gérant / admin : jamais bloqué). */
function serveusePlanningBlocksSale(saleDateStr, siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return null;
  const d = String(saleDateStr || "").slice(0, 10);
  const sid = siteId || currentSiteId();
  if (!sid || !/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return null;
  if (!teamHasPlanningOnDate(sid, d)) return null;
  if (staffIsOnDutyNow(sid)) return null;
  // Le relais de service prime sur le jour de repos : si la serveuse a pris le service, elle peut vendre.
  if (serveuseIsOnSalesRelay(sid)) return null;
  const label = formatDateDdMmYyyy(d);
  if (serveuseIsRestDay(d, sid)) {
    return `Jour de repos (${label}) : le module Ventes est indisponible. Consultez Planning → Mes horaires ou contactez votre gérante.`;
  }
  if (staffIsOnDutyNow(sid)) return null;
  const todayShifts = workShiftsForUserOnDate(sessionUser, sid, d);
  if (todayShifts.length) {
    const windows = todayShifts.map(formatShiftWindowLabel).join(", ");
    return `Hors période de service (${label}) : vos créneaux sont ${windows}. Revenez pendant votre service ou demandez à la gérante d'ajuster le planning.`;
  }
  return `Jour de repos (${label}) : vous ne pouvez pas vendre. Voyez votre gérante pour vous autoriser — elle pourra ajouter un créneau dans Planning → Équipe.`;
}"""

NEW_BLOCKS_SALE = """/** Message si serveuse hors service (gérant / admin : jamais bloqué). */
function serveusePlanningBlocksSale(saleDateStr, siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return null;
  const d = String(saleDateStr || "").slice(0, 10);
  const sid = siteId || currentSiteId();
  if (!sid || !/^\\d{4}-\\d{2}-\\d{2}$/.test(d)) return null;
  if (staffIsOnDutyNow(sid)) return null;

  const label = formatDateDdMmYyyy(d);
  const me = String(sessionUser || "").trim().toLowerCase();
  const onDuty = currentServeuseOnDuty(sid);

  if (onDuty && onDuty !== me) {
    return `${staffDisplayName(onDuty)} est en service — demandez à la gérante dans Planning (Mes horaires) pour être autorisée à vendre.`;
  }
  if (pendingServiceRelayRequest(sessionUser, sid)) {
    return "Demande en attente — la gérante doit valider dans Planning → Équipe avant que vous puissiez vendre.";
  }
  if (!teamHasPlanningOnDate(sid, d)) {
    return `Hors service (${label}) : demandez à la gérante l'autorisation de prendre le service (Planning → Mes horaires).`;
  }
  if (serveuseIsRestDay(d, sid)) {
    return `Jour de repos (${label}) : le module Ventes est indisponible. Consultez Planning → Mes horaires ou contactez votre gérante.`;
  }
  const todayShifts = workShiftsForUserOnDate(sessionUser, sid, d);
  if (todayShifts.length) {
    const windows = todayShifts.map(formatShiftWindowLabel).join(", ");
    return `Hors période de service (${label}) : vos créneaux sont ${windows}. Demandez à la gérante de vous autoriser ou revenez pendant votre créneau.`;
  }
  return `Hors service (${label}) : vous ne pouvez pas vendre. Demandez à la gérante dans Planning → Mes horaires.`;
}"""

OLD_SYNC = """  const msg = blocked ? serveusePlanningBlocksSale(journalSaleDateFromDom(), currentSiteId()) : "";
  if (restGate) {
    if (blocked && msg) {
      restGate.classList.remove("hidden");
      restGate.removeAttribute("hidden");
      restGate.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Jour de repos</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(msg)}</p>
      </div>`;"""

NEW_SYNC = """  const msg = blocked ? serveusePlanningBlocksSale(journalSaleDateFromDom(), currentSiteId()) : "";
  const restTitle = blocked && serveuseIsRestDay(today(), currentSiteId()) ? "Jour de repos" : "Hors service";
  if (restGate) {
    if (blocked && msg) {
      restGate.classList.remove("hidden");
      restGate.removeAttribute("hidden");
      restGate.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>${escapeHtml(restTitle)}</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(msg)}</p>
      </div>`;"""

t = JS.read_text(encoding="utf-8")
for name, old, new in [
    ("serveuseVentesModuleBlocked", OLD_BLOCKED, NEW_BLOCKED),
    ("serveusePlanningBlocksSale", OLD_BLOCKS_SALE, NEW_BLOCKS_SALE),
    ("syncServeuseVentesPageRestDay", OLD_SYNC, NEW_SYNC),
]:
    if old not in t:
        raise SystemExit(f"pattern not found: {name}")
    t = t.replace(old, new, 1)

JS.write_text(t, encoding="utf-8")

html = HTML.read_text(encoding="utf-8")
html = html.replace("app-orders.js?v=369", "app-orders.js?v=370")
HTML.write_text(html, encoding="utf-8")
print("patched app-orders.js + index.html")
