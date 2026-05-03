const API = {
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
  state: "/api/state",
  changes: "/api/changes",
  reset: "/api/reset",
  restoreFromJson: "/api/admin/restore-from-json",
  twoFaVerify: "/api/2fa/verify",
  twoFaSetup: "/api/2fa/setup",
  twoFaEnable: "/api/2fa/enable",
  twoFaDisable: "/api/2fa/disable",
};

const CATEGORIES = ["Bières", "Sodas & Jus", "Eaux", "Vins & Spiritueux", "Cocktails", "Snacks", "Autres"];
const PAYMENT_METHODS = ["Espèces", "Orange Money", "MTN MoMo", "Wave", "Carte", "Crédit client"];
/** Modes incluant Credit fournisseur (dettes fournisseurs), uniquement pour les charges / depenses */
const CHARGE_PAYMENT_METHODS = [...PAYMENT_METHODS, "Credit fournisseur"];
const CHARGE_CATEGORIES = ["Loyer", "Salaires", "Électricité", "Eau", "Gaz / Charbon", "Achats boissons", "Achats snacks", "Téléphone", "Transport", "Entretien", "Impôts & taxes", "Autres"];
const COLORS = {
  "Bières": "#2196f3",
  "Sodas & Jus": "#42a5f5",
  "Eaux": "#73d1ff",
  "Vins & Spiritueux": "#c29dff",
  "Cocktails": "#ff8ec4",
  "Snacks": "#7adbb2",
  "Autres": "#b5b5b5",
  "Espèces": "#1976d2",
  "Orange Money": "#ff9d57",
  "MTN MoMo": "#ffe16d",
  "Mobile Money": "#ff9d57",
  "Wave": "#69d6ff",
  "Carte": "#a68bff",
  "Crédit client": "#ff8e82",
};

let state = null;
let sessionUser = null;
let currentRole = null;
let allowedSiteIds = [];
let currentPage = "home";
let currentFilter = "all";
let ventesSubTab = "commandes";
let caisseInnerTab = "historique";
let stockSubTab = "catalogue";
let paramsSubTab = "profil";
let stockTableCompact = true;
let stockSearchTerm = "";
let activeOrderId = null;
let editingLineId = null;
let currentQrLinkInt = "";
let currentQrLinkExt = "";
let pendingFinalizeOrderId = null;
let liveSyncTimer = null;
let qrAlertCount = 0;
let knownQrOrderIds = new Set();
let flashingQrOrderIds = new Set();
let pendingPreAuthToken = null;
let pendingReceivePurchaseId = null;
let purchaseDraftLines = [];

function creditRecoveriesForSite(sourceState = state) {
  const siteId = sourceState?.activeSiteId || currentSiteId();
  const multiSite = ((sourceState?.sites || state?.sites || []).length > 1);
  return (sourceState?.creditRecoveries || []).filter((p) => rowMatchesSite(p, siteId, multiSite));
}

function normalizePaymentMethodKey(method) {
  return String(method || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
}

function isCreditClientMethod(method) {
  const n = normalizePaymentMethodKey(method);
  return n === "credit client" || (n.includes("credit") && n.includes("client"));
}

function isAReglerPaiement(paiement) {
  const n = normalizePaymentMethodKey(paiement).replace(/\s/g, "");
  return n === "aregler" || paiement === "A regler";
}

/** Clé affichage recouvrement : même débiteur quel que soit la casse → tout en majuscules. */
function debtorDisplayKey(name) {
  const raw = String(name || "").trim();
  return raw ? raw.toUpperCase() : "CLIENT INCONNU";
}

function creditOutstandingMap(sourceState = state) {
  const ventes = recordsForSite(sourceState?.ventes || []);
  const map = {};
  ventes.forEach((v) => {
    const net = calcNet(v);
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: net }];
    const debtorName = debtorDisplayKey(v.debiteur || v.client || "Client inconnu");
    let creditAmount = 0;
    details.forEach((d) => {
      if (isCreditClientMethod(d.method)) creditAmount += Number(d.amount) || 0;
    });
    if (!creditAmount && isAReglerPaiement(v.paiement)) creditAmount = net;
    if (creditAmount > 0) map[debtorName] = (map[debtorName] || 0) + creditAmount;
  });
  creditRecoveriesForSite(sourceState).forEach((p) => {
    const debtorName = debtorDisplayKey(p.debiteur || "Client inconnu");
    map[debtorName] = (map[debtorName] || 0) - (Number(p.montant) || 0);
  });
  Object.keys(map).forEach((k) => {
    if (map[k] <= 0.001) delete map[k];
  });
  return map;
}

/** Noms des comptes (serveur / gérant) ayant enregistré une vente avec crédit client, par débiteur. */
function creditIssuerLabelsByDebtor(sourceState = state) {
  const ventes = recordsForSite(sourceState?.ventes || []);
  const issuerSets = {};
  ventes.forEach((v) => {
    const net = calcNet(v);
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: net }];
    const debtorName = debtorDisplayKey(v.debiteur || v.client || "Client inconnu");
    let creditAmount = 0;
    details.forEach((d) => {
      if (isCreditClientMethod(d.method)) creditAmount += Number(d.amount) || 0;
    });
    if (!creditAmount && isAReglerPaiement(v.paiement)) creditAmount = net;
    if (creditAmount <= 0) return;
    const issuer = String(v.creditIssuedBy || "").trim();
    if (!issuer) return;
    if (!issuerSets[debtorName]) issuerSets[debtorName] = new Set();
    issuerSets[debtorName].add(issuer);
  });
  const labels = {};
  Object.keys(issuerSets).forEach((k) => {
    labels[k] = [...issuerSets[k]].sort((a, b) => a.localeCompare(b, "fr")).join(", ");
  });
  return labels;
}

function creditTotals(sourceState = state) {
  const issued = recordsForSite(sourceState?.ventes || []).reduce((sum, v) => {
    const net = calcNet(v);
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: net }];
    let creditAmount = 0;
    details.forEach((d) => {
      if (isCreditClientMethod(d.method)) creditAmount += Number(d.amount) || 0;
    });
    if (!creditAmount && isAReglerPaiement(v.paiement)) creditAmount = net;
    return sum + Math.max(0, creditAmount);
  }, 0);
  const paid = creditRecoveriesForSite(sourceState).reduce((sum, p) => sum + (Number(p.montant) || 0), 0);
  return { issued, paid };
}

function fmt(value) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(value) || 0));
}

/** Extrait les chiffres d'une saisie montant (espaces / séparateurs retirés). */
function digitsOnlyFcfaString(str) {
  return String(str || "")
    .replace(/\u202f/g, "")
    .replace(/\s/g, "")
    .replace(/\D/g, "");
}

/**
 * Applique la séparation des milliers (fr-FR) sur un champ montant.
 * @param {HTMLInputElement | null} el
 */
function formatFcfaThousandsField(el) {
  if (!el || el.tagName !== "INPUT") return;
  if (!el.dataset.fcfaAttrs) {
    el.setAttribute("inputmode", "numeric");
    el.setAttribute("autocomplete", "off");
    el.setAttribute("spellcheck", "false");
    el.dataset.fcfaAttrs = "1";
  }
  const raw = el.value;
  const care = el.selectionStart ?? raw.length;
  const digitsLeft = digitsOnlyFcfaString(raw.slice(0, care)).length;
  const all = digitsOnlyFcfaString(raw);
  if (!all) {
    el.value = "";
    return;
  }
  let n = Math.round(Number(all));
  if (!Number.isFinite(n) || n < 0) n = 0;
  n = Math.min(n, 1e15);
  const formatted = new Intl.NumberFormat("fr-FR").format(n);
  el.value = formatted;
  let newPos = formatted.length;
  if (digitsLeft <= 0) {
    newPos = 0;
  } else {
    let digitCount = 0;
    for (let i = 0; i < formatted.length; i++) {
      if (/\d/.test(formatted[i])) {
        digitCount++;
        if (digitCount >= digitsLeft) {
          newPos = i + 1;
          break;
        }
      }
    }
  }
  requestAnimationFrame(() => {
    try {
      el.setSelectionRange(newPos, newPos);
    } catch (_) {
      /* ignore */
    }
  });
}

function isFcfaThousandsInput(el) {
  return el instanceof HTMLInputElement && (el.classList.contains("input-fcfa") || el.id === "pdj-opening-cash");
}

/** Une seule fois : écoute les champs injectés dynamiquement (évite une vieille JS en cache sans bind). */
function installFcfaThousandsDelegation() {
  if (window.__fcfaThousandsDelegation) return;
  window.__fcfaThousandsDelegation = true;
  document.body.addEventListener("input", (e) => {
    const t = e.target;
    if (isFcfaThousandsInput(t)) formatFcfaThousandsField(t);
  });
  document.body.addEventListener("blur", (e) => {
    const t = e.target;
    if (isFcfaThousandsInput(t)) formatFcfaThousandsField(t);
  }, true);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** yyyy-mm-dd → dd-mm-yyyy (affichage uniquement ; les données restent ISO). */
function isoDateToDdMmYyyy(iso) {
  const s = String(iso ?? "").trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || "—");
}

/** Affiche jj-mm-aaaa (Date, chaîne ISO datetime, ou yyyy-mm-dd). */
function formatDateDdMmYyyy(input) {
  if (input == null || input === "") return "—";
  const str = String(input).trim();
  const dOnly = str.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dOnly)) return isoDateToDdMmYyyy(dOnly);
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return str || "—";
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** jj-mm-aaaa HH:mm (fuseau local). */
function formatDateTimeDdMmYyyy(input) {
  if (input == null || input === "") return "—";
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Valeur pour input[type=datetime-local] (fuseau local). */
function datetimeLocalNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function formatCreditPaidAt(p) {
  const raw = String(p?.paidAt || p?.createdAt || "").trim();
  if (raw) {
    try {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) {
        return formatDateTimeDdMmYyyy(d);
      }
    } catch (_) {
      /* ignore */
    }
  }
  const day = String(p?.date || "").trim();
  return day ? `${isoDateToDdMmYyyy(day)} (heure non renseignée)` : "—";
}

/** Versements déjà enregistrés par débiteur (clé majuscules), tri récent → ancien. */
function creditRecoveriesGroupedByDebtor(sourceState = state) {
  const map = {};
  creditRecoveriesForSite(sourceState).forEach((p) => {
    const k = debtorDisplayKey(p.debiteur);
    if (!map[k]) map[k] = [];
    map[k].push(p);
  });
  Object.keys(map).forEach((k) => {
    map[k].sort((a, b) => {
      const ta = String(a.paidAt || a.createdAt || `${a.date}T00:00:00`).slice(0, 24);
      const tb = String(b.paidAt || b.createdAt || `${b.date}T00:00:00`).slice(0, 24);
      return tb.localeCompare(ta);
    });
  });
  return map;
}

function calcNet(item) {
  return (Number(item.prix) || 0) * (Number(item.qty) || 0) - (Number(item.remise) || 0);
}

function paymentLabel(item) {
  if (item?.paiementDetails?.length > 1) return "Mixte";
  if (item?.paiementDetails?.length === 1) return item.paiementDetails[0].method;
  return item?.paiement || "";
}

function paymentTotals(list) {
  return (list || []).reduce((acc, item) => {
    if (Array.isArray(item.paiementDetails) && item.paiementDetails.length) {
      item.paiementDetails.forEach((detail) => {
        acc[detail.method] = (acc[detail.method] || 0) + (Number(detail.amount) || 0);
      });
    } else {
      acc[item.paiement] = (acc[item.paiement] || 0) + calcNet(item);
    }
    return acc;
  }, {});
}

function stockLegacyTotal(item) {
  return Math.max(0, Number(item.init || 0) + Number(item.entrees || 0) - Number(item.sorties || 0));
}

function stockFrigo(item) {
  if (!item) return 0;
  if (item.frigo !== undefined && item.frigo !== null) return Math.max(0, Number(item.frigo) || 0);
  return stockLegacyTotal(item);
}

function stockReserve(item) {
  if (!item) return 0;
  if (item.reserve !== undefined && item.reserve !== null) return Math.max(0, Number(item.reserve) || 0);
  return Math.max(0, stockLegacyTotal(item) - stockFrigo(item));
}

function stockActuel(item) {
  if (!item) return 0;
  // Stock actuel = frigo + réserve quand ces champs existent (stock physique réel)
  if (item.frigo !== undefined || item.reserve !== undefined) {
    return Math.max(0, stockFrigo(item) + stockReserve(item));
  }
  return stockLegacyTotal(item);
}

function normalizePhysicalStock(item) {
  const total = stockLegacyTotal(item);
  if (item.frigo === undefined && item.reserve === undefined) {
    item.frigo = total;
    item.reserve = 0;
    return;
  }
  item.frigo = Math.max(0, Number(item.frigo) || 0);
  item.reserve = Math.max(0, Number(item.reserve) || 0);
}

function consumePhysicalStock(item, bottles) {
  normalizePhysicalStock(item);
  let remaining = Math.max(0, Number(bottles) || 0);
  const fromFrigo = Math.min(stockFrigo(item), remaining);
  item.frigo = stockFrigo(item) - fromFrigo;
  remaining -= fromFrigo;
  if (remaining > 0) {
    item.reserve = Math.max(0, stockReserve(item) - remaining);
  }
}

function availableStock(item) {
  if (!item) return 0;
  return stockActuel(item);
}

function lineBottleQty(line, stockItem = null) {
  const packSize = Math.max(1, Number(line?.formatQuantite) || Number(line?.packSize) || Number(stockItem?.packSize) || 1);
  return (Number(line?.qty) || 0) * packSize;
}

function stockItemForArticle(article, siteId = currentSiteId()) {
  return (state.stock || []).find((item) => item.siteId === siteId && item.article.toLowerCase() === String(article || "").toLowerCase()) || null;
}

function reservedBottlesForOpenOrders(article, excludeOrderId = null, excludeLineId = null, siteId = currentSiteId()) {
  return (state.commandes || [])
    .filter((order) => order.siteId === siteId && order.id !== excludeOrderId)
    .flatMap((order) => order.lignes || [])
    .filter((line) => line.article.toLowerCase() === String(article || "").toLowerCase() && line.id !== excludeLineId)
    .reduce((sum, line) => sum + lineBottleQty(line, stockItemForArticle(line.article, siteId)), 0);
}

function stockAvailabilityForLine(article, bottlesNeeded, excludeOrderId = null, excludeLineId = null, siteId = currentSiteId()) {
  const stockItem = stockItemForArticle(article, siteId);
  const reserved = reservedBottlesForOpenOrders(article, excludeOrderId, excludeLineId, siteId);
  const available = Math.max(0, availableStock(stockItem) - reserved);
  return { stockItem, reserved, available, bottlesNeeded };
}

const VALID_CASE_SIZES = [6, 9, 12, 16, 20, 24];

function caseSize(item = {}) {
  const value = Number(item.caseSize) || 24;
  return VALID_CASE_SIZES.includes(value) ? value : 24;
}

function casesFromBottles(bottles, item = {}) {
  const value = Number(bottles) || 0;
  return Math.round((value / caseSize(item)) * 100) / 100;
}

function categoryList() {
  const custom = Array.isArray(state?.categories) ? state.categories : [];
  const cleanedCustom = custom.map((cat) => String(cat || "").trim()).filter(Boolean);
  // If user saved categories, treat them as the source of truth (allow deletions).
  if (cleanedCustom.length) {
    return [...new Set(cleanedCustom)];
  }
  return CATEGORIES.slice();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const isJson = (response.headers.get("Content-Type") || "").includes("application/json");
  const payload = isJson ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function emptyState(title, message) {
  return `<div class="empty-state"><strong>${escapeHtml(title)}</strong><p class="empty-copy">${escapeHtml(message)}</p></div>`;
}

function populateSelect(id, values, firstLabel = null) {
  const options = [...(firstLabel ? [{ value: "", label: firstLabel }] : []), ...values.map((value) => ({ value, label: value }))];
  const node = document.getElementById(id);
  if (!node) return;
  node.innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
}

function populateCategorySelects() {
  populateSelect("s-cat", categoryList());
}

function setAuthVisible(isAuthenticated) {
  document.getElementById("auth-screen").classList.toggle("hidden", isAuthenticated);
  document.getElementById("app-shell").classList.toggle("hidden", !isAuthenticated);
}

function currentSiteId() {
  return state?.activeSiteId || state?.sites?.[0]?.id || null;
}

function currentSite() {
  return (state?.sites || []).find((site) => site.id === currentSiteId()) || state?.sites?.[0] || null;
}

function multiSiteActive() {
  return ((state?.sites || []).length > 1);
}

/** Alignement avec les anciennes lignes sans siteId (un seul maquis). */
function rowMatchesSite(item, siteId, multiSite) {
  if (!item || siteId == null) return false;
  if (item.siteId === siteId) return true;
  if (!multiSite && (item.siteId === undefined || item.siteId === null || item.siteId === "")) return true;
  return false;
}

function recordsForSite(list) {
  const siteId = currentSiteId();
  const multiSite = multiSiteActive();
  return (list || []).filter((item) => rowMatchesSite(item, siteId, multiSite));
}

function canSuperAdmin() {
  if (currentRole === "superadmin") return true;
  const sn = String(sessionUser || "").trim();
  if (sn.toLowerCase() === "admin") return true;
  const u = (state?.auth?.users || []).find((x) => String(x.username || "").trim().toLowerCase() === sn.toLowerCase());
  if (u && String(u.role || "") === "superadmin") return true;
  return false;
}

/** Le login reserve admin est toujours superadmin cote UI et controles locaux. */
function normalizeRoleForUsername(username, role) {
  if (String(username || "").trim().toLowerCase() === "admin") return "superadmin";
  return role;
}

function canSiteAdmin() {
  return currentRole === "admin";
}

/** Super-admin (tous maquis) ou administrateur rattache a un ou plusieurs maquis. */
function canAnyAdmin() {
  return canSuperAdmin() || canSiteAdmin();
}

/** Date traitee sur le Point du jour : admin et superadmin peuvent choisir une journee anterieure pour corriger les ecarts. */
function pdjCalendarDate() {
  const t = today();
  if (!canAnyAdmin()) return t;
  const el = document.getElementById("pdj-work-date");
  const v = el?.value?.trim();
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v > t ? t : v;
  return t;
}

function syncPdjWorkDateInput() {
  const el = document.getElementById("pdj-work-date");
  if (!el || !canAnyAdmin()) return;
  const t = today();
  el.max = t;
  if (!el.value || el.value > t) el.value = t;
}

const STAFF_AUDIT_MAX = 800;

function shouldRecordStaffAudit() {
  if (!sessionUser) return false;
  if (canSuperAdmin() || canSiteAdmin()) return false;
  return currentRole === "manager" || currentRole === "serveuse";
}

function recordStaffAudit(verb, entity, summary, detail = "") {
  if (!shouldRecordStaffAudit() || !state) return;
  if (!Array.isArray(state.staffAuditLog)) state.staffAuditLog = [];
  if (!state.nextId) state.nextId = {};
  state.nextId.auditEntry = (Number(state.nextId.auditEntry) || 0) + 1;
  const id = state.nextId.auditEntry;
  const site = (state.sites || []).find((s) => s.id === currentSiteId());
  state.staffAuditLog.unshift({
    id,
    at: new Date().toISOString(),
    siteId: currentSiteId() || "",
    siteNom: site?.nom || "",
    actor: sessionUser || "-",
    role: currentRole || "-",
    verb,
    entity,
    summary: String(summary || "").slice(0, 400),
    detail: String(detail || "").slice(0, 16000),
  });
  if (state.staffAuditLog.length > STAFF_AUDIT_MAX) state.staffAuditLog.length = STAFF_AUDIT_MAX;
}

/** Liste lisible des lignes commande pour l'audit (annulation / trace). */
function formatCommandeAuditDetail(order) {
  if (!order) return "";
  const lines = Array.isArray(order.lignes) ? order.lignes : [];
  const meta = [];
  if (order.table != null && String(order.table).trim() !== "") meta.push(`Table ${order.table}`);
  if (order.statut) meta.push(`Statut: ${order.statut}`);
  if (order.note && String(order.note).trim()) meta.push(`Note: ${String(order.note).trim()}`);
  const header = meta.length ? `${meta.join(" · ")}\n\n` : "";
  if (!lines.length) return `${header}Aucune ligne enregistree.`;
  const body = lines.map((line, i) => {
    const art = line.article || "?";
    const q = fmt(line.qty);
    const pu = fmt(line.prix || 0);
    const net = fmt(calcNet(line));
    const rem = Number(line.remise) || 0;
    const remTxt = rem > 0 ? ` · remise ${fmt(rem)}` : "";
    return `${i + 1}. ${art} · qte ${q} · PU ${pu}${remTxt} · ${net} FCFA`;
  }).join("\n");
  const total = lines.reduce((s, l) => s + (Number(calcNet(l)) || 0), 0);
  return `${header}${body}\n\nTotal: ${fmt(total)} FCFA (${lines.length} ligne(s))`;
}

function formatPurchaseOrderAuditDetail(po) {
  if (!po) return "";
  const lines = Array.isArray(po.lines) ? po.lines : [];
  if (!lines.length) return `${fmt(po.total || 0)} FCFA · aucune ligne`;
  const body = lines.map((l, i) => {
    const art = l.article || "?";
    const cases = fmt(l.cases);
    const cs = l.caseSize != null ? fmt(l.caseSize) : "";
    const ppc = fmt(l.pricePerCase || 0);
    const amt = fmt(l.amount || 0);
    const csPart = cs ? ` · ${cs} btl/cas.` : "";
    return `${i + 1}. ${art} · ${cases} cas.${csPart} · ${ppc} FCFA/cas. · ${amt} FCFA`;
  }).join("\n");
  return `${body}\n\nTotal: ${fmt(po.total || 0)} FCFA (${lines.length} ligne(s))`;
}

function staffAuditVerbLabel(verb) {
  if (verb === "delete") return "Suppression";
  if (verb === "create") return "Creation";
  if (verb === "update") return "Modification";
  return verb;
}

function staffAuditEntityLabel(entity) {
  const map = {
    commande_ligne: "Ligne commande",
    commande: "Commande",
    commande_statut: "Statut commande",
    vente: "Vente facturee",
    charge: "Depense",
    credit_recovery: "Recouvrement client",
    encaissement: "Encaissement",
    frigo: "Frigo / reserve",
    reappro: "Reappro stock",
    perte: "Perte stock",
    achat_fournisseur: "Commande fournisseur",
    reception_fournisseur: "Reception fournisseur",
    cloture_jour: "Cloture journee",
    catalogue_article: "Article catalogue",
  };
  return map[entity] || entity;
}

function openStaffAuditDetailModal(entryId) {
  const log = Array.isArray(state?.staffAuditLog) ? state.staffAuditLog : [];
  const row = log.find((r) => Number(r.id) === Number(entryId));
  if (!row) {
    showToast("Entree d'audit introuvable.");
    return;
  }
  const idEl = document.getElementById("audit-detail-id");
  if (idEl) idEl.textContent = String(row.id ?? "—");
  const set = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("audit-detail-date", formatDateTimeDdMmYyyy(row.at));
  set("audit-detail-site", row.siteNom || row.siteId || "—");
  set("audit-detail-siteid", row.siteId || "—");
  set("audit-detail-actor", row.actor || "—");
  set("audit-detail-role", row.role || "—");
  set("audit-detail-verb", staffAuditVerbLabel(row.verb));
  set("audit-detail-entity", staffAuditEntityLabel(row.entity));
  set("audit-detail-verbraw", row.verb || "—");
  set("audit-detail-entityraw", row.entity || "—");
  set("audit-detail-summary", row.summary || "—");
  set("audit-detail-detail", row.detail || "—");
  openModal("modal-staff-audit-detail");
  document.getElementById("audit-detail-detail")?.focus();
}

function renderStaffAuditLog() {
  const container = document.getElementById("staff-audit-list");
  if (!container) return;
  if (!canAnyAdmin()) {
    container.innerHTML = "";
    return;
  }
  const log = Array.isArray(state.staffAuditLog) ? state.staffAuditLog : [];
  if (!log.length) {
    container.innerHTML = emptyState("Aucune trace", "Les actions du gerant et des serveuses apparaitront ici.");
    return;
  }
  container.innerHTML = `
    <div class="stock-table-wrap" style="margin-top:8px">
      <table class="stock-table" style="min-width:920px">
        <thead><tr>
          <th>Date</th>
          <th>Maquis</th>
          <th>Utilisateur</th>
          <th>Role</th>
          <th>Action</th>
          <th>Type</th>
          <th>Resume</th>
          <th>Detail</th>
        </tr></thead>
        <tbody>
          ${log.map((row) => `<tr>
            <td>${escapeHtml(formatDateTimeDdMmYyyy(row.at))}</td>
            <td>${escapeHtml(row.siteNom || row.siteId || "")}</td>
            <td>${escapeHtml(row.actor || "")}</td>
            <td>${escapeHtml(row.role || "")}</td>
            <td>${escapeHtml(staffAuditVerbLabel(row.verb))}</td>
            <td>${escapeHtml(staffAuditEntityLabel(row.entity))}</td>
            <td class="audit-cell-wrap">
              <span class="audit-cell-expand" data-audit-open="${escapeHtml(String(row.id))}" role="button" tabindex="0" title="Voir le resume complet">${escapeHtml(row.summary || "")}</span>
            </td>
            <td class="audit-cell-wrap-muted">
              <span class="audit-cell-expand-muted" data-audit-open="${escapeHtml(String(row.id))}" role="button" tabindex="0" title="Voir le detail complet">${escapeHtml(row.detail || "")}</span>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function canManage() {
  return canAnyAdmin() || currentRole === "manager";
}

function canAccessSite(siteId) {
  return allowedSiteIds.includes(siteId);
}

function renderSiteSwitcher() {
  const availableSites = canSuperAdmin()
    ? (state?.sites || [])
    : (state?.sites || []).filter((site) => canAccessSite(site.id));
  const select = document.getElementById("site-switcher");
  select.innerHTML = availableSites.map((site) => `<option value="${escapeHtml(site.id)}">${escapeHtml(site.nom)}</option>`).join("");
  if (!canAccessSite(currentSiteId()) && availableSites[0]) {
    state.activeSiteId = availableSites[0].id;
  }
  select.value = currentSiteId() || "";
  select.disabled = availableSites.length <= 1;
}

function applyRoleVisibility() {
  const restrictedPages = ["stock", "charges", "params"];
  document.querySelectorAll(".nav-btn").forEach((button) => {
    const restricted = restrictedPages.includes(button.dataset.page);
    button.classList.toggle("hidden", !canManage() && restricted);
  });
  document.querySelectorAll(".manager-more-item").forEach((node) => {
    node.classList.toggle("hidden", !canManage());
  });
  if (!canManage() && restrictedPages.includes(currentPage)) {
    navigate("ventes");
    return;
  }
  document.querySelectorAll(".manager-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canManage());
  });
  document.querySelectorAll(".superadmin-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canSuperAdmin());
  });
  document.querySelectorAll(".any-admin").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canAnyAdmin());
  });
  document.querySelectorAll(".admin-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canSuperAdmin());
  });
  const roleSelect = document.getElementById("new-user-role");
  if (roleSelect) {
    [...roleSelect.options].forEach((opt) => {
      if (opt.classList.contains("admin-only")) opt.hidden = !canSuperAdmin();
      else if (opt.classList.contains("any-admin")) opt.hidden = !canAnyAdmin();
      else opt.hidden = false;
    });
    if (!canAnyAdmin() && roleSelect.value !== "serveuse") roleSelect.value = "serveuse";
    if (!canSuperAdmin() && (roleSelect.value === "superadmin" || roleSelect.value === "admin")) {
      roleSelect.value = "serveuse";
    }
  }
  maybeAdjustParamsSubTab();
}

function renderTopbar() {
  document.getElementById("top-bar-name").textContent = currentSite()?.nom || "Mon Bar";
  document.getElementById("top-date").textContent = formatDateDdMmYyyy(new Date());
  document.getElementById("session-user").textContent = sessionUser || "utilisateur";
  document.getElementById("role-badge").textContent = (() => {
    const eff = String(sessionUser || "").trim().toLowerCase() === "admin" ? "superadmin" : currentRole;
    return eff === "superadmin"
      ? "super administrateur"
      : eff === "admin"
        ? "admin. maquis"
        : eff === "manager"
          ? "gerant"
          : (eff || "utilisateur");
  })();
}

function renderHero() {
  const titles = {
    home: "Le coeur de votre bar, en temps reel.",
    pdj: "Le point du jour, separe du tableau de bord.",
    ventes: "Servez plusieurs clients sans perdre la commande en cours.",
    guide: "Mode d'emploi accessible a toute l'equipe.",
    stock: "Les prix de vente partent du catalogue stock.",
    charges: "Les sorties d'argent restent centralisees.",
    params: "Parametres organises par onglets : profil, catalogue, acces, administration.",
  };
  const copies = {
    home: "Le serveur garde les sessions et l'etat complet de l'application.",
    pdj: "Ouverture puis fermeture de caisse ; verification stock conforme avant cloture.",
    ventes: "Une commande peut etre modifiee autant de fois que necessaire avant la facture finale.",
    guide: "Sommaire, liens vers le guide imprimable PDF ; meme les comptes serveuse peuvent consulter cette page.",
    stock: "Renseignez prix achat et prix vente pour accelerer la prise de commande.",
    charges: "Toutes les depenses sont historisees cote serveur.",
    params: "Profil du maquis et export JSON sous Profil ; categories et utilisateurs ont leur propre onglet.",
  };
  document.getElementById("hero-title").textContent = titles[currentPage];
  document.getElementById("hero-copy").textContent = copies[currentPage];
}

function syncCaisseInnerPanels() {
  const hist = document.getElementById("ventes-caisse-panel-historique");
  const rec = document.getElementById("ventes-caisse-panel-recouvrement");
  if (!hist || !rec) return;
  const showHist = caisseInnerTab === "historique";
  hist.classList.toggle("hidden", !showHist);
  rec.classList.toggle("hidden", showHist);
  hist.setAttribute("aria-hidden", showHist ? "false" : "true");
  rec.setAttribute("aria-hidden", showHist ? "true" : "false");
  document.querySelectorAll("[data-caisse-inner]").forEach((btn) => {
    const active = btn.dataset.caisseInner === caisseInnerTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function setCaisseInnerTab(tab) {
  if (tab !== "historique" && tab !== "recouvrement") return;
  caisseInnerTab = tab;
  syncCaisseInnerPanels();
  syncNavActiveState();
}

function setVentesSubTab(tab) {
  ventesSubTab = tab;
  const isCommandes = tab === "commandes";
  const isCaisse = tab === "caisse";
  const isQr = tab === "qr";
  document.getElementById("ventes-card-gestion").classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-board").classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-qr").classList.toggle("hidden", !isQr);
  document.getElementById("ventes-card-historique").classList.toggle("hidden", !isCaisse);
  document.querySelectorAll("[data-subtab-ventes]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtabVentes === tab);
  });
  if (isCaisse) syncCaisseInnerPanels();
  syncNavActiveState();
}

function setStockSubTab(tab) {
  stockSubTab = tab;
  const isCatalogue = tab === "catalogue";
  const isMouvements = tab === "mouvements";
  const isAchats = tab === "achats";
  const isCreanciers = tab === "creanciers";
  document.getElementById("stock-card-catalogue").classList.toggle("hidden", !isCatalogue);
  document.getElementById("stock-list").classList.toggle("hidden", !isCatalogue);
  document.getElementById("stock-card-mouvements").classList.toggle("hidden", !isMouvements);
  document.getElementById("stock-card-achats").classList.toggle("hidden", !isAchats);
  document.getElementById("stock-card-creanciers").classList.toggle("hidden", !isCreanciers);
  document.querySelectorAll("[data-subtab-stock]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtabStock === tab);
  });
  if (currentPage === "stock") {
    if (isAchats) renderPurchaseOrders();
    else if (isCreanciers) renderCreanciers();
    else if (isMouvements) renderStockMovements();
  }
  syncFabLabelForStockPage();
}

