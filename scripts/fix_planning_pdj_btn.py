"""Planning serveuse : PDJ seulement en service, bouton « Commencer le service »."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "app-orders.js"
HTML = ROOT / "index.html"

HELPER_AFTER = """/** Vrai si la serveuse a un service ouvert non clôturé (date de travail courante). */
function serveuseHasOpenServiceToday(siteId = currentSiteId()) {
  const d = workingDate(siteId);
  return !!(d && dayBookFor(d, siteId) && !stockCheckForSiteDate(d, siteId));
}"""

HELPER_NEW = HELPER_AFTER + """

/** Bouton PDJ fin de service : uniquement si la serveuse est en service et la journée est ouverte. */
function serveuseShowPdjFinServiceBtn(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  if (!serveuseHasOpenServiceToday(siteId)) return false;
  return staffIsOnDutyNow(siteId);
}

function serveusePdjFinServiceBtnHtml(style = "margin-top:8px") {
  if (!serveuseShowPdjFinServiceBtn()) return "";
  return `<button type="button" class="btn btn-sm btn-primary" style="${style}" onclick="navigate('pdj')">Point du jour — Fin de service</button>`;
}"""

OLD_SHOW = """    if (showTakeServiceBtn) {
      const onDutyName = onDutyUser && onDutyUser !== meUser ? escapeHtml(staffDisplayName(onDutyUser)) : null;
      const title = onDutyName ? `${onDutyName} est en service` : "Service non démarré";
      const btnLabel = onDutyName ? "Demander à la gérante" : "Demander à démarrer";
      const _openSvc = serveuseHasOpenServiceToday();
      sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #e08a1e;padding:10px 12px;font-size:0.88rem">
        <strong>${title}</strong>
        <p style="margin:4px 0 8px;font-size:0.83rem;color:var(--muted)">La gérante doit autoriser la prise de service dans Planning → Équipe.</p>
        <button type="button" class="btn btn-sm btn-outline" id="take-service-btn">${btnLabel}</button>
        ${_openSvc ? `<button type="button" class="btn btn-sm btn-primary" style="margin-left:8px" onclick="navigate('pdj')">Point du jour — Fin de service</button>` : ""}
      </div>`;
      document.getElementById("take-service-btn")?.addEventListener("click", () => requestTakeService().catch(handleApiError));"""

NEW_SHOW = """    if (showTakeServiceBtn) {
      const onDutyName = onDutyUser && onDutyUser !== meUser ? escapeHtml(staffDisplayName(onDutyUser)) : null;
      const title = onDutyName ? `${onDutyName} est en service` : "Service non démarré";
      const hint = onDutyName
        ? "Commencez le service : la gérante validera dans Planning → Équipe."
        : "Commencez le service : la gérante doit autoriser dans Planning → Équipe.";
      sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #e08a1e;padding:10px 12px;font-size:0.88rem">
        <strong>${title}</strong>
        <p style="margin:4px 0 8px;font-size:0.83rem;color:var(--muted)">${hint}</p>
        <button type="button" class="btn btn-sm btn-outline" id="take-service-btn">Commencer le service</button>
      </div>`;
      document.getElementById("take-service-btn")?.addEventListener("click", () => requestTakeService().catch(handleApiError));"""

OLD_CANSELL_BRIDGE = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>Relais de service</strong> · entre la fin de nuit et ${escapeHtml(nextWin)} (ventes et encaissements autorisés)
        </div>`;"""

NEW_CANSELL_BRIDGE = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>Relais de service</strong> · entre la fin de nuit et ${escapeHtml(nextWin)} (ventes et encaissements autorisés)
          ${serveusePdjFinServiceBtnHtml("margin-left:8px")}
        </div>`;"""

OLD_CANSELL_RELAY = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>En service</strong> · ${escapeHtml(label)}
        </div>`;"""

NEW_CANSELL_RELAY = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>En service</strong> · ${escapeHtml(label)}
          ${serveusePdjFinServiceBtnHtml("margin-left:8px")}
        </div>`;"""

OLD_CANSELL_ACTIVE = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>En service maintenant</strong> · ${escapeHtml(win)}
        </div>`;"""

NEW_CANSELL_ACTIVE = """        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>En service maintenant</strong> · ${escapeHtml(win)}
          ${serveusePdjFinServiceBtnHtml("margin-left:8px")}
        </div>`;"""

OLD_REST = """    } else if (restToday) {
      const _openSvc = serveuseHasOpenServiceToday();
      sumEl.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Hors service</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(restToday)}</p>
        ${_openSvc ? `<button type="button" class="btn btn-sm btn-primary" style="margin-top:8px" onclick="navigate('pdj')">Point du jour — Fin de service</button>` : ""}
      </div>`;"""

NEW_REST = """    } else if (restToday) {
      sumEl.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Hors service</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(restToday)}</p>
        ${serveusePdjFinServiceBtnHtml()}
      </div>`;"""

OLD_CONFIRM = """  const msg = fromName
    ? `Demander à la gérante l'autorisation de remplacer ${fromName} ?`
    : "Demander à la gérante l'autorisation de démarrer le service ?";"""

NEW_CONFIRM = """  const msg = fromName
    ? `Commencer le service et remplacer ${fromName} ? La gérante devra valider dans Planning → Équipe.`
    : "Commencer le service ? La gérante devra valider dans Planning → Équipe.";"""

OLD_TOAST = '  showToast("Demande envoyée à la gérante.");'
NEW_TOAST = '  showToast("Demande envoyée — en attente de la gérante.");'

t = JS.read_text(encoding="utf-8")
replacements = [
    (HELPER_AFTER, HELPER_NEW),
    (OLD_SHOW, NEW_SHOW),
    (OLD_CANSELL_BRIDGE, NEW_CANSELL_BRIDGE),
    (OLD_CANSELL_RELAY, NEW_CANSELL_RELAY),
    (OLD_CANSELL_ACTIVE, NEW_CANSELL_ACTIVE),
    (OLD_REST, NEW_REST),
    (OLD_CONFIRM, NEW_CONFIRM),
    (OLD_TOAST, NEW_TOAST),
]
for old, new in replacements:
    if old not in t:
        raise SystemExit(f"pattern not found ({old[:60]}...)")
    t = t.replace(old, new, 1)

JS.write_text(t, encoding="utf-8")
html = HTML.read_text(encoding="utf-8").replace("app-orders.js?v=370", "app-orders.js?v=371")
HTML.write_text(html, encoding="utf-8")
print("ok")
