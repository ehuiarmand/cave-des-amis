"""Ajouter article : même UI que saisie rapide (cartes + panier)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "app-orders.js"
HTML = ROOT / "index.html"

HELPER = """
function openSaisieRapideModal({
  order = null,
  title = "Saisie rapide",
  submitLabel = "Valider la commande",
  clientReadonly = false,
  focusElId = "sr-client",
} = {}) {
  const ctx = document.getElementById("sr-order-context-wrap");
  if (ctx) ctx.classList.remove("hidden");
  const titleEl = document.getElementById("sr-modal-title");
  if (titleEl) titleEl.textContent = title;
  const srDate = document.getElementById("sr-date");
  if (srDate) srDate.value = order?.date || pdjCalendarDate();
  const srClient = document.getElementById("sr-client");
  if (srClient) {
    srClient.value = order?.client || "";
    srClient.readOnly = Boolean(clientReadonly);
    srClient.style.opacity = clientReadonly ? "0.85" : "";
  }
  const srOrderSel = document.getElementById("sr-order-select");
  if (srOrderSel) srOrderSel.value = order ? String(order.id) : "";
  const srNote = document.getElementById("sr-note");
  if (srNote) srNote.value = order?.note || "";
  const srLoc = document.getElementById("sr-location");
  const orderLoc = order?.lignes?.[0]?.location;
  if (srLoc) srLoc.value = orderLoc || "Intérieur";
  srCart = [];
  const searchEl = document.getElementById("sr-search");
  if (searchEl) searchEl.value = "";
  const submitBtn = document.getElementById("sr-submit-btn");
  if (submitBtn) {
    submitBtn.textContent = submitLabel;
    submitBtn.disabled = false;
  }
  renderSrMenu("");
  renderSrCart();
  openModal("modal-saisie-rapide");
  window.requestAnimationFrame(() => document.getElementById(focusElId)?.focus());
}

"""

ANCHOR = "function openOrderEditor(orderId = null) {"

OLD_OPEN = """function openOrderEditor(orderId = null) {
  syncDualZonePricingUi();
  activeOrderId = orderId;
  const order = orderId ? recordsForSite(state.commandes).find((item) => item.id === orderId) : null;
  populateOrderSelect();
  // Sans commande cible : saisie rapide (panier multi-articles)
  if (!orderId) {
    const ctx = document.getElementById("sr-order-context-wrap");
    if (ctx) ctx.classList.remove("hidden");
    const titleEl = document.getElementById("sr-modal-title");
    if (titleEl) titleEl.textContent = "Saisie rapide";
    const srDate = document.getElementById("sr-date");
    if (srDate) srDate.value = pdjCalendarDate();
    const srClient = document.getElementById("sr-client");
    if (srClient) srClient.value = "";
    const srOrderSel = document.getElementById("sr-order-select");
    if (srOrderSel) srOrderSel.value = "";
    const srNote = document.getElementById("sr-note");
    if (srNote) srNote.value = "";
    srCart = [];
    const searchEl = document.getElementById("sr-search");
    if (searchEl) searchEl.value = "";
    renderSrMenu("");
    renderSrCart();
    openModal("modal-saisie-rapide");
    window.requestAnimationFrame(() => document.getElementById("sr-client")?.focus());
    return;
  }
  if (orderId && !order) {
    showToast("Commande introuvable.");
    activeOrderId = null;
    populateOrderSelect();
    return;
  }
  // Commande existante : ajout de ligne — formulaire vente (recherche catalogue)
  document.getElementById("v-date").value = order?.date || pdjCalendarDate();
  document.getElementById("v-client").value = order?.client || "";
  document.getElementById("v-order-select").value = order ? String(order.id) : "";
  document.getElementById("v-article").value = "";
  document.getElementById("v-location").value = "Intérieur";
  populateSaleFormatSelect(null);
  document.getElementById("v-prix").value = "";
  document.getElementById("v-qty").value = "1";
  document.getElementById("v-remise").value = "0";
  document.getElementById("v-note").value = order?.note || "";
  document.getElementById("save-vente-btn").textContent = "Ajouter un article";
  syncFinalizeButtonJournalState();
  updateKitInfo(null);
  updateVentePreview();
  const vSearch = document.getElementById("v-article-search");
  if (vSearch) vSearch.value = "";
  renderVenteArticlePicker();
  syncLoyaltyClientHint();
  openModal("modal-vente");
  window.requestAnimationFrame(() => document.getElementById("v-article-search")?.focus());
}"""

NEW_OPEN = """function openOrderEditor(orderId = null) {
  syncDualZonePricingUi();
  activeOrderId = orderId;
  const order = orderId ? recordsForSite(state.commandes).find((item) => item.id === orderId) : null;
  populateOrderSelect();
  if (orderId && !order) {
    showToast("Commande introuvable.");
    activeOrderId = null;
    populateOrderSelect();
    return;
  }
  if (!orderId) {
    openSaisieRapideModal({ title: "Saisie rapide", focusElId: "sr-client" });
    return;
  }
  openSaisieRapideModal({
    order,
    title: "Ajouter un article",
    submitLabel: "Ajouter à la commande",
    clientReadonly: true,
    focusElId: "sr-search",
  });
}"""

OLD_CLOSE = '  if (id === "modal-saisie-rapide") { srCart = []; }'
NEW_CLOSE = """  if (id === "modal-saisie-rapide") {
    srCart = [];
    const srClient = document.getElementById("sr-client");
    if (srClient) {
      srClient.readOnly = false;
      srClient.style.opacity = "";
    }
    const submitBtn = document.getElementById("sr-submit-btn");
    if (submitBtn) submitBtn.textContent = "Valider la commande";
  }"""

t = JS.read_text(encoding="utf-8")
if "function openSaisieRapideModal" not in t:
    if ANCHOR not in t:
        raise SystemExit("anchor not found")
    t = t.replace(ANCHOR, HELPER + ANCHOR, 1)
if OLD_OPEN not in t:
    raise SystemExit("openOrderEditor block not found")
t = t.replace(OLD_OPEN, NEW_OPEN, 1)
if OLD_CLOSE not in t:
    raise SystemExit("closeModal sr block not found")
t = t.replace(OLD_CLOSE, NEW_CLOSE, 1)
JS.write_text(t, encoding="utf-8")

html = HTML.read_text(encoding="utf-8")
for old_v in ("371", "370", "369"):
    if f"app-orders.js?v={old_v}" in html:
        html = html.replace(f"app-orders.js?v={old_v}", "app-orders.js?v=372")
        break
else:
    raise SystemExit("cache version not found")
HTML.write_text(html, encoding="utf-8")
print("patched")
