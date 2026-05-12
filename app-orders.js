const API = {
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
  state: "/api/state",
  changes: "/api/changes",
  reset: "/api/reset",
  purgeMaquis: "/api/purge-maquis",
  restoreFromJson: "/api/admin/restore-from-json",
  adminBackups: "/api/admin/backups",
  restoreSiteFromBackup: "/api/admin/restore-site-from-backup",
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
/**
 * Si true : cycle journalier imposé — ouverture caisse avant ventes, clôture avant nouvelle ouverture,
 * ventes bloquées si journée non ouverte ou déjà clôturée pour la date concernée.
 * Si false : comportement legacy (pas de blocage ventes lié au PDJ).
 */
const PDJ_REQUIRE_CASH_OPENING = true;
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
/** Après fermeture du modal « nouveau casier » sans enregistrer, on annule la reprise commande achat. */
let pendingPurchaseCasierResume = false;
let sessionDeadlineUnix = null;

function applySessionTimingFromApi(payload) {
  if (!payload || typeof payload.sessionDeadlineUnix !== "number" || payload.sessionDeadlineUnix <= 0) {
    sessionDeadlineUnix = null;
    return;
  }
  sessionDeadlineUnix = payload.sessionDeadlineUnix;
}

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

/** Plus ancienne ouverture de crédit (vente avec « Crédit client » ou « À régler »), par débiteur — pour affichage recouvrement. */
function creditFirstOpenedLabelByDebtor(sourceState = state) {
  const ventes = recordsForSite(sourceState?.ventes || []);
  /** @type {Record<string, { ts: number, hasTime: boolean }>} */
  const best = {};
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
    const sold = String(v.soldAt || v.createdAt || "").trim();
    let ts;
    let hasTime = false;
    if (sold) {
      const d = new Date(sold);
      if (!Number.isNaN(d.getTime())) {
        ts = d.getTime();
        hasTime = true;
      }
    }
    if (ts == null) {
      const day = String(v.date || "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        ts = new Date(`${day}T12:00:00`).getTime();
        hasTime = false;
      }
    }
    if (ts == null || !Number.isFinite(ts)) return;
    const cur = best[debtorName];
    if (!cur || ts < cur.ts) best[debtorName] = { ts, hasTime };
  });
  const labels = {};
  Object.keys(best).forEach((k) => {
    const { ts, hasTime } = best[k];
    labels[k] = hasTime ? formatDateTimeDdMmYyyy(new Date(ts)) : formatDateDdMmYyyy(new Date(ts));
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

/** Affichage quantité « casiers » commande (y compris demi-casier, tous types de lots). */
function fmtPurchaseCases(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(rounded - Math.round(rounded)) < 1e-6) {
    return new Intl.NumberFormat("fr-FR").format(Math.round(rounded));
  }
  return new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(rounded);
}

/** Quantité de lots normalisée : jusqu'à 2 décimales (ex. 0,5) — y compris casiers consignés bière (réservation casiers vides = plafond par somme, arrondi supérieur au total). */
function roundPurchaseCasesFromRaw(lineLike, raw) {
  const n = Math.max(0, Number(raw) || 0);
  return Math.round(n * 100) / 100;
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

// Heure (locale) avant laquelle on considère qu'on est encore dans la nuit de la veille
const NIGHT_SHIFT_CUTOFF_HOUR = 8;

/**
 * Date de travail effective : si on est avant NIGHT_SHIFT_CUTOFF_HOUR et que la journée
 * d'hier est encore ouverte (dayBook existant, pas encore clôturé), on reste sur hier.
 * Cela couvre les maquis qui ferment au petit matin.
 */
function workingDate() {
  const now = new Date();
  if (now.getHours() < NIGHT_SHIFT_CUTOFF_HOUR) {
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    const yStr = [
      yest.getFullYear(),
      String(yest.getMonth() + 1).padStart(2, "0"),
      String(yest.getDate()).padStart(2, "0"),
    ].join("-");
    const yBook = dayBookFor(yStr, currentSiteId());
    const yClosed = stockCheckForSiteDate(yStr, currentSiteId());
    if (yBook && !yClosed) return yStr;
  }
  return today();
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

/** Libellé naturel : « 0 vente », « 1 vente », « 16 ventes ». */
function formatVentesCountFr(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return "0 vente";
  if (n === 1) return "1 vente";
  return `${n} ventes`;
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

/** Table HTML : tous les versements enregistrés (historique recouvrement), du plus récent au plus ancien. */
function buildCreditRecoveryHistoryHtml() {
  const payments = creditRecoveriesForSite()
    .slice()
    .sort((a, b) => String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || "")));
  if (!payments.length) {
    return `<div class="credit-history-section" style="margin-top:18px">
      <p class="eyebrow" style="margin-bottom:8px">Historique des paiements</p>
      <p class="muted" style="font-size:0.9rem">Aucun versement enregistré pour ce maquis. Après « Enregistrer le versement », chaque paiement apparaît ici avec date, montant et mode.</p>
    </div>`;
  }
  const rows = payments.map((p) => `
    <tr>
      <td>${escapeHtml(formatCreditPaidAt(p))}</td>
      <td><strong>${escapeHtml(debtorDisplayKey(p.debiteur))}</strong></td>
      <td style="text-align:right;color:#72d7a9;font-weight:600">${fmt(p.montant)} FCFA</td>
      <td>${escapeHtml(p.paiement || "—")}</td>
      <td class="muted" style="font-size:0.88rem;max-width:240px">${escapeHtml(p.note || "—")}</td>
    </tr>
  `).join("");
  return `<div class="credit-history-section" style="margin-top:18px">
    <p class="eyebrow" style="margin-bottom:10px">Historique des paiements (${payments.length})</p>
    <div class="stock-table-wrap">
      <table class="stock-table" style="min-width:720px">
        <thead><tr>
          <th>Date et heure</th>
          <th>Client (débiteur)</th>
          <th style="text-align:right">Montant versé</th>
          <th>Mode</th>
          <th>Note</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
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

/** Si true : alertes lorsque quantite au plus egale au seuil article. Si false (defaut) : alertes seulement si quantite strictement inferieure au seuil. */
function stockAlertInclusiveSeuil(site = currentSite()) {
  return Boolean(site?.stockAlertInclusiveSeuil);
}

function isStockBelowArticleSeuilForAlert(actuelBtl, seuilMin, site = currentSite()) {
  const seuil = Math.max(0, Number(seuilMin) || 0);
  if (seuil <= 0) return false;
  const actuel = Math.max(0, Number(actuelBtl) || 0);
  return stockAlertInclusiveSeuil(site) ? actuel <= seuil : actuel < seuil;
}

function isFrigoLowForAlert(frigoBtl, seuilFrigo, site = currentSite()) {
  const s = Math.max(0, Number(seuilFrigo) || 0);
  if (s <= 0) return false;
  const fr = Math.max(0, Number(frigoBtl) || 0);
  return stockAlertInclusiveSeuil(site) ? fr <= s : fr < s;
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

function linePackSize(line, stockItem = null) {
  const explicitPackSize = Math.max(0, Number(line?.formatQuantite) || Number(line?.packSize) || 0);
  if (explicitPackSize > 0) return explicitPackSize;
  const linePrice = Number(line?.prix) || 0;
  const matchingFormat = linePrice > 0 && stockItem
    ? normalizeSaleFormats(stockItem)
      .filter((format) => Number(format.quantite) > 1)
      .sort((a, b) => Number(b.quantite) - Number(a.quantite))
      .find((format) => Number(format.prixInterieur) === linePrice || Number(format.prixExterieur) === linePrice)
    : null;
  return Math.max(1, Number(matchingFormat?.quantite) || Number(stockItem?.packSize) || 1);
}

function lineBottleQty(line, stockItem = null) {
  return (Number(line?.qty) || 0) * linePackSize(line, stockItem);
}

function lineQtyLabel(line, stockItem = null) {
  const qty = Number(line?.qty) || 0;
  const packSize = linePackSize(line, stockItem);
  if (packSize > 1) {
    return `${fmt(qty * packSize)} btl (${fmt(qty)} x kit de ${fmt(packSize)})`;
  }
  return fmt(qty);
}

function lineQtyPriceLabel(line, stockItem = null) {
  const packSize = linePackSize(line, stockItem);
  const price = fmt(line?.prix || 0);
  if (packSize > 1) {
    return `${lineQtyLabel(line, stockItem)} · ${price} FCFA`;
  }
  return `${lineQtyLabel(line, stockItem)} x ${price} FCFA`;
}

/** Prix moyen par bouteille sur une ligne de vente (pour préremplir reliquat / consigne). */
function venteUnitPricePerBottle(vente) {
  if (!vente) return 0;
  const si = stockItemForArticle(vente.article);
  const bottles = Math.max(1, lineBottleQty(vente, si));
  const net = calcNet(vente);
  if (net > 0) return Math.round(net / bottles);
  const pack = linePackSize(vente, si);
  const p = Number(vente.prix) || 0;
  return pack > 1 ? Math.round(p / pack) : Math.round(p);
}

function stockItemForArticle(article, siteId = currentSiteId()) {
  const site = siteId ?? currentSiteId();
  const multi = multiSiteActive();
  const target = String(article || "").toLowerCase();
  const scoped = (state.stock || []).find((item) =>
    rowMatchesSite(item, site, multi)
    && String(item.article || "").toLowerCase() === target
  ) || null;
  if (scoped) return scoped;

  // Fallback compat: anciennes lignes sans siteId quand le multi-maquis est actif.
  // Si l'article est unique dans le catalogue global, on le prend.
  const allMatches = (state.stock || []).filter((item) =>
    String(item.article || "").toLowerCase() === target
  );
  if (allMatches.length === 1) return allMatches[0];

  // Si plusieurs, tenter de prioriser un match explicite siteId (même si rowMatchesSite a échoué).
  const direct = allMatches.find((it) => String(it.siteId || "") === String(site || ""));
  return direct || null;
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

const VALID_CASE_SIZES = [1, 6, 9, 12, 16, 20, 24];

function lotType(item = {}) {
  const raw = String(item.lotType || "").trim().toLowerCase();
  if (raw === "carton") return "carton";
  if (raw === "unite" || raw === "unité" || raw === "unit" || raw === "u") return "unite";
  return "casier";
}

function lotLabel(item = {}) {
  const t = lotType(item);
  if (t === "carton") return "carton";
  if (t === "unite") return "unité";
  return "casier";
}

function caseSize(item = {}) {
  const value = Number(item.caseSize) || 24;
  if (VALID_CASE_SIZES.includes(value)) return value;
  // Unités par lot : si l'article est "unité", on retombe à 1
  if (lotType(item) === "unite") return 1;
  return 24;
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
  const preserve = (id) => String(document.getElementById(id)?.value ?? "").trim();
  populateBrasserieFournisseurSelect(document.getElementById("s-brasserie"), { mode: "catalog", preservedValue: preserve("s-brasserie") });
  populateBrasserieFournisseurSelect(document.getElementById("brasserie-attach-name"), { mode: "catalog", preservedValue: preserve("brasserie-attach-name") });
  populateBrasserieFournisseurSelect(document.getElementById("p-single-br-name"), { mode: "catalog", preservedValue: preserve("p-single-br-name") });
  populateBrasserieFournisseurSelect(document.getElementById("new-site-single-br-name"), {
    mode: "catalog",
    preservedValue: preserve("new-site-single-br-name"),
  });
  syncSingleBreweryUi();
}

const DEFAULT_BRASSERIES = ["Brassivoire", "Carré d'or", "Solibra"];

/** Clé de comparaison brasserie / fournisseur : casse + accents (ex. Carré d'or ≈ Carre d'or). */
function brasserieMatchKey(name) {
  return String(name ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/\u2019/g, "'")
    .toLowerCase();
}

function brasserieListForCurrentSite() {
  const only = siteSingleBreweryName();
  if (only) return [only];
  const fromCatalogue = recordsForSite(state.stock)
    .map((item) => String(item.brasserie || "").trim())
    .filter(Boolean)
    .filter((b) => !isExcludedBrasserieSuggestion(b));
  const merged = [...DEFAULT_BRASSERIES, ...fromCatalogue].filter((b) => !isExcludedBrasserieSuggestion(b));
  const seen = new Set();
  const out = [];
  for (const b of merged) {
    const k = brasserieMatchKey(b);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(b);
  }
  return out.sort((a, b) => a.localeCompare(b, "fr"));
}

function casierIsAvailableEmptyForOrder(casier) {
  if (!casier) return false;
  if (casier.reservedByPoId) return false;
  if (casier.returnedAt) return false;
  return Math.max(0, Number(casier.quantiteActuelle) || 0) === 0;
}

function availableEmptyCasiersCount(brasserie, cap, siteId = currentSiteId()) {
  const brK = brasserieMatchKey(brasserie);
  const c = Math.max(1, Number(cap) || 24);
  return casiersForSite().filter((x) =>
    brasserieMatchKey(x.article || "") === brK
    && Math.max(1, Number(x.capacite) || 24) === c
    && casierIsAvailableEmptyForOrder(x)
  ).length;
}

function draftReservedCasesFor(brasserie, cap) {
  const brK = brasserieMatchKey(brasserie);
  const c = Math.max(1, Number(cap) || 24);
  return (purchaseDraftLines || [])
    .filter((l) => l.selected !== false)
    .filter((l) => {
      const it = stockItemForArticle(l.article);
      return purchaseLineNeedsConsigneReservation(it)
        && brasserieMatchKey(it.brasserie || l.brasserie || "") === brK
        && Math.max(1, Number(l.cap) || Number(l.caseSize) || caseSize(it) || 24) === c;
    })
    .reduce((sum, l) => sum + (Number(l.cases) || 0), 0);
}

function clampDraftCasesToAvailable(brasserie, cap) {
  const brK = brasserieMatchKey(brasserie);
  const c = Math.max(1, Number(cap) || 24);
  const totalAvail = availableEmptyCasiersCount(brasserie, c);
  if (!catalogueHasCasierConsigneForPurchaseBr(brasserie)) {
    return { available: totalAvail };
  }
  let remaining = totalAvail;
  purchaseDraftLines = (purchaseDraftLines || []).map((line) => {
    if (line.selected === false) return line;
    const it = stockItemForArticle(line.article);
    if (!purchaseLineNeedsConsigneReservation(it)) return line;
    if (brasserieMatchKey(it.brasserie || line.brasserie || "") !== brK || Math.max(1, Number(line.cap) || Number(line.caseSize) || caseSize(it) || 24) !== c) return line;
    const want = Math.max(0, Math.round((Number(line.cases) || 0) * 100) / 100);
    const take = Math.min(want, remaining);
    remaining = Math.round((remaining - take) * 100) / 100;
    return { ...line, cases: take, amount: Math.round(take * (Number(line.pricePerCase) || 0)) };
  });
  return { available: remaining };
}

function reserveEmptyCasiersForPurchaseOrder(po) {
  if (!po) return;
  const siteId = po.siteId || currentSiteId();
  /** besoin cumulé par ``brasserietarifaire::cap`` (uniquement lignes catalogue casier-consigne). */
  const buckets = {};
  const bucketLabel = {};
  for (const l of po.lines || []) {
    const it = stockItemForArticle(l.article);
    if (!purchaseLineNeedsConsigneReservation(it)) continue;
    const br = normalizeBrasserieName(it.brasserie || po.supplier || "");
    const cap = Math.max(1, Number(l.caseSize) || caseSize(it) || 24);
    const k = `${brasserieMatchKey(br)}::${cap}`;
    buckets[k] = (buckets[k] || 0) + Math.max(0, Number(l.cases) || 0);
    bucketLabel[k] = br;
  }
  Object.entries(buckets).forEach(([k, neededRaw]) => {
    const sep = k.lastIndexOf("::");
    const brK = sep >= 0 ? k.slice(0, sep) : k;
    const cap = sep >= 0 ? Math.max(1, Number(k.slice(sep + 2)) || 24) : 24;
    const needed = Math.max(0, Math.ceil((Number(neededRaw) || 0) - 1e-9));
    const candidates = casiersForSite()
      .filter((c) => rowMatchesSite(c, siteId, multiSiteActive()))
      .filter((c) => brasserieMatchKey(c.article || "") === brK)
      .filter((c) => Math.max(1, Number(c.capacite) || 24) === cap)
      .filter((c) => casierIsAvailableEmptyForOrder(c))
      .sort((a, b) => String(a.code || "").localeCompare(String(b.code || ""), "fr"));
    if (candidates.length < needed) {
      const brShow = bucketLabel[k] || brK;
      throw new Error(`Casiers vides insuffisants pour ${brShow} B${cap}. Disponible: ${candidates.length}, demandé: ${needed} casier(s) vide(s).`);
    }
    candidates.slice(0, needed).forEach((c) => {
      c.reservedByPoId = po.id;
      c.reservedAt = new Date().toISOString();
    });
  });
}

function releaseReservedCasiersForPurchaseOrder(poId) {
  const id = Number(poId);
  (state.casiers || []).forEach((c) => {
    if (Number(c.reservedByPoId) === id) {
      delete c.reservedByPoId;
      delete c.reservedAt;
    }
  });
}

function supplierKey(value) {
  return String(value || "").trim().toLowerCase();
}

/** Sentinelle interne pour les articles sans brasserie catalogue (champ commande fournisseur). */
const PURCHASE_NO_BRASSERIE_VALUE = "__sans_brasserie__";

/** Libellé affiché (option select, nom sur la commande) — la valeur technique est PURCHASE_NO_BRASSERIE_VALUE. */
const PURCHASE_SANS_BRASSERIE_LABEL = "Sans brasserie (cartons et autres)";

/** Première ligne des listes Brasserie / fournisseur (`<select>`) — valeur vide. */
const BRASSERIE_FOURNISSEUR_PLACEHOLDER_LABEL = "ex: Brassivoire, Solibra, Castel…";

/** Noms à ne jamais proposer comme brasserie (erreurs catalogue, ex. type de lot saisi comme brasserie). */
function isExcludedBrasserieSuggestion(name) {
  const k = supplierKey(String(name || "").trim());
  return k === "carton";
}

function purchaseSupplierRawFromDom() {
  return String(document.getElementById("purchase-supplier")?.value ?? "").trim();
}

/** Ancien select « brasserie (N casiers vides) » — enlève le suffixe pour matcher le catalogue. */
function stripPurchaseSupplierVidesSuffix(raw) {
  return String(raw ?? "")
    .replace(/\s+\([\d\s]+casier\(s\)\s+vide\(s\)\)\s*$/i, "")
    .trim();
}

/** Interprète la saisie / datalist → sentinel sans brasserie ou nom brasserie brut. */
function purchaseSupplierInputToCanonical(raw) {
  const s = stripPurchaseSupplierVidesSuffix(String(raw ?? "").trim());
  if (!s) return "";
  if (supplierKey(s) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE)) return PURCHASE_NO_BRASSERIE_VALUE;
  if (s === PURCHASE_SANS_BRASSERIE_LABEL || supplierKey(s) === supplierKey(PURCHASE_SANS_BRASSERIE_LABEL)) {
    return PURCHASE_NO_BRASSERIE_VALUE;
  }
  return s;
}

function getPurchaseSupplierCanonical() {
  return purchaseSupplierInputToCanonical(purchaseSupplierRawFromDom());
}

/** Libellé enregistré sur la commande et pour les prix fournisseur (« Fournisseur » si vide). */
function getPurchaseSupplierDisplayName() {
  const c = getPurchaseSupplierCanonical();
  if (c === PURCHASE_NO_BRASSERIE_VALUE) return PURCHASE_SANS_BRASSERIE_LABEL;
  const raw = purchaseSupplierRawFromDom();
  return raw || "Fournisseur";
}

function catalogueHasCasierConsigneForPurchaseBr(br) {
  const bKey = brasserieMatchKey(br);
  if (!bKey) return false;
  return recordsForSite(state.stock || []).some((item) =>
    brasserieMatchKey(item.brasserie) === bKey && lotType(item) === "casier"
  );
}

/** Ne compte pas les casiers physiques rattachés uniquement à du stock carton / non-casier. */
function physicalCasierCountsForPurchaseVides(casierRow) {
  const key = String(casierRow.article || "").trim().toLowerCase();
  const siteId = currentSiteId();
  const multi = multiSiteActive();
  const matches = (state.stock || []).filter((it) =>
    rowMatchesSite(it, siteId, multi) && String(it.article || "").trim().toLowerCase() === key
  );
  if (!matches.length) return true;
  return matches.some((it) => lotType(it) === "casier");
}

function brasserieMatchesPurchaseSelect(selValue, item) {
  const v = purchaseSupplierInputToCanonical(selValue);
  if (!v || supplierKey(v) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE)) {
    return !normalizeBrasserieName(item.brasserie);
  }
  return brasserieMatchKey(item.brasserie) === brasserieMatchKey(v);
}

function purchaseSupplierCountsEmptyCratesHints(supplierValue) {
  const v = purchaseSupplierInputToCanonical(String(supplierValue ?? "").trim());
  if (!v || supplierKey(v) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE)) return false;
  return catalogueHasCasierConsigneForPurchaseBr(v);
}

/** Lignes catalogue casier/carton pour la brasserie sélectionnée et le format B{n}. */
function purchaseContextStockItemsFiltered() {
  const brSel = getPurchaseSupplierCanonical();
  const formatVal = document.getElementById("purchase-article")?.value?.trim() || "";
  const capMatch = formatVal.match(/^B(\d+)$/);
  if (!capMatch || !String(brSel).trim()) return [];
  const cap = Number(capMatch[1]);
  return recordsForSite(state.stock).filter((item) =>
    brasserieMatchesPurchaseSelect(brSel, item)
    && (caseSize(item) || 24) === cap
    && (lotType(item) === "casier" || lotType(item) === "carton")
  );
}

function primaryPurchaseDraftStockLineForSync() {
  const detail = document.getElementById("purchase-article-detail")?.value?.trim();
  const items = purchaseContextStockItemsFiltered();
  if (detail && items.length) return items.find((x) => String(x.article) === detail) || null;
  if (items.length === 1) return items[0];
  return null;
}

function purchaseLineNeedsConsigneReservation(stockRow) {
  return Boolean(
    stockRow
    && lotType(stockRow) === "casier"
    && catalogueHasCasierConsigneForPurchaseBr(normalizeBrasserieName(stockRow.brasserie)),
  );
}

function supplierNamesForCurrentSite() {
  return [...new Set([
    ...brasserieListForCurrentSite(),
    ...purchaseOrdersForSite().map((po) => String(po.supplier || "").trim()).filter(Boolean),
    ...recordsForSite(state.supplierPrices || []).map((row) => String(row.supplier || "").trim()).filter(Boolean),
  ])].sort((a, b) => a.localeCompare(b, "fr"));
}

/**
 * Casiers physiques « vides disponibles » (compteur réservation commande fournisseur) :
 * même règle que `syncPurchaseQtyFromStock` / `reserveEmptyCasiersForPurchaseOrder` — hors réservés,
 * hors retournés, sans btl pleines en caisse (pas l’agrégat floor(btl vides/cap)).
 */
function physicallyAvailableEmptyCasiersForPurchaseBr(cap, brasserieRaw) {
  const brGrp = normalizeBrasserieName(String(brasserieRaw || "").trim());
  if (!brGrp || !catalogueHasCasierConsigneForPurchaseBr(brGrp)) return 0;
  const capN = Math.max(1, Math.floor(Number(cap) || 24));
  return casiersForSite().filter((c) =>
    brasserieMatchKey(c.article || "") === brasserieMatchKey(brGrp)
    && Math.max(1, Number(c.capacite) || 24) === capN
    && physicalCasierCountsForPurchaseVides(c)
    && casierIsAvailableEmptyForOrder(c),
  ).length;
}

/** Somme des casiers vides disponibles brasserie donnée — tous capacités (indicatif liste fournisseur). */
function physicallyAvailableEmptyCasiersForPurchaseBrand(brasserieRaw) {
  const brGrp = normalizeBrasserieName(String(brasserieRaw || "").trim());
  if (!brGrp || !catalogueHasCasierConsigneForPurchaseBr(brGrp)) return 0;
  return casiersForSite().filter((c) =>
    brasserieMatchKey(c.article || "") === brasserieMatchKey(brGrp)
    && physicalCasierCountsForPurchaseVides(c)
    && casierIsAvailableEmptyForOrder(c),
  ).length;
}

function computeVidesByBrForPurchaseHints() {
  const videsByBr = {};
  const brasseries = brasserieListForCurrentSite().filter((b) => catalogueHasCasierConsigneForPurchaseBr(b));
  brasseries.forEach((br) => {
    const k = brasserieMatchKey(br);
    if (!k) return;
    videsByBr[k] = physicallyAvailableEmptyCasiersForPurchaseBrand(br);
  });
  return videsByBr;
}

/** Remplit tout `<select>` « Brasserie / fournisseur » (commande achat ou catalogue/paramètres). */
function populateBrasserieFournisseurSelect(sel, options = {}) {
  if (!sel) return;
  const mode = options.mode === "purchase" ? "purchase" : "catalog";
  const only = siteSingleBreweryName();
  const preservedArg = options.preservedValue !== undefined ? options.preservedValue : sel.value;
  const preserveStr = String(preservedArg ?? "").trim();

  let brasseries = brasserieListForCurrentSite();
  if (mode === "catalog" && preserveStr && !isExcludedBrasserieSuggestion(preserveStr)) {
    const n = normalizeBrasserieName(preserveStr);
    if (n && !brasseries.some((b) => brasserieMatchKey(b) === brasserieMatchKey(n))) {
      brasseries = [...brasseries, preserveStr].sort((a, b) => a.localeCompare(b, "fr"));
    }
  }

  /** Toujours proposer en commande fournisseur (multi-brasseries) pour commander cartons / articles sans brasserie. */
  const hasSansBrasserie = mode === "purchase" && !only;

  const videsByBr = mode === "purchase" ? computeVidesByBrForPurchaseHints() : null;

  let html;
  if (!brasseries.length && mode !== "purchase") {
    html = `<option value="">${escapeHtml("Aucune brasserie dans le catalogue")}</option>`;
  } else {
    html = `<option value="">${escapeHtml(BRASSERIE_FOURNISSEUR_PLACEHOLDER_LABEL)}</option>`;
    if (hasSansBrasserie) {
      html += `<option value="${escapeHtml(PURCHASE_NO_BRASSERIE_VALUE)}">${escapeHtml(PURCHASE_SANS_BRASSERIE_LABEL)}</option>`;
    }
    html += brasseries
      .map((br) => {
        if (mode === "purchase") {
          const showVides = purchaseSupplierCountsEmptyCratesHints(br);
          const v = showVides ? (videsByBr[brasserieMatchKey(br)] || 0) : 0;
          const label = showVides && v > 0 ? `${br}  (${fmt(v)} casier(s) vide(s))` : br;
          return `<option value="${escapeHtml(br)}">${escapeHtml(label)}</option>`;
        }
        return `<option value="${escapeHtml(br)}">${escapeHtml(br)}</option>`;
      })
      .join("");
  }

  sel.innerHTML = html;

  if (mode === "purchase" && only) {
    sel.value = only;
    sel.setAttribute("disabled", "disabled");
    return;
  }
  if (mode === "purchase") {
    sel.removeAttribute("disabled");
    const currentCanon = purchaseSupplierInputToCanonical(preserveStr);
    if (currentCanon === PURCHASE_NO_BRASSERIE_VALUE && hasSansBrasserie) {
      sel.value = PURCHASE_NO_BRASSERIE_VALUE;
      return;
    }
    const keep =
      currentCanon
      && supplierKey(currentCanon) !== supplierKey(PURCHASE_NO_BRASSERIE_VALUE)
      && !isExcludedBrasserieSuggestion(currentCanon)
      && [...sel.options].some(
        (o) => o.value && brasserieMatchKey(o.value) === brasserieMatchKey(currentCanon),
      );
    if (keep) {
      const m = [...sel.options].find(
        (o) => o.value && brasserieMatchKey(o.value) === brasserieMatchKey(currentCanon),
      );
      sel.value = m ? m.value : "";
      return;
    }
    sel.value = "";
    return;
  }

  sel.removeAttribute("disabled");
  if (!preserveStr) {
    sel.value = "";
    return;
  }
  if (isExcludedBrasserieSuggestion(preserveStr)) {
    sel.value = "";
    return;
  }
  const stripped = stripPurchaseSupplierVidesSuffix(preserveStr);
  const match = [...sel.options].find(
    (o) => o.value && brasserieMatchKey(o.value) === brasserieMatchKey(stripped),
  );
  sel.value = match ? match.value : "";
}

function populateSupplierList() {
  const sel = document.getElementById("purchase-supplier");
  populateBrasserieFournisseurSelect(sel, { mode: "purchase", preservedValue: sel?.value });
}

function populatePurchaseArticlesByBrasserie(br) {
  const sel = document.getElementById("purchase-article");
  if (!sel) return;
  const brSel = String(br ?? "").trim();
  if (!brSel) {
    sel.innerHTML = `<option value="">— Choisir d'abord une brasserie —</option>`;
    return;
  }
  const brCanon = purchaseSupplierInputToCanonical(brSel);
  const articles = recordsForSite(state.stock).filter((item) =>
    brasserieMatchesPurchaseSelect(brSel, item)
    && (lotType(item) === "casier" || lotType(item) === "carton"),
  );
  const brNorm = normalizeBrasserieName(
    supplierKey(brCanon) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE) ? undefined : brCanon,
  );
  const capSet = new Set(articles.map((item) => caseSize(item) || 24));
  const caps = [...capSet].sort((a, b) => b - a);
  const aggregateVides = Boolean(brNorm) && catalogueHasCasierConsigneForPurchaseBr(brNorm);
  const videsByCap = {};
  if (aggregateVides) {
    caps.forEach((capSz) => {
      videsByCap[capSz] = physicallyAvailableEmptyCasiersForPurchaseBr(capSz, brNorm);
    });
  }
  const anyReserve = aggregateVides && articles.some((item) => purchaseLineNeedsConsigneReservation(item));
  let html = `<option value="">— Choisir un format —</option>`;
  for (const cap of caps) {
    const v = anyReserve ? (videsByCap[cap] || 0) : 0;
    const videsLabel = v > 0 ? `  ↩ ${fmt(v)} casier(s) vide(s)` : "";
    html += `<option value="B${cap}">${escapeHtml(`B${cap}${videsLabel}`)}</option>`;
  }
  sel.innerHTML = html;
  // Cacher le détail article tant qu'aucun format n'est sélectionné
  const detailWrap = document.getElementById("purchase-article-detail-wrap");
  if (detailWrap) detailWrap.style.display = "none";
  if (caps.length === 1) { sel.value = `B${caps[0]}`; populatePurchaseArticleDetailFromFormat(); syncPurchaseLineInputsFromStock(); }
}

function populatePurchaseArticleDetailFromFormat() {
  const formatVal = document.getElementById("purchase-article")?.value?.trim() || "";
  const brRaw = document.getElementById("purchase-supplier")?.value ?? "";
  const brCanon = purchaseSupplierInputToCanonical(brRaw);
  const wrap = document.getElementById("purchase-article-detail-wrap");
  const sel = document.getElementById("purchase-article-detail");
  const hint = document.getElementById("purchase-article-detail-hint");
  const capMatch = formatVal.match(/^B(\d+)$/);
  if (!wrap || !sel || !capMatch || !String(brRaw ?? "").trim()) {
    if (wrap) wrap.style.display = "none";
    return;
  }
  const cap = Number(capMatch[1]);
  const articles = recordsForSite(state.stock).filter((item) =>
    brasserieMatchesPurchaseSelect(brRaw, item)
    && (caseSize(item) || 24) === cap
    && (lotType(item) === "casier" || lotType(item) === "carton"),
  );
  if (!articles.length) { wrap.style.display = "none"; return; }
  const brTarif = normalizeBrasserieName(
    supplierKey(brCanon) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE) ? undefined : brCanon,
  );
  const vRetournablesBeer =
    brTarif && catalogueHasCasierConsigneForPurchaseBr(brTarif)
      ? physicallyAvailableEmptyCasiersForPurchaseBr(cap, brTarif)
      : 0;
  sel.innerHTML = `<option value="">— Choisir un article —</option>` +
    articles.map((item) => {
      const vr = purchaseLineNeedsConsigneReservation(item) ? vRetournablesBeer : 0;
      const videsLabel = vr > 0 ? `  ↩ ${fmt(vr)} casier(s) vide(s)` : "";
      return `<option value="${escapeHtml(item.article)}" data-vides="${vr}">${escapeHtml(item.article + videsLabel)}</option>`;
    }).join("");
  wrap.style.display = "";
  if (hint) hint.textContent = "";
  if (articles.length === 1) { sel.value = articles[0].article; syncPurchaseLineInputsFromStock(); }
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

/**
 * Duplique catalogue stock et grilles fournisseur depuis un maquis modele vers un nouveau siteId.
 * Les quantites (init, entrees, sorties, frigo, reserve, lots) sont remises a zero ; nouveaux ids stock.
 */