function setParamsSubTab(tab) {
  paramsSubTab = tab;
  const root = document.getElementById("page-params");
  if (!root) return;
  root.querySelectorAll("[data-subtab-params]").forEach((btn) => {
    const active = btn.dataset.subtabParams === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  root.querySelectorAll("[data-params-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.paramsPanel !== tab);
  });
}

function maybeAdjustParamsSubTab() {
  const root = document.getElementById("page-params");
  if (!root) return;
  const btn = root.querySelector(`[data-subtab-params="${paramsSubTab}"]`);
  if (!btn || btn.classList.contains("hidden-by-role")) paramsSubTab = "profil";
  setParamsSubTab(paramsSubTab);
}

function syncFabLabelForStockPage() {
  const fab = document.getElementById("fab-btn");
  if (!fab) return;
  if (currentPage === "stock" && stockSubTab === "creanciers") {
    fab.setAttribute("aria-label", "Enregistrer une dette fournisseur");
    fab.title = "Ouvre une depense avec paiement Credit fournisseur.";
    return;
  }
  if (currentPage === "stock" && stockSubTab === "achats") {
    fab.setAttribute("aria-label", "Nouvelle commande fournisseur");
    fab.title = "Ouvre le formulaire de commande achat (fournisseur).";
    return;
  }
  fab.setAttribute("aria-label", "Ajouter");
  fab.removeAttribute("title");
}

function openCreditorChargeModal() {
  document.getElementById("c-date").value = today();
  const pay = document.getElementById("c-pay");
  if (pay) pay.value = "Credit fournisseur";
  openModal("modal-charge");
}

function navigateToClientCredits() {
  ventesSubTab = "caisse";
  caisseInnerTab = "recouvrement";
  navigate("ventes");
}

function syncNavActiveState() {
  document.querySelectorAll(".sidebar-nav .nav-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === currentPage);
  });
  const bottom = document.getElementById("bottom-nav");
  if (!bottom) return;
  bottom.querySelectorAll(".nav-btn").forEach((btn) => {
    const page = btn.dataset.page;
    let active = false;
    if (page === currentPage) {
      if (page === "ventes") {
        const vst = btn.dataset.ventesSubtab;
        if (vst === "commandes") active = ventesSubTab === "commandes";
        else if (vst === "caisse") active = ventesSubTab === "caisse";
        else active = false;
      } else active = true;
    }
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-current", active ? "page" : "false");
  });
}

function navigate(page, opts = {}) {
  currentPage = page;
  const vstab = opts.ventesSubtab;
  const cinner = opts.caisseInner;
  if (vstab !== undefined && vstab !== null && String(vstab).trim() !== "") ventesSubTab = vstab;
  if (cinner !== undefined && cinner !== null && String(cinner).trim() !== "") caisseInnerTab = cinner;
  if (vstab === "caisse" && (cinner === undefined || String(cinner).trim() === "")) caisseInnerTab = "historique";

  document.querySelectorAll(".page").forEach((node) => node.classList.remove("active"));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add("active");

  syncNavActiveState();
  document.getElementById("fab-btn").classList.toggle("hidden", !["ventes", "stock", "charges"].includes(page));
  renderHero();
  renderSiteSwitcher();
  if (page === "home") renderDashboard();
  if (page === "pdj") renderPointDuJour();
  if (page === "ventes") { setVentesSubTab(ventesSubTab); renderVentesPage(); }
  if (page === "stock") { setStockSubTab(stockSubTab); renderStock(); }
  if (page === "charges") renderCharges();
  if (page === "params") {
    loadParamsForm();
    maybeAdjustParamsSubTab();
  }
  syncFabLabelForStockPage();
  applyRoleVisibility();
}

function handleNavButtonClick(button) {
  const page = button?.dataset?.page;
  if (!page) return;
  navigate(page, {
    ventesSubtab: button.dataset.ventesSubtab,
    caisseInner: button.dataset.caisseInner,
  });
}

function openMobileMoreSheet() {
  const sheet = document.getElementById("mobile-more-sheet");
  if (!sheet) return;
  sheet.classList.remove("hidden");
  sheet.classList.add("open");
  sheet.setAttribute("aria-hidden", "false");
}

function closeMobileMoreSheet() {
  const sheet = document.getElementById("mobile-more-sheet");
  if (!sheet) return;
  sheet.classList.remove("open");
  sheet.classList.add("hidden");
  sheet.setAttribute("aria-hidden", "true");
}

function bindMobileMoreSheet() {
  const sheet = document.getElementById("mobile-more-sheet");
  if (!sheet) return;
  document.getElementById("mobile-more-btn")?.addEventListener("click", () => openMobileMoreSheet());
  document.getElementById("topbar-more-btn")?.addEventListener("click", () => openMobileMoreSheet());
  sheet.addEventListener("click", (event) => {
    if (event.target.closest(".mobile-more-backdrop")) closeMobileMoreSheet();
    if (event.target.closest("[data-more-sheet-close]")) {
      closeMobileMoreSheet();
      return;
    }
    const link = event.target.closest("[data-more-nav]");
    if (!link) return;
    const nav = link.dataset.moreNav;
    closeMobileMoreSheet();
    if (nav === "qr") navigate("ventes", { ventesSubtab: "qr" });
    else if (nav === "guide") navigate("guide");
    else if (nav === "charges") navigate("charges");
    else if (nav === "params") navigate("params");
    else if (nav === "logout") logout();
  });
}

function resolveItemPrices(item) {
  const primary = primarySaleFormat(item);
  const prixInt = Number(primary?.prixInterieur) || Number(item.prixVenteInt) || Number(item.prixKitInt) || Number(item.prixBouteille) || Number(item.prixVente) || 0;
  const prixExt = Number(primary?.prixExterieur) || Number(item.prixVenteExt) || Number(item.prixKitExt) || Number(item.prixBouteille) || Number(item.prixVente) || prixInt;
  return { prixInt, prixExt };
}

function normalizeSaleFormats(item = {}) {
  const rawFormats = Array.isArray(item.formatsVente) ? item.formatsVente : [];
  const formats = rawFormats.map((format) => ({
    quantite: Math.max(1, Number(format.quantite ?? format.qty ?? format.packSize) || 1),
    prixInterieur: Number(format.prixInterieur ?? format.prixInt ?? format.prixVenteInt) || 0,
    prixExterieur: Number(format.prixExterieur ?? format.prixExt ?? format.prixVenteExt) || 0,
  })).filter((format) => format.prixInterieur > 0);
  if (!formats.length) {
    const packSize = Math.max(1, Number(item.packSize) || 1);
    const prixInt = Number(item.prixVenteInt) || Number(item.prixKitInt) || Number(item.prixBouteille) || Number(item.prixVente) || 0;
    const prixExt = Number(item.prixVenteExt) || Number(item.prixKitExt) || Number(item.prixBouteille) || Number(item.prixVente) || prixInt;
    if (prixInt > 0) formats.push({ quantite: packSize, prixInterieur: prixInt, prixExterieur: prixExt || prixInt });
  }
  return formats
    .map((format) => ({ ...format, prixExterieur: format.prixExterieur || format.prixInterieur }))
    .sort((a, b) => a.quantite - b.quantite);
}

function primarySaleFormat(item = {}) {
  const formats = normalizeSaleFormats(item);
  return formats.find((format) => format.quantite === 1) || formats[0] || null;
}

function saleFormatLabel(format) {
  const qty = Math.max(1, Number(format?.quantite) || 1);
  return qty === 1 ? "Unite" : `Kit de ${qty}`;
}

function formatPrice(format, location) {
  if (!format) return 0;
  return String(location).startsWith("Ext") ? Number(format.prixExterieur) || 0 : Number(format.prixInterieur) || 0;
}

function knownProducts() {
  const map = new Map();
  recordsForSite(state.stock).forEach((item) => {
    const formatsVente = normalizeSaleFormats(item);
    const primary = primarySaleFormat(item);
    const packSize = Math.max(1, Number(primary?.quantite) || Number(item.packSize) || 1);
    const { prixInt, prixExt } = resolveItemPrices(item);
    map.set(item.article.toLowerCase(), {
      article: item.article,
      cat: item.cat,
      prix: prixInt,
      prixInt,
      prixExt,
      prixAchat: Number(item.prixAchat) || 0,
      packSize,
      formatsVente,
    });
  });
  recordsForSite(state.ventes).forEach((item) => {
    if (!map.has(item.article.toLowerCase())) {
      map.set(item.article.toLowerCase(), {
        article: item.article,
        cat: item.cat,
        prix: Number(item.prix) || 0,
        prixInt: Number(item.prix) || 0,
        prixExt: Number(item.prix) || 0,
        prixAchat: 0,
        packSize: 1,
      });
    }
  });
  return [...map.values()];
}

function findKnownProduct(name) {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  return knownProducts().find((item) => item.article.toLowerCase() === value)
    || knownProducts().find((item) => item.article.toLowerCase().includes(value))
    || null;
}

function updateKitInfo(product = findKnownProduct(document.getElementById("v-article").value)) {
  const info = document.getElementById("v-kit-info");
  if (!info) return;
  const stockInfo = document.getElementById("v-stock-info");
  const priceInput = document.getElementById("v-prix");
  const format = selectedSaleFormat(product);
  const packSize = Math.max(1, Number(format?.quantite) || Number(product?.packSize) || 1);
  if (product && format) {
    const prix = formatPrice(format, document.getElementById("v-location").value);
    info.textContent = `${saleFormatLabel(format)} : ${packSize} bouteille(s) pour ${fmt(prix)} FCFA. Le stock baisse de ${packSize} bouteille(s) par quantite vendue.`;
    info.classList.remove("hidden");
    const stockItem = stockItemForArticle(product.article);
    const frigo = stockFrigo(stockItem);
    const reserve = stockReserve(stockItem);
    const alert = frigo < packSize && reserve > 0
      ? ` <button type="button" class="mini-btn" data-fill-fridge-article="${escapeHtml(product.article)}">Remplir depuis reserve</button>`
      : "";
    if (stockInfo) {
      stockInfo.innerHTML = `Stock reel : frigo ${fmt(frigo)} btl · reserve ${fmt(reserve)} btl.${frigo < packSize ? " Alerte : frigo bas." : ""}${alert}`;
      stockInfo.classList.remove("hidden");
    }
    priceInput.readOnly = true;
    return;
  }
  info.textContent = "";
  info.classList.add("hidden");
  if (stockInfo) {
    stockInfo.innerHTML = "";
    stockInfo.classList.add("hidden");
  }
  priceInput.readOnly = true;
}

function syncKnownProduct() {
  const product = findKnownProduct(document.getElementById("v-article").value);
  populateSaleFormatSelect(product);
  updateKitInfo(product);
  if (!product) {
    document.getElementById("v-prix").value = "";
    updateVentePreview();
    return;
  }
  const fixedPrice = productPrice(product, document.getElementById("v-location").value);
  document.getElementById("v-prix").value = String(fixedPrice || "");
  updateVentePreview();
}

/** Liste filtrée pour la modale commande (hors QR). */
function productsForVentePicker(query) {
  const items = knownProducts().slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, 55);
  const terms = q.split(/\s+/).filter(Boolean);
  return items.filter((p) => {
    const a = p.article.toLowerCase();
    const c = String(p.cat || "").toLowerCase();
    return terms.every((t) => a.includes(t) || c.includes(t));
  }).slice(0, 80);
}

function renderVenteArticlePicker() {
  const wrap = document.getElementById("v-article-picker");
  const search = document.getElementById("v-article-search");
  if (!wrap) return;
  const q = search ? String(search.value || "") : "";
  const allCount = knownProducts().length;
  const list = productsForVentePicker(q);
  let hint = "";
  if (!q.trim() && allCount > list.length) {
    hint = `<div class="vente-picker-hint">${list.length} premiers articles (tri A-Z). Saisissez un mot-cle pour affiner.</div>`;
  } else if (q.trim() && list.length >= 80) {
    hint = `<div class="vente-picker-hint">Limite a 80 resultats : precisez la recherche.</div>`;
  }
  if (!list.length) {
    wrap.innerHTML = `${hint}<p class="muted" style="padding:12px;font-size:0.88rem">Aucun produit ne correspond.</p>`;
    return;
  }
  wrap.innerHTML = hint + list.map((p) => {
    const stockItem = stockItemForArticle(p.article);
    const avail = stockItem ? availableStock(stockItem) : null;
    const avLabel = avail == null ? "—" : `${fmt(avail)} btl`;
    const enc = encodeURIComponent(p.article);
    return `<button type="button" class="vente-picker-row" data-vente-pick="${enc}">
      <span class="vente-picker-name">${escapeHtml(p.article)}</span>
      <span class="vente-picker-meta">${escapeHtml(p.cat || "—")} · Stock ${avLabel}</span>
    </button>`;
  }).join("");
}

function productPrice(product, location) {
  if (!product) return 0;
  const format = selectedSaleFormat(product);
  if (format) return formatPrice(format, location);
  return String(location).startsWith("Ext") ? Number(product.prixExt) || 0 : Number(product.prixInt) || 0;
}

function populateSaleFormatSelect(product, selectedQuantity = null) {
  const select = document.getElementById("v-format");
  if (!select) return;
  const formats = product ? normalizeSaleFormats(product) : [];
  select.innerHTML = formats.length
    ? formats.map((format) => `<option value="${format.quantite}">${escapeHtml(saleFormatLabel(format))}</option>`).join("")
    : `<option value="1">Unite</option>`;
  if (selectedQuantity) select.value = String(selectedQuantity);
}

function selectedSaleFormat(product) {
  if (!product) return null;
  const formats = normalizeSaleFormats(product);
  const selected = Number(document.getElementById("v-format")?.value) || 0;
  return formats.find((format) => format.quantite === selected) || primarySaleFormat(product);
}

function renderBreakdown(targetId, collection, total, emptyMessage) {
  const entries = Object.entries(collection).sort((a, b) => b[1] - a[1]);
  document.getElementById(targetId).innerHTML = entries.length
    ? entries.map(([label, value]) => {
      const pct = total > 0 ? Math.round((value / total) * 100) : 0;
      const color = COLORS[label] || "#b5b5b5";
      return `<div class="cat-row"><span class="cat-dot" style="background:${color}"></span><span>${escapeHtml(label)} ${fmt(value)} FCFA</span><span class="cat-bar"><span class="cat-fill" style="width:${pct}%;background:${color}"></span></span><strong>${pct}%</strong></div>`;
    }).join("")
    : emptyState("Vide", emptyMessage);
}

function isCreance(v) {
  return isCreditSale(v);
}

function isCreditSale(v) {
  return isCreditClientMethod(v.paiement) || isAReglerPaiement(v.paiement)
    || (v.paiementDetails || []).some((detail) => isCreditClientMethod(detail.method) && Number(detail.amount) > 0);
}

function renderPointDuJour() {
  syncPdjWorkDateInput();
  const dStr = pdjCalendarDate();
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totalsJour = paymentTotals(ventesJour);
  const caCreances = Object.entries(totalsJour).reduce((sum, [method, amount]) => String(method).includes("dit client") ? sum + amount : sum, 0);
  const caEncaisse = Object.entries(totalsJour).reduce((sum, [method, amount]) => String(method).includes("dit client") ? sum : sum + amount, 0);
  const remisesJour = ventesJour.reduce((sum, v) => sum + (Number(v.remise) || 0), 0);

  const pdjDateEl = document.getElementById("pdj-date");
  if (pdjDateEl) {
    pdjDateEl.textContent = canSuperAdmin() && dStr !== today()
      ? `Journee du ${formatDateDdMmYyyy(dStr)} · aujourd'hui ${formatDateDdMmYyyy(new Date())}`
      : formatDateDdMmYyyy(new Date());
  }
  renderCashOpeningPanel();
  document.getElementById("pdj-ca").textContent = `${fmt(caEncaisse)} FCFA`;
  document.getElementById("pdj-creances").textContent = `${fmt(caCreances)} FCFA`;
  document.getElementById("pdj-nb").textContent = String(ventesJour.length);
  document.getElementById("pdj-remises").textContent = `${fmt(remisesJour)} FCFA`;
  document.getElementById("pdj-ventes-count").textContent = `${ventesJour.length} vente(s)`;

  renderSalesByProduct(ventesJour);
  renderBreakdown(
    "pdj-pay-chart",
    Object.fromEntries(Object.entries(totalsJour).filter(([method]) => !String(method).includes("dit client"))),
    /*
    ventesJour.filter((v) => !isCreditSale(v)).reduce((acc, v) => {
      let categorie = v.paiement;
      // Regrouper les services de mobile money
      if (categorie === "Orange Money" || categorie === "MTN MoMo") {
        categorie = "Mobile Money";
      }
      acc[categorie] = (acc[categorie] || 0) + calcNet(v);
      return acc;
    }, {}),
    */
    caEncaisse,
    dStr === today() ? "Aucun encaissement enregistre aujourd'hui." : `Aucun encaissement pour le ${formatDateDdMmYyyy(dStr)}.`,
  );

  const sorted = ventesJour.slice().sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("pdj-ventes-list").innerHTML = sorted.length
    ? sorted.map((v) => `
        <article class="list-item">
          <div>
            <p class="list-item-title">${escapeHtml(v.article)}</p>
            <p class="list-item-sub">${escapeHtml(v.cat)} · ${fmt(v.qty)} x ${fmt(v.prix)} FCFA${v.remise ? ` · -${fmt(v.remise)}` : ""} · ${escapeHtml(v.paiement)}</p>
          </div>
          <div class="list-side">
            <div>
              <p class="list-item-amount" style="${isCreance(v) ? "color:#ff8e82" : ""}">${fmt(calcNet(v))} FCFA</p>
              <p class="list-item-date">${v.factureNumber ? escapeHtml(v.factureNumber) : escapeHtml(formatDateDdMmYyyy(dStr))}</p>
            </div>
          </div>
        </article>
      `).join("")
    : emptyState(
      dStr === today() ? "Aucune vente aujourd'hui" : `Aucune vente le ${formatDateDdMmYyyy(dStr)}`,
      dStr === today()
        ? "Les ventes du jour apparaissent ici des qu'elles sont enregistrees."
        : "Les ventes de cette date apparaitront ici.",
    );
  renderDailyStockCheck();
  renderPastClosuresForReopen();
}

/** Annule les ecritures comptables (sorties / entrees) appliquees par une cloture — meme logique que prevClose dans closeAccountingDay. */
function revertStockCheckLedgerEffects(check) {
  if (!check || !Array.isArray(check.items)) return;
  for (const prev of check.items) {
    const id = Number(prev.id);
    const item = state.stock.find((s) => Number(s.id) === id);
    if (!item) continue;
    const st = Number(prev.sortiesToday) || 0;
    const ec = Number(prev.ecart) || 0;
    if (st > 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - st);
    if (ec > 0) item.entrees = Math.max(0, (Number(item.entrees) || 0) - ec);
    if (ec < 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - Math.abs(ec));
  }
}

function renderPastClosuresForReopen() {
  const host = document.getElementById("pdj-reopen-closures");
  if (!host) return;
  if (!canAnyAdmin()) {
    host.innerHTML = "";
    return;
  }
  const siteId = currentSiteId();
  if (!siteId) {
    host.innerHTML = "";
    return;
  }
  const checks = (state.stockChecks || [])
    .filter((sc) => sc && sc.siteId === siteId && sc.date && Array.isArray(sc.items) && sc.items.length)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!checks.length) {
    host.innerHTML = `<p class="muted" style="font-size:0.88rem;margin:8px 0 0">Aucune journee cloturee enregistree pour ce maquis.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="section-head pdj-detail-head" style="margin-top:16px">
      <h3 class="pdj-detail-title">Journees cloturees (reouverture)</h3>
    </div>
    <p class="muted" style="font-size:0.85rem;margin:0 0 12px;line-height:1.45">
      Reserve aux administrateurs : supprime la fiche de cloture et annule les ecritures de stock associees (sorties journalieres et ecarts comptables enregistres a la cloture).
      Les quantites frigo / reserve actuelles ne sont pas modifiees automatiquement ; verifiez le stock physique si necessaire.
    </p>
    <ul style="list-style:none;padding:0;margin:0;display:grid;gap:10px">
      ${checks.map((sc) => {
        const dLabel = formatDateDdMmYyyy(sc.date);
        const when = sc.createdAt ? formatDateTimeDdMmYyyy(sc.createdAt) : "";
        const cashOpen = typeof sc.openingCashFcfa === "number" ? `${fmt(sc.openingCashFcfa)} FCFA a l'ouverture` : "";
        return `<li class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <strong>${escapeHtml(dLabel)}</strong>
            ${when ? `<span class="muted" style="font-size:0.85rem"> · cloturee ${escapeHtml(when)}</span>` : ""}
            ${cashOpen ? `<p class="muted" style="margin:4px 0 0;font-size:0.82rem">${escapeHtml(cashOpen)}</p>` : ""}
          </div>
          <button type="button" class="mini-btn" style="border-color:#c54f41;color:#983428" data-reopen-close="${escapeHtml(String(sc.date))}">Reouvrir cette journee</button>
        </li>`;
      }).join("")}
    </ul>`;
}

async function reopenAccountingDayConfirm(siteId, dateStr) {
  if (!canAnyAdmin()) {
    showToast("Reserve aux administrateurs.");
    return;
  }
  if (!canSuperAdmin() && !canAccessSite(siteId)) {
    showToast("Maquis non autorise.");
    return;
  }
  const label = formatDateDdMmYyyy(dateStr);
  if (!window.confirm(
    `Reouvrir la journee du ${label} ? La fiche de cloture sera supprimee et les ecritures de stock generees par cette cloture seront annulees (frigo / reserve non ajustes automatiquement).`,
  )) return;
  await reopenAccountingDay(siteId, dateStr);
}

async function reopenAccountingDay(siteId, dateStr) {
  if (!canAnyAdmin()) {
    showToast("Reserve aux administrateurs.");
    return;
  }
  if (!canSuperAdmin() && !canAccessSite(siteId)) {
    showToast("Maquis non autorise.");
    return;
  }
  const check = (state.stockChecks || []).find((sc) => sc.siteId === siteId && sc.date === dateStr);
  if (!check) {
    showToast("Cloture introuvable pour cette date.");
    return;
  }
  revertStockCheckLedgerEffects(check);
  state.stockChecks = (state.stockChecks || []).filter((sc) => !(sc.siteId === siteId && sc.date === dateStr));
  await persistState({ stock: state.stock, stockChecks: state.stockChecks });
  // Auto-positionner la date de travail sur la date recouverte
  const workDateEl = document.getElementById("pdj-work-date");
  if (workDateEl && canAnyAdmin()) {
    workDateEl.value = dateStr;
    syncPdjWorkDateInput();
  }
  renderStock();
  renderPointDuJour();
  showToast(`Journee du ${formatDateDdMmYyyy(dateStr)} reouverte. Corrigez le stock puis recloturez.`);
}

function dayBookFor(dateStr = today(), siteId = currentSiteId()) {
  return (state.dayBooks || []).find((b) => b.siteId === siteId && b.date === dateStr) || null;
}

function dayBookNeedsCashOpening(book) {
  if (!book) return true;
  if (book.openingCashRecorded === true) return false;
  const n = Number(book.openingCashFcfa);
  if (typeof book.openingCashFcfa === "number" && !Number.isNaN(n)) return false;
  if (book.openingCashFcfa != null && book.openingCashFcfa !== "" && !Number.isNaN(n)) return false;
  return true;
}

function captureOpeningStockSnapshot() {
  const snapshot = {};
  recordsForSite(state.stock).forEach((item) => {
    snapshot[String(item.id)] = stockActuel(item);
  });
  return snapshot;
}

async function recordCashOpening() {
  const input = document.getElementById("pdj-opening-cash");
  const raw = input?.value;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    showToast("Indiquez le montant en caisse à l'ouverture (fonds de caisse).");
    return;
  }
  const amount = Number(digitsOnlyFcfaString(raw));
  if (Number.isNaN(amount) || amount < 0) {
    showToast("Montant d'ouverture invalide.");
    return;
  }
  state.dayBooks = state.dayBooks || [];
  const siteId = currentSiteId();
  const dateStr = pdjCalendarDate();
  if (!canSuperAdmin() && dateStr !== today()) {
    showToast("Seul le super administrateur peut enregistrer l'ouverture pour une autre date.");
    return;
  }
  let book = dayBookFor(dateStr, siteId);
  const snapshot = captureOpeningStockSnapshot();
  const ts = new Date().toISOString();
  if (!book) {
    book = {
      id: Date.now(),
      siteId,
      date: dateStr,
      openedAt: ts,
      openingStockById: snapshot,
      openingCashFcfa: amount,
      openingCashRecorded: true,
      openingRecordedAt: ts,
      openingRecordedBy: sessionUser || "",
    };
  } else {
    book.openingCashFcfa = amount;
    book.openingCashRecorded = true;
    book.openingRecordedAt = ts;
    book.openingRecordedBy = sessionUser || "";
    if (!book.openingStockById || Object.keys(book.openingStockById).length === 0) {
      book.openingStockById = snapshot;
    }
    if (!book.openedAt) book.openedAt = ts;
  }
  state.dayBooks = [book, ...state.dayBooks.filter((b) => !(b.siteId === siteId && b.date === dateStr))];
  recordStaffAudit("update", "caisse_ouverture", `Ouverture caisse ${formatDateDdMmYyyy(dateStr)}`, `${fmt(amount)} FCFA · snapshot stock`);
  await persistState({ dayBooks: state.dayBooks });
  renderPointDuJour();
  showToast("Ouverture de caisse enregistrée. Le point du jour est disponible.");
}

function renderCashOpeningPanel() {
  const container = document.getElementById("pdj-cash-opening");
  const lockBlock = document.getElementById("pdj-locked-block");
  const mainWrap = document.getElementById("pdj-main-wrap");
  if (!container) return;
  const book = dayBookFor(pdjCalendarDate(), currentSiteId());
  const needs = dayBookNeedsCashOpening(book);
  mainWrap?.classList.remove("pdj-main--locked");
  if (lockBlock) {
    lockBlock.classList.toggle("pdj-main--locked", needs);
  }
  if (!needs && book) {
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done">
        <p class="eyebrow" style="margin-bottom:4px">Caisse ouverte</p>
        <strong>Fonds en caisse : ${fmt(book.openingCashFcfa)} FCFA</strong>
        <p class="muted" style="margin-top:8px;font-size:0.88rem">
          Enregistré ${escapeHtml(formatDateTimeDdMmYyyy(book.openingRecordedAt || book.openedAt))}
          ${book.openingRecordedBy ? ` · ${escapeHtml(book.openingRecordedBy)}` : ""}
        </p>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="pdj-opening-card">
      <p class="eyebrow" style="margin-bottom:4px">Étape obligatoire</p>
      <strong>Ouverture de caisse</strong>
      <p class="muted" style="margin-top:8px">
        Avant le point du jour, saisissez le montant réellement présent en caisse (fonds de caisse).
        Un cliché du stock à cet instant sert de référence pour la fermeture.
      </p>
      <div class="pdj-opening-form">
        <div class="form-group">
          <label for="pdj-opening-cash">Montant en caisse à l'ouverture (FCFA)</label>
          <input id="pdj-opening-cash" class="input-fcfa" type="text" inputmode="numeric" placeholder="ex: 50 000" value="">
        </div>
        <button type="button" class="btn btn-primary" id="pdj-opening-submit" style="width:auto;min-height:44px">Valider l'ouverture</button>
      </div>
    </div>`;
}

function renderSalesByProduct(ventesJour) {
  const container = document.getElementById("pdj-sales-by-product");
  const countNode = document.getElementById("pdj-sales-count");
  if (!container) return;
  const byArticle = {};
  (ventesJour || []).forEach((v) => {
    const stockItem = recordsForSite(state.stock).find((s) => s.article === v.article);
    const packSize = Math.max(1, Number(v.formatQuantite) || Number(v.packSize) || Number(stockItem?.packSize) || 1);
    const key = v.article;
    if (!byArticle[key]) byArticle[key] = { article: v.article, cat: v.cat || "", bouteilles: 0, ca: 0 };
    byArticle[key].bouteilles += (Number(v.qty) || 0) * packSize;
    byArticle[key].ca += calcNet(v);
  });
  const rows = Object.values(byArticle).sort((a, b) => b.ca - a.ca);
  if (countNode) countNode.textContent = `${rows.length} article(s)`;
  if (!rows.length) {
    container.innerHTML = emptyState("Aucune vente", "Les boissons vendues aujourd'hui apparaîtront ici.");
    return;
  }
  container.innerHTML = `
    <div class="stock-table-wrap">
      <table class="stock-table" style="min-width:620px">
        <thead>
          <tr>
            <th>Article</th>
            <th>Catégorie</th>
            <th style="text-align:right">Qté (btl)</th>
            <th style="text-align:right">CA net</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `<tr>
            <td>${escapeHtml(r.article)}</td>
            <td>${escapeHtml(r.cat)}</td>
            <td style="text-align:right;color:#1976d2">${fmt(r.bouteilles)}</td>
            <td style="text-align:right"><strong>${fmt(r.ca)} FCFA</strong></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function stockCheckForSiteDate(dateStr, siteId = currentSiteId()) {
  if (!dateStr || !siteId) return null;
  return (state.stockChecks || []).find((item) => item.siteId === siteId && item.date === dateStr) || null;
}

function todaySortiesBottlesForArticle(article, saleDateStr = pdjCalendarDate()) {
  const stockItem = recordsForSite(state.stock).find((s) => s.article === article);
  const packSize = Math.max(1, Number(stockItem?.packSize) || 1);
  return recordsForSite(state.ventes)
    .filter((v) => v.date.slice(0, 10) === saleDateStr && v.article === article)
    .reduce((sum, v) => sum + (Number(v.qty) || 0) * packSize, 0);
}

function renderDailyStockCheck() {
  const items = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const dStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  const dayBook = dayBookFor(dStr, currentSiteId());
  const container = document.getElementById("pdj-stock-check");
  const button = document.getElementById("close-day-btn");
  const printBtn = document.getElementById("print-closure-btn");
  if (!container || !button) return;
  const superadminCorrection = Boolean(closed && canAnyAdmin());
  button.textContent = superadminCorrection
    ? "Mettre a jour la cloture"
    : closed
      ? "Reverifier la journee"
      : "Verifier et cloturer";
  if (printBtn) printBtn.classList.toggle("hidden", !closed);
  if (!items.length) {
    container.innerHTML = emptyState("Aucun stock", "Ajoutez des articles avant de faire le point de fermeture.");
    button.disabled = false;
    return;
  }

  const openingBlocked = dayBookNeedsCashOpening(dayBook);
  const isPastDate = dStr !== today();
  if (openingBlocked && !(isPastDate && canAnyAdmin())) {
    container.innerHTML = emptyState(
      "Ouverture de caisse requise",
      "Validez le montant en caisse en haut de cette page avant la verification stock et la cloture.",
    );
    button.disabled = true;
    return;
  }
  button.disabled = false;

  if (closed && !canAnyAdmin()) {
    const checkItems = closed.items || [];
    const rows = checkItems.map((ci) => {
      const ecartColor = ci.ecart === 0 ? "#72d7a9" : "#ff8e82";
      const ecartLabel = ci.ecart === 0 ? "OK" : (ci.ecart > 0 ? `+${fmt(ci.ecart)}` : fmt(ci.ecart));
      return `<tr>
        <td>${escapeHtml(ci.article)}</td>
        <td style="text-align:right;color:#1976d2">${fmt(ci.stockAvant ?? ci.expected ?? 0)}</td>
        <td style="text-align:right;color:#ff8e82">${fmt(ci.sortiesToday ?? 0)}</td>
        <td style="text-align:right">${fmt(ci.expected ?? 0)}</td>
        <td style="text-align:right">${fmt(ci.frigo ?? 0)}</td>
        <td style="text-align:right">${fmt(ci.reserve ?? 0)}</td>
        <td style="text-align:right"><strong style="color:#72d7a9">${fmt(ci.stockApres ?? ci.counted ?? 0)}</strong></td>
        <td style="text-align:right;color:${ecartColor}">${ecartLabel}</td>
      </tr>`;
    }).join("");
    const hasCash = typeof closed.openingCashFcfa === "number";
    const cashBlock = hasCash
      ? `<div class="inline-card" style="margin-bottom:12px;display:grid;gap:10px">
          <strong>Caisse (espèces)</strong>
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><span class="muted">Fonds à l'ouverture</span><strong>${fmt(closed.openingCashFcfa)} FCFA</strong></div>
          ${typeof closed.closingCashFcfa === "number" ? `<div style="display:flex;justify-content:space-between"><span class="muted">Dénombrement fermeture</span><strong>${fmt(closed.closingCashFcfa)} FCFA</strong></div>` : ""}
          ${typeof closed.expectedEspecesCash === "number" ? `<div style="display:flex;justify-content:space-between"><span class="muted">Théorique caisse espèces</span><strong>${fmt(closed.expectedEspecesCash)} FCFA</strong></div>` : ""}
          ${typeof closed.cashEcartEspeces === "number"
      ? `<div style="display:flex;justify-content:space-between;color:${closed.cashEcartEspeces === 0 ? "#72d7a9" : "#ff8e82"}"><span>Écart espèces</span><strong>${closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)} FCFA`}</strong></div>`
      : ""}
        </div>`
      : "";
    container.innerHTML = `
      ${cashBlock}
      <div class="inline-card" style="margin-bottom:12px">
        <span class="muted">Journee cloturee le</span>
        <strong>${escapeHtml(formatDateTimeDdMmYyyy(closed.createdAt))}</strong>
      </div>
      <div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Article</th>
          <th class="th-orange" style="text-align:right">Stk Ouverture</th>
          <th class="th-blue" style="text-align:right">Sorties jour</th>
          <th style="text-align:right">Theorique</th>
          <th style="text-align:right">Frigo</th>
          <th style="text-align:right">Reserve</th>
          <th class="th-orange" style="text-align:right">Stk Fermeture</th>
          <th style="text-align:right">Ecart</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  } else {
    const seedFromClose = closed && canAnyAdmin() ? closed : null;
    const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
    const totauxJourOpen = paymentTotals(ventesJour);
    const especesVentes = Number(totauxJourOpen["Espèces"]) || 0;
    const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
    const especesCharges = chargesJour.reduce((sum, c) => (
      normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces") ? sum + (Number(c.montant) || 0) : sum
    ), 0);
    const openingCash = Number(dayBook?.openingCashFcfa) || 0;
    const expectedEspeces = openingCash + especesVentes - especesCharges;
    const closingSeed = seedFromClose && typeof seedFromClose.closingCashFcfa === "number"
      ? Math.round(Number(seedFromClose.closingCashFcfa))
      : null;
    const rows = items.map((item) => {
      const stockAtOpen = Number(dayBook?.openingStockById?.[String(item.id)]) || stockActuel(item); // ouverture figée
      const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
      const remaining = Math.max(0, stockAtOpen - sortiesToday); // restant théorique
      const seedCi = seedFromClose ? (seedFromClose.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
      const frigoVal = seedCi != null ? Math.max(0, Number(seedCi.frigo) || 0) : stockFrigo(item);
      const reserveVal = seedCi != null ? Math.max(0, Number(seedCi.reserve) || 0) : stockReserve(item);
      const gap = (frigoVal + reserveVal) - remaining;
      return `<tr>
        <td>${escapeHtml(item.article)}</td>
        <td style="text-align:right;color:#1976d2">${fmt(stockAtOpen)}</td>
        <td style="text-align:right;color:#ff8e82">${fmt(sortiesToday)}</td>
        <td style="text-align:right">${fmt(remaining)}</td>
        <td><input class="stock-check-input" type="number" min="0" data-check-frigo="${item.id}" value="${frigoVal}"></td>
        <td><input class="stock-check-input" type="number" min="0" data-check-reserve="${item.id}" value="${reserveVal}"></td>
        <td style="text-align:right;color:${gap === 0 ? "#72d7a9" : "#ff8e82"}">${gap === 0 ? "OK" : fmt(gap)}</td>
      </tr>`;
    }).join("");
    const correctionBanner = seedFromClose
      ? `<div class="inline-card" style="margin-bottom:12px;border-left:3px solid var(--mm-primary, #2196f3)">
        <strong>Correction de cloture (super administrateur)</strong>
        <p class="muted" style="margin-top:6px;font-size:0.86rem;line-height:1.45">
          Champs pre-remplis avec la derniere cloture du <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>.
          Ajustez frigo, reserve et caisse puis validez pour remplacer la fiche (les ecritures de stock seront recalculees).
        </p>
      </div>`
      : "";
    container.innerHTML = `
      ${correctionBanner}
      <div class="inline-card" style="margin-bottom:12px">
        <span class="muted">Référence ouverture</span>
        <strong>${escapeHtml(formatDateTimeDdMmYyyy(dayBook.openedAt))}</strong>
      </div>
      <div class="pdj-closing-cash-panel">
        <strong>Fermeture caisse (espèces)</strong>
        <p class="muted" style="margin-top:6px;font-size:0.88rem;line-height:1.45">
          Théorique en caisse : <strong>${fmt(expectedEspeces)} FCFA</strong>
          (ouverture ${fmt(openingCash)} + ventes espèces ${fmt(especesVentes)} − dépenses réglées en espèces ${fmt(especesCharges)}).
        </p>
        <div class="form-grid two-cols" style="margin-top:10px">
          <div class="form-group">
            <label for="pdj-closing-cash">Montant espèces dénombrées à la fermeture (FCFA)</label>
            <input id="pdj-closing-cash" type="number" min="0" step="1" placeholder="Comptage réel en caisse" value="${closingSeed != null ? String(closingSeed) : ""}">
          </div>
        </div>
      </div>
      <p class="muted" style="margin-bottom:10px;font-size:0.88rem">
        Saisissez le stock physique reel (frigo + reserve). L'ecart s'affiche en direct.
        ${canAnyAdmin() ? `Les ecarts sont autorises et seront enregistres dans le stock.` : `La cloture n'est possible que si chaque ligne affiche <strong>OK</strong>.`}
      </p>
      <div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Article</th>
          <th class="th-orange" style="text-align:right">Stk Ouverture</th>
          <th class="th-blue" style="text-align:right">Sorties jour</th>
          <th style="text-align:right">Theorique</th>
          <th style="text-align:right">Frigo (saisir)</th>
          <th style="text-align:right">Reserve (saisir)</th>
          <th style="text-align:right">Ecart</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }
}

function renderDashboard() {
  const site = currentSite();
  const ventes = recordsForSite(state.ventes);
  const charges = recordsForSite(state.charges);
  const stock = recordsForSite(state.stock);
  const caTotal = ventes.reduce((sum, vente) => sum + calcNet(vente), 0);
  const chargesTotal = charges.reduce((sum, charge) => sum + Number(charge.montant || 0), 0);
  const benefice = caTotal - chargesTotal;
  const objectif = Number(site?.objectifCA) || 0;
  const pct = objectif > 0 ? Math.min(100, Math.round((caTotal / objectif) * 100)) : 0;
  document.getElementById("kpi-ca").textContent = fmt(caTotal);
  document.getElementById("kpi-charges").textContent = fmt(chargesTotal);
  const beneficeNode = document.getElementById("kpi-benefice");
  beneficeNode.textContent = fmt(benefice);
  beneficeNode.className = `kpi-value ${benefice >= 0 ? "green" : "red"}`;
  document.getElementById("kpi-nb").textContent = String(ventes.length);
  document.getElementById("obj-pct").textContent = `${pct}%`;
  document.getElementById("obj-val").textContent = `/ ${fmt(objectif)} FCFA`;
  document.getElementById("obj-bar").style.width = `${pct}%`;
  renderBreakdown("cat-chart", ventes.reduce((acc, vente) => ((acc[vente.cat] = (acc[vente.cat] || 0) + calcNet(vente)), acc), {}), caTotal, "Aucune vente finalisee.");
  const alerts = stockAlertItemsForDashboard();
  document.getElementById("stock-alerts").innerHTML = alerts.length
    ? `<div class="stock-alerts-toolbar">
          <button type="button" class="mini-btn" data-stock-alert-propose-all>Toutes les alertes</button>
          <button type="button" class="mini-btn" data-stock-alert-propose-selected>Selection cochée</button>
          <button type="button" class="mini-btn mini-btn--soft" data-stock-alert-check-all>Tout cocher</button>
          <button type="button" class="mini-btn mini-btn--soft" data-stock-alert-uncheck-all>Tout décocher</button>
        </div>
        ${alerts.map((item) => `<article class="list-item">
        <label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer;flex:1;min-width:0;margin:0">
          <input type="checkbox" class="stock-alert-pick" data-stock-alert-pick="${item.id}" aria-label="Inclure ${escapeHtml(item.article)} dans une proposition groupee">
          <div style="min-width:0">
            <p class="list-item-title">${escapeHtml(item.article)}</p>
            <p class="list-item-sub">${escapeHtml(item.cat)}</p>
          </div>
        </label>
        <div class="list-side">
          <div>
            <p class="list-item-amount" style="color:#ff8e82">${fmt(stockActuel(item))} bouteilles</p>
            <p class="list-item-date">Seuil: ${fmt(item.seuilMin)}</p>
          </div>
          <button type="button" class="mini-btn" data-propose-purchase="${item.id}">Proposer commande</button>
        </div>
      </article>`).join("")}`
    : emptyState("Tout va bien", "Aucune alerte stock critique pour le moment.");
  renderBreakdown("pay-chart", paymentTotals(ventes), caTotal, "Aucun paiement disponible.");
  syncMobileBottomBadges();
}

function suggestPurchaseCases(stockItem) {
  const seuil = Math.max(0, Number(stockItem?.seuilMin) || Number(currentSite()?.seuilStock) || 5);
  const actuel = stockActuel(stockItem);
  const target = Math.max(seuil * 2, seuil); // remonter au moins à 2x le seuil
  const deficitBottles = Math.max(0, target - actuel);
  const cs = Math.max(1, Number(caseSize(stockItem)) || 24);
  const cases = Math.max(1, Math.ceil(deficitBottles / cs));
  return { cases, caseSize: cs };
}

function stockAlertItemsForDashboard() {
  const stock = recordsForSite(state.stock);
  return stock.filter((item) => stockActuel(item) <= Number(item.seuilMin));
}

/** Badges verts type WhatsApp sur la barre du bas (commandes QR, alertes stock). */
function syncMobileBottomBadges() {
  const cmd = document.getElementById("bottom-nav-badge-commandes");
  if (cmd) {
    if (qrAlertCount <= 0) {
      cmd.classList.add("hidden");
      cmd.textContent = "";
    } else {
      cmd.classList.remove("hidden");
      cmd.textContent = qrAlertCount > 99 ? "99+" : String(qrAlertCount);
    }
  }
  const stockDot = document.getElementById("bottom-nav-dot-stock");
  if (stockDot && state) {
    const n = stockAlertItemsForDashboard().length;
    stockDot.classList.toggle("hidden", n === 0);
  }
}

/** Ajoute ou fusionne une ligne au brouillon achat depuis une ligne stock. Retourne false si prix catalogue absent. */
function mergePurchaseDraftLineForStockItem(item) {
  const { cases, caseSize: cs } = suggestPurchaseCases(item);
  const price = purchasePricePerCaseFromStock(item.article);
  if (!price) return false;
  const existingIdx = purchaseDraftLines.findIndex((l) => String(l.article || "").toLowerCase() === String(item.article || "").toLowerCase());
  const line = { article: item.article, cases, caseSize: cs, pricePerCase: price, amount: Math.round(cases * price), selected: true };
  if (existingIdx >= 0) {
    const prev = purchaseDraftLines[existingIdx];
    const mergedCases = (Number(prev.cases) || 0) + cases;
    purchaseDraftLines[existingIdx] = {
      ...prev,
      cases: mergedCases,
      caseSize: prev.caseSize || cs,
      pricePerCase: prev.pricePerCase || price,
      amount: Math.round(mergedCases * (Number(prev.pricePerCase) || price || 0)),
      selected: prev.selected !== false,
    };
  } else {
    purchaseDraftLines.push(line);
  }
  return true;
}

function proposePurchaseForStockItems(items) {
  const valid = (items || []).filter(Boolean);
  if (!valid.length) {
    showToast("Aucun article dans cette proposition.");
    return;
  }
  navigate("stock");
  setStockSubTab("achats");
  openPurchaseForm();
  let added = 0;
  let skippedPrice = 0;
  valid.forEach((item) => {
    if (mergePurchaseDraftLineForStockItem(item)) added++;
    else skippedPrice++;
  });
  renderPurchaseDraft();
  document.getElementById("purchase-article").value = "";
  document.getElementById("purchase-cases").value = "";
  syncPurchaseLineInputsFromStock();
  if (!added) {
    showToast(skippedPrice ? "Prix achat manquant pour tous ces articles." : "Aucune ligne ajoutee.");
    return;
  }
  showToast(`${added} ligne(s) dans le brouillon achat.${skippedPrice ? ` ${skippedPrice} sans prix ignores.` : ""}`);
}

function proposePurchaseForStockItemId(stockItemId) {
  const item = recordsForSite(state.stock).find((s) => Number(s.id) === Number(stockItemId));
  if (!item) { showToast("Article introuvable."); return; }
  navigate("stock");
  setStockSubTab("achats");
  openPurchaseForm();
  if (!mergePurchaseDraftLineForStockItem(item)) {
    showToast("Prix achat / casier manquant dans le catalogue pour cet article.");
    renderPurchaseDraft();
    return;
  }
  const { cases, caseSize: cs } = suggestPurchaseCases(item);
  renderPurchaseDraft();
  document.getElementById("purchase-article").value = item.article;
  document.getElementById("purchase-cases").value = String(cases);
  document.getElementById("purchase-case-size").value = String(cs);
  syncPurchasePriceInput();
  showToast("Commande fournisseur proposee.");
}

function renderTabs() {
  const filters = [{ key: "all", label: "Toutes" }, ...categoryList().map((cat) => ({ key: cat, label: cat }))];
  document.getElementById("ventes-tabs").innerHTML = filters.map((filter) => `<button type="button" class="tab ${filter.key === currentFilter ? "active" : ""}" data-filter="${escapeHtml(filter.key)}">${escapeHtml(filter.label)}</button>`).join("");
}

function saleDateValue(item) {
  return String(item?.date || "").slice(0, 10);
}

function salesPeriod() {
  return {
    start: document.getElementById("sales-period-start")?.value || "",
    end: document.getElementById("sales-period-end")?.value || "",
  };
}

function salesForHistory() {
  const { start, end } = salesPeriod();
  return recordsForSite(state.ventes).filter((item) => {
    const value = saleDateValue(item);
    const categoryOk = currentFilter === "all" || item.cat === currentFilter;
    const startOk = !start || value >= start;
    const endOk = !end || value <= end;
    return categoryOk && startOk && endOk;
  });
}

function renderSalesHistory() {
  renderTabs();
  const ventes = salesForHistory().slice().sort((a, b) => b.date.localeCompare(a.date));
  const invoices = new Map();
  ventes.forEach((vente) => {
    const key = vente.factureNumber || `vente-${vente.id}`;
    if (!invoices.has(key)) {
      invoices.set(key, {
        factureNumber: vente.factureNumber || `VENTE-${vente.id}`,
        date: vente.date,
        client: vente.client || "Client comptoir",
        paiement: paymentLabel(vente),
        lignes: [],
      });
    }
    invoices.get(key).lignes.push(vente);
  });
  document.getElementById("ventes-list").innerHTML = invoices.size
    ? [...invoices.values()].map((invoice) => {
      const total = invoice.lignes.reduce((sum, line) => sum + calcNet(line), 0);
      return `<article class="order-card">
        <div class="section-head">
          <div>
            <h3>${escapeHtml(invoice.factureNumber)}</h3>
            <p class="list-item-sub">${escapeHtml(invoice.client)} · ${escapeHtml(formatDateDdMmYyyy(invoice.date))} · ${escapeHtml(invoice.paiement)}</p>
          </div>
          <div class="order-total">${fmt(total)} FCFA</div>
        </div>
        <div class="order-lines">
          ${invoice.lignes.map((vente) => `<div class="order-line"><div><p class="list-item-title">${escapeHtml(vente.article)}</p><p class="list-item-sub">${escapeHtml(vente.cat)} · ${fmt(vente.qty)} x ${fmt(vente.prix)} FCFA${vente.remise ? ` · -${fmt(vente.remise)}` : ""}</p></div><button class="del-btn" type="button" data-delete-type="vente" data-id="${vente.id}">Suppr.</button></div>`).join("")}
        </div>
        <div class="order-actions">
          <button type="button" class="mini-btn" data-print-invoice="${escapeHtml(invoice.factureNumber)}">Imprimer facture</button>
        </div>
      </article>`;
    }).join("")
    : emptyState("Aucune vente", "Finalisez une commande pour alimenter l'historique.");
  if (!canDeletePaidSale()) {
    document.querySelectorAll('#ventes-list [data-delete-type="vente"]').forEach((button) => button.remove());
  }
}

function orderStatus(order) {
  return order.status || "En attente";
}

function nextOrderStatus(status) {
  if (status === "En attente") return "Servi";
  if (status === "Servi") return "Encaisser";
  return "";
}

function canDeleteOrder(order) {
  const status = orderStatus(order);
  if (status === "Paye" || status === "PayÃ©" || status === "Payé") return canAnyAdmin();
  if (status === "Servi") return canManage();
  return canManage() || order?.server === sessionUser || order?.serveur === sessionUser;
}

function canDeletePaidSale() {
  return canAnyAdmin();
}

function orderType(order) {
  return order.type || (String(order.location || "").startsWith("Ext") ? "sur-place" : "sur-place");
}

function orderTotal(order) {
  return (order?.lignes || []).reduce((sum, line) => sum + calcNet(line), 0);
}

function orderTime(order) {
  const timeFromDate = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (order?._isPaid && Array.isArray(order.lignes) && order.lignes.length) {
    const v = order.lignes[0];
    const fromVente = String(v?.soldAt || v?.createdAt || "").trim();
    if (fromVente.includes("T")) {
      try {
        const d = new Date(fromVente);
        if (!Number.isNaN(d.getTime())) return timeFromDate(d);
      } catch (_) {
        /* ignore */
      }
    }
  }
  const raw = String(order?.createdAt || order?.updatedAt || order?.date || "");
  if (raw.includes("T")) {
    try {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return timeFromDate(d);
    } catch (_) {
      /* ignore */
    }
  }
  return "--:--";
}

function renderOrdersManagement() {
  const date = document.getElementById("orders-filter-date")?.value || today();
  const status = document.getElementById("orders-filter-status")?.value || "all";
  const type = document.getElementById("orders-filter-type")?.value || "all";
  const activeOrders = recordsForSite(state.commandes);
  const salesToday = recordsForSite(state.ventes).filter((vente) => saleDateValue(vente) === date);

  // Reconstruct paid orders from state.ventes grouped by factureNumber
  const paidByFacture = {};
  recordsForSite(state.ventes).forEach((v) => {
    const key = v.factureNumber || `V-${v.id}`;
    if (!paidByFacture[key]) {
      paidByFacture[key] = {
        id: key,
        factureNumber: v.factureNumber,
        date: v.date,
        client: v.client || v.table,
        table: v.table || v.client,
        server: v.server || v.serveur || "-",
        lignes: [],
        status: "Paye",
        _isPaid: true,
        createdAt: v.soldAt || v.createdAt,
      };
    }
    paidByFacture[key].lignes.push(v);
    const ts = v.soldAt || v.createdAt;
    if (ts && !paidByFacture[key].createdAt) paidByFacture[key].createdAt = ts;
  });
  const paidOrders = Object.values(paidByFacture);

  const baseOrders = status === "Paye"
    ? paidOrders
    : status === "all"
      ? [...activeOrders, ...paidOrders]
      : activeOrders;

  const orders = baseOrders.filter((order) => {
    const dateOk = !date || saleDateValue(order) === date;
    const statusOk = status === "all" || orderStatus(order) === status;
    const typeOk = type === "all" || orderType(order) === type;
    return dateOk && statusOk && typeOk;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  document.getElementById("orders-today-kpi").textContent = String(activeOrders.filter((order) => saleDateValue(order) === date).length + salesToday.length);
  document.getElementById("orders-pending-kpi").textContent = String(activeOrders.filter((order) => orderStatus(order) === "En attente").length);
  document.getElementById("orders-ca-kpi").textContent = `${fmt(salesToday.reduce((sum, vente) => sum + calcNet(vente), 0))} FCFA`;
  document.getElementById("orders-management-table").innerHTML = orders.length
    ? orders.map((order) => {
      const next = order._isPaid ? "" : nextOrderStatus(orderStatus(order));
      return `<tr>
        <td>#${escapeHtml(order.factureNumber || String(order.id))}</td>
        <td>${escapeHtml(order.table || order.client || "Comptoir")}</td>
        <td>${escapeHtml(order.server || order.serveur || "Client QR")}</td>
        <td>${escapeHtml(orderStatus(order))}</td>
        <td>${orderType(order) === "a-emporter" ? "A emporter" : "Sur place"}</td>
        <td style="text-align:right">${fmt((order.lignes || []).length)}</td>
        <td style="text-align:right">${fmt(orderTotal(order))} FCFA</td>
        <td>${escapeHtml(orderTime(order))}</td>
        <td>
          ${order._isPaid ? "" : `<button type="button" class="mini-btn" data-activate-order="${order.id}">Ouvrir</button>`}
          ${next ? `<button type="button" class="mini-btn" data-advance-order="${order.id}">${escapeHtml(next)}</button>` : ""}
          ${!order._isPaid && canDeleteOrder(order) ? `<button type="button" class="mini-btn" data-delete-order="${order.id}">Annuler</button>` : ""}
        </td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:44px">Aucune commande trouvee</td></tr>`;
}

function renderOrders() {
  const orders = recordsForSite(state.commandes).slice().sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("order-board").innerHTML = orders.length
    ? orders.map((order) => {
      const total = order.lignes.reduce((sum, line) => sum + calcNet(line), 0);
      const highlightClass = flashingQrOrderIds.has(order.id) ? "order-card-new" : "";
      const next = nextOrderStatus(orderStatus(order));
      const nextAction = next === "Encaisser"
        ? `<button type="button" class="mini-btn" data-finalize-order="${order.id}">Encaisser</button>`
        : next ? `<button type="button" class="mini-btn" data-advance-order="${order.id}">${escapeHtml(next)}</button>` : "";
      return `<article class="order-card ${order.id === activeOrderId ? "active" : ""} ${highlightClass}">
        <div class="section-head">
          <div>
            <h3>${escapeHtml(order.client || "Client sans nom")}</h3>
            <p class="list-item-sub">${escapeHtml(formatDateDdMmYyyy(order.date))}${order.note ? ` · ${escapeHtml(order.note)}` : ""}</p>
          </div>
          <div class="order-total">${fmt(total)} FCFA</div>
        </div>
        <div class="order-lines">
          ${order.lignes.length ? order.lignes.map((line) => `<div class="order-line"><div><p class="list-item-title">${escapeHtml(line.article)}</p><p class="list-item-sub">${escapeHtml(line.cat)} · ${fmt(line.qty)} x ${fmt(line.prix)} FCFA${line.remise ? ` · -${fmt(line.remise)}` : ""} · ${escapeHtml(line.paiement)}</p></div><div class="line-actions"><button type="button" class="mini-btn" data-edit-line="${line.id}" data-order-id="${order.id}">Modifier</button><button type="button" class="mini-btn" data-remove-line="${line.id}" data-order-id="${order.id}">Retirer</button></div></div>`).join("") : emptyState("Commande vide", "Ajoutez une premiere boisson a cette commande.")}
        </div>
        <div class="order-actions">
          <button type="button" class="mini-btn" data-activate-order="${order.id}">Ouvrir la commande</button>
          <button type="button" class="mini-btn" data-add-line-order="${order.id}">Ajouter un article</button>
          <button type="button" class="mini-btn" data-print-order="${order.id}">Ticket</button>
          ${nextAction}
          ${canDeleteOrder(order) ? `<button type="button" class="mini-btn" data-delete-order="${order.id}">Annuler commande</button>` : ""}
        </div>
      </article>`;
    }).join("")
    : emptyState("Aucune commande en cours", "Créez une commande client, ajoutez des boissons puis finalisez la facture.");
  populateOrderSelect();
}

function renderVentesPage() {
  document.getElementById("articles-list").innerHTML = knownProducts().map((item) => `<option value="${escapeHtml(item.article)}">`).join("");
  if (document.getElementById("modal-vente")?.classList.contains("open")) renderVenteArticlePicker();
  renderOrdersManagement();
  renderQrAlertBadge();
  renderOrders();
  renderSalesHistory();
  renderCreditRecovery();
}

function qrLocationLabel(location) {
  return String(location).startsWith("Ext") ? "Exterieur" : "Interieur";
}

function qrTableLabels() {
  const manual = document.getElementById("qr-table").value.trim();
  const count = Math.max(1, Math.min(200, Number(document.getElementById("qr-count")?.value) || 1));
  if (manual && count === 1) return [manual];
  const prefix = document.getElementById("qr-prefix")?.value.trim() || "Table";
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);
}

function qrRows() {
  const alias = document.getElementById("qr-alias").value.trim();
  return qrTableLabels().map((table) => ({
    table,
    alias: alias || table,
    intLink: buildQrOrderLink("IntÃ©rieur", table, alias || table),
    extLink: buildQrOrderLink("ExtÃ©rieur", table, alias || table),
  }));
}

function buildQrOrderLink(location, tableOverride = null, aliasOverride = null) {
  const site = currentSite();
  if (!site) return "";
  const table = tableOverride ?? document.getElementById("qr-table").value.trim();
  const alias = aliasOverride ?? document.getElementById("qr-alias").value.trim();
  const url = new URL("/order.html", window.location.origin);
  url.searchParams.set("site", site.id);
  url.searchParams.set("location", location);
  if (table) url.searchParams.set("table", table);
  if (alias) url.searchParams.set("alias", alias);
  return url.toString();
}

function renderQrPreview() {
  const card = document.getElementById("qr-card-preview");
  currentQrLinkInt = buildQrOrderLink("Intérieur");
  currentQrLinkExt = buildQrOrderLink("Extérieur");
  if (!currentQrLinkInt) {
    card.classList.add("hidden");
    return;
  }
  const site = currentSite();
  const table = document.getElementById("qr-table").value.trim() || "Comptoir";
  const siteName = site?.nom || "Maquis";

  document.getElementById("qr-preview-title-int").textContent = `${siteName} · ${table} · Intérieur`;
  document.getElementById("qr-preview-link-int").href = currentQrLinkInt;
  document.getElementById("qr-preview-link-int").textContent = "Ouvrir le menu intérieur";
  document.getElementById("qr-preview-image-int").src = `https://quickchart.io/qr?size=180&text=${encodeURIComponent(currentQrLinkInt)}`;

  document.getElementById("qr-preview-title-ext").textContent = `${siteName} · ${table} · Extérieur`;
  document.getElementById("qr-preview-link-ext").href = currentQrLinkExt;
  document.getElementById("qr-preview-link-ext").textContent = "Ouvrir le menu extérieur";
  document.getElementById("qr-preview-image-ext").src = `https://quickchart.io/qr?size=180&text=${encodeURIComponent(currentQrLinkExt)}`;

  card.classList.remove("hidden");
}

function printQrCard(location) {
  if (!currentQrLinkInt) renderQrPreview();
  const link = location === "Extérieur" ? currentQrLinkExt : currentQrLinkInt;
  if (!link) { showToast("Impossible de generer le lien QR."); return; }
  const site = currentSite();
  const table = document.getElementById("qr-table").value.trim() || "Comptoir";
  const locationLabel = location;
  const qrImage = `https://quickchart.io/qr?size=320&text=${encodeURIComponent(link)}`;
  const ticketWindow = window.open("", "_blank", "width=800,height=900");
  if (!ticketWindow) { showToast("Impossible d'ouvrir l'impression."); return; }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR ${escapeHtml(locationLabel)} - ${escapeHtml(table)}</title><style>body{font-family:Arial,sans-serif;padding:32px;text-align:center;color:#111}img{width:320px;height:320px;background:#fff;padding:12px;border-radius:18px}h1,h2,p{margin:0 0 12px}.box{border:2px solid #111;border-radius:22px;padding:24px;max-width:520px;margin:0 auto}.loc{display:inline-block;background:#111;color:#fff;padding:4px 18px;border-radius:20px;font-size:14px;margin-bottom:12px}</style></head><body><div class="box"><h1>${escapeHtml(site?.nom || "Maquis")}</h1><div class="loc">${escapeHtml(locationLabel)}</div><p>Table: ${escapeHtml(table)}</p><img src="${qrImage}" alt="QR commande"><p>Scannez pour voir le menu et commander</p></div><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function qrRows() {
  const alias = document.getElementById("qr-alias").value.trim();
  return qrTableLabels().map((table) => ({
    table,
    alias: alias || table,
    intLink: buildQrOrderLink("Interieur", table, alias || table),
    extLink: buildQrOrderLink("Exterieur", table, alias || table),
  }));
}

function renderQrPreview() {
  const card = document.getElementById("qr-card-preview");
  const rows = qrRows();
  currentQrLinkInt = rows[0]?.intLink || "";
  currentQrLinkExt = rows[0]?.extLink || "";
  if (!currentQrLinkInt) {
    card.classList.add("hidden");
    return;
  }
  const siteName = currentSite()?.nom || "Maquis";
  const list = document.getElementById("qr-table-list");
  const oldPreview = [...card.children].find((child) => child.classList?.contains("qr-two-cols"));
  if (oldPreview) oldPreview.classList.add("hidden");
  list.innerHTML = rows.map((row) => `
    <article class="qr-table-card">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(row.table)}</h3>
          <p class="list-item-sub">${escapeHtml(siteName)}</p>
        </div>
        <button type="button" class="mini-btn" data-print-qr-table="${escapeHtml(row.table)}">Imprimer cette table</button>
      </div>
      <div class="qr-two-cols">
        <div class="qr-location-card">
          <div class="qr-location-header">Interieur (cave)</div>
          <div class="qr-card-box">
            <img src="https://quickchart.io/qr?size=180&text=${encodeURIComponent(row.intLink)}" alt="QR Interieur ${escapeHtml(row.table)}">
            <div>
              <p class="list-item-title">${escapeHtml(row.table)} - Interieur</p>
              <a class="qr-link" href="${escapeHtml(row.intLink)}" target="_blank" rel="noopener noreferrer">Ouvrir</a>
            </div>
          </div>
        </div>
        <div class="qr-location-card">
          <div class="qr-location-header">Exterieur (terrasse)</div>
          <div class="qr-card-box">
            <img src="https://quickchart.io/qr?size=180&text=${encodeURIComponent(row.extLink)}" alt="QR Exterieur ${escapeHtml(row.table)}">
            <div>
              <p class="list-item-title">${escapeHtml(row.table)} - Exterieur</p>
              <a class="qr-link" href="${escapeHtml(row.extLink)}" target="_blank" rel="noopener noreferrer">Ouvrir</a>
            </div>
          </div>
        </div>
      </div>
    </article>
  `).join("");
  card.classList.remove("hidden");
}

function printQrCard(location, tableOverride = null, linkOverride = null) {
  if (!currentQrLinkInt) renderQrPreview();
  const table = tableOverride || qrTableLabels()[0] || "Comptoir";
  const link = linkOverride || (String(location).startsWith("Ext") ? currentQrLinkExt : currentQrLinkInt);
  if (!link) { showToast("Impossible de generer le lien QR."); return; }
  const site = currentSite();
  const locationLabel = qrLocationLabel(location);
  const qrImage = `https://quickchart.io/qr?size=320&text=${encodeURIComponent(link)}`;
  const ticketWindow = window.open("", "_blank", "width=800,height=900");
  if (!ticketWindow) { showToast("Impossible d'ouvrir l'impression."); return; }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR ${escapeHtml(locationLabel)} - ${escapeHtml(table)}</title><style>body{font-family:Arial,sans-serif;padding:32px;text-align:center;color:#111}img{width:320px;height:320px;background:#fff;padding:12px;border-radius:18px}h1,p{margin:0 0 12px}.box{border:2px solid #111;border-radius:22px;padding:24px;max-width:520px;margin:0 auto}.loc{display:inline-block;background:#111;color:#fff;padding:4px 18px;border-radius:20px;font-size:14px;margin-bottom:12px}</style></head><body><div class="box"><h1>${escapeHtml(site?.nom || "Maquis")}</h1><div class="loc">${escapeHtml(locationLabel)}</div><p>Table: ${escapeHtml(table)}</p><img src="${qrImage}" alt="QR commande"><p>Scannez pour voir le menu et commander</p></div><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function printQrTable(table) {
  const row = qrRows().find((item) => item.table === table);
  if (!row) return;
  printAllQrTables([row]);
}

function printAllQrTables(rowsOverride = null) {
  const rows = rowsOverride || qrRows();
  if (!rows.length) { showToast("Aucun QR code a imprimer."); return; }
  const siteName = currentSite()?.nom || "Maquis";
  const ticketWindow = window.open("", "_blank", "width=1000,height=900");
  if (!ticketWindow) { showToast("Impossible d'ouvrir l'impression."); return; }
  const cards = rows.map((row) => `
    <section class="table-block">
      <h2>${escapeHtml(siteName)} - ${escapeHtml(row.table)}</h2>
      <div class="grid">
        <div><strong>Interieur</strong><img src="https://quickchart.io/qr?size=260&text=${encodeURIComponent(row.intLink)}" alt="QR Interieur"></div>
        <div><strong>Exterieur</strong><img src="https://quickchart.io/qr?size=260&text=${encodeURIComponent(row.extLink)}" alt="QR Exterieur"></div>
      </div>
      <p>Scannez pour voir le menu et commander.</p>
    </section>
  `).join("");
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR codes tables</title><style>body{font-family:Arial,sans-serif;color:#111;padding:22px}.table-block{break-inside:avoid;page-break-inside:avoid;border:2px solid #111;border-radius:18px;padding:18px;margin:0 0 18px;text-align:center}h2{margin:0 0 14px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px}img{display:block;width:260px;height:260px;margin:10px auto;background:#fff;padding:8px;border:1px solid #ddd;border-radius:14px}p{margin:8px 0 0}@media print{body{padding:0}.table-block{page-break-inside:avoid}}</style></head><body>${cards}<script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function renderStock() {
  const allItems = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const term = String(stockSearchTerm || "").trim().toLowerCase();
  const items = term
    ? allItems.filter((item) => String(item.article || "").toLowerCase().includes(term))
    : allItems;
  const site = currentSite();
  const globalSeuil = Number(site?.seuilStock) || 5;
  let totalValue = 0;
  let nbAlerte = 0;
  let nbOk = 0;

  const rows = items.map((item) => {
    const actuel = stockActuel(item);
    const frigo = stockFrigo(item);
    const reserve = stockReserve(item);
    const valeur = casesFromBottles(actuel, item) * (Number(item.prixAchat) || 0);
    totalValue += valeur;
    const seuilFrigo = Number(item.seuilMin) || globalSeuil;
    const isFrigoLow = frigo <= seuilFrigo;
    const isAlert = actuel <= Number(item.seuilMin) || isFrigoLow;
    if (isAlert) nbAlerte++; else nbOk++;

    let statusBadge;
    if (actuel <= 0) statusBadge = `<span class="badge badge-red">RUPTURE</span>`;
    else if (actuel <= Number(item.seuilMin)) statusBadge = `<span class="badge badge-red">CRITIQUE</span>`;
    else if (actuel <= Number(item.seuilMin) * 2) statusBadge = `<span class="badge badge-amber">FAIBLE</span>`;
    else statusBadge = `<span class="stock-ok-badge">✓ OK</span>`;

    const packSize = Math.max(1, Number(item.packSize) || 1);
    const { prixInt, prixExt } = resolveItemPrices(item);
    const packCell = packSize > 1 ? `<span class="badge badge-amber">Kit de ${packSize}</span>` : `<span style="color:var(--muted)">Unite</span>`;
    const itemCaseSize = caseSize(item);

    const D = "scd"; // classe colonne detail
    return `<tr class="${isAlert ? "stock-row-alert" : ""}">
      <td>${escapeHtml(item.article)}</td>
      <td class="${D}">${escapeHtml(item.cat)}</td>
      <td class="${D}" style="text-align:center">${packCell}</td>
      <td class="${D}" style="text-align:center">${fmt(itemCaseSize)}</td>
      <td style="text-align:right">${fmt(frigo)}</td>
      <td style="text-align:right">${fmt(reserve)}</td>
      <td class="${D}" style="text-align:right">${fmt(casesFromBottles(item.init, item))} cas.</td>
      <td class="${D}" style="text-align:right">${fmt(casesFromBottles(item.entrees, item))} cas.</td>
      <td class="${D}" style="text-align:right">${fmt(item.sorties || 0)}</td>
      <td style="text-align:right"><strong>${fmt(actuel)}</strong></td>
      <td style="text-align:right">${fmt(item.seuilMin)}</td>
      <td class="${D}" style="text-align:right">${fmt(item.prixAchat || 0)} / cas.</td>
      <td class="${D}" style="text-align:right">${fmt(prixInt)}</td>
      <td class="${D}" style="text-align:right">${fmt(prixExt)}</td>
      <td class="${D}" style="text-align:right">${fmt(valeur)}</td>
      <td>${statusBadge}</td>
      <td class="stock-actions-cell">
        ${isFrigoLow && reserve > 0 ? `<button type="button" class="mini-btn" data-auto-fill-fridge="${item.id}">Remplir frigo</button>` : ""}
        <button type="button" class="stock-del-btn" style="background:rgba(197,79,65,0.18);color:#ff8e82" data-perte-id="${item.id}">Perte</button>
        ${canAnyAdmin() ? `<button type="button" class="mini-btn" data-edit-stock="${item.id}">Modifier</button>
        <button class="stock-del-btn" type="button" data-delete-type="stock" data-id="${item.id}">Suppr.</button>` : ""}
      </td>
    </tr>`;
  }).join("");

  document.getElementById("stock-nb").textContent = term ? `${items.length}/${allItems.length}` : String(allItems.length);
  document.getElementById("stock-val").textContent = `${fmt(totalValue)} FCFA`;
  document.getElementById("stock-alerte").textContent = String(nbAlerte);
  document.getElementById("stock-ok").textContent = String(nbOk);
  document.getElementById("stock-seuil").textContent = String(globalSeuil);

  const toggleBtn = document.getElementById("toggle-stock-detail-btn");
  if (toggleBtn) toggleBtn.textContent = stockTableCompact ? "Vue complete" : "Vue simple";

  document.getElementById("stock-list").innerHTML = items.length
    ? `<div class="stock-table-wrap"><table class="stock-table${stockTableCompact ? " stock-compact" : ""}">
        <thead>
          <tr>
            <th class="th-orange">Article</th>
            <th class="th-orange scd">Categorie</th>
            <th class="th-orange scd" style="text-align:center">Btl / kit</th>
            <th class="th-orange scd" style="text-align:center">Btl / casier</th>
            <th class="th-blue" style="text-align:right">Frigo</th>
            <th class="th-blue" style="text-align:right">Reserve</th>
            <th class="th-orange scd" style="text-align:right">Stk Initial</th>
            <th class="th-orange scd" style="text-align:right">Entrees</th>
            <th class="th-blue scd" style="text-align:right">Sorties</th>
            <th class="th-blue" style="text-align:right">Stk Actuel</th>
            <th class="th-orange" style="text-align:right">Seuil</th>
            <th class="th-orange scd" style="text-align:right">Prix Achat / cas.</th>
            <th class="th-orange scd" style="text-align:right">Prix Vente Int.</th>
            <th class="th-orange scd" style="text-align:right">Prix Vente Ext.</th>
            <th class="th-blue scd" style="text-align:right">Valeur Stk</th>
            <th class="th-blue">Statut</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : term
      ? emptyState("Aucun resultat", `Aucun article ne correspond a "${stockSearchTerm}".`)
      : emptyState("Stock vide", "Ajoutez un article pour construire le catalogue.");
  renderStockMovements();
}

function renderCharges() {
  const chargesForSite = recordsForSite(state.charges);
  const total = chargesForSite.reduce((sum, charge) => sum + Number(charge.montant || 0), 0);
  document.getElementById("charges-total").textContent = `${fmt(total)} FCFA`;
  const charges = chargesForSite.slice().sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("charges-list").innerHTML = charges.length
    ? charges.map((charge) => `<article class="list-item"><div><p class="list-item-title">${escapeHtml(charge.lib)}</p><p class="list-item-sub">${escapeHtml(charge.cat)} · ${escapeHtml(charge.paiement)}</p></div><div class="list-side"><div><p class="list-item-amount" style="color:#ff8e82">${fmt(charge.montant)} FCFA</p><p class="list-item-date">${escapeHtml(formatDateDdMmYyyy(charge.date))}</p></div><button class="del-btn" type="button" data-delete-type="charge" data-id="${charge.id}">Suppr.</button></div></article>`).join("")
    : emptyState("Aucune charge", "Ajoutez une depense pour suivre les sorties du mois.");
  refreshCreanciersIfVisible();
}

function normalizePaymentKeyForCreditor(paiement) {
  return String(paiement || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function isSupplierCreditPayment(paiement) {
  const s = normalizePaymentKeyForCreditor(paiement);
  return s.includes("credit") && s.includes("fournisseur");
}

function refreshCreanciersIfVisible() {
  if (currentPage === "stock" && stockSubTab === "creanciers") renderCreanciers();
}

function renderCreanciers() {
  const kpiPending = document.getElementById("creanciers-kpi-pending");
  const kpiCharges = document.getElementById("creanciers-kpi-charges");
  const pendingEl = document.getElementById("creanciers-pending-list");
  const chargesEl = document.getElementById("creanciers-charges-list");
  if (!pendingEl || !chargesEl || !kpiPending || !kpiCharges) return;

  const pendingOrders = purchaseOrdersForSite().filter(
    (po) => po.status !== "Reçue" && po.status !== "Annulée" && isSupplierCreditPayment(po.payment),
  );
  const pendingTotal = pendingOrders.reduce((sum, po) => sum + (Number(po.total) || 0), 0);
  kpiPending.textContent = `${fmt(pendingTotal)} FCFA`;

  pendingEl.innerHTML = pendingOrders.length
    ? pendingOrders.map((po) => `
      <article class="list-item">
        <div>
          <p class="list-item-title">${escapeHtml(po.supplier || "Fournisseur")}</p>
          <p class="list-item-sub">${escapeHtml(po.date ? formatDateDdMmYyyy(po.date) : "")} · ${escapeHtml(po.payment || "")}</p>
        </div>
        <div class="list-side">
          <p class="list-item-amount">${fmt(po.total || 0)} FCFA</p>
          <span class="badge badge-amber">${escapeHtml(po.status || "En attente")}</span>
        </div>
      </article>`).join("")
    : emptyState("Aucune commande a credit en attente", "Creez une commande fournisseur avec paiement Credit fournisseur.");

  const creditCharges = recordsForSite(state.charges || [])
    .filter((c) => isSupplierCreditPayment(c.paiement))
    .slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  const chargesTotal = creditCharges.reduce((sum, c) => sum + (Number(c.montant) || 0), 0);
  kpiCharges.textContent = `${fmt(chargesTotal)} FCFA`;

  chargesEl.innerHTML = creditCharges.length
    ? creditCharges.map((charge) => `
      <article class="list-item">
        <div>
          <p class="list-item-title">${escapeHtml(charge.lib)}</p>
          <p class="list-item-sub">${escapeHtml(charge.cat)} · ${escapeHtml(charge.date ? formatDateDdMmYyyy(charge.date) : "")}</p>
        </div>
        <div class="list-side">
          <p class="list-item-amount" style="color:#ff8e82">${fmt(charge.montant)} FCFA</p>
          <button class="del-btn" type="button" data-delete-type="charge" data-id="${charge.id}">Suppr.</button>
        </div>
      </article>`).join("")
    : emptyState("Aucune dette fournisseur en charges", "Une charge apparait quand vous receptionnez une commande au credit.");
}

function renderUserSiteCheckboxes() {
  const section = document.getElementById("new-user-sites-section");
  const container = document.getElementById("new-user-sites");
  section.classList.remove("hidden");
  const selectedIds = new Set(
    [...container.querySelectorAll("[data-site-id]:checked")].map((input) => input.dataset.siteId),
  );
  // Manager ne peut rattacher que ses propres maquis ; admin voit tout
  const visibleSites = canSuperAdmin()
    ? (state.sites || [])
    : (state.sites || []).filter((site) => allowedSiteIds.includes(site.id));
  container.innerHTML = visibleSites.map((site) => `
    <label class="checkbox-row">
      <span>
        <strong>${escapeHtml(site.nom)}</strong>
        <span class="list-item-sub">${escapeHtml(site.ville || "")}</span>
      </span>
      <input type="checkbox" data-site-id="${escapeHtml(site.id)}" ${selectedIds.size === 0 || selectedIds.has(site.id) ? "checked" : ""}>
    </label>
  `).join("");
}

function renderEditableUserSites(user) {
  const container = document.getElementById("new-user-sites");
  const visibleSites = canSuperAdmin()
    ? (state.sites || [])
    : (state.sites || []).filter((site) => allowedSiteIds.includes(site.id));
  container.innerHTML = visibleSites.map((site) => `
    <label class="checkbox-row">
      <span>
        <strong>${escapeHtml(site.nom)}</strong>
        <span class="list-item-sub">${escapeHtml(site.ville || "")}</span>
      </span>
      <input type="checkbox" data-site-id="${escapeHtml(site.id)}" ${(user.allowedSiteIds || []).includes(site.id) ? "checked" : ""}>
    </label>
  `).join("");
}

function resetUserForm() {
  document.getElementById("edit-user-username").value = "";
  document.getElementById("new-user-username").value = "";
  document.getElementById("new-user-username").disabled = false;
  document.getElementById("new-user-role").value = "serveuse";
  document.getElementById("new-user-password").value = "";
  document.getElementById("new-user-password").placeholder = "Obligatoire a la creation";
  document.getElementById("add-user-btn").textContent = "Ajouter l'utilisateur";
  document.getElementById("cancel-edit-user-btn").classList.add("hidden");
  renderUserSiteCheckboxes();
}

function editUser(username) {
  const user = (state.auth.users || []).find((item) => item.username === username);
  if (!user) return;
  document.getElementById("edit-user-username").value = user.username;
  document.getElementById("new-user-username").value = user.username;
  document.getElementById("new-user-username").disabled = true;
  document.getElementById("new-user-role").value = String(user.username || "").trim().toLowerCase() === "admin" ? "superadmin" : user.role;
  document.getElementById("new-user-password").value = "";
  document.getElementById("new-user-password").placeholder = "Laisser vide pour garder l'ancien";
  document.getElementById("add-user-btn").textContent = "Enregistrer les modifications";
  document.getElementById("cancel-edit-user-btn").classList.remove("hidden");
  renderEditableUserSites(user);
}

function roleLabel(role, username = "") {
  if (String(username || "").trim().toLowerCase() === "admin") return "Super administrateur";
  if (role === "superadmin") return "Super administrateur";
  if (role === "admin") return "Administrateur de maquis";
  if (role === "manager") return "Gerant";
  return "Serveuse";
}

function renderUsersList() {
  const container = document.getElementById("users-list");
  if (!container) return;
  const allUsers = state.auth.users || [];
  // Manager ne voit que les serveuses de ses propres maquis
  const users = canSuperAdmin() || canSiteAdmin()
    ? allUsers
    : allUsers.filter((u) => u.role === "serveuse" && (u.allowedSiteIds || []).some((sid) => allowedSiteIds.includes(sid)));
  if (!users.length) {
    container.innerHTML = emptyState("Aucun utilisateur", "Ajoutez des serveuses ci-dessous.");
    return;
  }
  container.innerHTML = users.map((user) => {
    const siteNames = (user.allowedSiteIds || []).map((sid) => {
      const site = (state.sites || []).find((s) => s.id === sid);
      return site ? escapeHtml(site.nom) : escapeHtml(sid);
    }).join(", ") || "Aucun maquis";
    const twoFaBadge = user.twoFactorEnabled
      ? `<span class="badge badge-green" style="margin-left:6px">2FA</span>`
      : `<span class="badge badge-red" style="margin-left:6px">Sans 2FA</span>`;
    const canEdit = canAnyAdmin() || user.role === "serveuse";
    const canDelete = user.username !== sessionUser && (canAnyAdmin() || user.role === "serveuse");
    return `
      <div class="site-row">
        <div>
          <p class="list-item-title">${escapeHtml(user.username)}${twoFaBadge}</p>
          <p class="list-item-sub">${roleLabel(user.role, user.username)} · ${siteNames}</p>
        </div>
        <div class="line-actions">
          ${canEdit ? `<button type="button" class="mini-btn" data-edit-user="${escapeHtml(user.username)}">Modifier</button>` : ""}
          ${user.username === sessionUser
            ? `<span class="list-item-sub">Connecte(e)</span>`
            : canDelete ? `<button type="button" class="mini-btn" data-delete-user="${escapeHtml(user.username)}">Supprimer</button>` : ""}
          ${user.twoFactorEnabled
            ? `<button type="button" class="mini-btn" data-disable-2fa="${escapeHtml(user.username)}">Desactiver 2FA</button>`
            : `<button type="button" class="mini-btn" data-setup-2fa="${escapeHtml(user.username)}">Activer 2FA</button>`}
        </div>
      </div>
    `;
  }).join("");
}

async function addUser() {
  const editUsername = document.getElementById("edit-user-username").value;
  const username = document.getElementById("new-user-username").value.trim();
  const password = document.getElementById("new-user-password").value;
  const role = document.getElementById("new-user-role").value;
  if (String(username || "").trim().toLowerCase() === "admin" && role !== "superadmin") {
    showToast('Le compte "admin" doit rester super administrateur (tous les maquis).');
    return;
  }
  if (!username || (!editUsername && !password)) {
    showToast("Nom d'utilisateur et mot de passe obligatoires.");
    return;
  }
  const users = state.auth.users || [];
  if (currentRole === "manager" && role !== "serveuse") {
    showToast("Les gerants peuvent uniquement creer des comptes serveuse.");
    return;
  }
  if (!canSuperAdmin() && canSiteAdmin() && (role === "superadmin" || role === "admin")) {
    showToast("Seul le super administrateur peut creer ce type de compte.");
    return;
  }
  const effectiveSessionRole =
    String(sessionUser || "").trim().toLowerCase() === "admin" ? "superadmin" : currentRole;
  if (editUsername && editUsername === sessionUser && role !== effectiveSessionRole) {
    showToast("Vous ne pouvez pas modifier votre propre role.");
    return;
  }
  if (!editUsername && users.some((u) => u.username === username)) {
    showToast("Ce nom d'utilisateur existe deja.");
    return;
  }
  const selectedSiteIds = [...document.querySelectorAll("[data-site-id]:checked")].map((cb) => cb.dataset.siteId);
  if (!selectedSiteIds.length) {
    showToast(role === "serveuse" ? "Selectionnez au moins un maquis pour la serveuse." : "Selectionnez au moins un maquis.");
    return;
  }
  let allowedSiteIds = selectedSiteIds;
  if (editUsername && !canSuperAdmin()) {
    const targetUser = users.find((user) => user.username === editUsername);
    const hiddenSiteIds = (targetUser?.allowedSiteIds || []).filter((siteId) => !canAccessSite(siteId));
    allowedSiteIds = [...new Set([...selectedSiteIds, ...hiddenSiteIds])];
  }
  const newUsers = editUsername
    ? users.map((user) => user.username === editUsername
      ? { ...user, username, ...(password ? { password } : {}), role, allowedSiteIds }
      : user)
    : [...users, { username, password, role, allowedSiteIds }];
  await persistState({ auth: { users: newUsers } });
  const saved = (state.auth.users || []).find((user) => user.username === username);
  if (!saved || saved.role !== role || JSON.stringify([...(saved.allowedSiteIds || [])].sort()) !== JSON.stringify([...allowedSiteIds].sort())) {
    showToast("La modification n'a pas ete sauvegardee par le serveur.");
    return;
  }
  resetUserForm();
  renderUsersList();
  showToast(editUsername ? `Utilisateur "${username}" modifie.` : `Utilisateur "${username}" ajoute.`);
}

async function deleteUser(username) {
  const users = state.auth.users || [];
  const target = users.find((u) => u.username === username);
  if (currentRole === "manager" && target?.role !== "serveuse") {
    showToast("Seul un administrateur peut supprimer un gerant.");
    return;
  }
  const remaining = users.filter((u) => u.username !== username);
  if (!remaining.some((u) => ["superadmin", "admin", "manager"].includes(u.role))) {
    showToast("Impossible de supprimer le dernier compte de gestion.");
    return;
  }
  await persistState({ auth: { users: remaining } });
  renderUsersList();
  showToast(`Utilisateur "${username}" supprime.`);
}

function renderSitesList() {
  const container = document.getElementById("sites-list");
  if (!container) return;
  if (!canSuperAdmin()) {
    container.innerHTML = "";
    return;
  }
  const sites = state.sites || [];
  if (!sites.length) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:12px 0">Aucun maquis enregistre.</p>`;
    return;
  }
  container.innerHTML = sites.map((site) => `
    <article class="list-item">
      <div>
        <p class="list-item-title">${escapeHtml(site.nom)}</p>
        <p class="list-item-sub">${escapeHtml(site.id)}${site.ville ? " · " + escapeHtml(site.ville) : ""}${site.pays ? ", " + escapeHtml(site.pays) : ""}</p>
      </div>
      <button type="button" class="btn btn-danger btn-sm" data-delete-site="${escapeHtml(site.id)}">Supprimer</button>
    </article>`).join("");
}

async function addSite() {
  if (!canSuperAdmin()) {
    showToast("Seul le super administrateur peut creer un maquis.");
    return;
  }
  const nom = document.getElementById("new-site-nom").value.trim();
  const rawId = document.getElementById("new-site-id").value.trim();
  const ville = document.getElementById("new-site-ville").value.trim();
  const pays = document.getElementById("new-site-pays").value.trim();
  if (!nom) { showToast("Le nom du maquis est obligatoire."); return; }
  const siteId = rawId || nom.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if ((state.sites || []).some((s) => s.id === siteId)) {
    showToast(`Un maquis avec l'identifiant "${siteId}" existe deja.`);
    return;
  }
  const newSite = { id: siteId, nom, ville, pays };
  const newSites = [...(state.sites || []), newSite];
  const newUsers = (state.auth?.users || []).map((user) => {
    const currentAllowed = new Set(user.allowedSiteIds || []);
    if (user.username === sessionUser || user.role === "superadmin" || user.role === "admin" || (canSuperAdmin() && user.role === "manager")) {
      currentAllowed.add(siteId);
    }
    return { ...user, allowedSiteIds: [...currentAllowed] };
  });
  await persistState({ sites: newSites, auth: { users: newUsers } });
  allowedSiteIds = canSuperAdmin()
    ? (state.sites || []).map((s) => s.id)
    : [...new Set([...allowedSiteIds, siteId])];
  document.getElementById("new-site-nom").value = "";
  document.getElementById("new-site-id").value = "";
  document.getElementById("new-site-ville").value = "";
  document.getElementById("new-site-pays").value = "";
  renderSitesList();
  renderSiteSwitcher();
  resetUserForm();
  renderUserSiteCheckboxes();
  renderUsersList();
  showToast(`Maquis "${nom}" cree.`);
}

async function deleteSite(siteId) {
  if (!canSuperAdmin()) {
    showToast("Seul le super administrateur peut supprimer un maquis.");
    return;
  }
  const site = (state.sites || []).find((s) => s.id === siteId);
  if (!site) return;
  if ((state.sites || []).length <= 1) {
    showToast("Impossible de supprimer le dernier maquis.");
    return;
  }
  const newSites = (state.sites || []).filter((s) => s.id !== siteId);
  await persistState({ sites: newSites });
  if (canSuperAdmin()) allowedSiteIds = (state.sites || []).map((s) => s.id);
  if (state.activeSiteId === siteId) {
    await persistState({ activeSiteId: newSites[0]?.id || null });
  }
  renderSitesList();
  renderSiteSwitcher();
  renderUserSiteCheckboxes();
  renderUsersList();
  showToast(`Maquis "${site.nom}" supprime.`);
}

function loadParamsForm() {
  const site = currentSite();
  document.getElementById("p-nom").value = site?.nom || "";
  document.getElementById("p-ville").value = site?.ville || "";
  document.getElementById("p-pays").value = site?.pays || "";
  document.getElementById("p-gerant").value = site?.gerant || "";
  document.getElementById("p-obj").value = site?.objectifCA || 500000;
  document.getElementById("p-seuil").value = site?.seuilStock || 5;
  document.getElementById("p-prefixe").value = site?.prefixeFacture || "";
  const categoriesField = document.getElementById("p-categories");
  if (categoriesField) {
    const saved = Array.isArray(state?.categories) && state.categories.length ? state.categories : CATEGORIES;
    categoriesField.value = saved.map((cat) => String(cat || "").trim()).filter(Boolean).join("\n");
  }
  renderUsersList();
  renderUserSiteCheckboxes();
  renderSitesList();
  renderStaffAuditLog();
}

function populateOrderSelect() {
  const orders = recordsForSite(state.commandes).map((order) => ({ value: String(order.id), label: order.client || `Commande ${order.id}` }));
  const options = [{ value: "", label: "Nouvelle commande" }, ...orders];
  document.getElementById("v-order-select").innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  document.getElementById("v-order-select").value = activeOrderId ? String(activeOrderId) : "";
}

function currentOrder() {
  return recordsForSite(state.commandes).find((order) => order.id === activeOrderId) || null;
}

function openOrderEditor(orderId = null, lineId = null) {
  activeOrderId = orderId;
  editingLineId = lineId;
  const order = orderId ? recordsForSite(state.commandes).find((item) => item.id === orderId) : null;
  const line = order && lineId ? order.lignes.find((item) => item.id === lineId) : null;
  populateOrderSelect();
  document.getElementById("v-date").value = line?.date || order?.date || today();
  document.getElementById("v-client").value = order?.client || "";
  document.getElementById("v-order-select").value = order ? String(order.id) : "";
  document.getElementById("v-article").value = line?.article || "";
  document.getElementById("v-location").value = line?.location || "Intérieur";
  populateSaleFormatSelect(findKnownProduct(line?.article || ""), line?.formatQuantite || line?.packSize);
  document.getElementById("v-prix").value = line?.prix ? String(line.prix) : "";
  document.getElementById("v-qty").value = line?.qty ? String(line.qty) : "1";
  document.getElementById("v-remise").value = line?.remise ? String(line.remise) : "0";
  document.getElementById("v-note").value = line?.note || order?.note || "";
  document.getElementById("save-vente-btn").textContent = line ? "Mettre a jour la ligne" : "Ajouter un article";
  document.getElementById("finalize-order-btn").disabled = !order;
  updateKitInfo();
  updateVentePreview();
  const vSearch = document.getElementById("v-article-search");
  if (vSearch) vSearch.value = "";
  renderVenteArticlePicker();
  openModal("modal-vente");
  window.requestAnimationFrame(() => document.getElementById("v-article-search")?.focus());
}

function resetOrderForm() {
  editingLineId = null;
  document.getElementById("v-date").value = today();
  document.getElementById("v-client").value = "";
  document.getElementById("v-order-select").value = activeOrderId ? String(activeOrderId) : "";
  document.getElementById("v-article").value = "";
  document.getElementById("v-location").value = "Intérieur";
  populateSaleFormatSelect(null);
  document.getElementById("v-prix").value = "";
  document.getElementById("v-qty").value = "1";
  document.getElementById("v-remise").value = "0";
  document.getElementById("v-note").value = "";
  document.getElementById("save-vente-btn").textContent = "Ajouter un article";
  document.getElementById("finalize-order-btn").disabled = !activeOrderId;
  const vSearchReset = document.getElementById("v-article-search");
  if (vSearchReset) vSearchReset.value = "";
  renderVenteArticlePicker();
  updateKitInfo(null);
  updateVentePreview();
}

function modalIsOpen() {
  return Boolean(document.querySelector(".modal-overlay.open"));
}

function qrOrdersForCurrentSite(sourceState = state) {
  const siteId = sourceState?.activeSiteId || currentSiteId();
  return (sourceState?.commandes || []).filter((item) => item.siteId === siteId && item.source === "qr");
}

function renderQrAlertBadge() {
  const badge = document.getElementById("qr-alert-badge");
  if (badge) {
    if (qrAlertCount <= 0) {
      badge.classList.add("hidden");
      badge.textContent = "Nouvelle commande QR";
    } else {
      badge.classList.remove("hidden");
      badge.textContent = qrAlertCount === 1 ? "1 nouvelle commande QR" : `${qrAlertCount} nouvelles commandes QR`;
    }
  }
  syncMobileBottomBadges();
}

function clearQrAlert() {
  qrAlertCount = 0;
  renderQrAlertBadge();
}

function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.setValueAtTime(660, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.1, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, context.currentTime + 0.26);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.28);
    oscillator.onended = () => context.close().catch(() => {});
  } catch (error) {
    console.error(error);
  }
}

function triggerQrCardFlash(orderIds) {
  orderIds.forEach((id) => flashingQrOrderIds.add(id));
  renderOrders();
  window.setTimeout(() => {
    orderIds.forEach((id) => flashingQrOrderIds.delete(id));
    renderOrders();
  }, 6500);
}

function startLiveSync() {
  clearInterval(liveSyncTimer);
  liveSyncTimer = window.setInterval(() => {
    syncStateSilently().catch(() => {});
  }, 4000);
}

function stopLiveSync() {
  clearInterval(liveSyncTimer);
  liveSyncTimer = null;
}

async function syncStateSilently() {
  if (!state || modalIsOpen()) return;
  if (!["ventes", "home"].includes(currentPage)) return;
  const previousQrIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
  const since = state?.meta?.updatedAt || "";
  try {
    const delta = await apiRequest(`${API.changes}?since=${encodeURIComponent(since)}&siteId=${encodeURIComponent(currentSiteId())}`);
    const incoming = (delta?.changes?.commandes || []).slice();
    if (incoming.length) {
      const byId = new Map((state.commandes || []).map((order) => [order.id, order]));
      incoming.forEach((order) => byId.set(order.id, order));
      state.commandes = Array.from(byId.values()).sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    }
    if (delta?.meta) {
      state.meta = delta.meta;
    }
  } catch (error) {
    // Fallback: if delta endpoint fails, reload full state.
    state = await apiRequest(API.state);
  }

  const latestQrOrders = qrOrdersForCurrentSite(state);
  const newQrOrders = latestQrOrders.filter((item) => !previousQrIds.has(item.id));
  knownQrOrderIds = new Set(latestQrOrders.map((item) => item.id));
  if (newQrOrders.length) {
    triggerQrCardFlash(newQrOrders.map((item) => item.id));
    qrAlertCount += newQrOrders.length;
    renderQrAlertBadge();
    playNotificationSound();
    showToast(newQrOrders.length === 1 ? "Nouvelle commande QR recue." : `${newQrOrders.length} nouvelles commandes QR recues.`);
  }
  renderTopbar();
  renderSiteSwitcher();
  if (currentPage === "home") {
    renderDashboard();
  }
  if (currentPage === "ventes") {
    renderVentesPage();
  }
}

async function persistState(overrides = {}) {
  state = await apiRequest(API.state, {
    method: "PUT",
    body: JSON.stringify({
      sites: overrides.sites || state.sites,
      activeSiteId: overrides.activeSiteId || state.activeSiteId,
      params: overrides.params || {},
      ventes: overrides.ventes || state.ventes,
      stock: overrides.stock || state.stock,
      commandes: overrides.commandes || state.commandes,
      stockChecks: overrides.stockChecks || state.stockChecks || [],
      stockLosses: overrides.stockLosses ?? state.stockLosses ?? [],
      stockEntrees: overrides.stockEntrees ?? state.stockEntrees ?? [],
      dayBooks: overrides.dayBooks !== undefined ? overrides.dayBooks : (state.dayBooks || []),
      purchaseOrders: overrides.purchaseOrders ?? state.purchaseOrders ?? [],
      creditRecoveries: overrides.creditRecoveries || state.creditRecoveries || [],
      categories: overrides.categories || state.categories || CATEGORIES,
      charges: overrides.charges || state.charges,
      nextId: overrides.nextId || state.nextId,
      staffAuditLog: overrides.staffAuditLog !== undefined ? overrides.staffAuditLog : (state.staffAuditLog || []),
      auth: overrides.auth || { users: state.auth.users || [] },
    }),
  });
  renderTopbar();
}

function renderCreditRecovery() {
  const list = document.getElementById("credit-list");
  if (!list) return;
  const totals = creditTotals();
  const dueMap = creditOutstandingMap();
  const issuerByDebtor = creditIssuerLabelsByDebtor();
  const entries = Object.entries(dueMap).sort((a, b) => b[1] - a[1]);
  const totalDue = entries.reduce((sum, [, v]) => sum + (Number(v) || 0), 0);
  const byDebtor = creditRecoveriesGroupedByDebtor();

  const totalDueNode = document.getElementById("credit-total-due");
  const totalPaidNode = document.getElementById("credit-total-paid");
  if (totalDueNode) totalDueNode.textContent = `${fmt(totalDue)} FCFA`;
  if (totalPaidNode) totalPaidNode.textContent = `${fmt(totals.paid)} FCFA`;

  const datalist = document.getElementById("credit-names-list");
  if (datalist) {
    const names = [...new Set([
      ...entries.map(([n]) => n),
      ...creditRecoveriesForSite().map((p) => debtorDisplayKey(p.debiteur)).filter(Boolean),
    ])].sort((a, b) => a.localeCompare(b, "fr"));
    datalist.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
  }

  if (!entries.length) {
    list.innerHTML = emptyState("Aucun crédit en cours", "Les crédits clients apparaîtront ici (paiement : Crédit client).");
    return;
  }

  const rowsHtml = entries.map(([name, amount]) => {
    const installments = byDebtor[name] || [];
    const headRow = `
            <tr class="credit-debtor-summary">
              <td><strong>${escapeHtml(name)}</strong></td>
              <td class="muted" style="font-size:0.9rem">${escapeHtml(issuerByDebtor[name] || "—")}</td>
              <td style="text-align:right"><strong style="color:#ff8e82">${fmt(amount)} FCFA</strong></td>
              <td><button type="button" class="mini-btn" data-credit-fill="${escapeHtml(name)}">Encaisser</button></td>
            </tr>`;
    const instRows = installments.length
      ? [`<tr class="credit-installment-row"><td colspan="4" class="credit-installment-label">Échéances enregistrées (${installments.length})</td></tr>`,
        ...installments.map((p) => `
            <tr class="credit-installment-row">
              <td colspan="2" style="padding-left:1.1rem;font-size:0.88rem">
                <span class="muted">↳</span>
                ${escapeHtml(formatCreditPaidAt(p))}
                · ${escapeHtml(p.paiement || "—")}
                ${p.note ? ` · <span class="muted">${escapeHtml(p.note)}</span>` : ""}
              </td>
              <td style="text-align:right;font-size:0.88rem;color:#72d7a9;font-weight:600">${fmt(p.montant)} FCFA</td>
              <td></td>
            </tr>`)
      ].join("")
      : "";
    return headRow + instRows;
  }).join("");

  list.innerHTML = `
    <div class="stock-table-wrap" style="margin-top:10px">
      <table class="stock-table" style="min-width:880px">
        <thead><tr>
          <th>Débiteur</th>
          <th>Crédit accordé par</th>
          <th style="text-align:right">Reste à payer</th>
          <th>Action</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

async function saveCreditRecovery() {
  const name = (document.getElementById("credit-name")?.value || "").trim();
  const nameNorm = debtorDisplayKey(name);
  const montant = Math.round(Number(document.getElementById("credit-amount")?.value) || 0);
  const method = document.getElementById("credit-method")?.value || "Espèces";
  const dtInput = document.getElementById("credit-datetime")?.value?.trim() || "";
  const note = (document.getElementById("credit-note")?.value || "").trim();
  if (!name) { showToast("Le nom du client débiteur est obligatoire."); return; }
  if (montant <= 0) { showToast("Entrez un montant valide."); return; }

  let paidAtIso = new Date().toISOString();
  let dateCalendar = today();
  if (dtInput) {
    const parsed = new Date(dtInput);
    if (!Number.isNaN(parsed.getTime())) {
      paidAtIso = parsed.toISOString();
      dateCalendar = dtInput.slice(0, 10);
    }
  }

  const dueMap = creditOutstandingMap();
  const remaining = Number(dueMap[nameNorm]) || 0;
  const applied = remaining > 0 ? Math.min(montant, Math.round(remaining)) : montant;
  if (remaining > 0 && applied <= 0) { showToast("Ce client n'a plus de crédit en cours."); return; }

  const row = {
    id: state.nextId.creditRecovery++,
    siteId: currentSiteId(),
    date: dateCalendar,
    paidAt: paidAtIso,
    debiteur: nameNorm,
    montant: applied,
    paiement: method,
    note,
    createdAt: new Date().toISOString(),
  };
  state.creditRecoveries = [row, ...(state.creditRecoveries || [])];
  recordStaffAudit("create", "credit_recovery", `Encaissement credit · ${nameNorm}`, `${fmt(applied)} FCFA · ${method}${note ? ` · ${note}` : ""}`);
  await persistState({ creditRecoveries: state.creditRecoveries, nextId: state.nextId });
  document.getElementById("credit-name").value = nameNorm;
  document.getElementById("credit-amount").value = "";
  document.getElementById("credit-note").value = "";
  const creditDt = document.getElementById("credit-datetime");
  if (creditDt) creditDt.value = datetimeLocalNow();
  showToast("Versement enregistré.");
  renderCreditRecovery();
  renderDashboard();
  renderPointDuJour();
}

function purchaseOrdersForSite() {
  const siteId = currentSiteId();
  const multiSite = multiSiteActive();
  return (state.purchaseOrders || []).filter((p) => rowMatchesSite(p, siteId, multiSite));
}

function purchasePricePerCaseFromStock(articleName) {
  const product = findKnownProduct(String(articleName || "").trim());
  const prix = Number(product?.prixAchat) || 0;
  return Math.max(0, Math.round(prix));
}

function syncPurchasePriceInput() {
  const input = document.getElementById("purchase-price");
  if (!input) return;
  const article = document.getElementById("purchase-article")?.value?.trim() || "";
  const prix = purchasePricePerCaseFromStock(article);
  input.value = prix > 0 ? String(prix) : "";
}

/** Casiers et btl/casier alignés sur la ligne stock + suggestion au seuil (comme depuis « Commander » sur une ligne catalogue). */
function syncPurchaseQtyFromStock() {
  const casesInput = document.getElementById("purchase-cases");
  const caseSizeField = document.getElementById("purchase-case-size");
  if (!casesInput || !caseSizeField) return;
  const article = document.getElementById("purchase-article")?.value?.trim() || "";
  const item = stockItemForArticle(article);
  if (!item) {
    casesInput.value = "";
    caseSizeField.value = "24";
    return;
  }
  const cs = caseSize(item);
  caseSizeField.value = String(VALID_CASE_SIZES.includes(cs) ? cs : 24);
  const { cases } = suggestPurchaseCases(item);
  casesInput.value = String(cases);
}

function syncPurchaseLineInputsFromStock() {
  syncPurchasePriceInput();
  syncPurchaseQtyFromStock();
}

function renderPurchaseDraft() {
  const container = document.getElementById("purchase-lines");
  if (!container) return;
  if (!purchaseDraftLines.length) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:10px 0">Aucune ligne.</p>`;
    return;
  }
  const allSelected = purchaseDraftLines.every((l) => l.selected !== false);
  container.innerHTML = `
    <div class="stock-table-wrap" style="margin-top:10px">
      <table class="stock-table" style="min-width:760px">
        <thead><tr>
          <th style="width:52px;text-align:center"><input id="purchase-select-all" type="checkbox" ${allSelected ? "checked" : ""} aria-label="Tout sélectionner"></th>
          <th>Article</th>
          <th style="text-align:right">Casiers</th>
          <th style="text-align:right">Btl/casier</th>
          <th style="text-align:right">Prix/casier</th>
          <th style="text-align:right">Montant</th>
          <th>Action</th>
        </tr></thead>
        <tbody>
          ${purchaseDraftLines.map((l, idx) => {
            const selected = l.selected !== false;
            return `<tr>
              <td style="text-align:center"><input type="checkbox" data-purchase-select="${idx}" ${selected ? "checked" : ""} aria-label="Sélection ligne"></td>
              <td>${escapeHtml(l.article)}</td>
              <td style="text-align:right"><input type="number" min="0" step="1" value="${escapeHtml(String(l.cases ?? 0))}" data-purchase-cases="${idx}" style="max-width:110px"></td>
              <td style="text-align:right">${fmt(l.caseSize ?? 24)}</td>
              <td style="text-align:right">${fmt(l.pricePerCase || 0)} FCFA</td>
              <td style="text-align:right"><strong>${fmt(l.amount)} FCFA</strong></td>
              <td><button type="button" class="mini-btn" data-purchase-remove-line="${idx}">Retirer</button></td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function recomputePurchaseLine(idx) {
  const line = purchaseDraftLines[idx];
  if (!line) return;
  const cases = Math.max(0, Math.round(Number(line.cases) || 0));
  const stockItem = stockItemForArticle(line.article);
  const caseSizeVal = stockItem ? caseSize(stockItem) : Math.max(1, Math.round(Number(line.caseSize) || 24));
  const price = Math.max(0, Math.round(Number(line.pricePerCase) || purchasePricePerCaseFromStock(line.article) || 0));
  purchaseDraftLines[idx] = {
    ...line,
    cases,
    caseSize: caseSizeVal,
    pricePerCase: price,
    amount: Math.round(cases * price),
  };
}

function openPurchaseForm() {
  purchaseDraftLines = [];
  document.getElementById("purchase-form")?.classList.remove("hidden");
  document.getElementById("purchase-date").value = today();
  document.getElementById("purchase-feedback").textContent = "";
  syncPurchaseLineInputsFromStock();
  renderPurchaseDraft();
}

function addPurchaseLine() {
  const feedback = document.getElementById("purchase-feedback");
  const article = document.getElementById("purchase-article").value.trim();
  syncPurchasePriceInput();
  const cases = Number(document.getElementById("purchase-cases").value) || 0;
  const caseSizeVal = Number(document.getElementById("purchase-case-size").value) || 24;
  const price = purchasePricePerCaseFromStock(article);
  if (!article || cases <= 0) {
    if (feedback) feedback.textContent = "Article et casiers sont obligatoires. Les casiers se remplissent lorsque l'article existe dans le stock du site.";
    return;
  }
  if (!price) {
    if (feedback) feedback.textContent = "Prix achat / casier manquant dans le stock pour cet article.";
    return;
  }
  const amount = Math.round(cases * price);
  purchaseDraftLines.push({ article, cases, caseSize: caseSizeVal, pricePerCase: price, amount, selected: true });
  document.getElementById("purchase-article").value = "";
  document.getElementById("purchase-cases").value = "";
  syncPurchaseLineInputsFromStock();
  if (feedback) feedback.textContent = "";
  renderPurchaseDraft();
}

async function savePurchaseOrder() {
  const feedback = document.getElementById("purchase-feedback");
  const selectedLines = purchaseDraftLines.filter((l) => l.selected !== false);
  if (!selectedLines.length) {
    if (feedback) feedback.textContent = "Cochez au moins une ligne (ou ajoutez une ligne).";
    return;
  }
  const siteIdSave = currentSiteId();
  if (!siteIdSave) {
    if (feedback) feedback.textContent = "Selectionnez un maquis (aucun site actif).";
    showToast("Impossible d'enregistrer : aucun maquis actif.");
    return;
  }
  const supplier = document.getElementById("purchase-supplier").value.trim() || "Fournisseur";
  const date = document.getElementById("purchase-date").value || today();
  const pay = document.getElementById("purchase-pay").value || "Especes";
  const total = selectedLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  if (!state.nextId) state.nextId = {};
  if (state.nextId.purchaseOrder == null || Number.isNaN(Number(state.nextId.purchaseOrder))) {
    const maxExisting = (state.purchaseOrders || []).reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    state.nextId.purchaseOrder = Math.max(100, maxExisting + 1);
  }
  const po = {
    id: state.nextId.purchaseOrder++,
    siteId: siteIdSave,
    supplier,
    date,
    payment: pay,
    status: "En attente",
    createdAt: new Date().toISOString(),
    createdBy: sessionUser || "system",
    lines: selectedLines.map((l) => {
      const copy = { ...l };
      delete copy.selected;
      return copy;
    }),
    total,
  };
  state.purchaseOrders = [po, ...(state.purchaseOrders || [])];
  recordStaffAudit("create", "achat_fournisseur", `Commande fournisseur ${supplier}`, `${fmt(total)} FCFA · ${pay} · ${selectedLines.length} ligne(s)`);
  await persistState({ purchaseOrders: state.purchaseOrders });
  document.getElementById("purchase-form")?.classList.add("hidden");
  purchaseDraftLines = [];
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  showToast("Commande fournisseur enregistrée.");
}

function recalculatePurchaseOrderTotal(po) {
  po.total = Math.round((po.lines || []).reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
}

async function cancelPurchaseOrder(id) {
  const po = (state.purchaseOrders || []).find((p) => p.id === id);
  if (!po || po.status === "Reçue" || po.status === "Annulée") return;
  if (po.status !== "En attente") return;
  if (!window.confirm(`Annuler la commande fournisseur "${po.supplier}" (${fmt(po.total || 0)} FCFA) ?`)) return;
  po.status = "Annulée";
  po.cancelledAt = new Date().toISOString();
  po.cancelledBy = sessionUser || "system";
  recordStaffAudit("update", "achat_fournisseur", `Commande annulee · ${po.supplier}`, formatPurchaseOrderAuditDetail(po));
  await persistState({ purchaseOrders: state.purchaseOrders });
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  showToast("Commande annulee.");
}

function purchaseReceiptNeedsSnapshot(originalLines, receivedLines) {
  const norm = (lines) =>
    [...(lines || [])]
      .map((l) => ({
        article: String(l.article || "").toLowerCase().trim(),
        cases: Number(l.cases) || 0,
      }))
      .sort((a, b) => a.article.localeCompare(b.article));
  const o = norm(originalLines);
  const r = norm(receivedLines);
  if (o.length !== r.length) return true;
  for (let i = 0; i < o.length; i++) {
    if (o[i].article !== r[i].article || o[i].cases !== r[i].cases) return true;
  }
  return false;
}

async function applyPurchaseReceipt(po, linesReceived) {
  const receivedTotal = Math.round(linesReceived.reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
  if (!linesReceived.length || receivedTotal <= 0) return false;

  if (purchaseReceiptNeedsSnapshot(po.lines, linesReceived)) {
    po.linesOrderedSnapshot = JSON.parse(JSON.stringify(po.lines || []));
  } else {
    delete po.linesOrderedSnapshot;
  }

  const siteId = currentSiteId();
  const stockItems = state.stock || [];
  const stockEntrees = state.stockEntrees || [];
  if (!state.nextId) state.nextId = {};
  if (state.nextId.stockEntree == null || Number.isNaN(Number(state.nextId.stockEntree))) {
    const maxE = stockEntrees.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    state.nextId.stockEntree = Math.max(100, maxE + 1);
  }
  linesReceived.forEach((line) => {
    const cases = Number(line.cases) || 0;
    if (cases <= 0) return;
    const item = stockItems.find((s) => s.siteId === siteId && String(s.article || "").toLowerCase() === String(line.article || "").toLowerCase());
    if (!item) return;
    const bottles = cases * (Number(line.caseSize) || caseSize(item));
    item.entrees = (Number(item.entrees) || 0) + bottles;
    item.reserve = Math.max(0, Number(item.reserve) || 0) + bottles;
    item.lastReapproAt = new Date().toISOString();
    item.lastReapproBy = sessionUser || "system";
    stockEntrees.unshift({
      id: state.nextId.stockEntree++,
      siteId,
      date: po.date,
      article: item.article,
      qty: bottles,
      cases,
      caseSize: line.caseSize,
      user: sessionUser || "system",
    });
  });

  state.charges = state.charges || [];
  state.charges.unshift({
    id: state.nextId.charge++,
    siteId,
    date: po.date,
    lib: `Commande fournisseur ${po.supplier} (${fmt(receivedTotal)} FCFA)`,
    cat: "Approvisionnement",
    montant: receivedTotal,
    paiement: po.payment || "Especes",
  });
  po.lines = linesReceived;
  po.total = receivedTotal;
  po.status = "Reçue";
  po.receivedAt = new Date().toISOString();
  po.receivedBy = sessionUser || "system";
  recordStaffAudit(
    "update",
    "reception_fournisseur",
    `Reception · ${po.supplier}`,
    `${fmt(receivedTotal)} FCFA · ${linesReceived.length} ligne(s) livree(s) · ${po.payment || ""}`
  );
  await persistState({ stock: stockItems, purchaseOrders: state.purchaseOrders, charges: state.charges, nextId: state.nextId, stockEntrees });
  renderStock();
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  showToast("Commande receptionnee selon les quantites livrees.");
  return true;
}

function updateReceivePurchaseModalTotals(po) {
  let sum = 0;
  (po.lines || []).forEach((line, idx) => {
    const inp = document.getElementById(`recv-cases-${idx}`);
    const delivered = Math.max(0, Math.round(Number(inp?.value) || 0));
    const price = Number(line.pricePerCase) || 0;
    const amt = Math.round(delivered * price);
    sum += amt;
    const el = document.getElementById(`recv-line-amt-${idx}`);
    if (el) el.textContent = `${fmt(amt)} FCFA`;
  });
  const prev = document.getElementById("purchase-receive-total-preview");
  if (prev) prev.textContent = `${fmt(sum)} FCFA`;
}

function openReceivePurchaseModal(poId) {
  const po = (state.purchaseOrders || []).find((p) => p.id === poId);
  if (!po || po.status !== "En attente") return;
  recalculatePurchaseOrderTotal(po);
  pendingReceivePurchaseId = poId;
  const wrap = document.getElementById("purchase-receive-lines");
  if (!wrap) return;
  wrap.innerHTML = (po.lines || [])
    .map((l, idx) => {
      const orderedCases = Number(l.cases) || 0;
      const price = Number(l.pricePerCase) || 0;
      return `
    <div class="purchase-receive-row" style="border-bottom:1px solid rgba(255,255,255,0.06);padding:12px 0">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between">
        <div style="flex:1;min-width:160px">
          <strong>${escapeHtml(l.article)}</strong>
          <p class="muted" style="margin:4px 0 0;font-size:0.82rem">Commande : ${fmt(orderedCases)} casier(s) × ${fmt(l.caseSize)} btl · ${fmt(price)} FCFA/cas.</p>
        </div>
        <div class="form-group" style="margin:0;min-width:120px">
          <label for="recv-cases-${idx}">Casiers livres</label>
          <input type="number" min="0" step="1" class="recv-cases-input" id="recv-cases-${idx}" data-recv-idx="${idx}" value="${orderedCases}">
        </div>
        <div style="min-width:100px;text-align:right">
          <span class="muted" style="font-size:0.78rem">Montant</span>
          <div><strong id="recv-line-amt-${idx}">${fmt(l.amount)} FCFA</strong></div>
        </div>
      </div>
    </div>`;
    })
    .join("");
  const supEl = document.getElementById("purchase-receive-supplier");
  const payEl = document.getElementById("purchase-receive-payment");
  if (supEl) supEl.textContent = po.supplier || "Fournisseur";
  if (payEl) payEl.textContent = po.payment || "";
  updateReceivePurchaseModalTotals(po);
  openModal("modal-purchase-receive");
}

async function confirmReceivePurchaseOrder() {
  const poId = pendingReceivePurchaseId;
  const po = (state.purchaseOrders || []).find((p) => p.id === poId);
  if (!po || po.status !== "En attente") {
    closeModal("modal-purchase-receive");
    return;
  }
  const linesReceived = [];
  (po.lines || []).forEach((line, idx) => {
    const inp = document.getElementById(`recv-cases-${idx}`);
    const delivered = Math.max(0, Math.round(Number(inp?.value) || 0));
    if (delivered <= 0) return;
    const price = Number(line.pricePerCase) || 0;
    const caseSizeVal = Math.max(1, Number(line.caseSize) || 24);
    linesReceived.push({
      article: line.article,
      cases: delivered,
      caseSize: caseSizeVal,
      pricePerCase: price,
      amount: Math.round(delivered * price),
    });
  });
  if (!linesReceived.length) {
    showToast("Indiquez au moins une quantite livree (> 0).");
    return;
  }
  const previewTotal = linesReceived.reduce((s, l) => s + l.amount, 0);
  if (
    !window.confirm(
      `Valider la reception pour ${fmt(linesReceived.length)} ligne(s) · total ${fmt(previewTotal)} FCFA ?\n\nLe stock sera augmente et une charge sera creee.`
    )
  )
    return;
  closeModal("modal-purchase-receive");
  await applyPurchaseReceipt(po, linesReceived);
}

async function removePurchaseOrderLine(poId, lineIndex) {
  const po = (state.purchaseOrders || []).find((p) => p.id === poId);
  if (!po || po.status !== "En attente") return;
  const lines = po.lines || [];
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const removed = lines[lineIndex];
  if (!window.confirm(`Retirer "${removed.article}" de la commande (non livre) ?`)) return;
  lines.splice(lineIndex, 1);
  recalculatePurchaseOrderTotal(po);
  recordStaffAudit("update", "achat_fournisseur", `Ligne retiree · ${po.supplier}`, `${removed.article} · ${fmt(removed.amount || 0)} FCFA`);
  if (!lines.length) {
    po.status = "Annulée";
    po.cancelledAt = new Date().toISOString();
    po.cancelledBy = sessionUser || "system";
    await persistState({ purchaseOrders: state.purchaseOrders });
    renderPurchaseOrders();
    refreshCreanciersIfVisible();
    showToast("Plus aucune ligne : commande annulee.");
    return;
  }
  await persistState({ purchaseOrders: state.purchaseOrders });
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  showToast("Ligne retiree.");
}

function receivePurchaseOrder(id) {
  const po = (state.purchaseOrders || []).find((p) => p.id === id);
  if (!po || po.status === "Reçue" || po.status === "Annulée") return;
  recalculatePurchaseOrderTotal(po);
  if (!po.lines?.length || Number(po.total) <= 0) {
    showToast("Aucune ligne a receptionner.");
    return;
  }
  openReceivePurchaseModal(id);
}

function renderPurchaseOrders() {
  const list = document.getElementById("purchase-list");
  const count = document.getElementById("purchase-count");
  if (!list) return;
  const orders = purchaseOrdersForSite().slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  if (count) count.textContent = `${orders.length}`;
  if (!orders.length) {
    list.innerHTML = emptyState("Aucune commande", "Créez une commande fournisseur pour tracer vos achats.");
    return;
  }
  list.innerHTML = orders.map((po) => {
    const pending = po.status === "En attente";
    const badgeClass = po.status === "Reçue" ? "badge-green" : po.status === "Annulée" ? "badge-red" : "badge-amber";
    return `
    <article class="list-item" style="flex-direction:column;align-items:stretch;gap:8px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <div>
          <p class="list-item-title">${escapeHtml(po.supplier || "Fournisseur")}</p>
          <p class="list-item-sub">${escapeHtml(po.date ? formatDateDdMmYyyy(po.date) : "")} · ${fmt(po.lines?.length || 0)} ligne(s) · ${fmt(po.total || 0)} FCFA · ${escapeHtml(po.payment || "")}</p>
          ${po.status === "Reçue" && Array.isArray(po.linesOrderedSnapshot) && po.linesOrderedSnapshot.length ? `<p class="muted" style="font-size:0.78rem;margin:4px 0 0">Reception avec ecart par rapport a la commande initiale.</p>` : ""}
        </div>
        <div class="line-actions" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <span class="badge ${badgeClass}">${escapeHtml(po.status || "En attente")}</span>
          ${pending ? `<button type="button" class="mini-btn" data-purchase-receive="${po.id}">Réceptionner</button>
          <button type="button" class="mini-btn" style="border-color:rgba(197,79,65,0.6);color:#ff8e82" data-purchase-cancel="${po.id}">Annuler</button>` : ""}
        </div>
      </div>
      <div class="customer-order-lines" style="min-width:0">
        ${(po.lines || []).map((l, idx) => `<div class="customer-order-line" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
          <span>${escapeHtml(l.article)} · ${fmt(l.cases)} cas × ${fmt(l.caseSize)} btl</span>
          <span style="display:flex;align-items:center;gap:10px">
            <strong>${fmt(l.amount)} FCFA</strong>
            ${pending ? `<button type="button" class="mini-btn" data-purchase-remove-line="${po.id}" data-line-index="${idx}">Retirer</button>` : ""}
          </span>
        </div>`).join("")}
      </div>
    </article>`;
  }).join("");
}

function ensureOrder(clientName, date, note) {
  const selectedOrderId = Number(document.getElementById("v-order-select").value) || activeOrderId;
  let order = selectedOrderId ? recordsForSite(state.commandes).find((item) => item.id === selectedOrderId) : null;
  if (!order) {
    order = {
      id: state.nextId.commande++,
      siteId: currentSiteId(),
      client: clientName.trim() || `Client ${state.nextId.commande - 1}`,
      date,
      createdAt: new Date().toISOString(),
      status: "Servi",
      type: "sur-place",
      server: sessionUser || "Serveur",
      note: note.trim(),
      lignes: [],
    };
    state.commandes.unshift(order);
  } else {
    order.client = clientName.trim() || order.client;
    order.date = date;
    order.note = note.trim();
  }
  activeOrderId = order.id;
  return order;
}

async function saveOrderLine() {
  const article = document.getElementById("v-article").value.trim();
  const product = findKnownProduct(article);
  const format = selectedSaleFormat(product);
  const prix = formatPrice(format, document.getElementById("v-location").value);
  if (!article || !product || prix <= 0) {
    showToast("Choisissez un article du stock avec un prix catalogue.");
    return;
  }
  const selectedOrderId = Number(document.getElementById("v-order-select").value) || activeOrderId;
  const creatingNewOrder = !selectedOrderId;
  const date = document.getElementById("v-date").value || today();
  const order = ensureOrder(document.getElementById("v-client").value, date, document.getElementById("v-note").value);
  const requestedBottles = (Number(document.getElementById("v-qty").value) || 1) * Math.max(1, Number(format?.quantite) || Number(product?.packSize) || 1);
  const availability = stockAvailabilityForLine(product.article, requestedBottles, order.id, editingLineId);
  if (!availability.stockItem || availability.available < requestedBottles) {
    if (creatingNewOrder && !(order.lignes && order.lignes.length)) {
      state.commandes = (state.commandes || []).filter((o) => o.id !== order.id);
      if (activeOrderId === order.id) activeOrderId = null;
    }
    showToast(`Stock insuffisant pour ${product.article}. Disponible: ${fmt(availability.available)} bouteille(s).`);
    return;
  }
  const line = {
    id: editingLineId || state.nextId.ligneCommande++,
    date,
    article: product?.article || article,
    cat: product?.cat || "Autres",
    location: document.getElementById("v-location").value,
    formatQuantite: Math.max(1, Number(format?.quantite) || Number(product?.packSize) || 1),
    prix,
    qty: Number(document.getElementById("v-qty").value) || 1,
    remise: Number(document.getElementById("v-remise").value) || 0,
    paiement: "A regler",
    note: document.getElementById("v-note").value.trim(),
  };
  const index = order.lignes.findIndex((item) => item.id === line.id);
  if (index >= 0) order.lignes[index] = line;
  else order.lignes.push(line);
  recordStaffAudit(index >= 0 ? "update" : "create", "commande_ligne", `${index >= 0 ? "Ligne modifiee" : "Ligne ajoutee"} · commande #${order.id} · ${order.client || ""}`, `${line.article} · ${fmt(calcNet(line))} FCFA`);
  await persistState();
  closeModal("modal-vente");
  resetOrderForm();
  renderVentesPage();
  showToast(index >= 0 ? "Commande mise a jour." : "Ligne ajoutee a la commande.");
}

function readPaymentMix(total) {
  const creditName = document.getElementById("pay-credit-name").value.trim();
  const details = [
    ["Espèces", "pay-cash"],
    ["Wave", "pay-wave"],
    ["Orange Money", "pay-orange"],
    ["MTN MoMo", "pay-mtn"],
    ["Carte", "pay-card"],
    ["Crédit client", "pay-credit"],
  ].map(([method, id]) => ({ method, amount: Number(document.getElementById(id).value) || 0 }))
    .filter((item) => item.amount > 0);
  const paidTotal = details.reduce((sum, item) => sum + item.amount, 0);
  if (!details.length) {
    return { error: "Renseignez au moins un montant de paiement." };
  }
  if (Math.round(paidTotal) !== Math.round(total)) {
    return { error: `Le total saisi (${fmt(paidTotal)} FCFA) doit etre egal a ${fmt(total)} FCFA.` };
  }
  if (details.some((item) => isCreditClientMethod(item.method)) && !creditName) {
    return { error: "Le nom du debiteur est obligatoire pour un credit client." };
  }
  return { details, creditName };
}

function splitPaymentDetails(details, lineTotal, orderTotal) {
  if (!orderTotal) return [];
  return details.map((detail) => ({
    method: detail.method,
    amount: Math.round((Number(detail.amount) || 0) * lineTotal / orderTotal),
  })).filter((detail) => detail.amount > 0);
}

async function finalizeOrder(orderId = activeOrderId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order || !order.lignes.length) {
    showToast("Aucune ligne a facturer pour ce client.");
    return;
  }
  const orderTotal = order.lignes.reduce((sum, line) => sum + calcNet(line), 0);
  const paymentMix = readPaymentMix(orderTotal);
  if (paymentMix.error) {
    showToast(paymentMix.error);
    return;
  }
  const siteId = order.siteId || currentSiteId();
  const neededByArticle = {};
  for (const line of order.lignes) {
    neededByArticle[line.article] = (neededByArticle[line.article] || 0) + lineBottleQty(line, stockItemForArticle(line.article, siteId));
  }
  for (const [article, bottles] of Object.entries(neededByArticle)) {
    const stockItem = stockItemForArticle(article, siteId);
    if (!stockItem || availableStock(stockItem) < bottles) {
      showToast(`Stock insuffisant pour ${article}. Disponible: ${fmt(availableStock(stockItem))} bouteille(s).`);
      return;
    }
  }
  const paymentMethod = paymentMix.details.length > 1 ? "Mixte" : paymentMix.details[0].method;
  const site = currentSite();
  const factureNumber = `${site?.prefixeFacture || "FAC"}-${String(state.nextId.invoice++).padStart(4, "0")}`;
  const encaisseAt = new Date().toISOString();
  const creditIssuedBy = paymentMix.details.some((d) => isCreditClientMethod(d.method))
    ? String(sessionUser || "").trim()
    : "";
  const ventes = order.lignes.map((line) => ({
    id: state.nextId.vente++,
    siteId: order.siteId || currentSiteId(),
    factureNumber,
    date: line.date || order.date || today(),
    soldAt: encaisseAt,
    client: order.client,
    table: order.table || order.client,
    article: line.article,
    cat: line.cat,
    prix: line.prix,
    qty: line.qty,
    remise: line.remise,
    paiement: paymentMethod,
    paiementDetails: splitPaymentDetails(paymentMix.details, calcNet(line), orderTotal),
    debiteur: paymentMix.creditName,
    creditIssuedBy: creditIssuedBy || undefined,
    note: line.note || order.note || "",
  }));
  state.ventes = [...ventes, ...state.ventes];

  order.lignes.forEach((line) => {
    const stockItem = stockItemForArticle(line.article, siteId);
    if (stockItem) {
      const bottles = lineBottleQty(line, stockItem);
      stockItem.sorties = (Number(stockItem.sorties) || 0) + bottles;
      stockItem.lastSortieAt = new Date().toISOString();
      stockItem.lastSortieBy = sessionUser || "Serveur";
      consumePhysicalStock(stockItem, bottles);
    }
  });

  state.commandes = state.commandes.filter((item) => item.id !== order.id);
  if (activeOrderId === order.id) activeOrderId = null;
  pendingFinalizeOrderId = null;
  recordStaffAudit("create", "encaissement", `Facture ${factureNumber} · ${order.client || "Client"}`, `Total ${fmt(orderTotal)} FCFA · ${paymentMethod}${paymentMix.creditName ? ` · debiteur ${paymentMix.creditName}` : ""}`);
  await persistState();
  closeModal("modal-vente");
  resetOrderForm();
  if (currentPage === "home") renderDashboard();
  renderVentesPage();
  showToast(`Facture ${factureNumber} enregistree pour ${order.client}.`);
  showFinalizeSuccess(factureNumber);
}

function resetFinalizeModalUi() {
  document.getElementById("modal-finalize-flow")?.classList.remove("hidden");
  document.getElementById("modal-finalize-done")?.classList.add("hidden");
}

function showFinalizeSuccess(factureNumber) {
  const numEl = document.getElementById("finalize-done-num");
  const printBtn = document.getElementById("print-finalize-btn");
  if (numEl) numEl.textContent = factureNumber;
  if (printBtn) printBtn.dataset.facture = factureNumber;
  document.getElementById("modal-finalize-flow")?.classList.add("hidden");
  document.getElementById("modal-finalize-done")?.classList.remove("hidden");
}

function openFinalizeDialog(orderId = activeOrderId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order || !order.lignes.length) {
    showToast("Aucune ligne a facturer pour ce client.");
    return;
  }
  pendingFinalizeOrderId = orderId;
  resetFinalizeModalUi();
  document.querySelectorAll(".finalize-pay-input").forEach((input) => { input.value = ""; });
  document.getElementById("pay-credit-name").value = "";
  const orderTotal = order.lignes.reduce((sum, line) => sum + calcNet(line), 0);
  document.getElementById("finalize-order-total").textContent = `${fmt(orderTotal)} FCFA`;
  document.getElementById("pay-mix-preview").textContent = "0 FCFA";
  const resteEl = document.getElementById("pay-reste-preview");
  if (resteEl) { resteEl.textContent = `Reste ${fmt(orderTotal)} FCFA`; resteEl.style.color = "#ff8e82"; }
  openModal("modal-finalize");
}

async function advanceOrder(orderId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order) return;
  const next = nextOrderStatus(orderStatus(order));
  if (!next) {
    showToast("Cette commande ne peut plus avancer.");
    return;
  }
  // Encaissement must go through the finalize dialog to record payment method and create ventes
  if (next === "Encaisser") {
    activeOrderId = orderId;
    openFinalizeDialog();
    return;
  }
  if (!window.confirm(`Passer la commande au statut "${next}" ?`)) return;
  order.status = next;
  recordStaffAudit("update", "commande_statut", `Commande #${order.id} : ${next}`, order.client || "");
  await persistState();
  renderVentesPage();
  showToast(`Commande #${order.id} : ${next}.`);
}

function updateStockPriceInput() {
  const location = document.getElementById("s-price-location")?.value || "int";
  const hiddenId = location === "ext" ? "s-prix-kit-ext" : "s-prix-kit-int";
  const input = document.getElementById("s-price-location-value");
  if (input) input.value = document.getElementById(hiddenId)?.value || "";
}

function commitStockPriceInput() {
  const location = document.getElementById("s-price-location")?.value || "int";
  const hiddenId = location === "ext" ? "s-prix-kit-ext" : "s-prix-kit-int";
  const hidden = document.getElementById(hiddenId);
  const input = document.getElementById("s-price-location-value");
  if (hidden && input) hidden.value = input.value;
}

function renderStockSaleFormats(formats = [{ quantite: 1, prixInterieur: "", prixExterieur: "" }]) {
  const container = document.getElementById("sale-formats-list");
  if (!container) return;
  const rows = formats.length ? formats : [{ quantite: 1, prixInterieur: "", prixExterieur: "" }];
  container.innerHTML = rows.map((format, index) => `
    <div class="sale-format-row" data-format-row>
      <div class="form-group">
        <label>Quantite</label>
        <input class="stock-format-qty" type="number" min="1" value="${escapeHtml(format.quantite || 1)}" placeholder="1">
      </div>
      <div class="form-group">
        <label>Prix interieur</label>
        <input class="stock-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || "")}" placeholder="ex: 700">
      </div>
      <div class="form-group">
        <label>Prix exterieur</label>
        <input class="stock-format-ext" type="number" min="0" value="${escapeHtml(format.prixExterieur || "")}" placeholder="ex: 600">
      </div>
      <button type="button" class="mini-btn" data-remove-sale-format="${index}" ${rows.length <= 1 ? "disabled" : ""}>Retirer</button>
    </div>
  `).join("");
}

function readStockSaleFormats() {
  const rows = [...document.querySelectorAll("[data-format-row]")];
  const byQuantity = new Map();
  rows.forEach((row) => {
    const quantite = Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1);
    const prixInterieur = Number(row.querySelector(".stock-format-int")?.value) || 0;
    const prixExterieur = Number(row.querySelector(".stock-format-ext")?.value) || prixInterieur;
    if (prixInterieur > 0) byQuantity.set(quantite, { quantite, prixInterieur, prixExterieur });
  });
  return [...byQuantity.values()].sort((a, b) => a.quantite - b.quantite);
}

function addStockSaleFormat() {
  const formats = [...document.querySelectorAll("[data-format-row]")].map((row) => ({
    quantite: Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1),
    prixInterieur: Number(row.querySelector(".stock-format-int")?.value) || "",
    prixExterieur: Number(row.querySelector(".stock-format-ext")?.value) || "",
  }));
  const maxQty = formats.reduce((max, format) => Math.max(max, Number(format.quantite) || 1), 0);
  renderStockSaleFormats([...formats, { quantite: maxQty + 1, prixInterieur: "", prixExterieur: "" }]);
}