function cloneCatalogRowsForNewSite(templateSiteId, newSiteId) {
  const stockList = state.stock || [];
  const priceList = state.supplierPrices || [];
  const multiSite = (state.sites || []).length > 1;
  const stockTemplate = stockList.filter((item) => rowMatchesSite(item, templateSiteId, multiSite));
  const priceTemplate = priceList.filter((row) => rowMatchesSite(row, templateSiteId, multiSite));
  const nextId = { ...state.nextId };
  if (nextId.stock == null || Number.isNaN(Number(nextId.stock))) {
    const maxExisting = stockList.reduce((m, s) => Math.max(m, Number(s.id) || 0), 0);
    nextId.stock = Math.max(100, maxExisting + 1);
  }
  const now = new Date().toISOString();
  const actor = sessionUser || "-";
  const newStock = stockTemplate.map((row) => {
    const c = JSON.parse(JSON.stringify(row));
    c.id = Number(nextId.stock++);
    c.siteId = newSiteId;
    c.init = 0;
    c.entrees = 0;
    c.sorties = 0;
    if (Object.prototype.hasOwnProperty.call(c, "frigo")) c.frigo = 0;
    if (Object.prototype.hasOwnProperty.call(c, "reserve")) c.reserve = 0;
    if (Object.prototype.hasOwnProperty.call(c, "initCases")) c.initCases = 0;
    delete c.lastReapproAt;
    delete c.lastReapproBy;
    delete c.lastSortieBy;
    delete c.sortiesToday;
    c.createdAt = now;
    c.createdBy = actor;
    return c;
  });
  const newPrices = priceTemplate.map((row) => {
    const c = JSON.parse(JSON.stringify(row));
    c.siteId = newSiteId;
    c.id = `${newSiteId}-${now}-${Math.random().toString(36).slice(2, 9)}`;
    c.createdAt = now;
    c.updatedAt = now;
    c.updatedBy = actor;
    return c;
  });
  return { newStock, newPrices, nextId };
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

/** Ouverture / clôture journée comptable (PDJ) : tout utilisateur connecté sauf les comptes serveuse. */
function canManagePdjAccounting() {
  return Boolean(sessionUser) && String(currentRole || "").trim() !== "serveuse";
}

/** Date traitee sur le Point du jour : admin et superadmin peuvent choisir une journee anterieure pour corriger les ecarts.
 *  Pour tous les roles, si la journee d'hier est encore ouverte (maquis ouvert la nuit), on reste sur hier. */
function pdjCalendarDate() {
  const t = today();
  if (!canAnyAdmin()) return workingDate();
  const el = document.getElementById("pdj-work-date");
  const v = el?.value?.trim();
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v > t ? t : v;
  return workingDate();
}

function syncPdjWorkDateInput() {
  const el = document.getElementById("pdj-work-date");
  if (!el || !canAnyAdmin()) return;
  const t = today();
  el.max = t;
  if (!el.value || el.value > t) el.value = workingDate();
  const workDate = pdjCalendarDate();
  const vDateEl = document.getElementById("v-date");
  if (vDateEl) vDateEl.value = workDate;
  const filterDateEl = document.getElementById("orders-filter-date");
  if (filterDateEl) filterDateEl.value = workDate;
  syncFinalizeButtonJournalState();
  if (currentPage === "ventes") renderVentesPage();
}

const STAFF_AUDIT_MAX = 800;

function shouldRecordStaffAudit() {
  if (!sessionUser) return false;
  return true;
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
    const q = lineQtyLabel(line, stockItemForArticle(line.article));
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
    const cases = fmtPurchaseCases(l.cases);
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
    cloture_jour: "Clôture journée",
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
  const detailEl = document.getElementById("audit-detail-detail");
  if (detailEl) detailEl.classList.remove("is-expanded");
  const toggleBtn = document.getElementById("audit-detail-toggle-btn");
  if (toggleBtn) toggleBtn.textContent = "Agrandir";
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
  let detailText = row.detail || "—";
  // Amélioration UX: pour "Commande fournisseur", si l'ancien audit est trop court,
  // tenter de reconstituer la liste des lignes à partir de state.purchaseOrders.
  if (String(row.entity || "") === "achat_fournisseur") {
    const hasList = typeof detailText === "string" && (detailText.includes("\n1.") || detailText.includes("Total:"));
    if (!hasList && Array.isArray(state?.purchaseOrders) && state.purchaseOrders.length) {
      const supplierFromSummary = (() => {
        const s = String(row.summary || "");
        const m = s.match(/Commande fournisseur\s+(.+?)(?:\s+\(#?\d+\))?$/i);
        return (m && m[1]) ? m[1].trim() : "";
      })();
      const at = String(row.at || "");
      const datePrefix = at ? at.slice(0, 10) : "";
      const actor = String(row.actor || "");
      const candidates = state.purchaseOrders.filter((po) => {
        if (supplierFromSummary && String(po.supplier || "").trim() !== supplierFromSummary) return false;
        if (datePrefix && String(po.date || "").slice(0, 10) !== datePrefix) return false;
        if (actor && String(po.createdBy || "").trim() !== actor) return false;
        return true;
      });
      if (candidates.length) {
        // Choisir le plus proche de l'heure de l'audit.
        const targetTs = at ? Date.parse(at) : NaN;
        candidates.sort((a, b) => {
          const da = Math.abs((Date.parse(a.createdAt || "") || 0) - (Number.isNaN(targetTs) ? 0 : targetTs));
          const db = Math.abs((Date.parse(b.createdAt || "") || 0) - (Number.isNaN(targetTs) ? 0 : targetTs));
          return da - db;
        });
        const po = candidates[0];
        const rebuilt = formatPurchaseOrderAuditDetail(po);
        if (rebuilt) detailText = `${detailText}\n\n---\nDETAIL (reconstruit)\n\n${rebuilt}`;
      }
    }
  }
  // Commandes: si le détail est trop court (ex "7 ligne(s)"), tenter de retrouver un détail complet
  // depuis une autre entrée d'audit concernant la même commande (#id).
  if (String(row.entity || "") === "commande") {
    const hasList = typeof detailText === "string" && (detailText.includes("\n1.") || detailText.includes("Total:"));
    if (!hasList) {
      const m = String(row.summary || "").match(/#(\d+)/);
      const orderId = m ? Number(m[1]) : null;
      if (orderId && Array.isArray(state?.staffAuditLog)) {
        const candidates = state.staffAuditLog
          .filter((r) => Number(r.id) !== Number(row.id))
          .filter((r) => String(r.entity || "") === "commande" || String(r.entity || "") === "commande_statut")
          .filter((r) => String(r.summary || "").includes(`#${orderId}`))
          .filter((r) => typeof r.detail === "string" && (r.detail.includes("\n1.") || r.detail.includes("Total:")));
        if (candidates.length) {
          // Prendre l'entrée la plus proche (id/temps).
          candidates.sort((a, b) => Math.abs(Number(a.id) - Number(row.id)) - Math.abs(Number(b.id) - Number(row.id)));
          const rebuilt = String(candidates[0].detail || "").trim();
          if (rebuilt) detailText = `${detailText}\n\n---\nDETAIL (reconstruit)\n\n${rebuilt}`;
        }
      }
    }
  }
  set("audit-detail-detail", detailText);
  openModal("modal-staff-audit-detail");
  detailEl?.focus();
}

function copyTextToClipboard(text) {
  const raw = String(text || "");
  if (!raw) return Promise.resolve(false);
  if (navigator?.clipboard?.writeText) {
    return navigator.clipboard.writeText(raw).then(() => true).catch(() => false);
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = raw;
    ta.setAttribute("readonly", "true");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return Promise.resolve(Boolean(ok));
  } catch {
    return Promise.resolve(false);
  }
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
  // Filtres (stateful sans dépendre d'HTML fixe)
  window.__staffAuditUi = window.__staffAuditUi || {
    q: "",
    role: "all",
    actor: "all",
    entity: "all",
    verb: "all",
    page: 0,
    pageSize: 80,
  };
  const ui = window.__staffAuditUi;

  const uniq = (arr) => [...new Set(arr)].filter(Boolean);
  const roles = uniq(log.map((r) => String(r.role || "").trim())).sort((a, b) => a.localeCompare(b, "fr"));
  const actors = uniq(log.map((r) => String(r.actor || "").trim())).sort((a, b) => a.localeCompare(b, "fr"));
  const entities = uniq(log.map((r) => String(r.entity || "").trim())).sort((a, b) => a.localeCompare(b, "fr"));
  const verbs = uniq(log.map((r) => String(r.verb || "").trim())).sort((a, b) => a.localeCompare(b, "fr"));

  const q = String(ui.q || "").trim().toLowerCase();
  const filtered = log.filter((row) => {
    if (ui.role !== "all" && String(row.role || "") !== ui.role) return false;
    if (ui.actor !== "all" && String(row.actor || "") !== ui.actor) return false;
    if (ui.entity !== "all" && String(row.entity || "") !== ui.entity) return false;
    if (ui.verb !== "all" && String(row.verb || "") !== ui.verb) return false;
    if (!q) return true;
    const hay = `${row.at || ""} ${row.siteNom || ""} ${row.siteId || ""} ${row.actor || ""} ${row.role || ""} ${row.verb || ""} ${row.entity || ""} ${row.summary || ""} ${row.detail || ""}`.toLowerCase();
    return hay.includes(q);
  });

  const total = filtered.length;
  const maxPage = Math.max(0, Math.ceil(total / ui.pageSize) - 1);
  ui.page = Math.min(Math.max(0, ui.page), maxPage);
  const start = ui.page * ui.pageSize;
  const pageRows = filtered.slice(start, start + ui.pageSize);

  const opt = (value, label, current) => `<option value="${escapeHtml(value)}" ${String(current) === String(value) ? "selected" : ""}>${escapeHtml(label)}</option>`;

  container.innerHTML = `
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin:6px 0 12px">
      <div class="form-group form-group--zero" style="min-width:220px;flex:1">
        <label for="audit-q">Recherche</label>
        <input id="audit-q" type="search" placeholder="client, article, action, utilisateur..." value="${escapeHtml(ui.q || "")}">
      </div>
      <div class="form-group form-group--zero" style="min-width:160px">
        <label for="audit-role">Role</label>
        <select id="audit-role">
          ${opt("all", "Tous", ui.role)}
          ${roles.map((r) => opt(r, r, ui.role)).join("")}
        </select>
      </div>
      <div class="form-group form-group--zero" style="min-width:190px">
        <label for="audit-actor">Utilisateur</label>
        <select id="audit-actor">
          ${opt("all", "Tous", ui.actor)}
          ${actors.map((a) => opt(a, a, ui.actor)).join("")}
        </select>
      </div>
      <div class="form-group form-group--zero" style="min-width:180px">
        <label for="audit-verb">Action</label>
        <select id="audit-verb">
          ${opt("all", "Toutes", ui.verb)}
          ${verbs.map((v) => opt(v, staffAuditVerbLabel(v), ui.verb)).join("")}
        </select>
      </div>
      <div class="form-group form-group--zero" style="min-width:200px">
        <label for="audit-entity">Type</label>
        <select id="audit-entity">
          ${opt("all", "Tous", ui.entity)}
          ${entities.map((e) => opt(e, staffAuditEntityLabel(e), ui.entity)).join("")}
        </select>
      </div>
      <div class="form-group form-group--zero" style="min-width:120px">
        <label for="audit-size">Taille page</label>
        <select id="audit-size">
          ${[40, 80, 150, 300].map((n) => opt(String(n), `${n}`, String(ui.pageSize))).join("")}
        </select>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        <button type="button" class="mini-btn" id="audit-prev" ${ui.page <= 0 ? "disabled" : ""}>◀</button>
        <span class="muted" style="font-size:0.82rem">${fmt(start + 1)}–${fmt(Math.min(start + ui.pageSize, total))} / ${fmt(total)}</span>
        <button type="button" class="mini-btn" id="audit-next" ${ui.page >= maxPage ? "disabled" : ""}>▶</button>
      </div>
    </div>
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
          ${pageRows.map((row) => `<tr>
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

  // Handlers (idempotent: DOM replaced each render)
  const bind = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("change", fn); };
  const bindInput = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener("input", fn); };
  bindInput("audit-q", (e) => { ui.q = e.target.value; ui.page = 0; renderStaffAuditLog(); });
  bind("audit-role", (e) => { ui.role = e.target.value; ui.page = 0; renderStaffAuditLog(); });
  bind("audit-actor", (e) => { ui.actor = e.target.value; ui.page = 0; renderStaffAuditLog(); });
  bind("audit-verb", (e) => { ui.verb = e.target.value; ui.page = 0; renderStaffAuditLog(); });
  bind("audit-entity", (e) => { ui.entity = e.target.value; ui.page = 0; renderStaffAuditLog(); });
  bind("audit-size", (e) => { ui.pageSize = Math.max(20, Number(e.target.value) || 80); ui.page = 0; renderStaffAuditLog(); });
  document.getElementById("audit-prev")?.addEventListener("click", () => { ui.page = Math.max(0, ui.page - 1); renderStaffAuditLog(); });
  document.getElementById("audit-next")?.addEventListener("click", () => { ui.page = Math.min(maxPage, ui.page + 1); renderStaffAuditLog(); });
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
  syncDualZonePricingUi();
  syncSingleBreweryUi();
}

/** Maquis avec prix cave / terrasse ou tarif unique (pas de lieu en vente). */
function siteUsesDualZonePricing(site = currentSite()) {
  if (!site) return true;
  return site.dualZonePricing !== false;
}

function siteSingleBreweryName(site = currentSite()) {
  if (!site) return "";
  const enabled = site.singleBreweryOnly === true;
  if (!enabled) return "";
  return String(site.singleBreweryName || "").trim();
}

function siteIsSingleBrewery(site = currentSite()) {
  return Boolean(siteSingleBreweryName(site));
}

function syncSingleBreweryUi() {
  const site = currentSite();
  const enabled = Boolean(site?.singleBreweryOnly);
  const brName = String(site?.singleBreweryName || "").trim();

  // Create site UI
  const createEnabledEl = document.getElementById("new-site-single-br-enabled");
  const createWrap = document.getElementById("new-site-single-br-wrap");
  if (createEnabledEl && createWrap) {
    createWrap.classList.toggle("hidden", !createEnabledEl.checked);
  }

  // Params UI
  const pEnabledEl = document.getElementById("p-single-br-enabled");
  const pWrap = document.getElementById("p-single-br-wrap");
  if (pEnabledEl && pWrap) {
    pWrap.classList.toggle("hidden", !pEnabledEl.checked);
  }

  // Stock modal: force brasserie
  const stockBrEl = document.getElementById("s-brasserie");
  if (stockBrEl) {
    if (enabled && brName) {
      stockBrEl.value = brName;
      stockBrEl.setAttribute("disabled", "disabled");
    } else {
      stockBrEl.removeAttribute("disabled");
    }
  }

  // Purchase form: force supplier
  const purchaseSupplier = document.getElementById("purchase-supplier");
  if (purchaseSupplier) {
    if (enabled && brName) {
      purchaseSupplier.value = brName;
      purchaseSupplier.setAttribute("disabled", "disabled");
    } else {
      purchaseSupplier.removeAttribute("disabled");
    }
  }
}

/** Affiche ou masque les sélecteurs de lieu selon la config du maquis. */
function syncDualZonePricingUi() {
  const dual = siteUsesDualZonePricing();
  const vWrap = document.getElementById("v-location-wrap");
  if (vWrap) vWrap.classList.toggle("hidden", !dual);
  const vLoc = document.getElementById("v-location");
  if (vLoc && !dual) vLoc.value = "Intérieur";

  const kWrap = document.getElementById("kit-location-wrap");
  if (kWrap) kWrap.classList.toggle("hidden", !dual);
  const kLoc = document.getElementById("kit-location");
  if (kLoc && !dual) kLoc.value = "Intérieur";

  const srWrap = document.getElementById("sr-location-wrap");
  if (srWrap) srWrap.classList.toggle("hidden", !dual);
  const srLoc = document.getElementById("sr-location");
  if (srLoc && !dual) srLoc.value = "Intérieur";

  const printQrExtBtn = document.getElementById("print-qr-ext-btn");
  if (printQrExtBtn) printQrExtBtn.classList.toggle("hidden", !dual);
  const qrLegacyCards = document.querySelectorAll("#qr-card-preview > .qr-two-cols > .qr-location-card");
  if (qrLegacyCards.length >= 2) {
    qrLegacyCards[1].classList.toggle("hidden", !dual);
    if (!dual && qrLegacyCards[0]?.parentElement)
      qrLegacyCards[0].parentElement.style.gridTemplateColumns = "1fr";
    else if (qrLegacyCards[0]?.parentElement) qrLegacyCards[0].parentElement.style.gridTemplateColumns = "";
  }

  if (currentPage === "ventes") {
    const q = document.getElementById("sr-search")?.value || "";
    renderSrMenu(q);
    if (document.getElementById("qr-card-preview") && !document.getElementById("qr-card-preview").classList.contains("hidden")) {
      renderQrPreview();
    }
  }
}

function applyRoleVisibility() {
  const restrictedPages = ["home", "stock", "charges", "params"];
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
  const eff = String(sessionUser || "").trim().toLowerCase() === "admin" ? "superadmin" : currentRole;
  const roleLabel = eff === "superadmin"
    ? "super administrateur"
    : eff === "admin"
      ? "admin. maquis"
      : eff === "manager"
        ? "gérant"
        : (eff || "utilisateur");
  const badge = document.getElementById("role-badge");
  badge.textContent = roleLabel;
  badge.title = `Compte : ${sessionUser || "—"}. Role effectif : ${roleLabel}. Les actions sensibles sont verifiees cote serveur selon ce role et les maquis autorises.`;
  const sid = currentSiteId() || "";
  const scopeEl = document.getElementById("header-site-scope");
  if (scopeEl) {
    scopeEl.textContent = sid
      ? `Maquis actif : ${currentSite()?.nom || sid} (${sid})`
      : "";
    scopeEl.title = "Les ecritures (ventes, stock…) sont rattachees a ce maquis dans l'etat enregistre.";
  }
  const sessExp = document.getElementById("top-session-expires");
  if (sessExp) {
    if (typeof sessionDeadlineUnix === "number" && sessionDeadlineUnix > 0) {
      const ms = sessionDeadlineUnix * 1000;
      if (ms > Date.now()) {
        sessExp.textContent = `Session (echeance indicative) : ${formatDateTimeDdMmYyyy(new Date(ms))}`;
        sessExp.title = "L'expiration reelle depend de l'inactivite et de la duree max. configurees sur le serveur (MAQUIS_MANAGER_SESSION_*).";
      } else {
        sessExp.textContent = "";
        sessExp.removeAttribute("title");
      }
    } else {
      sessExp.textContent = "";
      sessExp.removeAttribute("title");
    }
  }
}

function renderHero() {
  const titles = {
    home: "Le cœur de votre bar, en temps réel.",
    pdj: "Le point du jour, séparé du tableau de bord.",
    ventes: "Servez plusieurs clients sans perdre la commande en cours.",
    guide: "Mode d'emploi accessible à toute l'équipe.",
    stock: "Les prix de vente partent du catalogue stock.",
    charges: "Les sorties d'argent restent centralisées.",
    params: "Paramètres organisés par onglets : profil, catalogue, accès, administration.",
  };
  const copies = {
    home: "Le serveur garde les sessions et l'état complet de l'application.",
    pdj: "Ouverture puis fermeture de journée : gérant et administrateurs ; les ventes sont bloquées tant que la journée n'est pas ouverte. Les serveuses consultent le reste.",
    ventes: "Une commande peut être modifiée autant de fois que nécessaire avant la facture finale, si la journée est ouverte.",
    guide: "Sommaire, liens vers le guide imprimable PDF ; même les comptes serveuse peuvent consulter cette page.",
    stock: "Renseignez prix achat et prix vente pour accélérer la prise de commande.",
    charges: "Toutes les dépenses sont historisées côté serveur.",
    params: "Profil du maquis et export JSON sous Profil ; catégories et utilisateurs ont leur propre onglet.",
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
  const isConsignes = tab === "consignes";
  document.getElementById("ventes-card-gestion").classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-board").classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-qr").classList.toggle("hidden", !isQr);
  document.getElementById("ventes-card-historique").classList.toggle("hidden", !isCaisse);
  document.getElementById("ventes-card-consignes")?.classList.toggle("hidden", !isConsignes);
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
  const isCasiers = tab === "casiers";
  document.getElementById("stock-card-catalogue").classList.toggle("hidden", !isCatalogue);
  document.getElementById("stock-list").classList.toggle("hidden", !isCatalogue);
  document.getElementById("stock-card-mouvements").classList.toggle("hidden", !isMouvements);
  document.getElementById("stock-card-achats").classList.toggle("hidden", !isAchats);
  document.getElementById("stock-card-creanciers").classList.toggle("hidden", !isCreanciers);
  document.getElementById("stock-card-casiers")?.classList.toggle("hidden", !isCasiers);
  document.querySelectorAll("[data-subtab-stock]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.subtabStock === tab);
  });
  if (currentPage === "stock") {
    if (isAchats) renderPurchaseOrders();
    else if (isCreanciers) renderCreanciers();
    else if (isMouvements) renderStockMovements();
    else if (isCasiers) renderCasiers();
  }
  syncFabLabelForStockPage();
}

function renderCasiers() {
  const container = document.getElementById("casiers-content");
  if (!container) return;
  renderBrasserieAttachMenu();
  const products = recordsForSite(state.stock).filter((item) => lotType(item) !== "unite");
  if (!products.length) {
    container.innerHTML = "<p class='muted' style='padding:20px;text-align:center'>Aucun article dans le catalogue.</p>";
    return;
  }

  // --- RÉSUMÉ CASIERS PHYSIQUES par brasserie ---
  const allCasiers = casiersForSite();
  let casiersResume = "";
  if (allCasiers.length > 0) {
    const mkGrp = () => ({ plein: 0, partiel: 0, vide: 0, btlPleines: 0, btlVides: 0 });
    const byBr = {};
    allCasiers.forEach((c) => {
      const stockIt = stockItemForArticle(c.article);
      const br = normalizeBrasserieName(stockIt?.brasserie || c.article) || "Sans brasserie";
      const cap = Math.max(1, Number(c.capacite) || 24);
      if (!byBr[br]) byBr[br] = { ...mkGrp(), byCap: {} };
      const g = byBr[br];
      if (!g.byCap[cap]) g.byCap[cap] = mkGrp();
      const gc = g.byCap[cap];
      const st = String(c.statut || "vide").toLowerCase();
      if (st === "plein") { g.plein++; gc.plein++; }
      else if (st === "partiel") { g.partiel++; gc.partiel++; }
      else { g.vide++; gc.vide++; }
      const p = Math.max(0, Number(c.quantiteActuelle) || 0);
      const v = Math.max(0, Number(c.bouteillesVides) || 0);
      g.btlPleines += p; gc.btlPleines += p;
      g.btlVides += v;   gc.btlVides += v;
    });
    const totalAvecStock = allCasiers.filter((c) => (Number(c.quantiteActuelle) || 0) > 0).length;
    const totalVides = allCasiers.filter((c) => (Number(c.quantiteActuelle) || 0) <= 0).length;
    const totalBtlVides = allCasiers.reduce((s, c) => s + (Number(c.bouteillesVides) || 0), 0);
    const totalBtlPleines = allCasiers.reduce((s, c) => s + (Number(c.quantiteActuelle) || 0), 0);
    const rowCells = (g, indent) => `
      <td style="${indent ? "padding-left:20px;font-size:0.78rem;color:#555" : ""}">
        ${indent ? `<span style="color:#90a4ae;margin-right:4px">↳</span><strong style="color:#455a64">B${indent}</strong>` : ""}
      </td>
      <td style="text-align:right;font-weight:700;color:#2e7d32;${indent ? "font-size:0.78rem" : ""}">${fmt(g.plein)}</td>
      <td style="text-align:right;font-weight:700;color:#f57c00;${indent ? "font-size:0.78rem" : ""}">${fmt(g.partiel)}</td>
      <td style="text-align:right;font-weight:700;color:#e53935;${indent ? "font-size:0.78rem" : ""}">${fmt(g.vide)}</td>
      <td style="text-align:right;font-weight:700;color:#1976d2;${indent ? "font-size:0.78rem" : ""}">${fmt(g.btlPleines)}</td>
      <td style="text-align:right;font-weight:700;${g.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"};${indent ? "font-size:0.78rem" : ""}">${fmt(g.btlVides)}</td>`;
    casiersResume = `<div style="margin-bottom:18px;border-radius:10px;border:1.5px solid #e3f2fd;background:#f8fbff;padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <strong style="font-size:0.9rem;color:#1565c0">État des casiers physiques</strong>
        <span style="font-size:0.78rem;color:#757575">${fmt(allCasiers.length)} casier(s) enregistré(s)</span>
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
        <span style="padding:5px 12px;border-radius:7px;background:#e8f5e9;color:#2e7d32;font-size:0.82rem;font-weight:700">${fmt(totalAvecStock)} avec stock · ${fmt(totalBtlPleines)} btl pleines</span>
        <span style="padding:5px 12px;border-radius:7px;background:#fff3e0;color:#e65100;font-size:0.82rem;font-weight:700">${fmt(totalVides)} vide(s)</span>
        ${totalBtlVides > 0 ? `<span style="padding:5px 12px;border-radius:7px;background:#fce4ec;color:#c62828;font-size:0.82rem">${fmt(totalBtlVides)} btl vide(s) à retourner</span>` : ""}
      </div>
      <div style="overflow-x:auto"><table class="data-table" style="width:100%;font-size:0.82rem">
        <thead><tr>
          <th style="text-align:left">Brasserie / Format</th>
          <th style="text-align:right;color:#2e7d32">Pleins</th>
          <th style="text-align:right;color:#f57c00">Partiels</th>
          <th style="text-align:right;color:#e53935">Vides</th>
          <th style="text-align:right;color:#1976d2">Btl pleines</th>
          <th style="text-align:right;color:#e65100">Btl vides</th>
        </tr></thead>
        <tbody>${Object.entries(byBr).sort(([a], [b]) => a.localeCompare(b, "fr")).map(([br, g]) => {
          const capRows = Object.entries(g.byCap).sort(([a], [b]) => Number(b) - Number(a));
          return `<tr style="background:#eaf2ff">
            <td><strong style="color:#1565c0">${escapeHtml(br)}</strong></td>
            <td style="text-align:right;font-weight:700;color:#2e7d32">${fmt(g.plein)}</td>
            <td style="text-align:right;font-weight:700;color:#f57c00">${fmt(g.partiel)}</td>
            <td style="text-align:right;font-weight:700;color:#e53935">${fmt(g.vide)}</td>
            <td style="text-align:right;font-weight:700;color:#1976d2">${fmt(g.btlPleines)}</td>
            <td style="text-align:right;font-weight:700;${g.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(g.btlVides)}</td>
          </tr>${capRows.map(([cap, gc]) => `<tr style="background:#fafbff">
            <td style="padding-left:22px;font-size:0.8rem"><span style="color:#90a4ae">↳</span> <strong style="color:#455a64">B${cap}</strong></td>
            <td style="text-align:right;font-size:0.8rem;font-weight:600;color:#2e7d32">${fmt(gc.plein)}</td>
            <td style="text-align:right;font-size:0.8rem;font-weight:600;color:#f57c00">${fmt(gc.partiel)}</td>
            <td style="text-align:right;font-size:0.8rem;font-weight:600;color:#e53935">${fmt(gc.vide)}</td>
            <td style="text-align:right;font-size:0.8rem;font-weight:600;color:#1976d2">${fmt(gc.btlPleines)}</td>
            <td style="text-align:right;font-size:0.8rem;font-weight:600;${gc.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(gc.btlVides)}</td>
          </tr>`).join("")}`;
        }).join("")}</tbody>
      </table></div>
    </div>`;
  }

  // Group by brasserie (fallback to cat) then by lotType+caseSize
  const byBrasserie = {};
  products.forEach((item) => {
    const key = (item.brasserie || "").trim() || (item.cat || "Autres");
    const cs = caseSize(item);
    const lt = lotType(item);
    const groupKey = `${lt}:${cs}`;
    if (!byBrasserie[key]) byBrasserie[key] = {};
    if (!byBrasserie[key][groupKey]) byBrasserie[key][groupKey] = [];
    byBrasserie[key][groupKey].push(item);
  });
  let totalLotsTous = 0, totalLotsConsignes = 0, nbAlerte = 0, nbEpuise = 0;
  let html = `<div style="display:flex;justify-content:flex-end;margin-bottom:14px">
    <button type="button" class="sync-casiers-btn" style="background:#1565c0;color:#fff;border:none;padding:7px 16px;border-radius:8px;font-size:0.82rem;cursor:pointer;font-weight:600;letter-spacing:0.01em">
      ⟳ Créer casiers depuis stock &amp; ventes
    </button>
  </div>`;
  Object.entries(byBrasserie).sort(([a], [b]) => a.localeCompare(b, "fr")).forEach(([brasserie, byCaseSize]) => {
    const catCasiers = Object.values(byCaseSize).flat().reduce((s, item) => {
      const cs = caseSize(item); const stk = stockActuel(item);
      return s + (stk > 0 ? Math.floor(stk / cs) : 0);
    }, 0);
    html += "<div style='margin-bottom:26px'>";
    html += "<div style='display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px'>";
    html += "<h4 style='margin:0;font-size:0.9rem;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:#1976d2'>" + escapeHtml(brasserie) + "</h4>";
    html += "<span style='font-size:0.78rem;color:#757575'>" + fmt(catCasiers) + " casier(s) total</span>";
    html += "</div>";
    // Sub-group by lot type + case size (sorted by case size desc then casier/carton)
    const groupEntries = Object.entries(byCaseSize).sort(([a], [b]) => {
      const [ta, sa] = String(a).split(":");
      const [tb, sb] = String(b).split(":");
      const na = Number(sa) || 0;
      const nb = Number(sb) || 0;
      if (nb !== na) return nb - na;
      return String(ta).localeCompare(String(tb), "fr");
    });
    groupEntries.forEach(([groupKey, items]) => {
      const [lt, csStr] = String(groupKey).split(":");
      const csNum = Number(csStr) || 24;
      const rows = items.map((item) => {
        const stockBtl = stockActuel(item);
        const casiersFull = Math.floor(stockBtl / csNum);
        const reste = stockBtl % csNum;
        const manquantes = reste > 0 ? csNum - reste : 0;
        const seuil = Number(item.seuilAlerte) || 0;
        const alerte = seuil > 0 && stockBtl > 0 && isStockBelowArticleSeuilForAlert(stockBtl, seuil);
        const epuise = stockBtl === 0;
        if (!epuise) {
          totalLotsTous += casiersFull;
          if (lt === "casier") totalLotsConsignes += casiersFull;
        }
        if (alerte) nbAlerte++;
        if (epuise) nbEpuise++;
        return { item, stockBtl, casiersFull, reste, manquantes, alerte, epuise };
      });
      const groupCasiers = rows.filter((r) => !r.epuise).reduce((s, r) => s + r.casiersFull, 0);
      html += "<div style='margin-bottom:14px;padding:10px 12px 12px;border-radius:10px;border:1px solid #e0e0e0'>";
      html += "<div style='display:flex;justify-content:space-between;align-items:center;margin-bottom:8px'>";
      const groupLabel = lt === "carton" ? "Carton" : "Casier";
      html += "<span style='font-size:0.82rem;font-weight:700;color:#444'>" + groupLabel + " de <strong style=\"color:#1976d2\">" + fmt(csNum) + " unité(s)</strong></span>";
      html += "<button type='button' class='mini-btn co-open-btn' data-co-brasserie='" + escapeHtml(brasserie) + "' data-co-cs='" + csNum + "' style='background:#1976d2;color:#fff;border:none;padding:4px 10px;border-radius:6px;font-size:0.78rem;cursor:pointer'>+ Commander</button>";
      html += "</div>";
      html += "<div style='overflow-x:auto'><table class='data-table' style='width:100%'>";
      html += "<thead><tr><th>Article</th><th style='text-align:right'>Stock (btl)</th><th style='text-align:right'>Casiers complets</th><th style='text-align:right'>Reste (btl)</th><th style='text-align:right;color:#1565c0'>Btl pr. compléter</th><th>Statut</th></tr></thead><tbody>";
      rows.forEach(({ item, stockBtl, casiersFull, reste, manquantes, alerte, epuise }) => {
        const rowBg = epuise ? "background:#fff3e0;" : alerte ? "background:#fffde7;" : "";
        const nameColor = epuise ? "color:#e53935;" : alerte ? "color:#f57c00;" : "";
        const manqHtml = manquantes > 0 ? "<span style='color:#1565c0;font-weight:700'>" + fmt(manquantes) + "</span>" : "<span style='color:#9e9e9e'>—</span>";
        const statusHtml = epuise ? "<span style='color:#e53935;font-weight:600'>Epuise</span>" : alerte ? "<span style='color:#f57c00;font-weight:600'>Commander</span>" : "<span style='color:#2e7d32'>OK</span>";
        html += "<tr style='" + rowBg + "'>";
        html += "<td style='font-weight:500;" + nameColor + "'>" + escapeHtml(item.article) + "</td>";
        html += "<td style='text-align:right;font-weight:600'>" + fmt(stockBtl) + "</td>";
        html += "<td style='text-align:right;font-weight:700;color:#1976d2'>" + (epuise ? "0" : fmt(casiersFull)) + "</td>";
        html += "<td style='text-align:right;color:#757575'>" + (epuise ? "—" : fmt(reste)) + "</td>";
        html += "<td style='text-align:right'>" + manqHtml + "</td>";
        html += "<td>" + statusHtml + "</td>";
        html += "</tr>";
      });
      html += "</tbody></table></div>";
      html += "<div style='display:flex;justify-content:flex-end;gap:16px;font-size:0.8rem;margin-top:6px;padding-top:6px;border-top:1px solid #e0e0e0;color:#555'>";
      html += "<span><strong style='color:#1976d2'>" + fmt(groupCasiers) + "</strong> casier(s) complet(s) en stock</span>";
      html += "</div></div>";
    });
    html += "</div>";
  });
  container.innerHTML = casiersResume + html;
  const kpiTotal = document.getElementById("casiers-kpi-total");
  const kpiConsignes = document.getElementById("casiers-kpi-consignes");
  const kpiAlerte = document.getElementById("casiers-kpi-alerte");
  const kpiEpuise = document.getElementById("casiers-kpi-epuise");
  if (kpiTotal) kpiTotal.textContent = fmt(totalLotsTous);
  if (kpiConsignes) kpiConsignes.textContent = fmt(totalLotsConsignes);
  if (kpiAlerte) kpiAlerte.textContent = String(nbAlerte);
  if (kpiEpuise) kpiEpuise.textContent = String(nbEpuise);
}

function renderBrasserieAttachMenu() {
  const list = document.getElementById("brasserie-attach-list");
  const count = document.getElementById("brasserie-attach-count");
  if (!list) return;
  const term = String(document.getElementById("brasserie-attach-filter")?.value || "").trim().toLowerCase();
  const products = recordsForSite(state.stock)
    .slice()
    .sort((a, b) => String(a.article || "").localeCompare(String(b.article || ""), "fr"));
  const filtered = term
    ? products.filter((item) => String(item.article || "").toLowerCase().includes(term) || String(item.brasserie || "").toLowerCase().includes(term))
    : products;
  if (count) count.textContent = `${fmt(products.length)} article(s)`;
  list.innerHTML = filtered.length
    ? filtered.map((item) => `
      <label class="brasserie-attach-item">
        <input type="checkbox" data-brasserie-stock-id="${item.id}">
        <span>
          <strong>${escapeHtml(item.article || "")}</strong>
          <span class="brasserie-attach-current">${escapeHtml(item.brasserie || "Sans brasserie")} · ${escapeHtml(item.cat || "Autres")} · ${fmt(stockActuel(item))} btl</span>
        </span>
      </label>
    `).join("")
    : emptyState("Aucun article", "Aucun article en stock ne correspond a ce filtre.");
}

async function saveBrasserieAttachment() {
  if (!canAnyAdmin()) {
    showToast("Rattachement reserve a un administrateur.");
    return;
  }
  const brasserie = String(document.getElementById("brasserie-attach-name")?.value || "").trim();
  if (!brasserie) {
    showToast("Saisissez le nom de la brasserie.");
    return;
  }
  const ids = [...document.querySelectorAll("[data-brasserie-stock-id]:checked")].map((input) => Number(input.dataset.brasserieStockId));
  if (!ids.length) {
    showToast("Selectionnez au moins un article.");
    return;
  }
  const selected = new Set(ids);
  let updated = 0;
  state.stock = (state.stock || []).map((item) => {
    if (!selected.has(Number(item.id)) || !rowMatchesSite(item, currentSiteId(), multiSiteActive())) return item;
    updated++;
    return { ...item, brasserie };
  });
  await persistState({ stock: state.stock });
  populateCategorySelects();
  renderStock();
  renderCasiers();
  showToast(`${fmt(updated)} article(s) rattache(s) a "${brasserie}".`);
}

function clearBrasserieAttachmentSelection() {
  document.querySelectorAll("[data-brasserie-stock-id]:checked").forEach((input) => { input.checked = false; });
}

function openCasierOrderModal(brasserie, cs) {
  const brassEl = document.getElementById("co-brasserie");
  const csEl = document.getElementById("co-cs");
  const videsEl = document.getElementById("co-vides");
  const qtyEl = document.getElementById("co-qty");
  const preview = document.getElementById("co-preview");
  if (brassEl) {
    populateBrasserieFournisseurSelect(brassEl, { mode: "catalog", preservedValue: brasserie || "" });
  }
  if (csEl && cs) csEl.value = String(cs);
  if (videsEl) videsEl.value = "0";
  if (qtyEl) qtyEl.value = "";
  if (preview) preview.style.display = "none";
  const submitBtn = document.getElementById("co-submit-btn");
  if (submitBtn) submitBtn.disabled = true;
  openModal("modal-casier-order");
  window.requestAnimationFrame(() => videsEl?.focus());
}

function renderCasierOrderPreview() {
  const brasserie = document.getElementById("co-brasserie")?.value || "";
  const cs = Number(document.getElementById("co-cs")?.value) || 24;
  const vides = Math.max(0, Number(document.getElementById("co-vides")?.value) || 0);
  const preview = document.getElementById("co-preview");
  const submitBtn = document.getElementById("co-submit-btn");
  if (!preview) return;
  if (vides === 0) { preview.style.display = "none"; if (submitBtn) submitBtn.disabled = true; return; }
  // Articles de cette brasserie avec ce format de casier
  const articles = recordsForSite(state.stock).filter((item) => {
    const b = (item.brasserie || "").trim();
    const fallback = b || item.cat || "";
    return (b === brasserie || fallback === brasserie) && caseSize(item) === cs;
  });
  document.getElementById("co-casiers-full").textContent = fmt(vides);
  document.getElementById("co-total-btl").textContent = fmt(vides * cs) + " btl";
  const articlesEl = document.getElementById("co-articles-list");
  if (articlesEl) {
    articlesEl.innerHTML = articles.length
      ? articles.map((a) => `<span style="background:#e3f2fd;color:#1565c0;border-radius:6px;padding:3px 8px;font-size:0.8rem;font-weight:600">${escapeHtml(a.article)}</span>`).join("")
      : `<span style="color:#9e9e9e;font-size:0.82rem">Aucun article de cette brasserie avec ${fmt(cs)} btl/casier dans le catalogue.</span>`;
  }
  const qtyEl = document.getElementById("co-qty");
  if (qtyEl && !qtyEl.value) qtyEl.value = String(vides);
  preview.style.display = "";
  if (submitBtn) submitBtn.disabled = false;
}

function submitCasierOrder() {
  const brasserie = document.getElementById("co-brasserie")?.value || "";
  const cs = Number(document.getElementById("co-cs")?.value) || 24;
  const qty = Math.max(1, Number(document.getElementById("co-qty")?.value) || 1);
  if (!brasserie) { showToast("Selectionnez une brasserie."); return; }
  const matchingArticles = recordsForSite(state.stock).filter((item) => {
    const b = (item.brasserie || "").trim();
    const fallback = b || item.cat || "";
    return (b === brasserie || fallback === brasserie)
      && (caseSize(item) || 24) === cs
      && lotType(item) === "casier";
  });
  const article = matchingArticles[0] || null;
  if (!article) {
    showToast("Aucun article catalogue pour ce format — verifiez la brasserie et le stock.");
    return;
  }
  closeModal("modal-casier-order");
  navigate("stock");
  setStockSubTab("achats");
  window.requestAnimationFrame(() => {
    openPurchaseForm();
    const supSel = document.getElementById("purchase-supplier");
    if (supSel) supSel.value = brasserie;
    populatePurchaseArticlesByBrasserie(brasserie);
    const fmtSel = document.getElementById("purchase-article");
    const formatVal = `B${cs}`;
    if (!fmtSel || ![...fmtSel.options].some((o) => o.value === formatVal)) {
      showToast(`Format ${formatVal} absent du catalogue pour cette brasserie.`);
      return;
    }
    fmtSel.value = formatVal;
    populatePurchaseArticleDetailFromFormat();
    const detailSel = document.getElementById("purchase-article-detail");
    if (detailSel) detailSel.value = article.article;
    syncPurchasePriceInput();
    const caseSizeField = document.getElementById("purchase-case-size");
    if (caseSizeField) caseSizeField.value = String(cs);
    const casesInput = document.getElementById("purchase-cases");
    if (casesInput) {
      casesInput.value = String(qty);
      casesInput.removeAttribute("max");
    }
    const price = supplierPriceForArticle(article.article, brasserie)
      || Math.max(0, Math.round(Number(document.getElementById("purchase-price")?.value) || 0));
    purchaseDraftLines.push({
      article: article.article,
      brasserie: normalizeBrasserieName(brasserie),
      cap: cs,
      cases: qty,
      caseSize: cs,
      pricePerCase: price,
      amount: Math.round(qty * price),
      selected: true,
    });
    renderPurchaseDraft();
    syncPurchaseLineInputsFromStock();
    showToast(`${qty} casier(s) de ${cs} btl · ${brasserie} · verifiez le prix fournisseur puis enregistrez.`);
  });
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
  if (page === "ventes") { syncPdjWorkDateInput(); setVentesSubTab(ventesSubTab); renderVentesPage(); }
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

function formatPrice(format, location, siteOverride = undefined) {
  if (!format) return 0;
  const site = siteOverride !== undefined ? siteOverride : currentSite();
  const dual = !site || siteUsesDualZonePricing(site);
  const loc = dual ? location : "Intérieur";
  return String(loc).startsWith("Ext") ? Number(format.prixExterieur) || 0 : Number(format.prixInterieur) || 0;
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
  // Only show articles that exist in the current stock catalogue (not deleted articles from sales history)
  const catalogueIds = new Set(recordsForSite(state.stock).map((i) => i.article.toLowerCase()));
  const items = knownProducts()
    .filter((p) => catalogueIds.has(p.article.toLowerCase()))
    .sort((a, b) => a.article.localeCompare(b.article, "fr"));
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
  const allCount = recordsForSite(state.stock).length;
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
      ? `Journée du ${formatDateDdMmYyyy(dStr)} · aujourd'hui ${formatDateDdMmYyyy(new Date())}`
      : formatDateDdMmYyyy(new Date());
  }
  renderCashOpeningPanel();
  document.getElementById("pdj-ca").textContent = `${fmt(caEncaisse)} FCFA`;
  document.getElementById("pdj-creances").textContent = `${fmt(caCreances)} FCFA`;
  document.getElementById("pdj-nb").textContent = String(ventesJour.length);
  document.getElementById("pdj-remises").textContent = `${fmt(remisesJour)} FCFA`;
  document.getElementById("pdj-ventes-count").textContent = formatVentesCountFr(ventesJour.length);

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
        ? "Les ventes du jour apparaissent ici dès qu'elles sont enregistrées."
        : "Les ventes de cette date apparaîtront ici.",
    );
  renderDailyStockCheck();
  renderPastClosuresForReopen();
}

/** Annule les écritures comptables (sorties / entrées) appliquées par une clôture — même logique que prevClose dans closeAccountingDay. */
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
    host.innerHTML = `<p class="muted" style="font-size:0.88rem;margin:8px 0 0">Aucune journée clôturée enregistrée pour ce maquis.</p>`;
    return;
  }
  host.innerHTML = `
    <div class="section-head pdj-detail-head" style="margin-top:16px">
      <h3 class="pdj-detail-title">Journées clôturées (réouverture)</h3>
    </div>
    <p class="muted" style="font-size:0.85rem;margin:0 0 12px;line-height:1.45">
      Réservé aux administrateurs : supprime la fiche de clôture et annule les écritures de stock associées (sorties journalières et écarts comptables enregistrés à la clôture).
      Les quantités frigo / réserve actuelles ne sont pas modifiées automatiquement ; vérifiez le stock physique si nécessaire.
    </p>
    <ul style="list-style:none;padding:0;margin:0;display:grid;gap:10px">
      ${checks.map((sc) => {
        const dLabel = formatDateDdMmYyyy(sc.date);
        const when = sc.createdAt ? formatDateTimeDdMmYyyy(sc.createdAt) : "";
        const cashOpen = typeof sc.openingCashFcfa === "number" ? `${fmt(sc.openingCashFcfa)} FCFA à l'ouverture` : "";
        return `<li class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <strong>${escapeHtml(dLabel)}</strong>
            ${when ? `<span class="muted" style="font-size:0.85rem"> · clôturée ${escapeHtml(when)}</span>` : ""}
            ${cashOpen ? `<p class="muted" style="margin:4px 0 0;font-size:0.82rem">${escapeHtml(cashOpen)}</p>` : ""}
          </div>
          <button type="button" class="mini-btn" style="border-color:#c54f41;color:#983428" data-reopen-close="${escapeHtml(String(sc.date))}">Réouvrir cette journée</button>
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
    `Réouvrir la journée du ${label} ? La fiche de clôture sera supprimée et les écritures de stock générées par cette clôture seront annulées (frigo / réserve non ajustés automatiquement).`,
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
  showToast(`Journée du ${formatDateDdMmYyyy(dateStr)} réouverte. Corrigez le stock puis reclôturer.`);
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
  if (!canManagePdjAccounting()) {
    showToast("Ouverture de journée réservée au gérant ou à un administrateur.");
    return;
  }
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
  const blockOpen = blockingJournalBeforeOpeningNewDate(dateStr, siteId);
  if (blockOpen) {
    showToast(`La journée du ${isoDateToDdMmYyyy(blockOpen)} doit être clôturée avant d'ouvrir la suivante.`);
    return;
  }
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
  mainWrap?.classList.remove("pdj-main--locked");
  if (lockBlock) lockBlock.classList.remove("pdj-main--locked");
  if (!PDJ_REQUIRE_CASH_OPENING) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  const dStr = pdjCalendarDate();
  const siteId = currentSiteId();
  const closed = stockCheckForSiteDate(dStr, siteId);
  const book = dayBookFor(dStr, siteId);
  const needs = dayBookNeedsCashOpening(book);
  if (lockBlock) {
    lockBlock.classList.toggle("pdj-main--locked", needs && canManagePdjAccounting());
  }
  if (closed) {
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done" style="border-left:3px solid #1565c0;background:#f4f8ff">
        <p class="eyebrow" style="margin-bottom:4px">Journée clôturée</p>
        <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>
        <p class="muted" style="margin-top:8px;line-height:1.45">
          Les ventes pour cette date sont bloquées. Pour encaisser à nouveau, ouvrez la journée suivante depuis cette page (date adéquate, puis ouverture de caisse).
        </p>
        <p class="muted" style="margin-top:8px;font-size:0.82rem;line-height:1.45">
          Une réouverture de journée nécessite un profil gérant ou administrateur et sera journalisée.
        </p>
      </div>`;
    return;
  }
  if (!canManagePdjAccounting() && needs) {
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done" style="border-color:#e0e0e0;background:#fafafa">
        <p class="eyebrow" style="margin-bottom:4px">Étape gérant</p>
        <strong>Ouverture de caisse</strong>
        <p class="muted" style="margin-top:8px">
          Réservé au <strong>gérant</strong> ou à un <strong>administrateur</strong> (pas aux comptes serveuse).
        </p>
      </div>`;
    return;
  }
  if (!needs && book) {
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done">
        <p class="eyebrow" style="margin-bottom:4px">Journée ouverte</p>
        <strong>Fonds en caisse : ${fmt(book.openingCashFcfa)} FCFA</strong>
        <p class="muted" style="margin-top:8px;font-size:0.88rem;line-height:1.45">
          Les ventes sont autorisées pour cette date jusqu'à la <strong>clôture</strong> (vérification stock et caisse ci‑dessous).
          Enregistré ${escapeHtml(formatDateTimeDdMmYyyy(book.openingRecordedAt || book.openedAt))}
          ${book.openingRecordedBy ? ` · ${escapeHtml(book.openingRecordedBy)}` : ""}
        </p>
      </div>`;
    return;
  }
  container.innerHTML = `
    <div class="pdj-opening-card">
      <p class="eyebrow" style="margin-bottom:4px">Ouvrir la journée</p>
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
        <button type="button" class="btn btn-primary" id="pdj-opening-submit" style="width:auto;min-height:44px">Ouvrir la journée</button>
      </div>
    </div>`;
}

const PRODUCT_RANK_TOP_N = 5;
const PRODUCT_RANK_BOTTOM_N = 5;

/** Agrège les lignes de vente par article (quantité en bouteilles + CA net). */
function aggregateVentesByArticle(ventes) {
  const byArticle = {};
  (ventes || []).forEach((v) => {
    const stockItem = recordsForSite(state.stock).find((s) => s.article === v.article);
    const packSize = Math.max(1, Number(v.formatQuantite) || Number(v.packSize) || Number(stockItem?.packSize) || 1);
    const key = v.article;
    if (!byArticle[key]) byArticle[key] = { article: v.article, cat: v.cat || "", bouteilles: 0, ca: 0 };
    byArticle[key].bouteilles += (Number(v.qty) || 0) * packSize;
    byArticle[key].ca += calcNet(v);
  });
  return Object.values(byArticle);
}

/**
 * Top / flop par quantité (bouteilles). Si peu d'articles distincts, le flop peut être omis (showFlop=false).
 */
function topBottomByBottles(rows, { topN = PRODUCT_RANK_TOP_N, bottomN = PRODUCT_RANK_BOTTOM_N, hideFlopWhenSmall = false } = {}) {
  if (!rows.length) return { top: [], bottom: [], showFlop: false };
  const byDesc = [...rows].sort((a, b) => b.bouteilles - a.bouteilles || b.ca - a.ca);
  const byAsc = [...rows].sort((a, b) => a.bouteilles - b.bouteilles || a.ca - b.ca);
  const top = byDesc.slice(0, Math.min(topN, rows.length));
  let showFlop = rows.length >= 2;
  if (hideFlopWhenSmall && rows.length <= topN) showFlop = false;
  if (rows.length <= 1) showFlop = false;
  const bottom = showFlop ? byAsc.slice(0, Math.min(bottomN, rows.length)) : [];
  return { top, bottom, showFlop };
}

function htmlProductRankLists(top, bottom, showFlop, { flopHint } = {}) {
  const rowHtml = (r, rankStyle) => `<article class="list-item" style="padding:10px 12px;margin:0">
    <div style="min-width:0">
      <p class="list-item-title" style="margin:0;font-size:0.92rem">${escapeHtml(r.article)}</p>
      <p class="list-item-sub" style="margin:2px 0 0;font-size:0.78rem">${escapeHtml(r.cat)}</p>
    </div>
    <div class="list-side">
      <p class="list-item-amount" style="margin:0;${rankStyle || ""}">${fmt(r.bouteilles)} btl</p>
      <p class="list-item-date" style="margin:0">${fmt(r.ca)} FCFA</p>
    </div>
  </article>`;
  const topBlock = `
    <div class="product-rank-col">
      <p class="eyebrow" style="margin:0 0 8px;color:#1565c0">Les plus vendues (qté)</p>
      <div style="display:flex;flex-direction:column;gap:8px">${top.map((r) => rowHtml(r, "color:#1565c0")).join("")}</div>
    </div>`;
  if (!showFlop || !bottom.length) return `<div class="product-rank-grid">${topBlock}</div>`;
  return `
    <div class="product-rank-grid">
      ${topBlock}
      <div class="product-rank-col">
        <p class="eyebrow" style="margin:0 0 8px;color:#c62828">Les moins vendues${flopHint ? ` <span class="muted" style="font-weight:400;font-size:0.78rem">(${escapeHtml(flopHint)})</span>` : ""}</p>
        <div style="display:flex;flex-direction:column;gap:8px">${bottom.map((r) => rowHtml(r, "color:#c62828")).join("")}</div>
      </div>
    </div>`;
}

function renderSalesByProduct(ventesJour) {
  const container = document.getElementById("pdj-sales-by-product");
  const countNode = document.getElementById("pdj-sales-count");
  if (!container) return;
  const aggregated = aggregateVentesByArticle(ventesJour);
  const rows = aggregated.sort((a, b) => b.ca - a.ca);
  if (countNode) countNode.textContent = `${rows.length} article(s)`;
  if (!rows.length) {
    container.innerHTML = emptyState("Aucune vente", "Les boissons vendues aujourd'hui apparaîtront ici.");
    return;
  }
  const { top, bottom, showFlop } = topBottomByBottles(aggregated, { hideFlopWhenSmall: true });
  const rankHtml = htmlProductRankLists(top, bottom, showFlop, { flopHint: "ce jour" });
  container.innerHTML = `
    ${rankHtml}
    <p class="muted" style="margin:16px 0 10px;font-size:0.82rem">Detail par article (tri CA net)</p>
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

/** Plus petite date ISO encore « ouverte » (ouverture caisse validée, pas de clôture stock). */
function firstUnclosedJournalDate(siteId = currentSiteId()) {
  let best = null;
  for (const b of state.dayBooks || []) {
    if (!b || b.siteId !== siteId || !b.date) continue;
    const d = String(b.date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (dayBookNeedsCashOpening(b)) continue;
    if (stockCheckForSiteDate(d, siteId)) continue;
    if (!best || d.localeCompare(best) < 0) best = d;
  }
  return best;
}

/**
 * Si non null : impossible d'ouvrir (enregistrer l'ouverture caisse pour) `dateStr` tant que la date retournée n'est pas clôturée.
 * Exception : compléter l'ouverture de la même `dateStr` lorsque le fonds de caisse n'est pas encore saisi.
 */
function blockingJournalBeforeOpeningNewDate(dateStr, siteId = currentSiteId()) {
  const u = firstUnclosedJournalDate(siteId);
  if (!u) return null;
  if (u === dateStr && dayBookNeedsCashOpening(dayBookFor(dateStr, siteId))) return null;
  if (u !== dateStr) return u;
  return null;
}

/** Date utilisée pour les contrôles ventes (formulaire commande / modal). */
function journalSaleDateFromDom() {
  const raw = document.getElementById("v-date")?.value?.trim() || "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return workingDate();
}

/**
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function journalAllowsSalesForDate(saleDateStr, siteId = currentSiteId()) {
  if (!PDJ_REQUIRE_CASH_OPENING) return { ok: true };
  if (!saleDateStr || !siteId) {
    return { ok: false, code: "no_open", message: "Vous devez ouvrir la journée avant d'enregistrer une vente." };
  }
  const d = String(saleDateStr).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    return { ok: false, code: "no_open", message: "Vous devez ouvrir la journée avant d'enregistrer une vente." };
  }
  const book = dayBookFor(d, siteId);
  if (dayBookNeedsCashOpening(book)) {
    return { ok: false, code: "no_open", message: "Vous devez ouvrir la journée avant d'enregistrer une vente." };
  }
  if (stockCheckForSiteDate(d, siteId)) {
    return {
      ok: false,
      code: "closed",
      message: `La journée du ${isoDateToDdMmYyyy(d)} est clôturée. Ouvrez une nouvelle journée (Point du jour) avant d'enregistrer des ventes pour cette date.`,
    };
  }
  return { ok: true };
}

function assertJournalAllowsSalesOrToast(saleDateStr, siteId = currentSiteId()) {
  const j = journalAllowsSalesForDate(saleDateStr, siteId);
  if (!j.ok) showToast(j.message);
  return j.ok;
}

function journalEncaisseDisabledForOrder(order) {
  if (!PDJ_REQUIRE_CASH_OPENING || !order) return false;
  const d = String(order.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  return !journalAllowsSalesForDate(d, order.siteId || currentSiteId()).ok;
}

function journalEncaisseBlockTitle(order) {
  if (!order) return "";
  const d = String(order.date || "").slice(0, 10);
  const j = journalAllowsSalesForDate(d, order.siteId || currentSiteId());
  return j.ok ? "" : j.message;
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
  const openingBlocked = PDJ_REQUIRE_CASH_OPENING && dayBookNeedsCashOpening(dayBook);
  const isPastDate = dStr !== today();
  button.textContent = superadminCorrection
    ? "Mettre à jour la clôture"
    : closed
      ? "Revérifier la journée"
      : openingBlocked && !(isPastDate && canAnyAdmin()) && canManagePdjAccounting()
        ? "Ouverture requise"
        : "Clôturer la journée";
  if (printBtn) printBtn.classList.toggle("hidden", !closed);
  if (!items.length) {
    container.innerHTML = emptyState("Aucun stock", "Ajoutez des articles avant de faire le point de fermeture.");
    button.disabled = false;
    return;
  }

  if (openingBlocked && !(isPastDate && canAnyAdmin()) && canManagePdjAccounting()) {
    container.innerHTML = emptyState(
      "Ouverture de caisse requise",
      "Validez le montant en caisse en haut de cette page avant la vérification stock et la clôture.",
    );
    button.disabled = true;
    return;
  }
  button.disabled = false;

  if (!canManagePdjAccounting()) {
    button.disabled = true;
    if (openingBlocked) {
      container.innerHTML = emptyState(
        "Ouverture de caisse (gérant)",
        "En attente de l'ouverture par un gérant ou un administrateur. Les serveuses peuvent consulter le reste du point du jour.",
      );
      if (printBtn) printBtn.classList.toggle("hidden", true);
      return;
    }
    if (closed) {
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
      <p class="muted" style="margin-bottom:10px;font-size:0.88rem">Lecture seule — vérification et clôture réservées au gérant ou à un administrateur.</p>
      <div class="inline-card" style="margin-bottom:12px">
        <span class="muted">Journée clôturée le</span>
        <strong>${escapeHtml(formatDateTimeDdMmYyyy(closed.createdAt))}</strong>
      </div>
      <div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Article</th>
          <th class="th-orange" style="text-align:right">Stk Ouverture</th>
          <th class="th-blue" style="text-align:right">Sorties jour</th>
          <th style="text-align:right">Théorique</th>
          <th style="text-align:right">Frigo</th>
          <th style="text-align:right">Réserve</th>
          <th class="th-orange" style="text-align:right">Stk Fermeture</th>
          <th style="text-align:right">Écart</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
      if (printBtn) printBtn.classList.toggle("hidden", !closed);
      return;
    }
    const ventesJourRo = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
    const rowsOpen = items.map((item) => {
      const stockAtOpen = dStr === today() ? stockActuel(item) : stockActuel(item);
      const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
      const remaining = Math.max(0, stockAtOpen - sortiesToday);
      const frigoVal = stockFrigo(item);
      const reserveVal = stockReserve(item);
      const gap = (frigoVal + reserveVal) - remaining;
      return `<tr>
        <td>${escapeHtml(item.article)}</td>
        <td style="text-align:right;color:#1976d2">${fmt(stockAtOpen)}</td>
        <td style="text-align:right;color:#ff8e82">${fmt(sortiesToday)}</td>
        <td style="text-align:right">${fmt(remaining)}</td>
        <td style="text-align:right">${fmt(frigoVal)}</td>
        <td style="text-align:right">${fmt(reserveVal)}</td>
        <td style="text-align:right;color:${gap === 0 ? "#72d7a9" : "#ff8e82"}">${gap === 0 ? "OK" : fmt(gap)}</td>
      </tr>`;
    }).join("");
    container.innerHTML = `
      <p class="muted" style="margin-bottom:10px;font-size:0.88rem">
        Lecture seule — la saisie de fermeture et la clôture sont réservées au <strong>gérant</strong> ou à un <strong>administrateur</strong>.
      </p>
      <div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Article</th>
          <th class="th-orange" style="text-align:right">Stk (ref.)</th>
          <th class="th-blue" style="text-align:right">Sorties jour</th>
          <th style="text-align:right">Théorique</th>
          <th style="text-align:right">Frigo</th>
          <th style="text-align:right">Réserve</th>
          <th style="text-align:right">Écart</th>
        </tr></thead>
        <tbody>${rowsOpen}</tbody>
      </table></div>
      <p class="muted" style="margin-top:8px;font-size:0.82rem">${formatVentesCountFr(ventesJourRo.length)} sur cette date — ${fmt(items.length)} ligne(s) de stock.</p>`;
    if (printBtn) printBtn.classList.toggle("hidden", true);
    return;
  }

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
    const closedCheckItem = closed ? (closed.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const stockAtOpen = dStr === today()
      ? stockActuel(item)
      : (closedCheckItem?.stockAvant ?? stockActuel(item));
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
        <strong>Correction de clôture (administrateur)</strong>
        <p class="muted" style="margin-top:6px;font-size:0.86rem;line-height:1.45">
          Champs préremplis avec la dernière clôture du <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>.
          Ajustez frigo, réserve et caisse puis validez pour remplacer la fiche (les écritures de stock seront recalculées).
        </p>
      </div>`
    : "";
  const openedLabel = dayBook?.openedAt ? formatDateTimeDdMmYyyy(dayBook.openedAt) : "—";
  container.innerHTML = `
      ${correctionBanner}
      <div class="inline-card" style="margin-bottom:12px">
        <span class="muted">Référence ouverture</span>
        <strong>${escapeHtml(openedLabel)}</strong>
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
        Saisissez le stock physique réel (frigo + réserve). L'écart s'affiche en direct.
        Les écarts peuvent être enregistrés dans le stock (gérant ou administrateur) ; une confirmation vous sera demandée si besoin.
      </p>
      <div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Article</th>
          <th class="th-orange" style="text-align:right">Stk Ouverture</th>
          <th class="th-blue" style="text-align:right">Sorties jour</th>
          <th style="text-align:right">Théorique</th>
          <th style="text-align:right">Frigo (saisir)</th>
          <th style="text-align:right">Réserve (saisir)</th>
          <th style="text-align:right">Écart</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
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
  const stockAlertRuleHtml = stockAlertInclusiveSeuil(site)
    ? `<p class="muted" style="font-size:0.78rem;margin:0 0 10px;line-height:1.35">Regle alertes pour ce maquis : le stock (bouteilles) est signale lorsqu'il est <strong>inferieur ou egal</strong> au seuil minimum de l'article (option activee dans Parametres &gt; Profil).</p>`
    : `<p class="muted" style="font-size:0.78rem;margin:0 0 10px;line-height:1.35">Regle alertes pour ce maquis : le stock (bouteilles) est signale lorsqu'il est <strong>strictement inferieur</strong> au seuil minimum. Cochez « Alerter des le seuil atteint » dans Parametres &gt; Profil pour alerter des que le stock atteint le seuil (egalite incluse).</p>`;
  const alerts = stockAlertItemsForDashboard();
  document.getElementById("stock-alerts").innerHTML = stockAlertRuleHtml + (alerts.length
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
    : emptyState("Tout va bien", "Aucune alerte stock critique pour le moment."));
  renderBreakdown("pay-chart", paymentTotals(ventes), caTotal, "Aucun paiement disponible.");
  renderDashboardCasierKpis(stock);
  renderDashboardProductRank(ventes);
  syncMobileBottomBadges();
}

function renderDashboardProductRank(ventesSite) {
  const host = document.getElementById("dashboard-product-rank");
  if (!host) return;
  const aggregated = aggregateVentesByArticle(ventesSite || []);
  if (!aggregated.length) {
    host.innerHTML = `<p class="muted" style="margin:0;font-size:0.88rem">Aucune vente enregistrée pour ce maquis — les classements apparaîtront après des ventes finalisées.</p>`;
    return;
  }
  const { top, bottom, showFlop } = topBottomByBottles(aggregated, { hideFlopWhenSmall: true });
  const intro = `<p class="muted" style="margin:0 0 12px;font-size:0.82rem;line-height:1.4">Cumul toutes périodes — tri sur la <strong>quantité (bouteilles)</strong> par article.</p>`;
  host.innerHTML = intro + htmlProductRankLists(top, bottom, showFlop, { flopHint: "historique site" });
}

function renderDashboardCasierKpis(stockSiteList) {
  const all = casiersConsignesForSite();
  const k = { total: all.length, plein: 0, partiel: 0, vide: 0 };
  all.forEach((c) => {
    const st = String(c.statut || "vide").toLowerCase();
    if (st === "plein") k.plein++;
    else if (st === "partiel") k.partiel++;
    else k.vide++;
  });
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  setText("dash-casier-total", fmt(k.total));
  setText("dash-casier-plein", fmt(k.plein));
  setText("dash-casier-partiel", fmt(k.partiel));
  setText("dash-casier-vide", fmt(k.vide));

  const wrap = document.getElementById("dashboard-casier-suggest");
  if (!wrap) return;
  const items = (stockSiteList || recordsForSite(state.stock || []))
    .filter((it) => lotType(it) !== "unite")
    .map((it) => ({ item: it, sug: suggestReapproLots(it.article) }))
    .filter((x) => x.sug.lots > 0)
    .sort((a, b) => b.sug.lots - a.sug.lots)
    .slice(0, 6);
  if (!items.length) {
    wrap.innerHTML = `<p class="muted" style="margin:0;font-size:0.85rem">Aucune suggestion (stock deja au-dessus de 2× le seuil ou pas de lot casier). Le parc est equilibre.</p>`;
    return;
  }
  wrap.innerHTML = `<p class="muted" style="margin:0 0 8px;font-size:0.82rem">Suggestions de reapprovisionnement : cible <strong>2× le seuil minimum</strong> (bouteilles). Le detail du calcul s’affiche sous chaque ligne.</p>` +
    items.map(({ item, sug }) => `<article class="list-item">
      <div style="min-width:0">
        <p class="list-item-title">${escapeHtml(item.article)}</p>
        <p class="list-item-sub">Stock: ${fmt(stockActuel(item))} btl · Seuil: ${fmt(item.seuilMin || 0)} · ${fmt(caseSize(item))} btl/${escapeHtml(lotLabel(item))}</p>
        <p class="muted" style="margin:4px 0 0;font-size:0.76rem;line-height:1.35">${sug.detail ? escapeHtml(sug.detail) : ""}</p>
      </div>
      <div class="list-side">
        <div>
          <p class="list-item-amount" style="color:#ffcf79">${fmt(sug.lots)} ${escapeHtml(lotLabel(item))}(s)</p>
          <p class="list-item-date">${fmt(sug.manque)} btl manquantes</p>
        </div>
        <button type="button" class="mini-btn" data-propose-purchase="${item.id}">Proposer commande</button>
      </div>
    </article>`).join("");
}

function suggestReapproLots(article) {
  const item = stockItemForArticle(article);
  if (!item) return { manque: 0, lots: 0, detail: "" };
  if (lotType(item) === "unite") return { manque: 0, lots: 0, detail: "" };
  const stock = stockActuel(item);
  const seuil = Math.max(0, Number(item.seuilMin) || 0);
  const target = seuil * 2;
  const manque = Math.max(0, target - stock);
  const cs = Math.max(1, caseSize(item));
  const detail = seuil > 0
    ? `Calcul : cible ${fmt(target)} btl (2 x seuil ${fmt(seuil)}) - stock ${fmt(stock)} = ${fmt(manque)} btl a couvrir ; lots arrondis au casier de ${fmt(cs)} btl.`
    : "";
  return { manque, lots: Math.ceil(manque / cs), detail };
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
  return stock.filter((item) => isStockBelowArticleSeuilForAlert(stockActuel(item), item.seuilMin));
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

/** Ajoute ou fusionne une ligne au brouillon achat depuis une ligne stock. Retourne false si prix fournisseur absent. */
function mergePurchaseDraftLineForStockItem(item) {
  const { cases, caseSize: cs } = suggestPurchaseCases(item);
  const price = supplierPriceForArticle(item.article);
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
    syncPurchaseLineInputsFromStock();
    return;
  }
  const { cases, caseSize: cs } = suggestPurchaseCases(item);
  renderPurchaseDraft();
  document.getElementById("purchase-article").value = item.article;
  document.getElementById("purchase-cases").value = String(cases);
  document.getElementById("purchase-case-size").value = String(cs);
  syncPurchasePriceInput();
  syncPurchaseLineInputsFromStock();
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
          ${invoice.lignes.map((vente) => `<div class="order-line"><div><p class="list-item-title">${escapeHtml(vente.article)}</p><p class="list-item-sub">${escapeHtml(vente.cat)} · ${escapeHtml(lineQtyPriceLabel(vente, stockItemForArticle(vente.article)))}${vente.remise ? ` · -${fmt(vente.remise)}` : ""}</p></div><button class="del-btn" type="button" data-delete-type="vente" data-id="${vente.id}">Suppr.</button></div>`).join("")}
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

function paidOrdersFromSales() {
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
  return Object.values(paidByFacture);
}

function managementOrders() {
  return [...recordsForSite(state.commandes), ...paidOrdersFromSales()];
}

function openOrderDetailModal(orderKey) {
  const order = managementOrders().find((item) => String(item.id) === String(orderKey) || String(item.factureNumber || "") === String(orderKey));
  if (!order) {
    showToast("Commande introuvable.");
    return;
  }
  const title = document.getElementById("order-detail-title");
  const body = document.getElementById("order-detail-body");
  if (!body) return;
  const total = orderTotal(order);
  const invoiceNumber = order.factureNumber || String(order.id);
  if (title) title.textContent = `Detail ${invoiceNumber}`;
  const paymentRows = order._isPaid
    ? Object.entries(paymentTotals(order.lignes || []))
      .map(([method, amount]) => `<div><dt>${escapeHtml(method)}</dt><dd>${fmt(amount)} FCFA</dd></div>`)
      .join("")
    : `<div><dt>Paiement</dt><dd>${escapeHtml((order.lignes || [])[0]?.paiement || "-")}</dd></div>`;
  const lineRows = (order.lignes || []).map((line) => `
    <tr>
      <td>${escapeHtml(line.article)}</td>
      <td>${escapeHtml(line.cat || "-")}</td>
      <td>${escapeHtml(lineQtyLabel(line, stockItemForArticle(line.article)))}</td>
      <td style="text-align:right">${fmt(line.prix || 0)} FCFA</td>
      <td style="text-align:right">${fmt(line.remise || 0)} FCFA</td>
      <td style="text-align:right">${fmt(calcNet(line))} FCFA</td>
    </tr>
  `).join("");
  body.innerHTML = `
    <dl class="audit-detail-dl">
      <div><dt>Numero</dt><dd>${escapeHtml(invoiceNumber)}</dd></div>
      <div><dt>Date</dt><dd>${escapeHtml(formatDateDdMmYyyy(order.date))}</dd></div>
      <div><dt>Heure</dt><dd>${escapeHtml(orderTime(order))}</dd></div>
      <div><dt>Statut</dt><dd>${escapeHtml(orderStatus(order))}</dd></div>
      <div><dt>Table / client</dt><dd>${escapeHtml(order.table || order.client || "Comptoir")}</dd></div>
      <div><dt>Serveur</dt><dd>${escapeHtml(order.server || order.serveur || "-")}</dd></div>
      <div><dt>Type</dt><dd>${orderType(order) === "a-emporter" ? "A emporter" : "Sur place"}</dd></div>
      <div><dt>Total</dt><dd><strong>${fmt(total)} FCFA</strong></dd></div>
      ${paymentRows}
    </dl>
    <div class="stock-table-wrap" style="margin-top:14px">
      <table class="stock-table">
        <thead><tr><th>Article</th><th>Categorie</th><th>Quantite</th><th style="text-align:right">Prix</th><th style="text-align:right">Remise</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${lineRows || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:24px">Aucun article</td></tr>`}</tbody>
      </table>
    </div>
    <div class="order-actions" style="margin-top:14px">
      ${order._isPaid && order.factureNumber ? `<button type="button" class="mini-btn" data-print-invoice="${escapeHtml(order.factureNumber)}">Imprimer facture</button>` : `<button type="button" class="mini-btn" data-print-order="${escapeHtml(order.id)}">Ticket</button>`}
    </div>
  `;
  openModal("modal-order-detail");
}

function renderOrdersManagement() {
  const date = document.getElementById("orders-filter-date")?.value || pdjCalendarDate();
  const status = document.getElementById("orders-filter-status")?.value || "all";
  const type = document.getElementById("orders-filter-type")?.value || "all";
  const activeOrders = recordsForSite(state.commandes);
  const salesToday = recordsForSite(state.ventes).filter((vente) => saleDateValue(vente) === date);

  const paidOrders = paidOrdersFromSales();

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
      const encBlocked = next === "Encaisser" && journalEncaisseDisabledForOrder(order);
      const encTitle = encBlocked ? escapeHtml(journalEncaisseBlockTitle(order)) : "";
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
          <button type="button" class="mini-btn" data-order-details="${escapeHtml(order.id)}">Details</button>
          ${order._isPaid ? "" : `<button type="button" class="mini-btn" data-activate-order="${order.id}">Ouvrir</button>`}
          ${next && !(next === "Encaisser" && encBlocked) ? `<button type="button" class="mini-btn" data-advance-order="${order.id}">${escapeHtml(next)}</button>` : ""}
          ${encBlocked ? `<button type="button" class="mini-btn" disabled title="${encTitle}">Encaisser</button>` : ""}
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
      const encBlocked = next === "Encaisser" && journalEncaisseDisabledForOrder(order);
      const encTitle = encBlocked ? escapeHtml(journalEncaisseBlockTitle(order)) : "";
      const nextAction = next === "Encaisser" && encBlocked
        ? `<button type="button" class="mini-btn" disabled title="${encTitle}">Encaisser</button>`
        : next === "Encaisser"
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
          ${order.lignes.length ? order.lignes.map((line) => `<div class="order-line"><div><p class="list-item-title">${escapeHtml(line.article)}</p><p class="list-item-sub">${escapeHtml(line.cat)} · ${escapeHtml(lineQtyPriceLabel(line, stockItemForArticle(line.article)))}${line.remise ? ` · -${fmt(line.remise)}` : ""} · ${escapeHtml(line.paiement)}</p></div><div class="line-actions"><button type="button" class="mini-btn" data-edit-line="${line.id}" data-order-id="${order.id}">Modifier</button><button type="button" class="mini-btn" data-replace-line="${line.id}" data-order-id="${order.id}">Remplacer</button><button type="button" class="mini-btn" data-remove-line="${line.id}" data-order-id="${order.id}">Retirer</button></div></div>`).join("") : emptyState("Commande vide", "Ajoutez une premiere boisson a cette commande.")}
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

// ─── SAISIE RAPIDE (menu multi-articles pour serveuse) ────────────────────────

let srCart = []; // [{ article, cat, prix, packSize, qty, location }]

function srCurrentLoc() {
  return document.getElementById("sr-location")?.value || "Intérieur";
}

function srCartQtyForLoc(article, packSize, location) {
  return (srCart.find((c) => c.article === article && c.packSize === packSize && c.location === location) || {}).qty || 0;
}

function srCartQtyTotal(article, packSize) {
  return srCart.filter((c) => c.article === article && c.packSize === packSize).reduce((s, c) => s + c.qty, 0);
}

function srUpdateQty(article, packSize, delta) {
  const location = srCurrentLoc();
  const product = findKnownProduct(article);
  if (!product) return;
  const format = (product.formatsVente || []).find((f) => Number(f.quantite) === Number(packSize)) || null;
  const prix = formatPrice(format || { prixInterieur: product.prixInt, prixExterieur: product.prixExt }, location);
  const idx = srCart.findIndex((c) => c.article === article && c.packSize === packSize && c.location === location);
  const current = idx >= 0 ? srCart[idx].qty : 0;
  const next = Math.max(0, current + delta);
  if (next === 0 && idx >= 0) srCart.splice(idx, 1);
  else if (next > 0 && idx >= 0) srCart[idx].qty = next;
  else if (next > 0) srCart.push({ article, cat: product.cat || "Autres", prix, packSize: Number(packSize), qty: next, location });
  renderSrMenu(document.getElementById("sr-search")?.value || "");
  renderSrCart();
}

function srSetQty(article, packSize, newQty) {
  const location = srCurrentLoc();
  const product = findKnownProduct(article);
  if (!product) return;
  const format = (product.formatsVente || []).find((f) => Number(f.quantite) === Number(packSize)) || null;
  const prix = formatPrice(format || { prixInterieur: product.prixInt, prixExterieur: product.prixExt }, location);
  const qty = Math.max(0, Math.floor(Number(newQty) || 0));
  const idx = srCart.findIndex((c) => c.article === article && c.packSize === packSize && c.location === location);
  if (qty === 0 && idx >= 0) srCart.splice(idx, 1);
  else if (qty > 0 && idx >= 0) srCart[idx].qty = qty;
  else if (qty > 0) srCart.push({ article, cat: product.cat || "Autres", prix, packSize: Number(packSize), qty, location });
  renderSrMenu(document.getElementById("sr-search")?.value || "");
  renderSrCart();
}

function srItemCard(item, loc) {
  const format = item._srFormat || primarySaleFormat(item);
  const packSz = Math.max(1, Number(format?.quantite) || Number(item.packSize) || 1);
  const prix = formatPrice(format || { prixInterieur: Number(item.prixVenteInt) || 0, prixExterieur: Number(item.prixVenteExt) || 0 }, loc);
  const qtyLoc = srCartQtyForLoc(item.article, packSz, loc);
  const qtyOther = srCartQtyTotal(item.article, packSz) - qtyLoc;
  const stock = stockActuel(item);
  const hasQty = qtyLoc > 0;
  const otherLabel = loc.startsWith("Ext") ? "Cave" : "Terr.";
  const artEsc = escapeHtml(item.article);
  const border = hasQty ? "border:1px solid #2196f3;" : "border:1px solid #e0e0e0;";
  const bg = hasQty ? "background:#e3f2fd;" : "background:#fafafa;";
  let html = "<div style='display:flex;align-items:center;justify-content:space-between;padding:10px 12px;" + bg + border + "border-radius:10px;margin-bottom:6px;gap:10px'>";
  html += "<div style='flex:1;min-width:0;overflow:hidden'>";
  const formatBadge = saleFormatLabel(format);
  const badgeStyle = packSz > 1 ? "background:#fff3e0;color:#e65100" : "background:#e8f5e9;color:#2e7d32";
  html += "<p style='margin:0 0 2px;font-size:0.92rem;font-weight:600;color:#212121;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'>" + artEsc + " <small style='" + badgeStyle + ";border-radius:3px;padding:1px 4px;font-size:0.7rem'>" + escapeHtml(formatBadge) + "</small></p>";
  html += "<p style='margin:0;font-size:0.78rem;color:#757575'>" + fmt(prix) + " FCFA · Stock : " + fmt(stock) + (qtyOther > 0 ? " · <b style='color:#1976d2'>" + otherLabel + " x" + qtyOther + "</b>" : "") + "</p>";
  html += "</div>";
  html += "<div style='display:flex;align-items:center;gap:5px;flex-shrink:0'>";
  if (hasQty) {
    html += "<button type='button' class='sr-dec' data-sr-article='" + artEsc + "' data-sr-pack='" + packSz + "' style='width:30px;height:30px;border-radius:50%;border:1px solid #bdbdbd;background:#fff;font-size:1.1rem;cursor:pointer;color:#212121'>−</button>";
    html += "<input type='number' min='0' value='" + qtyLoc + "' class='sr-qty-input' data-sr-article='" + artEsc + "' data-sr-pack='" + packSz + "' style='width:44px;text-align:center;font-weight:700;font-size:0.95rem;border:1px solid #90caf9;border-radius:6px;padding:2px 4px;color:#1976d2;background:#e3f2fd'>";
  }
  html += "<button type='button' class='sr-inc' data-sr-article='" + artEsc + "' data-sr-pack='" + packSz + "' style='width:30px;height:30px;border-radius:50%;border:none;background:#1976d2;color:#fff;font-size:1.2rem;cursor:pointer;font-weight:700'>+</button>";
  html += "</div></div>";
  return html;
}

function renderSrMenu(query) {
  const container = document.getElementById("sr-menu");
  if (!container) return;
  const q = (query || "").toLowerCase().trim();
  const products = recordsForSite(state.stock)
    .filter((item) => stockActuel(item) > 0)
    .filter((item) => !q || item.article.toLowerCase().includes(q) || (item.cat || "").toLowerCase().includes(q))
    .slice().sort((a, b) => (a.cat || "").localeCompare(b.cat || "", "fr") || a.article.localeCompare(b.article, "fr"));

  if (!products.length) {
    container.innerHTML = "<p style='text-align:center;padding:20px;color:#757575'>Aucun produit disponible.</p>";
    return;
  }
  const loc = srCurrentLoc();
  const byCategory = {};
  products.forEach((item) => {
    const cat = item.cat || "Autres";
    if (!byCategory[cat]) byCategory[cat] = [];
    const formats = normalizeSaleFormats(item).filter((format) => formatPrice(format, loc) > 0);
    (formats.length ? formats : [primarySaleFormat(item)]).filter(Boolean).forEach((format) => {
      byCategory[cat].push({ ...item, _srFormat: format });
    });
  });

  let html = "";
  Object.entries(byCategory).forEach(([cat, items]) => {
    html += "<div style='margin-bottom:14px'>";
    html += "<p style='font-size:0.7rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#9e9e9e;margin:0 0 6px 2px'>" + escapeHtml(cat) + "</p>";
    items.forEach((item) => { html += srItemCard(item, loc); });
    html += "</div>";
  });
  container.innerHTML = html;
}

function renderSrCart() {
  const container = document.getElementById("sr-cart");
  const totalEl = document.getElementById("sr-total");
  if (!container) return;
  const total = srCart.reduce((s, c) => s + c.prix * c.qty, 0);
  if (totalEl) totalEl.textContent = `${fmt(total)} FCFA`;
  if (!srCart.length) {
    container.innerHTML = "<p style='text-align:center;font-size:0.82rem;padding:4px 0;color:#9e9e9e'>Panier vide — ajoutez des produits ci-dessus.</p>";
    return;
  }
  const int = srCart.filter((c) => !c.location.startsWith("Ext"));
  const ext = srCart.filter((c) => c.location.startsWith("Ext"));
  const section = (items, label, color) => {
    if (!items.length) return "";
    const sub = items.reduce((s, c) => s + c.prix * c.qty, 0);
    return `<div style="margin-bottom:10px;padding:10px;border-radius:8px;border:1px solid ${color}22;background:${color}0d">
      <p style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color};margin:0 0 6px">${label}</p>
      ${items.map((c) => `<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;padding:4px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
        <span style="color:var(--mm-text)">${escapeHtml(c.article)}${c.packSize > 1 ? ` ×${c.packSize}` : ""} <span style="color:var(--muted)">× ${c.qty}</span></span>
        <strong style="color:var(--mm-text)">${fmt(c.prix * c.qty)} FCFA</strong>
      </div>`).join("")}
      <div style="display:flex;justify-content:flex-end;font-size:0.8rem;font-weight:600;color:${color};padding-top:5px">Sous-total : ${fmt(sub)} FCFA</div>
    </div>`;
  };
  container.innerHTML =
    section(int, "Cave (Interieur)", "#1976d2") +
    section(ext, "Terrasse (Exterieur)", "#388e3c");
}

function openSaisieRapide() {
  syncDualZonePricingUi();
  srCart = [];
  const searchEl = document.getElementById("sr-search");
  if (searchEl) searchEl.value = "";
  renderSrMenu("");
  renderSrCart();
  openModal("modal-saisie-rapide");
  window.requestAnimationFrame(() => searchEl?.focus());
}

async function submitSaisieRapide() {
  if (!srCart.length) { showToast("Ajoutez au moins un article."); return; }
  const date = pdjCalendarDate();
  if (!assertJournalAllowsSalesOrToast(date, currentSiteId())) return;
  const btn = document.getElementById("sr-submit-btn");
  if (btn) { btn.disabled = true; btn.textContent = "Validation..."; }
  try {
  const clientName = `Saisie rapide · ${sessionUser || "Serveuse"}`;
  const location = document.getElementById("sr-location")?.value || "Intérieur";
  state.nextId = state.nextId || {};
  state.nextId.commande = (Number(state.nextId.commande) || 0) + 1;
  const order = {
    id: state.nextId.commande,
    siteId: currentSiteId(),
    client: clientName,
    date,
    createdAt: new Date().toISOString(),
    status: "Servi",
    type: "sur-place",
    server: sessionUser || "Serveuse",
    note: "",
    lignes: [],
  };
  const errors = [];
  for (const item of srCart) {
    const product = findKnownProduct(item.article);
    if (!product) { errors.push(item.article); continue; }
    const bottles = item.qty * item.packSize;
    const avail = stockAvailabilityForLine(product.article, bottles, order.id, null);
    if (!avail.stockItem || avail.available < bottles) {
      errors.push(`${item.article} (stock insuffisant : ${fmt(avail.available)} btl)`);
      continue;
    }
    state.nextId.ligneCommande = (Number(state.nextId.ligneCommande) || 0) + 1;
    order.lignes.push({
      id: state.nextId.ligneCommande,
      date,
      article: product.article,
      cat: product.cat || "Autres",
      location,
      formatQuantite: item.packSize,
      prix: item.prix,
      qty: item.qty,
      remise: 0,
      paiement: "A regler",
    });
  }
  if (!order.lignes.length) {
    showToast(errors.length ? `Aucune ligne ajoutee : ${errors.join(", ")}` : "Aucune ligne valide.");
    return;
  }
  state.commandes = state.commandes || [];
  state.commandes.unshift(order);
  activeOrderId = order.id;
  await persistState({ commandes: state.commandes, nextId: state.nextId });
  closeModal("modal-saisie-rapide");
  srCart = [];
  renderVentesPage();
  const warn = errors.length ? ` (${errors.length} article(s) ignores : stock insuffisant)` : "";
  showToast(`Commande creee : ${order.lignes.length} article(s) pour ${clientName}.${warn}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Valider la commande"; }
  }
}