function resetStockForm() {
  document.getElementById("s-edit-id").value = "";
  document.getElementById("s-article").value = "";
  document.getElementById("s-init").value = "0";
  document.getElementById("s-case-size").value = "24";
  document.getElementById("s-seuil").value = "5";
  document.getElementById("s-pack").value = "1";
  document.getElementById("s-frigo").value = "0";
  document.getElementById("s-reserve").value = "";
  document.getElementById("s-prix").value = "";
  document.getElementById("s-prix-kit-int").value = "";
  document.getElementById("s-prix-kit-ext").value = "";
  document.getElementById("s-price-location").value = "int";
  document.getElementById("s-price-location-value").value = "";
  renderStockSaleFormats();
  document.getElementById("stock-modal-title").textContent = "Nouvel article en stock";
  document.getElementById("save-stock-btn").textContent = "Enregistrer l'article";
}

function openEditStock(itemId) {
  if (!canAnyAdmin()) {
    showToast("Modification du catalogue reservee a un administrateur.");
    return;
  }
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  document.getElementById("s-edit-id").value = String(itemId);
  document.getElementById("s-article").value = item.article;
  document.getElementById("s-cat").value = item.cat;
  document.getElementById("s-case-size").value = String(caseSize(item));
  document.getElementById("s-init").value = String(item.initCases ?? casesFromBottles(item.init, item));
  document.getElementById("s-seuil").value = String(item.seuilMin || 5);
  document.getElementById("s-pack").value = String(item.packSize || 1);
  document.getElementById("s-frigo").value = String(stockFrigo(item));
  document.getElementById("s-reserve").value = String(stockReserve(item));
  document.getElementById("s-prix").value = String(item.prixAchat || "");
  document.getElementById("s-prix-kit-int").value = String(item.prixVenteInt || item.prixKitInt || item.prixBouteille || item.prixVente || "");
  document.getElementById("s-prix-kit-ext").value = String(item.prixVenteExt || item.prixKitExt || item.prixBouteille || item.prixVente || "");
  document.getElementById("s-price-location").value = "int";
  renderStockSaleFormats(normalizeSaleFormats(item));
  updateStockPriceInput();
  document.getElementById("stock-modal-title").textContent = `Modifier : ${item.article}`;
  document.getElementById("save-stock-btn").textContent = "Enregistrer les modifications";
  openModal("modal-stock");
}