function renderVentesPage() {
  syncDualZonePricingUi();
  const gate = document.getElementById("ventes-journal-gate");
  if (gate) {
    if (!PDJ_REQUIRE_CASH_OPENING) {
      gate.classList.add("hidden");
      gate.innerHTML = "";
    } else {
      const d = journalSaleDateFromDom();
      const j = journalAllowsSalesForDate(d, currentSiteId());
      gate.classList.remove("hidden");
      if (j.ok) {
        gate.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;margin-bottom:12px">
          <strong>Journée ouverte</strong> (${escapeHtml(isoDateToDdMmYyyy(d))}) — vous pouvez enregistrer des lignes de commande et encaisser. Clôturez la journée sur le <strong>Point du jour</strong> en fin de service.
        </div>`;
      } else {
        gate.innerHTML = `<div class="inline-card" style="border-left:3px solid #ff8e82;margin-bottom:12px">
          <strong>Ventes indisponibles pour cette date</strong>
          <p class="muted" style="margin:8px 0 0;line-height:1.45">${escapeHtml(j.message)}</p>
          <p class="muted" style="margin:6px 0 0;font-size:0.86rem;line-height:1.45">Ouvrez la journée (ou la suivante si celle-ci est déjà clôturée) depuis la page <strong>Point du jour</strong> — rôle gérant ou administrateur.</p>
        </div>`;
      }
    }
  }
  document.getElementById("articles-list").innerHTML = recordsForSite(state.stock).map((item) => `<option value="${escapeHtml(item.article)}">`).join("");
  if (document.getElementById("modal-vente")?.classList.contains("open")) renderVenteArticlePicker();
  renderOrdersManagement();
  renderQrAlertBadge();
  renderOrders();
  renderSalesHistory();
  renderCreditRecovery();
  renderConsignes();
}

// ─── CONSIGNES ────────────────────────────────────────────────────────────────

const CONSIGNE_STATUT_EN_COURS = "En cours";
const CONSIGNE_STATUT_CONSERVE = "Conservé réutilisation";
const CONSIGNE_STATUT_RENDU = "Rendu";
const CONSIGNE_STATUT_REUTILISE = "Réutilisé";

function consigneStatutBrut(c) {
  const s = String(c?.statut ?? "").trim();
  if (!s) return CONSIGNE_STATUT_EN_COURS;
  return s;
}

function consigneEstEnCoursRetour(c) {
  return consigneStatutBrut(c) === CONSIGNE_STATUT_EN_COURS;
}

function consigneEstConserveReuse(c) {
  return consigneStatutBrut(c) === CONSIGNE_STATUT_CONSERVE;
}

function consigneEstRendu(c) {
  return consigneStatutBrut(c) === CONSIGNE_STATUT_RENDU;
}

function consigneEstReutilise(c) {
  return consigneStatutBrut(c) === CONSIGNE_STATUT_REUTILISE;
}

function consigneLabelStatut(c) {
  if (consigneEstRendu(c)) {
    const dr = formatDateDdMmYyyy(c.dateRetour || "");
    return dr ? `Clôturé (${dr})` : "Clôturé";
  }
  if (consigneEstReutilise(c)) {
    const du = formatDateDdMmYyyy(c.dateReutilisation || "");
    return du ? `Reliquat servi (${du})` : "Reliquat servi";
  }
  if (consigneEstConserveReuse(c)) return "À servir plus tard (déjà payé)";
  return "Bouteille — retour physique attendu";
}

function consigneCouleurStatut(c) {
  if (consigneEstRendu(c)) return "#72d7a9";
  if (consigneEstReutilise(c)) return "var(--muted)";
  if (consigneEstConserveReuse(c)) return "#7ec8e3";
  return "#ffb347";
}

const CONSIGNE_FACTURE_SELECT_LIMIT = 120;

function consigneMergeNoteFacture(noteBase, factureNumber) {
  const ref = String(factureNumber || "").trim();
  const b = String(noteBase || "").trim();
  if (!ref) return b;
  if (b.includes(ref)) return b;
  return b ? `${b} · Fact. ${ref}` : `Fact. ${ref}`;
}

/** Lit les quantités « reliquat » saisies sur les lignes de facture (plusieurs articles possibles). */
function readConsigneFactureReliquatInputs() {
  const tbody = document.getElementById("consigne-facture-lines");
  if (!tbody) return [];
  const out = [];
  let clamped = false;
  tbody.querySelectorAll("input.consigne-facture-reliquat-qty").forEach((inp) => {
    const vente = consigneFindVenteById(inp.dataset.venteId);
    if (!vente) return;
    const si = stockItemForArticle(vente.article);
    const maxB = Math.max(1, lineBottleQty(vente, si));
    let q = Math.floor(Number(inp.value) || 0);
    if (q <= 0) return;
    if (q > maxB) {
      q = maxB;
      clamped = true;
      inp.value = String(maxB);
    }
    out.push({ vente, qty: q });
  });
  if (clamped) showToast("Quantités plafonnées à ce qui a été facturé sur chaque ligne.");
  return out;
}

async function saveConsignesMultiFromFacture(entries) {
  const client = (document.getElementById("consigne-client")?.value || "").trim();
  if (!client) {
    showToast("Saisissez le nom du client.");
    return;
  }
  const date = document.getElementById("consigne-date")?.value || pdjCalendarDate();
  const noteBase = (document.getElementById("consigne-note")?.value || "").trim();
  const reliquatProchaineVisite = Boolean(document.getElementById("consigne-reliquat-prochaine-visite")?.checked);
  const fact0 = String(entries[0]?.vente?.factureNumber || "").trim();
  const note = consigneMergeNoteFacture(noteBase, fact0);

  state.consignes = state.consignes || [];
  state.nextId = state.nextId || {};
  const now = new Date().toISOString();
  const siteId = currentSiteId();
  for (const { vente, qty } of entries) {
    const si = stockItemForArticle(vente.article);
    const maxB = Math.max(1, lineBottleQty(vente, si));
    const q = Math.min(Math.max(1, qty), maxB);
    const montantUnitaire = venteUnitPricePerBottle(vente);
    state.nextId.consigne = (Number(state.nextId.consigne) || 0) + 1;
    const fn = String(vente.factureNumber || "").trim();
    state.consignes.unshift({
      id: state.nextId.consigne,
      siteId,
      date,
      client,
      article: String(vente.article || "").trim(),
      qty: q,
      montantUnitaire,
      total: q * montantUnitaire,
      note,
      statut: reliquatProchaineVisite ? CONSIGNE_STATUT_CONSERVE : CONSIGNE_STATUT_EN_COURS,
      factureNumber: fn || undefined,
      sourceVenteId: Number(vente.id) || vente.id,
      createdBy: sessionUser || "-",
      createdAt: now,
    });
  }
  const localConsignes = [...state.consignes];
  const localNextId = { ...state.nextId };
  await persistState({ consignes: localConsignes, nextId: localNextId });
  if (!state.consignes?.length) state.consignes = localConsignes;
  if (!state.nextId?.consigne) state.nextId = { ...state.nextId, ...localNextId };
  document.getElementById("consigne-form-wrap")?.classList.add("hidden");
  resetConsigneForm();
  renderConsignes();
  showToast(
    `${entries.length} consigne(s) enregistrée(s) — mélange d'articles pour la même facture / client.`,
  );
}

function consigneFindVenteById(id) {
  return (state.ventes || []).find((v) => String(v.id) === String(id));
}

function populateConsigneFactureSelect() {
  const sel = document.getElementById("consigne-facture-select");
  if (!sel) return;
  const prev = sel.value;
  const ts = (o) => String(o.lignes?.[0]?.soldAt || o.lignes?.[0]?.createdAt || o.createdAt || `${o.date || ""}T23:59:59`);
  const orders = paidOrdersFromSales()
    .slice()
    .sort((a, b) => ts(b).localeCompare(ts(a)))
    .slice(0, CONSIGNE_FACTURE_SELECT_LIMIT);
  const opts = [`<option value="">— Saisie manuelle (sans facture) —</option>`];
  for (const o of orders) {
    const idVal = escapeHtml(String(o.id));
    const num = escapeHtml(String(o.factureNumber || o.id));
    const cli = escapeHtml(String(o.client || o.table || "Client").slice(0, 44));
    const d = escapeHtml(formatDateDdMmYyyy(o.date));
    const tot = fmt(orderTotal(o));
    opts.push(`<option value="${idVal}">${num} · ${cli} · ${d} · ${tot} FCFA</option>`);
  }
  sel.innerHTML = opts.join("");
  if (prev && orders.some((o) => String(o.id) === prev)) sel.value = prev;
  else sel.value = "";
}

function renderConsigneFactureLinesForOrder(orderId) {
  const wrap = document.getElementById("consigne-facture-lines-wrap");
  const tbody = document.getElementById("consigne-facture-lines");
  if (!wrap || !tbody) return;
  if (!orderId) {
    wrap.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  const order = paidOrdersFromSales().find((o) => String(o.id) === String(orderId));
  if (!order?.lignes?.length) {
    wrap.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  wrap.classList.remove("hidden");
  tbody.innerHTML = order.lignes.map((vente) => {
    const si = stockItemForArticle(vente.article);
    const qtyLab = escapeHtml(lineQtyLabel(vente, si));
    const unit = venteUnitPricePerBottle(vente);
    const net = fmt(calcNet(vente));
    const maxB = Math.max(1, lineBottleQty(vente, si));
    const vid = String(vente.id);
    return `<tr>
      <td>${escapeHtml(vente.article || "-")}</td>
      <td>${qtyLab}</td>
      <td style="text-align:right">${fmt(unit)} FCFA</td>
      <td style="text-align:right">${net} FCFA</td>
      <td style="text-align:center">
        <input type="number" class="consigne-facture-reliquat-qty" data-vente-id="${escapeHtml(vid)}" min="0" max="${maxB}" value="0" style="width:3.25rem;text-align:center;padding:4px 2px" title="Bouteilles laissées pour ce produit">
      </td>
      <td style="white-space:nowrap"><button type="button" class="mini-btn" data-pick-vente-line="${escapeHtml(vid)}" title="Ajouter 1 bouteille à cette ligne">+1</button></td>
    </tr>`;
  }).join("");
}

function onConsigneFactureSelectChange() {
  const sel = document.getElementById("consigne-facture-select");
  const hid = document.getElementById("consigne-source-vente-id");
  if (hid) hid.value = "";
  renderConsigneFactureLinesForOrder(sel?.value || "");
}

function applyVenteLineToConsigneForm(venteId) {
  const vente = consigneFindVenteById(venteId);
  if (!vente) {
    showToast("Ligne de facture introuvable.");
    return;
  }
  const tbody = document.getElementById("consigne-facture-lines");
  const inp = tbody?.querySelector(`input.consigne-facture-reliquat-qty[data-vente-id="${String(vente.id)}"]`);
  if (!inp) {
    showToast("Sélectionnez d'abord la facture dans la liste.");
    return;
  }
  const maxB = Math.max(1, Number(inp.max) || 1);
  const cur = Math.floor(Number(inp.value) || 0);
  inp.value = String(Math.min(maxB, cur + 1));
  const hid = document.getElementById("consigne-source-vente-id");
  if (hid) hid.value = "";
  const cli = document.getElementById("consigne-client");
  if (cli && !String(cli.value || "").trim()) cli.value = String(vente.client || vente.table || "").trim();
  const dEl = document.getElementById("consigne-date");
  if (dEl && vente.date) dEl.value = saleDateValue(vente);
  const noteEl = document.getElementById("consigne-note");
  const ref = String(vente.factureNumber || "").trim();
  if (noteEl && ref) {
    const curN = String(noteEl.value || "");
    if (!curN.includes(ref)) noteEl.value = curN.trim() ? `${curN.trim()} · Fact. ${ref}` : `Fact. ${ref}`;
  }
  inp.focus();
  if (typeof inp.select === "function") inp.select();
  showToast("Ajoutez des quantités sur d'autres lignes si besoin, puis Enregistrer.");
}

function consignesForSite() {
  return (state.consignes || []).filter((c) => c.siteId === currentSiteId());
}

function renderConsignes() {
  const list = document.getElementById("consigne-list");
  if (!list) return;
  const all = consignesForSite().slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const nbEnCoursRetour = all.filter(consigneEstEnCoursRetour).length;
  const nbConserves = all.filter(consigneEstConserveReuse).length;
  const rendues = all.filter(consigneEstRendu);
  const montantARestituer = all
    .filter(consigneEstEnCoursRetour)
    .reduce((s, c) => s + (Number(c.total) || 0), 0);
  const kpiE = document.getElementById("consigne-kpi-encours");
  const kpiC = document.getElementById("consigne-kpi-conserve");
  const kpiR = document.getElementById("consigne-kpi-rendues");
  const kpiM = document.getElementById("consigne-kpi-montant");
  if (kpiE) kpiE.textContent = String(nbEnCoursRetour);
  if (kpiC) kpiC.textContent = String(nbConserves);
  if (kpiR) kpiR.textContent = String(rendues.length);
  if (kpiM) kpiM.textContent = `${fmt(montantARestituer)} FCFA`;
  list.innerHTML = all.length
    ? all.map((c) => {
      const actions = [];
      if (consigneEstEnCoursRetour(c)) {
        actions.push(`<button class="mini-btn" data-return-consigne="${c.id}">Bouteille rendue</button>`);
        actions.push(`<button class="mini-btn" data-conserve-consigne="${c.id}">Reliquat payé (prochaine visite)</button>`);
      } else if (consigneEstConserveReuse(c)) {
        actions.push(`<button class="mini-btn" data-return-consigne="${c.id}">Remboursé / annulé</button>`);
        actions.push(`<button class="mini-btn" data-reutilise-consigne="${c.id}">Reliquat servi</button>`);
      }
      actions.push(`<button class="mini-btn" data-delete-consigne="${c.id}">Suppr.</button>`);
      const fac = c.factureNumber ? ` <span class="muted" style="font-size:0.78rem">(${escapeHtml(c.factureNumber)})</span>` : "";
      return `<tr>
        <td>${escapeHtml(formatDateDdMmYyyy(c.date))}${fac}</td>
        <td>${escapeHtml(c.client || "-")}</td>
        <td>${escapeHtml(c.article || "-")}</td>
        <td style="text-align:right">${fmt(c.qty)}</td>
        <td style="text-align:right">${fmt(c.montantUnitaire)} FCFA</td>
        <td style="text-align:right"><strong>${fmt(c.total)} FCFA</strong></td>
        <td><span style="color:${consigneCouleurStatut(c)}">${escapeHtml(consigneLabelStatut(c))}</span></td>
        <td>${actions.join(" ")}</td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:32px">Aucune consigne enregistree</td></tr>`;
}

async function saveConsigne() {
  const multi = readConsigneFactureReliquatInputs();
  if (multi.length) {
    await saveConsignesMultiFromFacture(multi);
    return;
  }

  const client = (document.getElementById("consigne-client")?.value || "").trim();
  const article = (document.getElementById("consigne-article")?.value || "").trim();
  const qty = Math.max(1, Number(document.getElementById("consigne-qty")?.value) || 1);
  const montantUnitaire = Math.max(0, Number(document.getElementById("consigne-montant")?.value) || 0);
  const date = document.getElementById("consigne-date")?.value || pdjCalendarDate();
  const note = (document.getElementById("consigne-note")?.value || "").trim();
  const reliquatProchaineVisite = Boolean(document.getElementById("consigne-reliquat-prochaine-visite")?.checked);
  const sourceVenteRaw = String(document.getElementById("consigne-source-vente-id")?.value || "").trim();
  const sourceVente = sourceVenteRaw ? consigneFindVenteById(sourceVenteRaw) : null;
  const factureRef = String(sourceVente?.factureNumber || "").trim();
  if (!article) { showToast("Saisissez l'article ou la boisson (ex. bière)."); return; }
  if (!client) { showToast("Saisissez le nom du client."); return; }
  state.consignes = state.consignes || [];
  state.nextId = state.nextId || {};
  state.nextId.consigne = (Number(state.nextId.consigne) || 0) + 1;
  const sourceVenteId = sourceVenteRaw && sourceVente ? (Number(sourceVente.id) || sourceVente.id) : undefined;
  state.consignes.unshift({
    id: state.nextId.consigne,
    siteId: currentSiteId(),
    date,
    client,
    article,
    qty,
    montantUnitaire,
    total: qty * montantUnitaire,
    note,
    statut: reliquatProchaineVisite ? CONSIGNE_STATUT_CONSERVE : CONSIGNE_STATUT_EN_COURS,
    factureNumber: factureRef || undefined,
    sourceVenteId,
    createdBy: sessionUser || "-",
    createdAt: new Date().toISOString(),
  });
  const localConsignes = [...state.consignes];
  const localNextId = { ...state.nextId };
  await persistState({ consignes: localConsignes, nextId: localNextId });
  if (!state.consignes?.length) state.consignes = localConsignes;
  if (!state.nextId?.consigne) state.nextId = { ...state.nextId, ...localNextId };
  document.getElementById("consigne-form-wrap")?.classList.add("hidden");
  resetConsigneForm();
  renderConsignes();
  showToast(
    reliquatProchaineVisite
      ? "Reliquat enregistré : le client pourra consommer le reste à une prochaine visite."
      : "Consigne bouteille (dépôt) enregistrée — retour physique à suivre.",
  );
}

async function returnConsigne(id) {
  const c = (state.consignes || []).find((x) => x.id === Number(id) || x.id === id);
  if (!c) return;
  const etaitReliquat = consigneEstConserveReuse(c);
  c.statut = CONSIGNE_STATUT_RENDU;
  c.dateRetour = pdjCalendarDate();
  await persistState({ consignes: state.consignes });
  renderConsignes();
  showToast(
    etaitReliquat
      ? `Ligne clôturée pour ${c.client} (remboursement, annulation ou autre).`
      : `Bouteille / dépôt marqué rendu pour ${c.client}.`,
  );
}

async function conserveConsignePourReuse(id) {
  const c = (state.consignes || []).find((x) => x.id === Number(id) || x.id === id);
  if (!c || !consigneEstEnCoursRetour(c)) return;
  c.statut = CONSIGNE_STATUT_CONSERVE;
  await persistState({ consignes: state.consignes });
  renderConsignes();
  showToast("Passage en reliquat : quantité à honorer quand le client revient.");
}

async function reutiliseConsigne(id) {
  const c = (state.consignes || []).find((x) => x.id === Number(id) || x.id === id);
  if (!c || !consigneEstConserveReuse(c)) return;
  c.statut = CONSIGNE_STATUT_REUTILISE;
  c.dateReutilisation = pdjCalendarDate();
  await persistState({ consignes: state.consignes });
  renderConsignes();
  showToast("Reliquat servi : la quantité due a été consommée (ou servie) lors d'une visite ultérieure.");
}

async function deleteConsigne(id) {
  state.consignes = (state.consignes || []).filter((c) => c.id !== Number(id) && c.id !== id);
  await persistState({ consignes: state.consignes });
  renderConsignes();
}

function resetConsigneForm() {
  const hid = document.getElementById("consigne-source-vente-id");
  if (hid) hid.value = "";
  const sel = document.getElementById("consigne-facture-select");
  if (sel) sel.value = "";
  renderConsigneFactureLinesForOrder("");
  ["consigne-client", "consigne-article", "consigne-note"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
  const qtyEl = document.getElementById("consigne-qty");
  if (qtyEl) {
    qtyEl.value = "1";
    qtyEl.removeAttribute("max");
  }
  const mEl = document.getElementById("consigne-montant");
  if (mEl) mEl.value = "";
  const dEl = document.getElementById("consigne-date");
  if (dEl) dEl.value = pdjCalendarDate();
  const reliquatEl = document.getElementById("consigne-reliquat-prochaine-visite");
  if (reliquatEl) reliquatEl.checked = true;
  populateConsigneFactureSelect();
}

// ─── KIT (sélection multi-produits même prix) ─────────────────────────────────

function renderKitProducts() {
  const price = Number(document.getElementById("kit-price")?.value) || 0;
  const location = document.getElementById("kit-location")?.value || "Intérieur";
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const container = document.getElementById("kit-products-list");
  const info = document.getElementById("kit-count-info");
  if (!container) return;
  if (price <= 0) {
    container.innerHTML = "";
    if (info) info.textContent = "Saisissez un prix pour voir les produits disponibles.";
    return;
  }
  const products = knownProducts().filter((p) => {
    const pInt = Number(p.prixInt) || Number(p.prix) || 0;
    const pExt = Number(p.prixExt) || pInt;
    const unitPrice = String(location).startsWith("Ext") ? pExt : pInt;
    return unitPrice === price;
  });
  if (!products.length) {
    container.innerHTML = `<p class="muted" style="font-size:0.85rem">Aucun produit a ce prix.</p>`;
    if (info) info.textContent = "";
    return;
  }
  const checked = container.querySelectorAll("input[type=checkbox]:checked");
  const checkedArticles = new Set([...checked].map((cb) => cb.value));
  container.innerHTML = products.map((p) => {
    const id = `kit-cb-${p.article.replace(/\s+/g, "-")}`;
    const isChecked = checkedArticles.has(p.article) ? "checked" : "";
    return `<label style="display:flex;align-items:center;gap:6px;background:var(--card-bg,#1e1e2e);border:1px solid var(--border);border-radius:6px;padding:6px 10px;cursor:pointer;font-size:0.85rem">
      <input type="checkbox" id="${escapeHtml(id)}" class="kit-cb" value="${escapeHtml(p.article)}" ${isChecked}>
      ${escapeHtml(p.article)}
    </label>`;
  }).join("");
  updateKitCountInfo();
}

function updateKitCountInfo() {
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const checked = document.querySelectorAll("#kit-products-list .kit-cb:checked").length;
  const info = document.getElementById("kit-count-info");
  if (info) info.textContent = `${checked} / ${size} produit(s) selectionne(s)`;
  // disable extra checkboxes when full
  document.querySelectorAll("#kit-products-list .kit-cb").forEach((cb) => {
    cb.disabled = !cb.checked && checked >= size;
  });
}

async function confirmKit() {
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const price = Number(document.getElementById("kit-price")?.value) || 0;
  const location = document.getElementById("kit-location")?.value || "Intérieur";
  const checked = [...document.querySelectorAll("#kit-products-list .kit-cb:checked")].map((cb) => cb.value);
  if (!checked.length) { showToast("Selectionnez au moins un produit."); return; }
  if (price <= 0) { showToast("Saisissez le prix unitaire."); return; }
  const clientName = (document.getElementById("v-client")?.value || "").trim();
  const date = document.getElementById("v-date")?.value || pdjCalendarDate();
  const note = document.getElementById("v-note")?.value || "";
  let anyAdded = false;
  for (const article of checked) {
    const product = findKnownProduct(article);
    if (!product) continue;
    const packSize = Math.max(1, Number(product.packSize) || 1);
    const availability = stockAvailabilityForLine(product.article, packSize, activeOrderId, null);
    if (!availability.stockItem || availability.available < packSize) {
      showToast(`Stock insuffisant : ${product.article}`);
      continue;
    }
    const order = ensureOrder(clientName, date, note);
    state.nextId = state.nextId || {};
    state.nextId.ligneCommande = (Number(state.nextId.ligneCommande) || 0) + 1;
    order.lignes.push({
      id: state.nextId.ligneCommande,
      date,
      article: product.article,
      cat: product.cat || "Autres",
      location,
      formatQuantite: packSize,
      prix: price,
      qty: 1,
      remise: 0,
      paiement: "A regler",
    });
    anyAdded = true;
  }
  if (!anyAdded) { showToast("Aucun article n'a pu etre ajoute."); return; }
  await persistState({ commandes: state.commandes, nextId: state.nextId });
  document.getElementById("kit-mode-details")?.removeAttribute("open");
  renderVentesPage();
  showToast(`Kit de ${checked.length} produit(s) ajoute.`);
}

// ─── REMPLACEMENT D'ARTICLE ───────────────────────────────────────────────────

let replacingLine = null; // { orderId, lineId, article }
let replaceSelectedArticle = null;

function openReplaceModal(orderId, lineId) {
  const order = recordsForSite(state.commandes).find((o) => o.id === Number(orderId));
  if (!order) return;
  const line = (order.lignes || []).find((l) => l.id === Number(lineId));
  if (!line) return;
  replacingLine = { orderId: Number(orderId), lineId: Number(lineId), article: line.article };
  replaceSelectedArticle = null;
  const infoEl = document.getElementById("replace-current-info");
  if (infoEl) infoEl.textContent = `Article actuel : ${line.article} · ${lineQtyPriceLabel(line, stockItemForArticle(line.article))}`;
  const searchEl = document.getElementById("replace-search");
  if (searchEl) searchEl.value = "";
  renderReplacePicker("");
  const btn = document.getElementById("confirm-replace-btn");
  if (btn) btn.disabled = true;
  openModal("modal-replace-article");
  window.requestAnimationFrame(() => searchEl?.focus());
}

function renderReplacePicker(query) {
  const picker = document.getElementById("replace-picker");
  if (!picker) return;
  const q = (query || "").toLowerCase().trim();
  const products = knownProducts().filter((p) =>
    !q || p.article.toLowerCase().includes(q) || (p.cat || "").toLowerCase().includes(q)
  ).slice(0, 24);
  picker.innerHTML = products.map((p) => `
    <div class="picker-item${replaceSelectedArticle === p.article ? " selected" : ""}"
      data-pick-replace="${escapeHtml(p.article)}"
      style="cursor:pointer;padding:8px 10px;border-radius:6px;margin-bottom:4px;background:var(--card-bg,#1e1e2e);border:1px solid ${replaceSelectedArticle === p.article ? "var(--accent)" : "var(--border)"}">
      <strong style="font-size:0.9rem">${escapeHtml(p.article)}</strong>
      <span class="muted" style="font-size:0.8rem;margin-left:6px">${fmt(p.prixInt)} FCFA</span>
    </div>`).join("");
}

async function confirmReplace() {
  if (!replacingLine || !replaceSelectedArticle) return;
  const order = recordsForSite(state.commandes).find((o) => o.id === replacingLine.orderId);
  if (!order) return;
  const line = (order.lignes || []).find((l) => l.id === replacingLine.lineId);
  if (!line) return;
  const newProduct = findKnownProduct(replaceSelectedArticle);
  if (!newProduct) { showToast("Produit introuvable."); return; }
  line.article = newProduct.article;
  line.cat = newProduct.cat || line.cat;
  await persistState({ commandes: state.commandes });
  closeModal("modal-replace-article");
  replacingLine = null;
  replaceSelectedArticle = null;
  renderVentesPage();
  showToast("Article remplace.");
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

function qrRows() {
  const alias = document.getElementById("qr-alias").value.trim();
  const dual = siteUsesDualZonePricing();
  return qrTableLabels().map((table) => {
    const intLink = buildQrOrderLink("Intérieur", table, alias || table);
    const extLink = dual ? buildQrOrderLink("Extérieur", table, alias || table) : intLink;
    return { table, alias: alias || table, intLink, extLink };
  });
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
  const dual = siteUsesDualZonePricing();
  const list = document.getElementById("qr-table-list");
  const oldPreview = [...card.children].find((child) => child.classList?.contains("qr-two-cols"));
  if (oldPreview) oldPreview.classList.add("hidden");
  const colsClass = dual ? "qr-two-cols" : "qr-two-cols qr-one-col";
  list.innerHTML = rows.map((row) => `
    <article class="qr-table-card">
      <div class="section-head">
        <div>
          <h3>${escapeHtml(row.table)}</h3>
          <p class="list-item-sub">${escapeHtml(siteName)}</p>
        </div>
        <button type="button" class="mini-btn" data-print-qr-table="${escapeHtml(row.table)}">Imprimer cette table</button>
      </div>
      <div class="${colsClass}">
        <div class="qr-location-card">
          <div class="qr-location-header">${dual ? "Intérieur (cave)" : "Tarif unique"}</div>
          <div class="qr-card-box">
            <img src="https://quickchart.io/qr?size=180&text=${encodeURIComponent(row.intLink)}" alt="QR ${dual ? "Intérieur" : "menu"} ${escapeHtml(row.table)}">
            <div>
              <p class="list-item-title">${escapeHtml(row.table)}${dual ? " - Intérieur" : ""}</p>
              <a class="qr-link" href="${escapeHtml(row.intLink)}" target="_blank" rel="noopener noreferrer">Ouvrir</a>
            </div>
          </div>
        </div>
        ${dual
          ? `<div class="qr-location-card">
          <div class="qr-location-header">Extérieur (terrasse)</div>
          <div class="qr-card-box">
            <img src="https://quickchart.io/qr?size=180&text=${encodeURIComponent(row.extLink)}" alt="QR Extérieur ${escapeHtml(row.table)}">
            <div>
              <p class="list-item-title">${escapeHtml(row.table)} - Extérieur</p>
              <a class="qr-link" href="${escapeHtml(row.extLink)}" target="_blank" rel="noopener noreferrer">Ouvrir</a>
            </div>
          </div>
        </div>`
          : ""}
      </div>
    </article>
  `).join("");
  card.classList.remove("hidden");
}

function printQrCard(location, tableOverride = null, linkOverride = null) {
  if (!currentQrLinkInt) renderQrPreview();
  const table = tableOverride || qrTableLabels()[0] || "Comptoir";
  const dualQr = siteUsesDualZonePricing();
  let link = linkOverride || (dualQr && String(location).startsWith("Ext") ? currentQrLinkExt : currentQrLinkInt);
  if (!dualQr) link = linkOverride || currentQrLinkInt;
  if (!link) { showToast("Impossible de generer le lien QR."); return; }
  const site = currentSite();
  const locationLabel = dualQr ? qrLocationLabel(location) : "Tarif unique";
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
  const dual = siteUsesDualZonePricing();
  const ticketWindow = window.open("", "_blank", "width=1000,height=900");
  if (!ticketWindow) { showToast("Impossible d'ouvrir l'impression."); return; }
  const gridTpl = dual ? "1fr 1fr" : "1fr";
  const cards = rows.map((row) => `
    <section class="table-block">
      <h2>${escapeHtml(siteName)} - ${escapeHtml(row.table)}</h2>
      <div class="grid" style="grid-template-columns:${gridTpl}">
        <div><strong>${dual ? "Intérieur" : "Tarif unique"}</strong><img src="https://quickchart.io/qr?size=260&text=${encodeURIComponent(row.intLink)}" alt="QR menu"></div>
        ${dual ? `<div><strong>Extérieur</strong><img src="https://quickchart.io/qr?size=260&text=${encodeURIComponent(row.extLink)}" alt="QR Extérieur"></div>` : ""}
      </div>
      <p>Scannez pour voir le menu et commander.</p>
    </section>
  `).join("");
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>QR codes tables</title><style>body{font-family:Arial,sans-serif;color:#111;padding:22px}.table-block{break-inside:avoid;page-break-inside:avoid;border:2px solid #111;border-radius:18px;padding:18px;margin:0 0 18px;text-align:center}h2{margin:0 0 14px}.grid{display:grid;gap:18px}img{display:block;width:260px;height:260px;margin:10px auto;background:#fff;padding:8px;border:1px solid #ddd;border-radius:14px}p{margin:8px 0 0}@media print{body{padding:0}.table-block{page-break-inside:avoid}}</style></head><body>${cards}<script>window.onload=function(){window.print();}</script></body></html>`);
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
    const isFrigoLow = isFrigoLowForAlert(frigo, seuilFrigo);
    const seuilArticle = Number(item.seuilMin) || 0;
    const isAlert = isStockBelowArticleSeuilForAlert(actuel, seuilArticle) || isFrigoLow;
    if (isAlert) nbAlerte++; else nbOk++;

    let statusBadge;
    if (actuel <= 0) statusBadge = `<span class="badge badge-red">RUPTURE</span>`;
    else if (isStockBelowArticleSeuilForAlert(actuel, seuilArticle)) statusBadge = `<span class="badge badge-red">CRITIQUE</span>`;
    else if (
      (stockAlertInclusiveSeuil(site) ? actuel <= seuilArticle * 2 : actuel < seuilArticle * 2)
      && seuilArticle > 0
    ) statusBadge = `<span class="badge badge-amber">FAIBLE</span>`;
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
        ${canManage() ? `<button type="button" class="mini-btn" data-edit-stock="${item.id}">Modifier</button>` : ""}
        ${canAnyAdmin() ? `<button class="stock-del-btn" type="button" data-delete-type="stock" data-id="${item.id}">Suppr.</button>` : ""}
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
  if (String(username || "").trim().toLowerCase() === "admin") {
    showToast('Impossible de supprimer le compte "admin" (super administrateur).');
    return;
  }
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

function populatePurgeMaquisSelect() {
  const sel = document.getElementById("purge-maquis-select");
  if (!sel || !canSuperAdmin() || !state) return;
  const sites = state.sites || [];
  const prev = sel.value || "";
  sel.innerHTML = sites.length
    ? sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nom)} (${escapeHtml(s.id)})</option>`).join("")
    : `<option value="">— Aucun maquis —</option>`;
  const cur = currentSiteId();
  if (sites.some((s) => String(s.id) === String(prev))) sel.value = prev;
  else if (sites.some((s) => String(s.id) === String(cur))) sel.value = String(cur);
}

function renderSitesList() {
  const container = document.getElementById("sites-list");
  if (!container) return;
  if (!canSuperAdmin()) {
    container.innerHTML = "";
    populatePurgeMaquisSelect();
    return;
  }
  const sites = state.sites || [];
  if (!sites.length) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:12px 0">Aucun maquis enregistre.</p>`;
    populatePurgeMaquisSelect();
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
  populatePurgeMaquisSelect();
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
  const dualZonePricing = Boolean(document.getElementById("new-site-dual-zone")?.checked);
  const singleBreweryOnly = Boolean(document.getElementById("new-site-single-br-enabled")?.checked);
  const singleBreweryName = String(document.getElementById("new-site-single-br-name")?.value || "").trim();
  if (singleBreweryOnly && !singleBreweryName) { showToast("Saisissez la brasserie unique."); return; }
  const newSite = {
    id: siteId, nom, ville, pays, dualZonePricing, singleBreweryOnly, singleBreweryName,
    stockAlertInclusiveSeuil: false,
  };
  const newSites = [...(state.sites || []), newSite];
  const sitesBefore = state.sites || [];
  const templateSiteId = sitesBefore.some((s) => s.id === "maquis-1") ? "maquis-1" : sitesBefore[0]?.id || "";
  const { newStock, newPrices, nextId } = cloneCatalogRowsForNewSite(templateSiteId, siteId);
  const newUsers = (state.auth?.users || []).map((user) => {
    const currentAllowed = new Set(user.allowedSiteIds || []);
    if (normalizeRoleForUsername(user.username, user.role) === "superadmin") {
      currentAllowed.add(siteId);
    }
    return { ...user, allowedSiteIds: [...currentAllowed] };
  });
  await persistState({
    sites: newSites,
    auth: { users: newUsers },
    stock: [...(state.stock || []), ...newStock],
    supplierPrices: [...(state.supplierPrices || []), ...newPrices],
    nextId,
  });
  allowedSiteIds = canSuperAdmin()
    ? (state.sites || []).map((s) => s.id)
    : [...new Set([...allowedSiteIds, siteId])];
  document.getElementById("new-site-nom").value = "";
  document.getElementById("new-site-id").value = "";
  document.getElementById("new-site-ville").value = "";
  document.getElementById("new-site-pays").value = "";
  const newDualEl = document.getElementById("new-site-dual-zone");
  if (newDualEl) newDualEl.checked = true;
  const newBrEnabled = document.getElementById("new-site-single-br-enabled");
  const newBrName = document.getElementById("new-site-single-br-name");
  if (newBrEnabled) newBrEnabled.checked = false;
  if (newBrName) newBrName.value = "";
  syncSingleBreweryUi();
  renderSitesList();
  renderSiteSwitcher();
  resetUserForm();
  renderUserSiteCheckboxes();
  renderUsersList();
  if (currentPage === "home") renderDashboard();
  if (currentPage === "stock") renderStock();
  const tplName = (state.sites || []).find((s) => s.id === templateSiteId)?.nom || templateSiteId;
  showToast(
    newStock.length
      ? `Maquis "${nom}" cree — ${newStock.length} article(s) catalogue copies depuis "${tplName}" (stocks a zero).`
      : `Maquis "${nom}" cree — aucun article copie (catalogue du maquis modele "${tplName}" vide).`,
  );
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
  const pSmsQr = document.getElementById("p-sms-qr");
  if (pSmsQr) pSmsQr.value = site?.smsQrAlert || "";
  const pSingleEnabled = document.getElementById("p-single-br-enabled");
  const pSingleName = document.getElementById("p-single-br-name");
  if (pSingleEnabled) pSingleEnabled.checked = Boolean(site?.singleBreweryOnly);
  if (pSingleName) {
    populateBrasserieFournisseurSelect(pSingleName, { mode: "catalog", preservedValue: site?.singleBreweryName || "" });
  }
  const dualZonePricingEl = document.getElementById("p-dual-zone-pricing");
  if (dualZonePricingEl) dualZonePricingEl.checked = siteUsesDualZonePricing(site);
  const pStockAlertInclusive = document.getElementById("p-stock-alert-inclusive-seuil");
  if (pStockAlertInclusive) pStockAlertInclusive.checked = Boolean(site?.stockAlertInclusiveSeuil);
  const categoriesField = document.getElementById("p-categories");
  if (categoriesField) {
    const saved = Array.isArray(state?.categories) && state.categories.length ? state.categories : CATEGORIES;
    categoriesField.value = saved.map((cat) => String(cat || "").trim()).filter(Boolean).join("\n");
  }
  syncSingleBreweryUi();
  renderUsersList();
  renderUserSiteCheckboxes();
  renderSitesList();
  refreshRestoreBackupUi().catch(() => {});
  renderStaffAuditLog();
}

function populateOrderSelect() {
  const orders = recordsForSite(state.commandes).map((order) => ({ value: String(order.id), label: order.client || `Commande ${order.id}` }));
  const options = [{ value: "", label: "Nouvelle commande" }, ...orders];
  document.getElementById("v-order-select").innerHTML = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  document.getElementById("v-order-select").value = activeOrderId ? String(activeOrderId) : "";
  syncFinalizeButtonJournalState();
}

function currentOrder() {
  return recordsForSite(state.commandes).find((order) => order.id === activeOrderId) || null;
}

function syncFinalizeButtonJournalState() {
  const btn = document.getElementById("finalize-order-btn");
  if (!btn) return;
  const id = Number(document.getElementById("v-order-select")?.value) || activeOrderId || null;
  const saleD = document.getElementById("v-date")?.value?.trim() || pdjCalendarDate();
  const allow = journalAllowsSalesForDate(saleD, currentSiteId()).ok;
  btn.disabled = !id || !allow;
}

function openOrderEditor(orderId = null, lineId = null) {
  syncDualZonePricingUi();
  activeOrderId = orderId;
  editingLineId = lineId;
  const order = orderId ? recordsForSite(state.commandes).find((item) => item.id === orderId) : null;
  const line = order && lineId ? order.lignes.find((item) => item.id === lineId) : null;
  populateOrderSelect();
  document.getElementById("v-date").value = line?.date || order?.date || pdjCalendarDate();
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
  syncFinalizeButtonJournalState();
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
  document.getElementById("v-date").value = pdjCalendarDate();
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
  syncFinalizeButtonJournalState();
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
  if (!["ventes", "home", "stock"].includes(currentPage)) return;

  if (currentPage === "stock") {
    // Full reload for stock page — delta only returns commandes, not stock/purchases
    try {
      const fresh = await apiRequest(API.state);
      if (fresh) {
        const _casiers = state.casiers ?? [];
        const _casierMouvements = state.casierMouvements ?? [];
        const _nextCasier = state.nextId?.casier;
        const _nextCasierMvt = state.nextId?.casierMouvement;
        state = fresh;
        if (!state.nextId) state.nextId = {};
        if (!state.casiers?.length && _casiers.length) state.casiers = _casiers;
        if (!state.casierMouvements?.length && _casierMouvements.length) state.casierMouvements = _casierMouvements;
        if (!state.nextId.casier && _nextCasier) state.nextId.casier = _nextCasier;
        if (!state.nextId.casierMouvement && _nextCasierMvt) state.nextId.casierMouvement = _nextCasierMvt;
        lsSaveCasiers();
      }
    } catch (e) { return; }
    renderTopbar();
    renderSiteSwitcher();
    renderStock();
    if (stockSubTab === "mouvements") renderStockMovements();
    else if (stockSubTab === "achats") renderPurchaseOrders();
    else if (stockSubTab === "creanciers") renderCreanciers();
    else if (stockSubTab === "casiers") renderCasiers();
    return;
  }

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

/** Liste alignee avec server.py (_SITE_SCOPED_ROW_KEYS) — secours purge maquis via PUT si route POST absente (vieux serveur). */
const PURGE_MAQUIS_ROW_KEYS = [
  "ventes", "stock", "commandes", "stockChecks", "stockEntrees", "stockLosses",
  "dayBooks", "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
  "creditRecoveries", "charges", "staffAuditLog",
];

async function purgeMaquisDataViaStatePut(siteId, keepStockCatalog) {
  if (!canSuperAdmin()) throw new Error("Reserve au super administrateur.");
  const sid = String(siteId || "").trim();
  const keep = (row) => !(row && typeof row === "object" && String(row.siteId || "").trim() === sid);
  const overrides = {};
  PURGE_MAQUIS_ROW_KEYS.forEach((key) => {
    const list = Array.isArray(state[key]) ? state[key] : [];
    if (key === "stock" && keepStockCatalog) {
      overrides.stock = list.map((row) => {
        if (!row || typeof row !== "object" || String(row.siteId || "").trim() !== sid) return row;
        const c = { ...row };
        c.init = 0;
        c.entrees = 0;
        c.sorties = 0;
        c.frigo = 0;
        c.reserve = 0;
        delete c.lastReapproAt;
        delete c.lastReapproBy;
        return c;
      });
      return;
    }
    if (keepStockCatalog && key === "supplierPrices") {
      overrides.supplierPrices = list.slice();
      return;
    }
    overrides[key] = list.filter(keep);
  });
  await persistState(overrides);
}

async function persistState(overrides = {}) {
  const _casiers = overrides.casiers ?? state.casiers ?? [];
  const _casierMouvements = overrides.casierMouvements ?? state.casierMouvements ?? [];
  const _consignes = overrides.consignes ?? state.consignes ?? [];
  const _supplierPrices = overrides.supplierPrices ?? state.supplierPrices ?? [];
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
      supplierPrices: overrides.supplierPrices ?? state.supplierPrices ?? [],
      creditRecoveries: overrides.creditRecoveries || state.creditRecoveries || [],
      consignes: _consignes,
      categories: overrides.categories || state.categories || CATEGORIES,
      charges: overrides.charges || state.charges,
      nextId: overrides.nextId || state.nextId,
      staffAuditLog: overrides.staffAuditLog !== undefined ? overrides.staffAuditLog : (state.staffAuditLog || []),
      auth: overrides.auth || { users: state.auth.users || [] },
      casiers: _casiers,
      casierMouvements: _casierMouvements,
    }),
  });
  // Le serveur peut ne pas renvoyer les nouveaux champs — on les préserve localement
  if (!state.casiers?.length && _casiers.length) state.casiers = _casiers;
  if (!state.casierMouvements?.length && _casierMouvements.length) state.casierMouvements = _casierMouvements;
  if (!state.consignes?.length && _consignes.length) state.consignes = _consignes;
  if (!state.supplierPrices?.length && _supplierPrices.length) state.supplierPrices = _supplierPrices;
  lsSaveCasiers();
  renderTopbar();
}

function renderCreditRecovery() {
  const list = document.getElementById("credit-list");
  if (!list) return;
  const totals = creditTotals();
  const dueMap = creditOutstandingMap();
  const issuerByDebtor = creditIssuerLabelsByDebtor();
  const creditOpenedByDebtor = creditFirstOpenedLabelByDebtor();
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

  const historyHtml = buildCreditRecoveryHistoryHtml();

  if (!entries.length) {
    list.innerHTML = `
      <div class="muted" style="margin-bottom:14px;padding:12px;border:1px solid var(--border);border-radius:8px;font-size:0.92rem">
        <strong>Aucun solde débiteur actif</strong> — soit tous les crédits sont soldés, soit aucune vente n’a été encaissée en « Crédit client » pour ce maquis. Le tableau ci‑dessous liste quand même <strong>tous les versements déjà enregistrés</strong>.
      </div>
      ${historyHtml}`;
    return;
  }

  const rowsHtml = entries.map(([name, amount]) => {
    const installments = byDebtor[name] || [];
    const headRow = `
            <tr class="credit-debtor-summary">
              <td><strong>${escapeHtml(name)}</strong></td>
              <td class="muted" style="font-size:0.9rem">${escapeHtml(issuerByDebtor[name] || "—")}</td>
              <td class="muted" style="font-size:0.9rem;white-space:nowrap">${escapeHtml(creditOpenedByDebtor[name] || "—")}</td>
              <td style="text-align:right"><strong style="color:#ff8e82">${fmt(amount)} FCFA</strong></td>
              <td><button type="button" class="mini-btn" data-credit-fill="${escapeHtml(name)}">Encaisser</button></td>
            </tr>`;
    const instRows = installments.length
      ? [`<tr class="credit-installment-row"><td colspan="5" class="credit-installment-label">Échéances enregistrées (${installments.length})</td></tr>`,
        ...installments.map((p) => `
            <tr class="credit-installment-row">
              <td colspan="3" style="padding-left:1.1rem;font-size:0.88rem">
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
      <p class="eyebrow" style="margin-bottom:8px">Crédits en cours (reste à payer)</p>
      <table class="stock-table" style="min-width:980px">
        <thead><tr>
          <th>Débiteur</th>
          <th>Crédit accordé par</th>
          <th>Prise du crédit</th>
          <th style="text-align:right">Reste à payer</th>
          <th>Action</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    ${historyHtml}
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

function purchaseCataloguePricePerCase(articleName) {
  const product = findKnownProduct(String(articleName || "").trim());
  const prix = Number(product?.prixAchat) || 0;
  return Math.max(0, Math.round(prix));
}

function supplierPriceForArticle(articleName, supplierName = null) {
  const articleKey = String(articleName || "").trim().toLowerCase();
  const raw = supplierName != null ? String(supplierName).trim() : purchaseSupplierRawFromDom();
  const c = purchaseSupplierInputToCanonical(raw);
  const supplierNorm = c === PURCHASE_NO_BRASSERIE_VALUE ? "" : brasserieMatchKey(raw);
  if (articleKey && supplierNorm) {
    const row = recordsForSite(state.supplierPrices || []).find((item) =>
      brasserieMatchKey(item.supplier) === supplierNorm
      && String(item.article || "").trim().toLowerCase() === articleKey
    );
    const supplierPrice = Number(row?.pricePerCase) || 0;
    if (supplierPrice > 0) return Math.max(0, Math.round(supplierPrice));
  }
  return purchaseCataloguePricePerCase(articleName);
}

function syncPurchasePriceInput() {
  const input = document.getElementById("purchase-price");
  if (!input) return;
  const articleDetail = document.getElementById("purchase-article-detail")?.value?.trim() || "";
  const formatVal = document.getElementById("purchase-article")?.value?.trim() || "";
  const brCanon = getPurchaseSupplierCanonical();
  const br = supplierKey(brCanon) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE) ? "" : normalizeBrasserieName(brCanon);
  if (articleDetail) {
    const prix = supplierPriceForArticle(articleDetail, br);
    input.value = prix > 0 ? String(prix) : "";
    return;
  }
  const capMatch = formatVal.match(/^B(\d+)$/);
  if (!capMatch || !br) { input.value = ""; return; }
  const cap = Number(capMatch[1]);
  const firstArticle = recordsForSite(state.stock).find((item) =>
    brasserieMatchKey(item.brasserie) === brasserieMatchKey(br) && (caseSize(item) || 24) === cap
  );
  const prix = firstArticle ? supplierPriceForArticle(firstArticle.article, br) : 0;
  input.value = prix > 0 ? String(prix) : "";
}

function purchasePriceInputValue() {
  return Math.max(0, Math.round(Number(document.getElementById("purchase-price")?.value) || 0));
}

/**
 * Un casier est retournable quand bouteillesVides >= capacite.
 * recomputeCasierStatus garantit que bouteillesVides = cap quand statut devient "vide".
 * Un casier partiel (encore des bouteilles pleines) n'est jamais retournable.
 */
function casierRetournableUnits(c) {
  const cap = Math.max(1, Number(c.capacite) || 24);
  const statut = String(c.statut || "").toLowerCase();
  if (statut === "retourne") return 0;
  const vides = Math.max(0, Number(c.bouteillesVides) || 0);
  return Math.floor(vides / cap);
}

function emptyCasiersCountForArticle(article) {
  if (!article) return 0;
  const stockIt = stockItemForArticle(article);
  const br = normalizeBrasserieName(stockIt?.brasserie || "");
  if (!br) return 0;
  const cap = caseSize(stockIt) || 24;
  return physicallyAvailableEmptyCasiersForPurchaseBr(cap, br);
}

/** Casiers et btl/casier alignés sur la ligne stock + suggestion au seuil (comme depuis « Commander » sur une ligne catalogue). */
function syncPurchaseQtyFromStock() {
  const casesInput = document.getElementById("purchase-cases");
  const caseSizeField = document.getElementById("purchase-case-size");
  if (!casesInput || !caseSizeField) return;
  const formatVal = document.getElementById("purchase-article")?.value?.trim() || "";
  const brRaw = document.getElementById("purchase-supplier")?.value ?? "";
  const brCanon = getPurchaseSupplierCanonical();
  const videsBtn = document.getElementById("purchase-from-vides-btn");
  const videsHint = document.getElementById("purchase-vides-hint");
  const limitHint = document.getElementById("purchase-cases-limit-hint");
  const capMatch = formatVal.match(/^B(\d+)$/);
  if (!capMatch || !String(brRaw ?? "").trim()) {
    casesInput.value = "";
    caseSizeField.value = "24";
    casesInput.removeAttribute("max");
    casesInput.placeholder = "Depuis stock";
    if (videsBtn) videsBtn.style.display = "none";
    if (videsHint) videsHint.style.display = "none";
    if (limitHint) limitHint.style.display = "none";
    return;
  }
  const cap = Number(capMatch[1]);
  caseSizeField.value = String(cap);

  const resolved = primaryPurchaseDraftStockLineForSync();
  const ctx = purchaseContextStockItemsFiltered();
  const ambiguous = ctx.length > 1 && !resolved;

  /** Limiter aux casiers vides seulement si la ligne catalogue exige une consigne brassière (casiers bières). */
  let needReserve = resolved
    ? purchaseLineNeedsConsigneReservation(resolved)
    : ctx.some((it) => purchaseLineNeedsConsigneReservation(it));
  let brGrp = "";
  if (supplierKey(brCanon) !== supplierKey(PURCHASE_NO_BRASSERIE_VALUE)) {
    brGrp = normalizeBrasserieName(String(brCanon).trim());
  } else if (resolved && purchaseLineNeedsConsigneReservation(resolved)) {
    brGrp = normalizeBrasserieName(resolved.brasserie || "");
  }
  if (needReserve) needReserve = Boolean(brGrp) && catalogueHasCasierConsigneForPurchaseBr(brGrp);

  const needArticlePick = ambiguous && ctx.some((it) => purchaseLineNeedsConsigneReservation(it));

  if (!needReserve || needArticlePick) {
    casesInput.removeAttribute("max");
    casesInput.placeholder = "Nombre de lots";
    casesInput.value = "";
    if (videsBtn) videsBtn.style.display = "none";
    if (videsHint) videsHint.style.display = "none";
    if (limitHint) {
      limitHint.style.display = "";
      if (needArticlePick) {
        limitHint.innerHTML =
          `<span class="muted">Casiers retournables : choisissez l'article précis dans la liste si plusieurs formats mélangent casier bière et carton.</span>`;
      } else {
        limitHint.innerHTML =
          `<span class="muted">Pas de plafond consigne brasserie pour ce format : quantité libre (carton / autres).</span>`;
      }
    }
    return;
  }

  const casiersGroupe = casiersForSite().filter((c) =>
    brasserieMatchKey(c.article || "") === brasserieMatchKey(brGrp)
    && Math.max(1, Number(c.capacite) || 24) === cap
    && physicalCasierCountsForPurchaseVides(c),
  );
  let nbPleins = 0, nbPartiels = 0, btlPleines = 0, btlVides = 0;
  casiersGroupe.forEach((c) => {
    const st = String(c.statut || "vide").toLowerCase();
    if (st === "plein") nbPleins++;
    else if (st === "partiel") nbPartiels++;
    btlPleines += Math.max(0, Number(c.quantiteActuelle) || 0);
    btlVides += Math.max(0, Number(c.bouteillesVides) || 0);
  });
  const nbCasiersVidesRetour = casiersGroupe.filter((c) => casierIsAvailableEmptyForOrder(c)).length;
  const nbCasiersVidesBloques = casiersGroupe.filter((c) => {
    const st = String(c.statut || "").toLowerCase();
    const emptyLoads = Math.max(0, Number(c.quantiteActuelle) || 0) === 0;
    return emptyLoads && !casierIsAvailableEmptyForOrder(c) && st !== "plein" && st !== "partiel";
  }).length;
  const alreadyInDraft = draftReservedCasesFor(brGrp, cap);
  const maxNow = Math.max(0, Math.round((nbCasiersVidesRetour - alreadyInDraft) * 100) / 100);

  casesInput.value = String(maxNow);
  casesInput.max = String(maxNow);
  casesInput.step = "0.5";
  casesInput.placeholder = "Depuis stock";
  if (videsBtn) { videsBtn.style.display = nbCasiersVidesRetour > 0 ? "" : "none"; videsBtn.dataset.nbVides = nbCasiersVidesRetour; }

  if (limitHint) {
    limitHint.style.display = "";
    const quickBtnCasierHtml = () => (
      canManageCasier()
        ? `<button type="button" class="mini-btn mini-btn-quick-casier" style="margin-top:8px;display:inline-flex;align-items:center" data-purchase-quick-casier data-pqc-br="${escapeHtml(brGrp)}" data-pqc-cap="${escapeHtml(String(cap))}">Créer des casiers vides…</button>`
        : `<span class="muted" style="display:inline-block;margin-top:8px">Création de casiers : gérant / admin.</span>`
    );
    if (nbCasiersVidesRetour > 0) {
      let extraBlocked = nbCasiersVidesBloques > 0
        ? `<span class="muted" style="font-weight:500"> (${fmt(nbCasiersVidesBloques)} autre(s) vide(s) : réservation commande ou retourné — non comptées ici).</span>`
        : "";
      const maxZero = maxNow <= 0;
      const zeroExplain = maxZero
        ? ` <span class="muted" style="font-weight:600">Les casiers vide(s) comptés ci-dessous sont déjà pris par le <strong>brouillon</strong> (lignes cochées) — réduisez les quantités ou ajoutez des casiers.</span>`
        : "";
      const showQuickBelow = maxZero;
      limitHint.innerHTML = `<span style="color:#e65100;font-weight:700">↩ Maximum commandable : ${fmtPurchaseCases(maxNow)} casier(s) (reste sur casiers vides) — ${fmt(nbCasiersVidesRetour)} vide(s) disponible(s) au stock pour ${escapeHtml(brGrp)} ${escapeHtml(formatVal)}.</span>${extraBlocked}${zeroExplain} <span style="display:block;margin-top:6px;font-weight:500;color:var(--muted)">Demi-casier possible : la réservation de casiers vides utilise la somme des quantités, arrondie au casier entier au-dessus.</span>${showQuickBelow ? `<span style="display:block">${quickBtnCasierHtml()}</span>` : ""}`;
    } else {
      const quickBtn = quickBtnCasierHtml();
      limitHint.innerHTML =
        `<span style="color:#c62828;font-weight:700;display:inline-block;margin-bottom:4px">Aucun casier vide pour ce format (consigne ${escapeHtml(brGrp)}) — créez des casiers ou changez de format.</span><span style="display:block">${quickBtn}</span>`;
    }
  }

  if (videsHint) {
    if (casiersGroupe.length > 0) {
      videsHint.style.display = "";
      const parts = [];
      if (nbPleins > 0) parts.push(`<span style="color:#2e7d32;font-weight:700">${fmt(nbPleins)} plein(s)</span>`);
      if (nbPartiels > 0) parts.push(`<span style="color:#f57c00;font-weight:700">${fmt(nbPartiels)} partiel(s)</span>`);
      if (nbCasiersVidesRetour > 0 || nbCasiersVidesBloques > 0) {
        let sub = `<span style="color:#e53935;font-weight:700">${fmt(nbCasiersVidesRetour)} vide(s) utilisables</span>`;
        if (nbCasiersVidesBloques > 0) {
          sub += ` <span class="muted">(${fmt(nbCasiersVidesBloques)} réservé(s) / indisponible(s))</span>`;
        }
        parts.push(sub);
      }
      const btlInfo = `${fmt(btlPleines)} btl pleines`;
      videsHint.innerHTML = `Casiers : ${parts.join(" · ")} · ${btlInfo}`;
      videsHint.style.color = "";
    } else {
      videsHint.style.display = "none";
    }
  }
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
          <th style="text-align:right">Prix fournisseur</th>
          <th style="text-align:right">Montant</th>
          <th>Action</th>
        </tr></thead>
        <tbody>
          ${purchaseDraftLines.map((l, idx) => {
            const selected = l.selected !== false;
            return `<tr>
              <td style="text-align:center"><input type="checkbox" data-purchase-select="${idx}" ${selected ? "checked" : ""} aria-label="Sélection ligne"></td>
              <td>${escapeHtml(l.article)}</td>
              <td style="text-align:right"><input type="number" min="0" step="0.5" value="${escapeHtml(String(l.cases ?? 0))}" data-purchase-cases="${idx}" style="max-width:110px"></td>
              <td style="text-align:right">${fmt(l.caseSize ?? 24)}</td>
              <td style="text-align:right"><input type="number" min="0" step="1" value="${escapeHtml(String(l.pricePerCase ?? 0))}" data-purchase-price="${idx}" style="max-width:130px"></td>
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
  const cases = roundPurchaseCasesFromRaw(line, line.cases);
  const stockItem = stockItemForArticle(line.article);
  const caseSizeVal = stockItem ? caseSize(stockItem) : Math.max(1, Math.round(Number(line.caseSize) || 24));
  const price = Math.max(0, Math.round(Number(line.pricePerCase) || supplierPriceForArticle(line.article) || 0));
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
  populateSupplierList();
  syncSingleBreweryUi();
  // Réinitialiser le select article (aucune brasserie sélectionnée au départ)
  const forcedBr = siteSingleBreweryName();
  populatePurchaseArticlesByBrasserie(forcedBr || "");
  syncPurchaseLineInputsFromStock();
  renderPurchaseDraft();
}

function addPurchaseLine() {
  const feedback = document.getElementById("purchase-feedback");
  const formatVal = document.getElementById("purchase-article").value.trim();
  const articleDetail = document.getElementById("purchase-article-detail")?.value?.trim() || "";
  const brCanon = getPurchaseSupplierCanonical();
  const br = supplierKey(brCanon) === supplierKey(PURCHASE_NO_BRASSERIE_VALUE) ? "" : normalizeBrasserieName(brCanon);
  const casesInput = document.getElementById("purchase-cases");
  const casesRaw = Number(casesInput?.value);
  const caseSizeVal = Number(document.getElementById("purchase-case-size").value) || 24;
  const capMatch = formatVal.match(/^B(\d+)$/);
  const article = articleDetail || (capMatch && br ? `${br} ${formatVal}` : formatVal);
  const stockForLine = stockItemForArticle(article);
  const price = purchasePriceInputValue() || supplierPriceForArticle(article);
  if (!formatVal || !Number.isFinite(casesRaw) || casesRaw <= 0) {
    if (feedback) feedback.textContent = "Sélectionnez un format et indiquez le nombre de casiers (ex. 0,5 pour un demi-casier).";
    return;
  }
  const cases = roundPurchaseCasesFromRaw({ article }, casesRaw);
  if (cases <= 0) {
    if (feedback) feedback.textContent = "Sélectionnez un format et indiquez le nombre de casiers.";
    return;
  }
  if (!price) {
    if (feedback) feedback.textContent = "Saisissez le prix fournisseur pour ce format.";
    return;
  }
  const maxAttr = casesInput?.getAttribute("max");
  const maxCases = maxAttr !== null && purchaseLineNeedsConsigneReservation(stockForLine) ? Number(maxAttr) : null;
  if (maxCases !== null && Number.isFinite(maxCases) && cases > maxCases + 1e-6) {
    if (feedback) {
      if (maxCases === 0 && capMatch && br && canManageCasier()) {
        const capN = Number(capMatch[1]) || 24;
        feedback.innerHTML = `<span>${escapeHtml(`Aucun casier vide pour ${br} ${formatVal}.`)}</span> <button type="button" class="mini-btn mini-btn-quick-casier" style="margin-left:8px" data-purchase-quick-casier data-pqc-br="${escapeHtml(br)}" data-pqc-cap="${escapeHtml(String(capN))}">Créer des casiers vides…</button>`;
      } else if (maxCases === 0) {
        feedback.textContent = `Aucun casier vide disponible pour ${br} ${formatVal} — commande impossible (gérant : créer des casiers dans Stock → Gestion casiers).`;
      } else {
        feedback.textContent = `Commande limitée à ${fmt(maxCases)} casier(s) vide(s) disponible(s) pour ${br} ${formatVal}.`;
      }
    }
    return;
  }
  const amount = Math.round(cases * price);
  const lineBrKey = normalizeBrasserieName(stockForLine?.brasserie || br || "");
  purchaseDraftLines.push({
    article,
    brasserie: lineBrKey,
    cap: caseSizeVal,
    cases,
    caseSize: caseSizeVal,
    pricePerCase: price,
    amount,
    selected: true,
  });
  // Réinitialiser article-detail
  const detailSel = document.getElementById("purchase-article-detail");
  if (detailSel) detailSel.value = "";
  casesInput.removeAttribute("max");
  // Re-peupler la liste article filtrée par brasserie courante
  const curBr = purchaseSupplierRawFromDom();
  populatePurchaseArticlesByBrasserie(curBr);
  document.getElementById("purchase-cases").value = "";
  syncPurchaseLineInputsFromStock();
  if (feedback) feedback.textContent = "";
  renderPurchaseDraft();
}

function rememberSupplierPrices(supplier, lines) {
  const supplierName = String(supplier || "").trim();
  if (!supplierName) return;
  state.supplierPrices = state.supplierPrices || [];
  const siteId = currentSiteId();
  const now = new Date().toISOString();
  (lines || []).forEach((line) => {
    const article = String(line.article || "").trim();
    const price = Math.max(0, Math.round(Number(line.pricePerCase) || 0));
    if (!article || price <= 0) return;
    const existing = state.supplierPrices.find((row) =>
      rowMatchesSite(row, siteId, multiSiteActive())
      && supplierKey(row.supplier) === supplierKey(supplierName)
      && String(row.article || "").trim().toLowerCase() === article.toLowerCase()
    );
    if (existing) {
      existing.pricePerCase = price;
      existing.updatedAt = now;
      existing.updatedBy = sessionUser || "system";
    } else {
      state.supplierPrices.push({
        id: `${siteId || "site"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        siteId,
        supplier: supplierName,
        article,
        pricePerCase: price,
        createdAt: now,
        updatedAt: now,
        updatedBy: sessionUser || "system",
      });
    }
  });
}

async function savePurchaseOrder() {
  const feedback = document.getElementById("purchase-feedback");
  purchaseDraftLines.forEach((_, idx) => recomputePurchaseLine(idx));
  const selectedLines = purchaseDraftLines.filter((l) => l.selected !== false);
  if (!selectedLines.length) {
    if (feedback) feedback.textContent = "Cochez au moins une ligne (ou ajoutez une ligne).";
    return;
  }
  const invalidLine = selectedLines.find((l) => (Number(l.cases) || 0) <= 0 || (Number(l.pricePerCase) || 0) <= 0);
  if (invalidLine) {
    if (feedback) feedback.textContent = `Renseignez les casiers et le prix fournisseur pour "${invalidLine.article}".`;
    renderPurchaseDraft();
    syncPurchaseLineInputsFromStock();
    return;
  }
  const siteIdSave = currentSiteId();
  if (!siteIdSave) {
    if (feedback) feedback.textContent = "Selectionnez un maquis (aucun site actif).";
    showToast("Impossible d'enregistrer : aucun maquis actif.");
    return;
  }
  const supplier = getPurchaseSupplierDisplayName();
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
      delete copy.brasserie;
      delete copy.cap;
      return copy;
    }),
    total,
  };
  rememberSupplierPrices(supplier, selectedLines);
  // Réserver les casiers vides (déduction immédiate). Si insuffisant -> blocage.
  try {
    reserveEmptyCasiersForPurchaseOrder(po);
  } catch (e) {
    if (feedback) feedback.textContent = e?.message || "Casiers vides insuffisants.";
    showToast(e?.message || "Casiers vides insuffisants.");
    return;
  }
  state.purchaseOrders = [po, ...(state.purchaseOrders || [])];
  recordStaffAudit(
    "create",
    "achat_fournisseur",
    `Commande fournisseur ${supplier} (#${po.id})`,
    formatPurchaseOrderAuditDetail(po),
  );
  await persistState({ purchaseOrders: state.purchaseOrders, supplierPrices: state.supplierPrices, casiers: state.casiers });
  document.getElementById("purchase-form")?.classList.add("hidden");
  purchaseDraftLines = [];
  populateSupplierList();
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
  // Rendre les casiers vides réservés par cette commande
  releaseReservedCasiersForPurchaseOrder(po.id);
  recordStaffAudit("update", "achat_fournisseur", `Commande annulee · ${po.supplier}`, formatPurchaseOrderAuditDetail(po));
  await persistState({ purchaseOrders: state.purchaseOrders, casiers: state.casiers });
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  populateSupplierList();
  showToast("Commande annulee.");
}

function purchaseReceiptNeedsSnapshot(originalLines, receivedLines) {
  const norm = (lines) =>
    [...(lines || [])]
      .map((l) => ({
        article: String(l.article || "").toLowerCase().trim(),
        cases: Math.round((Number(l.cases) || 0) * 100) / 100,
      }))
      .sort((a, b) => a.article.localeCompare(b.article));
  const o = norm(originalLines);
  const r = norm(receivedLines);
  if (o.length !== r.length) return true;
  for (let i = 0; i < o.length; i++) {
    if (o[i].article !== r[i].article || Math.abs(o[i].cases - r[i].cases) > 1e-4) return true;
  }
  return false;
}

async function applyPurchaseReceipt(po, linesReceived, opts = {}) {
  const rangerCasiers = opts.rangerCasiers !== false;
  const receivedTotal = Math.round(linesReceived.reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
  if (!linesReceived.length || receivedTotal <= 0) return false;

  if (purchaseReceiptNeedsSnapshot(po.lines, linesReceived)) {
    po.linesOrderedSnapshot = JSON.parse(JSON.stringify(po.lines || []));
  } else {
    delete po.linesOrderedSnapshot;
  }

  const siteId = po.siteId || currentSiteId();
  const stockItems = state.stock || [];
  const stockEntrees = state.stockEntrees || [];
  if (!state.nextId) state.nextId = {};
  if (state.nextId.stockEntree == null || Number.isNaN(Number(state.nextId.stockEntree))) {
    const maxE = stockEntrees.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0);
    state.nextId.stockEntree = Math.max(100, maxE + 1);
  }
  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  if (!state.nextId.casier || Number.isNaN(Number(state.nextId.casier))) state.nextId.casier = 1;
  if (!state.nextId.casierMouvement || Number.isNaN(Number(state.nextId.casierMouvement))) state.nextId.casierMouvement = 1;
  let casiersCreated = 0;
  let casiersUsed = 0;

  linesReceived.forEach((line) => {
    const cases = Number(line.cases) || 0;
    if (cases <= 0) return;
    const item = stockItems.find((s) => s.siteId === siteId && String(s.article || "").toLowerCase() === String(line.article || "").toLowerCase());
    if (!item) return;
    const cs = Number(line.caseSize) || caseSize(item);
    const bottles = Math.round(cases * cs);
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

    if (rangerCasiers && lotType(item) === "casier") {
      let remaining = bottles;
      const partials = (state.casiers || [])
        .filter((c) => c.siteId === siteId && String(c.article || "").toLowerCase() === String(item.article || "").toLowerCase())
        .filter((c) => (Number(c.quantiteActuelle) || 0) < (Number(c.capacite) || 0))
        .sort((a, b) => (Number(b.quantiteActuelle) || 0) - (Number(a.quantiteActuelle) || 0));
      partials.forEach((c) => {
        if (remaining <= 0) return;
        const cap = Math.max(1, Number(c.capacite) || 1);
        const cur = Math.max(0, Number(c.quantiteActuelle) || 0);
        const free = cap - cur;
        if (free <= 0) return;
        const add = Math.min(free, remaining);
        c.quantiteActuelle = cur + add;
        recomputeCasierStatus(c);
        c.lastMoveAt = new Date().toISOString();
        c.lastMoveBy = sessionUser || "system";
        state.casierMouvements.unshift({
          id: state.nextId.casierMouvement++,
          siteId,
          casierId: c.id,
          casierCode: c.code,
          article: item.article,
          type: "entree",
          quantite: add,
          source: "fournisseur",
          motif: "",
          commentaire: `Réception ${po.supplier || "fournisseur"}`,
          user: sessionUser || "system",
          role: currentRole || "-",
          date: po.date || today(),
          createdAt: new Date().toISOString(),
        });
        remaining -= add;
        casiersUsed++;
      });
      while (remaining > 0) {
        const code = nextCasierCode();
        const fill = Math.min(cs, remaining);
        const newCasier = {
          id: state.nextId.casier++,
          siteId,
          code,
          article: item.article,
          capacite: cs,
          quantiteActuelle: fill,
          bouteillesVides: 0,
          emplacement: "À ranger",
          statut: fill >= cs ? "plein" : "partiel",
          createdAt: new Date().toISOString(),
          createdBy: sessionUser || "system",
          lastMoveAt: new Date().toISOString(),
          lastMoveBy: sessionUser || "system",
        };
        state.casiers.push(newCasier);
        state.casierMouvements.unshift({
          id: state.nextId.casierMouvement++,
          siteId,
          casierId: newCasier.id,
          casierCode: newCasier.code,
          article: item.article,
          type: "entree",
          quantite: fill,
          source: "fournisseur",
          motif: "",
          commentaire: `Création + réception ${po.supplier || "fournisseur"}`,
          user: sessionUser || "system",
          role: currentRole || "-",
          date: po.date || today(),
          createdAt: new Date().toISOString(),
        });
        remaining -= fill;
        casiersCreated++;
      }
    }
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
  const casierDetail = rangerCasiers ? ` · casiers: ${casiersUsed} re-utilise(s), ${casiersCreated} cree(s)` : "";
  recordStaffAudit(
    "update",
    "reception_fournisseur",
    `Reception · ${po.supplier}`,
    `${fmt(receivedTotal)} FCFA · ${linesReceived.length} ligne(s) livree(s) · ${po.payment || ""}${casierDetail}`
  );
  await persistState({ stock: stockItems, purchaseOrders: state.purchaseOrders, charges: state.charges, nextId: state.nextId, stockEntrees, casiers: state.casiers, casierMouvements: state.casierMouvements });
  renderStock();
  renderPurchaseOrders();
  refreshCreanciersIfVisible();
  if (currentPage === "stock" && stockSubTab === "casiers") renderCasiers();
  renderDashboard();
  if (rangerCasiers && (casiersCreated + casiersUsed) > 0) {
    showToast(`Commande receptionnee. ${casiersCreated} nouveau(x) casier(s), ${casiersUsed} casier(s) complete(s).`);
  } else {
    showToast("Commande receptionnee selon les quantites livrees.");
  }
  return true;
}

function updateReceivePurchaseModalTotals(po) {
  let sum = 0;
  (po.lines || []).forEach((line, idx) => {
    const inp = document.getElementById(`recv-cases-${idx}`);
    const raw = Number(inp?.value);
    const delivered = roundPurchaseCasesFromRaw(line, raw);
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
      const recvStep = "0.5";
      return `
    <div class="purchase-receive-row" style="border-bottom:1px solid rgba(255,255,255,0.06);padding:12px 0">
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;justify-content:space-between">
        <div style="flex:1;min-width:160px">
          <strong>${escapeHtml(l.article)}</strong>
          <p class="muted" style="margin:4px 0 0;font-size:0.82rem">Commande : ${fmtPurchaseCases(orderedCases)} casier(s) × ${fmt(l.caseSize)} btl · ${fmt(price)} FCFA/cas.</p>
        </div>
        <div class="form-group" style="margin:0;min-width:120px">
          <label for="recv-cases-${idx}">Casiers livres</label>
          <input type="number" min="0" step="${recvStep}" class="recv-cases-input" id="recv-cases-${idx}" data-recv-idx="${idx}" value="${escapeHtml(String(orderedCases))}">
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
    const delivered = roundPurchaseCasesFromRaw(line, inp?.value);
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
  const rangerEl = document.getElementById("purchase-receive-ranger");
  const rangerCasiers = rangerEl ? Boolean(rangerEl.checked) : true;
  closeModal("modal-purchase-receive");
  await applyPurchaseReceipt(po, linesReceived, { rangerCasiers });
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
          <span>${escapeHtml(l.article)} · ${fmtPurchaseCases(l.cases)} cas × ${fmt(l.caseSize)} btl</span>
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
  if (!assertJournalAllowsSalesOrToast(date, currentSiteId())) return;
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
  const saleDateGuard = String(order.date || today()).slice(0, 10);
  if (!assertJournalAllowsSalesOrToast(saleDateGuard, order.siteId || currentSiteId())) return;
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
    formatQuantite: linePackSize(line, stockItemForArticle(line.article, siteId)),
    packSize: linePackSize(line, stockItemForArticle(line.article, siteId)),
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
      drainArticleCasiers(stockItem.article, bottles, { motif: "vente", commentaire: `Facture ${factureNumber}` });
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
  if (currentPage === "stock" && stockSubTab === "casiers") renderCasiers();
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
  const saleD = String(order.date || today()).slice(0, 10);
  if (!assertJournalAllowsSalesOrToast(saleD, order.siteId || currentSiteId())) return;
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
        <label>Prix cave</label>
        <input class="stock-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || "")}" placeholder="ex: 700">
      </div>
      <div class="form-group">
        <label>Prix maquis</label>
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
  document.getElementById("s-lot-type").value = "casier";
  document.getElementById("s-seuil").value = "5";
  document.getElementById("s-pack").value = "1";
  document.getElementById("s-frigo").value = "0";
  document.getElementById("s-reserve").value = "";
  document.getElementById("s-prix").value = "";
  document.getElementById("s-prix-kit-int").value = "";
  document.getElementById("s-prix-kit-ext").value = "";
  document.getElementById("s-price-location").value = "int";
  document.getElementById("s-price-location-value").value = "";
  populateBrasserieFournisseurSelect(document.getElementById("s-brasserie"), {
    mode: "catalog",
    preservedValue: siteSingleBreweryName() || "",
  });
  renderStockSaleFormats();
  document.getElementById("stock-modal-title").textContent = "Nouvel article en stock";
  document.getElementById("save-stock-btn").textContent = "Enregistrer l'article";
  syncSingleBreweryUi();
}

function openEditStock(itemId) {
  if (!canManage()) {
    showToast("Modification du catalogue reservee au gerant ou administrateur.");
    return;
  }
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  document.getElementById("s-edit-id").value = String(itemId);
  document.getElementById("s-article").value = item.article;
  document.getElementById("s-cat").value = item.cat;
  document.getElementById("s-case-size").value = String(caseSize(item));
  document.getElementById("s-lot-type").value = lotType(item);
  document.getElementById("s-init").value = String(item.initCases ?? casesFromBottles(item.init, item));
  document.getElementById("s-seuil").value = String(item.seuilMin || 5);
  document.getElementById("s-pack").value = String(item.packSize || 1);
  document.getElementById("s-frigo").value = String(stockFrigo(item));
  document.getElementById("s-reserve").value = String(stockReserve(item));
  document.getElementById("s-prix").value = String(item.prixAchat || "");
  populateBrasserieFournisseurSelect(document.getElementById("s-brasserie"), {
    mode: "catalog",
    preservedValue: siteSingleBreweryName() || item.brasserie || "",
  });
  document.getElementById("s-prix-kit-int").value = String(item.prixVenteInt || item.prixKitInt || item.prixBouteille || item.prixVente || "");
  document.getElementById("s-prix-kit-ext").value = String(item.prixVenteExt || item.prixKitExt || item.prixBouteille || item.prixVente || "");
  document.getElementById("s-price-location").value = "int";
  renderStockSaleFormats(normalizeSaleFormats(item));
  updateStockPriceInput();
  document.getElementById("stock-modal-title").textContent = `Modifier : ${item.article}`;
  document.getElementById("save-stock-btn").textContent = "Enregistrer les modifications";
  syncSingleBreweryUi();
  openModal("modal-stock");
}

async function saveStock() {
  commitStockPriceInput();
  if (!canManage()) {
    showToast("Modification du catalogue reservee au gerant ou administrateur.");
    return;
  }
  const editId = document.getElementById("s-edit-id").value;
  const articleName = document.getElementById("s-article").value.trim();
  if (!articleName) {
    showToast("Nom de l'article obligatoire.");
    return;
  }
  const forcedBrasserie = siteSingleBreweryName();
  const fields = {
    caseSize: (VALID_CASE_SIZES.includes(Number(document.getElementById("s-case-size").value)) ? Number(document.getElementById("s-case-size").value) : 24),
    lotType: String(document.getElementById("s-lot-type")?.value || "casier"),
    article: articleName,
    cat: document.getElementById("s-cat").value,
    brasserie: forcedBrasserie || (document.getElementById("s-brasserie")?.value || "").trim(),
    initCases: Number(document.getElementById("s-init").value) || 0,
    seuilMin: Number(document.getElementById("s-seuil").value) || 5,
    prixAchat: Number(document.getElementById("s-prix").value) || 0,
  };
  if (siteIsSingleBrewery() && !fields.brasserie) { showToast("Brasserie unique manquante dans les paramètres du maquis."); return; }
  fields.formatsVente = readStockSaleFormats();
  const primaryFormat = fields.formatsVente.find((format) => format.quantite === 1) || fields.formatsVente[0];
  fields.packSize = Math.max(1, Number(primaryFormat?.quantite) || Number(document.getElementById("s-pack").value) || 1);
  fields.prixVenteInt = Number(primaryFormat?.prixInterieur) || Number(document.getElementById("s-prix-kit-int").value) || 0;
  fields.prixVenteExt = Number(primaryFormat?.prixExterieur) || Number(document.getElementById("s-prix-kit-ext").value) || fields.prixVenteInt;
  // Si article à l'unité, forcer 1 unité par lot.
  if (String(fields.lotType).toLowerCase() === "unite" || String(fields.lotType).toLowerCase() === "unité") {
    fields.caseSize = 1;
  }
  fields.init = fields.initCases * fields.caseSize;
  fields.frigo = Math.max(0, Number(document.getElementById("s-frigo").value) || 0);
  const reserveInput = document.getElementById("s-reserve").value;
  fields.reserve = reserveInput === "" ? Math.max(0, fields.init - fields.frigo) : Math.max(0, Number(reserveInput) || 0);
  fields.prixBouteille = fields.packSize === 1 ? fields.prixVenteInt : 0;
  fields.prixKitInt = fields.packSize > 1 ? fields.prixVenteInt : 0;
  fields.prixKitExt = fields.packSize > 1 ? fields.prixVenteExt : 0;
  if (fields.prixAchat <= 0 || !fields.formatsVente.length || fields.prixVenteInt <= 0) {
    showToast("Prix achat et au moins un format avec prix cave obligatoires.");
    return;
  }
  if (fields.prixVenteExt <= 0) {
    fields.prixVenteExt = fields.prixVenteInt;
  }
  if (editId) {
    const item = state.stock.find((i) => i.id === Number(editId));
    if (item) {
      const before = JSON.parse(JSON.stringify(item));
      Object.assign(item, fields);
      const changes = [];
      const pushChange = (label, a, b) => {
        const sa = a == null ? "" : String(a);
        const sb = b == null ? "" : String(b);
        if (sa !== sb) changes.push(`${label}: ${sa || "—"} → ${sb || "—"}`);
      };
      pushChange("Article", before.article, item.article);
      pushChange("Categorie", before.cat, item.cat);
      pushChange("Type lot", lotType(before), lotType(item));
      pushChange("Unites/lot", caseSize(before), caseSize(item));
      pushChange("Seuil (btl)", before.seuilMin, item.seuilMin);
      pushChange("PA/lot", before.prixAchat, item.prixAchat);
      pushChange("Pack", before.packSize, item.packSize);
      pushChange("PV int", before.prixVenteInt, item.prixVenteInt);
      pushChange("PV ext", before.prixVenteExt, item.prixVenteExt);
      pushChange("Init lots", before.initCases, item.initCases);
      pushChange("Stock init (btl)", before.init, item.init);
      pushChange("Frigo (btl)", before.frigo, item.frigo);
      pushChange("Reserve (btl)", before.reserve, item.reserve);
      const header = `ID ${item.id} · ${item.siteId || ""}`.trim();
      recordStaffAudit(
        "update",
        "catalogue_article",
        `Article modifie : ${articleName}`,
        `${header}\n${changes.length ? changes.join("\n") : "Aucun changement detecte."}`,
      );
    }
  } else {
    state.stock.push({ id: state.nextId.stock++, siteId: currentSiteId(), entrees: 0, sorties: 0, createdAt: new Date().toISOString(), createdBy: sessionUser || "-", ...fields });
    recordStaffAudit("create", "catalogue_article", `Article ajoute : ${articleName}`, `${fields.cat} · PA ${fmt(fields.prixAchat)}/cas. · vente int. ${fmt(fields.prixVenteInt)}`);
  }
  await persistState();
  closeModal("modal-stock");
  resetStockForm();
  populateCategorySelects();
  if (currentPage === "home") renderDashboard();
  renderStock();
  if (currentPage === "stock" && stockSubTab === "casiers") renderCasiers();
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
        movements.push({
          date: e.date,
          article: e.article,
          type: "entree",
          qty: e.qty,
          unit: "Bouteille",
          reason: `Achat (${fmtPurchaseCases(e.cases)} casier(s) x ${fmt(e.caseSize)} btl)`,
          user: e.user || e.createdBy || item.lastReapproBy || item.createdBy || "-",
        });
      });
    } else if (Number(item.entrees) > 0) {
      movements.push({
        date: item.lastReapproAt || today(),
        article: item.article,
        type: "entree",
        qty: Number(item.entrees) || 0,
        unit: "Bouteille",
        reason: "Approvisionnement (historique)",
        user: item.lastReapproBy || item.createdBy || "Historique",
      });
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

function closureCashSnapshot(dStr) {
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum : sum + a, 0);
  const caCreances = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum + a : sum, 0);
  const especesVentes = Number(totauxJour["Espèces"]) || Number(totauxJour["EspÃ¨ces"]) || 0;
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces")
    || normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("EspÃ¨ces")
      ? sum + (Number(c.montant) || 0)
      : sum
  ), 0);
  const dayBook = dayBookFor(dStr, currentSiteId());
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  const expectedEspecesCash = openingCash + especesVentes - especesCharges;
  const closingRaw = document.getElementById("pdj-closing-cash")?.value;
  const closingCashFcfa = closingRaw === undefined || closingRaw === null || String(closingRaw).trim() === ""
    ? expectedEspecesCash
    : Math.max(0, Number(closingRaw) || 0);
  return {
    dayBook,
    ventesJour,
    totauxJour,
    caEncaisse,
    caCreances,
    especesVentes,
    especesCharges,
    openingCash,
    expectedEspecesCash,
    closingCashFcfa,
    cashEcartEspeces: closingCashFcfa - expectedEspecesCash,
  };
}

async function closeAccountingDay() {
  if (!canManagePdjAccounting()) {
    showToast("Clôture de journée réservée au gérant ou à un administrateur.");
    return;
  }
  const items = recordsForSite(state.stock);
  if (!items.length) {
    showToast("Aucun stock a verifier.");
    return;
  }
  const dStr = pdjCalendarDate();
  if (!canAnyAdmin() && dStr !== today()) {
    showToast("Seul un administrateur peut clôturer une autre date.");
    return;
  }
  const dayBook = dayBookFor(dStr, currentSiteId());
  const isPastDateCorrection = dStr !== today() && canAnyAdmin();
  if (!isPastDateCorrection && PDJ_REQUIRE_CASH_OPENING && (!dayBook || dayBookNeedsCashOpening(dayBook))) {
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

  const existingCloseCheck = stockCheckForSiteDate(dStr, currentSiteId());
  const checkedItems = items.map((item) => {
    const frigo = Math.max(0, Number(document.querySelector(`[data-check-frigo="${item.id}"]`)?.value) || 0);
    const reserve = Math.max(0, Number(document.querySelector(`[data-check-reserve="${item.id}"]`)?.value) || 0);
    const existingCloseItem = existingCloseCheck ? (existingCloseCheck.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const stockAtOpen = dStr === today()
      ? stockActuel(item)
      : (existingCloseItem?.stockAvant ?? stockActuel(item));
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
  // Les ecarts sont acceptes et enregistres dans le stock (entrees/sorties)
  // Avertissement informatif uniquement pour les non-admins
  if (stockGaps.length && !canAnyAdmin()) {
    const confirm = window.confirm(`${stockGaps.length} article(s) ont des ecarts entre le stock physique et le theorique. Ces ecarts seront enregistres. Confirmer quand meme ?`);
    if (!confirm) return;
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
  const gapLines = stockGaps
    .slice()
    .sort((a, b) => Math.abs(Number(b.ecart) || 0) - Math.abs(Number(a.ecart) || 0))
    .map((g, i) => {
      const sign = g.ecart > 0 ? "+" : "";
      return `${i + 1}. ${g.article} · ouv ${fmt(g.stockAvant)} · ventes ${fmt(g.sortiesToday)} · theo ${fmt(g.expected)} · compte ${fmt(g.counted)} (F ${fmt(g.frigo)} / R ${fmt(g.reserve)}) · ecart ${sign}${fmt(g.ecart)}`;
    });
  const cashBlock = [
    `Date: ${formatDateDdMmYyyy(dStr)}`,
    `CA encaisse: ${fmt(caEncaisse)} FCFA · Creances: ${fmt(caCreances)} FCFA · Nb ventes: ${fmt(ventesJour.length)}`,
    `Caisse especes: ouverture ${fmt(openingCash)} · ventes ${fmt(especesVentes)} · charges ${fmt(especesCharges)} · attendu ${fmt(expectedEspecesCash)} · denombre ${fmt(closingCashFcfa)} · ecart ${cashEcartEspeces > 0 ? "+" : ""}${fmt(cashEcartEspeces)}`,
  ].join("\n");
  const stockBlock = gapLines.length
    ? `\n\nEcarts stock (${gapLines.length}):\n${gapLines.join("\n")}`
    : "\n\nEcarts stock: aucun (OK).";
  recordStaffAudit(
    "update",
    "cloture_jour",
    `Cloture journee ${formatDateDdMmYyyy(dStr)}`,
    `${cashBlock}${stockBlock}`,
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
  const dualPricingChecked = Boolean(document.getElementById("p-dual-zone-pricing")?.checked);
  const singleBreweryOnly = Boolean(document.getElementById("p-single-br-enabled")?.checked);
  const singleBreweryName = String(document.getElementById("p-single-br-name")?.value || "").trim();
  if (singleBreweryOnly && !singleBreweryName) { showToast("Saisissez la brasserie unique."); return; }
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
    dualZonePricing: dualPricingChecked,
    smsQrAlert: (document.getElementById("p-sms-qr")?.value || "").trim(),
    singleBreweryOnly,
    singleBreweryName: singleBreweryOnly ? singleBreweryName : "",
    stockAlertInclusiveSeuil: Boolean(document.getElementById("p-stock-alert-inclusive-seuil")?.checked),
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
    populatePurgeMaquisSelect();
    await refreshRestoreBackupUi().catch(() => {});
    resetUserForm();
    renderUsersList();
    showToast("Restauration terminee. Rechargez la page si besoin.");
  } catch (error) {
    showToast(error.message || "Echec restauration.");
  }
}

async function refreshRestoreBackupUi() {
  const infoEl = document.getElementById("restore-backup-info");
  const fileSel = document.getElementById("restore-backup-file");
  const siteSel = document.getElementById("restore-backup-site");
  if (!fileSel || !siteSel) return;
  if (!canSuperAdmin()) {
    if (infoEl) infoEl.textContent = "";
    return;
  }
  const prevBackup = fileSel.value || "";
  const prevSite = siteSel.value || "";
  let data = null;
  let fallbackFromState = false;
  try {
    data = await apiRequest(API.adminBackups, { cache: "no-store" });
  } catch (fetchErr) {
    try {
      /** Repli : superadmin reçoit <code>adminBackups</code> dans l'état complet. Param anti-cache pour éviter un 304 sans corps. */
      const stateUrl = `${API.state}?_=${Date.now()}`;
      state = await apiRequest(stateUrl, { cache: "no-store" });
      data = state.adminBackups;
      if (data) fallbackFromState = true;
    } catch (_) {
      data = null;
    }
    if (!data && infoEl) {
      const st = fetchErr?.status != null ? ` (${fetchErr.status})` : "";
      const raw = String(fetchErr?.message || fetchErr || "erreur");
      const msg = escapeHtml(raw);
      const is404 = Number(fetchErr?.status) === 404;
      const hint404 = is404
        ? `<span class="muted">Un <strong>404</strong> signifie en général que le <strong>serveur Python</strong> ne connaît pas encore la route <code>GET /api/admin/backups</code> (version ancienne de <code>server.py</code>, ou page ouverte sans passer par ce serveur). <strong>Déployez la dernière version</strong> du dépôt et <strong>redémarrez</strong> le processus serveur.</span><br><br>`
        : "";
      infoEl.innerHTML =
        `${hint404}<span style="color:#c62828"><strong>Liste des sauvegardes inaccessible${st}</strong><br>${msg}</span><br>`
        + `<span class="muted">Les copies dans <code>backups/</code> sont créées <strong>à chaque enregistrement</strong> par le serveur (fichiers <code>data-*.json</code> ou <code>app-*.sqlite3</code>). Si la liste reste vide après mise à jour du serveur, vérifiez que le dossier <code>backups</code> existe à côté de <code>server.py</code> et les droits disque.</span>`;
    }
    console.error(fetchErr);
  }

  if (data) {
    if (infoEl) {
      const mode = escapeHtml(data.storageMode || "?");
      const k = escapeHtml(String(data.keepCount ?? 30));
      const note = escapeHtml(data.autoNote || "");
      const via = fallbackFromState
        ? `<p class="muted" style="margin:0 0 8px">Liste obtenue via <code>/api/state</code> (<code>/api/admin/backups</code> non disponible sur ce deploiement).</p>`
        : "";
      infoEl.innerHTML =
        `${via}${note}<br><strong>Stockage serveur&nbsp;:</strong> ${mode} · jusqu&apos;a <strong>${k}</strong> fichiers <code>data-*.json</code> et <code>app-*.sqlite3</code> conserves.<br>Pour plus de gardes&nbsp;: <code>MAQUIS_MANAGER_BACKUP_KEEP</code> (3-100), ou <code>TDB_BAR_BACKUP_KEEP</code> (ancien nom, encore accepte).`;
    }
    const jsonBk = Array.isArray(data.jsonBackups) ? data.jsonBackups : [];
    const sqlBk = Array.isArray(data.sqliteBackups) ? data.sqliteBackups : [];
    const parts = [];
    if (jsonBk.length) {
      parts.push(
        `<optgroup label="Snapshots JSON">${jsonBk.map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)} · ${escapeHtml(b.mtimeIso || "")}</option>`).join("")}</optgroup>`,
      );
    }
    if (sqlBk.length) {
      parts.push(
        `<optgroup label="Copies SQLite">${sqlBk.map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)} · ${escapeHtml(b.mtimeIso || "")}</option>`).join("")}</optgroup>`,
      );
    }
    fileSel.innerHTML =
      parts.length
        ? parts.join("")
        : `<option value="">Aucun fichier dans backups/</option>`;
    if ([...fileSel.options].some((o) => o.value === prevBackup)) fileSel.value = prevBackup;
  }

  const sites = state?.sites || [];
  siteSel.innerHTML = sites.length
    ? sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nom)} (${escapeHtml(s.id)})</option>`).join("")
    : `<option value="">—</option>`;
  const cur = currentSiteId();
  if (prevSite && sites.some((s) => String(s.id) === prevSite)) siteSel.value = prevSite;
  else if (cur && sites.some((s) => String(s.id) === String(cur))) siteSel.value = String(cur);
}

async function restoreSelectedSiteFromBackup() {
  if (!canSuperAdmin()) {
    showToast("Reserve au super administrateur.");
    return;
  }
  const backupFile = document.getElementById("restore-backup-file")?.value?.trim();
  const siteId = document.getElementById("restore-backup-site")?.value?.trim();
  const site = (state?.sites || []).find((s) => String(s.id) === siteId);
  if (!backupFile) {
    showToast("Choisissez un fichier de sauvegarde.");
    return;
  }
  if (!siteId || !site) {
    showToast("Choisissez un maquis.");
    return;
  }
  if (
    !window.confirm(
      `Remplacer toutes les donnees operationnelles du maquis "${site.nom}" (${site.id})\n`
      + `par la version contenue dans la sauvegarde "${backupFile}" pour ce meme maquis ?\n`
      + "Les autres maquis restent inchanges.",
    )
  ) {
    return;
  }
  try {
    await apiRequest(API.restoreSiteFromBackup, { method: "POST", body: JSON.stringify({ backupFile, siteId }) });
    activeOrderId = null;
    editingLineId = null;
    await bootstrapAuthenticatedApp({ skipCasierLsRestore: true });
    lsSaveCasiers();
    showToast(`Maquis "${site.nom}" restaure depuis ${backupFile}.`);
  } catch (error) {
    handleApiError(error);
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
  if (!window.confirm(
    "Exporter tout l'etat de l'application en JSON sur cet appareil ?\n\n"
    + "Le fichier peut contenir des donnees sensibles (ventes, mots de passe chiffres, stock). "
    + "Conservez-le dans un endroit sur.",
  )) {
    return;
  }
  const payload = { ...state, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `maquis_manager_${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  recordStaffAudit("export", "donnees_json", "Export JSON complet (telechargement local)", `Octets ~${blob.size}`);
  persistState({ staffAuditLog: state.staffAuditLog, nextId: state.nextId }).catch(() => {});
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
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Ticket ${escapeHtml(order.client)}</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1,h2,p{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{padding:8px 0;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.total{margin-top:16px;font-size:20px;font-weight:700}.muted{color:#666;font-size:12px}</style></head><body><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p><p class="muted">Client: ${escapeHtml(order.client || "Comptoir")} · Date: ${escapeHtml(formatDateDdMmYyyy(order.date))}</p><table><thead><tr><th>Article</th><th>Qté</th><th>Montant</th></tr></thead><tbody>${order.lignes.map((line) => `<tr><td>${escapeHtml(line.article)}</td><td>${escapeHtml(lineQtyLabel(line, stockItemForArticle(line.article)))}</td><td>${fmt(calcNet(line))} FCFA</td></tr>`).join("")}</tbody></table><p class="total">Total: ${fmt(total)} FCFA</p><p class="muted">${escapeHtml(order.note || "")}</p><script>window.onload=function(){window.print();}</script></body></html>`);
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
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Facture ${escapeHtml(factureNumber)}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111;background:#fff}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:16px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.meta{color:#555}.totals{margin-top:18px;display:flex;justify-content:flex-end}.totals-box{min-width:300px;border:1px solid #111;padding:16px}.totals-box p{display:flex;justify-content:space-between;margin-bottom:6px}.grand{font-size:20px;font-weight:700;border-top:1px solid #111;padding-top:8px;margin-top:8px}.footer{margin-top:26px;color:#666;font-size:12px}.pay-label{font-size:12px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} - ${escapeHtml(site?.pays || "")}</p><p>Gerant: ${escapeHtml(site?.gerant || "-")}</p></div><div><h2>Facture</h2><p class="meta">Numero: ${escapeHtml(factureNumber)}</p><p class="meta">Date: ${escapeHtml(formatDateDdMmYyyy(lignes[0].date))}</p><p class="meta">Client: ${escapeHtml(client)}</p></div></header><table><thead><tr><th>Article</th><th>Qte</th><th>Prix unit.</th><th>Remise</th><th>Total</th></tr></thead><tbody>${lignes.map((line) => `<tr><td>${escapeHtml(line.article)}</td><td>${escapeHtml(lineQtyLabel(line, stockItemForArticle(line.article)))}</td><td>${fmt(line.prix)} FCFA</td><td>${fmt(line.remise || 0)} FCFA</td><td>${fmt(calcNet(line))} FCFA</td></tr>`).join("")}</tbody></table><div class="totals"><div class="totals-box">${isMixed ? `<p class="pay-label" style="display:block">Paiement mixte</p>` : ""}${paymentSection}${creditSection}<p class="grand"><span>Total facture</span><span>${fmt(total)} FCFA</span></p></div></div><p class="footer">Merci pour votre visite.</p><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function printDayClosure() {
  const reportDateStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(reportDateStr, currentSiteId());
  if (!closed) { showToast("Aucune clôture enregistrée pour la journée affichée."); return; }
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
      ? `<h3 style="margin-top:10px;padding-top:8px;border-top:1px solid #ddd">Caisse espèces</h3>
      <div class="box-row"><span>Ouverture</span><strong>${fmt(closed.openingCashFcfa)} FCFA</strong></div>
      ${typeof closed.closingCashFcfa === "number" ? `<div class="box-row"><span>Fermeture (dénombrement)</span><strong>${fmt(closed.closingCashFcfa)} FCFA</strong></div>` : ""}
      ${typeof closed.expectedEspecesCash === "number" ? `<div class="box-row"><span>Théorique caisse</span><strong>${fmt(closed.expectedEspecesCash)} FCFA</strong></div>` : ""}
      ${typeof closed.cashEcartEspeces === "number" ? `<div class="box-row" style="font-weight:700;color:${closed.cashEcartEspeces === 0 ? "#2a9d5c" : "#c0392b"}"><span>Écart espèces</span><strong>${closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)} FCFA`}</strong></div>` : ""}`
      : "";
  const cashHeaderExtra = typeof closed.openingCashFcfa === "number"
    ? `<br>Caisse esp. : ouv. ${fmt(closed.openingCashFcfa)} · ferm. ${typeof closed.closingCashFcfa === "number" ? fmt(closed.closingCashFcfa) : "-"} · écart ${typeof closed.cashEcartEspeces === "number" ? (closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)}`) : "-"}`
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
    const ecartMark = ci.ecart !== 0 ? ` <span style="color:#c0392b;font-size:9px">(écart ${ci.ecart > 0 ? "+" : ""}${fmt(ci.ecart)})</span>` : "";
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
  <title>Fiche de clôture ${formatDateDdMmYyyy(reportDateStr)}</title>
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
      <h1>${escapeHtml(site?.nom || "Maquis Manager")}</h1>
      <div style="font-size:10px;margin-top:2px">FICHE DE CONTROLE — ${dateLabel}</div>
    </div>
    <div class="meta">Clôture : ${generatedAt}<br>Gérant : ${escapeHtml(sessionUser || "-")}<br>Écarts stock : ${gaps}${cashHeaderExtra}</div>
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

  <div class="footer">${escapeHtml(site?.nom || "Maquis Manager")} &mdash; Fiche de clôture générée automatiquement &mdash; ${escapeHtml(formatDateDdMmYyyy(reportDateStr))}</div>
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
      <td>${escapeHtml(lineQtyLabel(vente, stockItemForArticle(vente.article)))}</td>
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
    const alert = isStockBelowArticleSeuilForAlert(actuel, item.seuilMin);
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
  if (id === "modal-saisie-rapide") { srCart = []; }
  if (id === "modal-casier-edit") pendingPurchaseCasierResume = false;
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
  consumePhysicalStock(item, qty);
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

function updateCasierMoveInfos() {
  const sel = document.getElementById("casier-move-article");
  const itemId = Number(sel?.value);
  const item = (state?.stock || []).find((i) => i.id === itemId) || null;
  const stockInfo = document.getElementById("casier-move-stock-info");
  const caseInfo = document.getElementById("casier-move-case-info");
  const preview = document.getElementById("casier-move-preview");
  const cases = Math.max(0, Math.floor(Number(document.getElementById("casier-move-cases")?.value) || 0));
  if (!item) {
    if (stockInfo) stockInfo.textContent = "";
    if (caseInfo) caseInfo.textContent = "—";
    if (preview) preview.textContent = "";
    return;
  }
  const cs = caseSize(item);
  const label = lotLabel(item);
  if (stockInfo) stockInfo.textContent = `Frigo: ${fmt(stockFrigo(item))} btl · Reserve: ${fmt(stockReserve(item))} btl · Total: ${fmt(stockActuel(item))} btl`;
  if (caseInfo) caseInfo.textContent = `${fmt(cs)} unité(s) / ${label}`;
  const bottles = cases > 0 ? cases * cs : 0;
  const mode = document.getElementById("casier-move-mode")?.value || "entree";
  if (preview) preview.textContent = bottles > 0 ? `${mode === "sortie" ? "-" : "+"}${fmt(cases)} ${label}(s) = ${fmt(bottles)} unité(s) pour "${item.article}".` : "";
}

function openCasierMoveModal(mode = "entree") {
  const title = document.getElementById("casier-move-title");
  const modeEl = document.getElementById("casier-move-mode");
  if (modeEl) modeEl.value = mode === "sortie" ? "sortie" : "entree";
  if (title) title.textContent = mode === "sortie" ? "Sortie de lots" : "Entrée de lots";

  const items = recordsForSite(state.stock).filter((i) => lotType(i) !== "unite").slice().sort((a, b) => String(a.article || "").localeCompare(String(b.article || ""), "fr"));
  const sel = document.getElementById("casier-move-article");
  if (sel) {
    sel.innerHTML = items.map((i) => `<option value="${i.id}">${escapeHtml(i.article)} (${fmt(stockActuel(i))} btl)</option>`).join("");
  }
  const casesEl = document.getElementById("casier-move-cases");
  const notesEl = document.getElementById("casier-move-notes");
  if (casesEl) casesEl.value = "";
  if (notesEl) notesEl.value = "";
  updateCasierMoveInfos();
  openModal("modal-casier-move");
  window.requestAnimationFrame(() => casesEl?.focus());
}

async function submitCasierMove() {
  const mode = document.getElementById("casier-move-mode")?.value || "entree";
  const itemId = Number(document.getElementById("casier-move-article")?.value);
  const cases = Math.max(0, Math.floor(Number(document.getElementById("casier-move-cases")?.value) || 0));
  const notes = String(document.getElementById("casier-move-notes")?.value || "").trim();
  if (!itemId) { showToast("Choisissez un article."); return; }
  if (cases <= 0) { showToast("Entrez un nombre de casiers valide."); return; }
  const item = state.stock.find((i) => i.id === itemId);
  if (!item) return;
  const cs = caseSize(item);
  const bottles = cases * cs;

  if (!state.nextId) state.nextId = {};

  if (mode === "sortie") {
    if (bottles > stockActuel(item)) {
      showToast(`Stock insuffisant (${fmt(stockActuel(item))} btl disponibles).`);
      return;
    }
    item.sorties = (Number(item.sorties) || 0) + bottles;
    consumePhysicalStock(item, bottles);
    item.lastSortieAt = new Date().toISOString();
    item.lastSortieBy = sessionUser || "-";

    state.stockLosses = state.stockLosses || [];
    if (state.nextId.stockLoss == null || Number.isNaN(Number(state.nextId.stockLoss))) {
      const maxL = state.stockLosses.reduce((m, l) => Math.max(m, Number(l.id) || 0), 0);
      state.nextId.stockLoss = Math.max(100, maxL + 1);
    }
    state.stockLosses.push({
      id: state.nextId.stockLoss++,
      siteId: currentSiteId(),
      article: item.article,
      qty: bottles,
      cases,
      caseSize: cs,
      motif: "Sortie casiers",
      notes,
      date: today(),
      createdAt: new Date().toISOString(),
      createdBy: sessionUser || "-",
    });
    recordStaffAudit("create", "casiers_sortie", `Sortie casiers · ${item.article}`, `${fmt(cases)} cas. x ${fmt(cs)} btl · ${fmt(bottles)} btl${notes ? ` · ${notes}` : ""}`);
    await persistState({ stock: state.stock, nextId: state.nextId, stockLosses: state.stockLosses });
    closeModal("modal-casier-move");
    renderStock();
    renderCasiers();
    renderDashboard();
    showToast(`-${fmt(cases)} casier(s) (${fmt(bottles)} btl) pour "${item.article}".`);
    return;
  }

  item.entrees = (Number(item.entrees) || 0) + bottles;
  item.reserve = stockReserve(item) + bottles;
  item.lastReapproAt = new Date().toISOString();
  item.lastReapproBy = sessionUser || "-";

  state.stockEntrees = state.stockEntrees || [];
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
    caseSize: cs,
    qty: bottles,
    user: sessionUser || "-",
    notes,
    source: "casiers",
  });
  recordStaffAudit("create", "casiers_entree", `Entree casiers · ${item.article}`, `${fmt(cases)} cas. x ${fmt(cs)} btl · ${fmt(bottles)} btl${notes ? ` · ${notes}` : ""}`);
  await persistState({ stock: state.stock, nextId: state.nextId, stockEntrees: state.stockEntrees });
  closeModal("modal-casier-move");
  renderStock();
  renderCasiers();
  renderDashboard();
  showToast(`+${fmt(cases)} casier(s) (${fmt(bottles)} btl) pour "${item.article}".`);
}

/* ===========================================================
 * MODULE CASIERS PHYSIQUES (CAS-XXXX)
 * =========================================================== */

const LS_CASIERS_KEY = "cda_casiers_v1";
const LS_CASIER_MVT_KEY = "cda_casierMouvements_v1";

function lsSaveCasiers() {
  try {
    localStorage.setItem(LS_CASIERS_KEY, JSON.stringify(state.casiers || []));
    localStorage.setItem(LS_CASIER_MVT_KEY, JSON.stringify(state.casierMouvements || []));
  } catch (e) { /* quota plein ou mode privé */ }
}

function lsRestoreCasiers() {
  try {
    if (!state.nextId) state.nextId = {};
    const rawC = localStorage.getItem(LS_CASIERS_KEY);
    const rawM = localStorage.getItem(LS_CASIER_MVT_KEY);
    if (rawC) {
      const list = JSON.parse(rawC);
      if (Array.isArray(list) && list.length) {
        state.casiers = list;
        const maxId = list.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
        if (!state.nextId.casier || state.nextId.casier <= maxId) state.nextId.casier = maxId + 1;
      }
    }
    if (rawM) {
      const list = JSON.parse(rawM);
      if (Array.isArray(list) && list.length) {
        state.casierMouvements = list;
        const maxId = list.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
        if (!state.nextId.casierMouvement || state.nextId.casierMouvement <= maxId) state.nextId.casierMouvement = maxId + 1;
      }
    }
  } catch (e) { /* localStorage corrompu */ }
}

let casierPhysFilters = { article: "", emplacement: "", statut: "all" };
let casierViewMode = "lots"; // "lots" | "physique"

function casiersForSite(sourceState = state) {
  const list = Array.isArray(sourceState?.casiers) ? sourceState.casiers : [];
  return list.filter((c) => rowMatchesSite(c, currentSiteId(), multiSiteActive()));
}

function casiersConsignesForSite(sourceState = state) {
  return casiersForSite(sourceState).filter((c) => {
    const key = String(c.article || "").trim().toLowerCase();
    if (!key) return true;

    // Certains casiers physiques stockent la "brasserie" directement (pas un article du stock).
    // Si on ne trouve aucun article catalogue correspondant, on conserve.
    const siteId = currentSiteId();
    const multi = multiSiteActive();
    const matches = (state.stock || []).filter((it) =>
      rowMatchesSite(it, siteId, multi) && String(it.article || "").trim().toLowerCase() === key
    );
    if (!matches.length) return true;

    // Si au moins un match du site courant est un "casier", on conserve (consigné).
    if (matches.some((it) => lotType(it) === "casier")) return true;

    // Sinon (carton / unité), ce casier ne doit pas apparaître dans "casiers physiques".
    return false;
  });
}

async function cleanupCartonCasiers({ confirmFirst = true } = {}) {
  if (!canAnyAdmin()) { showToast("Reserve aux administrateurs."); return; }
  const before = Array.isArray(state.casiers) ? state.casiers.slice() : [];
  if (!before.length) { showToast("Aucun casier a nettoyer."); return; }
  const siteId = currentSiteId();
  const multi = multiSiteActive();
  const isForSite = (c) => rowMatchesSite(c, siteId, multi);
  const siteRows = before.filter(isForSite);

  // Un casier est "carton" si son article existe dans le catalogue et qu'aucune occurrence n'est lotType=casier.
  const isWrong = (c) => {
    const key = String(c.article || "").trim().toLowerCase();
    if (!key) return false;
    const matches = (state.stock || []).filter((it) =>
      rowMatchesSite(it, siteId, multi) && String(it.article || "").trim().toLowerCase() === key
    );
    if (!matches.length) return false; // casier par brasserie ou article absent → ne pas supprimer
    return !matches.some((it) => lotType(it) === "casier");
  };

  const toRemove = siteRows.filter(isWrong);
  if (!toRemove.length) { showToast("Aucun casier 'carton' detecte."); return; }

  if (confirmFirst) {
    const sample = toRemove.slice(0, 8).map((c) => `${c.code || "CAS-?"} · ${c.article || "—"}`).join("\n");
    if (!window.confirm(
      `Supprimer ${toRemove.length} casier(s) lies a des articles en CARTON/UNITE ?\n\n` +
      `Exemples:\n${sample}${toRemove.length > 8 ? "\n…" : ""}\n\n` +
      `Cette action nettoie les erreurs anciennes (stocke localement).`
    )) return;
  }

  const removeIds = new Set(toRemove.map((c) => String(c.id)));
  state.casiers = before.filter((c) => !isForSite(c) || !removeIds.has(String(c.id)));
  lsSaveCasiers();
  try { await persistState({ casiers: state.casiers }); } catch {}
  renderCasierPhysique();
  renderDashboard();
  showToast(`${toRemove.length} casier(s) 'carton' supprime(s).`);
}

function casierMouvementsForSite(sourceState = state) {
  const list = Array.isArray(sourceState?.casierMouvements) ? sourceState.casierMouvements : [];
  return list.filter((c) => rowMatchesSite(c, currentSiteId(), multiSiteActive()));
}

function recomputeCasierStatus(casier) {
  if (!casier) return casier;
  const cap = Math.max(1, Number(casier.capacite) || 1);
  const qty = Math.max(0, Number(casier.quantiteActuelle) || 0);
  if (qty >= cap) {
    casier.statut = "plein";
  } else if (qty > 0) {
    casier.statut = "partiel";
  } else {
    // qty = 0 : conserver "retourne" si déjà positionné (casier rendu au fournisseur)
    if (String(casier.statut || "").toLowerCase() !== "retourne") casier.statut = "vide";
  }
  return casier;
}

function casierStatutBadge(casier) {
  const st = String(casier?.statut || "vide").toLowerCase();
  if (st === "plein") return `<span class="badge badge-green">Plein</span>`;
  if (st === "partiel") return `<span class="badge badge-amber">Partiel</span>`;
  if (st === "retourne") return `<span class="badge badge-gray">Retourné</span>`;
  return `<span class="badge badge-red">Vide</span>`;
}

function nextCasierCode() {
  state.casiers = state.casiers || [];
  state.nextId = state.nextId || {};
  let n = Math.max(1, Number(state.nextId.casier) || 1);
  const usedCodes = new Set(state.casiers.map((c) => String(c.code || "").toUpperCase()));
  let code;
  do {
    code = `CAS-${String(n).padStart(4, "0")}`;
    n += 1;
  } while (usedCodes.has(code));
  state.nextId.casier = n;
  return code;
}

function findCasierById(id) {
  return (state.casiers || []).find((c) => Number(c.id) === Number(id)) || null;
}

function findCasierByCode(code) {
  const norm = String(code || "").trim().toUpperCase();
  if (!norm) return null;
  return (state.casiers || []).find((c) => String(c.code || "").toUpperCase() === norm) || null;
}

function preferredCasierCapacityForBrasserie(brasserie, siteId = currentSiteId()) {
  const b = normalizeBrasserieName(brasserie);
  const items = recordsForSite(state.stock || []).filter((it) => normalizeBrasserieName(it.brasserie) === b);
  if (!items.length) return 24;
  const counts = {};
  items.forEach((it) => {
    const cs = Math.max(1, Number(caseSize(it)) || 24);
    counts[cs] = (counts[cs] || 0) + 1;
  });
  const best = Object.entries(counts).sort((a, b2) => b2[1] - a[1])[0];
  return best ? Number(best[0]) : 24;
}

function casiersForBrasserie(brasserie, siteId = currentSiteId()) {
  const b = normalizeBrasserieName(brasserie);
  return (state.casiers || []).filter((c) => rowMatchesSite(c, siteId, multiSiteActive()))
    .filter((c) => normalizeBrasserieName(c.article) === b);
}

function fillBrasserieCasiers(brasserie, bottles, { source = "vente", commentaire = "" } = {}) {
  const b = normalizeBrasserieName(brasserie) || "Sans brasserie";
  let remaining = Math.max(0, Math.floor(Number(bottles) || 0));
  if (remaining <= 0) return { filled: 0, created: 0 };
  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casier || Number.isNaN(Number(state.nextId.casier))) state.nextId.casier = 1;
  if (!state.nextId.casierMouvement || Number.isNaN(Number(state.nextId.casierMouvement))) state.nextId.casierMouvement = 1;

  const all = casiersForBrasserie(b).slice();
  // Remplir dans l'ordre des codes CAS-XXXX : on complète le premier casier disponible,
  // puis on passe au suivant quand il est plein.
  all.sort((a, b2) => String(a.code || "").localeCompare(String(b2.code || ""), "fr"));

  let filled = 0;
  let created = 0;
  const now = new Date().toISOString();
  for (const c of all) {
    if (remaining <= 0) break;
    const cap = Math.max(1, Number(c.capacite) || 24);
    const cur = Math.max(0, Number(c.quantiteActuelle) || 0);
    const free = cap - cur;
    if (free <= 0) continue;
    const add = Math.min(free, remaining);
    const before = { quantiteActuelle: cur };
    c.quantiteActuelle = cur + add;
    recomputeCasierStatus(c);
    c.lastMoveAt = now;
    c.lastMoveBy = sessionUser || "system";
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId: currentSiteId(),
      casierId: c.id,
      casierCode: c.code,
      article: c.article,
      type: "entree",
      quantite: add,
      source,
      motif: "",
      commentaire,
      user: sessionUser || "system",
      role: currentRole || "-",
      date: today(),
      createdAt: now,
    });
    logCasierAudit("create", c, before, null, null, add, { type: "ENTREE", label: "Remplissage casier", source, commentaire, entity: "casier_entree" });
    remaining -= add;
    filled += add;
  }

  // Si pas assez de place, on n'auto-crée pas : il faut créer des casiers manuellement (objectif du module).
  if (remaining > 0) {
    recordStaffAudit(
      "create",
      "casier_entree",
      `Remplissage casiers (incomplet) · ${b}`,
      `${fmt(filled)} btl affectée(s) · ${fmt(remaining)} btl non affectée(s) (pas assez de casiers disponibles)${commentaire ? ` · ${commentaire}` : ""}`,
    );
  }
  return { filled, created };
}

function drainArticleCasiers(article, bottles, opts = {}) {
  if (!article || bottles <= 0) return;
  const siteId = currentSiteId();
  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement || Number.isNaN(Number(state.nextId.casierMouvement))) state.nextId.casierMouvement = 1;
  const artNorm = String(article || "").toLowerCase();
  const stockIt = stockItemForArticle(article);
  const brasNorm = normalizeBrasserieName(stockIt?.brasserie).toLowerCase();
  const matching = state.casiers
    .filter((c) => {
      if (c.siteId !== siteId || (Number(c.quantiteActuelle) || 0) <= 0) return false;
      const cn = String(c.article || "").toLowerCase();
      return cn === artNorm || (brasNorm && cn === brasNorm);
    })
    .sort((a, b) => (Number(a.quantiteActuelle) || 0) - (Number(b.quantiteActuelle) || 0));
  let remaining = bottles;
  const now = new Date().toISOString();
  for (const c of matching) {
    if (remaining <= 0) break;
    const cur = Math.max(0, Number(c.quantiteActuelle) || 0);
    const take = Math.min(cur, remaining);
    if (take <= 0) continue;
    const cap = Math.max(1, Number(c.capacite) || 24);
    c.quantiteActuelle = cur - take;
    recomputeCasierStatus(c);
    distributeVidesEnCasiers(c.article, cap, take, now, opts);
    c.lastMoveAt = now;
    c.lastMoveBy = sessionUser || "system";
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId,
      casierId: c.id,
      casierCode: c.code,
      article: c.article,
      type: "sortie",
      quantite: take,
      source: "",
      motif: opts.motif || "vente",
      commentaire: opts.commentaire || "",
      user: sessionUser || "system",
      role: currentRole || "-",
      date: today(),
      createdAt: now,
    });
    remaining -= take;
  }
}

function distributeVidesEnCasiers(article, cap, bottles, now, opts = {}) {
  if (!article || bottles <= 0) return;
  const siteId = currentSiteId();
  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement) state.nextId.casierMouvement = 1;
  if (!state.nextId.casier) state.nextId.casier = 1;
  const ts = now || new Date().toISOString();
  let remaining = bottles;
  // Brasserie de l'article source (les casiers de collecte dépendent du format+brasserie, pas de l'article)
  const srcBr = normalizeBrasserieName(stockItemForArticle(article)?.brasserie || "");

  // Remplir les casiers de collecte existants (vide, même brasserie+format, non retournés), les plus remplis en premier
  const collectors = state.casiers.filter((c) => {
    const cBr = normalizeBrasserieName(stockItemForArticle(c.article)?.brasserie || "");
    return c.siteId === siteId &&
      (srcBr ? cBr === srcBr : String(c.article || "").toLowerCase() === String(article || "").toLowerCase()) &&
      Math.max(1, Number(c.capacite) || 24) === cap &&
      (Number(c.quantiteActuelle) || 0) === 0 &&
      String(c.statut || "").toLowerCase() !== "retourne";
  }).sort((a, b) => (Number(b.bouteillesVides) || 0) - (Number(a.bouteillesVides) || 0));

  for (const c of collectors) {
    if (remaining <= 0) break;
    const current = Math.max(0, Number(c.bouteillesVides) || 0);
    const free = cap - current;
    if (free <= 0) continue;
    const add = Math.min(free, remaining);
    c.bouteillesVides = current + add;
    recomputeCasierStatus(c);
    c.lastMoveAt = ts;
    c.lastMoveBy = sessionUser || "system";
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId, casierId: c.id, casierCode: c.code, article: c.article,
      type: "collecte_vide", quantite: add, source: "",
      motif: opts.motif || "vente",
      commentaire: opts.commentaire || `Collecte ${add} btl vide(s) B${cap}`,
      user: sessionUser || "system", role: currentRole || "-",
      date: today(), createdAt: ts,
    });
    remaining -= add;
  }

  // Si pas assez de casiers de collecte disponibles → créer un nouveau casier de collecte
  while (remaining > 0) {
    const fill = Math.min(cap, remaining);
    const code = nextCasierCode();
    const newCasier = {
      id: state.nextId.casier++, siteId, code, article,
      capacite: cap, quantiteActuelle: 0, bouteillesVides: fill,
      emplacement: "À retourner", statut: "vide",
      createdAt: ts, createdBy: sessionUser || "system",
      lastMoveAt: ts, lastMoveBy: sessionUser || "system",
    };
    state.casiers.push(newCasier);
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId, casierId: newCasier.id, casierCode: newCasier.code, article,
      type: "collecte_vide", quantite: fill, source: "",
      motif: opts.motif || "vente",
      commentaire: opts.commentaire || `Nouveau casier collecte B${cap}`,
      user: sessionUser || "system", role: currentRole || "-",
      date: today(), createdAt: ts,
    });
    remaining -= fill;
  }
}

function suggestReapproCasiers(article) {
  const item = stockItemForArticle(article);
  if (!item) return { manque: 0, casiers: 0 };
  const stock = stockActuel(item);
  const seuil = Math.max(0, Number(item.seuilMin) || 0);
  const target = seuil * 2;
  const manque = Math.max(0, target - stock);
  const cs = Math.max(1, caseSize(item));
  return { manque, casiers: Math.ceil(manque / cs) };
}

function canManageCasier() {
  return canManage();
}

function canMoveCasier() {
  return Boolean(sessionUser);
}

function normalizeBrasserieName(name) {
  return String(name || "").trim();
}

function brasserieForArticle(article, siteId = currentSiteId()) {
  const item = stockItemForArticle(article, siteId);
  const b = normalizeBrasserieName(item?.brasserie);
  return b || "Sans brasserie";
}

function logCasierAudit(verb, casier, before, item, beforeStock, qty, opts = {}) {
  const codeLabel = casier?.code || "CAS-?";
  const article = casier?.article || "?";
  const cap = Math.max(1, Number(casier?.capacite) || 1);
  const qBefore = Math.max(0, Number(before?.quantiteActuelle) || 0);
  const qAfter = Math.max(0, Number(casier?.quantiteActuelle) || 0);
  const lines = [];
  lines.push(`${codeLabel} · ${article} · ${String(opts.type || verb).toUpperCase()} · qty ${fmt(qty)}`);
  lines.push(`casier ${fmt(qBefore)} → ${fmt(qAfter)} (cap ${fmt(cap)} · ${casier?.statut || "?"})`);
  // Dans la logique "casiers par brasserie remplis par vente", les casiers ne modifient pas le stock.
  if (opts.source) lines.push(`source: ${opts.source}`);
  if (opts.motif) lines.push(`motif: ${opts.motif}`);
  if (opts.commentaire) lines.push(`note: ${opts.commentaire}`);
  recordStaffAudit(verb, opts.entity || "casier", `${codeLabel} · ${article} · ${opts.label || verb}`, lines.join("\n"));
}

async function syncCasiersFromStockEtVentes() {
  if (!canAnyAdmin()) { showToast("Réservé aux administrateurs."); return; }
  const siteId = currentSiteId();
  const eligible = recordsForSite(state.stock).filter((item) => lotType(item) === "casier");
  if (!eligible.length) { showToast("Aucun article en stock pour initialiser les casiers."); return; }

  let previewPleins = 0, previewVides = 0;
  eligible.forEach((item) => {
    const cap = Math.max(1, caseSize(item));
    previewPleins += Math.ceil(Math.max(0, stockActuel(item)) / cap);
    previewVides  += Math.ceil(Math.max(0, Number(item.sorties) || 0) / cap);
  });

  if (!confirm(
    `Créer les casiers depuis le stock et les ventes ?\n\n` +
    `  • ${previewPleins} casier(s) PLEINS  (stock actuel)\n` +
    `  • ${previewVides} casier(s) VIDES   (bouteilles vendues)\n\n` +
    `Les casiers existants de ce site seront remplacés.`
  )) return;

  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.casier) state.nextId.casier = 1;

  // Supprimer les casiers du site courant
  state.casiers = state.casiers.filter((c) => !rowMatchesSite(c, siteId, multiSiteActive()));

  const now = new Date().toISOString();
  let createdPleins = 0, createdVides = 0;

  eligible.forEach((item) => {
    const cap = Math.max(1, caseSize(item));

    // --- Casiers PLEINS (stock actuel) ---
    const stockBtl = Math.max(0, stockActuel(item));
    if (stockBtl > 0) {
      const fullCount = Math.floor(stockBtl / cap);
      const remainder = stockBtl % cap;
      for (let i = 0; i < fullCount; i++) {
        const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
          capacite: cap, quantiteActuelle: cap, bouteillesVides: 0,
          emplacement: "Réserve", statut: "plein", createdAt: now, createdBy: sessionUser || "-", autoInitialized: true };
        recomputeCasierStatus(c);
        state.casiers.push(c);
        createdPleins++;
      }
      if (remainder > 0) {
        const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
          capacite: cap, quantiteActuelle: remainder, bouteillesVides: 0,
          emplacement: "Réserve", statut: "partiel", createdAt: now, createdBy: sessionUser || "-", autoInitialized: true };
        recomputeCasierStatus(c);
        state.casiers.push(c);
        createdPleins++;
      }
    }

    // --- Casiers VIDES (bouteilles vendues, à retourner fournisseur) ---
    const sorties = Math.max(0, Number(item.sorties) || 0);
    if (sorties > 0) {
      const fullVides = Math.floor(sorties / cap);
      const remainderVides = sorties % cap;
      for (let i = 0; i < fullVides; i++) {
        const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
          capacite: cap, quantiteActuelle: 0, bouteillesVides: cap,
          emplacement: "À retourner", statut: "vide", createdAt: now, createdBy: sessionUser || "-", autoInitialized: true };
        recomputeCasierStatus(c);
        state.casiers.push(c);
        createdVides++;
      }
      if (remainderVides > 0) {
        const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
          capacite: cap, quantiteActuelle: 0, bouteillesVides: remainderVides,
          emplacement: "À retourner", statut: "vide", createdAt: now, createdBy: sessionUser || "-", autoInitialized: true };
        recomputeCasierStatus(c);
        state.casiers.push(c);
        createdVides++;
      }
    }
  });

  lsSaveCasiers();
  recordStaffAudit("create", "casier_sync",
    `Sync casiers: ${createdPleins} pleins · ${createdVides} vides`,
    `Initialisation depuis stock actuel et ventes totales du site.`
  );
  try {
    await persistState({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  } catch (e) { lsSaveCasiers(); }
  renderCasiers();
  showToast(`${fmt(createdPleins + createdVides)} casier(s) créé(s) : ${fmt(createdPleins)} plein(s) · ${fmt(createdVides)} vide(s)`);
}

async function ensurePhysicalCasiersFromReserve() {
  if (!state || !Array.isArray(state.stock)) return;
  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  if (state.casiers.length > 0) return;
  const eligible = (state.stock || []).filter((item) => {
    if (lotType(item) === "unite") return false;
    if (!item.siteId) return true;
    return true;
  });
  let created = 0;
  eligible.forEach((item) => {
    const reserve = stockReserve(item);
    if (reserve <= 0) return;
    const cap = Math.max(1, caseSize(item));
    const fullCount = Math.floor(reserve / cap);
    const remainder = reserve - fullCount * cap;
    for (let i = 0; i < fullCount; i++) {
      const code = nextCasierCode();
      state.casiers.push({
        id: state.nextId.casier++,
        siteId: item.siteId || currentSiteId(),
        code,
        article: item.article,
        capacite: cap,
        quantiteActuelle: cap,
        emplacement: "À ranger",
        statut: "plein",
        createdAt: new Date().toISOString(),
        createdBy: sessionUser || "-",
        autoInitialized: true,
      });
      created++;
    }
    if (remainder > 0) {
      const code = nextCasierCode();
      state.casiers.push({
        id: state.nextId.casier++,
        siteId: item.siteId || currentSiteId(),
        code,
        article: item.article,
        capacite: cap,
        quantiteActuelle: remainder,
        emplacement: "À ranger",
        statut: "partiel",
        createdAt: new Date().toISOString(),
        createdBy: sessionUser || "-",
        autoInitialized: true,
      });
      created++;
    }
  });
  if (created > 0) {
    recordStaffAudit("create", "casier_init", `Initialisation casiers physiques (${created})`, `Création automatique de ${created} casier(s) à partir de la réserve actuelle.`);
    try {
      await persistState({ casiers: state.casiers, nextId: state.nextId });
    } catch (e) {
      console.warn("ensurePhysicalCasiersFromReserve: persist failed", e);
    }
  }
}

function snapshotItemStock(item) {
  if (!item) return { frigo: 0, reserve: 0, total: 0 };
  return { frigo: stockFrigo(item), reserve: stockReserve(item), total: stockActuel(item) };
}

async function createCasier({ article, capacite, emplacement, quantiteActuelle = 0, bouteillesVides = 0 }) {
  if (!canManageCasier()) {
    showToast("Reserve au gerant ou administrateur.");
    return null;
  }
  const brasserie = normalizeBrasserieName(article);
  if (!brasserie) { showToast("Choisissez une brasserie."); return null; }
  const cap = Math.max(1, Math.floor(Number(capacite) || 0));
  if (cap <= 0) { showToast("Capacite invalide."); return null; }
  const qty0 = Math.max(0, Math.floor(Number(quantiteActuelle) || 0));
  const vides0 = Math.max(0, Math.floor(Number(bouteillesVides) || 0));
  if (qty0 > cap) { showToast(`Quantite initiale (${qty0}) > capacite (${cap}).`); return null; }
  if (vides0 > cap) { showToast(`Bouteilles vides (${vides0}) > capacite (${cap}).`); return null; }
  state.casiers = state.casiers || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement) state.nextId.casierMouvement = 1;
  const code = nextCasierCode();
  const now = new Date().toISOString();
  const casier = {
    id: state.nextId.casier++,
    siteId: currentSiteId(),
    code,
    article: brasserie,
    capacite: cap,
    quantiteActuelle: qty0,
    bouteillesVides: vides0,
    emplacement: String(emplacement || "").trim() || "—",
    statut: "vide",
    createdAt: now,
    createdBy: sessionUser || "-",
  };
  recomputeCasierStatus(casier);
  state.casiers.push(casier);
  state.casierMouvements = state.casierMouvements || [];
  if (qty0 > 0) {
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId: currentSiteId(), casierId: casier.id, casierCode: casier.code, article: casier.article,
      type: "entree", quantite: qty0, source: "correction", motif: "",
      commentaire: "Quantite initiale (creation casier)",
      user: sessionUser || "-", role: currentRole || "-", date: today(), createdAt: now,
    });
    casier.lastMoveAt = now;
    casier.lastMoveBy = sessionUser || "-";
  }
  if (vides0 > 0) {
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId: currentSiteId(), casierId: casier.id, casierCode: casier.code, article: casier.article,
      type: "retour_vide", quantite: vides0, nbCasiers: Math.floor(vides0 / cap),
      source: "", motif: "retour_fournisseur",
      commentaire: `${vides0} btl vides (saisie initiale)`,
      user: sessionUser || "-", role: currentRole || "-", date: today(), createdAt: now,
    });
    casier.lastMoveAt = now;
    casier.lastMoveBy = sessionUser || "-";
  }
  logCasierAudit("create", casier, { quantiteActuelle: 0 }, null, null, qty0, {
    type: "CREATE",
    label: vides0 > 0 ? "Nouveau casier vide" : "Nouveau casier",
    source: qty0 > 0 ? "correction" : "",
    commentaire: [emplacement ? `emplacement: ${emplacement}` : "", vides0 > 0 ? `${vides0} btl vides` : ""].filter(Boolean).join(" · "),
    entity: "casier",
  });
  await persistState({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  return casier;
}

async function casierEntree(casierId, qty, { source = "fournisseur", commentaire = "" } = {}) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return false; }
  const casier = findCasierById(casierId);
  if (!casier) { showToast("Casier introuvable."); return false; }
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) { showToast("Quantite invalide."); return false; }
  const cap = Math.max(1, Number(casier.capacite) || 1);
  const current = Math.max(0, Number(casier.quantiteActuelle) || 0);
  if (current + q > cap) {
    showToast(`Capacite depassee (${cap}). Disponible: ${cap - current}.`);
    return false;
  }
  const before = JSON.parse(JSON.stringify(casier));

  casier.quantiteActuelle = current + q;
  recomputeCasierStatus(casier);
  casier.lastMoveAt = new Date().toISOString();
  casier.lastMoveBy = sessionUser || "-";

  state.casierMouvements = state.casierMouvements || [];
  state.casierMouvements.unshift({
    id: state.nextId.casierMouvement++,
    siteId: currentSiteId(),
    casierId: casier.id,
    casierCode: casier.code,
    article: casier.article,
    type: "entree",
    quantite: q,
    source: String(source || "autre"),
    motif: "",
    commentaire: String(commentaire || ""),
    user: sessionUser || "-",
    role: currentRole || "-",
    date: today(),
    createdAt: new Date().toISOString(),
  });
  logCasierAudit("create", casier, before, null, null, q, {
    type: "ENTREE",
    label: "Entree casier",
    source,
    commentaire,
    entity: "casier_entree",
  });
  await persistState({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  return true;
}

/** Articles catalogue alignés avec un casier (SKU direct ou même brasserie + format). */
function stockCandidatesForCasierFrigoTransfer(casier) {
  if (!casier) return [];
  const cap = Math.max(1, Number(casier.capacite) || 24);
  const label = String(casier.article || "").trim();
  const directMatch = recordsForSite(state.stock).find((it) =>
    lotType(it) !== "unite"
    && String(it.article || "").toLowerCase() === label.toLowerCase()
  );
  if (directMatch) return [directMatch];
  const br = normalizeBrasserieName(label);
  return recordsForSite(state.stock)
    .filter((it) => lotType(it) !== "unite"
      && normalizeBrasserieName(it.brasserie) === br
      && (caseSize(it) || 24) === cap)
    .sort((a, b) => stockReserve(b) - stockReserve(a));
}

/**
 * Répartition reserve → frigo pour une sortie casier motif frigo (conserve stock total = frigo + reserve).
 * Retour { ok, msg?, allocations: { itemId, article, take }[] }
 */
function buildCasierToFrigoStockPlan(casier, qtyBottles) {
  const candidates = stockCandidatesForCasierFrigoTransfer(casier);
  if (!candidates.length) {
    const capHint = Math.max(1, Number(casier.capacite) || 24);
    return {
      ok: false,
      msg: `Aucun article catalogue lie (${String(casier.article || "?")}, B${capHint}). Pas de mise a jour frigo.`,
    };
  }
  candidates.forEach((it) => normalizePhysicalStock(it));
  const pool = candidates.reduce((sum, it) => sum + stockReserve(it), 0);
  const qty = Math.max(0, Math.floor(Number(qtyBottles) || 0));
  if (pool < qty) {
    return {
      ok: false,
      msg: `Réserve catalogue insuffisante : ${fmt(qty)} btl demandées, ${fmt(pool)} disponible(s). Ajustez frigo/réserve ou diminuez la quantité.`,
    };
  }
  const allocations = [];
  let remaining = qty;
  for (const it of candidates) {
    if (remaining <= 0) break;
    normalizePhysicalStock(it);
    const take = Math.min(remaining, stockReserve(it));
    if (take <= 0) continue;
    allocations.push({ itemId: it.id, article: it.article, take });
    remaining -= take;
  }
  if (remaining > 0) {
    return { ok: false, msg: "Impossible de repartir la reserve sur les articles catalogue." };
  }
  return { ok: true, allocations };
}

function applyCasierToFrigoStockPlan(plan) {
  if (!plan?.ok || !Array.isArray(plan.allocations)) return;
  const now = new Date().toISOString();
  const actor = sessionUser || "-";
  plan.allocations.forEach(({ itemId, take }) => {
    const item = (state.stock || []).find((i) => Number(i.id) === Number(itemId));
    if (!item || take <= 0) return;
    normalizePhysicalStock(item);
    item.reserve = stockReserve(item) - take;
    item.frigo = stockFrigo(item) + take;
    item.lastReapproAt = now;
    item.lastReapproBy = actor;
  });
}

async function casierSortie(casierId, qty, { motif = "autre", commentaire = "" } = {}) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return false; }
  const casier = findCasierById(casierId);
  if (!casier) { showToast("Casier introuvable."); return false; }
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) { showToast("Quantite invalide."); return false; }
  const current = Math.max(0, Number(casier.quantiteActuelle) || 0);
  if (q > current) {
    showToast(`Stock insuffisant dans le casier (${current}).`);
    return false;
  }
  const motifKey = String(motif || "autre").trim().toLowerCase();
  let frigoPlan = null;
  if (motifKey === "frigo") {
    frigoPlan = buildCasierToFrigoStockPlan(casier, q);
    if (!frigoPlan.ok) {
      showToast(frigoPlan.msg || "Transfert frigo impossible.");
      return false;
    }
  }
  const before = JSON.parse(JSON.stringify(casier));

  casier.quantiteActuelle = current - q;
  recomputeCasierStatus(casier);
  casier.lastMoveAt = new Date().toISOString();
  casier.lastMoveBy = sessionUser || "-";

  state.casierMouvements = state.casierMouvements || [];
  state.casierMouvements.unshift({
    id: state.nextId.casierMouvement++,
    siteId: currentSiteId(),
    casierId: casier.id,
    casierCode: casier.code,
    article: casier.article,
    type: "sortie",
    quantite: q,
    source: "",
    motif: String(motif || "autre"),
    commentaire: String(commentaire || ""),
    user: sessionUser || "-",
    role: currentRole || "-",
    date: today(),
    createdAt: new Date().toISOString(),
  });
  logCasierAudit("create", casier, before, null, null, q, {
    type: "SORTIE",
    label: "Sortie casier",
    motif,
    commentaire,
    entity: "casier_sortie",
  });
  if (frigoPlan && frigoPlan.ok) {
    applyCasierToFrigoStockPlan(frigoPlan);
    const stamp = `${casier.code} · ${fmt(q)} btl`;
    const detail = frigoPlan.allocations.map((a) =>
      `${a.article}: ${fmt(a.take)} btl rés. → frigo`).join("\n");
    recordStaffAudit("update", "frigo", `Casier vers frigo · ${stamp}`, detail || stamp);
  }
  await persistState({
    casiers: state.casiers,
    casierMouvements: state.casierMouvements,
    nextId: state.nextId,
    ...(frigoPlan && frigoPlan.ok ? { stock: state.stock } : {}),
  });
  return true;
}

async function deleteCasier(casierId) {
  if (!canManageCasier()) { showToast("Reserve au gerant ou administrateur."); return false; }
  const casier = findCasierById(casierId);
  if (!casier) return false;
  if ((Number(casier.quantiteActuelle) || 0) > 0) {
    showToast("Casier non vide : videz-le avant de le supprimer.");
    return false;
  }
  if ((Number(casier.bouteillesVides) || 0) > 0) {
    showToast("Des bouteilles vides sont encore dans ce casier. Retournez-les au fournisseur d'abord.");
    return false;
  }
  if (!window.confirm(`Supprimer le casier ${casier.code} (${casier.article}) ?`)) return false;
  state.casiers = (state.casiers || []).filter((c) => Number(c.id) !== Number(casierId));
  recordStaffAudit("delete", "casier", `Suppression casier ${casier.code}`, `${casier.code} · ${casier.article} · emplacement ${casier.emplacement || "-"}`);
  await persistState({ casiers: state.casiers });
  return true;
}

async function retourVidesGroupeBrasserie(br, cap, nbCasiers) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return 0; }
  const matchingVides = casiersForSite().filter((c) => {
    const stockIt = stockItemForArticle(c.article);
    const cBr = normalizeBrasserieName(stockIt?.brasserie || "");
    return cBr === br &&
      Math.max(1, Number(c.capacite) || 1) === cap &&
      (Number(c.quantiteActuelle) || 0) === 0 &&
      (Number(c.bouteillesVides) || 0) > 0;
  }).slice(0, nbCasiers);
  return _retourVidesLot(matchingVides, cap, `${br} B${cap}`);
}

async function _retourVidesLot(matchingVides, cap, label) {
  if (!matchingVides.length) { showToast("Aucun casier de vides trouvé."); return 0; }
  const siteId = currentSiteId();
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement) state.nextId.casierMouvement = 1;
  const now = new Date().toISOString();
  let processed = 0;
  for (const casier of matchingVides) {
    const vides = Math.max(0, Number(casier.bouteillesVides) || 0);
    if (vides < cap) continue; // pas assez de bouteilles vides pour un casier
    casier.bouteillesVides = Math.max(0, vides - cap);
    casier.statut = "retourne"; // rendu au fournisseur : plus retournable jusqu'à nouveau remplissage
    recomputeCasierStatus(casier); // recalcule selon qty mais préserve "retourne"
    casier.lastMoveAt = now;
    casier.lastMoveBy = sessionUser || "system";
    state.casierMouvements.unshift({
      id: state.nextId.casierMouvement++,
      siteId, casierId: casier.id, casierCode: casier.code, article: casier.article,
      type: "retour_vide", quantite: cap, nbCasiers: 1,
      source: "", motif: "retour_fournisseur",
      commentaire: `1 casier de ${fmt(cap)} btl vides`,
      user: sessionUser || "system", role: currentRole || "-",
      date: today(), createdAt: now,
    });
    processed++;
  }
  if (!processed) { showToast("Aucun casier traité."); return 0; }
  lsSaveCasiers();
  recordStaffAudit("create", "casier_retour_vide",
    `Retour ${label} : ${processed} casier(s)`,
    `${processed} casier(s) × ${cap} btl = ${processed * cap} btl vides retournées fournisseur`
  );
  await persistState({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  return processed;
}

async function retourVidesGroupe(article, cap, nbCasiers) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return 0; }
  const stockIt = stockItemForArticle(article);
  const br = normalizeBrasserieName(stockIt?.brasserie || "");
  const matchingVides = casiersForSite().filter((c) => {
    const cBr = normalizeBrasserieName(stockItemForArticle(c.article)?.brasserie || "");
    return (br ? cBr === br : c.article === article) &&
      Math.max(1, Number(c.capacite) || 1) === cap &&
      (Number(c.quantiteActuelle) || 0) === 0 &&
      (Number(c.bouteillesVides) || 0) > 0;
  }).slice(0, nbCasiers);
  return _retourVidesLot(matchingVides, cap, `${article} B${cap}`);
}

async function retourVidesCasier(casierId, qty) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return false; }
  const casier = findCasierById(casierId);
  if (!casier) { showToast("Casier introuvable."); return false; }
  const cap = Math.max(1, Number(casier.capacite) || 24);
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) { showToast("Quantité invalide."); return false; }
  const statutCasier = String(casier.statut || "").toLowerCase();
  const rawVides = Math.max(0, Number(casier.bouteillesVides) || 0);
  const vides = (statutCasier === "vide" && rawVides === 0) ? cap : rawVides;
  if (q > vides) { showToast(`Seulement ${fmt(vides)} bouteille(s) vide(s) dans ce casier.`); return false; }
  const nbCasiers = Math.floor(q / cap);
  casier.bouteillesVides = Math.max(0, vides - q);
  if (casier.bouteillesVides < cap) casier.statut = "retourne";
  recomputeCasierStatus(casier);
  casier.lastMoveAt = new Date().toISOString();
  casier.lastMoveBy = sessionUser || "system";
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement) state.nextId.casierMouvement = 1;
  state.casierMouvements.unshift({
    id: state.nextId.casierMouvement++,
    siteId: currentSiteId(),
    casierId: casier.id,
    casierCode: casier.code,
    article: casier.article,
    type: "retour_vide",
    quantite: q,
    nbCasiers,
    source: "",
    motif: "retour_fournisseur",
    commentaire: `${fmt(nbCasiers)} casier(s) de ${fmt(cap)} btl vides`,
    user: sessionUser || "system",
    role: currentRole || "-",
    date: today(),
    createdAt: new Date().toISOString(),
  });
  recordStaffAudit("create", "casier_retour_vide", `Retour ${casier.code} : ${fmt(nbCasiers)} casier(s) vide(s)`, `${fmt(nbCasiers)} casier(s) × ${fmt(cap)} btl = ${fmt(q)} btl vide(s) retournée(s) fournisseur`);
  await persistState({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  return true;
}

/* -----------------------------------------------------------
 * Rendu et UI Casiers physiques
 * ----------------------------------------------------------- */

function setCasierViewMode(mode) {
  casierViewMode = mode === "physique" ? "physique" : "lots";
  const lotsEl = document.getElementById("casier-view-lots");
  const lotsExtra = document.getElementById("casier-view-lots-extra");
  const physEl = document.getElementById("casier-view-physique");
  if (lotsEl) lotsEl.classList.toggle("hidden", casierViewMode !== "lots");
  if (lotsExtra) lotsExtra.classList.toggle("hidden", casierViewMode !== "lots");
  if (physEl) physEl.classList.toggle("hidden", casierViewMode !== "physique");
  document.querySelectorAll("[data-casier-view]").forEach((btn) => {
    const active = btn.dataset.casierView === casierViewMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (casierViewMode === "physique") renderCasierPhysique();
  else renderCasiers();
}

function renderCasierPhysique() {
  const list = document.getElementById("casier-phys-list");
  if (!list) return;
  const all = casiersConsignesForSite();
  const fArticle = String(casierPhysFilters.article || "").trim().toLowerCase();
  const fEmplacement = String(casierPhysFilters.emplacement || "").trim().toLowerCase();
  const fStatut = String(casierPhysFilters.statut || "all").toLowerCase();
  const filtered = all.filter((c) => {
    if (fArticle && !String(c.article || "").toLowerCase().includes(fArticle)) return false;
    if (fEmplacement && !String(c.emplacement || "").toLowerCase().includes(fEmplacement)) return false;
    if (fStatut !== "all" && String(c.statut || "").toLowerCase() !== fStatut) return false;
    return true;
  });
  // KPIs
  const kpis = { total: all.length, plein: 0, partiel: 0, vide: 0, btlVides: 0 };
  all.forEach((c) => {
    const st = String(c.statut || "vide").toLowerCase();
    if (st === "plein") kpis.plein++;
    else if (st === "partiel") kpis.partiel++;
    else kpis.vide++;
    kpis.btlVides += Math.max(0, Number(c.bouteillesVides) || 0);
  });
  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
  setText("casier-phys-kpi-total", fmt(kpis.total));
  setText("casier-phys-kpi-plein", fmt(kpis.plein));
  setText("casier-phys-kpi-partiel", fmt(kpis.partiel));
  setText("casier-phys-kpi-vide", fmt(kpis.vide));
  setText("casier-phys-kpi-btl-vides", fmt(kpis.btlVides));

  // Grouper par brasserie > format (capacité) — exclure les articles sans brasserie
  const byBr = {};
  filtered.forEach((c) => {
    const stockIt = stockItemForArticle(c.article);
    const rawBr = normalizeBrasserieName(stockIt?.brasserie || "");
    if (!rawBr) return; // ignorer les articles non rattachés à une brasserie
    const cap = Math.max(1, Number(c.capacite) || 24);
    if (!byBr[rawBr]) byBr[rawBr] = {};
    if (!byBr[rawBr][cap]) byBr[rawBr][cap] = { cap, pleins: 0, partiels: 0, vides: 0, btlPleines: 0, btlVides: 0, byArticle: {} };
    const g = byBr[rawBr][cap];
    const art = c.article || "—";
    if (!g.byArticle[art]) g.byArticle[art] = { article: art, pleins: 0, partiels: 0, vides: 0, btlPleines: 0, btlVides: 0 };
    const ag = g.byArticle[art];
    const st = String(c.statut || "vide").toLowerCase();
    if (st === "plein") { g.pleins++; ag.pleins++; }
    else if (st === "partiel") { g.partiels++; ag.partiels++; }
    else { g.vides++; ag.vides++; }
    const btlP = Math.max(0, Number(c.quantiteActuelle) || 0);
    const btlV = Math.max(0, Number(c.bouteillesVides) || 0);
    g.btlPleines += btlP; ag.btlPleines += btlP;
    g.btlVides += btlV;   ag.btlVides += btlV;
  });

  if (!Object.keys(byBr).length) {
    list.innerHTML = emptyState(
      all.length ? "Aucun casier ne correspond" : "Aucun casier physique",
      all.length ? "Ajustez les filtres ci-dessus." : "Cliquez sur '+ Nouveau casier' pour démarrer.",
    );
  } else {
    let html = "";
    Object.entries(byBr).sort(([a], [b]) => a.localeCompare(b, "fr")).forEach(([br, groups]) => {
      // trier par capacité décroissante (B24 avant B12)
      const entries = Object.entries(groups).sort(([a], [b]) => Number(b) - Number(a));
      const brTot = entries.reduce((t, [, g]) => {
        t.pleins += g.pleins; t.partiels += g.partiels; t.vides += g.vides;
        t.btlPleines += g.btlPleines; t.btlVides += g.btlVides; return t;
      }, { pleins: 0, partiels: 0, vides: 0, btlPleines: 0, btlVides: 0 });

      html += `<div style="margin-bottom:22px">
        <div style="background:#1565c0;color:#fff;padding:8px 14px;border-radius:8px 8px 0 0;display:flex;justify-content:space-between;align-items:center">
          <strong style="font-size:0.9rem;letter-spacing:0.04em">${escapeHtml(br)}</strong>
          <span style="font-size:0.78rem;opacity:0.9">
            <span style="color:#a5d6a7">${fmt(brTot.pleins)} plein(s)</span> ·
            <span style="color:#ffe082">${fmt(brTot.partiels)} partiel(s)</span> ·
            <span style="color:#ef9a9a">${fmt(brTot.vides)} vide(s)</span> ·
            <strong>${fmt(brTot.btlPleines)} btl pleines</strong>
            ${brTot.btlVides > 0 ? ` · <span style="color:#ffcc80">${fmt(brTot.btlVides)} btl vides</span>` : ""}
          </span>
        </div>
        <div class="stock-table-wrap" style="border:1.5px solid #e3f2fd;border-top:none;border-radius:0 0 8px 8px">
          <table class="stock-table" style="width:100%">
            <thead><tr>
              <th class="th-blue" style="text-align:center">Format / Article</th>
              <th class="th-blue" style="text-align:right">Cas. pleins</th>
              <th style="text-align:right;color:#f57c00">Cas. partiels</th>
              <th style="text-align:right;color:#e53935">Cas. vides</th>
              <th style="text-align:right;color:#e65100">Cas. retournables</th>
              <th class="th-blue" style="text-align:right">Btl pleines</th>
              <th class="th-amber" style="text-align:right">Btl vides</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${entries.map(([, g]) => {
                const fullVides = Math.floor(g.btlVides / g.cap);
                const enCoursFmt = g.btlVides % g.cap;
                const retourBtn = fullVides >= 1
                  ? `<button type="button" class="mini-btn" data-casier-grp-retour-br="${escapeHtml(br)}" data-casier-grp-retour-cap="${g.cap}" style="background:rgba(230,81,0,0.12);color:#e65100;font-weight:700">↩ Retourner ${fmt(fullVides)}</button>`
                  : enCoursFmt > 0 ? `<span style="color:#9e9e9e;font-size:0.75rem">${fmt(enCoursFmt)} btl en cours</span>` : "";
                const artRows = Object.entries(g.byArticle).sort(([a], [b]) => a.localeCompare(b, "fr")).map(([, ag]) => {
                  const retournables = Math.floor(ag.btlVides / g.cap);
                  const enCours = ag.btlVides % g.cap;
                  const retCell = retournables > 0
                    ? `<span style="color:#e65100;font-weight:700">${fmt(retournables)}</span>`
                    : `<span style="color:#9e9e9e">0</span>`;
                  const btlVidesCell = ag.btlVides > 0
                    ? `<span style="color:#e65100">${fmt(ag.btlVides)}</span>${enCours > 0 ? `<span style="color:#9e9e9e;font-size:0.7rem"> (${fmt(enCours)} en cours)</span>` : ""}`
                    : `<span style="color:#9e9e9e">0</span>`;
                  return `<tr style="background:#f5f8ff">
                  <td style="padding-left:28px;font-size:0.78rem;color:#37474f"><span style="color:#90a4ae;margin-right:4px">↳</span>${escapeHtml(ag.article)}</td>
                  <td style="text-align:right;font-size:0.78rem;color:#2e7d32">${fmt(ag.pleins)}</td>
                  <td style="text-align:right;font-size:0.78rem;color:#f57c00">${fmt(ag.partiels)}</td>
                  <td style="text-align:right;font-size:0.78rem;color:#e53935">${fmt(ag.vides)}</td>
                  <td style="text-align:right;font-size:0.78rem">${retCell}</td>
                  <td style="text-align:right;font-size:0.78rem;color:#1976d2">${fmt(ag.btlPleines)}</td>
                  <td style="text-align:right;font-size:0.78rem">${btlVidesCell}</td>
                  <td></td>
                </tr>`;
                }).join("");
                return `<tr style="background:#fff">
                  <td style="text-align:center"><span style="background:#e3f2fd;color:#1565c0;padding:2px 9px;border-radius:5px;font-size:0.8rem;font-weight:700">B${g.cap}</span></td>
                  <td style="text-align:right;font-weight:700;color:#2e7d32">${fmt(g.pleins)}</td>
                  <td style="text-align:right;font-weight:700;color:#f57c00">${fmt(g.partiels)}</td>
                  <td style="text-align:right;font-weight:700;color:#e53935">${fmt(g.vides)}</td>
                  <td style="text-align:right;font-weight:700;${fullVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(fullVides)}</td>
                  <td style="text-align:right;font-weight:700;color:#1976d2">${fmt(g.btlPleines)}</td>
                  <td style="text-align:right;font-weight:700;${g.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(g.btlVides)}</td>
                  <td style="white-space:nowrap;text-align:right">${retourBtn}</td>
                </tr>${artRows}`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    });
    list.innerHTML = html;
  }

  // Mouvements (50 derniers)
  const mvtList = document.getElementById("casier-phys-mvt-list");
  const mvtCount = document.getElementById("casier-phys-mvt-count");
  if (mvtList) {
    const mvts = casierMouvementsForSite()
      .slice()
      .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
    if (mvtCount) mvtCount.textContent = `${fmt(mvts.length)} mouvement(s)`;
    const head = mvts.slice(0, 50);
    if (!head.length) {
      mvtList.innerHTML = emptyState("Aucun mouvement", "Les entrées et sorties de casiers apparaîtront ici.");
    } else {
      mvtList.innerHTML = `<div class="stock-table-wrap"><table class="stock-table">
        <thead><tr>
          <th>Date</th>
          <th>Casier</th>
          <th>Article</th>
          <th>Type</th>
          <th style="text-align:right">Qté</th>
          <th>Source / motif</th>
          <th>Note</th>
          <th>Utilisateur</th>
        </tr></thead>
        <tbody>
          ${head.map((m) => `<tr>
            <td>${escapeHtml(formatDateDdMmYyyy(m.date || (m.createdAt || "").slice(0,10)))}</td>
            <td><strong>${escapeHtml(m.casierCode || "-")}</strong></td>
            <td>${escapeHtml(m.article || "-")}</td>
            <td>${m.type === "retour_vide" ? "<span class='badge badge-amber'>Retour vides</span>" : m.type === "sortie" ? "<span class='badge badge-red'>Sortie</span>" : "<span class='badge badge-green'>Entrée</span>"}</td>
            <td style="text-align:right">${m.type === "retour_vide" && m.nbCasiers ? `<strong>${fmt(m.nbCasiers)} casier(s)</strong> <span class="muted">(${fmt(m.quantite)} btl)</span>` : fmt(m.quantite)}</td>
            <td>${escapeHtml(m.type === "retour_vide" ? (m.commentaire || "retour fournisseur") : m.type === "sortie" ? (m.motif || "") : (m.source || ""))}</td>
            <td>${escapeHtml(m.commentaire || "")}</td>
            <td>${escapeHtml(m.user || "-")}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
    }
  }
}

/* -----------------------------------------------------------
 * Modal "Nouveau casier"
 * ----------------------------------------------------------- */

function openCasierEditModal(opts = {}) {
  if (!canManageCasier()) {
    showToast("Reserve au gerant ou administrateur.");
    return;
  }
  const o = opts && typeof opts === "object" ? opts : {};
  pendingPurchaseCasierResume = Boolean(o.resumePurchase);

  const title = document.getElementById("casier-edit-title");
  if (title) {
    title.textContent = pendingPurchaseCasierResume
      ? "Nouveau casier vide (commande fournisseur)"
      : "Nouveau casier vide";
  }

  const codeEl = document.getElementById("casier-edit-code");
  if (codeEl) codeEl.value = `CAS-${String(Number(state?.nextId?.casier) || 1).padStart(4, "0")}`;
  const preservedBr = o.brasserie ? normalizeBrasserieName(String(o.brasserie).trim()) : "";
  populateBrasserieFournisseurSelect(document.getElementById("casier-edit-article"), {
    mode: "catalog",
    preservedValue: preservedBr,
  });
  syncCasierEditFromArticle();
  if (o.capacite) {
    const capEl = document.getElementById("casier-edit-capacite");
    if (capEl) capEl.value = String(Math.max(1, Math.floor(Number(o.capacite))));
  }

  const empEl = document.getElementById("casier-edit-emplacement");
  if (empEl) empEl.value = "À retourner";
  const qtyEl = document.getElementById("casier-edit-qty");
  if (qtyEl) {
    const def = Math.max(1, Math.floor(Number(o.qtySuggest) || 0));
    qtyEl.value = String(def > 0 ? def : 1);
  }
  openModal("modal-casier-edit");
}

function resumePurchaseAfterCasiersCreated() {
  const form = document.getElementById("purchase-form");
  if (form?.classList.contains("hidden")) return;
  syncPurchaseLineInputsFromStock();
  renderPurchaseDraft();
  const fb = document.getElementById("purchase-feedback");
  if (fb) fb.textContent = "";
  const casesEl = document.getElementById("purchase-cases");
  if (casesEl) {
    casesEl.focus();
    try { casesEl.select(); } catch (_) { /* noop */ }
  }
  try {
    form?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (_) {
    form?.scrollIntoView();
  }
}

function syncCasierEditFromArticle() {
  const sel = document.getElementById("casier-edit-article");
  const capEl = document.getElementById("casier-edit-capacite");
  const info = document.getElementById("casier-edit-article-info");
  if (!sel) return;
  const brasserie = normalizeBrasserieName(sel.value);
  const cap = preferredCasierCapacityForBrasserie(brasserie);
  if (capEl && (!capEl.value || Number(capEl.value) === 0)) capEl.value = String(cap);
  if (info) info.textContent = brasserie ? `Brasserie: ${brasserie} · Capacite conseillée: ${fmt(cap)} btl/casier` : "";
}

async function submitCasierEdit() {
  const article = document.getElementById("casier-edit-article")?.value || "";
  const capacite = Math.max(1, Math.floor(Number(document.getElementById("casier-edit-capacite")?.value) || 0));
  const emplacement = String(document.getElementById("casier-edit-emplacement")?.value || "À retourner").trim();
  const qty = Math.max(1, Math.floor(Number(document.getElementById("casier-edit-qty")?.value) || 1));
  if (!normalizeBrasserieName(article)) { showToast("Saisissez la brasserie."); return; }
  if (capacite <= 0) { showToast("Capacite invalide."); return; }
  const resumePurchase = pendingPurchaseCasierResume;
  let createdCount = 0;
  for (let i = 0; i < qty; i++) {
    const created = await createCasier({ article, capacite, emplacement, quantiteActuelle: 0, bouteillesVides: 0 });
    if (created) createdCount++;
  }
  if (!createdCount) return;

  pendingPurchaseCasierResume = false;
  closeModal("modal-casier-edit");
  renderCasierPhysique();
  renderStock();
  renderDashboard();
  populateSupplierList();
  if (resumePurchase) resumePurchaseAfterCasiersCreated();
  showToast(
    resumePurchase
      ? `${createdCount} casier(s) créé(s). Plafond mis à jour — poursuivez la commande ci-dessous.`
      : `${createdCount} casier(s) créé(s).`,
  );
}

/* -----------------------------------------------------------
 * Modal "Mouvement casier physique" (IN/OUT)
 * ----------------------------------------------------------- */

function openCasierPhysMoveModal(type, prefilledCasierId = null) {
  if (!canMoveCasier()) { showToast("Connexion requise."); return; }
  const t = type === "sortie" ? "sortie" : "entree";
  const typeEl = document.getElementById("casier-phys-move-type");
  const titleEl = document.getElementById("casier-phys-move-title");
  if (typeEl) typeEl.value = t;
  if (titleEl) titleEl.textContent = t === "sortie" ? "Sortie casier" : "Entrée casier";
  document.getElementById("casier-phys-move-source-wrap")?.classList.toggle("hidden", t === "sortie");
  document.getElementById("casier-phys-move-motif-wrap")?.classList.toggle("hidden", t === "entree");

  const sel = document.getElementById("casier-phys-move-casier");
  if (sel) {
    const all = casiersConsignesForSite().slice().sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
    sel.innerHTML = all.length
      ? all.map((c) => `<option value="${c.id}">${escapeHtml(c.code)} · ${escapeHtml(c.article || "-")} · ${fmt(c.quantiteActuelle || 0)}/${fmt(c.capacite || 0)}</option>`).join("")
      : `<option value="">— Aucun casier —</option>`;
    if (prefilledCasierId) sel.value = String(prefilledCasierId);
  }
  const qtyEl = document.getElementById("casier-phys-move-qty");
  if (qtyEl) qtyEl.value = "";
  const cmtEl = document.getElementById("casier-phys-move-comment");
  if (cmtEl) cmtEl.value = "";
  updateCasierPhysMovePreview();
  openModal("modal-casier-phys-move");
}

function updateCasierPhysMovePreview() {
  const sel = document.getElementById("casier-phys-move-casier");
  const info = document.getElementById("casier-phys-move-casier-info");
  const preview = document.getElementById("casier-phys-move-preview");
  const c = findCasierById(Number(sel?.value));
  const t = document.getElementById("casier-phys-move-type")?.value || "entree";
  const qty = Math.max(0, Math.floor(Number(document.getElementById("casier-phys-move-qty")?.value) || 0));
  if (!c) {
    if (info) info.textContent = "";
    if (preview) preview.textContent = "";
    return;
  }
  const cap = Math.max(1, Number(c.capacite) || 1);
  const cur = Math.max(0, Number(c.quantiteActuelle) || 0);
  if (info) info.textContent = `${c.code} · ${c.article} · ${fmt(cur)}/${fmt(cap)} btl · ${c.statut || "-"} · empl: ${c.emplacement || "-"}`;
  if (preview) {
    if (qty <= 0) { preview.textContent = ""; return; }
    if (t === "entree") {
      const after = cur + qty;
      if (after > cap) preview.textContent = `Refusé : capacité dépassée (max ${fmt(cap - cur)}).`;
      else preview.textContent = `Après : ${fmt(after)}/${fmt(cap)} btl.`;
    } else {
      if (qty > cur) preview.textContent = `Refusé : stock insuffisant (max ${fmt(cur)}).`;
      else preview.textContent = `Après : ${fmt(cur - qty)}/${fmt(cap)} btl.`;
    }
  }
}

async function submitCasierPhysMove() {
  const t = document.getElementById("casier-phys-move-type")?.value || "entree";
  const id = Number(document.getElementById("casier-phys-move-casier")?.value);
  const qty = Math.max(0, Math.floor(Number(document.getElementById("casier-phys-move-qty")?.value) || 0));
  const commentaire = String(document.getElementById("casier-phys-move-comment")?.value || "").trim();
  if (!id) { showToast("Choisissez un casier."); return; }
  if (qty <= 0) { showToast("Quantité invalide."); return; }
  let ok = false;
  if (t === "entree") {
    const source = document.getElementById("casier-phys-move-source")?.value || "autre";
    ok = await casierEntree(id, qty, { source, commentaire });
  } else {
    const motif = document.getElementById("casier-phys-move-motif")?.value || "autre";
    ok = await casierSortie(id, qty, { motif, commentaire });
  }
  if (!ok) return;
  closeModal("modal-casier-phys-move");
  renderCasierPhysique();
  renderStock();
  renderDashboard();
  showToast(t === "entree" ? "Entrée enregistrée." : "Sortie enregistrée.");
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
      applySessionTimingFromApi(session);
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
        applySessionTimingFromApi(result);
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
  sessionDeadlineUnix = null;
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

function migrateCasiersVidesBouteillesVides() {
  if (!Array.isArray(state.casiers)) return;
  const now = new Date().toISOString();
  let changed = false;

  // 1. Casiers vides (qty=0) sans bouteillesVides tracquées → initialiser à capacite
  state.casiers.forEach((c) => {
    const cap = Math.max(1, Number(c.capacite) || 24);
    const qty = Math.max(0, Number(c.quantiteActuelle) || 0);
    const vides = Math.max(0, Number(c.bouteillesVides) || 0);
    const statut = String(c.statut || "").toLowerCase();
    if (qty <= 0 && vides < cap && statut !== "retourne") {
      c.bouteillesVides = cap;
      c.statut = "vide";
      changed = true;
    }
  });

  // 2. Casiers partiels (qty>0) avec bouteillesVides > 0 → déplacer vers casiers de collecte
  state.casiers.forEach((c) => {
    const qty = Math.max(0, Number(c.quantiteActuelle) || 0);
    const vides = Math.max(0, Number(c.bouteillesVides) || 0);
    if (qty > 0 && vides > 0) {
      const cap = Math.max(1, Number(c.capacite) || 24);
      distributeVidesEnCasiers(c.article, cap, vides, now, { motif: "migration" });
      c.bouteillesVides = 0;
      changed = true;
    }
  });

  if (changed) lsSaveCasiers();
}

async function bootstrapAuthenticatedApp(opts = {}) {
  const skipCasierLsRestore = Boolean(opts.skipCasierLsRestore);
  state = await apiRequest(API.state);
  if (!Array.isArray(state.creditRecoveries)) state.creditRecoveries = [];
  if (!Array.isArray(state.purchaseOrders)) state.purchaseOrders = [];
  if (!Array.isArray(state.supplierPrices)) state.supplierPrices = [];
  if (!Array.isArray(state.dayBooks)) state.dayBooks = [];
  if (!Array.isArray(state.stockEntrees)) state.stockEntrees = [];
  if (!Array.isArray(state.stockLosses)) state.stockLosses = [];
  if (!Array.isArray(state.casiers)) state.casiers = [];
  if (!Array.isArray(state.casierMouvements)) state.casierMouvements = [];
  if (!Array.isArray(state.staffAuditLog)) state.staffAuditLog = [];
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.stockEntree || Number.isNaN(Number(state.nextId.stockEntree))) state.nextId.stockEntree = 100;
  if (!state.nextId.stockLoss || Number.isNaN(Number(state.nextId.stockLoss))) state.nextId.stockLoss = 100;
  if (!state.nextId.creditRecovery) state.nextId.creditRecovery = 100;
  if (!state.nextId.casier || Number.isNaN(Number(state.nextId.casier))) state.nextId.casier = 1;
  if (!state.nextId.casierMouvement || Number.isNaN(Number(state.nextId.casierMouvement))) state.nextId.casierMouvement = 1;
  // Restaurer depuis localStorage si le serveur n'a pas les casiers (éviter après purge / reset : cache local obsolète)
  if (!skipCasierLsRestore && !state.casiers.length) lsRestoreCasiers();
  // Migration : casiers vides existants sans bouteillesVides tracquées → initialiser à capacite
  migrateCasiersVidesBouteillesVides();
  if (state.nextId.auditEntry === undefined || state.nextId.auditEntry === null) state.nextId.auditEntry = 0;
  knownQrOrderIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
  qrAlertCount = 0;
  renderSiteSwitcher();
  populateCategorySelects();
  populateSupplierList();
  populateSelect("c-cat", CHARGE_CATEGORIES);
  populateSelect("c-pay", CHARGE_PAYMENT_METHODS);
  document.getElementById("v-date").value = pdjCalendarDate();
  document.getElementById("c-date").value = today();
  const consigneDateEl = document.getElementById("consigne-date");
  if (consigneDateEl) consigneDateEl.value = pdjCalendarDate();
  const creditDt = document.getElementById("credit-datetime");
  if (creditDt) creditDt.value = datetimeLocalNow();
  document.getElementById("orders-filter-date").value = pdjCalendarDate();
  document.getElementById("stock-move-start").value = today().slice(0, 8) + "01";
  document.getElementById("stock-move-end").value = today();
  populateOrderSelect();
  renderTopbar();
  renderDashboard();
  renderVentesPage();
  renderStock();
  renderCharges();
  loadParamsForm();
  populatePurgeMaquisSelect();
  await refreshRestoreBackupUi().catch(() => {});
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
    renderCasierPhysique();
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
  // Saisie rapide
  document.getElementById("saisie-rapide-btn")?.addEventListener("click", openSaisieRapide);
  document.getElementById("sr-submit-btn")?.addEventListener("click", () => submitSaisieRapide().catch(handleApiError));
  document.getElementById("sr-search")?.addEventListener("input", (e) => renderSrMenu(e.target.value));
  document.getElementById("sr-location")?.addEventListener("change", () => {
    renderSrMenu(document.getElementById("sr-search")?.value || "");
    renderSrCart();
  });
  document.getElementById("sr-menu")?.addEventListener("click", (e) => {
    const dec = e.target.closest(".sr-dec");
    if (dec) { srUpdateQty(dec.dataset.srArticle, Number(dec.dataset.srPack), -1); return; }
    const inc = e.target.closest(".sr-inc");
    if (inc) { srUpdateQty(inc.dataset.srArticle, Number(inc.dataset.srPack), +1); return; }
  });
  document.getElementById("sr-menu")?.addEventListener("change", (e) => {
    const input = e.target.closest(".sr-qty-input");
    if (input) srSetQty(input.dataset.srArticle, Number(input.dataset.srPack), Number(input.value));
  });
  // Consignes
  document.getElementById("new-consigne-btn")?.addEventListener("click", () => {
    const wrap = document.getElementById("consigne-form-wrap");
    if (!wrap) return;
    resetConsigneForm();
    wrap.classList.remove("hidden");
    document.getElementById("consigne-client")?.focus();
  });
  document.getElementById("consigne-facture-select")?.addEventListener("change", onConsigneFactureSelectChange);
  document.getElementById("consigne-form-wrap")?.addEventListener("click", (ev) => {
    const pick = ev.target.closest("[data-pick-vente-line]");
    if (pick?.dataset?.pickVenteLine) applyVenteLineToConsigneForm(pick.dataset.pickVenteLine);
  });
  document.getElementById("save-consigne-btn")?.addEventListener("click", () => saveConsigne().catch(handleApiError));
  document.getElementById("cancel-consigne-btn")?.addEventListener("click", () => {
    document.getElementById("consigne-form-wrap")?.classList.add("hidden");
  });
  // Casier order modal
  document.getElementById("co-brasserie")?.addEventListener("change", renderCasierOrderPreview);
  document.getElementById("co-cs")?.addEventListener("change", renderCasierOrderPreview);
  document.getElementById("co-vides")?.addEventListener("input", renderCasierOrderPreview);
  document.getElementById("co-submit-btn")?.addEventListener("click", submitCasierOrder);
  document.getElementById("stock-card-casiers")?.addEventListener("click", (e) => {
    if (e.target.closest(".sync-casiers-btn")) {
      syncCasiersFromStockEtVentes().catch(handleApiError);
      return;
    }
    const btn = e.target.closest(".co-open-btn");
    if (btn) openCasierOrderModal(btn.dataset.coBrasserie || "", Number(btn.dataset.coCs) || null);
  });
  document.getElementById("casiers-entree-btn")?.addEventListener("click", () => openCasierMoveModal("entree"));
  document.getElementById("casiers-sortie-btn")?.addEventListener("click", () => openCasierMoveModal("sortie"));
  document.getElementById("casier-move-article")?.addEventListener("change", updateCasierMoveInfos);
  document.getElementById("casier-move-cases")?.addEventListener("input", updateCasierMoveInfos);
  document.getElementById("casier-move-submit")?.addEventListener("click", () => submitCasierMove().catch(handleApiError));
  // Toggle vue Lots / Casiers physiques
  document.querySelectorAll("[data-casier-view]").forEach((btn) => {
    btn.addEventListener("click", () => setCasierViewMode(btn.dataset.casierView));
  });
  // Casiers physiques : actions globales
  document.getElementById("casier-phys-new-btn")?.addEventListener("click", openCasierEditModal);
  document.getElementById("casier-phys-move-in-btn")?.addEventListener("click", () => openCasierPhysMoveModal("entree"));
  document.getElementById("casier-phys-move-out-btn")?.addEventListener("click", () => openCasierPhysMoveModal("sortie"));
  document.getElementById("casier-phys-clean-cartons-btn")?.addEventListener("click", () => cleanupCartonCasiers().catch(handleApiError));
  // Modal Nouveau casier
  document.getElementById("casier-edit-article")?.addEventListener("change", syncCasierEditFromArticle);
  document.getElementById("casier-edit-submit")?.addEventListener("click", () => submitCasierEdit().catch(handleApiError));
  // Modal Mouvement casier physique
  document.getElementById("casier-phys-move-casier")?.addEventListener("change", updateCasierPhysMovePreview);
  document.getElementById("casier-phys-move-qty")?.addEventListener("input", updateCasierPhysMovePreview);
  document.getElementById("casier-phys-move-submit")?.addEventListener("click", () => submitCasierPhysMove().catch(handleApiError));
  // Filtres casiers physiques
  document.getElementById("casier-phys-filter-article")?.addEventListener("input", (e) => {
    casierPhysFilters.article = e.target.value;
    renderCasierPhysique();
  });
  document.getElementById("casier-phys-filter-emplacement")?.addEventListener("input", (e) => {
    casierPhysFilters.emplacement = e.target.value;
    renderCasierPhysique();
  });
  document.getElementById("casier-phys-filter-statut")?.addEventListener("change", (e) => {
    casierPhysFilters.statut = e.target.value;
    renderCasierPhysique();
  });
  // Actions par ligne (table casiers physiques)
  document.getElementById("casier-phys-list")?.addEventListener("click", (e) => {
    const inBtn = e.target.closest("[data-casier-phys-in]");
    if (inBtn) { openCasierPhysMoveModal("entree", Number(inBtn.dataset.casierPhysIn)); return; }
    const outBtn = e.target.closest("[data-casier-phys-out]");
    if (outBtn) { openCasierPhysMoveModal("sortie", Number(outBtn.dataset.casierPhysOut)); return; }
    const frigoBtn = e.target.closest("[data-casier-phys-frigo]");
    if (frigoBtn) {
      const id = Number(frigoBtn.dataset.casierPhysFrigo);
      const c = findCasierById(id);
      if (!c) return;
      const max = Math.max(0, Number(c.quantiteActuelle) || 0);
      if (max <= 0) { showToast("Casier vide."); return; }
      const raw = window.prompt(`Combien de bouteilles transférer au frigo depuis ${c.code} ? (max ${max})`, String(max));
      const qty = Math.max(0, Math.floor(Number(raw) || 0));
      if (qty <= 0) return;
      casierSortie(id, qty, { motif: "frigo", commentaire: "Transfert vers frigo" })
        .then((ok) => {
          if (ok) {
            renderCasierPhysique();
            renderStock();
            renderDashboard();
            showToast(`${fmt(qty)} btl transférée(s) au frigo.`);
          }
        })
        .catch(handleApiError);
      return;
    }
    const grpRetourBtn = e.target.closest("[data-casier-grp-retour-br]");
    if (grpRetourBtn) {
      const br = grpRetourBtn.dataset.casierGrpRetourBr;
      const cap = Number(grpRetourBtn.dataset.casierGrpRetourCap) || 24;
      const maxCasiers = casiersForSite().filter((c) => {
        const stockIt = stockItemForArticle(c.article);
        const cBr = normalizeBrasserieName(stockIt?.brasserie || "");
        return cBr === br &&
          Math.max(1, Number(c.capacite) || 1) === cap &&
          Math.max(0, Number(c.bouteillesVides) || 0) >= cap;
      }).length;
      if (maxCasiers < 1) { showToast("Pas de casier complet de vides à retourner."); return; }
      const raw = window.prompt(
        `Combien de casiers vides à retourner au fournisseur ?\n${br} · B${cap}\n(max ${fmt(maxCasiers)} casier(s))`,
        String(maxCasiers)
      );
      const nb = Math.max(0, Math.min(maxCasiers, Math.floor(Number(raw) || 0)));
      if (!nb) return;
      retourVidesGroupeBrasserie(br, cap, nb)
        .then((done) => { if (done) { renderCasierPhysique(); renderDashboard(); showToast(`${fmt(done)} casier(s) vide(s) retourné(s) au fournisseur.`); } })
        .catch(handleApiError);
      return;
    }
    const retourBtn = e.target.closest("[data-casier-phys-retour]");
    if (retourBtn) {
      const id = Number(retourBtn.dataset.casierPhysRetour);
      const c = findCasierById(id);
      if (!c) return;
      const cap = Math.max(1, Number(c.capacite) || 24);
      const vides = Math.max(0, Number(c.bouteillesVides) || 0);
      const maxCasiers = Math.floor(vides / cap);
      if (maxCasiers < 1) { showToast("Pas encore un casier complet de vides à retourner."); return; }
      const raw = window.prompt(
        `Combien de casiers vides à retourner au fournisseur ?\n` +
        `Casier ${c.code} · ${c.article} · ${fmt(cap)} btl/casier\n` +
        `(max ${fmt(maxCasiers)} casier(s) = ${fmt(maxCasiers * cap)} btl)`,
        String(maxCasiers)
      );
      const nbCasiers = Math.max(0, Math.min(maxCasiers, Math.floor(Number(raw) || 0)));
      if (!nbCasiers) return;
      const qty = nbCasiers * cap;
      retourVidesCasier(id, qty)
        .then((ok) => {
          if (ok) {
            renderCasierPhysique();
            renderDashboard();
            showToast(`${fmt(qty)} bouteille(s) vide(s) retournée(s) au fournisseur.`);
          }
        })
        .catch(handleApiError);
      return;
    }
    const delBtn = e.target.closest("[data-casier-phys-delete]");
    if (delBtn) {
      deleteCasier(Number(delBtn.dataset.casierPhysDelete))
        .then((ok) => { if (ok) renderCasierPhysique(); })
        .catch(handleApiError);
    }
  });
  document.getElementById("save-brasserie-attach-btn")?.addEventListener("click", () => saveBrasserieAttachment().catch(handleApiError));
  document.getElementById("clear-brasserie-attach-btn")?.addEventListener("click", clearBrasserieAttachmentSelection);
  document.getElementById("brasserie-attach-filter")?.addEventListener("input", renderBrasserieAttachMenu);
  document.getElementById("brasserie-attach-name")?.addEventListener("change", () => {
    const name = String(document.getElementById("brasserie-attach-name")?.value || "").trim().toLowerCase();
    document.querySelectorAll("[data-brasserie-stock-id]").forEach((input) => {
      const item = recordsForSite(state.stock).find((stockItem) => Number(stockItem.id) === Number(input.dataset.brasserieStockId));
      input.checked = !!name && String(item?.brasserie || "").trim().toLowerCase() === name;
    });
  });
  // Kit
  document.getElementById("kit-price")?.addEventListener("input", renderKitProducts);
  document.getElementById("kit-size")?.addEventListener("change", () => { renderKitProducts(); updateKitCountInfo(); });
  document.getElementById("kit-location")?.addEventListener("change", renderKitProducts);
  document.getElementById("kit-products-list")?.addEventListener("change", (e) => {
    if (e.target.classList.contains("kit-cb")) updateKitCountInfo();
  });
  document.getElementById("confirm-kit-btn")?.addEventListener("click", () => confirmKit().catch(handleApiError));
  // Remplacement d'article
  document.getElementById("replace-search")?.addEventListener("input", (e) => renderReplacePicker(e.target.value));
  document.getElementById("replace-picker")?.addEventListener("click", (e) => {
    const item = e.target.closest("[data-pick-replace]");
    if (!item) return;
    replaceSelectedArticle = item.dataset.pickReplace;
    renderReplacePicker(document.getElementById("replace-search")?.value || "");
    const btn = document.getElementById("confirm-replace-btn");
    if (btn) btn.disabled = false;
  });
  document.getElementById("confirm-replace-btn")?.addEventListener("click", () => confirmReplace().catch(handleApiError));
  document.getElementById("generate-qr-btn").addEventListener("click", renderQrPreview);
  document.getElementById("print-all-qr-btn").addEventListener("click", () => printAllQrTables());
  document.getElementById("print-qr-int-btn").addEventListener("click", () => printQrCard("Intérieur"));
  document.getElementById("print-qr-ext-btn").addEventListener("click", () => printQrCard("Extérieur"));
  document.getElementById("new-site-single-br-enabled")?.addEventListener("change", syncSingleBreweryUi);
  document.getElementById("p-single-br-enabled")?.addEventListener("change", syncSingleBreweryUi);
document.getElementById("fab-btn").addEventListener("click", () => {
    if (currentPage === "ventes") {
      if (ventesSubTab === "consignes") {
        const wrap = document.getElementById("consigne-form-wrap");
        if (wrap) { resetConsigneForm(); wrap.classList.remove("hidden"); document.getElementById("consigne-client")?.focus(); }
        return;
      }
      openOrderEditor(activeOrderId || null, null);
      return;
    }
    if (currentPage === "stock" && stockSubTab === "casiers") {
      openCasierOrderModal("", null);
      return;
    }
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
    syncPdjWorkDateInput();
    renderOrdersManagement();
    if (currentPage === "pdj") renderPointDuJour();
    if (currentPage === "ventes") renderVentesPage();
  });
  document.getElementById("pdj-apply-work-date")?.addEventListener("click", () => {
    syncPdjWorkDateInput();
    renderOrdersManagement();
    if (currentPage === "pdj") renderPointDuJour();
    if (currentPage === "ventes") renderVentesPage();
  });
  document.getElementById("close-day-btn").addEventListener("click", () => {
    if (!canManagePdjAccounting()) {
      showToast("Clôture réservée au gérant ou à un administrateur.");
      return;
    }
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
      await bootstrapAuthenticatedApp({ skipCasierLsRestore: true });
      lsSaveCasiers();
      showToast("Application reinitialisee.");
    } catch (error) {
      handleApiError(error);
    }
  });
  document.getElementById("purge-maquis-btn")?.addEventListener("click", async () => {
    if (!canSuperAdmin()) {
      showToast("Seul le super administrateur peut purger un maquis.");
      return;
    }
    const sel = document.getElementById("purge-maquis-select");
    const siteId = sel?.value?.trim();
    const site = (state?.sites || []).find((s) => String(s.id) === siteId);
    if (!site) {
      showToast("Selectionnez un maquis.");
      return;
    }
    const keepCat = Boolean(document.getElementById("purge-maquis-keep-catalog")?.checked);
    const msg =
      (keepCat
        ? `Remettre a zero les quantites et effacer tout l'historique de "${site.nom}" (${site.id}) tout en conservant les articles du catalogue ?\n`
        : `EFFACER aussi le catalogue articles (stock) pour "${site.nom}" (${site.id}) avec tout le reste ?\n`)
      + "Les parametres maquis dans la liste (nom, ville...) sont toujours conserves.";
    if (!window.confirm(msg)) return;
    if (!window.confirm("Confirmation finale : suppression irreversible pour ce maquis ?")) return;
    try {
      let compatPut = false;
      try {
        await apiRequest(API.purgeMaquis, { method: "POST", body: JSON.stringify({ siteId, keepStockCatalog: keepCat }) });
      } catch (first) {
        const st = first?.status;
        const apiMsg = typeof first?.message === "string" ? first.message : "";
        const unknownRoute =
          st === 404 || apiMsg.includes("Route API introuvable") || apiMsg.includes("NOT_FOUND") || /\b404\b/.test(apiMsg);
        if (!canSuperAdmin() || !unknownRoute) throw first;
        await purgeMaquisDataViaStatePut(siteId, keepCat);
        compatPut = true;
      }
      activeOrderId = null;
      editingLineId = null;
      await bootstrapAuthenticatedApp({ skipCasierLsRestore: true });
      lsSaveCasiers();
      showToast(
        compatPut
          ? `Donnees du maquis "${site.nom}" effacees (serveur sans /api/purge-maquis ; redemarrez avec la derniere version de server.py).`
          : `Donnees du maquis "${site.nom}" effacees sur le serveur.`,
      );
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
  document.getElementById("restore-backup-refresh-btn")?.addEventListener("click", () => refreshRestoreBackupUi().catch(handleApiError));
  document.getElementById("restore-site-backup-btn")?.addEventListener("click", () => restoreSelectedSiteFromBackup().catch(handleApiError));
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
    const quickCasier = event.target.closest("[data-purchase-quick-casier]");
    if (quickCasier) {
      const br = quickCasier.getAttribute("data-pqc-br") || "";
      const cap = Math.max(1, Math.floor(Number(quickCasier.getAttribute("data-pqc-cap")) || 24));
      openCasierEditModal({ brasserie: br, capacite: cap, resumePurchase: true, qtySuggest: 2 });
      return;
    }
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
  document.getElementById("purchase-from-vides-btn")?.addEventListener("click", () => {
    const btn = document.getElementById("purchase-from-vides-btn");
    const nb = Number(btn?.dataset?.nbVides) || 0;
    if (nb > 0) {
      document.getElementById("purchase-cases").value = String(nb);
      showToast(`Quantité définie sur ${fmt(nb)} casier(s) vide(s) à retourner.`);
    }
  });
  document.getElementById("purchase-receive-confirm-btn")?.addEventListener("click", () => confirmReceivePurchaseOrder().catch(handleApiError));
  // Audit detail: copy + expand
  document.getElementById("audit-detail-copy-btn")?.addEventListener("click", () => {
    const detail = document.getElementById("audit-detail-detail")?.textContent || "";
    copyTextToClipboard(detail).then((ok) => {
      showToast(ok ? "Detail copie." : "Impossible de copier.");
    });
  });
  document.getElementById("audit-detail-toggle-btn")?.addEventListener("click", () => {
    const pre = document.getElementById("audit-detail-detail");
    const btn = document.getElementById("audit-detail-toggle-btn");
    if (!pre || !btn) return;
    const expanded = pre.classList.toggle("is-expanded");
    btn.textContent = expanded ? "Reduire" : "Agrandir";
    if (expanded) pre.scrollIntoView({ block: "nearest" });
  });
  document.getElementById("modal-purchase-receive")?.addEventListener("input", (event) => {
    if (!event.target.classList?.contains("recv-cases-input")) return;
    const po = (state.purchaseOrders || []).find((p) => p.id === pendingReceivePurchaseId);
    if (po) updateReceivePurchaseModalTotals(po);
  });
  document.getElementById("purchase-article")?.addEventListener("change", () => {
    // Format change → repopuler les articles du format puis sync
    populatePurchaseArticleDetailFromFormat();
    syncPurchaseLineInputsFromStock();
  });
  document.getElementById("purchase-article-detail")?.addEventListener("change", () => syncPurchaseLineInputsFromStock());
  document.getElementById("purchase-supplier")?.addEventListener("change", (e) => {
    if (siteIsSingleBrewery()) return;
    const br = e.target.value;
    populatePurchaseArticlesByBrasserie(br);
    syncPurchasePriceInput();
    // Reset article, article-detail et casiers
    document.getElementById("purchase-cases").value = "";
    document.getElementById("purchase-cases").removeAttribute("max");
    const detailSel = document.getElementById("purchase-article-detail");
    if (detailSel) detailSel.value = "";
    const detailWrap = document.getElementById("purchase-article-detail-wrap");
    if (detailWrap) detailWrap.style.display = "none";
    const videsBtn = document.getElementById("purchase-from-vides-btn");
    const videsHint = document.getElementById("purchase-vides-hint");
    const limitHint = document.getElementById("purchase-cases-limit-hint");
    if (videsBtn) videsBtn.style.display = "none";
    if (videsHint) videsHint.style.display = "none";
    if (limitHint) limitHint.style.display = "none";
  });
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
      syncPurchaseLineInputsFromStock();
      return;
    }
    const selectAll = event.target.closest("#purchase-select-all");
    if (selectAll) {
      const checked = Boolean(selectAll.checked);
      purchaseDraftLines = purchaseDraftLines.map((l) => ({ ...l, selected: checked }));
      renderPurchaseDraft();
      syncPurchaseLineInputsFromStock();
      return;
    }
    const selectLine = event.target.closest("[data-purchase-select]");
    if (selectLine) {
      const idx = Number(selectLine.dataset.purchaseSelect);
      if (!purchaseDraftLines[idx]) return;
      purchaseDraftLines[idx].selected = Boolean(selectLine.checked);
      renderPurchaseDraft();
      syncPurchaseLineInputsFromStock();
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
    const priceInput = event.target.closest("[data-purchase-price]");
    if (!casesInput && !priceInput) return;
    const idx = Number((casesInput || priceInput).dataset.purchaseCases ?? (casesInput || priceInput).dataset.purchasePrice);
    if (!purchaseDraftLines[idx]) return;
    if (casesInput) purchaseDraftLines[idx].cases = Number(casesInput.value) || 0;
    if (priceInput) purchaseDraftLines[idx].pricePerCase = Number(priceInput.value) || 0;
    recomputePurchaseLine(idx);
    const brCanon = getPurchaseSupplierCanonical();
    const formatVal = document.getElementById("purchase-article")?.value?.trim() || "";
    const capMatch = formatVal.match(/^B(\d+)$/);
    if (String(brCanon).trim() && capMatch && purchaseSupplierCountsEmptyCratesHints(brCanon)) {
      const brClamp = normalizeBrasserieName(brCanon);
      if (catalogueHasCasierConsigneForPurchaseBr(brClamp)) {
        clampDraftCasesToAvailable(brClamp, Number(capMatch[1]));
      }
    }
    renderPurchaseDraft();
    syncPurchaseLineInputsFromStock();
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
    const orderDetails = event.target.closest("[data-order-details]");
    if (orderDetails) {
      openOrderDetailModal(orderDetails.dataset.orderDetails);
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
    const replaceLine = event.target.closest("[data-replace-line]");
    if (replaceLine) {
      openReplaceModal(replaceLine.dataset.orderId, replaceLine.dataset.replaceLine);
      return;
    }
    const returnConsigneBtn = event.target.closest("[data-return-consigne]");
    if (returnConsigneBtn) {
      returnConsigne(returnConsigneBtn.dataset.returnConsigne).catch(handleApiError);
      return;
    }
    const conserveConsigneBtn = event.target.closest("[data-conserve-consigne]");
    if (conserveConsigneBtn) {
      conserveConsignePourReuse(conserveConsigneBtn.dataset.conserveConsigne).catch(handleApiError);
      return;
    }
    const reutiliseConsigneBtn = event.target.closest("[data-reutilise-consigne]");
    if (reutiliseConsigneBtn) {
      reutiliseConsigne(reutiliseConsigneBtn.dataset.reutiliseConsigne).catch(handleApiError);
      return;
    }
    const deleteConsigneBtn = event.target.closest("[data-delete-consigne]");
    if (deleteConsigneBtn && window.confirm("Supprimer cette consigne ?")) {
      deleteConsigne(deleteConsigneBtn.dataset.deleteConsigne).catch(handleApiError);
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
    syncFinalizeButtonJournalState();
  });
  document.getElementById("v-date")?.addEventListener("change", () => {
    syncFinalizeButtonJournalState();
    if (currentPage === "ventes") renderVentesPage();
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
    applySessionTimingFromApi(session);
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