async function saveStock() {
  commitStockPriceInput();
  if (!canAnyAdmin()) {
    showToast("Modification du catalogue reservee a un administrateur.");
    return;
  }
  const editId = document.getElementById("s-edit-id").value;
  const articleName = document.getElementById("s-article").value.trim();
  if (!articleName) {
    showToast("Nom de l'article obligatoire.");
    return;
  }
  const fields = {
    caseSize: (VALID_CASE_SIZES.includes(Number(document.getElementById("s-case-size").value)) ? Number(document.getElementById("s-case-size").value) : 24),
    article: articleName,
    cat: document.getElementById("s-cat").value,
    initCases: Number(document.getElementById("s-init").value) || 0,
    seuilMin: Number(document.getElementById("s-seuil").value) || 5,
    prixAchat: Number(document.getElementById("s-prix").value) || 0,
  };
  fields.formatsVente = readStockSaleFormats();
  const primaryFormat = fields.formatsVente.find((format) => format.quantite === 1) || fields.formatsVente[0];
  fields.packSize = Math.max(1, Number(primaryFormat?.quantite) || Number(document.getElementById("s-pack").value) || 1);
  fields.prixVenteInt = Number(primaryFormat?.prixInterieur) || Number(document.getElementById("s-prix-kit-int").value) || 0;
  fields.prixVenteExt = Number(primaryFormat?.prixExterieur) || Number(document.getElementById("s-prix-kit-ext").value) || fields.prixVenteInt;
  fields.init = fields.initCases * fields.caseSize;
  fields.frigo = Math.max(0, Number(document.getElementById("s-frigo").value) || 0);
  const reserveInput = document.getElementById("s-reserve").value;
  fields.reserve = reserveInput === "" ? Math.max(0, fields.init - fields.frigo) : Math.max(0, Number(reserveInput) || 0);
  fields.prixBouteille = fields.packSize === 1 ? fields.prixVenteInt : 0;
  fields.prixKitInt = fields.packSize > 1 ? fields.prixVenteInt : 0;
  fields.prixKitExt = fields.packSize > 1 ? fields.prixVenteExt : 0;
  if (fields.prixAchat <= 0 || !fields.formatsVente.length || fields.prixVenteInt <= 0) {
    showToast("Prix achat et au moins un format avec prix interieur obligatoires.");
    return;
  }
  if (fields.prixVenteExt <= 0) {
    fields.prixVenteExt = fields.prixVenteInt;
  }
  if (editId) {
    const item = state.stock.find((i) => i.id === Number(editId));
    if (item) Object.assign(item, fields);
  } else {
    state.stock.push({ id: state.nextId.stock++, siteId: currentSiteId(), entrees: 0, sorties: 0, createdAt: new Date().toISOString(), createdBy: sessionUser || "-", ...fields });
    recordStaffAudit("create", "catalogue_article", `Article ajoute : ${articleName}`, `${fields.cat} · PA ${fmt(fields.prixAchat)}/cas. · vente int. ${fmt(fields.prixVenteInt)}`);
  }
  await persistState();
  closeModal("modal-stock");
  resetStockForm();
  if (currentPage === "home") renderDashboard();
  renderStock();
  showToast(editId ? `"${articleName}" mis a jour.` : "Article catalogue ajoute.");
}

function stockMovementDateValue(item) {
  return String(item.date || item.createdAt || "").slice(0, 10);
}

function stockMovements() {
  const siteId = currentSiteId();
  const multiSite = multiSiteActive();
  const movements = [];
  recordsForSite(state.stock).forEach((item) => {
    const created = item.createdAt || today();
    if (Number(item.init) > 0) {
      movements.push({ date: created, article: item.article, type: "entree", qty: Number(item.init) || 0, unit: "Bouteille", reason: "Stock initial", user: item.createdBy || "-" });
    }
    const itemEntrees = (state.stockEntrees || []).filter((e) => rowMatchesSite(e, siteId, multiSite) && e.article === item.article);
    if (itemEntrees.length > 0) {
      itemEntrees.forEach((e) => {
        movements.push({ date: e.date, article: e.article, type: "entree", qty: e.qty, unit: "Bouteille", reason: `Achat (${fmt(e.cases)} casier(s) x ${fmt(e.caseSize)} btl)`, user: e.user });
      });
    } else if (Number(item.entrees) > 0) {
      movements.push({ date: item.lastReapproAt || today(), article: item.article, type: "entree", qty: Number(item.entrees) || 0, unit: "Bouteille", reason: "Approvisionnement (historique)", user: item.lastReapproBy || "-" });
    }
    // item.sorties is a cumulative accounting counter — individual ventes are already listed below
  });
  (state.stockLosses || []).filter((l) => rowMatchesSite(l, siteId, multiSite)).forEach((loss) => {
    movements.push({
      date: loss.date || loss.createdAt || today(),
      article: loss.article,
      type: "sortie",
      qty: loss.qty,
      unit: "Bouteille",
      reason: `Perte : ${loss.motif}${loss.notes ? " – " + loss.notes : ""}`,
      user: loss.createdBy || "-",
    });
  });
  recordsForSite(state.ventes).forEach((vente) => {
    const stockItem = (state.stock || []).find((item) => item.siteId === siteId && item.article === vente.article);
    const packSize = Math.max(1, Number(stockItem?.packSize) || 1);
    movements.push({
      date: vente.date || today(),
      article: vente.article,
      type: "sortie",
      qty: (Number(vente.qty) || 0) * packSize,
      unit: "Bouteille",
      reason: `Vente ${vente.factureNumber || ""}`.trim(),
      user: vente.server || vente.serveur || sessionUser || "-",
    });
  });
  return movements;
}

function renderStockMovements() {
  const start = document.getElementById("stock-move-start")?.value || "";
  const end = document.getElementById("stock-move-end")?.value || "";
  const type = document.getElementById("stock-move-type")?.value || "all";
  const movements = stockMovements().filter((item) => {
    const date = stockMovementDateValue(item);
    return (!start || date >= start) && (!end || date <= end) && (type === "all" || item.type === type);
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const entree = movements.filter((item) => item.type === "entree").reduce((sum, item) => sum + item.qty, 0);
  const sortie = movements.filter((item) => item.type === "sortie").reduce((sum, item) => sum + item.qty, 0);
  document.getElementById("stock-movement-count").textContent = `${fmt(movements.length)} mouvement(s)`;
  document.getElementById("stock-movement-summary").innerHTML = `
    <div class="pdj-kpi"><span class="kpi-label">Mouvements</span><strong class="pdj-val amber">${fmt(movements.length)}</strong></div>
    <div class="pdj-kpi"><span class="kpi-label">Entrees</span><strong class="pdj-val amber">${fmt(entree)}</strong></div>
    <div class="pdj-kpi"><span class="kpi-label">Sorties</span><strong class="pdj-val red">${fmt(sortie)}</strong></div>
  `;
  document.getElementById("stock-movement-list").innerHTML = movements.length
    ? movements.map((item) => `<tr>
      <td>${escapeHtml(formatDateDdMmYyyy(item.date || item.createdAt))}</td>
      <td>${escapeHtml(item.article)}</td>
      <td>${item.type === "entree" ? "Entree" : "Sortie"}</td>
      <td style="text-align:right">${fmt(item.qty)}</td>
      <td>${escapeHtml(item.unit)}</td>
      <td>${escapeHtml(item.reason)}</td>
      <td>${escapeHtml(item.user)}</td>
    </tr>`).join("")
    : `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">Aucun mouvement trouve</td></tr>`;
}

async function closeAccountingDay() {
  const items = recordsForSite(state.stock);
  if (!items.length) {
    showToast("Aucun stock a verifier.");
    return;
  }
  const dStr = pdjCalendarDate();
  if (!canAnyAdmin() && dStr !== today()) {
    showToast("Seul un administrateur peut cloturer une autre date.");
    return;
  }
  const dayBook = dayBookFor(dStr, currentSiteId());
  const isPastDateCorrection = dStr !== today() && canAnyAdmin();
  if (!isPastDateCorrection && (!dayBook || dayBookNeedsCashOpening(dayBook))) {
    showToast(dStr === today()
      ? "Enregistrez d'abord l'ouverture de caisse pour aujourd'hui."
      : "Enregistrez d'abord l'ouverture de caisse pour cette journee.");
    return;
  }
  const closingRaw = document.getElementById("pdj-closing-cash")?.value;
  if (!isPastDateCorrection && (closingRaw === undefined || closingRaw === null || String(closingRaw).trim() === "")) {
    showToast("Saisissez le montant espèces dénombrées à la fermeture.");
    return;
  }
  const closingCashFcfa = Math.max(0, Number(closingRaw) || 0);
  if (Number.isNaN(closingCashFcfa)) {
    showToast("Montant de fermeture invalide.");
    return;
  }

  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum : sum + a, 0);
  const caCreances = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum + a : sum, 0);
  const especesVentes = Number(totauxJour["Espèces"]) || 0;
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces") ? sum + (Number(c.montant) || 0) : sum
  ), 0);
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  const expectedEspecesCash = openingCash + especesVentes - especesCharges;
  const cashEcartEspeces = closingCashFcfa - expectedEspecesCash;

  const checkedItems = items.map((item) => {
    const frigo = Math.max(0, Number(document.querySelector(`[data-check-frigo="${item.id}"]`)?.value) || 0);
    const reserve = Math.max(0, Number(document.querySelector(`[data-check-reserve="${item.id}"]`)?.value) || 0);
    const stockAtOpen = Number(dayBook?.openingStockById?.[String(item.id)]) || stockActuel(item); // ouverture figée
    const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
    const expectedRemaining = Math.max(0, stockAtOpen - sortiesToday); // restant théorique après ventes
    const counted = frigo + reserve;
    return {
      id: item.id,
      article: item.article,
      cat: item.cat || "",
      stockAvant: stockAtOpen,        // stock à l'ouverture
      sortiesToday,
      expected: expectedRemaining,    // restant théorique (ouverture − ventes)
      frigo,
      reserve,
      counted,
      ecart: counted - expectedRemaining, // écart physique réel (hors ventes)
      stockApres: counted,
    };
  });
  const stockGaps = checkedItems.filter((item) => item.ecart !== 0);
  if (stockGaps.length && !canAnyAdmin()) {
    showToast(`Stock non conforme : ${stockGaps.length} article(s) avec écart. Ajustez frigo et réserve jusqu'à OK sur chaque ligne.`);
    return;
  }

  // Find previous close for today to reverse its effects before re-applying
  const prevClose = (state.stockChecks || []).find(
    (sc) => sc.siteId === currentSiteId() && sc.date === dStr,
  );
  checkedItems.forEach((checked) => {
    const item = state.stock.find((stockItem) => stockItem.id === checked.id);
    if (!item) return;
    item.frigo = checked.frigo;
    item.reserve = checked.reserve;
    // Annuler la cloture precedente du jour pour eviter le double-comptage
    if (prevClose) {
      const prev = (prevClose.items || []).find((pi) => pi.id === checked.id);
      if (prev) {
        if (prev.sortiesToday > 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - prev.sortiesToday);
        if (prev.ecart > 0) item.entrees = Math.max(0, (Number(item.entrees) || 0) - prev.ecart);
        if (prev.ecart < 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - Math.abs(prev.ecart));
      }
    }
    // Déduire les ventes du jour du stock (réduit stockActuel correctement)
    if (checked.sortiesToday > 0) {
      item.sorties = (Number(item.sorties) || 0) + checked.sortiesToday;
      item.lastSortieAt = new Date().toISOString();
      item.lastSortieBy = sessionUser || "system";
    }
    // Écrire uniquement l'écart physique réel (gain ou perte hors ventes)
    if (checked.ecart > 0) item.entrees = (Number(item.entrees) || 0) + checked.ecart;
    if (checked.ecart < 0) item.sorties = (Number(item.sorties) || 0) + Math.abs(checked.ecart);
  });
  const check = {
    id: Date.now(),
    siteId: currentSiteId(),
    date: dStr,
    createdAt: new Date().toISOString(),
    openedAt: dayBook?.openedAt || "",
    openingCashFcfa: openingCash,
    closingCashFcfa,
    expectedEspecesCash,
    cashEcartEspeces,
    caEncaisse,
    caCreances,
    nbVentes: ventesJour.length,
    totauxJour,
    items: checkedItems,
  };
  state.stockChecks = [
    check,
    ...(state.stockChecks || []).filter((item) => !(item.siteId === check.siteId && item.date === check.date)),
  ];
  recordStaffAudit(
    "update",
    "cloture_jour",
    `Cloture journee ${formatDateDdMmYyyy(dStr)}`,
    `CA encaisse ${fmt(caEncaisse)} · stock conforme · caisse esp. ecart ${fmt(cashEcartEspeces)}`,
  );
  await persistState({ stock: state.stock, stockChecks: state.stockChecks });
  renderStock();
  renderPointDuJour();
  const cashHint = cashEcartEspeces === 0 ? "" : ` Écart espèces : ${cashEcartEspeces > 0 ? "+" : ""}${fmt(cashEcartEspeces)} FCFA.`;
  showToast(`Journée clôturée : stock conforme.${cashHint}`);
}

async function saveCharge() {
  const charge = {
    id: state.nextId.charge++,
    siteId: currentSiteId(),
    date: document.getElementById("c-date").value || today(),
    lib: document.getElementById("c-lib").value.trim(),
    cat: document.getElementById("c-cat").value,
    montant: Number(document.getElementById("c-montant").value) || 0,
    paiement: document.getElementById("c-pay").value,
  };
  if (!charge.lib || charge.montant <= 0) {
    showToast("Libelle et montant obligatoires.");
    return;
  }
  state.charges.unshift(charge);
  recordStaffAudit("create", "charge", `Depense : ${charge.lib}`, `${fmt(charge.montant)} FCFA · ${charge.cat} · ${charge.paiement}`);
  await persistState();
  closeModal("modal-charge");
  document.getElementById("c-date").value = today();
  document.getElementById("c-lib").value = "";
  document.getElementById("c-montant").value = "";
  renderDashboard();
  renderCharges();
  showToast("Depense enregistree.");
}

async function saveParams() {
  const site = currentSite();
  const categories = (document.getElementById("p-categories")?.value || "")
    .split(/\r?\n|,/)
    .map((value) => value.trim())
    .filter(Boolean);
  const cleanCategories = [...new Set(categories)].length ? [...new Set(categories)] : CATEGORIES;
  const updatedSites = state.sites.map((item) => item.id === site.id ? {
    ...item,
    nom: document.getElementById("p-nom").value.trim() || "Mon Bar",
    ville: document.getElementById("p-ville").value.trim(),
    pays: document.getElementById("p-pays").value.trim(),
    gerant: document.getElementById("p-gerant").value.trim(),
    objectifCA: Number(document.getElementById("p-obj").value) || 500000,
    seuilStock: Number(document.getElementById("p-seuil").value) || 5,
    prefixeFacture: (document.getElementById("p-prefixe").value.trim() || item.prefixeFacture || "FAC").toUpperCase(),
  } : item);
  await persistState({ sites: updatedSites, categories: cleanCategories });
  populateCategorySelects();
  loadParamsForm();
  renderTopbar();
  renderSiteSwitcher();
  renderHero();
  showToast("Parametres sauvegardes.");
}

async function restoreFromJson() {
  if (!canSuperAdmin()) {
    showToast("Seul le super administrateur peut restaurer depuis data.json.");
    return;
  }
  if (!window.confirm("Restaurer depuis data.json ?\n\nCela remplacera l'etat actuel (SQLite/JSON) par le contenu de data.json.")) {
    return;
  }
  try {
    state = await apiRequest(API.restoreFromJson, { method: "POST", body: JSON.stringify({}) });
    renderTopbar();
    renderSiteSwitcher();
    renderHero();
    renderDashboard();
    renderPointDuJour();
    renderVentesPage();
    renderStock();
    renderCharges();
    renderSitesList();
    resetUserForm();
    renderUsersList();
    showToast("Restauration terminee. Rechargez la page si besoin.");
  } catch (error) {
    showToast(error.message || "Echec restauration.");
  }
}

/** Cellule Excel exportee/reimportee : cle absente ou vide => ne pas forcer la valeur en base. */
function excelNumericCell(row, key) {
  if (!Object.prototype.hasOwnProperty.call(row, key)) return undefined;
  const raw = row[key];
  if (raw === "" || raw === null || raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function excelImportedCaseSize(row) {
  const raw = Number(row["Taille casier"]);
  return VALID_CASE_SIZES.includes(raw) ? raw : 24;
}

/** Reprend les colonnes physiques de exportStockExcel pour un aller-retour fidele. */
function physicalStockPatchFromExcel(row, existing, initBtl) {
  const patch = {};
  const entrees = excelNumericCell(row, "Entrees (btl)");
  const sorties = excelNumericCell(row, "Sorties (btl)");
  const frigo = excelNumericCell(row, "Frigo (btl)");
  const reserve = excelNumericCell(row, "Reserve (btl)");
  const actuel = excelNumericCell(row, "Stock Actuel (btl)");

  if (entrees !== undefined) patch.entrees = Math.max(0, Math.round(entrees));
  if (sorties !== undefined) patch.sorties = Math.max(0, Math.round(sorties));

  const hasF = frigo !== undefined;
  const hasR = reserve !== undefined;
  const hasA = actuel !== undefined;

  if (hasF && hasR) {
    patch.frigo = Math.max(0, Math.round(frigo));
    patch.reserve = Math.max(0, Math.round(reserve));
  } else if (hasA && !hasF && !hasR) {
    patch.frigo = Math.max(0, Math.round(actuel));
    patch.reserve = 0;
  } else if (hasF && !hasR) {
    patch.frigo = Math.max(0, Math.round(frigo));
    patch.reserve = 0;
  } else if (hasR && !hasF) {
    patch.reserve = Math.max(0, Math.round(reserve));
    const actRef = hasA ? Math.max(0, Math.round(actuel)) : (existing ? stockActuel(existing) : Math.max(0, Math.round(initBtl)));
    patch.frigo = Math.max(0, actRef - patch.reserve);
  }

  return patch;
}

function exportStockExcel() {
  if (typeof XLSX === "undefined") {
    showToast("Bibliotheque Excel non chargee. Verifiez votre connexion.");
    return;
  }
  const items = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  if (!items.length) { showToast("Aucun article en stock a exporter."); return; }

  const rows = items.map((item) => {
    const { prixInt, prixExt } = resolveItemPrices(item);
    return {
      "Article": item.article,
      "Categorie": item.cat || "",
      "Taille casier": caseSize(item),
      "Btl / kit": Math.max(1, Number(item.packSize) || 1),
      "Stock Initial (btl)": Number(item.init) || 0,
      "Entrees (btl)": Number(item.entrees) || 0,
      "Sorties (btl)": Number(item.sorties) || 0,
      "Stock Actuel (btl)": stockActuel(item),
      "Frigo (btl)": stockFrigo(item),
      "Reserve (btl)": stockReserve(item),
      "Seuil Min (btl)": Number(item.seuilMin) || 0,
      "Prix Achat / cas. (FCFA)": Number(item.prixAchat) || 0,
      "Prix Vente Int. (FCFA)": prixInt,
      "Prix Vente Ext. (FCFA)": prixExt,
    };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  // Largeurs de colonnes
  ws["!cols"] = [22, 18, 13, 10, 17, 13, 13, 16, 12, 13, 15, 22, 22, 22].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Stock");
  const siteName = (currentSite()?.nom || "stock").replace(/[^a-zA-Z0-9]/g, "_");
  XLSX.writeFile(wb, `stock_${siteName}_${today()}.xlsx`);
}

async function importStockExcel(file) {
  if (typeof XLSX === "undefined") {
    showToast("Bibliotheque Excel non chargee. Verifiez votre connexion.");
    return;
  }
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      if (!rows.length) { showToast("Fichier vide ou format incorrect."); return; }

      let created = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const articleName = String(row["Article"] || "").trim();
        if (!articleName) { skipped++; continue; }

        const caseS = excelImportedCaseSize(row);
        const packS = Math.max(1, Number(row["Btl / kit"]) || 1);
        const initBtl = Math.max(0, Number(row["Stock Initial (btl)"]) || 0);
        const prixAchat = Number(row["Prix Achat / cas. (FCFA)"]) || 0;
        const prixVenteInt = Number(row["Prix Vente Int. (FCFA)"]) || 0;
        const prixVenteExt = Number(row["Prix Vente Ext. (FCFA)"]) || prixVenteInt;
        const csDiv = Math.max(1, caseS);

        const fields = {
          article: articleName,
          cat: String(row["Categorie"] || "").trim(),
          caseSize: caseS,
          packSize: packS,
          init: initBtl,
          initCases: Math.round(initBtl / csDiv),
          seuilMin: Math.max(0, Number(row["Seuil Min (btl)"]) || 5),
          prixAchat,
          prixVenteInt,
          prixVenteExt,
          prixBouteille: packS === 1 ? prixVenteInt : 0,
          prixKitInt: packS > 1 ? prixVenteInt : 0,
          prixKitExt: packS > 1 ? prixVenteExt : 0,
        };

        const existing = state.stock.find(
          (s) => s.siteId === currentSiteId() && s.article.toLowerCase() === articleName.toLowerCase()
        );
        const physicalPatch = physicalStockPatchFromExcel(row, existing || null, initBtl);

        if (existing) {
          Object.assign(existing, fields, physicalPatch);
          updated++;
        } else {
          state.stock.push({
            id: state.nextId.stock++,
            siteId: currentSiteId(),
            entrees: physicalPatch.entrees ?? 0,
            sorties: physicalPatch.sorties ?? 0,
            frigo: physicalPatch.frigo ?? Math.max(0, Math.round(initBtl)),
            reserve: physicalPatch.reserve ?? 0,
            createdAt: new Date().toISOString(),
            createdBy: sessionUser || "-",
            ...fields,
          });
          created++;
        }
      }
      await persistState();
      renderStock();
      showToast(`Import termine : ${created} ajout(s), ${updated} mise(s) a jour.${skipped ? ` ${skipped} ligne(s) ignoree(s).` : ""}`);
    } catch (err) {
      console.error("Import Excel error:", err);
      showToast("Erreur lors de l'import. Verifiez le format du fichier.");
    }
  };
  reader.readAsArrayBuffer(file);
}

function exportData() {
  const payload = { ...state, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `tdb_bar_${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function printOrderTicket(orderId = activeOrderId) {
  const order = recordsForSite(state.commandes).find((item) => item.id === orderId);
  if (!order) {
    showToast("Aucune commande selectionnee pour impression.");
    return;
  }
  const site = currentSite();
  const total = order.lignes.reduce((sum, line) => sum + calcNet(line), 0);
  const ticketWindow = window.open("", "_blank", "width=420,height=720");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir la fenetre d'impression.");
    return;
  }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Ticket ${escapeHtml(order.client)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1,h2,p{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px 0;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.total{margin-top:16px;font-size:20px;font-weight:700}.muted{color:#666;font-size:12px}</style></head><body><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p><p class="muted">Client: ${escapeHtml(order.client || "Comptoir")} · Date: ${escapeHtml(formatDateDdMmYyyy(order.date))}</p><table><thead><tr><th>Article</th><th>Qté</th><th>Montant</th></tr></thead><tbody>${order.lignes.map((line) => `<tr><td>${escapeHtml(line.article)}</td><td>${fmt(line.qty)}</td><td>${fmt(calcNet(line))} FCFA</td></tr>`).join("")}</tbody></table><p class="total">Total: ${fmt(total)} FCFA</p><p class="muted">${escapeHtml(order.note || "")}</p><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function printInvoice(factureNumber) {
  const lignes = recordsForSite(state.ventes).filter((item) => item.factureNumber === factureNumber);
  if (!lignes.length) {
    showToast("Facture introuvable.");
    return;
  }
  const site = currentSite();
  const total = lignes.reduce((sum, line) => sum + calcNet(line), 0);
  const client = lignes[0].client || "Client comptoir";
  const ticketWindow = window.open("", "_blank", "width=900,height=1000");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir la fenetre d'impression.");
    return;
  }
  const allDetails = paymentTotals(lignes);
  const paymentEntries = Object.entries(allDetails);
  const isMixed = paymentEntries.length > 1;
  const debiteur = lignes[0].debiteur || "";
  const creditIssuerPrint = String(lignes[0].creditIssuedBy || "").trim();
  const paymentSection = isMixed
    ? paymentEntries.map(([method, amount]) => `<p><span>${escapeHtml(method)}</span><span>${fmt(amount)} FCFA</span></p>`).join("")
    : `<p><span>${escapeHtml(paymentEntries[0]?.[0] || lignes[0].paiement || "-")}</span><span>${fmt(total)} FCFA</span></p>`;
  const creditSection = debiteur
    ? `<p style="color:#c54f41"><span>Débiteur</span><span>${escapeHtml(debiteur)}</span></p>${creditIssuerPrint ? `<p class="meta"><span>Crédit accordé par</span><span>${escapeHtml(creditIssuerPrint)}</span></p>` : ""}`
    : "";
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Facture ${escapeHtml(factureNumber)}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111;background:#fff}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:16px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.meta{color:#555}.totals{margin-top:18px;display:flex;justify-content:flex-end}.totals-box{min-width:300px;border:1px solid #111;padding:16px}.totals-box p{display:flex;justify-content:space-between;margin-bottom:6px}.grand{font-size:20px;font-weight:700;border-top:1px solid #111;padding-top:8px;margin-top:8px}.footer{margin-top:26px;color:#666;font-size:12px}.pay-label{font-size:12px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} - ${escapeHtml(site?.pays || "")}</p><p>Gerant: ${escapeHtml(site?.gerant || "-")}</p></div><div><h2>Facture</h2><p class="meta">Numero: ${escapeHtml(factureNumber)}</p><p class="meta">Date: ${escapeHtml(formatDateDdMmYyyy(lignes[0].date))}</p><p class="meta">Client: ${escapeHtml(client)}</p></div></header><table><thead><tr><th>Article</th><th>Qte</th><th>Prix unit.</th><th>Remise</th><th>Total</th></tr></thead><tbody>${lignes.map((line) => `<tr><td>${escapeHtml(line.article)}</td><td>${fmt(line.qty)}</td><td>${fmt(line.prix)} FCFA</td><td>${fmt(line.remise || 0)} FCFA</td><td>${fmt(calcNet(line))} FCFA</td></tr>`).join("")}</tbody></table><div class="totals"><div class="totals-box">${isMixed ? `<p class="pay-label" style="display:block">Paiement mixte</p>` : ""}${paymentSection}${creditSection}<p class="grand"><span>Total facture</span><span>${fmt(total)} FCFA</span></p></div></div><p class="footer">Merci pour votre visite.</p><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function printDayClosure() {
  const reportDateStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(reportDateStr, currentSiteId());
  if (!closed) { showToast("Aucune cloture enregistree pour la journee affichee."); return; }
  const site = currentSite();
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === reportDateStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === reportDateStr);

  // Grouper les ventes par article : qty totale + montant total + par mode de paiement
  const byArticle = {};
  ventesJour.forEach((v) => {
    if (!byArticle[v.article]) byArticle[v.article] = { qty: 0, montant: 0, especes: 0, wave: 0, orange: 0, mtn: 0, carte: 0, credit: 0 };
    const entry = byArticle[v.article];
    entry.qty += Number(v.qty) || 0;
    entry.montant += calcNet(v);
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: calcNet(v) }];
    details.forEach((d) => {
      const a = Number(d.amount) || 0;
      if (d.method === "Espèces") entry.especes += a;
      else if (d.method === "Wave") entry.wave += a;
      else if (d.method === "Orange Money") entry.orange += a;
      else if (d.method === "MTN MoMo") entry.mtn += a;
      else if (d.method === "Carte") entry.carte += a;
      else if (d.method === "Crédit client") entry.credit += a;
    });
  });

  // Créances par débiteur
  const creancesMap = {};
  ventesJour.forEach((v) => {
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: calcNet(v) }];
    details.forEach((d) => {
      if (d.method === "Crédit client" && Number(d.amount) > 0) {
        const nom = v.debiteur?.trim() || v.client?.trim() || "Client inconnu";
        creancesMap[nom] = (creancesMap[nom] || 0) + Number(d.amount);
      }
    });
  });
  const creancesEntries = Object.entries(creancesMap);

  const totauxJour = closed.totauxJour || paymentTotals(ventesJour);
  const tEspeces = totauxJour["Espèces"] || 0;
  const tWave = totauxJour["Wave"] || 0;
  const tOrange = totauxJour["Orange Money"] || 0;
  const tMtn = totauxJour["MTN MoMo"] || 0;
  const tCarte = totauxJour["Carte"] || 0;
  const tCredit = totauxJour["Crédit client"] || 0;
  const caEncaisse = closed.caEncaisse || 0;
  const caCreances = closed.caCreances || 0;
  const chargesTotal = chargesJour.reduce((sum, c) => sum + Number(c.montant || 0), 0);
  const benefice = caEncaisse - chargesTotal;
  const gaps = (closed.items || []).filter((ci) => ci.ecart !== 0).length;
  const cashCloseRows =
    typeof closed.openingCashFcfa === "number"
      ? `<h3 style="margin-top:10px;padding-top:8px;border-top:1px solid #ddd">Caisse especes</h3>
      <div class="box-row"><span>Ouverture</span><strong>${fmt(closed.openingCashFcfa)} FCFA</strong></div>
      ${typeof closed.closingCashFcfa === "number" ? `<div class="box-row"><span>Fermeture (denombre)</span><strong>${fmt(closed.closingCashFcfa)} FCFA</strong></div>` : ""}
      ${typeof closed.expectedEspecesCash === "number" ? `<div class="box-row"><span>Theorique caisse</span><strong>${fmt(closed.expectedEspecesCash)} FCFA</strong></div>` : ""}
      ${typeof closed.cashEcartEspeces === "number" ? `<div class="box-row" style="font-weight:700;color:${closed.cashEcartEspeces === 0 ? "#2a9d5c" : "#c0392b"}"><span>Ecart especes</span><strong>${closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)} FCFA`}</strong></div>` : ""}`
      : "";
  const cashHeaderExtra = typeof closed.openingCashFcfa === "number"
    ? `<br>Caisse esp. : ouv. ${fmt(closed.openingCashFcfa)} · ferm. ${typeof closed.closingCashFcfa === "number" ? fmt(closed.closingCashFcfa) : "-"} · ecart ${typeof closed.cashEcartEspeces === "number" ? (closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)}`) : "-"}`
    : "";

  // Regrouper les items du check par article (plusieurs entrées stock peuvent exister pour le même article)
  // IMPORTANT : sortiesToday est identique pour toutes les entrées d'un même article (même valeur issue des ventes)
  // → on la prend une seule fois (première entrée), et on ne la somme PAS
  const checkByArticle = {};
  (closed.items || []).forEach((ci) => {
    if (!checkByArticle[ci.article]) {
      checkByArticle[ci.article] = {
        sortiesToday: Number(ci.sortiesToday ?? 0), // pris une seule fois
        expected: 0,
        ecart: 0,
      };
    }
    const a = checkByArticle[ci.article];
    a.expected += Number(ci.expected ?? 0);
    a.ecart += Number(ci.ecart ?? 0);
  });
  // stockAvant = stock théorique total + sorties réelles (UNE fois)
  Object.values(checkByArticle).forEach((a) => { a.stockAvant = a.expected + a.sortiesToday; });

  // Ligne fiche par article — une seule ligne par désignation
  let totalSorties = 0, totalMontant = 0, totalEsp = 0, totalWave = 0, totalOrange = 0, totalMtn = 0, totalCarte = 0, totalCredit = 0;
  const ficheRows = Object.entries(checkByArticle).map(([article, ci]) => {
    const v = byArticle[article] || { qty: 0, montant: 0, especes: 0, wave: 0, orange: 0, mtn: 0, carte: 0, credit: 0 };
    // RESTE = stock théorique restant = stockAvant − sortiesToday = expected
    const reste = ci.expected;
    const ecartMark = ci.ecart !== 0 ? ` <span style="color:#c0392b;font-size:9px">(ecart ${ci.ecart > 0 ? "+" : ""}${fmt(ci.ecart)})</span>` : "";
    totalSorties += ci.sortiesToday; totalMontant += v.montant;
    totalEsp += v.especes; totalWave += v.wave; totalOrange += v.orange;
    totalMtn += v.mtn; totalCarte += v.carte; totalCredit += v.credit;
    return `<tr>
      <td>${escapeHtml(article)}</td>
      <td style="text-align:right">${fmt(ci.stockAvant)}</td>
      <td style="text-align:right">${fmt(ci.sortiesToday)}</td>
      <td style="text-align:right">${fmt(v.montant)}</td>
      <td style="text-align:right;font-weight:700;background:#f0f8f0">${fmt(reste)}${ecartMark}</td>
      <td style="text-align:right">${v.wave ? fmt(v.wave) : ""}</td>
      <td style="text-align:right">${v.orange ? fmt(v.orange) : ""}</td>
      <td style="text-align:right">${v.mtn ? fmt(v.mtn) : ""}</td>
      <td style="text-align:right">${v.credit ? fmt(v.credit) : ""}</td>
      <td style="text-align:right">${v.carte ? fmt(v.carte) : ""}</td>
      <td style="text-align:right">${v.especes ? fmt(v.especes) : ""}</td>
    </tr>`;
  }).join("");

  const dateLabel = formatDateDdMmYyyy(closed.date || reportDateStr);
  const generatedAt = formatDateTimeDdMmYyyy(closed.createdAt);

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <title>Fiche de cloture ${formatDateDdMmYyyy(reportDateStr)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 16px; color: #111; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; border-bottom: 2px solid #111; padding-bottom: 8px; }
    .header h1 { font-size: 18px; }
    .header .meta { font-size: 10px; color: #555; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
    th, td { padding: 4px 6px; border: 1px solid #ccc; text-align: left; white-space: nowrap; }
    th { background: #ddd; font-weight: 700; font-size: 9px; text-transform: uppercase; text-align: center; }
    tr:nth-child(even) { background: #fafafa; }
    .total-row td { font-weight: 700; background: #eee; border-top: 2px solid #333; }
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
    .box { border: 1px solid #ccc; padding: 8px 12px; }
    .box h3 { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .box-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; }
    .box-row strong { font-size: 12px; }
    .box-row.total { border-top: 1px solid #ccc; margin-top: 4px; padding-top: 5px; font-weight: 700; }
    .summary-box { border: 2px solid #111; padding: 8px 14px; margin-top: 12px; }
    .summary-box .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #eee; }
    .summary-box .row:last-child { border-bottom: none; font-weight: 700; font-size: 13px; }
    .footer { margin-top: 14px; font-size: 9px; color: #aaa; text-align: center; }
    @media print { body { padding: 8px; } }
  </style></head><body>

  <div class="header">
    <div>
      <h1>${escapeHtml(site?.nom || "TDB Bar")}</h1>
      <div style="font-size:10px;margin-top:2px">FICHE DE CONTROLE — ${dateLabel}</div>
    </div>
    <div class="meta">Cloture : ${generatedAt}<br>Gerant : ${escapeHtml(sessionUser || "-")}<br>Ecarts stock : ${gaps}${cashHeaderExtra}</div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="text-align:left;min-width:120px">Designation</th>
        <th>Nombre</th>
        <th>Vente</th>
        <th>Somme (FCFA)</th>
        <th style="background:#c8e6c9">Reste</th>
        <th>Wave</th>
        <th>Orange</th>
        <th>MTN</th>
        <th>Credit</th>
        <th>Carte</th>
        <th>Caisse</th>
      </tr>
    </thead>
    <tbody>
      ${ficheRows}
      <tr class="total-row">
        <td>TOTAL GENERAL</td>
        <td></td>
        <td style="text-align:right">${fmt(totalSorties)}</td>
        <td style="text-align:right">${fmt(totalMontant)}</td>
        <td style="background:#c8e6c9"></td>
        <td style="text-align:right">${fmt(totalWave)}</td>
        <td style="text-align:right">${fmt(totalOrange)}</td>
        <td style="text-align:right">${fmt(totalMtn)}</td>
        <td style="text-align:right">${fmt(totalCredit)}</td>
        <td style="text-align:right">${fmt(totalCarte)}</td>
        <td style="text-align:right">${fmt(totalEsp)}</td>
      </tr>
    </tbody>
  </table>

  <div class="bottom-grid">
    <div class="box">
      <h3>Encaissements par mode</h3>
      ${tEspeces ? `<div class="box-row"><span>Especes</span><strong>${fmt(tEspeces)} FCFA</strong></div>` : ""}
      ${tWave ? `<div class="box-row"><span>Wave</span><strong>${fmt(tWave)} FCFA</strong></div>` : ""}
      ${tOrange ? `<div class="box-row"><span>Orange Money</span><strong>${fmt(tOrange)} FCFA</strong></div>` : ""}
      ${tMtn ? `<div class="box-row"><span>MTN MoMo</span><strong>${fmt(tMtn)} FCFA</strong></div>` : ""}
      ${tCarte ? `<div class="box-row"><span>Carte</span><strong>${fmt(tCarte)} FCFA</strong></div>` : ""}
      ${tCredit ? `<div class="box-row"><span>Credit client</span><strong>${fmt(tCredit)} FCFA</strong></div>` : ""}
      <div class="box-row total"><span>Total encaisse</span><strong>${fmt(caEncaisse)} FCFA</strong></div>
      ${caCreances ? `<div class="box-row" style="color:#c0392b;font-weight:700;margin-top:6px;border-top:1px solid #f0c0b0;padding-top:5px"><span>A regler (creances)</span><strong>${fmt(caCreances)} FCFA</strong></div>${creancesEntries.map(([nom, montant]) => `<div class="box-row" style="padding-left:14px;font-size:10px;color:#c0392b"><span>↳ ${escapeHtml(nom)}</span><span>${fmt(montant)} FCFA</span></div>`).join("")}` : ""}
      ${cashCloseRows}
    </div>
    <div>
      <div class="summary-box">
        <div class="row"><span>CA encaisse</span><strong>${fmt(caEncaisse)} FCFA</strong></div>
        ${chargesTotal ? `<div class="row"><span>Charges du jour</span><strong>- ${fmt(chargesTotal)} FCFA</strong></div>` : ""}
        ${chargesJour.map((c) => `<div class="row" style="font-size:10px;color:#555;padding-left:12px"><span>${escapeHtml(c.lib || c.libelle || c.cat || c.categorie || "Charge")}</span><span>${fmt(c.montant)} FCFA</span></div>`).join("")}
        <div class="row"><span>Benefice net</span><strong style="color:${benefice >= 0 ? "#2a9d5c" : "#c0392b"}">${fmt(benefice)} FCFA</strong></div>
      </div>
      <div style="margin-top:10px;border:1px solid #ccc;padding:8px 12px">
        <div style="font-size:10px;text-transform:uppercase;font-weight:700;margin-bottom:6px">Versement</div>
        <div style="display:flex;justify-content:space-between"><span>Versement depot :</span><span style="min-width:100px;border-bottom:1px solid #999">&nbsp;</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px"><span>Signature :</span><span style="min-width:100px;border-bottom:1px solid #999">&nbsp;</span></div>
      </div>
    </div>
  </div>

  <div class="footer">${escapeHtml(site?.nom || "TDB Bar")} &mdash; Fiche de cloture generee automatiquement &mdash; ${escapeHtml(formatDateDdMmYyyy(reportDateStr))}</div>
  <script>window.onload = () => window.print();<\/script>
  </body></html>`;

  const w = window.open("", "_blank");
  if (!w) { showToast("Impossible d'ouvrir la fenetre d'impression."); return; }
  w.document.write(html);
  w.document.close();
}

function printSalesHistory() {
  const ventes = salesForHistory().slice().sort((a, b) => saleDateValue(a).localeCompare(saleDateValue(b)));
  if (!ventes.length) {
    showToast("Aucune vente a imprimer pour cette periode.");
    return;
  }
  const site = currentSite();
  const { start, end } = salesPeriod();
  const periodLabel = start || end
    ? `Periode : ${start ? formatDateDdMmYyyy(start) : "..."} au ${end ? formatDateDdMmYyyy(end) : "..."}`
    : "Periode : toutes les dates";
  const total = ventes.reduce((sum, vente) => sum + calcNet(vente), 0);
  const remises = ventes.reduce((sum, vente) => sum + (Number(vente.remise) || 0), 0);
  const payRows = Object.entries(paymentTotals(ventes))
    .map(([method, amount]) => `<tr><td>${escapeHtml(method)}</td><td>${fmt(amount)} FCFA</td></tr>`)
    .join("");
  const rows = ventes.map((vente) => `
    <tr>
      <td>${escapeHtml(formatDateDdMmYyyy(saleDateValue(vente)))}</td>
      <td>${escapeHtml(vente.factureNumber || `VENTE-${vente.id}`)}</td>
      <td>${escapeHtml(vente.client || "Client comptoir")}</td>
      <td>${escapeHtml(vente.article)}</td>
      <td>${escapeHtml(vente.cat)}</td>
      <td>${fmt(vente.qty)}</td>
      <td>${fmt(vente.prix)} FCFA</td>
      <td>${fmt(vente.remise || 0)} FCFA</td>
      <td>${escapeHtml(paymentLabel(vente))}</td>
      <td>${fmt(calcNet(vente))} FCFA</td>
    </tr>
  `).join("");
  const ticketWindow = window.open("", "_blank", "width=1100,height=900");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir l'impression.");
    return;
  }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Historique des ventes</title><style>body{font-family:Arial,sans-serif;color:#111;padding:28px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}.meta{color:#555}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.box{border:1px solid #111;padding:12px}.box strong{display:block;font-size:18px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left}th{background:#f2f2f2}td:nth-child(6),td:nth-child(7),td:nth-child(8),td:nth-child(10),.pay td:last-child{text-align:right}.pay{max-width:420px;margin-top:10px}@media print{body{padding:0}table{font-size:11px}}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p><p class="meta">${escapeHtml(periodLabel)}${currentFilter !== "all" ? ` - Categorie : ${escapeHtml(currentFilter)}` : ""}</p></div><div><h2>Historique des ventes</h2><p class="meta">Imprime le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div></header><div class="summary"><div class="box">Total ventes<strong>${fmt(total)} FCFA</strong></div><div class="box">Transactions<strong>${fmt(ventes.length)}</strong></div><div class="box">Remises<strong>${fmt(remises)} FCFA</strong></div></div><h2>Encaissements</h2><table class="pay"><tbody>${payRows}</tbody></table><h2>Detail</h2><table><thead><tr><th>Date</th><th>Facture</th><th>Client</th><th>Article</th><th>Categorie</th><th>Qte</th><th>Prix</th><th>Remise</th><th>Paiement</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function printStockReport() {
  const items = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  if (!items.length) {
    showToast("Aucun stock a imprimer.");
    return;
  }
  const site = currentSite();
  let totalValue = 0;
  let alertCount = 0;
  const rows = items.map((item) => {
    const actuel = stockActuel(item);
    const valeur = casesFromBottles(actuel, item) * (Number(item.prixAchat) || 0);
    totalValue += valeur;
    const alert = actuel <= Number(item.seuilMin);
    if (alert) alertCount += 1;
    const { prixInt, prixExt } = resolveItemPrices(item);
    return `<tr>
      <td>${escapeHtml(item.article)}</td>
      <td>${escapeHtml(item.cat)}</td>
      <td>${fmt(Math.max(1, Number(item.packSize) || 1))}</td>
      <td>${fmt(caseSize(item))}</td>
      <td>${fmt(stockFrigo(item))}</td>
      <td>${fmt(stockReserve(item))}</td>
      <td>${fmt(casesFromBottles(item.init, item))}</td>
      <td>${fmt(casesFromBottles(item.entrees, item))}</td>
      <td>${fmt(item.sorties || 0)}</td>
      <td>${fmt(actuel)}</td>
      <td>${fmt(item.seuilMin)}</td>
      <td>${fmt(item.prixAchat || 0)} FCFA</td>
      <td>${fmt(prixInt)} FCFA</td>
      <td>${fmt(prixExt)} FCFA</td>
      <td>${fmt(valeur)} FCFA</td>
      <td>${alert ? "Alerte" : "OK"}</td>
    </tr>`;
  }).join("");
  const ticketWindow = window.open("", "_blank", "width=1100,height=900");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir l'impression.");
    return;
  }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Point du stock</title><style>body{font-family:Arial,sans-serif;color:#111;padding:28px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}.meta{color:#555}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.box{border:1px solid #111;padding:12px}.box strong{display:block;font-size:18px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left}th{background:#f2f2f2}td:nth-child(n+3){text-align:right}td:last-child{text-align:left}@media print{body{padding:0}table{font-size:10px}}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p></div><div><h2>Point du stock</h2><p class="meta">Imprime le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div></header><div class="summary"><div class="box">Articles<strong>${fmt(items.length)}</strong></div><div class="box">Valeur stock<strong>${fmt(totalValue)} FCFA</strong></div><div class="box">Articles en alerte<strong>${fmt(alertCount)}</strong></div></div><table><thead><tr><th>Article</th><th>Categorie</th><th>Btl/kit</th><th>Btl/casier</th><th>Frigo</th><th>Reserve</th><th>Initial cas.</th><th>Entrees cas.</th><th>Sorties btl</th><th>Stock btl</th><th>Seuil</th><th>Achat/cas.</th><th>Vente int.</th><th>Vente ext.</th><th>Valeur</th><th>Statut</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function openModal(id) {
  document.getElementById(id).classList.add("open");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
  if (id === "modal-purchase-receive") pendingReceivePurchaseId = null;
  if (id === "modal-finalize") resetFinalizeModalUi();
}

async function removeOrderLine(orderId, lineId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order) return;
  const line = order.lignes.find((item) => item.id === lineId);
  recordStaffAudit("delete", "commande_ligne", `Ligne retiree · commande #${orderId} · ${order.client || ""}`, line ? `${line.article} · ${fmt(calcNet(line))} FCFA` : "");
  order.lignes = order.lignes.filter((item) => item.id !== lineId);
  if (!order.lignes.length) {
    state.commandes = state.commandes.filter((item) => item.id !== orderId);
    if (activeOrderId === orderId) activeOrderId = null;
  }
  await persistState();
  renderVentesPage();
  showToast("Ligne retiree de la commande.");
}

async function removeOrder(orderId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order || !canDeleteOrder(order)) {
    showToast("Vous n'avez pas l'autorisation de supprimer cette commande.");
    return;
  }
  recordStaffAudit("delete", "commande", `Commande annulee #${orderId} · ${order.client || ""}`, formatCommandeAuditDetail(order));
  state.commandes = state.commandes.filter((item) => item.id !== orderId);
  if (activeOrderId === orderId) activeOrderId = null;
  await persistState();
  renderVentesPage();
  showToast("Commande annulee.");
}

async function deleteFinalSale(id) {
  if (!canDeletePaidSale()) {
    showToast("Une commande deja payee ne peut pas etre supprimee par un serveur ou un gerant.");
    return;
  }
  const vente = state.ventes.find((item) => item.id === id);
  recordStaffAudit("delete", "vente", `Vente supprimee ${vente?.factureNumber ? vente.factureNumber : "#" + id}`, vente ? `${vente.article} · ${fmt(calcNet(vente))} FCFA · ${vente.paiement || ""}` : "");
  state.ventes = state.ventes.filter((item) => item.id !== id);
  await persistState();
  renderDashboard();
  renderSalesHistory();
  showToast("Vente supprimee.");
}

async function deleteStockItem(id) {
  if (!canAnyAdmin()) {
    showToast("Suppression du catalogue reservee a un administrateur.");
    return;
  }
  state.stock = state.stock.filter((item) => item.id !== id);
  await persistState();
  renderDashboard();
  renderStock();
  showToast("Article supprime.");
}

async function deleteCharge(id) {
  const ch = (state.charges || []).find((item) => item.id === id);
  recordStaffAudit("delete", "charge", ch ? `${ch.lib} · ${fmt(ch.montant)} FCFA` : `Depense #${id}`, ch ? `${ch.cat} · ${formatDateDdMmYyyy(ch.date)} · ${ch.paiement}` : "");
  state.charges = state.charges.filter((item) => item.id !== id);
  await persistState();
  renderDashboard();
  renderCharges();
  showToast("Depense supprimee.");
}

function updateReapproPrixInfo() {
  const cases = Number(document.getElementById("reappro-qty").value) || 0;
  const prix = Number(document.getElementById("reappro-prix").value) || 0;
  const csVal = Number(document.getElementById("reappro-case-size-select")?.value) || 24;
  const caseInfo = document.getElementById("reappro-case-info");
  if (caseInfo && document.getElementById("reappro-mode")?.value === "achat") {
    caseInfo.textContent = `1 casier = ${fmt(csVal)} bouteilles.`;
  }
  const info = document.getElementById("reappro-montant-info");
  if (info) info.textContent = (cases > 0 && prix > 0) ? `Total : ${fmt(cases * prix)} FCFA (${fmt(cases * csVal)} btl)` : "";
}

function openReapproModal(itemId, mode = "achat") {
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  document.getElementById("reappro-item-id").value = String(itemId);
  document.getElementById("reappro-mode").value = mode;
  document.getElementById("reappro-article-name").textContent = item.article;
  document.getElementById("reappro-stock-actuel").textContent = `Frigo: ${fmt(stockFrigo(item))} btl · Reserve: ${fmt(stockReserve(item))} btl · Total: ${fmt(stockActuel(item))} btl`;
  document.getElementById("reappro-qty").value = "";
  document.getElementById("reappro-qty-label").textContent = mode === "frigo" ? "Bouteilles a mettre au frigo" : "Casiers a ajouter";
  document.getElementById("reappro-qty").placeholder = mode === "frigo" ? "ex: 12" : "ex: 2";
  document.getElementById("reappro-case-info").textContent = mode === "frigo"
    ? `Disponible en reserve: ${fmt(stockReserve(item))} bouteilles.`
    : `1 casier = ${fmt(caseSize(item))} bouteilles.`;
  document.getElementById("save-reappro-btn").textContent = mode === "frigo" ? "Mettre au frigo" : "Valider l'achat";
  const achatFields = document.getElementById("reappro-achat-fields");
  if (achatFields) achatFields.classList.toggle("hidden", mode === "frigo");
  if (mode === "achat") {
    const csSelect = document.getElementById("reappro-case-size-select");
    if (csSelect) csSelect.value = String(caseSize(item));
    document.getElementById("reappro-prix").value = String(Number(item.prixAchat) || "");
    document.getElementById("reappro-montant-info").textContent = "";
  }
  openModal("modal-reappro");
}

async function autoFillFridge(itemId) {
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  normalizePhysicalStock(item);
  const target = Math.max(caseSize(item), Number(item.seuilMin) || 0);
  const missing = Math.max(0, target - stockFrigo(item));
  const bottles = Math.min(missing, stockReserve(item));
  if (bottles <= 0) {
    showToast(stockReserve(item) <= 0 ? "Reserve insuffisante." : "Frigo deja suffisamment approvisionne.");
    return;
  }
  item.reserve = stockReserve(item) - bottles;
  item.frigo = stockFrigo(item) + bottles;
  item.lastReapproAt = new Date().toISOString();
  item.lastReapproBy = sessionUser || "-";
  recordStaffAudit("update", "frigo", `Reserve vers frigo · ${item.article}`, `${fmt(bottles)} btl`);
  await persistState();
  renderVentesPage();
  renderStock();
  renderDashboard();
  showToast(`Frigo reapprovisionne : ${fmt(bottles)} bouteille(s) transferee(s) depuis la reserve.`);
}

async function saveReappro() {
  const itemId = Number(document.getElementById("reappro-item-id").value);
  const qty = Number(document.getElementById("reappro-qty").value);
  const mode = document.getElementById("reappro-mode").value || "achat";
  if (!qty || qty <= 0) {
    showToast("Entrez une quantite valide.");
    return;
  }
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  if (mode === "frigo") {
    const bottles = Math.min(Math.round(qty), stockReserve(item));
    if (bottles <= 0) {
      showToast("Reserve insuffisante.");
      return;
    }
    item.reserve = stockReserve(item) - bottles;
    item.frigo = stockFrigo(item) + bottles;
    item.lastReapproAt = new Date().toISOString();
    item.lastReapproBy = sessionUser || "-";
    recordStaffAudit("update", "reappro", `Reserve vers frigo · ${item.article}`, `${fmt(bottles)} btl`);
    await persistState();
    closeModal("modal-reappro");
    renderVentesPage();
    renderStock();
    showToast(`${fmt(bottles)} bouteille(s) mises au frigo.`);
    return;
  }
  const cases = qty;
  const selectedCaseSize = Number(document.getElementById("reappro-case-size-select")?.value) || caseSize(item);
  const bottles = cases * selectedCaseSize;
  item.entrees = (Number(item.entrees) || 0) + bottles;
  item.reserve = stockReserve(item) + bottles;
  item.lastReapproAt = new Date().toISOString();
  item.lastReapproBy = sessionUser || "-";
  state.stockEntrees = state.stockEntrees || [];
  if (!state.nextId) state.nextId = {};
  if (state.nextId.stockEntree == null || Number.isNaN(Number(state.nextId.stockEntree))) {
    const maxE = state.stockEntrees.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    state.nextId.stockEntree = Math.max(100, maxE + 1);
  }
  state.stockEntrees.unshift({
    id: state.nextId.stockEntree++,
    siteId: currentSiteId(),
    date: today(),
    article: item.article,
    cases,
    caseSize: selectedCaseSize,
    qty: bottles,
    user: sessionUser || "-",
  });
  const prixCasier = Number(document.getElementById("reappro-prix")?.value) || 0;
  const modePaiement = document.getElementById("reappro-paiement")?.value || "Especes";
  if (prixCasier > 0) {
    state.charges = state.charges || [];
    state.charges.unshift({
      id: state.nextId.charge++,
      siteId: currentSiteId(),
      date: today(),
      lib: `Achat ${item.article} (${fmt(cases)} casier(s) x ${fmt(selectedCaseSize)} btl = ${fmt(bottles)} btl)`,
      cat: "Approvisionnement",
      montant: cases * prixCasier,
      paiement: modePaiement,
    });
  }
  recordStaffAudit("update", "reappro", `Achat rapide · ${item.article}`, `${fmt(cases)} cas. x ${fmt(selectedCaseSize)} btl · ${fmt(bottles)} btl${prixCasier > 0 ? ` · ${fmt(cases * prixCasier)} FCFA` : ""}`);
  await persistState({ stock: state.stock, charges: state.charges, nextId: state.nextId, stockEntrees: state.stockEntrees });
  closeModal("modal-reappro");
  renderStock();
  renderDashboard();
  renderCharges();
  const chargeMsg = prixCasier > 0 ? ` · Depense de ${fmt(cases * prixCasier)} FCFA enregistree.` : "";
  showToast(`+${fmt(cases)} casier(s) (${fmt(bottles)} btl) pour "${item.article}".${chargeMsg}`);
}

function openPerteModal(itemId = null) {
  const items = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const sel = document.getElementById("perte-article");
  sel.innerHTML = items.map((i) => `<option value="${i.id}">${escapeHtml(i.article)} (${fmt(stockActuel(i))} btl)</option>`).join("");
  if (itemId) sel.value = String(itemId);
  const selected = state.stock.find((i) => i.id === Number(sel.value));
  const info = document.getElementById("perte-stock-actuel");
  if (info && selected) info.textContent = `Frigo: ${fmt(stockFrigo(selected))} · Reserve: ${fmt(stockReserve(selected))} · Total: ${fmt(stockActuel(selected))} btl`;
  document.getElementById("perte-qty").value = "";
  document.getElementById("perte-notes").value = "";
  openModal("modal-perte");
}

async function savePerte() {
  const itemId = Number(document.getElementById("perte-article").value);
  const qty = Math.floor(Number(document.getElementById("perte-qty").value) || 0);
  const motif = document.getElementById("perte-motif").value;
  const notes = document.getElementById("perte-notes").value.trim();
  if (qty <= 0) { showToast("Entrez une quantite valide."); return; }
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  if (qty > stockActuel(item)) {
    showToast(`Stock insuffisant (${fmt(stockActuel(item))} btl disponibles).`);
    return;
  }
  item.sorties = (Number(item.sorties) || 0) + qty;
  item.lastSortieAt = new Date().toISOString();
  item.lastSortieBy = sessionUser || "-";
  state.stockLosses = state.stockLosses || [];
  if (!state.nextId) state.nextId = {};
  if (state.nextId.stockLoss == null || Number.isNaN(Number(state.nextId.stockLoss))) {
    const maxL = state.stockLosses.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
    state.nextId.stockLoss = Math.max(100, maxL + 1);
  }
  state.stockLosses.push({
    id: state.nextId.stockLoss++,
    siteId: currentSiteId(),
    article: item.article,
    qty,
    motif,
    notes,
    date: today(),
    createdAt: new Date().toISOString(),
    createdBy: sessionUser || "-",
  });
  recordStaffAudit("create", "perte", `Perte · ${item.article}`, `${fmt(qty)} btl · ${motif}${notes ? ` · ${notes}` : ""}`);
  await persistState({ stock: state.stock, stockLosses: state.stockLosses });
  closeModal("modal-perte");
  renderStock();
  renderDashboard();
  showToast(`Perte de ${fmt(qty)} btl "${item.article}" enregistree (${motif}).`);
}

async function setupTwoFactor(username) {
  try {
    const result = await apiRequest(API.twoFaSetup, { method: "POST", body: JSON.stringify({ username }) });
    document.getElementById("totp-setup-username").value = username;
    document.getElementById("modal-2fa-label").textContent = `Configurer 2FA pour "${username}"`;
    document.getElementById("totp-qr-img").src = `https://quickchart.io/qr?size=220&text=${encodeURIComponent(result.otpauthUrl)}`;
    document.getElementById("totp-secret-display").textContent = result.secret;
    document.getElementById("totp-confirm-code").value = "";
    openModal("modal-2fa");
  } catch (error) {
    showToast(error.message || "Erreur lors de la configuration 2FA.");
  }
}

async function enable2FA() {
  const username = document.getElementById("totp-setup-username").value;
  const code = document.getElementById("totp-confirm-code").value.trim();
  if (!code) {
    showToast("Entrez le code affiche dans votre application.");
    return;
  }
  try {
    await apiRequest(API.twoFaEnable, { method: "POST", body: JSON.stringify({ username, code }) });
    state = await apiRequest(API.state);
    closeModal("modal-2fa");
    renderUsersList();
    showToast(`2FA active pour "${username}".`);
  } catch (error) {
    showToast(error.message || "Code invalide ou expire.");
  }
}

async function disableTwoFactor(username) {
  try {
    await apiRequest(API.twoFaDisable, { method: "POST", body: JSON.stringify({ username }) });
    state = await apiRequest(API.state);
    renderUsersList();
    showToast(`2FA desactive pour "${username}".`);
  } catch (error) {
    showToast(error.message || "Erreur lors de la desactivation 2FA.");
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const totpSection = document.getElementById("totp-section");
  const errorEl = document.getElementById("login-error");
  try {
    if (pendingPreAuthToken) {
      const code = document.getElementById("login-totp").value.trim();
      const session = await apiRequest(API.twoFaVerify, {
        method: "POST",
        body: JSON.stringify({ preAuthToken: pendingPreAuthToken, code }),
      });
      pendingPreAuthToken = null;
      totpSection.classList.add("hidden");
      document.getElementById("login-totp").value = "";
      document.querySelector("#login-form button[type=submit]").textContent = "Ouvrir le tableau de bord";
      sessionUser = session.username;
      currentRole = normalizeRoleForUsername(session.username, session.role);
      allowedSiteIds = session.allowedSiteIds || [];
      errorEl.textContent = "";
      setAuthVisible(true);
      await bootstrapAuthenticatedApp();
      showToast("Connexion reussie.");
    } else {
      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;
      const result = await apiRequest(API.login, { method: "POST", body: JSON.stringify({ username, password }) });
      if (result.needsTwoFactor) {
        pendingPreAuthToken = result.preAuthToken;
        totpSection.classList.remove("hidden");
        document.getElementById("login-totp").focus();
        document.querySelector("#login-form button[type=submit]").textContent = "Verifier le code";
        errorEl.textContent = "";
      } else {
        sessionUser = result.username;
        currentRole = normalizeRoleForUsername(result.username, result.role);
        allowedSiteIds = result.allowedSiteIds || [];
        errorEl.textContent = "";
        setAuthVisible(true);
        await bootstrapAuthenticatedApp();
        showToast("Connexion reussie.");
      }
    }
  } catch (error) {
    errorEl.textContent = error.message;
  }
}

async function logout() {
  try {
    await apiRequest(API.logout, { method: "POST", body: JSON.stringify({}) });
  } catch (error) {
    console.error(error);
  }
  stopLiveSync();
  state = null;
  sessionUser = null;
  currentRole = null;
  allowedSiteIds = [];
  activeOrderId = null;
  editingLineId = null;
  pendingFinalizeOrderId = null;
  pendingPreAuthToken = null;
  qrAlertCount = 0;
  knownQrOrderIds = new Set();
  document.getElementById("totp-section").classList.add("hidden");
  document.getElementById("login-totp").value = "";
  document.querySelector("#login-form button[type=submit]").textContent = "Ouvrir le tableau de bord";
  setAuthVisible(false);
  showToast("Session fermee.");
}

async function bootstrapAuthenticatedApp() {
  state = await apiRequest(API.state);
  if (!Array.isArray(state.creditRecoveries)) state.creditRecoveries = [];
  if (!Array.isArray(state.purchaseOrders)) state.purchaseOrders = [];
  if (!Array.isArray(state.dayBooks)) state.dayBooks = [];
  if (!Array.isArray(state.stockEntrees)) state.stockEntrees = [];
  if (!Array.isArray(state.stockLosses)) state.stockLosses = [];
  if (!Array.isArray(state.staffAuditLog)) state.staffAuditLog = [];
  if (!state.nextId.stockEntree || Number.isNaN(Number(state.nextId.stockEntree))) state.nextId.stockEntree = 100;
  if (!state.nextId.stockLoss || Number.isNaN(Number(state.nextId.stockLoss))) state.nextId.stockLoss = 100;
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.creditRecovery) state.nextId.creditRecovery = 100;
  if (state.nextId.auditEntry === undefined || state.nextId.auditEntry === null) state.nextId.auditEntry = 0;
  knownQrOrderIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
  qrAlertCount = 0;
  renderSiteSwitcher();
  populateCategorySelects();
  populateSelect("c-cat", CHARGE_CATEGORIES);
  populateSelect("c-pay", CHARGE_PAYMENT_METHODS);
  document.getElementById("v-date").value = today();
  document.getElementById("c-date").value = today();
  const creditDt = document.getElementById("credit-datetime");
  if (creditDt) creditDt.value = datetimeLocalNow();
  document.getElementById("orders-filter-date").value = today();
  document.getElementById("stock-move-start").value = today().slice(0, 8) + "01";
  document.getElementById("stock-move-end").value = today();
  populateOrderSelect();
  renderTopbar();
  renderDashboard();
  renderVentesPage();
  renderStock();
  renderCharges();
  loadParamsForm();
  resetOrderForm();
  applyRoleVisibility();
  navigate(currentPage);
  renderQrAlertBadge();
  startLiveSync();
}

function handleApiError(error) {
  console.error(error);
  if (error?.status === 401) {
    logout();
    return;
  }
  let msg = error?.message || "Une erreur est survenue.";
  const net =
    !navigator.onLine
    || (typeof error?.message === "string" && error.message.includes("Failed to fetch"))
    || error?.name === "TypeError";
  if (net) {
    msg = "Serveur injoignable : vos dernieres modifications peuvent ne pas etre enregistrees. Verifiez la connexion ou l URL du site, puis reessayez.";
  }
  showToast(msg);
}


function updateVentePreview() {
  const prix = Number(document.getElementById("v-prix").value) || 0;
  const qty = Number(document.getElementById("v-qty").value) || 0;
  const remise = Number(document.getElementById("v-remise").value) || 0;
  document.getElementById("v-preview").textContent = `${fmt((prix * qty) - remise)} FCFA`;
}

function updatePaymentMixPreview() {
  const order = state?.commandes?.find((item) => item.id === (pendingFinalizeOrderId || activeOrderId));
  const total = order?.lignes?.reduce((sum, line) => sum + calcNet(line), 0) || 0;
  const paid = [...document.querySelectorAll(".finalize-pay-input")]
    .reduce((sum, input) => sum + (Number(input.value) || 0), 0);
  const reste = total - paid;
  const target = document.getElementById("pay-mix-preview");
  if (!target) return;
  target.textContent = `${fmt(paid)} FCFA`;
  const resteEl = document.getElementById("pay-reste-preview");
  if (resteEl) {
    if (reste > 0) {
      resteEl.textContent = `Reste ${fmt(reste)} FCFA`;
      resteEl.style.color = "#ff8e82";
    } else if (reste < 0) {
      resteEl.textContent = `Surplus ${fmt(-reste)} FCFA`;
      resteEl.style.color = "#ff8e82";
    } else {
      resteEl.textContent = "OK ✓";
      resteEl.style.color = "#72d7a9";
    }
  }
}

function takeOverOrder(orderId) {
  activeOrderId = orderId;
  clearQrAlert();
  renderOrders();
  showToast("Commande selectionnee. Cliquez sur 'Ajouter un article' pour modifier.");
}

function attachEvents() {
  installFcfaThousandsDelegation();
  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
  document.getElementById("logout-btn").addEventListener("click", () => logout());
  document.getElementById("site-switcher").addEventListener("change", () => {
    const siteId = document.getElementById("site-switcher").value;
    if (!canAccessSite(siteId)) return;
    state.activeSiteId = siteId;
    activeOrderId = null;
    knownQrOrderIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
    clearQrAlert();
    renderTopbar();
    renderDashboard();
    renderVentesPage();
    renderStock();
    renderCharges();
    loadParamsForm();
    resetOrderForm();
    persistState().catch(handleApiError);
  });
  document.getElementById("new-order-btn").addEventListener("click", () => {
    activeOrderId = null;
    resetOrderForm();
    openOrderEditor();
  });
  document.getElementById("new-order-top-btn").addEventListener("click", () => {
    activeOrderId = null;
    resetOrderForm();
    openOrderEditor();
  });
  document.getElementById("orders-filter-btn").addEventListener("click", renderOrdersManagement);
  ["orders-filter-date", "orders-filter-status", "orders-filter-type"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderOrdersManagement);
  });
  document.getElementById("generate-qr-btn").addEventListener("click", renderQrPreview);
  document.getElementById("print-all-qr-btn").addEventListener("click", () => printAllQrTables());
  document.getElementById("print-qr-int-btn").addEventListener("click", () => printQrCard("Intérieur"));
  document.getElementById("print-qr-ext-btn").addEventListener("click", () => printQrCard("Extérieur"));
document.getElementById("fab-btn").addEventListener("click", () => {
    if (currentPage === "ventes") openOrderEditor(activeOrderId || null, null);
    if (currentPage === "stock") {
      if (stockSubTab === "creanciers") {
        openCreditorChargeModal();
        return;
      }
      if (stockSubTab === "achats") {
        const form = document.getElementById("purchase-form");
        if (form?.classList.contains("hidden")) openPurchaseForm();
        else form?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        return;
      }
      resetStockForm();
      openModal("modal-stock");
    }
    if (currentPage === "charges") {
      document.getElementById("c-date").value = today();
      openModal("modal-charge");
    }
  });
  document.getElementById("save-vente-btn").addEventListener("click", () => saveOrderLine().catch(handleApiError));
  document.getElementById("finalize-order-btn").addEventListener("click", () => openFinalizeDialog());
  document.getElementById("confirm-finalize-btn").addEventListener("click", () => finalizeOrder(pendingFinalizeOrderId || activeOrderId).catch(handleApiError));
  document.getElementById("print-finalize-btn")?.addEventListener("click", () => {
    const n = document.getElementById("print-finalize-btn")?.dataset.facture;
    if (n) printInvoice(n);
  });
  document.getElementById("finalize-done-close")?.addEventListener("click", () => closeModal("modal-finalize"));
  document.getElementById("save-stock-btn").addEventListener("click", () => saveStock().catch(handleApiError));
  document.getElementById("add-sale-format-btn").addEventListener("click", addStockSaleFormat);
  document.getElementById("s-price-location").addEventListener("change", () => {
    updateStockPriceInput();
  });
  document.getElementById("s-price-location-value").addEventListener("input", commitStockPriceInput);
  document.getElementById("save-charge-btn").addEventListener("click", () => saveCharge().catch(handleApiError));
  document.getElementById("save-params-btn").addEventListener("click", () => saveParams().catch(handleApiError));
  document.getElementById("print-sales-history-btn").addEventListener("click", printSalesHistory);
  document.getElementById("print-stock-report-btn").addEventListener("click", printStockReport);
  document.getElementById("export-stock-excel-btn").addEventListener("click", exportStockExcel);
  document.getElementById("import-stock-excel-btn").addEventListener("click", () => document.getElementById("import-stock-file").click());
  document.getElementById("import-stock-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) { importStockExcel(file).catch(handleApiError); e.target.value = ""; }
  });
  document.getElementById("print-closure-btn").addEventListener("click", printDayClosure);
  document.getElementById("pdj-work-date")?.addEventListener("change", () => {
    if (currentPage === "pdj") renderPointDuJour();
  });
  document.getElementById("pdj-apply-work-date")?.addEventListener("click", () => {
    syncPdjWorkDateInput();
    if (currentPage === "pdj") renderPointDuJour();
  });
  document.getElementById("close-day-btn").addEventListener("click", () => {
    const dWork = pdjCalendarDate();
    const items = recordsForSite(state.stock);
    const hasInputs = items.length && !!document.querySelector(`[data-check-frigo="${items[0].id}"]`);
    if (!hasInputs && stockCheckForSiteDate(dWork, currentSiteId())) {
      // Journee deja cloturee mais en mode lecture : repasser en mode saisie
      const closed = stockCheckForSiteDate(dWork, currentSiteId());
      // Retirer temporairement la cloture pour forcer le mode edition
      state.stockChecks = (state.stockChecks || []).filter((sc) => !(sc.siteId === currentSiteId() && sc.date === dWork));
      renderDailyStockCheck();
      // Re-remettre la cloture en memoire (sans persistState) pour que le reverse fonctionne
      state.stockChecks = [...(state.stockChecks || []), closed];
      showToast("Verifiez les valeurs puis cliquez a nouveau pour confirmer.");
      return;
    }
    closeAccountingDay().catch(handleApiError);
  });
  document.getElementById("add-user-btn").addEventListener("click", () => addUser().catch(handleApiError));
  document.getElementById("add-site-btn").addEventListener("click", () => addSite().catch(handleApiError));
  document.getElementById("cancel-edit-user-btn").addEventListener("click", resetUserForm);
  document.getElementById("new-user-role").addEventListener("change", renderUserSiteCheckboxes);
  document.getElementById("save-reappro-btn").addEventListener("click", () => saveReappro().catch(handleApiError));
  document.getElementById("toggle-stock-detail-btn").addEventListener("click", () => {
    stockTableCompact = !stockTableCompact;
    renderStock();
  });
  document.getElementById("nouvelle-perte-btn").addEventListener("click", () => openPerteModal());
  document.getElementById("save-perte-btn").addEventListener("click", () => savePerte().catch(handleApiError));
  document.getElementById("perte-article").addEventListener("change", () => {
    const item = state.stock.find((i) => i.id === Number(document.getElementById("perte-article").value));
    const info = document.getElementById("perte-stock-actuel");
    if (info && item) info.textContent = `Frigo: ${fmt(stockFrigo(item))} · Reserve: ${fmt(stockReserve(item))} · Total: ${fmt(stockActuel(item))} btl`;
  });
  ["reappro-qty", "reappro-prix"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateReapproPrixInfo);
  });
  document.getElementById("reappro-case-size-select").addEventListener("change", updateReapproPrixInfo);
  document.getElementById("enable-2fa-btn").addEventListener("click", () => enable2FA().catch(handleApiError));
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("reset-btn").addEventListener("click", async () => {
    if (!canSuperAdmin()) {
      showToast("Seul le super administrateur peut reinitialiser l'application.");
      return;
    }
    if (!window.confirm("Reinitialiser toutes les donnees de l'application ?")) return;
    try {
      state = await apiRequest(API.reset, { method: "POST", body: JSON.stringify({}) });
      activeOrderId = null;
      editingLineId = null;
      await bootstrapAuthenticatedApp();
      showToast("Application reinitialisee.");
    } catch (error) {
      handleApiError(error);
    }
  });
  const saveCategoriesBtn = document.getElementById("save-categories-btn");
  if (saveCategoriesBtn) saveCategoriesBtn.addEventListener("click", () => saveParams().catch(handleApiError));

  const categoriesTextarea = document.getElementById("p-categories");
  if (categoriesTextarea) {
    categoriesTextarea.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        saveParams().catch(handleApiError);
      }
    });
  }
  const restoreBtn = document.getElementById("restore-json-btn");
  if (restoreBtn) restoreBtn.addEventListener("click", () => restoreFromJson());
  document.querySelectorAll(".nav-btn").forEach((button) => button.addEventListener("click", () => handleNavButtonClick(button)));
  bindMobileMoreSheet();
  document.getElementById("page-pdj")?.addEventListener("click", (event) => {
    if (event.target.closest("#pdj-opening-submit")) recordCashOpening().catch(handleApiError);
  });
  document.getElementById("pdj-stock-check")?.addEventListener("input", (event) => {
    const input = event.target.closest("[data-check-frigo],[data-check-reserve]");
    if (!input) return;
    const itemId = input.dataset.checkFrigo || input.dataset.checkReserve;
    const frigoEl = document.querySelector(`[data-check-frigo="${itemId}"]`);
    const reserveEl = document.querySelector(`[data-check-reserve="${itemId}"]`);
    if (!frigoEl || !reserveEl) return;
    const frigo = Math.max(0, Number(frigoEl.value) || 0);
    const reserve = Math.max(0, Number(reserveEl.value) || 0);
    const row = input.closest("tr");
    if (!row) return;
    const theorique = Number(row.cells[3]?.textContent?.replace(/\s/g, "").replace(",", ".")) || 0;
    const ecart = (frigo + reserve) - theorique;
    const ecartCell = row.cells[row.cells.length - 1];
    if (ecartCell) {
      ecartCell.textContent = ecart === 0 ? "OK" : (ecart > 0 ? `+${ecart}` : String(ecart));
      ecartCell.style.color = ecart === 0 ? "#72d7a9" : "#ff8e82";
    }
  });
  document.getElementById("page-ventes").addEventListener("click", (event) => {
    const innerBtn = event.target.closest("[data-caisse-inner]");
    if (innerBtn) {
      setCaisseInnerTab(innerBtn.dataset.caisseInner);
      return;
    }
    const btn = event.target.closest("[data-subtab-ventes]");
    if (btn) {
      setVentesSubTab(btn.dataset.subtabVentes);
      renderVentesPage();
    }
  });
  document.getElementById("page-stock").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-subtab-stock]");
    if (btn) setStockSubTab(btn.dataset.subtabStock);
    const removeFormatBtn = event.target.closest("[data-remove-sale-format]");
    if (removeFormatBtn) {
      const index = Number(removeFormatBtn.dataset.removeSaleFormat);
      const formats = readStockSaleFormats();
      formats.splice(index, 1);
      renderStockSaleFormats(formats);
    }
  });
  document.getElementById("page-params")?.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-subtab-params]");
    if (btn && !btn.classList.contains("hidden-by-role")) setParamsSubTab(btn.dataset.subtabParams);
  });
  document.getElementById("goto-client-debtors-btn")?.addEventListener("click", () => navigateToClientCredits());
  document.getElementById("purchase-new-btn")?.addEventListener("click", () => openPurchaseForm());
  document.getElementById("purchase-add-line-btn")?.addEventListener("click", () => addPurchaseLine());
  document.getElementById("purchase-save-btn")?.addEventListener("click", () => savePurchaseOrder().catch(handleApiError));
  document.getElementById("purchase-receive-confirm-btn")?.addEventListener("click", () => confirmReceivePurchaseOrder().catch(handleApiError));
  document.getElementById("modal-purchase-receive")?.addEventListener("input", (event) => {
    if (!event.target.classList?.contains("recv-cases-input")) return;
    const po = (state.purchaseOrders || []).find((p) => p.id === pendingReceivePurchaseId);
    if (po) updateReceivePurchaseModalTotals(po);
  });
  document.getElementById("purchase-article")?.addEventListener("input", () => syncPurchaseLineInputsFromStock());
  document.getElementById("purchase-article")?.addEventListener("change", () => syncPurchaseLineInputsFromStock());
  document.getElementById("stock-card-achats")?.addEventListener("click", (event) => {
    const rmPoLineBtn = event.target.closest("[data-purchase-remove-line]");
    if (rmPoLineBtn && rmPoLineBtn.dataset.lineIndex !== undefined && rmPoLineBtn.dataset.lineIndex !== "") {
      removePurchaseOrderLine(Number(rmPoLineBtn.dataset.purchaseRemoveLine), Number(rmPoLineBtn.dataset.lineIndex)).catch(handleApiError);
      return;
    }
    const remove = event.target.closest("[data-purchase-remove-line]");
    if (remove) {
      const idx = Number(remove.dataset.purchaseRemoveLine);
      purchaseDraftLines.splice(idx, 1);
      renderPurchaseDraft();
      return;
    }
    const selectAll = event.target.closest("#purchase-select-all");
    if (selectAll) {
      const checked = Boolean(selectAll.checked);
      purchaseDraftLines = purchaseDraftLines.map((l) => ({ ...l, selected: checked }));
      renderPurchaseDraft();
      return;
    }
    const selectLine = event.target.closest("[data-purchase-select]");
    if (selectLine) {
      const idx = Number(selectLine.dataset.purchaseSelect);
      if (!purchaseDraftLines[idx]) return;
      purchaseDraftLines[idx].selected = Boolean(selectLine.checked);
      renderPurchaseDraft();
      return;
    }
    const receive = event.target.closest("[data-purchase-receive]");
    if (receive) {
      receivePurchaseOrder(Number(receive.dataset.purchaseReceive));
      return;
    }
    const cancelPo = event.target.closest("[data-purchase-cancel]");
    if (cancelPo) {
      cancelPurchaseOrder(Number(cancelPo.dataset.purchaseCancel)).catch(handleApiError);
      return;
    }
  });

  document.getElementById("stock-card-achats")?.addEventListener("input", (event) => {
    const casesInput = event.target.closest("[data-purchase-cases]");
    if (!casesInput) return;
    const idx = Number(casesInput.dataset.purchaseCases);
    if (!purchaseDraftLines[idx]) return;
    purchaseDraftLines[idx].cases = Number(casesInput.value) || 0;
    purchaseDraftLines[idx].pricePerCase = purchasePricePerCaseFromStock(purchaseDraftLines[idx].article);
    recomputePurchaseLine(idx);
    renderPurchaseDraft();
  });
  document.getElementById("ventes-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    currentFilter = button.dataset.filter;
    renderSalesHistory();
  });
  ["sales-period-start", "sales-period-end"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderSalesHistory);
  });
  ["stock-move-start", "stock-move-end", "stock-move-type"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderStockMovements);
  });
  document.body.addEventListener("click", (event) => {
    const closeButton = event.target.closest(".close-modal");
    if (closeButton) {
      closeModal(closeButton.dataset.close);
      return;
    }
    const auditOpen = event.target.closest("[data-audit-open]");
    if (auditOpen) {
      const raw = auditOpen.getAttribute("data-audit-open");
      const id = Number(raw);
      if (raw != null && raw !== "" && !Number.isNaN(id)) openStaffAuditDetailModal(id);
      return;
    }
    const ventePick = event.target.closest("[data-vente-pick]");
    if (ventePick) {
      let name = "";
      try {
        name = decodeURIComponent(ventePick.getAttribute("data-vente-pick") || "");
      } catch (_) {
        name = "";
      }
      const art = document.getElementById("v-article");
      if (art) art.value = name;
      const vSearch = document.getElementById("v-article-search");
      if (vSearch) vSearch.value = "";
      renderVenteArticlePicker();
      syncKnownProduct();
      art?.focus();
      return;
    }
    const removeFormatBtn = event.target.closest("[data-remove-sale-format]");
    if (removeFormatBtn) {
      const index = Number(removeFormatBtn.dataset.removeSaleFormat);
      const formats = readStockSaleFormats();
      formats.splice(index, 1);
      renderStockSaleFormats(formats);
      return;
    }
    const activateOrder = event.target.closest("[data-activate-order]");
    if (activateOrder) {
      takeOverOrder(Number(activateOrder.dataset.activateOrder));
      return;
    }
    const addLine = event.target.closest("[data-add-line-order]");
    if (addLine) {
      openOrderEditor(Number(addLine.dataset.addLineOrder), null);
      return;
    }
    const editLine = event.target.closest("[data-edit-line]");
    if (editLine) {
      openOrderEditor(Number(editLine.dataset.orderId), Number(editLine.dataset.editLine));
      return;
    }
    const removeLine = event.target.closest("[data-remove-line]");
    if (removeLine && window.confirm("Retirer cette ligne de la commande ?")) {
      removeOrderLine(Number(removeLine.dataset.orderId), Number(removeLine.dataset.removeLine)).catch(handleApiError);
      return;
    }
    const finalize = event.target.closest("[data-finalize-order]");
    if (finalize) {
      openFinalizeDialog(Number(finalize.dataset.finalizeOrder));
      return;
    }
    const fillFridge = event.target.closest("[data-fill-fridge-article]");
    if (fillFridge) {
      const item = stockItemForArticle(fillFridge.dataset.fillFridgeArticle);
      if (item) openReapproModal(item.id, "frigo");
      return;
    }
    const printTicket = event.target.closest("[data-print-order]");
    if (printTicket) {
      printOrderTicket(Number(printTicket.dataset.printOrder));
      return;
    }
    const printInvoiceBtn = event.target.closest("[data-print-invoice]");
    if (printInvoiceBtn) {
      printInvoice(printInvoiceBtn.dataset.printInvoice);
      return;
    }
    const printQrTableBtn = event.target.closest("[data-print-qr-table]");
    if (printQrTableBtn) {
      printQrTable(printQrTableBtn.dataset.printQrTable);
      return;
    }
    const advanceOrderBtn = event.target.closest("[data-advance-order]");
    if (advanceOrderBtn) {
      advanceOrder(Number(advanceOrderBtn.dataset.advanceOrder)).catch(handleApiError);
      return;
    }
    const reopenCloseBtn = event.target.closest("[data-reopen-close]");
    if (reopenCloseBtn) {
      const dateStr = reopenCloseBtn.getAttribute("data-reopen-close") || "";
      const sid = currentSiteId();
      if (dateStr && sid) reopenAccountingDayConfirm(sid, dateStr).catch(handleApiError);
      return;
    }
    const deleteUserBtn = event.target.closest("[data-delete-user]");
    if (deleteUserBtn && window.confirm(`Supprimer l'utilisateur "${deleteUserBtn.dataset.deleteUser}" ?`)) {
      deleteUser(deleteUserBtn.dataset.deleteUser).catch(handleApiError);
      return;
    }
    const deleteSiteBtn = event.target.closest("[data-delete-site]");
    if (deleteSiteBtn && window.confirm(`Supprimer le maquis "${deleteSiteBtn.dataset.deleteSite}" ? Cette action est irreversible.`)) {
      deleteSite(deleteSiteBtn.dataset.deleteSite).catch(handleApiError);
      return;
    }
    const editUserBtn = event.target.closest("[data-edit-user]");
    if (editUserBtn) {
      editUser(editUserBtn.dataset.editUser);
      return;
    }
    const autoFillBtn = event.target.closest("[data-auto-fill-fridge]");
    if (autoFillBtn) {
      openReapproModal(Number(autoFillBtn.dataset.autoFillFridge), "frigo");
      return;
    }
    const reapproBtn = event.target.closest("[data-reappro-id]");
    if (reapproBtn) {
      openReapproModal(Number(reapproBtn.dataset.reapproId));
      return;
    }
    const perteBtn = event.target.closest("[data-perte-id]");
    if (perteBtn) {
      openPerteModal(Number(perteBtn.dataset.perteId));
      return;
    }
    const editStockBtn = event.target.closest("[data-edit-stock]");
    if (editStockBtn) {
      openEditStock(Number(editStockBtn.dataset.editStock));
      return;
    }
    const setup2faBtn = event.target.closest("[data-setup-2fa]");
    if (setup2faBtn) {
      setupTwoFactor(setup2faBtn.getAttribute("data-setup-2fa")).catch(handleApiError);
      return;
    }
    const disable2faBtn = event.target.closest("[data-disable-2fa]");
    if (disable2faBtn && window.confirm(`Desactiver le 2FA pour "${disable2faBtn.getAttribute("data-disable-2fa")}" ?`)) {
      disableTwoFactor(disable2faBtn.getAttribute("data-disable-2fa")).catch(handleApiError);
      return;
    }
    const deleteOrder = event.target.closest("[data-delete-order]");
    if (deleteOrder && window.confirm("Annuler toute la commande de ce client ?")) {
      removeOrder(Number(deleteOrder.dataset.deleteOrder)).catch(handleApiError);
      return;
    }
    const proposePurchase = event.target.closest("[data-propose-purchase]");
    if (proposePurchase) {
      proposePurchaseForStockItemId(Number(proposePurchase.dataset.proposePurchase));
      return;
    }
    if (event.target.closest("[data-stock-alert-propose-all]")) {
      proposePurchaseForStockItems(stockAlertItemsForDashboard());
      return;
    }
    if (event.target.closest("[data-stock-alert-propose-selected]")) {
      const root = document.getElementById("stock-alerts");
      const ids = root ? [...root.querySelectorAll("input.stock-alert-pick:checked")].map((cb) => Number(cb.dataset.stockAlertPick)) : [];
      const items = ids.map((id) => recordsForSite(state.stock).find((s) => Number(s.id) === id)).filter(Boolean);
      if (!items.length) {
        showToast("Cochez au moins une alerte ou utilisez « Toutes les alertes ».");
        return;
      }
      proposePurchaseForStockItems(items);
      return;
    }
    if (event.target.closest("[data-stock-alert-check-all]")) {
      document.querySelectorAll("#stock-alerts input.stock-alert-pick").forEach((cb) => { cb.checked = true; });
      return;
    }
    if (event.target.closest("[data-stock-alert-uncheck-all]")) {
      document.querySelectorAll("#stock-alerts input.stock-alert-pick").forEach((cb) => { cb.checked = false; });
      return;
    }
    const deleteButton = event.target.closest("[data-delete-type]");
    if (!deleteButton) return;
    const id = Number(deleteButton.dataset.id);
    const type = deleteButton.dataset.deleteType;
    if (type === "vente" && window.confirm("Supprimer cette vente finalisee ?")) deleteFinalSale(id).catch(handleApiError);
    if (type === "stock" && window.confirm("Supprimer cet article du stock ?")) deleteStockItem(id).catch(handleApiError);
    if (type === "charge" && window.confirm("Supprimer cette depense ?")) deleteCharge(id).catch(handleApiError);
  });
  document.body.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const auditOpen = event.target.closest("[data-audit-open]");
    if (!auditOpen) return;
    event.preventDefault();
    const raw = auditOpen.getAttribute("data-audit-open");
    const id = Number(raw);
    if (raw != null && raw !== "" && !Number.isNaN(id)) openStaffAuditDetailModal(id);
  });
  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeModal(overlay.id);
    });
  });
  const creditSaveBtn = document.getElementById("credit-save-btn");
  if (creditSaveBtn) creditSaveBtn.addEventListener("click", () => saveCreditRecovery().catch(handleApiError));
  const stockSearch = document.getElementById("stock-search");
  if (stockSearch) {
    stockSearch.addEventListener("input", () => {
      stockSearchTerm = stockSearch.value || "";
      if (currentPage === "stock" && stockSubTab === "catalogue") renderStock();
    });
  }
  const stockClear = document.getElementById("stock-search-clear");
  if (stockClear) {
    stockClear.addEventListener("click", () => {
      stockSearchTerm = "";
      if (stockSearch) stockSearch.value = "";
      if (currentPage === "stock" && stockSubTab === "catalogue") renderStock();
    });
  }
  ["v-prix", "v-qty", "v-remise"].forEach((id) => document.getElementById(id).addEventListener("input", updateVentePreview));
  document.querySelectorAll(".finalize-pay-input").forEach((input) => input.addEventListener("input", updatePaymentMixPreview));
  document.getElementById("v-article").addEventListener("change", syncKnownProduct);
  document.getElementById("v-article").addEventListener("blur", syncKnownProduct);
  const vArticleSearch = document.getElementById("v-article-search");
  if (vArticleSearch) {
    vArticleSearch.addEventListener("input", () => {
      if (document.getElementById("modal-vente")?.classList.contains("open")) renderVenteArticlePicker();
    });
  }
  document.getElementById("v-location").addEventListener("change", () => {
    document.getElementById("v-prix").value = "";
    syncKnownProduct();
  });
  document.getElementById("v-format").addEventListener("change", () => {
    const product = findKnownProduct(document.getElementById("v-article").value);
    document.getElementById("v-prix").value = String(productPrice(product, document.getElementById("v-location").value) || "");
    updateKitInfo(product);
    updateVentePreview();
  });
  document.getElementById("v-order-select").addEventListener("change", () => {
    const id = Number(document.getElementById("v-order-select").value) || null;
    activeOrderId = id;
    const order = currentOrder();
    document.getElementById("v-client").value = order?.client || document.getElementById("v-client").value;
    document.getElementById("v-note").value = order?.note || document.getElementById("v-note").value;
    document.getElementById("finalize-order-btn").disabled = !id;
  });
  ["qr-table", "qr-alias", "qr-count", "qr-prefix"].forEach((id) => {
    document.getElementById(id).addEventListener("input", renderQrPreview);
  });
  const creditList = document.getElementById("credit-list");
  if (creditList) {
    creditList.addEventListener("click", (event) => {
      const fill = event.target.closest("[data-credit-fill]");
      if (!fill) return;
      const name = fill.getAttribute("data-credit-fill") || "";
      const nameField = document.getElementById("credit-name");
      if (nameField) nameField.value = debtorDisplayKey(name);
      const dueMap = creditOutstandingMap();
      const key = debtorDisplayKey(name);
      const remaining = Number(dueMap[key]) || 0;
      const amountField = document.getElementById("credit-amount");
      if (amountField && remaining > 0) amountField.value = String(Math.round(remaining));
      const creditDt = document.getElementById("credit-datetime");
      if (creditDt) creditDt.value = datetimeLocalNow();
      showToast("Client sélectionné pour encaissement.");
    });
  }
}

async function init() {
  attachEvents();
  setAuthVisible(false);
  try {
    const session = await apiRequest(API.session);
    sessionUser = session.username;
    currentRole = normalizeRoleForUsername(session.username, session.role);
    allowedSiteIds = session.allowedSiteIds || [];
    setAuthVisible(true);
    await bootstrapAuthenticatedApp();
  } catch (error) {
    setAuthVisible(false);
  }
}

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js")
      .then((registration) => registration.update())
      .catch((error) => console.error(error));
  });
}
