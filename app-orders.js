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
  createManualBackup: "/api/admin/create-manual-backup",
  createSiteBackup: "/api/admin/create-site-backup",
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
/** Brouillon saisi dans « Montant en caisse à l'ouverture » : réinjecté si le panneau est re-rendu (ex. sync live ~4 s) pendant la saisie. */
const pdjOpeningCashDraftBySiteDate = {};
/** Brouillon « espèces à la fermeture » + reprise des saisies frigo/réserve si le bloc clôture est re-rendu pendant la saisie. */
const pdjClosingCashDraftBySiteDate = {};
function pdjOpeningCashDraftKey(siteId, dateStr) {
  return `${String(siteId || "").trim()}|${String(dateStr || "").trim().slice(0, 10)}`;
}

/** True si les deux cartes PDJ (date imposee par maquis) sont identiques — evite re-render PDJ inutile a chaque sync. */
function shallowEqualPdjWorkDateMaps(a, b) {
  const ax = a && typeof a === "object" ? a : {};
  const bx = b && typeof b === "object" ? b : {};
  const keys = new Set([...Object.keys(ax), ...Object.keys(bx)]);
  for (const k of keys) {
    if (String(ax[k] ?? "").trim() !== String(bx[k] ?? "").trim()) return false;
  }
  return true;
}

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
/** True si le compte couvre tous les maquis (sauvegardes, multi-sites, purge globale). Voir reponse API `globalSuperadmin`. */
let globalSuperadmin = null;
/** Droit sauvegarde maquis cote serveur (reponse login / session). null = serveur ancien. */
let maquisBackupAllowed = null;
let currentPage = "home";
let currentFilter = "all";
let ventesSubTab = "commandes";
let pdjSubTab = "synthese";
let caisseInnerTab = "recouvrement";
let stockSubTab = "catalogue";
let paramsSubTab = "profil";
let stockTableCompact = true;
let stockSearchTerm = "";
let stockCatFilter = "all";
let stockStatusFilter = "all";

const CSV_MONTH_FR = ["janvier", "fevrier", "mars", "avril", "mai", "juin", "juillet", "aout", "septembre", "octobre", "novembre", "decembre"];

function orderPhysicalTable(order) {
  const table = String(order?.table || "").trim();
  if (table && !/saisie\s*rapide/i.test(table)) return table;
  const client = String(order?.client || "").trim();
  if (client && !/saisie\s*rapide/i.test(client)) {
    const parts = client.split("·").map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2 && /saisie\s*rapide/i.test(parts[0])) return parts.slice(1).join(" · ") || "—";
    if (!/saisie\s*rapide/i.test(client)) return client;
  }
  return table || "Comptoir";
}

function orderSaisieMode(order) {
  if (order?.saisieMode) return String(order.saisieMode);
  const client = String(order?.client || "");
  if (/saisie\s*rapide/i.test(client)) return "Saisie rapide";
  if (String(order?.source || "").trim() === "qr") return "QR client";
  return "Commande";
}

function reapproTargetMultiplier(site = currentSite()) {
  const m = Number(site?.reapproTargetMultiplier);
  return Number.isFinite(m) && m >= 1 && m <= 10 ? m : 2;
}

function stockRowStatusKey(item, site) {
  const actuel = stockActuel(item);
  const seuilArticle = Number(item.seuilMin) || 0;
  const mult = reapproTargetMultiplier(site);
  if (actuel <= 0) return "rupture";
  if (isStockBelowArticleSeuilForAlert(actuel, seuilArticle)) return "critique";
  const frigo = stockFrigo(item);
  const seuilFrigo = Number(item.seuilMin) || Number(site?.seuilStock) || 5;
  if (isFrigoLowForAlert(frigo, seuilFrigo)) return "faible";
  if (
    seuilArticle > 0
    && (stockAlertInclusiveSeuil(site) ? actuel <= seuilArticle * mult : actuel < seuilArticle * mult)
  ) return "faible";
  return "ok";
}

function stockItemLastUpdatedAt(item) {
  const stamps = [item.updatedAt, item.lastSortieAt, item.lastEntreeAt, item.lastMajAt]
    .map((x) => String(x || "").trim())
    .filter((x) => x.length >= 10);
  if (!stamps.length) return null;
  return stamps.sort().pop();
}

function formatStockMajLabel(iso) {
  if (!iso) return "—";
  const d = parseFlexibleDateTime(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / (1000 * 60 * 60);
  if (diffH < 24 && d.toDateString() === now.toDateString()) {
    return `Aujourd'hui ${formatLocalHourMinute(d)}`;
  }
  const diffD = Math.floor(diffH / 24);
  if (diffD === 1) return "Hier";
  if (diffD < 7) return `Il y a ${diffD} jours`;
  return formatDateDdMmYyyy(d);
}

function stockMajCssClass(iso, statusKey) {
  if (!iso) return "";
  const d = parseFlexibleDateTime(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ageH = (Date.now() - d.getTime()) / (1000 * 60 * 60);
  if ((statusKey === "rupture" || statusKey === "critique") && ageH > 48) return "stock-maj-stale-critical";
  if (ageH > 24) return "stock-maj-stale";
  return "";
}

function usersWithout2FACount() {
  if (!canManage() || !state?.auth?.users) return 0;
  return state.auth.users.filter((u) => !u.twoFactorEnabled).length;
}

function renderHome2FAAlert() {
  const el = document.getElementById("home-2fa-alert");
  if (!el) return;
  const n = usersWithout2FACount();
  const selfNo2fa = state?.auth?.users?.find(
    (u) => String(u.username) === String(sessionUser) && !u.twoFactorEnabled,
  );
  if (selfNo2fa && canManage()) {
    el.classList.remove("hidden");
    el.innerHTML = `<strong>Sécurité :</strong> votre compte n'a pas le 2FA activé — <button type="button" class="linkish-btn linkish-btn--emph" data-goto-params-acces-2fa>Activer maintenant</button>`;
  } else if (n > 0 && canManage()) {
    el.classList.remove("hidden");
    el.innerHTML = `<strong>Sécurité :</strong> ${n} compte${n > 1 ? "s" : ""} sans 2FA actif — <button type="button" class="linkish-btn" data-goto-params-acces>Voir dans Paramètres</button>`;
  } else {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.querySelector("[data-goto-params-acces]")?.addEventListener("click", () => {
    navigate("params");
    setParamsSubTab("acces");
  });
  el.querySelector("[data-goto-params-acces-2fa]")?.addEventListener("click", () => {
    openMyAccount2FASetup();
  });
}

function openMyAccount2FASetup() {
  const sn = String(sessionUser || "").trim();
  if (!sn) {
    showToast("Session requise.");
    return;
  }
  navigate("params");
  setParamsSubTab("profil");
  syncUserAccountPanel();
  const panel = document.getElementById("user-account-panel");
  panel?.scrollIntoView({ behavior: "smooth", block: "start" });
  const btn = document.querySelector(`[data-setup-2fa-self="${CSS.escape(sn)}"]`)
    || document.getElementById("ua-2fa-setup-btn");
  if (btn) {
    btn.focus();
    return;
  }
  setupTwoFactor(sn).catch(handleApiError);
}

function csvEscapeCell(value) {
  const s = String(value ?? "");
  if (/[",\n\r;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadCsvFile(filename, headerRow, dataRows) {
  const lines = [headerRow.map(csvEscapeCell).join(";"), ...dataRows.map((row) => row.map(csvEscapeCell).join(";"))];
  const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function downloadExcelFile(filename, sheetName, headerRow, dataRows) {
  if (typeof XLSX === "undefined") {
    showToast("Bibliothèque Excel non chargée. Rechargez la page (Ctrl+F5).");
    return false;
  }
  const objects = dataRows.map((row) => {
    const o = {};
    headerRow.forEach((key, i) => { o[key] = row[i]; });
    return o;
  });
  const ws = XLSX.utils.json_to_sheet(objects);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
  return true;
}

function downloadExcelWorkbook(filename, sheets) {
  if (typeof XLSX === "undefined") {
    showToast("Bibliothèque Excel non chargée. Rechargez la page (Ctrl+F5).");
    return false;
  }
  const wb = XLSX.utils.book_new();
  sheets.forEach(({ name, header, rows }) => {
    const objects = rows.map((row) => {
      const o = {};
      header.forEach((key, i) => { o[key] = row[i]; });
      return o;
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(objects), name.slice(0, 31));
  });
  XLSX.writeFile(wb, filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`);
  return true;
}

function exportFileSlug() {
  return (currentSite()?.nom || "maquis").replace(/[^\w-]+/gi, "_").replace(/_+/g, "_") || "maquis";
}

function periodFromControls(prefix) {
  const mode = document.getElementById(`${prefix}-period-mode`)?.value || "month";
  if (mode === "all") {
    return { start: null, end: null, mode, label: "Tout l'historique" };
  }
  if (mode === "month") {
    const { start, end } = monthPeriodBounds(new Date());
    const mois = new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
    return { start, end, mode, label: `Mois en cours (${mois})` };
  }
  if (mode === "week") {
    const { start, end } = weekPeriodBounds(new Date());
    return { start, end, mode, label: `Semaine en cours (${formatPeriodLabel(start, end)})` };
  }
  const { start, end } = dateRangeFromDom(`${prefix}-period-start`, `${prefix}-period-end`, today());
  return { start, end, mode, label: formatPeriodLabel(start, end) };
}

function syncPeriodCustomUi(prefix) {
  const mode = document.getElementById(`${prefix}-period-mode`)?.value || "month";
  document.getElementById(`${prefix}-period-custom`)?.classList.toggle("hidden", mode !== "custom");
  const label = document.getElementById(`${prefix}-period-label`);
  if (label) label.textContent = periodFromControls(prefix).label;
}

function initPeriodDom(prefix) {
  const { start } = monthPeriodBounds(new Date());
  const startEl = document.getElementById(`${prefix}-period-start`);
  const endEl = document.getElementById(`${prefix}-period-end`);
  if (startEl && !startEl.value) startEl.value = start;
  if (endEl && !endEl.value) endEl.value = today();
  syncPeriodCustomUi(prefix);
}

function exportPeriod() {
  return periodFromControls("export");
}

function recordsInPeriod(records, dateGetter, period) {
  if (!period?.start || !period?.end) return records;
  return records.filter((r) => {
    const d = String(dateGetter(r) || "").slice(0, 10);
    return d >= period.start && d <= period.end;
  });
}

function exportPeriodFileBase(period, kind) {
  const slug = exportFileSlug();
  if (period.mode === "all") return `${kind}_tout_${slug}`;
  if (period.mode === "month" && period.start) {
    const ym = period.start.slice(0, 7);
    const mi = Number(ym.slice(5, 7)) - 1;
    return `${kind}_${CSV_MONTH_FR[mi] || ym}-${ym.slice(0, 4)}_${slug}`;
  }
  return `${kind}_${period.start}_${period.end}_${slug}`;
}

function ventesExportRowsForPeriod(period) {
  const rows = recordsInPeriod(recordsForSite(state.ventes), (v) => saleDateValue(v), period);
  const header = ["date", "article", "categorie", "quantite", "prix_unitaire", "remise", "montant_net", "paiement", "serveur", "table"];
  const data = rows.map((v) => [
    formatDateDdMmYyyy(v.date),
    v.article,
    v.cat,
    v.qty,
    v.prix,
    v.remise,
    calcNet(v),
    v.paiement,
    v.server || v.serveur || "",
    v.table || v.client || "",
  ]);
  return { rows, header, data };
}

function chargesExportRowsForPeriod(period) {
  const rows = recordsInPeriod(recordsForSite(state.charges), (c) => c.date, period);
  const header = ["date", "libelle", "montant", "categorie", "paiement"];
  const data = rows.map((c) => [
    formatDateDdMmYyyy(c.date),
    c.lib,
    c.montant,
    c.cat || "Autres",
    c.paiement,
  ]);
  return { rows, header, data };
}

function exportExcelVentesMonth() {
  const period = exportPeriod();
  const { rows, header, data } = ventesExportRowsForPeriod(period);
  const fname = `${exportPeriodFileBase(period, "ventes")}.xlsx`;
  if (downloadExcelFile(fname, "Ventes", header, data)) {
    showToast(`${rows.length} vente(s) exportée(s) — ${period.label}.`);
  }
}

function exportExcelChargesMonth() {
  const period = exportPeriod();
  const { rows, header, data } = chargesExportRowsForPeriod(period);
  const fname = `${exportPeriodFileBase(period, "charges")}.xlsx`;
  if (downloadExcelFile(fname, "Charges", header, data)) {
    showToast(`${rows.length} charge(s) exportée(s) — ${period.label}.`);
  }
}

function exportExcelComptaMonth() {
  const period = exportPeriod();
  const ventes = ventesExportRowsForPeriod(period);
  const charges = chargesExportRowsForPeriod(period);
  const fname = `${exportPeriodFileBase(period, "compta")}.xlsx`;
  if (downloadExcelWorkbook(fname, [
    { name: "Ventes", header: ventes.header, rows: ventes.data },
    { name: "Charges", header: charges.header, rows: charges.data },
  ])) {
    showToast(`Excel : ${ventes.rows.length} vente(s), ${charges.rows.length} charge(s) — ${period.label}.`);
  }
}

/** @deprecated compat — redirige vers Excel */
function exportCsvVentesMonth() { exportExcelVentesMonth(); }
function exportCsvChargesMonth() { exportExcelChargesMonth(); }

function exportHtmlReport() {
  const period = exportPeriod();
  const site = currentSite();
  const nomMaquis = escapeHtml(site?.nom || state?.params?.nom || "Mon Maquis");
  const ville = escapeHtml(site?.ville || state?.params?.ville || "");
  const gerant = escapeHtml(site?.gerant || state?.params?.gerant || "");
  const generatedAt = new Date().toLocaleString("fr-FR");
  const periodLabel = escapeHtml(period.label || "Toute la période");

  const allVentes = recordsForSite(state.ventes);
  const ventes = recordsInPeriod(allVentes, (v) => saleDateValue(v), period)
    .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const allCharges = recordsForSite(state.charges);
  const charges = recordsInPeriod(allCharges, (c) => c.date, period)
    .slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const stockItems = recordsForSite(state.stock).slice().sort((a, b) =>
    String(a.article).localeCompare(String(b.article), "fr"));

  const caTotal = ventes.reduce((s, v) => s + calcNet(v), 0);
  const chargesTotal = charges.reduce((s, c) => s + (Number(c.montant) || 0), 0);
  const benefice = caTotal - chargesTotal;
  const nbVentes = ventes.length;

  const payTotals = ventes.reduce((acc, v) => {
    const k = v.paiement || "Autre";
    acc[k] = (acc[k] || 0) + calcNet(v);
    return acc;
  }, {});

  const PAY_COLORS = {
    "Espèces": "#1b5e20", "Orange Money": "#e65100", "MTN MoMo": "#f57f17",
    "Wave": "#0277bd", "Carte": "#4527a0", "Crédit client": "#b71c1c",
  };

  const rowsVentes = ventes.map((v) => {
    const color = PAY_COLORS[v.paiement] || "#37474f";
    return `<tr>
      <td>${escapeHtml(formatDateDdMmYyyy(v.date))}</td>
      <td><strong>${escapeHtml(v.article || "—")}</strong></td>
      <td style="color:#555">${escapeHtml(v.cat || "—")}</td>
      <td style="text-align:center">${escapeHtml(String(v.qty || 1))}</td>
      <td style="text-align:right">${fmt(v.prix)} FCFA</td>
      <td style="text-align:right;font-weight:600">${fmt(calcNet(v))} FCFA</td>
      <td><span class="badge-pay" style="background:${color}">${escapeHtml(v.paiement || "—")}</span></td>
      <td style="color:#555">${escapeHtml(v.server || v.serveur || "—")}</td>
    </tr>`;
  }).join("");

  const rowsCharges = charges.map((c) => {
    return `<tr>
      <td>${escapeHtml(formatDateDdMmYyyy(c.date))}</td>
      <td><strong>${escapeHtml(c.lib || "—")}</strong></td>
      <td style="color:#555">${escapeHtml(c.cat || "Autres")}</td>
      <td style="text-align:right;font-weight:600;color:#c62828">${fmt(c.montant)} FCFA</td>
      <td>${escapeHtml(c.paiement || "—")}</td>
    </tr>`;
  }).join("");

  const rowsStock = stockItems.map((item) => {
    const qte = stockActuel(item);
    let statut = "OK"; let sc = "#1b5e20"; let bg = "#e8f5e9";
    if (qte <= 0) { statut = "RUPTURE"; sc = "#b71c1c"; bg = "#ffebee"; }
    else if (qte <= Number(item.seuilMin || 0)) { statut = "CRITIQUE"; sc = "#b71c1c"; bg = "#ffebee"; }
    else if (qte <= Number(item.seuilMin || 0) * 2) { statut = "FAIBLE"; sc = "#e65100"; bg = "#fff3e0"; }
    const valeur = stockPurchaseValueFcfa(item);
    return `<tr style="background:${bg}">
      <td><strong>${escapeHtml(item.article || "—")}</strong></td>
      <td style="color:#555">${escapeHtml(item.cat || "—")}</td>
      <td style="text-align:center;font-weight:700;color:${sc}">${fmt(qte)}</td>
      <td style="text-align:center;color:#555">${fmt(item.seuilMin || 0)}</td>
      <td style="text-align:right">${fmt(item.prixAchat || 0)} FCFA</td>
      <td style="text-align:right">${fmt(valeur)} FCFA</td>
      <td style="text-align:center"><span class="badge-stock" style="background:${sc}">${statut}</span></td>
    </tr>`;
  }).join("");

  const payRows = Object.entries(payTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => {
    const c = PAY_COLORS[k] || "#37474f";
    return `<tr><td><span class="badge-pay" style="background:${c}">${escapeHtml(k)}</span></td>
      <td style="text-align:right;font-weight:600">${fmt(v)} FCFA</td>
      <td style="text-align:right;color:#555">${caTotal > 0 ? Math.round(v / caTotal * 100) : 0} %</td></tr>`;
  }).join("");

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rapport — ${nomMaquis}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f5f5f5;color:#212121;font-size:14px}
  .page{max-width:960px;margin:0 auto;padding:24px 16px 60px}
  /* ── En-tête ── */
  .header{background:linear-gradient(135deg,#c54f41,#7b241c);color:#fff;border-radius:12px;padding:28px 32px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
  .header h1{font-size:2rem;font-weight:800;letter-spacing:-0.5px}
  .header-sub{font-size:0.92rem;opacity:.85;margin-top:4px}
  .header-meta{text-align:right;font-size:0.82rem;opacity:.8;line-height:1.6}
  /* ── KPI cards ── */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:24px}
  .kpi{border-radius:10px;padding:18px 20px;color:#fff;position:relative;overflow:hidden}
  .kpi::after{content:'';position:absolute;right:-20px;top:-20px;width:80px;height:80px;border-radius:50%;background:rgba(255,255,255,.12)}
  .kpi-label{font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:.8px;opacity:.88}
  .kpi-value{font-size:1.7rem;font-weight:800;margin-top:4px;line-height:1}
  .kpi-sub{font-size:0.78rem;opacity:.8;margin-top:3px}
  .kpi-ca{background:linear-gradient(135deg,#1565c0,#0d47a1)}
  .kpi-charges{background:linear-gradient(135deg,#c62828,#b71c1c)}
  .kpi-ben{background:linear-gradient(135deg,#2e7d32,#1b5e20)}
  .kpi-ben.neg{background:linear-gradient(135deg,#bf360c,#b71c1c)}
  .kpi-ventes{background:linear-gradient(135deg,#6a1b9a,#4a148c)}
  /* ── Sections ── */
  section{background:#fff;border-radius:10px;border:1px solid #e0e0e0;margin-bottom:20px;overflow:hidden}
  .section-head{padding:14px 20px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #e0e0e0}
  .section-head h2{font-size:1rem;font-weight:700;flex:1}
  .section-badge{font-size:0.78rem;background:#f5f5f5;border:1px solid #ddd;border-radius:20px;padding:2px 10px;color:#555;font-weight:600}
  .section-body{overflow-x:auto}
  /* ── Tableaux ── */
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  thead tr{background:#fafafa}
  th{padding:10px 12px;text-align:left;font-size:0.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#757575;border-bottom:2px solid #e0e0e0}
  td{padding:9px 12px;border-bottom:1px solid #f0f0f0;vertical-align:middle}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#fafafa}
  /* ── Badges ── */
  .badge-pay,.badge-stock{display:inline-block;padding:2px 9px;border-radius:20px;font-size:0.72rem;font-weight:700;color:#fff;letter-spacing:.4px}
  /* ── Répartition paiements ── */
  .pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:0}
  .pay-grid table{border:none}
  /* ── Pied ── */
  .footer{text-align:center;color:#9e9e9e;font-size:0.78rem;margin-top:32px;padding-top:16px;border-top:1px solid #e0e0e0}
  .total-row{background:#f5f5f5!important;font-weight:700}
  .total-row td{border-top:2px solid #e0e0e0!important;border-bottom:none!important}
  .stripe tbody tr:nth-child(even){background:#fafafa}
  @media print{
    body{background:#fff}
    .page{padding:0}
    section{break-inside:avoid;border:1px solid #ccc}
    .kpi{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .header{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  }
</style>
</head>
<body>
<div class="page">

  <!-- En-tête -->
  <div class="header">
    <div>
      <h1>${nomMaquis}</h1>
      <div class="header-sub">${ville ? ville + " · " : ""}${gerant ? "Gérant : " + gerant : ""}</div>
    </div>
    <div class="header-meta">
      Rapport <strong>${periodLabel}</strong><br>
      Généré le ${escapeHtml(generatedAt)}
    </div>
  </div>

  <!-- KPI -->
  <div class="kpis">
    <div class="kpi kpi-ca">
      <div class="kpi-label">CA encaissé</div>
      <div class="kpi-value">${fmt(caTotal)}</div>
      <div class="kpi-sub">FCFA — ${periodLabel}</div>
    </div>
    <div class="kpi kpi-charges">
      <div class="kpi-label">Charges</div>
      <div class="kpi-value">${fmt(chargesTotal)}</div>
      <div class="kpi-sub">FCFA — ${periodLabel}</div>
    </div>
    <div class="kpi kpi-ben${benefice < 0 ? " neg" : ""}">
      <div class="kpi-label">Bénéfice net</div>
      <div class="kpi-value">${benefice >= 0 ? "" : "-"}${fmt(Math.abs(benefice))}</div>
      <div class="kpi-sub">FCFA — CA − Charges</div>
    </div>
    <div class="kpi kpi-ventes">
      <div class="kpi-label">Transactions</div>
      <div class="kpi-value">${nbVentes}</div>
      <div class="kpi-sub">vente${nbVentes > 1 ? "s" : ""} — ${periodLabel}</div>
    </div>
  </div>

  <!-- Répartition paiements -->
  ${Object.keys(payTotals).length ? `
  <section>
    <div class="section-head">
      <h2>Répartition des encaissements</h2>
      <span class="section-badge">${Object.keys(payTotals).length} mode(s)</span>
    </div>
    <div class="section-body">
      <table>
        <thead><tr><th>Mode de paiement</th><th style="text-align:right">Montant</th><th style="text-align:right">Part</th></tr></thead>
        <tbody>${payRows}
          <tr class="total-row"><td><strong>Total</strong></td><td style="text-align:right">${fmt(caTotal)} FCFA</td><td style="text-align:right">100 %</td></tr>
        </tbody>
      </table>
    </div>
  </section>` : ""}

  <!-- Ventes -->
  <section>
    <div class="section-head">
      <h2>Détail des ventes</h2>
      <span class="section-badge">${nbVentes} vente${nbVentes > 1 ? "s" : ""} · ${fmt(caTotal)} FCFA</span>
    </div>
    <div class="section-body">
      ${ventes.length ? `<table class="stripe">
        <thead><tr>
          <th>Date</th><th>Article</th><th>Catégorie</th>
          <th style="text-align:center">Qté</th><th style="text-align:right">Prix unit.</th>
          <th style="text-align:right">Net</th>
          <th>Paiement</th><th>Serveur</th>
        </tr></thead>
        <tbody>${rowsVentes}
          <tr class="total-row"><td colspan="5"><strong>Total</strong></td>
            <td style="text-align:right">${fmt(caTotal)} FCFA</td><td colspan="2"></td></tr>
        </tbody>
      </table>` : '<p style="padding:20px;color:#9e9e9e;text-align:center">Aucune vente sur cette période.</p>'}
    </div>
  </section>

  <!-- Stock -->
  <section>
    <div class="section-head">
      <h2>État du stock</h2>
      <span class="section-badge">${stockItems.length} article${stockItems.length > 1 ? "s" : ""}</span>
    </div>
    <div class="section-body">
      ${stockItems.length ? `<table>
        <thead><tr>
          <th>Article</th><th>Catégorie</th>
          <th style="text-align:center">Qté actuelle</th><th style="text-align:center">Seuil min.</th>
          <th style="text-align:right">Prix achat</th><th style="text-align:right">Valeur stock</th>
          <th style="text-align:center">Statut</th>
        </tr></thead>
        <tbody>${rowsStock}</tbody>
      </table>` : '<p style="padding:20px;color:#9e9e9e;text-align:center">Stock vide.</p>'}
    </div>
  </section>

  <!-- Charges -->
  <section>
    <div class="section-head">
      <h2>Détail des charges</h2>
      <span class="section-badge">${charges.length} charge${charges.length > 1 ? "s" : ""} · ${fmt(chargesTotal)} FCFA</span>
    </div>
    <div class="section-body">
      ${charges.length ? `<table class="stripe">
        <thead><tr>
          <th>Date</th><th>Libellé</th><th>Catégorie</th>
          <th style="text-align:right">Montant</th><th>Paiement</th>
        </tr></thead>
        <tbody>${rowsCharges}
          <tr class="total-row"><td colspan="3"><strong>Total</strong></td>
            <td style="text-align:right;color:#c62828">${fmt(chargesTotal)} FCFA</td><td></td></tr>
        </tbody>
      </table>` : '<p style="padding:20px;color:#9e9e9e;text-align:center">Aucune charge sur cette période.</p>'}
    </div>
  </section>

  <div class="footer">
    Rapport généré automatiquement par <strong>Maquis Manager</strong> · ${nomMaquis} · ${escapeHtml(generatedAt)}
  </div>
</div>
</body>
</html>`;

  const slug = exportFileSlug();
  const fname = `rapport_${exportPeriodFileBase(period, "rapport")}_${slug}.html`
    .replace(/rapport_rapport_/, "rapport_");
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fname;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast(`Rapport HTML exporté — ${period.label}.`);
}

function touchStockItemUpdated(item) {
  if (!item) return;
  item.updatedAt = new Date().toISOString();
  item.lastMajAt = item.updatedAt;
  item.lastMajBy = sessionUser || "";
}

function renderStockFilterBar(allItems, site) {
  const host = document.getElementById("stock-filter-bar");
  if (!host) return;
  const cats = ["all", ...new Set(allItems.map((i) => i.cat).filter(Boolean))];
  const counts = { all: allItems.length, alert: 0, rupture: 0, faible: 0, ok: 0, critique: 0 };
  allItems.forEach((item) => {
    const sk = stockRowStatusKey(item, site);
    if (sk !== "ok") counts.alert++;
    counts[sk] = (counts[sk] || 0) + 1;
  });
  const catBtns = cats.map((cat) => {
    const label = cat === "all" ? `Tous (${counts.all})` : cat;
    const active = stockCatFilter === cat ? " active" : "";
    return `<button type="button" class="tab stock-filter-tab${active}" data-stock-cat-filter="${escapeHtml(cat)}">${escapeHtml(label)}</button>`;
  }).join("");
  const statusDefs = [
    ["alert", `En alerte (${counts.alert})`, counts.alert > 0 ? " badge-red" : ""],
    ["rupture", `Rupture (${counts.rupture})`, ""],
    ["faible", `Faible (${counts.faible})`, ""],
    ["ok", `OK (${counts.ok})`, ""],
  ];
  const statusBtns = statusDefs.map(([key, label, extra]) => {
    const active = stockStatusFilter === key ? " active" : "";
    return `<button type="button" class="tab stock-filter-tab${active}${extra}" data-stock-status-filter="${key}">${escapeHtml(label)}</button>`;
  }).join("");
  host.innerHTML = `<div class="stock-filter-row">${catBtns}</div><div class="stock-filter-row stock-filter-row--status">${statusBtns}</div>`;
}

function updateCloseDayButtonLabel() {
  const btn = document.getElementById("close-day-btn");
  if (!btn || !canClosePdjDay()) return;
  const d = pdjCalendarDate();
  // Gérant (non-admin) sur site avec créneaux : ne pas écraser le bouton géré par renderDailyStockCheck
  if (canManagePdjAccounting() && !canAnyAdmin() && staffRequiresShiftWindowForSales()) {
    const closed2 = stockCheckForSiteDate(d, currentSiteId());
    if (!closed2) return;  // pas encore clôturé : renderDailyStockCheck gère le bouton
    const pend = pendingManagerConfirmationCheck(currentSiteId());
    if (pend && String(pend.date || "").slice(0, 10) === d) return;
  }
  btn.className = "btn btn-danger";
  const role = String(currentRole || "").trim();
  const suffix = role === "serveuse" ? " (fin de service)" : "";
  btn.textContent = `Clôturer la journée du ${formatDateDdMmYyyy(d)}${suffix}`;
}
let activeOrderId = null;
/** Date PDJ affichee (consultation / impression) sans imposer la journee serveur — par maquis. */
let pdjViewDateBySite = {};
/** true = affichage archive « Afficher » : journee deja cloturee, pas de nouvelle cloture. */
let pdjBrowseConsultationOnly = false;
let _pdjNoSalesReasonDraft = "";
let currentQrLinkInt = "";
let currentQrLinkExt = "";
let pendingFinalizeOrderId = null;
/** Évite double encaissement (clic répété ou réseau lent). */
const finalizeOrderInFlight = new Set();
/** Évite double création commande (réseau lent / double clic). */
const saisieRapideSubmitInFlight = new Set();
/** Idempotence saisie rapide : réutilisé si le PUT échoue et l'utilisateur réessaie. */
let srPendingClientRequestId = null;
/** Id commande saisie rapide en attente de confirmation serveur (réseau). */
let srPendingOrderId = null;
let liveSyncTimer = null;
let appLiveClockTimer = null;
let autoClotureTimer = null;
let _autoClotureInProgress = false;
let _lastUserInteractionAt = 0;
/** Jours réouverts manuellement : la clôture auto ne les referme pas. Clé : "siteId|date" */
const _autoClotureManualReopened = new Set();
let qrAlertCount = 0;
let knownQrOrderIds = new Set();
let flashingQrOrderIds = new Set();
/** Ignore un clic sur le fond du modal détail commande juste après ouverture (ghost click tactile). */
let suppressOrderDetailBackdropUntil = 0;
/** Cle site + jour PDJ : derniere valeur poussee dans v-date / orders-filter-date-* (evite d'ecraser le filtre a chaque sync). */
let ventesDomPdjStamp = "";
let pendingPreAuthToken = null;
let pendingWaUsername = null;
let pendingReceivePurchaseId = null;
let purchaseDraftLines = [];
/** Après fermeture du modal « nouveau casier » sans enregistrer, on annule la reprise commande achat. */
let pendingPurchaseCasierResume = false;
let sessionDeadlineUnix = null;
let csrfToken = null;

function isLocalDevHost() {
  const host = String(location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** Issue #2 : masquer l'export JSON header en production (localhost ou superadmin global). */
function shouldShowLocalJsonBackupUi() {
  return isLocalDevHost() || canGlobalSuperAdmin();
}

function monthPeriodBounds(refDate = new Date()) {
  const y = refDate.getFullYear();
  const m = refDate.getMonth();
  const start = `${y}-${pad2(m + 1)}-01`;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const end = `${y}-${pad2(m + 1)}-${pad2(daysInMonth)}`;
  return { start, end, daysInMonth };
}

function weekPeriodBounds(refDate = new Date()) {
  const d = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate());
  const day = d.getDay();
  const diffMon = (day + 6) % 7;
  const mon = new Date(d);
  mon.setDate(d.getDate() - diffMon);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const iso = (dt) => `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  return { start: iso(mon), end: iso(sun) };
}

function ventesEncaisseesForMonth(ventes, refDate = new Date()) {
  const { start, end } = monthPeriodBounds(refDate);
  return ventes.filter((v) => {
    const d = String(v.date || "").slice(0, 10);
    return d >= start && d <= end && !String(v.paiement || "").includes("dit client");
  });
}

function applySessionFieldsFromApi(payload) {
  if (!payload) return;
  if (payload.username) sessionUser = payload.username;
  if (payload.role) currentRole = normalizeRoleForUsername(payload.username || sessionUser, payload.role);
  if (Array.isArray(payload.allowedSiteIds)) allowedSiteIds = payload.allowedSiteIds;
  if ("globalSuperadmin" in payload) globalSuperadmin = payload.globalSuperadmin;
  if ("maquisBackupAllowed" in payload) maquisBackupAllowed = Boolean(payload.maquisBackupAllowed);
  applySessionTimingFromApi(payload);
}

function applySessionTimingFromApi(payload) {
  if (!payload) {
    return;
  }
  if ("globalSuperadmin" in payload && !("username" in payload)) {
    globalSuperadmin = payload.globalSuperadmin;
  }
  if (typeof payload.csrfToken === "string" && payload.csrfToken.trim()) {
    csrfToken = payload.csrfToken.trim();
  }
  if (typeof payload.sessionDeadlineUnix !== "number" || payload.sessionDeadlineUnix <= 0) {
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

/** Date comptable d'un versement recouvrement (jour du paiement, pas seulement le champ date). */
function creditRecoveryAccountingDate(r) {
  const paid = String(r?.paidAt || "").trim();
  if (paid.length >= 10) return paid.slice(0, 10);
  const d = String(r?.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d.slice(0, 10) : "";
}

function creditRecoveriesForPdjDate(dStr, sourceState = state) {
  const day = String(dStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  return creditRecoveriesForSite(sourceState).filter((r) => creditRecoveryAccountingDate(r) === day);
}

function isEspecesPaymentMethod(method) {
  const k = normalizePaymentMethodKey(method).replace(/\s/g, "");
  return k === "especes" || k === normalizePaymentMethodKey("Espèces").replace(/\s/g, "");
}

/** Encaissements espèces issus du recouvrement crédit pour une journée PDJ. */
function especesFromCreditRecoveriesForDate(dStr, sourceState = state) {
  return creditRecoveriesForPdjDate(dStr, sourceState).reduce((sum, r) => {
    if (!isEspecesPaymentMethod(r.paiement)) return sum;
    return sum + (Number(r.montant) || 0);
  }, 0);
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

/** Somme des restes à payer (tous débiteurs, toutes dates) — aligné sur « Total dû » du recouvrement. */
function totalCreditOutstanding(sourceState = state) {
  return Object.values(creditOutstandingMap(sourceState)).reduce((sum, n) => sum + (Number(n) || 0), 0);
}

/** Montant crédit / à régler émis sur les ventes d'une date comptable (sans déduire les remboursements). */
function creditIssuedOnDate(dStr, sourceState = state) {
  const day = String(dStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return 0;
  return recordsForSite(sourceState?.ventes || [])
    .filter((v) => String(v.date || "").slice(0, 10) === day)
    .reduce((sum, v) => sum + creditPortionOnVente(v), 0);
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
      const d = parseFlexibleDateTime(sold);
      if (!Number.isNaN(d.getTime())) {
        ts = d.getTime();
        hasTime = true;
      }
    }
    if (ts == null) {
      const day = String(v.date || "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        ts = parseDateTimeLocalInput(`${day}T12:00:00`).getTime();
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

/** Âge en jours calendaires depuis la première vente à crédit, par débiteur. */
function creditAgeInDaysByDebtor(sourceState = state) {
  const ventes = recordsForSite(sourceState?.ventes || []);
  const best = {};
  ventes.forEach((v) => {
    const net = calcNet(v);
    const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: net }];
    const debtorName = debtorDisplayKey(v.debiteur || v.client || "Client inconnu");
    let creditAmount = 0;
    details.forEach((d) => { if (isCreditClientMethod(d.method)) creditAmount += Number(d.amount) || 0; });
    if (!creditAmount && isAReglerPaiement(v.paiement)) creditAmount = net;
    if (creditAmount <= 0) return;
    const sold = String(v.soldAt || v.createdAt || "").trim();
    let ts;
    if (sold) { const d = parseFlexibleDateTime(sold); if (!Number.isNaN(d.getTime())) ts = d.getTime(); }
    if (ts == null) {
      const day = String(v.date || "").trim().slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) ts = new Date(day + "T00:00:00").getTime();
    }
    if (ts == null || !Number.isFinite(ts)) return;
    if (!best[debtorName] || ts < best[debtorName]) best[debtorName] = ts;
  });
  const now = Date.now();
  const ages = {};
  Object.keys(best).forEach((k) => { ages[k] = Math.floor((now - best[k]) / 86400000); });
  return ages;
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

/** Parse un entier affiché avec fmt() / fr-FR (espaces insécables, virgules). */
function parseFormattedIntegerFr(text) {
  const raw = String(text ?? "")
    .replace(/\u202f/g, "")
    .replace(/\u00a0/g, "")
    .replace(/\s/g, "")
    .replace(/[^\d+-]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : 0;
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
    // Champ cause journée sans vente : mettre à jour l'état du bouton en temps réel
    if (t.id === "pdj-no-sales-reason") {
      _pdjNoSalesReasonDraft = t.value;
      const btn = document.getElementById("close-day-btn");
      if (btn) pdjApplyCloseDayButtonGate(btn, {});
    }
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
 * Date de travail effective : si une journée passée est encore ouverte (caisse validée, pas de clôture stock),
 * on reste sur cette date jusqu'à la clôture — saisies le lendemain possibles.
 * Sinon, avant NIGHT_SHIFT_CUTOFF_HOUR, si hier est encore ouvert, on reste sur hier (maquis de nuit).
 */
function workingDate() {
  const siteId = currentSiteId();
  const unclosed = firstUnclosedJournalDate(siteId);
  const t = today();
  if (unclosed && String(unclosed).slice(0, 10) < t) {
    return String(unclosed).slice(0, 10);
  }
  // Aujourd'hui clôturé + lendemain déjà ouvert → avancer au lendemain
  const tomorrow = addCalendarDaysIso(t, 1);
  if (unclosed === tomorrow && stockCheckForSiteDate(t, siteId)) return tomorrow;
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

/**
 * Horodatages JSON (soldAt, createdAt, paidAt…) : avec Z ou décalage explicite → instant correct.
 * Sans fuseau (ex. anciennes données) : composantes lues en UTC (comme toISOString() / serveur gmtime en Z),
 * puis affichage converti par le navigateur vers le fuseau local de l'appareil.
 */
function parseFlexibleDateTime(input) {
  if (input == null || input === "") return new Date(NaN);
  if (input instanceof Date) return input;
  const s = String(input).trim();
  if (!s) return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  if (/[zZ]$/.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) {
    const t = Date.parse(s);
    return new Date(Number.isFinite(t) ? t : NaN);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const da = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    const se = Number(m[6] || 0);
    return new Date(Date.UTC(y, mo, da, h, mi, se));
  }
  const t = Date.parse(s);
  return new Date(Number.isFinite(t) ? t : NaN);
}

/** Valeur d'input[type=datetime-local] : heure « murale » du fuseau de cet appareil (sans Z). */
function parseDateTimeLocalInput(input) {
  if (input == null || input === "") return new Date(NaN);
  if (input instanceof Date) return input;
  const s = String(input).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0));
  }
  return new Date(NaN);
}

/** yyyy-mm-dd + delta jours (fuseau local, midi pour limiter les bugs DST). */
function addCalendarDaysIso(isoDateFragment, deltaDays) {
  const d = String(isoDateFragment ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(deltaDays) || deltaDays === 0) return d;
  const dt = parseDateTimeLocalInput(`${d}T12:00:00`);
  dt.setDate(dt.getDate() + deltaDays);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

/** Chaîne ISO datetime : remplace les 10 premiers caractères (date) par la même heure le jour décalé. */
function shiftIsoDatetimeLeadingCalendarDay(str, deltaDays) {
  const s = String(str ?? "").trim();
  if (!s) return s;
  const head = s.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return s;
  return addCalendarDaysIso(head, deltaDays) + s.slice(10);
}

/** Affiche jj-mm-aaaa (Date, chaîne ISO datetime, ou yyyy-mm-dd). */
function formatDateDdMmYyyy(input) {
  if (input == null || input === "") return "—";
  const str = String(input).trim();
  const dOnly = str.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dOnly)) return isoDateToDdMmYyyy(dOnly);
  const d = input instanceof Date ? input : parseFlexibleDateTime(input);
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

/** jj-mm-aaaa HH:mm (fuseau local du navigateur). */
function formatDateTimeDdMmYyyy(input) {
  if (input == null || input === "") return "—";
  const d = input instanceof Date ? input : parseFlexibleDateTime(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Heure locale (HH:mm), affichage homogène (fuseaux à décalage fractionné inclus). */
function formatLocalHourMinute(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "--:--";
  return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false, hourCycle: "h23" }).format(d);
}

/** Valeur pour input[type=datetime-local] (heure locale réelle, sans bug de fuseau). */
function datetimeLocalNow() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatCreditPaidAt(p) {
  const raw = String(p?.paidAt || p?.createdAt || "").trim();
  if (raw) {
    try {
      const d = parseFlexibleDateTime(raw);
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

/** Note affichée / enregistrée pour un versement recouvrement si le champ est vide. */
const CREDIT_RECOVERY_DEFAULT_NOTE = "Payé";

/** Délai d’affichage de l’historique après solde complet (jours). */
const CREDIT_HISTORY_SETTLED_RETENTION_DAYS = 3;

function formatCreditRecoveryNote(p) {
  return String(p?.note ?? "").trim() || CREDIT_RECOVERY_DEFAULT_NOTE;
}

function creditRecoveryPaidAtMs(p) {
  const raw = String(p?.paidAt || p?.createdAt || `${p?.date || ""}T12:00:00`).trim();
  const t = parseFlexibleDateTime(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

function calendarDaysSince(ms) {
  if (!ms) return 0;
  const start = new Date(ms);
  const now = new Date();
  start.setHours(0, 0, 0, 0);
  now.setHours(0, 0, 0, 0);
  return Math.floor((now - start) / 86400000);
}

/** Versement individuel : masqué si client soldé et date du versement > N jours. */
function isCreditRecoveryPaymentBeyondHistoryRetention(
  p,
  sourceState = state,
  retentionDays = CREDIT_HISTORY_SETTLED_RETENTION_DAYS,
) {
  const payMs = creditRecoveryPaidAtMs(p);
  if (!payMs) return false;
  return calendarDaysSince(payMs) > Math.max(1, retentionDays);
}

/**
 * Versements visibles dans l’historique :
 * - dette encore ouverte → tous les versements du client ;
 * - client soldé → chaque versement disparaît N jours après sa propre date.
 */
function isCreditRecoveryVisibleInHistoryUi(p, sourceState = state) {
  const dk = debtorDisplayKey(p.debiteur);
  const remaining = Math.round(Number(creditOutstandingMap(sourceState)[dk]) || 0);
  if (remaining > 0) return true;
  if (issuedCreditTotalForDebtor(dk, sourceState) <= 0) return false;
  return !isCreditRecoveryPaymentBeyondHistoryRetention(p, sourceState);
}

function creditRecoveriesForHistoryUi(sourceState = state) {
  return creditRecoveriesForSite(sourceState).filter((p) => isCreditRecoveryVisibleInHistoryUi(p, sourceState));
}

/** Versements enregistrés par débiteur pour l’affichage recouvrement (dette encore ouverte), tri récent → ancien. */
function creditRecoveriesGroupedByDebtor(sourceState = state) {
  const map = {};
  creditRecoveriesForHistoryUi(sourceState).forEach((p) => {
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

/** Table HTML : versements recouvrement (débiteurs encore dus), du plus récent au plus ancien. */
function buildCreditRecoveryHistoryHtml() {
  const allSite = creditRecoveriesForSite();
  const payments = creditRecoveriesForHistoryUi()
    .slice()
    .sort((a, b) => String(b.paidAt || b.createdAt || "").localeCompare(String(a.paidAt || a.createdAt || "")));
  const hasHiddenBecauseSoldes = allSite.length > 0 && payments.length === 0;
  if (!payments.length) {
    const emptyMsg = hasHiddenBecauseSoldes
      ? "Aucun versement affiché pour ce maquis (aucune ligne recouvrement liée à des ventes « crédit client » connues)."
      : "Aucun versement enregistré pour ce maquis. Après « Enregistrer le versement », chaque paiement apparaît ici avec date, montant et mode.";
    return `<div class="credit-history-section" style="margin-top:18px">
      <p class="eyebrow" style="margin-bottom:8px">Historique des paiements</p>
      <p class="muted" style="font-size:0.9rem">${emptyMsg}</p>
    </div>`;
  }
  const rows = payments.map((p) => `
    <tr>
      <td><button type="button" class="credit-moment-btn" data-credit-pay-detail="${String(p.id)}" title="Voir le détail du versement">${escapeHtml(formatCreditPaidAt(p))}</button></td>
      <td><strong>${escapeHtml(debtorDisplayKey(p.debiteur))}</strong></td>
      <td style="text-align:right;color:#72d7a9;font-weight:600">${fmt(p.montant)} FCFA</td>
      <td>${escapeHtml(p.paiement || "—")}</td>
      <td class="muted" style="font-size:0.88rem;max-width:240px">${escapeHtml(formatCreditRecoveryNote(p))}</td>
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
    <p class="muted" style="font-size:0.78rem;margin-top:8px;line-height:1.4">Versements liés à des ventes « crédit client » de ce maquis. Client soldé : chaque ligne disparaît ${CREDIT_HISTORY_SETTLED_RETENTION_DAYS} jours après sa date de paiement. Les encaissements sans vente crédit correspondante ne s’affichent pas ici.</p>
  </div>`;
}

/** Montant « crédit client » ou « à régler » pris sur une vente (FCFA). */
function creditPortionOnVente(v) {
  if (!v) return 0;
  const net = calcNet(v);
  const details = v.paiementDetails?.length ? v.paiementDetails : [{ method: v.paiement || "", amount: net }];
  let creditAmount = 0;
  details.forEach((d) => {
    if (isCreditClientMethod(d.method)) creditAmount += Number(d.amount) || 0;
  });
  if (!creditAmount && isAReglerPaiement(v.paiement)) creditAmount = net;
  return Math.max(0, creditAmount);
}

/** Total crédit « émis » (ventes) pour un débiteur sur le maquis courant — pour l'historique recouvrement même dette soldée. */
function issuedCreditTotalForDebtor(debtorKey, sourceState = state) {
  const dk = debtorDisplayKey(debtorKey);
  return recordsForSite(sourceState?.ventes || []).reduce((sum, v) => {
    const debtorName = debtorDisplayKey(v.debiteur || v.client || "Client inconnu");
    if (debtorName !== dk) return sum;
    return sum + creditPortionOnVente(v);
  }, 0);
}

/** Ventes à crédit pour un débiteur (ordre chronologique d'encaissement). */
function ventesCreditBreakdownForDebtor(debtorKey) {
  const dk = debtorDisplayKey(debtorKey);
  const out = [];
  recordsForSite(state.ventes || []).forEach((v) => {
    const debtorName = debtorDisplayKey(v.debiteur || v.client || "Client inconnu");
    if (debtorName !== dk) return;
    const creditFcfa = creditPortionOnVente(v);
    if (creditFcfa <= 0) return;
    const sold = String(v.soldAt || v.createdAt || "").trim();
    const ts = sold ? parseFlexibleDateTime(sold).getTime() : NaN;
    out.push({ v, creditFcfa, ts: Number.isFinite(ts) ? ts : 0 });
  });
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

/** Ventes à crédit regroupées par numéro de facture (une ligne par facture dans le détail). */
function ventesCreditBreakdownByFactureForDebtor(debtorKey) {
  const lines = ventesCreditBreakdownForDebtor(debtorKey);
  const byFact = new Map();
  for (const row of lines) {
    const v = row.v;
    const fk = String(v.factureNumber || "").trim() || `VENTE-${v.id}`;
    if (!byFact.has(fk)) byFact.set(fk, []);
    byFact.get(fk).push(row);
  }
  const groups = [];
  byFact.forEach((groupLines, factureKey) => {
    const sorted = groupLines.slice().sort((a, b) => a.ts - b.ts);
    const first = sorted[0];
    const creditSum = sorted.reduce((s, r) => s + r.creditFcfa, 0);
    const lineSum = sorted.reduce((s, r) => s + calcNet(r.v), 0);
    const saleDays = [...new Set(sorted.map((r) => formatDateDdMmYyyy(r.v.date)))].sort();
    const journVente = saleDays.length <= 1 ? (saleDays[0] || "—") : saleDays.join(" · ");
    const articlesCell = sorted
      .map((r) => `${escapeHtml(r.v.article || "—")} — <span class="muted">dû : ${fmt(r.creditFcfa)} FCFA</span>`)
      .join("<br>");
    const paySet = [...new Set(sorted.map((r) => String(r.v.paiement || "").trim() || "—"))];
    const payLabel = paySet.length === 1 ? paySet[0] : paySet.join(" · ");
    const serveurParts = sorted.map((r) => String(r.v.server || r.v.serveur || "").trim()).filter(Boolean);
    const serveurFromCredit = sorted.map((r) => String(r.v.creditIssuedBy || "").trim()).find(Boolean);
    const serveurLabel = serveurParts.length
      ? [...new Set(serveurParts)].join(" · ")
      : (serveurFromCredit || "—");
    const issSet = [...new Set(sorted.map((r) => String(r.v.creditIssuedBy || "").trim()).filter(Boolean))];
    const issLabel = issSet.length ? issSet.join(" · ") : "—";
    const notes = sorted.map((r) => String(r.v.note || "").trim()).filter(Boolean);
    const noteLabel = notes.length ? [...new Set(notes)].join(" · ") : "—";
    const enc = String(first.v.soldAt || first.v.createdAt || "").trim();
    const encLabel = enc
      ? formatDateTimeDdMmYyyy(parseFlexibleDateTime(enc))
      : `${formatDateDdMmYyyy(first.v.date)} (heure non renseignée)`;
    groups.push({
      factureKey,
      first,
      encLabel,
      journVente,
      articlesCell,
      creditSum,
      lineSum,
      payLabel,
      serveurLabel,
      issLabel,
      noteLabel,
    });
  });
  groups.sort((a, b) => a.first.ts - b.first.ts);
  return groups;
}

function openCreditDebtorOpenedDetailModal(debtorRaw) {
  const dk = debtorDisplayKey(debtorRaw);
  const titleEl = document.getElementById("credit-detail-title");
  const body = document.getElementById("credit-detail-body");
  if (!body) return;
  if (titleEl) titleEl.textContent = `Prise du crédit — ${dk}`;
  const issuer = creditIssuerLabelsByDebtor()[dk] || "—";
  const rows = ventesCreditBreakdownForDebtor(dk);
  if (!rows.length) {
    body.innerHTML = `<p class="muted">Aucune vente en « Crédit client » ou « À régler » trouvée pour ce nom sur ce maquis.</p>`;
    openModal("modal-credit-detail");
    return;
  }
  const factGroups = ventesCreditBreakdownByFactureForDebtor(dk);
  const first = rows[0].v;
  const firstMoment = String(first.soldAt || first.createdAt || "").trim();
  const firstLabel = firstMoment
    ? formatDateTimeDdMmYyyy(parseFlexibleDateTime(firstMoment))
    : `${formatDateDdMmYyyy(first.date)} (heure non renseignée)`;
  const tableRows = factGroups
    .map(
      (g) => `<tr>
      <td class="muted" style="white-space:nowrap;font-size:0.88rem">${escapeHtml(g.encLabel)}</td>
      <td>${escapeHtml(g.journVente)}</td>
      <td>${escapeHtml(g.factureKey)}</td>
      <td style="font-size:0.88rem;line-height:1.35">${g.articlesCell}</td>
      <td style="text-align:right;font-weight:600">${fmt(g.creditSum)} FCFA</td>
      <td style="text-align:right">${fmt(g.lineSum)} FCFA</td>
      <td>${escapeHtml(g.payLabel)}</td>
      <td class="muted" style="font-size:0.85rem">${escapeHtml(g.serveurLabel)}</td>
      <td class="muted" style="font-size:0.85rem">${escapeHtml(g.issLabel)}</td>
      <td class="muted" style="font-size:0.82rem;max-width:200px">${escapeHtml(g.noteLabel)}</td>
    </tr>`,
    )
    .join("");
  body.innerHTML = `
    <p class="muted" style="margin-bottom:10px;line-height:1.45">
      La colonne <strong>Prise du crédit</strong> du tableau reprend la <strong>première</strong> vente à crédit chronologiquement : <strong>${escapeHtml(firstLabel)}</strong>.
      Crédit accordé par (résumé) : <strong>${escapeHtml(issuer)}</strong>.
    </p>
    <p class="muted" style="margin-bottom:10px;font-size:0.86rem;line-height:1.45">
      Ci‑dessous, <strong>une ligne par facture</strong>. Chaque article listé est une ligne de vente avec <strong>crédit / à régler</strong> : la mention <strong>dû</strong> indique le montant crédit pour cette ligne. La colonne <strong>Heure facture</strong> est l’horodatage d’enregistrement de la vente (pas un versement de recouvrement).
    </p>
    <div class="stock-table-wrap">
      <table class="stock-table" style="min-width:880px">
        <thead><tr>
          <th>Heure facture</th>
          <th>Journée vente</th>
          <th>Facture</th>
          <th>Articles dus (crédit)</th>
          <th style="text-align:right">Montant crédit</th>
          <th style="text-align:right">Total lignes</th>
          <th>Paiement (vente)</th>
          <th>Serveur</th>
          <th>Accord crédit</th>
          <th>Note</th>
        </tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
  openModal("modal-credit-detail");
}

function openCreditPaymentDetailModal(recoveryId) {
  const id = Number(recoveryId);
  const p = creditRecoveriesForSite().find((x) => Number(x.id) === id);
  const titleEl = document.getElementById("credit-detail-title");
  const body = document.getElementById("credit-detail-body");
  if (!body) return;
  if (!p) {
    if (titleEl) titleEl.textContent = "Versement introuvable";
    body.innerHTML = `<p class="muted">Ce versement n'est plus dans les données affichées pour ce maquis.</p>`;
    openModal("modal-credit-detail");
    return;
  }
  if (titleEl) titleEl.textContent = `Versement — ${debtorDisplayKey(p.debiteur)}`;
  const paidRaw = String(p.paidAt || "").trim();
  const createdRaw = String(p.createdAt || "").trim();
  const paidIso = paidRaw ? formatDateTimeDdMmYyyy(paidRaw) : "—";
  const createdIso = createdRaw ? formatDateTimeDdMmYyyy(createdRaw) : "—";
  const isDoublon = creditRecoveryIsDoublon(p);
  const deleteBtn = canManage() && isDoublon
    ? `<div class="button-stack" style="margin-top:16px"><button type="button" class="btn btn-danger" data-delete-credit-recovery="${escapeHtml(String(p.id))}">Supprimer ce versement (doublon)</button></div>`
    : "";
  body.innerHTML = `
    <dl class="audit-detail-dl">
      <div><dt>Client (débiteur)</dt><dd><strong>${escapeHtml(debtorDisplayKey(p.debiteur))}</strong></dd></div>
      <div><dt>Montant versé</dt><dd><strong style="color:#72d7a9">${fmt(p.montant)} FCFA</strong></dd></div>
      <div><dt>Mode</dt><dd>${escapeHtml(p.paiement || "—")}</dd></div>
      <div><dt>Date comptable</dt><dd>${escapeHtml(p.date ? formatDateDdMmYyyy(p.date) : "—")}</dd></div>
      <div><dt>Date / heure versement</dt><dd>${escapeHtml(paidIso)}</dd></div>
      <div><dt>Enregistré le</dt><dd>${escapeHtml(createdIso)}</dd></div>
      <div><dt>Identifiant</dt><dd>${escapeHtml(String(p.id ?? "—"))}</dd></div>
    </dl>
    <div class="form-group" style="margin-top:14px">
      <label>Note</label>
      <div class="audit-detail-block">${escapeHtml(formatCreditRecoveryNote(p))}</div>
    </div>
    <p class="muted" style="font-size:0.82rem;margin-top:10px">Heure affichée selon l'horloge de cet appareil (fuseau local).</p>
    ${deleteBtn}`;
  openModal("modal-credit-detail");
}

async function deleteCreditRecovery(recoveryId) {
  if (!canManage()) {
    showToast("Reserve aux gerants et administrateurs.");
    return;
  }
  const id = Number(recoveryId);
  const row = creditRecoveriesForSite().find((x) => Number(x.id) === id);
  if (!row) {
    showToast("Versement introuvable pour ce maquis.");
    return;
  }
  const label = `${debtorDisplayKey(row.debiteur)} · ${fmt(row.montant)} FCFA · ${formatCreditPaidAt(row)}`;
  if (!window.confirm(`Supprimer ce versement en doublon ?\n\n${label}\n\nCe montant sera recompte comme credit en cours pour ce client.`)) {
    return;
  }
  state.creditRecoveries = (state.creditRecoveries || []).filter((x) => Number(x.id) !== id);
  recordStaffAudit(
    "delete",
    "credit_recovery",
    `Suppression versement credit · ${debtorDisplayKey(row.debiteur)}`,
    `${fmt(row.montant)} FCFA · ${row.paiement || ""} · id ${id}`,
  );
  await persistState({ creditRecoveries: state.creditRecoveries, staffAuditLog: state.staffAuditLog, nextId: state.nextId });
  closeModal("modal-credit-detail");
  renderCreditRecovery();
  renderDashboard();
  renderPointDuJour();
  if (currentPage === "ventes") renderVentesPage();
  showToast("Versement supprime. Les totaux ont ete recalcules.");
}

function calcNet(item) {
  return (Number(item.prix) || 0) * (Number(item.qty) || 0) - (Number(item.remise) || 0);
}

function paymentLabel(item) {
  if (item?.paiementDetails?.length > 1) return "Mixte";
  if (item?.paiementDetails?.length === 1) return item.paiementDetails[0].method;
  return item?.paiement || "";
}

function isCreditClientPayment(method) {
  const m = String(method || "").toLowerCase();
  return m.includes("dit client") || m.includes("à régler") || m.includes("a regler");
}

function paymentTotals(list) {
  return (list || []).reduce((acc, item) => {
    if (Array.isArray(item.paiementDetails) && item.paiementDetails.length) {
      const detailSum = item.paiementDetails.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const net = calcNet(item);
      const scale = detailSum > 0 ? net / detailSum : 1;
      item.paiementDetails.forEach((detail) => {
        acc[detail.method] = (acc[detail.method] || 0) + Math.round((Number(detail.amount) || 0) * scale);
      });
    } else {
      acc[item.paiement] = (acc[item.paiement] || 0) + calcNet(item);
    }
    return acc;
  }, {});
}

/** Encaissements réels (hors crédit client émis) — aligné PDJ. */
function paymentTotalsEncaissements(list) {
  return (list || []).reduce((acc, item) => {
    if (Array.isArray(item.paiementDetails) && item.paiementDetails.length) {
      const detailSum = item.paiementDetails.reduce((s, d) => s + (Number(d.amount) || 0), 0);
      const net = calcNet(item);
      const scale = detailSum > 0 ? net / detailSum : 1;
      item.paiementDetails.forEach((detail) => {
        if (isCreditClientPayment(detail.method)) return;
        acc[detail.method] = (acc[detail.method] || 0) + Math.round((Number(detail.amount) || 0) * scale);
      });
    } else if (!isCreditClientPayment(item.paiement)) {
      acc[item.paiement] = (acc[item.paiement] || 0) + calcNet(item);
    }
    return acc;
  }, {});
}

function creditClientEmittedTotal(list) {
  return (list || []).reduce((sum, item) => {
    if (Array.isArray(item.paiementDetails) && item.paiementDetails.length) {
      item.paiementDetails.forEach((detail) => {
        if (isCreditClientPayment(detail.method)) sum += Number(detail.amount) || 0;
      });
    } else if (isCreditClientPayment(item.paiement)) {
      sum += calcNet(item);
    }
    return sum;
  }, 0);
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

/** Complète formatQuantite / packSize sur une vente (anciennes lignes ou kits). */
function ensureVentePackMetadata(vente) {
  if (!vente) return 1;
  const si = stockItemForArticle(vente.article, vente.siteId);
  const pack = linePackSize(vente, si);
  if (pack > 1) {
    if (!Number(vente.formatQuantite)) vente.formatQuantite = pack;
    if (!Number(vente.packSize)) vente.packSize = pack;
  }
  return pack;
}

function syncReplaceQtyFieldLabel(vente) {
  const label = document.querySelector('label[for="replace-qty"]');
  const qtyWrap = document.getElementById("replace-qty-wrap");
  let hintEl = document.getElementById("replace-qty-hint");
  if (!hintEl && qtyWrap) {
    hintEl = document.createElement("p");
    hintEl.id = "replace-qty-hint";
    hintEl.className = "muted";
    hintEl.style.cssText = "font-size:0.82rem;margin:4px 0 0;line-height:1.4";
    qtyWrap.appendChild(hintEl);
  }
  const pack = ensureVentePackMetadata(vente);
  const qty = Math.max(1, Number(vente?.qty) || 1);
  if (label) {
    label.textContent = pack > 1 ? "Nombre de kits à remplacer" : "Quantité à remplacer";
  }
  if (hintEl) {
    if (pack > 1) {
      hintEl.textContent = `1 kit = ${fmt(pack)} bouteille(s). Ligne actuelle : ${fmt(qty)} kit(s) soit ${fmt(qty * pack)} btl au stock.`;
      hintEl.classList.remove("hidden");
    } else {
      hintEl.textContent = "";
      hintEl.classList.add("hidden");
    }
  }
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

/** Prix d'achat unitaire (casier ÷ bouteilles par casier). */
function prixAchatParBouteille(item = {}) {
  const paCasier = Number(item?.prixAchat) || 0;
  if (paCasier <= 0) return 0;
  return paCasier / Math.max(1, caseSize(item));
}

/** Bénéfice par bouteille vendue (zone int ou ext). null si données incomplètes. */
function stockMarginPerBottle(item = {}, zone = "int", site = currentSite(), asOfDate = today()) {
  const pa = prixAchatParBouteille(item);
  if (pa <= 0) return null;
  const primary = primarySaleFormat(item, asOfDate);
  const packQty = Math.max(1, Number(primary?.quantite) || Number(item.packSize) || 1);
  const { prixInt, prixExt } = resolveItemPrices(item, asOfDate);
  const packPrice = zone === "ext"
    ? (Number(primary?.prixExterieur) || prixExt)
    : (Number(primary?.prixInterieur) || prixInt);
  if (packPrice <= 0) return null;
  return packPrice / packQty - pa;
}

/** Bénéfice sur un casier complet (marge unitaire × bouteilles/casier). */
function stockMarginPerCase(item = {}, zone = "int", site = currentSite(), asOfDate = today()) {
  const m = stockMarginPerBottle(item, zone, site, asOfDate);
  if (m == null) return null;
  return m * caseSize(item);
}

function formatMarginFcfa(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const cls = rounded >= 0 ? "margin-positive" : "margin-negative";
  const sign = rounded >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${fmt(rounded)}</span>`;
}

/**
 * Marge brute sur un ensemble de lignes de vente : CA net − (prix achat / btl × bouteilles vendues).
 * Lignes sans article catalogue ou sans prix d'achat : exclus du total (voir excludedLines).
 */
function grossMarginFromVenteLines(ventesList) {
  let marge = 0;
  let excludedLines = 0;
  for (const v of ventesList || []) {
    const si = stockItemForArticle(v.article);
    const paBtl = prixAchatParBouteille(si);
    if (!si || paBtl <= 0) {
      excludedLines += 1;
      continue;
    }
    const bottles = lineBottleQty(v, si);
    marge += calcNet(v) - paBtl * bottles;
  }
  return { margeBrute: Math.round(marge), excludedLines };
}

/** Bénéfice opérationnel estimé PDJ : marge brute ventes − charges (hors recouvrement anciennes créances). */
function pdjEstimatedBenefitFromSales(ventesList, chargesTotal) {
  const { margeBrute, excludedLines } = grossMarginFromVenteLines(ventesList);
  const charges = Math.round(Number(chargesTotal) || 0);
  return {
    margeBrute,
    beneficeEstime: margeBrute - charges,
    excludedLines,
    charges,
  };
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

async function apiRequest(url, options = {}) {
  const { cache, ...rest } = options;
  const method = String(rest.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(rest.headers || {}) };
  if (csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const init = {
    credentials: "same-origin",
    ...rest,
    headers,
  };
  if (cache != null) init.cache = cache;
  const response = await fetch(url, init);
  const isJson = (response.headers.get("Content-Type") || "").includes("application/json");
  const payload = isJson ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function requireReauth() {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "reauth-overlay";
    overlay.innerHTML = `
      <div class="reauth-dialog">
        <h3 class="reauth-title">Confirmer l'identité</h3>
        <p class="reauth-desc">Cette action est irréversible. Entrez votre mot de passe pour continuer.</p>
        <div class="reauth-field">
          <label for="reauth-pw">Mot de passe</label>
          <input id="reauth-pw" type="password" autocomplete="current-password" placeholder="••••••••">
        </div>
        <div class="reauth-error" id="reauth-error" style="display:none"></div>
        <div class="reauth-actions">
          <button class="btn btn-outline" id="reauth-cancel">Annuler</button>
          <button class="btn btn-danger" id="reauth-confirm">Confirmer</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const pwInput = overlay.querySelector("#reauth-pw");
    const errEl   = overlay.querySelector("#reauth-error");
    const confirmBtn = overlay.querySelector("#reauth-confirm");
    const cancelBtn  = overlay.querySelector("#reauth-cancel");
    requestAnimationFrame(() => pwInput.focus());

    async function attempt() {
      const password = pwInput.value;
      if (!password) { errEl.textContent = "Mot de passe requis."; errEl.style.display = ""; return; }
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Vérification…";
      try {
        const resp = await apiRequest("/api/reauth", { method: "POST", body: JSON.stringify({ password }) });
        overlay.remove();
        resolve(resp.reauthToken);
      } catch (err) {
        errEl.textContent = err.message || "Mot de passe incorrect.";
        errEl.style.display = "";
        confirmBtn.disabled = false;
        confirmBtn.textContent = "Confirmer";
        pwInput.value = "";
        pwInput.focus();
      }
    }

    confirmBtn.addEventListener("click", attempt);
    pwInput.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
    cancelBtn.addEventListener("click", () => { overlay.remove(); resolve(null); });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
  });
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

let _siteCache = { stateRef: null, activeSiteId: undefined, siteId: null, site: null };

function _refreshSiteCache() {
  if (_siteCache.stateRef === state && _siteCache.activeSiteId === state?.activeSiteId) return;
  _siteCache.stateRef = state;
  _siteCache.activeSiteId = state?.activeSiteId;
  _siteCache.siteId = state?.activeSiteId || state?.sites?.[0]?.id || null;
  _siteCache.site = (state?.sites || []).find((s) => s.id === _siteCache.siteId) || state?.sites?.[0] || null;
}

function currentSiteId() {
  _refreshSiteCache();
  return _siteCache.siteId;
}

function currentSite() {
  _refreshSiteCache();
  return _siteCache.site;
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
  if (currentRole === "admin") return true;  // admin de maquis = superadmin scopé sur ses maquis
  const sn = String(sessionUser || "").trim();
  if (sn.toLowerCase() === "admin") return true;
  const u = (state?.auth?.users || []).find((x) => String(x.username || "").trim().toLowerCase() === sn.toLowerCase());
  if (u && (String(u.role || "") === "superadmin" || String(u.role || "") === "admin")) return true;
  return false;
}

/** Superadmin « racine » (tous maquis) : sauvegardes serveur, creation maquis, decalage global, etc. */
function canGlobalSuperAdmin() {
  if (String(sessionUser || "").trim().toLowerCase() === "admin") return true;
  if (!canSuperAdmin()) return false;
  if (globalSuperadmin === undefined || globalSuperadmin === null) return true;
  return Boolean(globalSuperadmin);
}

/** Sauvegarde / restauration par maquis (admins scopés ou superadmin global — pas la gérante). */
function canManageMaquisBackups() {
  if (maquisBackupAllowed === false) return false;
  if (isGerantRole()) return false;
  if (canGlobalSuperAdmin()) return true;
  if (!canAnyAdmin()) return false;
  return (allowedSiteIds || []).length > 0;
}

function sitesVisibleToSession() {
  const sites = state?.sites || [];
  if (canGlobalSuperAdmin()) return sites;
  const allowed = new Set((allowedSiteIds || []).map(String));
  return sites.filter((s) => allowed.has(String(s.id)));
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


// ─── Planning / horaires équipe ─────────────────────────────────────────────
let planningSubTab = "mine";

function canManageTeamSchedule() {
  return canManage();
}

function planningIsoDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function planningParseIso(s) {
  const t = String(s || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  const [y, m, d] = t.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** Semaine calendaire (lun–dim) contenant la date de référence. */
function planningWeekBoundsForRef(ref = new Date()) {
  const r = new Date(ref);
  r.setHours(12, 0, 0, 0);
  const day = (r.getDay() + 6) % 7;
  const mon = new Date(r);
  mon.setDate(r.getDate() - day);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return { start: planningIsoDate(mon), end: planningIsoDate(sun) };
}

function planningWeekBounds(offset = 0) {
  const ref = new Date();
  ref.setDate(ref.getDate() + offset * 7);
  return planningWeekBoundsForRef(ref);
}

function planningWeekLabel(bounds) {
  if (!bounds?.start || !bounds?.end) return "—";
  if (bounds.start === bounds.end) return formatDateDdMmYyyy(bounds.start);
  return `${formatDateDdMmYyyy(bounds.start)} — ${formatDateDdMmYyyy(bounds.end)}`;
}

function planningDisplayBounds() {
  const startEl = document.getElementById("planning-range-start");
  const endEl = document.getElementById("planning-range-end");
  let start = String(startEl?.value || "").slice(0, 10);
  let end = String(endEl?.value || "").slice(0, 10);
  if (!start || !end) {
    const w = planningWeekBounds(0);
    start = w.start;
    end = w.end;
    if (startEl) startEl.value = start;
    if (endEl) endEl.value = end;
  }
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
    if (startEl) startEl.value = start;
    if (endEl) endEl.value = end;
  }
  return { start, end };
}

function setPlanningRangeInputs(start, end) {
  const startEl = document.getElementById("planning-range-start");
  const endEl = document.getElementById("planning-range-end");
  if (startEl) startEl.value = start;
  if (endEl) endEl.value = end;
}

function setPlanningRangeToday() {
  const d = today();
  setPlanningRangeInputs(d, d);
}

function setPlanningRangeCurrentWeek() {
  const w = planningWeekBounds(0);
  setPlanningRangeInputs(w.start, w.end);
}

function setPlanningRangeCurrentMonth() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 12, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 12, 0, 0, 0);
  setPlanningRangeInputs(planningIsoDate(start), planningIsoDate(end));
}

function shiftPlanningRangeByPeriod(delta) {
  const b = planningDisplayBounds();
  const ds = planningParseIso(b.start);
  const de = planningParseIso(b.end);
  if (!ds || !de) return;
  const span = Math.max(1, Math.round((de - ds) / 86400000) + 1);
  const sign = delta < 0 ? -1 : 1;
  const shift = span * sign;
  ds.setDate(ds.getDate() + shift);
  de.setDate(de.getDate() + shift);
  setPlanningRangeInputs(planningIsoDate(ds), planningIsoDate(de));
}

/** Liste des jours ISO entre start et end inclus. */
function planningDatesBetween(startIso, endIso) {
  const out = [];
  const s = planningParseIso(startIso);
  const e = planningParseIso(endIso);
  if (!s || !e) return out;
  const cur = new Date(s);
  while (cur <= e) {
    out.push(planningIsoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function workShiftDurationMinutes(shift) {
  const d = String(shift?.date || "").slice(0, 10);
  const st = String(shift?.startTime || "").trim();
  const en = String(shift?.endTime || "").trim();
  if (!d || !st || !en) return 0;
  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = en.split(":").map(Number);
  let start = new Date(`${d}T${pad2(sh)}:${pad2(sm)}:00`);
  let end = new Date(`${d}T${pad2(eh)}:${pad2(em)}:00`);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return Math.max(0, Math.round((end - start) / 60000));
}

/** Intervalle réel d'un créneau (fin après minuit si endTime <= startTime). */
function workShiftInterval(shift) {
  const d = String(shift?.date || "").slice(0, 10);
  const st = String(shift?.startTime || "").trim();
  const en = String(shift?.endTime || "").trim();
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !st || !en) return null;
  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = en.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return null;
  let start = new Date(`${d}T${pad2(sh)}:${pad2(sm)}:00`);
  let end = new Date(`${d}T${pad2(eh)}:${pad2(em)}:00`);
  if (end <= start) end = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, shift };
}

function workShiftsForUserOnDate(username, siteId, dateIso) {
  const un = String(username || "").trim().toLowerCase();
  const d = String(dateIso || "").slice(0, 10);
  if (!un || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  return workShiftsForSite(siteId).filter(
    (s) => String(s.username || "").trim().toLowerCase() === un
      && String(s.date || "").slice(0, 10) === d,
  );
}

/** Créneaux actifs maintenant (jour du créneau et veille pour les fins après minuit). */
function activeWorkShiftsNow(username = sessionUser, siteId = currentSiteId()) {
  const un = String(username || "").trim();
  if (!un) return [];
  const now = Date.now();
  const days = [today(), addCalendarDaysIso(today(), -1)];
  const seen = new Set();
  const out = [];
  days.forEach((d) => {
    workShiftsForUserOnDate(un, siteId, d).forEach((shift) => {
      const iv = workShiftInterval(shift);
      if (!iv || now < iv.start.getTime() || now > iv.end.getTime()) return;
      const key = Number(shift.id) || `${shift.date}|${shift.startTime}|${shift.endTime}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(shift);
    });
  });
  return out;
}

/** Créneau de nuit (fin après minuit). */
function workShiftIsOvernight(shift) {
  const d = String(shift?.date || "").slice(0, 10);
  const st = String(shift?.startTime || "").trim();
  const en = String(shift?.endTime || "").trim();
  if (!d || !st || !en) return false;
  const [sh, sm] = st.split(":").map(Number);
  const [eh, em] = en.split(":").map(Number);
  if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return false;
  const endSameDay = new Date(`${d}T${pad2(eh)}:${pad2(em)}:00`);
  const startSameDay = new Date(`${d}T${pad2(sh)}:${pad2(sm)}:00`);
  return endSameDay <= startSameDay;
}

/**
 * Relais entre deux jours planifiés : ex. créneau 17/05 11h→02h puis 18/05 11h→02h
 * autorise ventes/encaissements entre 02h01 et 10h59 le 18/05 (clients de la nuit).
 */
function staffInShiftBridgeGap(username = sessionUser, siteId = currentSiteId()) {
  const un = String(username || "").trim().toLowerCase();
  if (!un) return false;
  const now = Date.now();
  const todayIso = today();
  const yesterdayIso = addCalendarDaysIso(todayIso, -1);
  const prevShifts = workShiftsForUserOnDate(un, siteId, yesterdayIso).filter(workShiftIsOvernight);
  const todayShifts = workShiftsForUserOnDate(un, siteId, todayIso);
  if (!prevShifts.length || !todayShifts.length) return false;

  let latestPrevEnd = null;
  prevShifts.forEach((shift) => {
    const iv = workShiftInterval(shift);
    if (!iv || planningIsoDate(iv.end) !== todayIso) return;
    if (!latestPrevEnd || iv.end > latestPrevEnd) latestPrevEnd = iv.end;
  });

  let earliestTodayStart = null;
  todayShifts.forEach((shift) => {
    const iv = workShiftInterval(shift);
    if (!iv) return;
    if (!earliestTodayStart || iv.start < earliestTodayStart) earliestTodayStart = iv.start;
  });

  if (!latestPrevEnd || !earliestTodayStart) return false;
  if (earliestTodayStart.getTime() <= latestPrevEnd.getTime()) return false;
  return now > latestPrevEnd.getTime() && now < earliestTodayStart.getTime();
}

/** Créneau planning obligatoire pour vendre : serveuses uniquement (gérant / admin jamais bloqués). */
function staffRequiresShiftWindowForSales() {
  return String(currentRole || "").trim() === "serveuse";
}

function staffIsOnDutyNow(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return true;
  if (activeWorkShiftsNow(sessionUser, siteId).length > 0) return true;
  return staffInShiftBridgeGap(sessionUser, siteId);
}

function formatShiftWindowLabel(shift) {
  const st = String(shift?.startTime || "").trim().slice(0, 5);
  const en = String(shift?.endTime || "").trim().slice(0, 5);
  return st && en ? `${st} – ${en}` : "votre créneau";
}

function formatDurationMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h && r) return `${h} h ${r} min`;
  if (h) return `${h} h`;
  return `${r} min`;
}

function staffDisplayName(username) {
  const u = (state?.auth?.users || []).find(
    (x) => String(x.username || "").trim().toLowerCase() === String(username || "").trim().toLowerCase(),
  );
  const dn = String(u?.displayName || "").trim();
  return dn || String(username || "").trim() || "—";
}

function workShiftsAll() {
  return Array.isArray(state?.workShifts) ? state.workShifts : [];
}

function workShiftBelongsToSite(shift, siteId) {
  const sid = String(siteId ?? currentSiteId() ?? "").trim();
  if (!sid) return false;
  return rowMatchesSite(shift, sid, multiSiteActive());
}

/** Créneaux d'un seul maquis (évite de valider / écraser les autres sites). */
function workShiftsForSite(siteId = currentSiteId()) {
  return workShiftsAll().filter((s) => workShiftBelongsToSite(s, siteId));
}

/** Payload PUT : autres maquis inchangés + liste complète du maquis ciblé. */
function buildWorkShiftsPutPayload(siteScopedRows, siteId) {
  const sid = String(siteId || currentSiteId() || "").trim();
  const scoped = (siteScopedRows || []).map((r) => ({ ...r, siteId: String(r.siteId || sid) }));
  const other = workShiftsAll().filter((s) => !workShiftBelongsToSite(s, sid));
  return [...other, ...scoped];
}

function myWorkShiftsInWeek(bounds) {
  const sn = String(sessionUser || "").trim().toLowerCase();
  return workShiftsForSessionUser()
    .filter((s) => {
      const d = String(s.date || "").slice(0, 10);
      return d >= bounds.start && d <= bounds.end
        && String(s.username || "").trim().toLowerCase() === sn;
    })
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
}

function teamWorkShiftsInWeek(bounds) {
  return workShiftsForSessionUser()
    .filter((s) => {
      const d = String(s.date || "").slice(0, 10);
      return d >= bounds.start && d <= bounds.end;
    })
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
}

/** Planning actif ce jour (gérant : équipe ; serveuse : au moins un créneau sur le mois). */
function teamHasPlanningOnDate(siteId, dateIso) {
  const d = String(dateIso || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const multi = multiSiteActive();
  if (String(currentRole || "").trim() === "serveuse") {
    const month = d.slice(0, 7);
    return workShiftsForSessionUser(siteId).some(
      (s) => rowMatchesSite(s, siteId, multi) && String(s.date || "").slice(0, 7) === month,
    );
  }
  return workShiftsAll().some(
    (s) => rowMatchesSite(s, siteId, multi) && String(s.date || "").slice(0, 10) === d,
  );
}

function serveuseHasShiftOnDate(username, siteId, dateIso) {
  const d = String(dateIso || "").slice(0, 10);
  const un = String(username || "").trim().toLowerCase();
  if (!un || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const multi = multiSiteActive();
  return workShiftsAll().some(
    (s) => rowMatchesSite(s, siteId, multi)
      && String(s.username || "").trim().toLowerCase() === un
      && String(s.date || "").slice(0, 10) === d,
  );
}

/** Jour sans créneau planifié (planning du mois actif sur le maquis). */
function serveuseIsRestDay(dateIso, siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  const d = String(dateIso || "").slice(0, 10);
  const sid = siteId || currentSiteId();
  if (!sid || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  if (!teamHasPlanningOnDate(sid, d)) return false;
  return !serveuseHasShiftOnDate(sessionUser, sid, d);
}

/** Module Ventes indisponible aujourd'hui (serveuse en repos). */
function serveuseVentesModuleBlocked(siteId = currentSiteId()) {
  return serveuseIsRestDay(today(), siteId);
}

/** Vrai si la serveuse a un service ouvert non clôturé (date de travail courante). */
function serveuseHasOpenServiceToday(siteId = currentSiteId()) {
  const d = workingDate(siteId);
  return !!(d && dayBookFor(d, siteId) && !stockCheckForSiteDate(d, siteId));
}

/** Pages accessibles pour une serveuse en jour de repos. */
const SERVEUSE_REST_DAY_PAGES = new Set(["planning", "historique-ventes"]);

function serveuseRestDayActive(siteId = currentSiteId()) {
  return serveuseVentesModuleBlocked(siteId);
}

function serveusePageAllowedDuringRest(page) {
  if (!staffRequiresShiftWindowForSales() || !serveuseRestDayActive()) return true;
  if (SERVEUSE_REST_DAY_PAGES.has(String(page || "").trim())) return true;
  if (page === "pdj" && serveuseHasOpenServiceToday()) return true;
  return false;
}

function serveuseRestDayBlockToast() {
  showToast("Jour de repos : seuls Planning et Mes ventes sont disponibles.");
}

/** Message si serveuse hors créneau ou jour de repos (gérant / admin : jamais bloqué). */
function serveusePlanningBlocksSale(saleDateStr, siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return null;
  const d = String(saleDateStr || "").slice(0, 10);
  const sid = siteId || currentSiteId();
  if (!sid || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  if (!teamHasPlanningOnDate(sid, d)) return null;
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
}

function syncServeuseRestDayNavAccess() {
  const rest = staffRequiresShiftWindowForSales() && serveuseRestDayActive();
  const roleRestricted = (page) => !canManage() && ["home", "stock", "charges"].includes(page);

  document.querySelectorAll(".nav-btn[data-page]").forEach((btn) => {
    const page = btn.dataset.page;
    if (!page) return;
    const allowed = serveusePageAllowedDuringRest(page);
    const hide = roleRestricted(page) || (rest && !allowed);
    btn.classList.toggle("hidden", hide);
    btn.disabled = rest && !allowed;
    btn.classList.toggle("nav-btn--disabled", rest && !allowed);
    btn.setAttribute("aria-disabled", rest && !allowed ? "true" : "false");
    if (rest && !allowed) btn.title = "Jour de repos — indisponible";
    else if (btn.title === "Jour de repos — indisponible") btn.removeAttribute("title");
  });

  const _hasOpenService = rest && serveuseHasOpenServiceToday();
  const moreNavOk = (nav) => {
    if (!rest) return true;
    if (nav === "logout") return true;
    if (nav === "pdj" && _hasOpenService) return true;
    return nav === "planning" || nav === "historique-ventes";
  };
  document.querySelectorAll("[data-more-nav]").forEach((btn) => {
    const nav = btn.dataset.moreNav;
    if (!nav) return;
    const row = btn.closest(".mobile-more-feature") || btn.closest(".mobile-more-footer-link") || btn;
    if (row) row.classList.toggle("hidden", !moreNavOk(nav));
  });
  document.querySelectorAll(".mobile-more-footer-primary, .mobile-more-footer-secondary").forEach((btn) => {
    btn.classList.toggle("hidden", rest);
  });

  document.getElementById("serveuse-rest-planning-nav")?.classList.toggle("hidden", !rest);
  if (rest) document.getElementById("fab-btn")?.classList.add("hidden");
}

function ensureServeuseRestDayPage() {
  if (serveusePageAllowedDuringRest(currentPage)) return false;
  serveuseRestDayBlockToast();
  navigate("planning");
  return true;
}

function syncServeuseVentesPageRestDay() {
  syncServeuseRestDayNavAccess();
  if (currentPage !== "ventes") return;
  const blocked = serveuseVentesModuleBlocked();
  const restGate = document.getElementById("ventes-rest-day-gate");
  const tabs = document.querySelector("#page-ventes > .tabs.page-subtabs");
  const journalGate = document.getElementById("ventes-journal-gate");
  const msg = blocked ? serveusePlanningBlocksSale(today(), currentSiteId()) : "";
  if (restGate) {
    if (blocked && msg) {
      restGate.classList.remove("hidden");
      restGate.removeAttribute("hidden");
      restGate.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Jour de repos</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(msg)}</p>
      </div>`;
    } else {
      restGate.classList.add("hidden");
      restGate.setAttribute("hidden", "");
      restGate.innerHTML = "";
    }
  }
  tabs?.classList.toggle("hidden", blocked);
  journalGate?.classList.toggle("hidden", blocked);
  const cardIds = ["ventes-card-board", "ventes-card-gestion", "ventes-card-consignes", "ventes-card-qr", "ventes-card-historique"];
  if (blocked) {
    cardIds.forEach((id) => document.getElementById(id)?.classList.add("hidden"));
    return;
  }
  const isCommandes = ventesSubTab === "commandes";
  const isCaisse = ventesSubTab === "caisse";
  const isQr = ventesSubTab === "qr";
  const isConsignes = ventesSubTab === "consignes";
  document.getElementById("ventes-card-gestion")?.classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-board")?.classList.toggle("hidden", !isCommandes);
  document.getElementById("ventes-card-qr")?.classList.toggle("hidden", !isQr);
  document.getElementById("ventes-card-historique")?.classList.toggle("hidden", !isCaisse);
  document.getElementById("ventes-card-consignes")?.classList.toggle("hidden", !isConsignes);
}

function schedulableStaffForCurrentSite() {
  const sid = String(currentSiteId() || "");
  return (state?.auth?.users || []).filter((u) => {
    const r = String(u.role || "").trim().toLowerCase();
    if (r !== "serveuse" && r !== "manager") return false;
    return (u.allowedSiteIds || []).some((x) => String(x) === sid);
  });
}

/** Personnes cochées pour la rotation, dans l'ordre affiché. */
function getRotationStaffOrder() {
  const wrap = document.getElementById("ws-rotation-staff-list");
  if (!wrap) return [];
  return [...wrap.querySelectorAll(".ws-rotation-staff-cb:checked")]
    .map((cb) => String(cb.value || "").trim())
    .filter(Boolean);
}

/** Qui travaille ce jour (index 0 = premier jour de la période). */
function staffUsernamesForRotationDay(dayIndex, staffOrder, workDays, teamSize) {
  const n = staffOrder.length;
  if (!n || workDays < 1) return [];
  const ts = Math.max(1, Math.min(teamSize, n));
  const block = Math.floor(dayIndex / workDays);
  const startIdx = block % n;
  const out = [];
  for (let k = 0; k < ts; k++) out.push(staffOrder[(startIdx + k) % n]);
  return [...new Set(out)];
}

function renderRotationStaffList() {
  const wrap = document.getElementById("ws-rotation-staff-list");
  if (!wrap) return;
  const staff = schedulableStaffForCurrentSite();
  const prev = new Set(getRotationStaffOrder());
  if (!staff.length) {
    wrap.innerHTML = `<p class="muted" style="font-size:0.86rem;margin:0">Aucune serveuse/gérante sur ce maquis.</p>`;
    return;
  }
  wrap.innerHTML = staff.map((u, i) => {
    const un = escapeHtml(u.username);
    const label = escapeHtml(staffDisplayName(u.username));
    const checked = prev.size ? prev.has(u.username) : true;
    return `<label class="planning-rotation-staff-row">
      <span class="planning-rotation-order" aria-hidden="true">${i + 1}</span>
      <input type="checkbox" class="ws-rotation-staff-cb" value="${un}" ${checked ? "checked" : ""}>
      <span>${label} <span class="muted">(${un})</span></span>
      <span class="planning-rotation-move">
        <button type="button" class="mini-btn ws-rotation-up" data-user="${un}" aria-label="Monter">↑</button>
        <button type="button" class="mini-btn ws-rotation-down" data-user="${un}" aria-label="Descendre">↓</button>
      </span>
    </label>`;
  }).join("");
  wrap.querySelectorAll(".ws-rotation-up").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      moveRotationStaffRow(btn.dataset.user, -1);
    });
  });
  wrap.querySelectorAll(".ws-rotation-down").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      moveRotationStaffRow(btn.dataset.user, 1);
    });
  });
  wrap.querySelectorAll(".ws-rotation-staff-cb").forEach((cb) => {
    cb.addEventListener("change", renderRotationPreview);
  });
  renderRotationPreview();
}

function moveRotationStaffRow(username, delta) {
  const wrap = document.getElementById("ws-rotation-staff-list");
  if (!wrap) return;
  const rows = [...wrap.querySelectorAll(".planning-rotation-staff-row")];
  const idx = rows.findIndex((row) => row.querySelector(".ws-rotation-staff-cb")?.value === username);
  if (idx < 0) return;
  const j = idx + delta;
  if (j < 0 || j >= rows.length) return;
  const a = rows[idx];
  const b = rows[j];
  if (delta < 0) wrap.insertBefore(a, b);
  else wrap.insertBefore(b, a);
  renderRotationPreview();
}

function renderRotationPreview() {
  const el = document.getElementById("ws-rotation-preview");
  if (!el) return;
  const staff = getRotationStaffOrder();
  const workDays = Math.max(1, Math.min(7, Number(document.getElementById("ws-rotation-work-days")?.value) || 2));
  const teamSize = Math.max(1, Math.min(5, Number(document.getElementById("ws-rotation-team-size")?.value) || 1));
  const bounds = planningDisplayBounds();
  const days = planningDatesBetween(bounds.start, bounds.end);
  const periodHint = document.getElementById("ws-rotation-period-hint");
  if (periodHint) {
    periodHint.textContent = days.length
      ? `Période Du/Au active : ${formatDateDdMmYyyy(bounds.start)} — ${formatDateDdMmYyyy(bounds.end)} (${days.length} jour(s))`
      : "Renseignez Du / Au en haut (bouton « Ce mois » pour tout le mois).";
  }
  if (!staff.length) {
    el.textContent = "Cochez au moins une personne dans la rotation.";
    return;
  }
  if (!days.length) {
    el.textContent = "Choisissez une période Du / Au en haut.";
    return;
  }
  if (days.length > 62) {
    el.textContent = "Période trop longue (max. 62 jours pour la génération automatique).";
    return;
  }
  if (teamSize > staff.length) {
    el.textContent = "Réduisez « Personnes en service / jour » ou ajoutez des personnes.";
    return;
  }
  const sample = days.slice(0, 4).map((date, i) => {
    const who = staffUsernamesForRotationDay(i, staff, workDays, teamSize).map(staffDisplayName).join(" + ");
    return `${formatDateDdMmYyyy(date)} : ${who}`;
  }).join(" · ");
  const restHint = staff.length >= 2 && teamSize === 1
    ? ` Chaque personne : ${workDays} j. de suite puis repos pendant que les autres assurent.`
    : "";
  el.textContent = `${days.length} jour(s), ${staff.length} en rotation — aperçu : ${sample}…${restHint}`;
}

function buildRotationShiftsForPeriod({
  startIso,
  endIso,
  staffOrder,
  workDays,
  teamSize,
  startTime,
  endTime,
  siteId,
  note,
}) {
  const days = planningDatesBetween(startIso, endIso);
  const now = new Date().toISOString();
  const out = [];
  let nextId = Number(state.nextId?.workShift) || 100;
  for (let i = 0; i < days.length; i++) {
    const date = days[i];
    const users = staffUsernamesForRotationDay(i, staffOrder, workDays, teamSize);
    for (const username of users) {
      out.push({
        id: nextId++,
        siteId,
        username,
        date,
        startTime,
        endTime,
        note: note || "Rotation auto",
        createdBy: sessionUser,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  state.nextId = state.nextId || {};
  state.nextId.workShift = nextId;
  return out;
}

async function generatePlanningRotationFromForm() {
  if (!canManageTeamSchedule()) {
    showToast("Réservé au gérant ou à un administrateur.");
    return;
  }
  const staffOrder = getRotationStaffOrder();
  const workDays = Math.max(1, Math.min(7, Number(document.getElementById("ws-rotation-work-days")?.value) || 2));
  const teamSize = Math.max(1, Math.min(5, Number(document.getElementById("ws-rotation-team-size")?.value) || 1));
  const startTime = document.getElementById("ws-rotation-start")?.value?.trim() || "18:00";
  const endTime = document.getElementById("ws-rotation-end")?.value?.trim() || "02:00";
  const replace = Boolean(document.getElementById("ws-rotation-replace")?.checked);
  const bounds = planningDisplayBounds();
  const siteId = String(currentSiteId() || "");
  if (!staffOrder.length) { showToast("Cochez au moins une personne."); return; }
  if (!siteId) { showToast("Choisissez un maquis."); return; }
  const days = planningDatesBetween(bounds.start, bounds.end);
  if (!days.length) { showToast("Période Du / Au invalide."); return; }
  if (days.length > 62) { showToast("Maximum 62 jours par génération."); return; }
  if (teamSize > staffOrder.length) { showToast("Trop de personnes en service par jour."); return; }
  if (days.length <= 7) {
    const goShort = window.confirm(
      `La période Du/Au ne couvre que ${days.length} jour(s) (${formatDateDdMmYyyy(bounds.start)} — ${formatDateDdMmYyyy(bounds.end)}).\n\n`
      + "Pour tout le mois : cliquez « Ce mois » en haut, puis relancez.\n\nContinuer pour cette courte période ?",
    );
    if (!goShort) return;
  }

  const generated = buildRotationShiftsForPeriod({
    startIso: bounds.start,
    endIso: bounds.end,
    staffOrder,
    workDays,
    teamSize,
    startTime,
    endTime,
    siteId,
    note: "Rotation auto",
  });
  const names = staffOrder.map(staffDisplayName).join(", ");
  const msg = `Générer ${generated.length} créneau(x) sur ${days.length} jour(s) ?\n\n`
    + `Période Du/Au : ${formatDateDdMmYyyy(bounds.start)} — ${formatDateDdMmYyyy(bounds.end)}\n`
    + `Rotation : ${names}\n${workDays} jour(s) d'affilée · ${teamSize} en service / jour · ${startTime}–${endTime}`
    + (replace ? "\n\nLes créneaux existants sur cette période pour ce maquis seront supprimés." : "");
  if (!window.confirm(msg)) return;

  await refreshWorkShiftsFromServer();
  let rows = [...workShiftsForSite(siteId)];
  if (replace) {
    rows = rows.filter((s) => {
      const d = String(s.date || "").slice(0, 10);
      return !(d >= bounds.start && d <= bounds.end);
    });
  }
  rows = [...rows, ...generated];
  const prevWorkShifts = workShiftsAll();
  try {
    await persistWorkShiftsPatch(rows, { snapshot: true, skipRefresh: true, nextId: state.nextId });
    recordStaffAudit("create", "planning", `Rotation ${bounds.start} → ${bounds.end}`, `${staffOrder.join(", ")} · ${workDays}j/${teamSize} srv`);
    renderPlanningTeam();
    renderPlanningMine();
    showToast(`${generated.length} créneaux générés.`);
  } catch (e) {
    state.workShifts = prevWorkShifts;
    handleApiError(e);
  }
}

function renderPlanningShiftRow(shift, { editable = false } = {}) {
  const mins = workShiftDurationMinutes(shift);
  const site = (state?.sites || []).find((s) => String(s.id) === String(shift.siteId));
  const note = String(shift.note || "").trim();
  const actions = editable
    ? `<div class="list-side">
        <button type="button" class="mini-btn" data-ws-edit="${escapeHtml(String(shift.id))}">Modifier</button>
        <button type="button" class="mini-btn del-btn" data-ws-del="${escapeHtml(String(shift.id))}">Suppr.</button>
      </div>`
    : "";
  return `<article class="list-item planning-shift-item">
    <div style="min-width:0;flex:1">
      <p class="list-item-title">${escapeHtml(formatDateDdMmYyyy(String(shift.date || "").slice(0, 10)))} · ${escapeHtml(String(shift.startTime || ""))} – ${escapeHtml(String(shift.endTime || ""))}</p>
      <p class="list-item-sub">${editable ? `${escapeHtml(staffDisplayName(shift.username))} · ` : ""}${escapeHtml(formatDurationMinutes(mins))}${site ? ` · ${escapeHtml(site.nom)}` : ""}${note ? ` · ${escapeHtml(note)}` : ""}</p>
    </div>
    ${actions}
  </article>`;
}

function renderPlanningMine() {
  const bounds = planningDisplayBounds();
  const labelEl = document.getElementById("planning-mine-week-label");
  const listEl = document.getElementById("planning-mine-list");
  const sumEl = document.getElementById("planning-mine-summary");
  if (labelEl) labelEl.textContent = planningWeekLabel(bounds);
  const rows = myWorkShiftsInWeek(bounds);
  const totalMins = rows.reduce((acc, s) => acc + workShiftDurationMinutes(s), 0);
  const periodLab = bounds.start === bounds.end ? "ce jour" : "cette période";
  const restToday = serveusePlanningBlocksSale(today(), currentSiteId());
  if (sumEl) {
    if (restToday) {
      const _openSvc = serveuseHasOpenServiceToday();
      sumEl.innerHTML = `<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Hors service</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(restToday)}</p>
        ${_openSvc ? `<button type="button" class="btn btn-sm btn-primary" style="margin-top:8px" onclick="navigate('pdj')">Point du jour — Fin de service</button>` : ""}
      </div>`;
    } else if (staffIsOnDutyNow()) {
      const active = activeWorkShiftsNow(sessionUser, currentSiteId());
      if (!active.length && staffInShiftBridgeGap(sessionUser, currentSiteId())) {
        const todaySh = workShiftsForUserOnDate(sessionUser, currentSiteId(), today());
        const nextWin = todaySh.length ? formatShiftWindowLabel(todaySh[0]) : "votre prochain créneau";
        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>Relais de service</strong> · entre la fin de nuit et ${escapeHtml(nextWin)} (ventes et encaissements autorisés)
        </div>`;
      } else {
        const win = active.map(formatShiftWindowLabel).join(", ");
        sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #72d7a9;padding:10px 12px;font-size:0.88rem">
          <strong>En service maintenant</strong> · ${escapeHtml(win)}
        </div>`;
      }
    } else {
      sumEl.textContent = rows.length
        ? `${rows.length} créneau(x) · ${formatDurationMinutes(totalMins)} sur ${periodLab}`
        : `Aucun créneau planifié pour ${periodLab}.`;
    }
  }
  if (!listEl) return;
  if (!rows.length) {
    const isSrv = String(currentRole || "").trim() === "serveuse";
    listEl.innerHTML = emptyState(
      "Aucun horaire",
      isSrv
        ? "Votre gérante n'a pas encore publié vos créneaux pour cette période. Essayez « Ce mois » en haut ou demandez-lui de régénérer le planning (onglet Équipe)."
        : "Aucun créneau pour vous sur cette période. L'onglet Équipe affiche tout le personnel.",
    );
    return;
  }
  listEl.innerHTML = rows.map((s) => renderPlanningShiftRow(s)).join("");
}

function renderPlanningTeam() {
  if (!canManageTeamSchedule()) return;
  const bounds = planningDisplayBounds();
  const labelEl = document.getElementById("planning-team-week-label");
  const listEl = document.getElementById("planning-team-list");
  if (labelEl) labelEl.textContent = planningWeekLabel(bounds);
  populateWorkShiftUserSelect();
  renderRotationStaffList();
  const rows = teamWorkShiftsInWeek(bounds);
  if (!listEl) return;
  if (!rows.length) {
    listEl.innerHTML = emptyState("Planning vide", "Ajoutez un créneau ci-dessous pour les serveuses et gérantes.");
    return;
  }
  listEl.innerHTML = rows.map((s) => renderPlanningShiftRow(s, { editable: true })).join("");
  listEl.querySelectorAll("[data-ws-edit]").forEach((btn) => {
    btn.addEventListener("click", () => startEditWorkShift(btn.dataset.wsEdit));
  });
  listEl.querySelectorAll("[data-ws-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteWorkShift(btn.dataset.wsDel));
  });
}

function populateWorkShiftUserSelect() {
  const sel = document.getElementById("ws-user");
  if (!sel) return;
  const staff = schedulableStaffForCurrentSite();
  const prev = sel.value;
  sel.innerHTML = staff.length
    ? staff.map((u) => {
      const label = staffDisplayName(u.username);
      return `<option value="${escapeHtml(u.username)}">${escapeHtml(label)} (${escapeHtml(u.username)})</option>`;
    }).join("")
    : `<option value="">— Aucune personne sur ce maquis —</option>`;
  if (staff.some((u) => u.username === prev)) sel.value = prev;
  else if (staff.length) sel.value = staff[0].username;

  const hint = document.getElementById("ws-staff-hint");
  const saveBtn = document.getElementById("ws-save-btn");
  const siteName = currentSite()?.nom || currentSiteId() || "ce maquis";
  if (hint) {
    if (!staff.length) {
      hint.innerHTML = `Aucune <strong>serveuse</strong> ni <strong>gérante</strong> n'est affectée à « ${escapeHtml(siteName)} ». `
        + `Ouvrez <strong>Paramètres → Accès</strong>, créez ou modifiez un compte (rôle Serveuse ou Gérant) et cochez ce maquis dans la liste des établissements.`;
      hint.classList.remove("hidden");
    } else {
      hint.classList.add("hidden");
    }
  }
  if (saveBtn) saveBtn.disabled = !staff.length;
}

function resetWorkShiftForm() {
  const editId = document.getElementById("ws-edit-id");
  const cancelBtn = document.getElementById("ws-cancel-edit-btn");
  if (editId) editId.value = "";
  if (cancelBtn) cancelBtn.classList.add("hidden");
  const dateEl = document.getElementById("ws-date");
  const dateEndEl = document.getElementById("ws-date-end");
  const b = planningDisplayBounds();
  const def = b.start || today();
  if (dateEl) dateEl.value = def;
  if (dateEndEl) dateEndEl.value = def;
  const noteEl = document.getElementById("ws-note");
  if (noteEl) noteEl.value = "";
}

function startEditWorkShift(idRaw) {
  const id = Number(idRaw);
  const shift = workShiftsAll().find((s) => Number(s.id) === id);
  if (!shift) return;
  document.getElementById("ws-edit-id").value = String(id);
  document.getElementById("ws-user").value = shift.username;
  const d = String(shift.date || "").slice(0, 10);
  document.getElementById("ws-date").value = d;
  const dateEndEl = document.getElementById("ws-date-end");
  if (dateEndEl) dateEndEl.value = d;
  document.getElementById("ws-start").value = String(shift.startTime || "18:00");
  document.getElementById("ws-end").value = String(shift.endTime || "02:00");
  document.getElementById("ws-note").value = String(shift.note || "");
  document.getElementById("ws-cancel-edit-btn")?.classList.remove("hidden");
  document.getElementById("ws-save-btn")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** Union par id (ajouts / mises à jour) — ne retire pas les ids absents du serveur. */
function mergeWorkShiftsFromServer(serverRows, localRows) {
  const server = Array.isArray(serverRows) ? serverRows : [];
  const local = Array.isArray(localRows) ? localRows : [];
  if (!server.length) return local.slice();
  if (!local.length) return server.slice();
  const byId = new Map();
  local.forEach((s) => {
    if (s?.id != null) byId.set(Number(s.id), s);
  });
  server.forEach((s) => {
    if (s?.id != null) byId.set(Number(s.id), s);
  });
  return Array.from(byId.values());
}

/** Remplace les créneaux d'un maquis par la réponse serveur (suppressions incluses). */
function applyWorkShiftsFromServerForSite(serverRows, siteId, localRows) {
  const sid = String(siteId || currentSiteId() || "").trim();
  const other = (localRows || []).filter((s) => !workShiftBelongsToSite(s, sid));
  const scoped = (serverRows || []).filter((s) => workShiftBelongsToSite(s, sid));
  return [...other, ...scoped];
}

/** Recharge workShifts depuis le serveur. replaceSite = vérité serveur pour le maquis actif. */
async function refreshWorkShiftsFromServer({ onlyIfLocalEmpty = false, replaceSite = false } = {}) {
  const local = workShiftsAll();
  if (onlyIfLocalEmpty && local.length > 0) return;
  const siteId = String(currentSiteId() || "").trim();
  try {
    const fresh = await apiRequest(API.state, { cache: "no-store" });
    if (fresh && Array.isArray(fresh.workShifts)) {
      if (replaceSite && siteId) {
        state.workShifts = applyWorkShiftsFromServerForSite(fresh.workShifts, siteId, local);
      } else {
        state.workShifts = mergeWorkShiftsFromServer(fresh.workShifts, local);
      }
    }
  } catch {
    /* garder l'état local */
  }
}

/** Garde les créneaux envoyés si la réponse PUT ne les renvoie pas (serveur ancien ou fusion vide). */
function reconcileWorkShiftsAfterPatch(sentRows) {
  if (!Array.isArray(sentRows) || !sentRows.length) return;
  const got = workShiftsAll();
  const missing = sentRows.filter(
    (p) => !got.some((g) => Number(g.id) === Number(p.id)),
  );
  if (!missing.length) return;
  const byId = new Map(got.map((s) => [Number(s.id), s]));
  sentRows.forEach((p) => byId.set(Number(p.id), p));
  state.workShifts = Array.from(byId.values());
}

const LS_WORK_SHIFTS_KEY_PREFIX = "cda_workShifts_v2";

/** Cache navigateur par compte + maquis (évite de mélanger gérante / serveuses). */
function lsWorkShiftsStorageKey() {
  const u = String(sessionUser || "").trim().toLowerCase() || "anon";
  const s = String(currentSiteId() || "").trim() || "site";
  return `${LS_WORK_SHIFTS_KEY_PREFIX}_${u}_${s}`;
}

function lsSaveWorkShifts() {
  try {
    const siteId = String(currentSiteId() || "").trim();
    if (!siteId) return;
    const key = lsWorkShiftsStorageKey();
    const rows = workShiftsForSite(siteId);
    if (!rows.length) {
      localStorage.removeItem(key);
      localStorage.removeItem(`${key}_nextId`);
      return;
    }
    localStorage.setItem(key, JSON.stringify(rows));
    if (state?.nextId?.workShift != null) {
      localStorage.setItem(`${key}_nextId`, String(state.nextId.workShift));
    }
  } catch {
    /* quota / mode privé */
  }
}

function lsRestoreWorkShifts() {
  try {
    const siteId = String(currentSiteId() || "").trim();
    if (!siteId) return;
    const key = lsWorkShiftsStorageKey();
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const list = JSON.parse(raw);
    if (!Array.isArray(list) || !list.length) return;
    state.workShifts = applyWorkShiftsFromServerForSite(list, siteId, workShiftsAll());
    if (!state.nextId) state.nextId = {};
    const nextRaw = localStorage.getItem(`${key}_nextId`);
    if (nextRaw) {
      state.nextId.workShift = Math.max(Number(state.nextId.workShift) || 100, Number(nextRaw) || 0);
    }
  } catch {
    /* localStorage corrompu */
  }
}

/** Créneaux visibles pour l'utilisateur connecté (serveuse = les siens ; gérant = tout le maquis sur Équipe). */
function workShiftsForSessionUser(siteId = currentSiteId()) {
  const multi = multiSiteActive();
  const sid = siteId || currentSiteId();
  const rows = workShiftsAll().filter((s) => rowMatchesSite(s, sid, multi));
  if (String(currentRole || "").trim() === "serveuse") {
    const un = String(sessionUser || "").trim().toLowerCase();
    return rows.filter((s) => String(s.username || "").trim().toLowerCase() === un);
  }
  return rows;
}

/** Après PUT planning : snapshot = liste envoyée ; sinon union prudente. */
function applyWorkShiftsAfterSave(sentRows, { snapshot = false } = {}) {
  const sent = Array.isArray(sentRows) ? sentRows : [];
  if (snapshot) {
    state.workShifts = sent.slice();
    lsSaveWorkShifts();
    return;
  }
  if (!sent.length) {
    lsSaveWorkShifts();
    return;
  }
  state.workShifts = mergeWorkShiftsFromServer(sent, workShiftsAll());
  reconcileWorkShiftsAfterPatch(sent);
  lsSaveWorkShifts();
}

/** Vérifie les créneaux du maquis ciblé uniquement (pas les autres sites fusionnés en mémoire). */
function validateWorkShiftsBeforeSend(rows, siteId) {
  const sid = String(siteId || currentSiteId() || "").trim();
  if (!sid) throw new Error("Aucun maquis sélectionné.");
  const staff = (state?.auth?.users || []).filter((u) => {
    const r = String(u.role || "").trim().toLowerCase();
    if (r !== "serveuse" && r !== "manager") return false;
    return (u.allowedSiteIds || []).some((x) => String(x) === sid);
  });
  const staffSet = new Set(staff.map((u) => String(u.username || "").trim().toLowerCase()));
  const problems = [];
  (rows || []).forEach((r, i) => {
    if (!workShiftBelongsToSite({ ...r, siteId: r?.siteId || sid }, sid)) return;
    const un = String(r?.username || "").trim();
    const d = String(r?.date || "").slice(0, 10);
    if (!un) problems.push(`ligne ${i + 1} : personne manquante`);
    else if (!staffSet.has(un.toLowerCase())) {
      problems.push(`« ${un} » n'est pas serveuse/gérante sur ce maquis (Paramètres → Accès).`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push(`ligne ${i + 1} : date invalide`);
  });
  if (problems.length) {
    throw new Error(problems[0]);
  }
}

/** Relit le serveur et vérifie créneaux conservés / supprimés pour le maquis. */
async function verifyWorkShiftsPersistedOnServer(sentRows, { siteId, removedIds = [] } = {}) {
  const sent = Array.isArray(sentRows) ? sentRows : [];
  const sid = String(siteId || currentSiteId() || "").trim();
  const sentIds = new Set(sent.map((s) => Number(s.id)).filter((id) => !Number.isNaN(id)));
  const removed = (removedIds || []).map((id) => Number(id)).filter((id) => !Number.isNaN(id));
  let serverRows = [];
  try {
    const fresh = await apiRequest(API.state, { cache: "no-store" });
    serverRows = Array.isArray(fresh?.workShifts) ? fresh.workShifts : [];
  } catch {
    throw new Error("Impossible de relire le planning sur le serveur. Vérifiez la connexion.");
  }
  const stillThere = removed.filter((rid) => serverRows.some((s) => Number(s.id) === rid));
  if (stillThere.length) {
    throw new Error(
      "La suppression n'a pas été enregistrée sur le serveur. "
      + "Déployez la dernière version de server.py sur le VPS (scripts/deploy.ps1 ou GitHub Actions), "
      + "redémarrez le service, puis Ctrl+F5.",
    );
  }
  if (sentIds.size) {
    const found = serverRows.filter((s) => sentIds.has(Number(s.id))).length;
    if (found < sentIds.size) {
      throw new Error(
        `Le serveur n'a enregistré que ${found}/${sentIds.size} créneau(x). `
        + "Vérifiez Paramètres → Accès ou redémarrez le serveur.",
      );
    }
  }
  if (sid) {
    state.workShifts = applyWorkShiftsFromServerForSite(serverRows, sid, workShiftsAll());
    lsSaveWorkShifts();
  }
}

/**
 * Sauvegarde planning : sync serveur d'abord, PUT, puis force l'état local + cache navigateur.
 * @param {boolean} snapshot — true = le serveur peut retirer les créneaux absents du payload (liste complète).
 */
async function persistWorkShiftsPatch(siteScopedRows, {
  snapshot = true,
  skipRefresh = false,
  removedIds = [],
  ...patchExtra
} = {}) {
  if (!skipRefresh) await refreshWorkShiftsFromServer({ replaceSite: true });
  const siteId = String(patchExtra.activeSiteId ?? state.activeSiteId ?? currentSiteId() ?? "");
  const scoped = (siteScopedRows || []).map((r) => ({ ...r, siteId: String(r.siteId || siteId) }));
  validateWorkShiftsBeforeSend(scoped, siteId);
  const sent = buildWorkShiftsPutPayload(scoped, siteId);
  const prev = workShiftsAll();
  state.workShifts = sent;
  try {
    await persistStatePatch({
      ...patchExtra,
      activeSiteId: siteId || state.activeSiteId,
      workShifts: sent,
      workShiftsScopedSnapshot: snapshot,
    });
    applyWorkShiftsAfterSave(sent, { snapshot });
    await verifyWorkShiftsPersistedOnServer(scoped, { siteId, removedIds });
  } catch (e) {
    state.workShifts = prev;
    throw e;
  }
}

async function saveWorkShiftFromForm() {
  if (!canManageTeamSchedule()) {
    showToast("Réservé au gérant ou à un administrateur.");
    return;
  }
  const username = document.getElementById("ws-user")?.value?.trim();
  const dateStart = document.getElementById("ws-date")?.value?.trim();
  const dateEndRaw = document.getElementById("ws-date-end")?.value?.trim() || dateStart;
  let dateEnd = dateEndRaw;
  if (dateStart && dateEnd && dateEnd < dateStart) {
    dateEnd = dateStart;
    const endInp = document.getElementById("ws-date-end");
    if (endInp) endInp.value = dateStart;
  }
  const startTime = document.getElementById("ws-start")?.value?.trim();
  const endTime = document.getElementById("ws-end")?.value?.trim();
  const note = String(document.getElementById("ws-note")?.value || "").trim().slice(0, 200);
  const editRaw = document.getElementById("ws-edit-id")?.value?.trim();
  const siteId = String(currentSiteId() || "");
  if (!username) {
    showToast(schedulableStaffForCurrentSite().length
      ? "Choisissez une personne."
      : "Aucune serveuse/gérante sur ce maquis : Paramètres → Accès.");
    return;
  }
  if (!dateStart || !startTime || !endTime) { showToast("Dates et heures obligatoires."); return; }
  if (!siteId) { showToast("Choisissez un maquis."); return; }
  const dayList = editRaw ? [dateStart] : planningDatesBetween(dateStart, dateEnd);
  if (!dayList.length) { showToast("Plage de dates invalide."); return; }
  if (!editRaw && dayList.length > 31) {
    showToast("Plage limitée à 31 jours. Réduisez la période Du / Au.");
    return;
  }
  await refreshWorkShiftsFromServer();
  const now = new Date().toISOString();
  let rows = [...workShiftsForSite(siteId)];
  if (editRaw) {
    const id = Number(editRaw);
    const idx = rows.findIndex((s) => Number(s.id) === id);
    if (idx < 0) { showToast("Créneau introuvable."); return; }
    rows[idx] = {
      ...rows[idx],
      username,
      siteId,
      date: dateStart,
      startTime,
      endTime,
      note,
      updatedAt: now,
      updatedBy: sessionUser,
    };
  } else {
    for (const date of dayList) {
      const nid = Number(state.nextId?.workShift) || 100;
      state.nextId = state.nextId || {};
      state.nextId.workShift = nid + 1;
      rows.push({
        id: nid,
        siteId,
        username,
        date,
        startTime,
        endTime,
        note,
        createdBy: sessionUser,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  const prevWorkShifts = workShiftsAll();
  try {
    await persistWorkShiftsPatch(rows, { snapshot: true, skipRefresh: true, nextId: state.nextId });
    const auditDay = editRaw ? dateStart : `${dateStart}${dayList.length > 1 ? ` → ${dateEnd}` : ""}`;
    recordStaffAudit(editRaw ? "update" : "create", "planning", editRaw ? `Créneau #${editRaw}` : `Créneau ${auditDay}`, `${username} ${startTime}-${endTime}${dayList.length > 1 ? ` · ${dayList.length} jours` : ""}`);
    resetWorkShiftForm();
    renderPlanningTeam();
    renderPlanningMine();
    showToast(editRaw ? "Créneau modifié." : (dayList.length > 1 ? `${dayList.length} créneaux enregistrés.` : "Créneau enregistré."));
  } catch (e) {
    state.workShifts = prevWorkShifts;
    handleApiError(e);
  }
}

async function deleteWorkShift(idRaw) {
  if (!canManageTeamSchedule()) return;
  const id = Number(idRaw);
  const shift = workShiftsAll().find((s) => Number(s.id) === id);
  if (!shift) return;
  if (!window.confirm(`Supprimer le créneau du ${formatDateDdMmYyyy(shift.date)} (${shift.startTime} – ${shift.endTime}) pour ${staffDisplayName(shift.username)} ?`)) return;
  const siteId = String(shift.siteId || currentSiteId() || "");
  const rows = workShiftsForSite(siteId).filter((s) => Number(s.id) !== id);
  const prevWorkShifts = workShiftsAll();
  try {
    await persistWorkShiftsPatch(rows, {
      snapshot: true,
      skipRefresh: true,
      activeSiteId: siteId,
      removedIds: [id],
    });
    recordStaffAudit("delete", "planning", `Créneau #${id}`, `${shift.username} ${shift.date}`);
    if (String(document.getElementById("ws-edit-id")?.value) === String(id)) resetWorkShiftForm();
    renderPlanningTeam();
    renderPlanningMine();
    showToast("Créneau supprimé.");
  } catch (e) {
    state.workShifts = prevWorkShifts;
    handleApiError(e);
  }
}

function setPlanningSubTab(tab) {
  planningSubTab = tab === "team" && canManageTeamSchedule() ? "team" : "mine";
  document.querySelectorAll("[data-subtab-planning]").forEach((btn) => {
    const active = btn.dataset.subtabPlanning === planningSubTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll("[data-planning-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.planningPanel !== planningSubTab);
  });
  if (planningSubTab === "mine") renderPlanningMine();
  else renderPlanningTeam();
}

function applyPlanningRangeAndRender() {
  planningDisplayBounds();
  renderPlanningMine();
  if (canManageTeamSchedule()) renderPlanningTeam();
  else renderRotationPreview();
}

async function renderPlanningPage() {
  if (!state) return;
  if (!Array.isArray(state.workShifts)) state.workShifts = [];
  await refreshWorkShiftsFromServer({ replaceSite: true });
  if (!workShiftsForSite(currentSiteId()).length) lsRestoreWorkShifts();
  lsSaveWorkShifts();
  if (!document.getElementById("planning-range-start")?.value) setPlanningRangeCurrentWeek();
  resetWorkShiftForm();
  setPlanningSubTab(planningSubTab);
  syncServeuseRestDayNavAccess();
}

function bindPlanningEvents() {
  document.querySelectorAll("[data-subtab-planning]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!btn.classList.contains("hidden-by-role")) setPlanningSubTab(btn.dataset.subtabPlanning);
    });
  });
  const onRangeChange = () => applyPlanningRangeAndRender();
  document.getElementById("planning-range-apply")?.addEventListener("click", onRangeChange);
  document.getElementById("planning-range-today")?.addEventListener("click", () => {
    setPlanningRangeToday();
    onRangeChange();
  });
  document.getElementById("planning-range-week")?.addEventListener("click", () => {
    setPlanningRangeCurrentWeek();
    onRangeChange();
  });
  document.getElementById("planning-range-month")?.addEventListener("click", () => {
    setPlanningRangeCurrentMonth();
    onRangeChange();
    renderRotationPreview();
  });
  document.getElementById("planning-range-prev")?.addEventListener("click", () => {
    shiftPlanningRangeByPeriod(-1);
    onRangeChange();
  });
  document.getElementById("planning-range-next")?.addEventListener("click", () => {
    shiftPlanningRangeByPeriod(1);
    onRangeChange();
  });
  document.getElementById("planning-range-start")?.addEventListener("change", onRangeChange);
  document.getElementById("planning-range-end")?.addEventListener("change", onRangeChange);
  document.getElementById("ws-date")?.addEventListener("change", () => {
    const s = document.getElementById("ws-date")?.value;
    const e = document.getElementById("ws-date-end");
    if (e && s && (!e.value || e.value < s)) e.value = s;
  });
  document.getElementById("ws-save-btn")?.addEventListener("click", () => saveWorkShiftFromForm().catch(handleApiError));
  document.getElementById("ws-cancel-edit-btn")?.addEventListener("click", resetWorkShiftForm);
  ["ws-rotation-work-days", "ws-rotation-team-size", "ws-rotation-start", "ws-rotation-end"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderRotationPreview);
    document.getElementById(id)?.addEventListener("change", renderRotationPreview);
  });
  document.getElementById("ws-rotation-generate")?.addEventListener("click", () => {
    generatePlanningRotationFromForm().catch(handleApiError);
  });
}

/** Ouverture caisse, réouverture, date PDJ admin : gérant / administrateurs (pas serveuse). */
function canManagePdjAccounting() {
  return Boolean(sessionUser) && String(currentRole || "").trim() !== "serveuse";
}

/** Clôture journée : gérant / admin ; serveuse ou gérante uniquement pendant son créneau de service. */
function canClosePdjDay() {
  if (!sessionUser) return false;
  if (canManagePdjAccounting()) return true;
  if (!staffRequiresShiftWindowForSales()) return false;
  // Maquis sans créneaux configurés : serveuse toujours autorisée (fin de service → gérant valide)
  if (workShiftsForSite(currentSiteId()).length === 0) return true;
  if (staffIsOnDutyNow()) return true;
  // Service ouvert sur une journée passée (non clôturé J-1 ou plus) : toujours autoriser la clôture
  if (serveuseHasOpenServiceToday()) {
    const d = workingDate(currentSiteId());
    if (d < today() || serveuseIsRestDay(today(), currentSiteId())) return true;
  }
  return false;
}

function stockCheckIsManagerConfirmed(check) {
  if (!check || typeof check !== "object") return false;
  if (check.managerConfirmedAt) return true;
  const role = String(check.closedByRole || "").trim().toLowerCase();
  if (!role) return true;
  return role !== "serveuse";
}

/** Dernière clôture du maquis en attente de validation gérante. */
function pendingManagerConfirmationCheck(siteId = currentSiteId()) {
  const sid = String(siteId || "").trim();
  if (!sid) return null;
  let best = null;
  for (const sc of state.stockChecks || []) {
    if (!sc || sc.siteId !== sid || !sc.date) continue;
    if (stockCheckIsManagerConfirmed(sc)) continue;
    const d = String(sc.date).slice(0, 10);
    if (!best || d.localeCompare(String(best.date).slice(0, 10)) > 0) best = sc;
  }
  return best;
}

function updatePdjRoleVisibility() {
  const accounting = canManagePdjAccounting();
  const canClose = canClosePdjDay();
  document.querySelectorAll(".pdj-accounting-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !accounting);
  });
  document.querySelectorAll(".pdj-accounting-open-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !accounting);
  });
  document.querySelectorAll(".pdj-accounting-close-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canClose);
  });
  document.querySelectorAll(".pdj-serveuse-print-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", accounting || canClose);
  });
}

/** Date traitee sur le Point du jour : admin/superadmin lisent d'abord le champ date (choix local), puis la date imposee serveur si le champ est vide.
 *  Les autres roles : date imposee serveur si presente, sinon workingDate().
 *  Si la journee d'hier est encore ouverte (maquis de nuit), workingDate() peut rester sur hier. */
function setPdjBrowseDate(dateStr, { consultationOnly = false } = {}) {
  const sid = String(currentSiteId() || "");
  if (!sid) return;
  const t = today();
  const d = String(dateStr || "").trim().slice(0, 10);
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= t) {
    pdjViewDateBySite[sid] = d;
    pdjBrowseConsultationOnly = Boolean(consultationOnly);
  } else {
    delete pdjViewDateBySite[sid];
    pdjBrowseConsultationOnly = false;
  }
}

function isPdjBrowseConsultationOnly() {
  return Boolean(pdjBrowseConsultationOnly);
}

function pdjVentesCountForDate(dateIso) {
  const d = String(dateIso || "").slice(0, 10);
  return recordsForSite(state.ventes).filter((v) => (v.date || "").slice(0, 10) === d).length;
}

/** Vrai si la date n'a aucune vente et n'est pas encore clôturée (bannière journée sans vente). */
function pdjNoSalesForDate(dateIso) {
  const d = String(dateIso || "").slice(0, 10);
  if (pdjVentesCountForDate(d) > 0) return false;
  const closed = stockCheckForSiteDate(d, currentSiteId());
  return !closed;
}

/** Bloque le bouton tant qu'aucune cause n'est saisie (journée sans vente). Admins non bloqués. */
function pdjClosureBlockedNoSales(dateIso) {
  if (!pdjNoSalesForDate(dateIso)) return false;
  if (canAnyAdmin()) return false;
  const reasonEl = document.getElementById("pdj-no-sales-reason");
  return String(reasonEl?.value ?? _pdjNoSalesReasonDraft).trim().length === 0;
}

function pdjNoSalesClosureBannerHtml(dateIso) {
  const d = String(dateIso || "").slice(0, 10);
  const draft = escapeHtml(_pdjNoSalesReasonDraft);
  return `<div class="inline-card" style="margin-bottom:12px;border-left:3px solid #fb8c00;padding:12px 16px">
    <strong>Journée sans vente — cause requise</strong>
    <p class="muted" style="margin-top:6px;margin-bottom:10px;font-size:0.86rem;line-height:1.45">
      Aucune vente enregistrée pour le <strong>${escapeHtml(formatDateDdMmYyyy(d))}</strong>.
      Indiquez la cause pour pouvoir clôturer la journée.
    </p>
    <label for="pdj-no-sales-reason" style="font-size:0.85rem;font-weight:600;display:block;margin-bottom:4px">Cause de la non-vente <span style="color:#ff8e82">*</span></label>
    <input id="pdj-no-sales-reason" type="text" value="${draft}"
      placeholder="Ex : jour férié, fermeture exceptionnelle, panne électrique…"
      style="width:100%;max-width:420px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:0.95rem">
  </div>`;
}

function pdjApplyCloseDayButtonGate(button, { disabled = false, title = null } = {}) {
  if (!button) return;
  const blockedNoSales = pdjClosureBlockedNoSales(pdjCalendarDate());
  button.disabled = Boolean(disabled || blockedNoSales);
  if (blockedNoSales && !disabled) {
    button.title = "Indiquez la cause de la journée sans vente avant de clôturer.";
  } else if (title) {
    button.title = title;
  } else {
    button.removeAttribute("title");
  }
}

function pdjCalendarDate() {
  const sid = currentSiteId();
  const t = today();
  const tomorrow = addCalendarDaysIso(t, 1);
  const forced = String(state?.pdjWorkDateBySite?.[sid] || "").trim().slice(0, 10);
  // Autoriser "demain" comme date forcée après ouverture auto (clôture du jour en cours)
  const hasForced = Boolean(forced && /^\d{4}-\d{2}-\d{2}$/.test(forced) && forced <= tomorrow);

  if (isPdjBrowseConsultationOnly()) {
    const view = String(pdjViewDateBySite[sid] || "").trim().slice(0, 10);
    if (view && /^\d{4}-\d{2}-\d{2}$/.test(view) && view <= t) return view;
  }

  let result;
  if (canAnyAdmin()) {
    const el = document.getElementById("pdj-work-date");
    const v = el?.value?.trim();
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      result = v > t ? t : v;
    } else if (hasForced) {
      result = forced;
    } else {
      result = workingDate();
    }
  } else {
    result = hasForced ? forced : workingDate();
  }

  // Si la date résultante est clôturée et qu'un jour suivant est ouvert (≤ demain), avancer automatiquement.
  // Exception : si une date a été explicitement forcée via pdjWorkDateBySite (superadmin "Appliquer"),
  // respecter ce choix sans auto-avancer — le superadmin veut travailler sur cette date précise.
  if (!isPdjBrowseConsultationOnly() && result && !hasForced && stockCheckForSiteDate(result, sid)) {
    const nextOpen = firstUnclosedJournalDate(sid);
    if (nextOpen && nextOpen <= tomorrow) return nextOpen;
  }

  return result;
}

function syncPdjWorkDateInput({ keepCurrentValue = false } = {}) {
  const el = document.getElementById("pdj-work-date");
  if (!el || !canAnyAdmin()) return;
  const t = today();
  const tomorrow = addCalendarDaysIso(t, 1);
  const sid = currentSiteId();
  const forced = String(state?.pdjWorkDateBySite?.[sid] || "").trim().slice(0, 10);
  // Autoriser "demain" si c'est une ouverture auto après clôture du jour en cours
  const useForced = forced && /^\d{4}-\d{2}-\d{2}$/.test(forced) && forced <= tomorrow;
  el.max = useForced && forced > t ? tomorrow : t;
  if (!keepCurrentValue) {
    let targetDate = useForced ? forced : workingDate();
    // Si ce jour est clôturé, afficher le prochain jour ouvert (≤ demain)
    if (stockCheckForSiteDate(targetDate, sid)) {
      const nextOpen = firstUnclosedJournalDate(sid);
      if (nextOpen && nextOpen <= tomorrow) targetDate = nextOpen;
    }
    el.value = targetDate;
  }
  const workDate = pdjCalendarDate();
  syncVentesJournalDateInputsFromPdj(workDate, { force: false });
  if (currentPage === "ventes") renderVentesPage();
}

/** Aligne v-date et orders-filter-date-* sur la journee PDJ active, sauf si rien n'a change (sinon la sync live efface le filtre des gerants). */
function syncVentesJournalDateInputsFromPdj(workDate, { force = false } = {}) {
  const site = String(currentSiteId() || "");
  const d = String(workDate || "").trim().slice(0, 10);
  const stampKey = `${site}|${d}`;
  if (!force && ventesDomPdjStamp === stampKey) {
    syncFinalizeButtonJournalState();
    return;
  }
  ventesDomPdjStamp = stampKey;
  const vDateEl = document.getElementById("v-date");
  if (vDateEl) vDateEl.value = d;
  const filterStartEl = document.getElementById("orders-filter-date-start");
  const filterEndEl = document.getElementById("orders-filter-date-end");
  if (filterStartEl) filterStartEl.value = d;
  if (filterEndEl) filterEndEl.value = d;
  const boissonsStartEl = document.getElementById("pdj-boissons-date-start");
  const boissonsEndEl = document.getElementById("pdj-boissons-date-end");
  if (boissonsStartEl) boissonsStartEl.value = d;
  if (boissonsEndEl) boissonsEndEl.value = d;
  syncFinalizeButtonJournalState();
}

function dateRangeFromDom(startId, endId, fallbackIso) {
  let start = document.getElementById(startId)?.value?.trim().slice(0, 10) || "";
  let end = document.getElementById(endId)?.value?.trim().slice(0, 10) || "";
  const fallback = String(fallbackIso || "").slice(0, 10);
  if (!start && !end) {
    start = fallback;
    end = fallback;
  } else if (start && !end) {
    end = start;
  } else if (!start && end) {
    start = end;
  }
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  return { start, end };
}

function ordersPeriod() {
  return dateRangeFromDom("orders-filter-date-start", "orders-filter-date-end", pdjCalendarDate());
}

function pdjBoissonsPeriod() {
  return dateRangeFromDom("pdj-boissons-date-start", "pdj-boissons-date-end", pdjCalendarDate());
}

function dashboardPeriodMode() {
  return document.getElementById("dashboard-period-mode")?.value || "month";
}

function dashboardPeriod() {
  return periodFromControls("dashboard");
}

function recordsInDashboardPeriod(records, dateGetter) {
  return recordsInPeriod(records, dateGetter, dashboardPeriod());
}

function syncDashboardPeriodCustomUi() {
  syncPeriodCustomUi("dashboard");
}

function showObjectifFormulaTip() {
  const site = currentSite();
  const objectif = Number(site?.objectifCA) || 0;
  const msg = objectif > 0
    ? `Objectif mensuel : ${fmt(objectif)} FCFA.\n`
      + `CA compté : ventes finalisées du 1er au dernier jour du mois calendaire, hors « Crédit client ».\n`
      + `% = CA encaissé du mois ÷ objectif. Reste et rythmes/jour sur jours restants du mois.`
    : "Définissez un objectif dans Paramètres > Objectifs & facturation.";
  showToast(msg, { durationMs: 12000 });
}

function initDashboardPeriodDom() {
  initPeriodDom("dashboard");
}

function initExportPeriodDom() {
  initPeriodDom("export");
}

function ventesForDateRange(start, end) {
  return recordsForSite(state.ventes).filter((v) => {
    const d = saleDateValue(v);
    return d >= start && d <= end;
  });
}

function formatPeriodLabel(start, end) {
  return start === end
    ? formatDateDdMmYyyy(start)
    : `${formatDateDdMmYyyy(start)} au ${formatDateDdMmYyyy(end)}`;
}

/** Met a jour les champs date des ventes / commandes selon pdjCalendarDate() (journee serveur incluse). */
function applyPdjWorkDateToVentesAndOrderDom() {
  syncVentesJournalDateInputsFromPdj(pdjCalendarDate(), { force: false });
  renderTopbar();
}

/** Enregistre la date PDJ choisie pour le maquis actif : visible par tous (serveurs, gerants). */
async function persistPdjWorkDateFromSuperPicker() {
  if (!canSuperAdmin()) {
    showToast("Reserve au super administrateur.");
    return;
  }
  const el = document.getElementById("pdj-work-date");
  const raw = el?.value?.trim() || "";
  const t = today();
  const siteId = currentSiteId();
  const map = { ...(state.pdjWorkDateBySite || {}) };
  const tomorrow = addCalendarDaysIso(t, 1);
  if (!raw) {
    delete map[siteId];
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && raw <= tomorrow) {
    map[siteId] = raw;
  } else {
    showToast("Date invalide.");
    return;
  }
  await persistStatePatch({ pdjWorkDateBySite: map });
  pdjBrowseConsultationOnly = false;
  delete pdjViewDateBySite[siteId];
  if (el) el.value = map[siteId] || workingDate();
  recordStaffAudit(
    "update",
    "pdj_date_serveur",
    "Journee comptable imposee (toutes sessions)",
    `${siteId} -> ${map[siteId] || "mode automatique"}`,
  );
  ventesDomPdjStamp = "";
  syncPdjWorkDateInput();
  applyPdjWorkDateToVentesAndOrderDom();
  syncVentesJournalDateInputsFromPdj(pdjCalendarDate(), { force: true });
  renderTopbar();
  renderOrdersManagement();
  if (currentPage === "pdj") renderPointDuJour();
  if (currentPage === "ventes") renderVentesPage();
  showToast(
    map[siteId]
      ? `Journee du ${isoDateToDdMmYyyy(map[siteId])} appliquee a tout le monde pour ce maquis.`
      : "Retour a la date automatique pour ce maquis.",
  );
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
    planning: "Planning / horaires",
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

function isGerantRole() {
  return currentRole === "manager";
}

/** Suppression des charges : administrateurs uniquement (pas la gérante / manager). */
function canDeleteCharge() {
  return canAnyAdmin();
}

/** Modification d'un article catalogue existant : administrateurs uniquement (pas la gérante). */
function canEditStockCatalog() {
  return canAnyAdmin();
}

function canAccessSite(siteId) {
  return allowedSiteIds.includes(siteId);
}

function renderSiteSwitcher() {
  const availableSites = canGlobalSuperAdmin()
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
  syncSiteSwitcherDetailTitle();
}

/** Infobulle du sélecteur maquis : maquis actif + échéance indicative de session (lignes masquées dans la barre). */
function syncSiteSwitcherDetailTitle() {
  const select = document.getElementById("site-switcher");
  if (!select) return;
  if (!state || !sessionUser) {
    select.removeAttribute("title");
    return;
  }
  const sid = currentSiteId() || "";
  const parts = [];
  if (sid) {
    parts.push(`Maquis actif : ${currentSite()?.nom || sid} (${sid})`);
  }
  if (typeof sessionDeadlineUnix === "number" && sessionDeadlineUnix > 0) {
    const ms = sessionDeadlineUnix * 1000;
    if (ms > Date.now()) {
      parts.push(`Session (echeance indicative) : ${formatDateTimeDdMmYyyy(new Date(ms))}`);
    }
  }
  parts.push("Les ecritures (ventes, stock…) sont rattachees au maquis choisi.");
  parts.push("L'expiration reelle de session depend de l'inactivite et du serveur (MAQUIS_MANAGER_SESSION_*).");
  select.title = parts.join(" ");
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

  const stockHint = document.getElementById("stock-sale-formats-hint");
  if (stockHint) {
    stockHint.textContent = dual
      ? "Un format = quantite de bouteilles vendues ensemble avec son prix cave et prix maquis."
      : "Un format = quantite de bouteilles vendues ensemble avec un prix de vente unique (FCFA).";
  }
  const stockModal = document.getElementById("modal-stock");
  const formatRows = [...document.querySelectorAll("[data-format-row]")];
  if (stockModal && !stockModal.classList.contains("hidden") && formatRows.length) {
    const snap = formatRows.map((row) => {
      const quantite = Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1);
      const rawInt = String(row.querySelector(".stock-format-int")?.value ?? "").trim();
      const rawExtEl = row.querySelector(".stock-format-ext");
      const rawExt = rawExtEl ? String(rawExtEl.value ?? "").trim() : rawInt;
      const prixInterieur = rawInt === "" ? "" : Number(rawInt);
      let prixExterieur;
      if (!dual) {
        prixExterieur = prixInterieur === "" ? "" : prixInterieur;
      } else if (rawExt === "") {
        prixExterieur = prixInterieur === "" ? "" : prixInterieur;
      } else {
        prixExterieur = Number(rawExt);
      }
      return { quantite, prixInterieur, prixExterieur };
    });
    renderStockSaleFormats(snap);
    if (!dual) {
      const kitInt = document.getElementById("s-prix-kit-int");
      const kitExt = document.getElementById("s-prix-kit-ext");
      if (kitInt && kitExt) kitExt.value = kitInt.value;
      updateStockPriceInput();
    }
  }

  if (currentPage === "stock") renderStock();
}

function applyRoleVisibility() {
  const restrictedPages = ["home", "stock", "charges"];
  document.querySelectorAll(".nav-btn").forEach((button) => {
    const restricted = restrictedPages.includes(button.dataset.page);
    button.classList.toggle("hidden", !canManage() && restricted);
  });
  document.querySelectorAll(".manager-more-item").forEach((node) => {
    node.classList.toggle("hidden", !canManage());
  });
  syncServeuseRestDayNavAccess();
  if (ensureServeuseRestDayPage()) return;
  if (!canManage() && restrictedPages.includes(currentPage)) {
    navigate(serveuseRestDayActive() ? "planning" : "ventes");
    return;
  }
  document.querySelectorAll(".manager-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canManage());
  });
  document.querySelectorAll(".superadmin-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canSuperAdmin());
  });
  document.querySelectorAll(".global-superadmin-only").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canGlobalSuperAdmin());
  });
  document.querySelectorAll(".maquis-backup-admin").forEach((node) => {
    node.classList.toggle("hidden-by-role", !canManageMaquisBackups());
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
      else if (opt.classList.contains("scoped-superadmin-option")) opt.hidden = !canGlobalSuperAdmin();
      else if (opt.classList.contains("any-admin")) opt.hidden = !canAnyAdmin();
      else opt.hidden = false;
    });
    if (!canAnyAdmin() && roleSelect.value !== "serveuse") roleSelect.value = "serveuse";
    if (!canSuperAdmin() && roleSelect.value === "admin") {
      roleSelect.value = "serveuse";
    }
    if (!canGlobalSuperAdmin() && roleSelect.value === "superadmin") {
      roleSelect.value = "serveuse";
    }
  }
  const serveuse = isServeuseAccount();
  document.querySelectorAll(".serveuse-only-nav").forEach((node) => {
    node.classList.toggle("hidden", !serveuse);
  });
  document.querySelectorAll(".manager-caisse-nav").forEach((node) => {
    node.classList.toggle("hidden", serveuse);
  });
  if (!serveuse && currentPage === "historique-ventes") {
    navigate("ventes");
    return;
  }
  if (serveuse && currentPage === "ventes" && ventesSubTab === "caisse" && caisseInnerTab === "historique") {
    navigate("historique-ventes");
    return;
  }
  syncGerantParamsAccess();
  maybeAdjustParamsSubTab();
  updatePdjRoleVisibility();
  applyPermissionVisibility();
}

const PAGE_PERMISSIONS = {
  home:    "rapports",
  pdj:     "caisse",
  stock:   "stock",
  charges: "charges",
  params:  "parametres",
};

function applyPermissionVisibility() {
  // Superadmin et admin : accès total
  if (canSuperAdmin() || canSiteAdmin()) return;

  // Contrôle nav : les permissions remplacent les restrictions de rôle pour les pages mappées
  const _pdjOpenService = isServeuseAccount() && serveuseHasOpenServiceToday();
  document.querySelectorAll(".nav-btn[data-page]").forEach((btn) => {
    const required = PAGE_PERMISSIONS[btn.dataset.page];
    if (!required) return;
    if (btn.dataset.page === "pdj" && _pdjOpenService) return; // service ouvert → accès PDJ autorisé
    btn.classList.toggle("hidden", !hasPermission(required));
  });

  // Rediriger si la page courante est interdite
  const requiredForCurrent = PAGE_PERMISSIONS[currentPage];
  if (requiredForCurrent && !hasPermission(requiredForCurrent)) {
    if (currentPage === "pdj" && _pdjOpenService) {
      // serveuse avec service ouvert : rester sur PDJ pour clôturer
    } else {
      navigate(hasPermission("ventes") ? "ventes" : "guide");
      return;
    }
  }

  // Onglet Accès dans Paramètres : contrôlé par permission "utilisateurs"
  const accesTabs = document.querySelectorAll("[data-subtab-params='acces'], [data-params-panel='acces']");
  accesTabs.forEach((el) => el.classList.toggle("hidden-by-role", !hasPermission("utilisateurs")));

  // Sections avec data-require-perm="..."
  document.querySelectorAll("[data-require-perm]").forEach((el) => {
    el.classList.toggle("hidden-by-role", !hasPermission(el.dataset.requirePerm));
  });
}

/** Serveuse / gérante : onglet Profil seul ; sauvegarde réservée aux admins (pas gérante). */
function syncParamsTabsAccess() {
  const root = document.getElementById("page-params");
  if (!root) return;
  const serveuse = isServeuseAccount();
  const gerant = isGerantRole();
  const profilOnly = serveuse || gerant;

  root.querySelector(".params-subtabs")?.classList.toggle("hidden-by-role", profilOnly);

  root.querySelectorAll("[data-subtab-params]").forEach((btn) => {
    const tab = btn.dataset.subtabParams;
    let hide = false;
    if (profilOnly) hide = tab !== "profil";
    else if (tab === "sauvegarde") hide = !canManageMaquisBackups();
    else if (tab === "catalogue" || tab === "acces" || tab === "admin") hide = !canAnyAdmin();
    btn.classList.toggle("hidden-by-role", hide);
  });

  if (profilOnly && currentPage === "params" && paramsSubTab !== "profil") {
    setParamsSubTab("profil");
  }
}

function syncGerantParamsAccess() {
  syncParamsTabsAccess();
}

function renderTopbar() {
  document.getElementById("top-bar-name").textContent = currentSite()?.nom || "Mon Bar";
  const journalDateEl = document.getElementById("top-journal-date");
  const journalDiffEl = document.getElementById("top-journal-diff");
  if (journalDateEl) {
    if (state && sessionUser) {
      const j = pdjCalendarDate();
      journalDateEl.textContent = formatDateDdMmYyyy(j);
      if (journalDiffEl) {
        const civil = today();
        const closeBtn = document.getElementById("top-journal-close-btn");
        if (j && j !== civil) {
          const closed = !!stockCheckForSiteDate(j, currentSiteId());
          journalDiffEl.textContent = closed
            ? `(journee cloturee — jour civil : ${formatDateDdMmYyyy(civil)})`
            : `(non cloturee — jour civil : ${formatDateDdMmYyyy(civil)})`;
          journalDiffEl.classList.remove("hidden");
          if (closeBtn && canManagePdjAccounting()) {
            closeBtn.classList.remove("hidden");
          } else if (closeBtn) {
            closeBtn.classList.add("hidden");
          }
        } else {
          journalDiffEl.textContent = "";
          journalDiffEl.classList.add("hidden");
          closeBtn?.classList.add("hidden");
        }
      }
    } else {
      journalDateEl.textContent = "—";
      journalDiffEl?.classList.add("hidden");
    }
  }
  const _displayLabel = sessionUserDisplayLabel() || "utilisateur";
  document.getElementById("session-user").textContent = _displayLabel;
  const _chip = document.getElementById("topbar-session-chip");
  if (_chip) _chip.textContent = _displayLabel;
  const _moreInfo = document.getElementById("mobile-more-session-info");
  if (_moreInfo) _moreInfo.textContent = _displayLabel;
  const eff = String(sessionUser || "").trim().toLowerCase() === "admin" ? "superadmin" : currentRole;
  const roleLabel = eff === "superadmin" && canGlobalSuperAdmin()
    ? "super administrateur"
    : eff === "superadmin" || eff === "admin"
      ? "admin. maquis"
      : eff === "manager"
        ? "gérant"
        : (eff || "utilisateur");
  const badge = document.getElementById("role-badge");
  badge.textContent = roleLabel;
  badge.title = `Compte : ${sessionUserDisplayLabel() || "—"} (${sessionUser || "—"}). Rôle effectif : ${roleLabel}. Les actions sensibles sont vérifiées côté serveur selon ce rôle et les maquis autorisés.`;
  syncSiteSwitcherDetailTitle();
}

function renderHero() {
  const titles = {
    home: "Le cœur de votre bar, en temps réel.",
    pdj: "Le point du jour, séparé du tableau de bord.",
    ventes: "Servez plusieurs clients sans perdre la commande en cours.",
    guide: "Mode d'emploi accessible à toute l'équipe.",
    stock: "Les prix de vente partent du catalogue stock.",
    charges: "Les sorties d'argent restent centralisées.",
    params: "Paramètres : profil personnel pour tous ; catalogue, accès et administration pour les rôles autorisés.",
    planning: "Consultez vos horaires et, si vous êtes gérant, planifiez l'équipe.",
    "historique-ventes": "Vos factures encaissées, filtrées par période.",
  };
  const copies = {
    home: "Le serveur garde les sessions et l'état complet de l'application.",
    pdj: "Ouverture : gérant / admin. Clôture : gérant ou équipe en créneau de service ; la gérante confirme avant le jour suivant. Ventes autorisées uniquement pendant votre service planifié.",
    ventes: "Une commande peut être modifiée autant de fois que nécessaire avant la facture finale, si la journée est ouverte.",
    guide: "Sommaire, liens vers le guide imprimable PDF ; même les comptes serveuse peuvent consulter cette page.",
    stock: "Renseignez prix achat et prix vente pour accélérer la prise de commande.",
    charges: "Toutes les dépenses sont historisées côté serveur.",
    params: "Onglet Profil : mon compte (nom affiché, mot de passe) pour tous ; réglages du maquis réservés au gérant ou aux administrateurs.",
    planning: "Mes horaires : lecture pour toute l'équipe. Onglet Équipe : création des créneaux (gérant / admin).",
    "historique-ventes": "Consultation et impression de vos ventes uniquement — pas l'historique caisse du gérant.",
  };
  document.getElementById("hero-title").textContent = titles[currentPage];
  document.getElementById("hero-copy").textContent = copies[currentPage];
}

function syncCaisseInnerPanels() {
  const hist = document.getElementById("ventes-caisse-panel-historique");
  const rec = document.getElementById("ventes-caisse-panel-recouvrement");
  if (!rec) return;
  const showHistorique = caisseInnerTab === "historique";
  if (hist) {
    hist.classList.toggle("hidden", !showHistorique);
    hist.setAttribute("aria-hidden", showHistorique ? "false" : "true");
  }
  rec.classList.toggle("hidden", showHistorique);
  rec.setAttribute("aria-hidden", showHistorique ? "true" : "false");
  document.querySelectorAll("[data-caisse-inner]").forEach((btn) => {
    const inner = btn.dataset.caisseInner;
    const active = inner === caisseInnerTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (showHistorique) renderSalesHistory();
}

function setCaisseInnerTab(tab) {
  if (tab !== "historique" && tab !== "recouvrement") return;
  if (tab === "historique" && isServeuseAccount()) {
    navigate("historique-ventes");
    return;
  }
  caisseInnerTab = tab;
  syncCaisseInnerPanels();
  syncNavActiveState();
}

function setPdjSubTab(tab, opts = {}) {
  const allowed = ["synthese", "cloture", "ventes"];
  pdjSubTab = allowed.includes(tab) ? tab : "synthese";
  const isSynthese = pdjSubTab === "synthese";
  const isCloture = pdjSubTab === "cloture";
  const isVentes = pdjSubTab === "ventes";
  document.getElementById("pdj-panel-synthese")?.classList.toggle("hidden", !isSynthese);
  document.getElementById("pdj-panel-cloture")?.classList.toggle("hidden", !isCloture);
  document.getElementById("pdj-panel-ventes")?.classList.toggle("hidden", !isVentes);
  document.querySelectorAll("[data-subtab-pdj]").forEach((btn) => {
    const active = btn.dataset.subtabPdj === pdjSubTab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  if (opts.scrollTop && currentPage === "pdj") {
    document.getElementById("page-pdj")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function suggestPdjSubTabForDay() {
  const dStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  if (isPdjBrowseConsultationOnly() && closed) return "synthese";
  if (closed) return "synthese";
  if (PDJ_REQUIRE_CASH_OPENING && dayBookNeedsCashOpening(dayBookFor(dStr, currentSiteId()))) return "cloture";
  return pdjSubTab || "synthese";
}

function updatePdjSubTabHints() {
  const clotureBtn = document.querySelector('[data-subtab-pdj="cloture"]');
  if (!clotureBtn) return;
  const dStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  const needsOpen = PDJ_REQUIRE_CASH_OPENING && dayBookNeedsCashOpening(dayBookFor(dStr, currentSiteId()));
  if (isPdjBrowseConsultationOnly()) {
    clotureBtn.title = "Consultation seule — journée clôturée";
    clotureBtn.classList.remove("pdj-tab-attention");
    return;
  }
  if (closed) {
    clotureBtn.removeAttribute("title");
    clotureBtn.classList.remove("pdj-tab-attention");
  } else if (needsOpen) {
    clotureBtn.title = "Ouverture de caisse requise";
    clotureBtn.classList.add("pdj-tab-attention");
  } else {
    clotureBtn.title = "Vérification stock et clôture";
    clotureBtn.classList.add("pdj-tab-attention");
  }
}

function setVentesSubTab(tab) {
  ventesSubTab = tab;
  if (serveuseVentesModuleBlocked()) {
    syncServeuseVentesPageRestDay();
    syncNavActiveState();
    return;
  }
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
    else if (isCasiers) { renderCasiers(); syncCasiersManquants({ silent: true }).then((n) => { if (n > 0) renderCasiers(); }).catch(() => {}); }
  }
  syncFabLabelForStockPage();
}

let _casierPhysicalFilter = "tous";

function setCasierFilter(f) {
  _casierPhysicalFilter = f;
  renderCasiers();
}

function _renderPhysicalCasiersSection(allCasiers) {
  if (!allCasiers.length) return "";
  const f = _casierPhysicalFilter || "tous";
  const statutMatch = { pleins: "plein", partiels: "partiel", vides: "vide" };
  const filtered = f === "tous" ? allCasiers : allCasiers.filter((c) => (c.statut || "vide").toLowerCase() === (statutMatch[f] || f));
  const cnt = {
    tous: allCasiers.length,
    pleins: allCasiers.filter((c) => (c.statut || "").toLowerCase() === "plein").length,
    partiels: allCasiers.filter((c) => (c.statut || "").toLowerCase() === "partiel").length,
    vides: allCasiers.filter((c) => !["plein", "partiel"].includes((c.statut || "").toLowerCase())).length,
  };
  const tabBtn = (key, label) => {
    const active = key === f;
    const base = "padding:5px 14px;border-radius:20px;font-size:0.82rem;cursor:pointer;border:1px solid transparent";
    const style = active
      ? `${base};background:var(--mm-primary,#B57321);color:var(--mm-on-primary,#FBF6EA);font-weight:600;border-color:var(--mm-primary,#B57321)`
      : `${base};background:transparent;color:var(--muted,#756A57);border-color:var(--line,rgba(28,24,20,0.12))`;
    return `<button type="button" style="${style}" onclick="setCasierFilter('${key}')">${label} <strong>${cnt[key]}</strong></button>`;
  };
  const cards = [...filtered].sort((a, b) => String(a.code || "").localeCompare(String(b.code || ""), "fr")).map((c) =>
    `<cave-casier code="${escapeHtml(c.code || "")}" article="${escapeHtml(c.article || "")}" capacite="${Number(c.capacite) || 24}" qte="${Math.max(0, Number(c.quantiteActuelle) || 0)}" emplacement="${escapeHtml(c.emplacement || "")}" statut="${escapeHtml((c.statut || "vide").toLowerCase())}"></cave-casier>`
  ).join("");
  const grid = filtered.length
    ? `<div class="cave-casiers-grid">${cards}</div>`
    : `<p style="text-align:center;color:var(--muted,#756A57);padding:20px">Aucun casier dans cette catégorie.</p>`;
  return `<div style="margin-bottom:28px">
    <p style="font-size:0.68rem;letter-spacing:0.18em;text-transform:uppercase;color:var(--muted,#756A57);margin:0 0 2px">INVENTAIRE PHYSIQUE</p>
    <h3 style="margin:0 0 14px;font-size:1.3rem;font-family:var(--cm-serif,'Instrument Serif',Georgia,serif);font-weight:400">Casiers de la cave</h3>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">${tabBtn("tous","Tous")}${tabBtn("pleins","Pleins")}${tabBtn("partiels","Partiels")}${tabBtn("vides","Vides")}</div>
    ${grid}
  </div>`;
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
      const artKey = `${cap}|${String(c.article || "").toLowerCase().trim()}`;
      if (!byBr[br]) byBr[br] = { ...mkGrp(), byArt: {} };
      const g = byBr[br];
      if (!g.byArt[artKey]) g.byArt[artKey] = { ...mkGrp(), cap, article: c.article || "—" };
      const gc = g.byArt[artKey];
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
          const artRows = Object.entries(g.byArt).sort(([, a], [, b]) => b.cap - a.cap || (a.article || "").localeCompare(b.article || "", "fr"));
          return `<tr style="background:#eaf2ff">
            <td><strong style="color:#1565c0">${escapeHtml(br)}</strong></td>
            <td style="text-align:right;font-weight:700;color:#2e7d32">${fmt(g.plein)}</td>
            <td style="text-align:right;font-weight:700;color:#f57c00">${fmt(g.partiel)}</td>
            <td style="text-align:right;font-weight:700;color:#e53935">${fmt(g.vide)}</td>
            <td style="text-align:right;font-weight:700;color:#1976d2">${fmt(g.btlPleines)}</td>
            <td style="text-align:right;font-weight:700;${g.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(g.btlVides)}</td>
          </tr>${artRows.map(([, gc]) => `<tr style="background:#fafbff">
            <td style="padding-left:22px;font-size:0.8rem"><span style="color:#90a4ae">↳</span> <strong style="color:#455a64">B${gc.cap}</strong> <span style="font-size:0.72rem;color:#546e7a;margin-left:4px">${escapeHtml(gc.article)}</span></td>
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
  let html = `<div style="display:flex;gap:8px;justify-content:flex-end;margin-bottom:14px;flex-wrap:wrap">
    <button type="button" class="purge-casiers-btn" style="background:#e53935;color:#fff;border:none;padding:7px 16px;border-radius:8px;font-size:0.82rem;cursor:pointer;font-weight:600;letter-spacing:0.01em">
      🗑 Purger casiers vides retournés
    </button>
    <button type="button" class="sync-casiers-manquants-btn" style="background:#2e7d32;color:#fff;border:none;padding:7px 16px;border-radius:8px;font-size:0.82rem;cursor:pointer;font-weight:600;letter-spacing:0.01em">
      + Compléter casiers manquants
    </button>
    <button type="button" class="sync-casiers-btn" style="background:#1565c0;color:#fff;border:none;padding:7px 16px;border-radius:8px;font-size:0.82rem;cursor:pointer;font-weight:600;letter-spacing:0.01em">
      ⟳ Recréer tout depuis stock
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
  container.innerHTML = _renderPhysicalCasiersSection(allCasiers) + casiersResume + html;
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
  if (tab === "sauvegarde") {
    apiRequest(API.session)
      .then((s) => {
        applySessionFieldsFromApi(s);
        applyRoleVisibility();
        renderSitesList();
        if (canManageMaquisBackups()) refreshRestoreBackupUi().catch(() => {});
      })
      .catch(() => {});
  }
  if (tab === "correction") {
    renderCorrectionPanel();
  }
  if (tab === "admin") {
    populatePurgeMaquisSelect();
    renderStaffAuditLog();
  }
  if (tab === "acces") {
    renderUsersList();
    renderCustomRolesList();
    populateCustomRoleSelect();
  }
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
  if (currentPage === "ventes" && ventesSubTab === "caisse" && caisseInnerTab === "recouvrement") {
    fab.setAttribute("aria-label", "Voir factures crédit du jour");
    fab.title = "Affiche les factures crédit client de la journée ouverte.";
    return;
  }
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
  if (page === "historique-ventes" && !isServeuseAccount()) page = "ventes";
  if (!serveusePageAllowedDuringRest(page)) {
    serveuseRestDayBlockToast();
    page = "planning";
  }
  currentPage = page;
  const vstab = opts.ventesSubtab;
  const cinner = opts.caisseInner;
  if (vstab !== undefined && vstab !== null && String(vstab).trim() !== "") ventesSubTab = vstab;
  if (cinner !== undefined && cinner !== null && String(cinner).trim() !== "") {
    const ci = String(cinner).trim();
    caisseInnerTab = ci;
  }
  if (vstab === "caisse" && (cinner === undefined || String(cinner).trim() === "")) caisseInnerTab = "recouvrement";

  document.querySelectorAll(".page").forEach((node) => node.classList.remove("active"));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add("active");

  syncNavActiveState();
  document.getElementById("fab-btn").classList.toggle("hidden", !["ventes", "stock", "charges"].includes(page));
  renderHero();
  renderSiteSwitcher();
  if (page === "home") renderDashboard();
  if (page === "pdj") {
    syncPdjWorkDateInput();
    const forcedPdj = opts.pdjSubTab;
    if (forcedPdj && ["synthese", "cloture", "ventes"].includes(String(forcedPdj))) {
      pdjSubTab = forcedPdj;
    } else if (!opts.keepPdjSubTab) {
      pdjSubTab = suggestPdjSubTabForDay();
    }
    renderPointDuJour();
    setPdjSubTab(pdjSubTab, { scrollTop: Boolean(forcedPdj === "cloture") });
  }
  if (page === "ventes") {
    syncPdjWorkDateInput();
    setVentesSubTab(ventesSubTab);
    renderVentesPage();
  }
  if (page === "stock") { setStockSubTab(stockSubTab); renderStock(); }
  if (page === "charges") renderCharges();
  if (page === "params") {
    loadParamsForm();
    maybeAdjustParamsSubTab();
  }
  if (page === "planning") renderPlanningPage().catch(handleApiError);
  if (page === "historique-ventes") renderServeuseSalesHistoryPage().catch(handleApiError);
  syncFabLabelForStockPage();
  applyRoleVisibility();
}

function handleNavButtonClick(button) {
  const page = button?.dataset?.page;
  if (!page) return;
  if (!serveusePageAllowedDuringRest(page)) {
    serveuseRestDayBlockToast();
    return;
  }
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
    if (nav === "planning" && !serveusePageAllowedDuringRest("planning")) {
      serveuseRestDayBlockToast();
      return;
    }
    if (nav === "historique-ventes" && !serveusePageAllowedDuringRest("historique-ventes")) {
      serveuseRestDayBlockToast();
      return;
    }
    if (nav === "qr") navigate("ventes", { ventesSubtab: "qr" });
    else if (nav === "consignes") navigate("ventes", { ventesSubtab: "consignes" });
    else if (nav === "guide") navigate("guide");
    else if (nav === "charges") navigate("charges");
    else if (nav === "params") navigate("params");
    else if (nav === "planning") navigate("planning");
    else if (nav === "historique-ventes") navigate("historique-ventes");
    else if (nav === "logout") logout();
  });
}

function ventePriceContextDate() {
  const v = String(document.getElementById("v-date")?.value || "").trim();
  return v.length >= 10 ? v.slice(0, 10) : today();
}

function normalizePromotions(item = {}) {
  return (Array.isArray(item.promotions) ? item.promotions : [])
    .map((p, index) => ({
      id: Number(p.id) || index + 1,
      libelle: String(p.libelle || p.nom || "Promotion").trim() || "Promotion",
      dateDebut: String(p.dateDebut || p.dateEffet || "").slice(0, 10),
      dateFin: String(p.dateFin || "").slice(0, 10),
      formatsVente: normalizeSaleFormatsFromRaw(p.formatsVente || [], p),
      stockPromoRestant: p.stockPromoRestant != null ? Number(p.stockPromoRestant) : null,
    }))
    .filter((p) => p.dateDebut && p.formatsVente.length)
    .sort((a, b) => a.dateDebut.localeCompare(b.dateDebut));
}

function activePromotion(item = {}, asOfDate) {
  const d = String(asOfDate || today()).slice(0, 10);
  const applicable = normalizePromotions(item).filter((p) => {
    if (p.dateDebut > d) return false;
    if (p.dateFin && p.dateFin < d) return false;
    if (p.stockPromoRestant != null && p.stockPromoRestant <= 0) return false;
    return true;
  });
  if (!applicable.length) return null;
  return applicable[applicable.length - 1];
}

function upcomingPromotion(item = {}, asOfDate) {
  const d = String(asOfDate || today()).slice(0, 10);
  return normalizePromotions(item).find((p) => p.dateDebut > d) || null;
}

function promotionBadgeHtml(item, asOfDate = today()) {
  const active = activePromotion(item, asOfDate);
  if (active) {
    const fin = active.dateFin ? ` → ${formatDateDdMmYyyy(active.dateFin)}` : "";
    const restant = active.stockPromoRestant != null ? Math.ceil(active.stockPromoRestant) : null;
    const stockLabel = restant != null ? ` · ${fmt(restant)} cas.` : "";
    return `<span class="badge badge-amber" title="${escapeHtml(active.libelle)}${fin}${stockLabel}">Promo${restant != null ? ` (${fmt(restant)} cas.)` : ""}</span>`;
  }
  const next = upcomingPromotion(item, asOfDate);
  if (next) {
    return `<span class="badge" title="${escapeHtml(next.libelle)}">Promo ${formatDateDdMmYyyy(next.dateDebut)}</span>`;
  }
  return "";
}

function normalizeSaleFormatsFromRaw(rawFormats, fallbackItem = {}) {
  const formats = (Array.isArray(rawFormats) ? rawFormats : []).map((format) => ({
    quantite: Math.max(1, Number(format.quantite ?? format.qty ?? format.packSize) || 1),
    prixInterieur: Number(format.prixInterieur ?? format.prixInt ?? format.prixVenteInt) || 0,
    prixExterieur: Number(format.prixExterieur ?? format.prixExt ?? format.prixVenteExt) || 0,
  })).filter((format) => format.prixInterieur > 0);
  if (!formats.length) {
    const packSize = Math.max(1, Number(fallbackItem.packSize) || 1);
    const prixInt = Number(fallbackItem.prixVenteInt) || Number(fallbackItem.prixKitInt) || Number(fallbackItem.prixBouteille) || Number(fallbackItem.prixVente) || 0;
    const prixExt = Number(fallbackItem.prixVenteExt) || Number(fallbackItem.prixKitExt) || Number(fallbackItem.prixBouteille) || Number(fallbackItem.prixVente) || prixInt;
    if (prixInt > 0) formats.push({ quantite: packSize, prixInterieur: prixInt, prixExterieur: prixExt || prixInt });
  }
  return formats
    .map((format) => ({ ...format, prixExterieur: format.prixExterieur || format.prixInterieur }))
    .sort((a, b) => a.quantite - b.quantite);
}

function baseSaleFormats(item = {}) {
  return normalizeSaleFormatsFromRaw(item.formatsVente, item);
}

function resolveItemPrices(item, asOfDate) {
  const primary = primarySaleFormat(item, asOfDate);
  const prixInt = Number(primary?.prixInterieur) || Number(item.prixVenteInt) || Number(item.prixKitInt) || Number(item.prixBouteille) || Number(item.prixVente) || 0;
  const prixExt = Number(primary?.prixExterieur) || Number(item.prixVenteExt) || Number(item.prixKitExt) || Number(item.prixBouteille) || Number(item.prixVente) || prixInt;
  return { prixInt, prixExt };
}

function normalizeSaleFormats(item = {}, asOfDate) {
  const promo = activePromotion(item, asOfDate);
  if (promo) return promo.formatsVente.slice();
  return baseSaleFormats(item);
}

function primarySaleFormat(item = {}, asOfDate) {
  const formats = normalizeSaleFormats(item, asOfDate);
  return formats.find((format) => format.quantite === 1) || formats[0] || null;
}

/** Prix de vente moyen par bouteille (format principal / kit). Tarif unique : prix du lieu unique ; deux zones : moyenne int./ext. */
function stockRetailUnitPricePerBottle(item, site = currentSite(), asOfDate = today()) {
  const primary = primarySaleFormat(item, asOfDate);
  const packQty = Math.max(1, Number(primary?.quantite) || Number(item.packSize) || 1);
  let puInt = Number(primary?.prixInterieur) || 0;
  let puExt = Number(primary?.prixExterieur) || 0;
  if (!puInt && !puExt) {
    const r = resolveItemPrices(item);
    puInt = Number(r.prixInt) || 0;
    puExt = Number(r.prixExt) || 0;
  }
  const dual = siteUsesDualZonePricing(site);
  let packPrice = 0;
  if (!dual) {
    packPrice = puInt || puExt || 0;
  } else {
    const a = Math.max(0, puInt);
    const b = Math.max(0, puExt) || a;
    packPrice = a > 0 && b > 0 && a !== b ? (a + b) / 2 : (a || b);
  }
  return packPrice > 0 ? packPrice / packQty : 0;
}

/** Valorisation stock PDV : bouteilles en stock × prix de vente unitaire (pas casiers × prix d'achat). */
function stockRetailValueFcfa(item, site = currentSite(), asOfDate = today()) {
  const btl = stockActuel(item);
  const unit = stockRetailUnitPricePerBottle(item, site, asOfDate);
  return Math.round(Math.max(0, btl) * unit);
}

/** Valeur du stock : bouteilles × (prixAchat ÷ caseSize) = coût réel par bouteille. */
function stockPurchaseValueFcfa(item) {
  return Math.round(Math.max(0, stockActuel(item)) * prixAchatParBouteille(item));
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

function knownProducts(asOfDate) {
  const priceDate = String(asOfDate || today()).slice(0, 10);
  const map = new Map();
  recordsForSite(state.stock).forEach((item) => {
    const formatsVente = normalizeSaleFormats(item, priceDate);
    const primary = primarySaleFormat(item, priceDate);
    const packSize = Math.max(1, Number(primary?.quantite) || Number(item.packSize) || 1);
    const { prixInt, prixExt } = resolveItemPrices(item, priceDate);
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

function findKnownProduct(name, asOfDate) {
  const value = name.trim().toLowerCase();
  if (!value) return null;
  const list = knownProducts(asOfDate ?? ventePriceContextDate());
  return list.find((item) => item.article.toLowerCase() === value)
    || list.find((item) => item.article.toLowerCase().includes(value))
    || null;
}

function catalogItemForPricing(article, asOfDate) {
  return stockItemForArticle(article) || findKnownProduct(article, asOfDate);
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
  const fixedPrice = productPrice(product, document.getElementById("v-location").value, ventePriceContextDate());
  document.getElementById("v-prix").value = String(fixedPrice || "");
  updateVentePreview();
}

/** Liste filtrée pour la modale commande (hors QR). */
function productsForVentePicker(query) {
  // Only show articles that exist in the current stock catalogue (not deleted articles from sales history)
  const catalogueIds = new Set(recordsForSite(state.stock).map((i) => i.article.toLowerCase()));
  const items = knownProducts(ventePriceContextDate())
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
  const priceDay = ventePriceContextDate();
  wrap.innerHTML = hint + list.map((p) => {
    const stockItem = stockItemForArticle(p.article);
    const avail = stockItem ? availableStock(stockItem) : null;
    const avLabel = avail == null ? "—" : `${fmt(avail)} btl`;
    const enc = encodeURIComponent(p.article);
    const pu = productPrice(p, "Intérieur", priceDay);
    const promo = stockItem && activePromotion(stockItem, priceDay) ? " · Promo" : "";
    return `<button type="button" class="vente-picker-row" data-vente-pick="${enc}">
      <span class="vente-picker-name">${escapeHtml(p.article)}</span>
      <span class="vente-picker-meta">${escapeHtml(p.cat || "—")} · ${fmt(pu)} FCFA${promo} · Stock ${avLabel}</span>
    </button>`;
  }).join("");
}

function productPrice(product, location, asOfDate) {
  if (!product) return 0;
  const format = selectedSaleFormat(product, asOfDate);
  if (format) return formatPrice(format, location);
  return String(location).startsWith("Ext") ? Number(product.prixExt) || 0 : Number(product.prixInt) || 0;
}

function populateSaleFormatSelect(product, selectedQuantity = null, asOfDate) {
  const select = document.getElementById("v-format");
  if (!select) return;
  const stockItem = product?.article ? stockItemForArticle(product.article) : null;
  const priceItem = stockItem || product;
  const formats = priceItem ? normalizeSaleFormats(priceItem, asOfDate || ventePriceContextDate()) : [];
  select.innerHTML = formats.length
    ? formats.map((format) => `<option value="${format.quantite}">${escapeHtml(saleFormatLabel(format))}</option>`).join("")
    : `<option value="1">Unite</option>`;
  if (selectedQuantity) select.value = String(selectedQuantity);
}

function selectedSaleFormat(product, asOfDate) {
  if (!product) return null;
  const stockItem = stockItemForArticle(product.article);
  const priceItem = stockItem || product;
  const d = asOfDate || ventePriceContextDate();
  const formats = normalizeSaleFormats(priceItem, d);
  const selected = Number(document.getElementById("v-format")?.value) || 0;
  return formats.find((format) => format.quantite === selected) || primarySaleFormat(priceItem, d);
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
  syncPdjWorkDateInput({ keepCurrentValue: true });
  const dStr = pdjCalendarDate();
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totalsJour = paymentTotals(ventesJour);
  const creditEmisJour = creditIssuedOnDate(dStr);
  const caCreances = totalCreditOutstanding();
  const caEncaisse = Object.entries(totalsJour).reduce((sum, [method, amount]) => String(method).includes("dit client") ? sum : sum + amount, 0);
  const promosActives = recordsForSite(state.stock).filter((item) => activePromotion(item, dStr)).length;

  const recouvrementJour = creditRecoveriesForPdjDate(dStr);
  const caRecouvrement = recouvrementJour.reduce((sum, r) => sum + (Number(r.montant) || 0), 0);
  const caEncaisseTotal = caEncaisse + caRecouvrement;

  const totalsJourAvecRecouvrement = Object.fromEntries(Object.entries(totalsJour).filter(([method]) => !String(method).includes("dit client")));
  recouvrementJour.forEach((r) => {
    const m = r.paiement || "Espèces";
    totalsJourAvecRecouvrement[m] = (totalsJourAvecRecouvrement[m] || 0) + (Number(r.montant) || 0);
  });

  const pdjDateEl = document.getElementById("pdj-date");
  if (pdjDateEl) {
    const t = today();
    const consultLabel = isPdjBrowseConsultationOnly() ? " · consultation seule" : "";
    pdjDateEl.textContent = dStr !== t
      ? `Journée du ${formatDateDdMmYyyy(dStr)}${consultLabel} · aujourd'hui ${formatDateDdMmYyyy(new Date())}`
      : `${formatDateDdMmYyyy(new Date())}${consultLabel}`;
  }
  const consultBanner = document.getElementById("pdj-consultation-banner");
  if (consultBanner) {
    if (isPdjBrowseConsultationOnly()) {
      consultBanner.classList.remove("hidden");
      consultBanner.innerHTML = `<strong>Consultation seule</strong> — cette journée est déjà clôturée. Vous pouvez consulter et imprimer le rapport ; pour modifier, un administrateur doit d'abord <strong>réouvrir</strong> la journée.`;
    } else {
      consultBanner.classList.add("hidden");
      consultBanner.innerHTML = "";
    }
  }
  renderCashOpeningPanel();
  renderPdjManagerConfirmationBlock();
  document.getElementById("pdj-ca").textContent = `${fmt(caEncaisseTotal)} FCFA`;
  document.getElementById("pdj-creances").textContent = `${fmt(caCreances)} FCFA`;
  const pdjCreancesSub = document.getElementById("pdj-creances-sub");
  if (pdjCreancesSub) {
    pdjCreancesSub.textContent = creditEmisJour > 0
      ? `Crédits émis ce jour : ${fmt(creditEmisJour)} FCFA (après remboursements, reste ci-dessus)`
      : caCreances > 0
        ? "Solde dû tous clients (recouvrement)"
        : "";
    pdjCreancesSub.classList.toggle("hidden", !creditEmisJour && !(caCreances > 0));
  }
  document.getElementById("pdj-nb").textContent = String(ventesJour.length);
  document.getElementById("pdj-remises").textContent = String(promosActives);
  document.getElementById("pdj-ventes-count").textContent = formatVentesCountFr(ventesJour.length);

  const { start: boissonsStart, end: boissonsEnd } = pdjBoissonsPeriod();
  renderSalesByProduct(ventesForDateRange(boissonsStart, boissonsEnd), {
    periodLabel: formatPeriodLabel(boissonsStart, boissonsEnd),
  });
  renderBreakdown(
    "pdj-pay-chart",
    totalsJourAvecRecouvrement,
    caEncaisseTotal,
    dStr === today() ? "Aucun encaissement enregistre aujourd'hui." : `Aucun encaissement pour le ${formatDateDdMmYyyy(dStr)}.`,
  );

  const sorted = ventesJour.slice().sort((a, b) => b.date.localeCompare(a.date));
  const recouvrementItems = recouvrementJour.map((r) => `
    <article class="list-item">
      <div>
        <p class="list-item-title">Remboursement crédit — ${escapeHtml(debtorDisplayKey(r.debiteur))}</p>
        <p class="list-item-sub">Recouvrement · ${escapeHtml(r.paiement || "Espèces")}${r.note ? ` · ${escapeHtml(r.note)}` : ""}</p>
      </div>
      <div class="list-side">
        <div>
          <p class="list-item-amount" style="color:#72d7a9">${fmt(r.montant)} FCFA</p>
          <p class="list-item-date">${escapeHtml(formatDateDdMmYyyy(dStr))}</p>
        </div>
      </div>
    </article>
  `).join("");
  const ventesItems = sorted.map((v) => `
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
  `).join("");
  document.getElementById("pdj-ventes-list").innerHTML = (recouvrementItems + ventesItems) || emptyState(
    dStr === today() ? "Aucune vente aujourd'hui" : `Aucune vente le ${formatDateDdMmYyyy(dStr)}`,
    dStr === today()
      ? "Les ventes du jour apparaissent ici dès qu'elles sont enregistrées."
      : "Les ventes de cette date apparaîtront ici.",
  );
  renderDailyStockCheck();
  renderPastClosuresForReopen();
  renderClosedDaysArchive();
  updatePdjRoleVisibility();
  updateCloseDayButtonLabel();
  updatePdjPrintButtons();
  updatePdjSubTabHints();
  setPdjSubTab(pdjSubTab);
}

function renderClosedDaysArchive() {
  const host = document.getElementById("pdj-closed-archive");
  if (!host) return;
  if (!canManagePdjAccounting()) {
    host.innerHTML = "";
    return;
  }
  const siteId = currentSiteId();
  const checks = (state.stockChecks || [])
    .filter((sc) => sc && sc.siteId === siteId && sc.date && /^\d{4}-\d{2}-\d{2}$/.test(String(sc.date).slice(0, 10)))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  if (!checks.length) {
    host.innerHTML = "";
    return;
  }
  const current = pdjCalendarDate();
  const t = today();
  host.innerHTML = `
    <div class="section-head pdj-detail-head" style="margin-top:16px">
      <h3 class="pdj-detail-title">Journées clôturées</h3>
    </div>
    <p class="muted" style="font-size:0.85rem;margin:0 0 10px;line-height:1.45">
      Consultez ou réimprimez le rapport de clôture d'une journée passée.
    </p>
    <ul style="list-style:none;padding:0;margin:0;display:grid;gap:8px">
      ${checks.map((sc) => {
        const d = String(sc.date).slice(0, 10);
        const active = d === current;
        const when = sc.createdAt ? formatDateTimeDdMmYyyy(sc.createdAt) : "";
        return `<li class="list-item" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap${active ? ";border-color:rgba(33,150,243,0.45)" : ""}">
          <div>
            <strong>${escapeHtml(formatDateDdMmYyyy(d))}</strong>
            ${active ? `<span class="muted" style="font-size:0.82rem"> · affichée</span>` : ""}
            ${when ? `<span class="muted" style="font-size:0.82rem"> · clôturée ${escapeHtml(when)}</span>` : ""}
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button type="button" class="mini-btn" data-pdj-browse-date="${escapeHtml(d)}">Afficher</button>
            <button type="button" class="mini-btn" data-pdj-print-closure="${escapeHtml(d)}">Imprimer clôture</button>
          </div>
        </li>`;
      }).join("")}
    </ul>
    ${current !== t ? `<button type="button" class="mini-btn" style="margin-top:10px" data-pdj-browse-today>Revenir au jour comptable actuel</button>` : ""}`;
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
  // Marquer le jour comme réouvert manuellement pour bloquer la clôture auto
  _autoClotureManualReopened.add(`${siteId}|${dateStr}`);
  const dayBookToMark = (state.dayBooks || []).find((b) => b.siteId === siteId && b.date === dateStr);
  if (dayBookToMark) {
    dayBookToMark.manualReopenedAt = new Date().toISOString();
  }
  const pdjMapReopen = { ...(state.pdjWorkDateBySite || {}) };
  if (canAnyAdmin()) pdjMapReopen[String(siteId)] = dateStr;
  await persistStatePatch({ stock: state.stock, stockChecks: state.stockChecks, dayBooks: state.dayBooks, pdjWorkDateBySite: pdjMapReopen });
  // Auto-positionner la date de travail sur la date recouverte
  const workDateEl = document.getElementById("pdj-work-date");
  if (workDateEl && canAnyAdmin()) {
    workDateEl.value = dateStr;
    syncPdjWorkDateInput();
  }
  setPdjBrowseDate(dateStr);
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

/**
 * Après une clôture : ouvre automatiquement la journée suivante (fonds = caisse à la fermeture)
 * et bascule la date comptable active — sans formulaire « Ouvrir la journée ».
 * @returns {{ nextDate: string, pdjMap: object } | null}
 */
function autoOpenNextAccountingDayAfterClose(siteId, closedDateStr, closingCashFcfa, { actorLabel = "" } = {}) {
  const sid = String(siteId || "").trim();
  const closed = String(closedDateStr || "").slice(0, 10);
  if (!sid || !/^\d{4}-\d{2}-\d{2}$/.test(closed)) return null;
  const nextDate = addCalendarDaysIso(closed, 1);
  const t = today();
  const tomorrow = addCalendarDaysIso(t, 1);
  // Autoriser l'ouverture du lendemain même si c'est demain (maquis : clôture du service → soirée ou lendemain matin)
  if (nextDate > tomorrow) return null;

  const openingAmount = Math.max(0, Math.round(Number(closingCashFcfa) || 0));
  const ts = new Date().toISOString();
  const snapshot = captureOpeningStockSnapshot();
  const recordedBy = actorLabel || sessionUser || "clôture auto";

  let book = dayBookFor(nextDate, sid);
  if (!book || dayBookNeedsCashOpening(book)) {
    if (!book) {
      book = {
        id: Date.now() + 1,
        siteId: sid,
        date: nextDate,
        openedAt: ts,
        openingStockById: snapshot,
        openingCashFcfa: openingAmount,
        openingCashRecorded: true,
        openingRecordedAt: ts,
        openingRecordedBy: recordedBy,
        autoOpenedFromClose: true,
        autoOpenedFromDate: closed,
      };
    } else {
      book.openingCashFcfa = openingAmount;
      book.openingCashRecorded = true;
      book.openingRecordedAt = ts;
      book.openingRecordedBy = recordedBy;
      book.openingStockById = snapshot;
      book.autoOpenedFromClose = true;
      book.autoOpenedFromDate = closed;
      if (!book.openedAt) book.openedAt = ts;
    }
    state.dayBooks = [book, ...(state.dayBooks || []).filter((b) => !(b.siteId === sid && b.date === nextDate))];
    recordStaffAudit(
      "update",
      "caisse_ouverture",
      `Ouverture auto après clôture ${formatDateDdMmYyyy(closed)}`,
      `Journée ${formatDateDdMmYyyy(nextDate)} · ${fmt(openingAmount)} FCFA (reprise caisse fermeture)`,
    );
  } else if (book) {
    // Journée déjà ouverte avec caisse : rafraîchir uniquement le snapshot stock
    // (reclôture d'une journée passée avec nouveaux comptages physiques)
    book.openingStockById = snapshot;
    book.autoOpenedFromDate = closed;
    state.dayBooks = [book, ...(state.dayBooks || []).filter((b) => !(b.siteId === sid && b.date === nextDate))];
  }

  const pdjMap = { ...(state.pdjWorkDateBySite || {}) };
  if (nextDate === t) delete pdjMap[sid];
  else pdjMap[sid] = nextDate;
  state.pdjWorkDateBySite = pdjMap;

  delete pdjViewDateBySite[sid];
  pdjBrowseConsultationOnly = false;

  return { nextDate, pdjMap };
}

function deleteDayBook(siteId, dateStr) {
  const sid = String(siteId || "").trim();
  const d = String(dateStr || "").slice(0, 10);
  if (!sid || !d) return;
  if (!canGlobalSuperAdmin()) return;
  const ventesJour = recordsForSite(state.ventes).filter((v) => (v.date || "").slice(0, 10) === d);
  if (ventesJour.length > 0) {
    showToast(`Impossible : ${ventesJour.length} vente(s) enregistrée(s) pour cette journée.`);
    return;
  }
  if (stockCheckForSiteDate(d, sid)) {
    showToast("Impossible : cette journée a déjà été clôturée.");
    return;
  }
  state.dayBooks = (state.dayBooks || []).filter((b) => !(b.siteId === sid && b.date === d));
  const pdjMap = { ...(state.pdjWorkDateBySite || {}) };
  if (pdjMap[sid] === d) delete pdjMap[sid];
  state.pdjWorkDateBySite = pdjMap;
  persistStatePatch({ dayBooks: state.dayBooks, pdjWorkDateBySite: pdjMap })
    .then(() => {
      recordStaffAudit("delete", "dayBook", `Suppression ouverture journée ${formatDateDdMmYyyy(d)}`, `Journée ${d} · ${sessionUser}`);
      showToast(`Ouverture du ${formatDateDdMmYyyy(d)} supprimée.`);
      renderCashOpeningPanel();
      updateCloseDayButtonLabel?.();
      updatePdjSubTabHints?.();
    })
    .catch(() => showToast("Erreur lors de la suppression."));
}

let _dayBookAutoOpenPersistTimer = null;

function schedulePersistAutoOpenedDayBooks() {
  clearTimeout(_dayBookAutoOpenPersistTimer);
  _dayBookAutoOpenPersistTimer = setTimeout(() => {
    _dayBookAutoOpenPersistTimer = null;
    persistStatePatch({
      dayBooks: state.dayBooks,
      pdjWorkDateBySite: state.pdjWorkDateBySite,
    }).catch((e) => console.error(e));
  }, 350);
}

/** Date de la veille clôturée (stockCheck), ou null. */
function previousClosedJournalDate(dateStr, siteId = currentSiteId()) {
  const prev = addCalendarDaysIso(dateStr, -1);
  return stockCheckForSiteDate(prev, siteId) ? prev : null;
}

function closingCashFromStockCheck(check) {
  if (!check) return 0;
  const closingCash = Number(check.closingCashFcfa);
  if (Number.isFinite(closingCash)) return Math.max(0, Math.round(closingCash));
  return Math.max(0, Math.round(Number(check.expectedEspecesCash) || 0));
}

/**
 * Ouvre `dateStr` à partir de la clôture de `closedDateStr` (doit être la veille calendaire).
 * @returns {boolean}
 */
function openAccountingDayFromPriorClose(siteId, dateStr, closedDateStr) {
  const sid = String(siteId || "").trim();
  const target = String(dateStr || "").slice(0, 10);
  const closed = String(closedDateStr || "").slice(0, 10);
  if (!sid || !target || !closed) return false;
  if (addCalendarDaysIso(closed, 1) !== target) return false;
  if (stockCheckForSiteDate(target, sid)) return false;
  if (!dayBookNeedsCashOpening(dayBookFor(target, sid))) return true;
  const block = blockingJournalBeforeOpeningNewDate(target, sid);
  if (block && block !== target) return false;
  const prevCheck = stockCheckForSiteDate(closed, sid);
  if (!prevCheck) return false;
  const amount = closingCashFromStockCheck(prevCheck);
  const res = autoOpenNextAccountingDayAfterClose(sid, closed, amount, { actorLabel: "reprise auto" });
  if (res) schedulePersistAutoOpenedDayBooks();
  return Boolean(res);
}

/**
 * Ouvre `dateStr` si la journée précédente est clôturée (reprise du dénombrement de fermeture).
 * @returns {boolean} true si la journée est ouverte (déjà ou venant d'être ouverte)
 */
function ensureAccountingDayOpenedFromPreviousClose(siteId, dateStr) {
  if (!PDJ_REQUIRE_CASH_OPENING || !siteId || !dateStr) return false;
  if (stockCheckForSiteDate(dateStr, siteId)) return false;
  if (!dayBookNeedsCashOpening(dayBookFor(dateStr, siteId))) return true;
  const prevClosed = previousClosedJournalDate(dateStr, siteId);
  if (!prevClosed) return false;
  return openAccountingDayFromPriorClose(siteId, dateStr, prevClosed);
}

/** Stock à l'ouverture enregistré lors de l'ouverture caisse (cliché) — base du théorique pour la journée `dayBook.date`. */
function stockOpeningFromDayBook(item, book) {
  if (!item || !book?.openingStockById) return null;
  const snap = book.openingStockById;
  const id = String(item.id);
  let raw = snap[id];
  if (raw === undefined) raw = snap[item.id];
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function captureOpeningStockSnapshot() {
  const snapshot = {};
  recordsForSite(state.stock).forEach((item) => {
    snapshot[String(item.id)] = stockActuel(item);
  });
  return snapshot;
}

function renderPdjManagerConfirmationBlock() {
  const host = document.getElementById("pdj-manager-confirm-block");
  if (!host) return;
  const siteId = currentSiteId();
  const pending = pendingManagerConfirmationCheck(siteId);
  if (!pending) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  const d = String(pending.date || "").slice(0, 10);
  const label = formatDateDdMmYyyy(d);
  if (canManagePdjAccounting()) {
    host.classList.remove("hidden");
    const sentAtGe = pending.createdAt ? ` à ${new Date(pending.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
    const caJour = fmt(Number(pending.caEncaisse) || 0);
    const nbVentes = Number(pending.nbVentes) || 0;
    const expectedCash = fmt(Number(pending.expectedEspecesCash) || 0);
    host.innerHTML = `
      <div class="inline-card" style="margin-bottom:14px;border-left:3px solid #ff9800;padding:14px 16px">
        <p class="eyebrow" style="margin-bottom:6px">Fin de service — validation requise</p>
        <strong>${escapeHtml(pending.closedBy || "La serveuse")} a terminé son service</strong>
        <p class="muted" style="margin:8px 0 10px;line-height:1.45;font-size:0.88rem">
          La clôture du <strong>${escapeHtml(label)}</strong> a été soumise par <strong>${escapeHtml(pending.closedBy || "la serveuse")}</strong>${sentAtGe}.
        </p>
        <div style="display:flex;gap:20px;flex-wrap:wrap;margin-bottom:12px;font-size:0.88rem">
          <span>CA encaissé : <strong>${escapeHtml(caJour)} FCFA</strong></span>
          <span>Ventes : <strong>${fmt(nbVentes)}</strong></span>
          <span>Caisse théorique : <strong>${escapeHtml(expectedCash)} FCFA</strong></span>
        </div>
        <label for="pdj-manager-closing-cash" style="display:block;font-size:0.85rem;margin-bottom:4px;font-weight:600">Montant espèces dénombrées en caisse (FCFA)</label>
        <input id="pdj-manager-closing-cash" type="number" min="0" step="1" placeholder="Comptage réel avant validation" style="width:100%;max-width:260px;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:1rem;margin-bottom:12px">
        <br>
        <button type="button" class="btn btn-primary" id="pdj-manager-confirm-btn" style="width:auto;min-height:44px">
          Valider la fin de service de ${escapeHtml(pending.closedBy || "la serveuse")}
        </button>
      </div>`;
    document.getElementById("pdj-manager-confirm-btn")?.addEventListener("click", () => {
      confirmDayClosureByManager(d).catch(handleApiError);
    });
    return;
  }
  host.classList.remove("hidden");
  const sentAtSe = pending.createdAt ? ` à ${new Date(pending.createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
  host.innerHTML = `
    <div class="inline-card" style="margin-bottom:14px;border-left:3px solid #1565c0;padding:12px 14px">
      <strong>Fin de service envoyée au gérant</strong>
      <p class="muted" style="margin:8px 0 0;line-height:1.45;font-size:0.88rem">
        Votre fin de service du <strong>${escapeHtml(label)}</strong> a été transmise${sentAtSe} et attend la validation du gérant. Vous serez notifié(e) dès confirmation.
      </p>
    </div>`;
}

async function confirmDayClosureByManager(dateStr) {
  if (!canManagePdjAccounting()) {
    showToast("Réservé au gérant ou à un administrateur.");
    return;
  }
  const siteId = currentSiteId();
  const d = String(dateStr || "").slice(0, 10);
  const check = stockCheckForSiteDate(d, siteId);
  if (!check) {
    showToast("Aucune clôture trouvée pour cette date.");
    return;
  }
  if (stockCheckIsManagerConfirmed(check)) {
    showToast("Cette journée est déjà confirmée.");
    return;
  }
  const cashInput = document.getElementById("pdj-manager-closing-cash");
  const cashRaw = cashInput?.value?.trim() || "";
  if (!cashRaw) {
    showToast("Saisissez le montant espèces dénombrées avant de valider.");
    return;
  }
  const closingCashFcfa = Math.max(0, Number(cashRaw) || 0);
  const expectedCash = Number(check.expectedEspecesCash) || 0;
  const cashEcart = closingCashFcfa - expectedCash;
  const ecartTxt = cashEcart === 0 ? "aucun écart" : `écart ${cashEcart > 0 ? "+" : ""}${fmt(cashEcart)} FCFA`;
  if (!window.confirm(
    `Valider la fin de service du ${formatDateDdMmYyyy(d)} ?\n\nCaisse : théorique ${fmt(expectedCash)} · dénombré ${fmt(closingCashFcfa)} · ${ecartTxt}.\n\nLa journée suivante sera ouverte automatiquement.`,
  )) return;
  const ts = new Date().toISOString();
  check.managerConfirmedAt = ts;
  check.managerConfirmedBy = sessionUser || "";
  check.closingCashFcfa = closingCashFcfa;
  check.cashEcartEspeces = cashEcart;
  const autoOpen = autoOpenNextAccountingDayAfterClose(siteId, d, closingCashFcfa, { actorLabel: sessionUser });
  const pdjMapClose = { ...(state.pdjWorkDateBySite || {}) };
  if (!autoOpen && pdjMapClose[siteId] === d) delete pdjMapClose[siteId];
  pdjMapClose[`_fc_${siteId}`] = { date: d, confirmedBy: sessionUser || "", closedBy: check.closedBy || "", at: ts };
  state.pdjWorkDateBySite = pdjMapClose;
  recordStaffAudit(
    "update",
    "cloture_jour",
    `Confirmation clôture ${formatDateDdMmYyyy(d)}`,
    `Validée par ${sessionUser || "gérant"} · caisse dénombrée ${fmt(closingCashFcfa)} FCFA · écart ${cashEcart > 0 ? "+" : ""}${fmt(cashEcart)} FCFA`,
  );
  await persistStatePatch({
    stockChecks: state.stockChecks,
    dayBooks: state.dayBooks,
    pdjWorkDateBySite: state.pdjWorkDateBySite,
  });
  await refreshStateFromServer();
  renderPointDuJour();
  renderVentesPage();
  showToast(autoOpen?.nextDate
    ? `Journée confirmée. Ouverture du ${formatDateDdMmYyyy(autoOpen.nextDate)}.`
    : "Journée confirmée.");
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
  if (amount === 0 && !window.confirm(
    "Fonds de caisse à 0 FCFA.\n\nConfirmer l'ouverture de journée sans espèces en caisse ?",
  )) {
    return;
  }
  state.dayBooks = state.dayBooks || [];
  const siteId = currentSiteId();
  const dateStr = pdjCalendarDate();
  const blockOpen = blockingJournalBeforeOpeningNewDate(dateStr, siteId);
  if (blockOpen && !canBypassBlockingJournalForCashOpening(dateStr)) {
    const pending = pendingManagerConfirmationCheck(siteId);
    if (pending && String(pending.date || "").slice(0, 10) === blockOpen) {
      showToast(`La gérante doit confirmer la clôture du ${isoDateToDdMmYyyy(blockOpen)} avant d'ouvrir la journée suivante.`);
    } else {
      showToast(`La journée du ${isoDateToDdMmYyyy(blockOpen)} doit être clôturée avant d'ouvrir la suivante.`);
    }
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
  const pdjMapOpen = { ...(state.pdjWorkDateBySite || {}) };
  if (canSuperAdmin()) {
    if (dateStr === today()) delete pdjMapOpen[siteId];
    else pdjMapOpen[siteId] = dateStr;
  } else if (dateStr === today() && (String(currentRole || "").trim() === "manager" || canSiteAdmin())) {
    delete pdjMapOpen[siteId];
  }
  const openCashBtn = document.getElementById("pdj-opening-submit");
  const prevOpenText = openCashBtn ? openCashBtn.textContent : "";
  if (openCashBtn) { openCashBtn.disabled = true; openCashBtn.textContent = "Enregistrement…"; }
  try {
    await persistStatePatch({ dayBooks: state.dayBooks, pdjWorkDateBySite: pdjMapOpen });
    delete pdjOpeningCashDraftBySiteDate[pdjOpeningCashDraftKey(siteId, dateStr)];
    pdjSubTab = "synthese";
    renderPointDuJour();
    setPdjSubTab("synthese");
    showToast("Ouverture de caisse enregistrée. Consultez la synthèse ou clôturez en fin de journée.");
  } finally {
    if (openCashBtn) { openCashBtn.disabled = false; openCashBtn.textContent = prevOpenText; }
  }
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
    container.removeAttribute("data-pdj-opening-fp");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");
  const dStr = pdjCalendarDate();
  const siteId = currentSiteId();
  const ventesForDate = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const closed = stockCheckForSiteDate(dStr, siteId);
  let book = dayBookFor(dStr, siteId);
  let needs = dayBookNeedsCashOpening(book);
  if (!closed && needs) {
    const autoOpened = ensureAccountingDayOpenedFromPreviousClose(siteId, dStr);
    book = dayBookFor(dStr, siteId);
    needs = dayBookNeedsCashOpening(book);
    if (autoOpened && !needs) {
      requestAnimationFrame(() => {
        renderDailyStockCheck();
        updateCloseDayButtonLabel();
        updatePdjSubTabHints();
      });
    }
  }
  if (lockBlock) {
    lockBlock.classList.toggle("pdj-main--locked", needs && canManagePdjAccounting());
  }
  renderPdjManagerConfirmationBlock();
  if (closed) {
    const nextD = addCalendarDaysIso(dStr, 1);
    const nextBook = dayBookFor(nextD, siteId);
    const confirmed = stockCheckIsManagerConfirmed(closed);
    const nextReady = confirmed && nextBook && !dayBookNeedsCashOpening(nextBook) && !stockCheckForSiteDate(nextD, siteId);
    container.removeAttribute("data-pdj-opening-fp");
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done" style="border-left:3px solid #1565c0;background:#f4f8ff">
        <p class="eyebrow" style="margin-bottom:4px">Journée clôturée</p>
        <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>
        ${!confirmed
    ? `<p class="muted" style="margin-top:8px;line-height:1.45">
          Clôture enregistrée par <strong>${escapeHtml(closed.closedBy || "l'équipe")}</strong>.
          La <strong>gérante</strong> doit confirmer cette journée avant l'ouverture de la suivante.
        </p>`
    : nextReady
      ? `<p class="muted" style="margin-top:8px;line-height:1.45">
          La journée suivante (<strong>${escapeHtml(formatDateDdMmYyyy(nextD))}</strong>) est ouverte
          avec <strong>${fmt(nextBook.openingCashFcfa)} FCFA</strong> en caisse (reprise du dénombrement de fermeture).
        </p>`
      : `<p class="muted" style="margin-top:8px;line-height:1.45">
          Les ventes pour cette date sont bloquées. Ouvrez la journée suivante depuis cette page (gérant).
        </p>`}
        <p class="muted" style="margin-top:8px;font-size:0.82rem;line-height:1.45">
          Une réouverture de journée nécessite un profil gérant ou administrateur et sera journalisée.
        </p>
      </div>`;
    return;
  }
  if (!canManagePdjAccounting() && needs) {
    container.removeAttribute("data-pdj-opening-fp");
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
    const canDeleteBook = canGlobalSuperAdmin() && ventesForDate.length === 0 && !closed;
    container.removeAttribute("data-pdj-opening-fp");
    container.innerHTML = `
      <div class="pdj-opening-card pdj-opening-card--done">
        <p class="eyebrow" style="margin-bottom:4px">Journée ouverte</p>
        <strong>Fonds en caisse : ${fmt(book.openingCashFcfa)} FCFA</strong>
        <p class="muted" style="margin-top:8px;font-size:0.88rem;line-height:1.45">
          Les ventes sont autorisées pour cette date jusqu'à la <strong>clôture</strong> (vérification stock et caisse ci‑dessous).
          Enregistré ${escapeHtml(formatDateTimeDdMmYyyy(book.openingRecordedAt || book.openedAt))}
          ${book.openingRecordedBy ? ` · ${escapeHtml(book.openingRecordedBy)}` : ""}${book.autoOpenedFromClose ? ` · Ouverture auto après clôture du ${escapeHtml(formatDateDdMmYyyy(book.autoOpenedFromDate || ""))}` : ""}
        </p>
        ${canDeleteBook ? `<button type="button" id="pdj-delete-daybook-btn" class="btn btn-outline" style="margin-top:12px;border-color:#d32f2f;color:#d32f2f;width:auto;min-height:40px;font-size:0.88rem">
          Supprimer cette ouverture de journée
        </button>` : ""}
      </div>`;
    if (canDeleteBook) {
      document.getElementById("pdj-delete-daybook-btn")?.addEventListener("click", () => {
        if (!confirm(`Supprimer l'ouverture de la journée du ${formatDateDdMmYyyy(dStr)} ?\nAucune vente n'est enregistrée pour cette date. Cette action est irréversible.`)) return;
        deleteDayBook(siteId, dStr);
      });
    }
    return;
  }
  const prevWasClosed = previousClosedJournalDate(dStr, siteId);
  if (needs && prevWasClosed) {
    const block = blockingJournalBeforeOpeningNewDate(dStr, siteId);
    if (block && block !== dStr) {
      container.removeAttribute("data-pdj-opening-fp");
      container.innerHTML = `<div class="pdj-opening-card" style="border-left:3px solid #ff8e82;background:#fff8f7">
          <p class="eyebrow" style="margin-bottom:4px">Ouverture automatique</p>
          <strong>Clôturez d'abord le ${escapeHtml(formatDateDdMmYyyy(block))}</strong>
          <p class="muted" style="margin-top:8px;line-height:1.45">
            La journée du ${escapeHtml(formatDateDdMmYyyy(dStr))} reprendra le fonds de caisse de la veille dès que les journées précédentes seront clôturées.
          </p>
        </div>`;
      return;
    }
    if (openAccountingDayFromPriorClose(siteId, dStr, prevWasClosed)) {
      renderCashOpeningPanel();
      return;
    }
    const prevCheck = stockCheckForSiteDate(prevWasClosed, siteId);
    const reopenAmount = closingCashFromStockCheck(prevCheck);
    container.removeAttribute("data-pdj-opening-fp");
    container.innerHTML = `<div class="pdj-opening-card pdj-opening-card--done" style="border-left:3px solid #1565c0;background:#f4f8ff">
        <p class="eyebrow" style="margin-bottom:4px">Ouverture automatique</p>
        <strong>Journée du ${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>
        <p class="muted" style="margin-top:8px;line-height:1.45">
          Reprise du dénombrement de fermeture du <strong>${escapeHtml(formatDateDdMmYyyy(prevWasClosed))}</strong>
          (<strong>${fmt(reopenAmount)} FCFA</strong> en caisse). Aucune saisie manuelle.
        </p>
        <button type="button" class="btn btn-primary" id="pdj-opening-auto-retry" style="width:auto;min-height:44px;margin-top:10px">
          Ouvrir automatiquement
        </button>
      </div>`;
    document.getElementById("pdj-opening-auto-retry")?.addEventListener("click", () => {
      if (openAccountingDayFromPriorClose(siteId, dStr, prevWasClosed)) {
        renderCashOpeningPanel();
        renderDailyStockCheck();
        updateCloseDayButtonLabel();
        updatePdjSubTabHints();
        showToast(`Journée du ${formatDateDdMmYyyy(dStr)} ouverte (${fmt(reopenAmount)} FCFA en caisse).`);
      } else {
        showToast("Ouverture automatique impossible. Vérifiez que la veille est bien clôturée.");
      }
    }, { once: true });
    return;
  }
  const blockBeforeManual = blockingJournalBeforeOpeningNewDate(dStr, siteId);
  if (needs && blockBeforeManual && blockBeforeManual !== dStr) {
    container.removeAttribute("data-pdj-opening-fp");
    container.innerHTML = `<div class="pdj-opening-card" style="border-left:3px solid #ff8e82;background:#fff8f7">
        <p class="eyebrow" style="margin-bottom:4px">Journées en attente</p>
        <strong>Clôturez d'abord le ${escapeHtml(formatDateDdMmYyyy(blockBeforeManual))}</strong>
        <p class="muted" style="margin-top:8px;line-height:1.45">
          Une journée plus ancienne n'est pas encore clôturée. Terminez-la avant d'ouvrir le ${escapeHtml(formatDateDdMmYyyy(dStr))}.
        </p>
      </div>`;
    return;
  }
  const draftKey = pdjOpeningCashDraftKey(siteId, dStr);
  const formFp = `open|${siteId}|${dStr}|n${ventesForDate.length}`;
  const prevOpening = container.querySelector("#pdj-opening-cash");
  const hadOpeningFocus = document.activeElement?.id === "pdj-opening-cash";
  if (prevOpening) pdjOpeningCashDraftBySiteDate[draftKey] = prevOpening.value;
  if (prevOpening && container.getAttribute("data-pdj-opening-fp") === formFp) {
    return;
  }
  const openingDraft = pdjOpeningCashDraftBySiteDate[draftKey] ?? "";
  container.innerHTML = `
    <div class="pdj-opening-card">
      <p class="eyebrow" style="margin-bottom:4px">Ouvrir la journée</p>
      <strong>Ouverture de caisse</strong>
      <p class="muted" style="margin-top:8px">
        Avant le point du jour, saisissez le montant réellement présent en caisse (fonds de caisse).
        Un cliché du stock à cet instant sert de référence pour la fermeture.
      </p>
      ${ventesForDate.length ? `<p class="muted" style="margin-top:10px;font-size:0.82rem;line-height:1.45">
        Vous voyez déjà <strong>${formatVentesCountFr(ventesForDate.length)}</strong> pour le <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong> dans le récapitulatif : ce sont des enregistrements existants.
        L'ouverture de caisse officialise tout de même la journée et autorise à ajouter de nouvelles ventes jusqu'à la clôture.
      </p>` : ""}
      <div class="pdj-opening-form">
        <div class="form-group">
          <label for="pdj-opening-cash">Montant en caisse à l'ouverture (FCFA)</label>
          <input id="pdj-opening-cash" class="input-fcfa" type="text" inputmode="numeric" placeholder="ex: 50 000" value="${escapeHtml(openingDraft)}">
        </div>
        <button type="button" class="btn btn-primary" id="pdj-opening-submit" style="width:auto;min-height:44px">Ouvrir la journée</button>
      </div>
    </div>`;
  container.setAttribute("data-pdj-opening-fp", formFp);
  if (hadOpeningFocus) {
    const neu = document.getElementById("pdj-opening-cash");
    if (neu) {
      neu.focus();
      const L = neu.value.length;
      try {
        neu.setSelectionRange(L, L);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

const PRODUCT_RANK_TOP_N = 5;
const PRODUCT_RANK_BOTTOM_N = 5;

/** Agrège les lignes de vente par article (quantité en bouteilles + CA net + stock actuel). */
function aggregateVentesByArticle(ventes) {
  const byArticle = {};
  (ventes || []).forEach((v) => {
    const stockItem = recordsForSite(state.stock).find((s) => s.article === v.article);
    const packSize = Math.max(1, Number(v.formatQuantite) || Number(v.packSize) || Number(stockItem?.packSize) || 1);
    const key = v.article;
    if (!byArticle[key]) {
      byArticle[key] = {
        article: v.article,
        cat: v.cat || "",
        bouteilles: 0,
        ca: 0,
        stockBtl: stockItem != null ? stockActuel(stockItem) : null,
        seuilMin: Number(stockItem?.seuilMin) || 0,
      };
    }
    byArticle[key].bouteilles += (Number(v.qty) || 0) * packSize;
    byArticle[key].ca += calcNet(v);
  });
  return Object.values(byArticle);
}

/** Catalogue du maquis + ventes de la periode → vendues / non vendues. */
function splitBoissonsVenduesNonVendues(ventesList) {
  const sold = aggregateVentesByArticle(ventesList).sort((a, b) => b.ca - a.ca || a.article.localeCompare(b.article, "fr"));
  const soldNames = new Set(sold.map((r) => r.article));
  const unsold = recordsForSite(state.stock)
    .filter((item) => item?.article && !soldNames.has(item.article))
    .map((item) => ({
      article: item.article,
      cat: item.cat || item.categorie || "",
      stockBtl: stockActuel(item),
    }))
    .sort((a, b) => a.article.localeCompare(b.article, "fr"));
  return { sold, unsold };
}

function htmlBoissonsNonVenduesSection(unsold, { periodLabel = "" } = {}) {
  if (!unsold.length) return "";
  const periodHint = periodLabel ? ` (${escapeHtml(periodLabel)})` : "";
  return `
    <p class="muted" style="margin:20px 0 10px;font-size:0.82rem;line-height:1.45">
      <strong style="color:#c62828">Non vendues</strong> sur la periode${periodHint}
      — <strong>${unsold.length}</strong> article(s) du catalogue sans vente enregistree.
    </p>
    <div class="stock-table-wrap">
      <table class="stock-table" style="min-width:520px">
        <thead>
          <tr>
            <th>Article</th>
            <th>Catégorie</th>
            <th style="text-align:right">Stock actuel (btl)</th>
          </tr>
        </thead>
        <tbody>
          ${unsold.map((r) => `<tr>
            <td>${escapeHtml(r.article)}</td>
            <td>${escapeHtml(r.cat)}</td>
            <td style="text-align:right;color:#c62828">${fmt(r.stockBtl)}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
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

function renderSalesByProduct(ventesList, { periodLabel = "" } = {}) {
  const container = document.getElementById("pdj-sales-by-product");
  const countNode = document.getElementById("pdj-sales-count");
  if (!container) return;
  const { sold, unsold } = splitBoissonsVenduesNonVendues(ventesList);
  const totalBtl = sold.reduce((sum, r) => sum + r.bouteilles, 0);
  const totalCa = sold.reduce((sum, r) => sum + r.ca, 0);
  const countParts = [];
  if (sold.length) countParts.push(`${sold.length} vendu(s)`);
  if (unsold.length) countParts.push(`${unsold.length} non vendu(s)`);
  if (countNode) {
    const base = countParts.length ? countParts.join(" · ") : "0 article";
    countNode.textContent = periodLabel ? `${base} · ${periodLabel}` : base;
  }
  if (!sold.length && !unsold.length) {
    container.innerHTML = emptyState("Catalogue vide", "Ajoutez des articles au stock pour suivre les ventes.");
    return;
  }
  const unsoldHtml = htmlBoissonsNonVenduesSection(unsold, { periodLabel });
  if (!sold.length) {
    container.innerHTML = `
      <p class="muted" style="margin:0 0 12px;font-size:0.88rem;line-height:1.45">
        Aucune vente enregistree${periodLabel ? ` sur la periode <strong>${escapeHtml(periodLabel)}</strong>` : ""}.
      </p>
      ${unsoldHtml}`;
    return;
  }
  const { top, bottom, showFlop } = topBottomByBottles(sold, { hideFlopWhenSmall: true });
  const rankHint = periodLabel ? `sur la periode (${periodLabel})` : "ce jour";
  const rankHtml = htmlProductRankLists(top, bottom, showFlop, { flopHint: rankHint });
  container.innerHTML = `
    ${rankHtml}
    <p class="muted" style="margin:16px 0 10px;font-size:0.82rem">Vendues — detail par article (tri CA net)</p>
    <div class="stock-table-wrap">
      <table class="stock-table" style="min-width:700px">
        <thead>
          <tr>
            <th>Article</th>
            <th>Catégorie</th>
            <th style="text-align:right">Qté vendue (btl)</th>
            <th style="text-align:right">Stock restant</th>
            <th style="text-align:right">CA net</th>
          </tr>
        </thead>
        <tbody>
          ${sold.map((r) => {
            const stockColor = r.stockBtl === null ? "#9e9e9e"
              : r.stockBtl <= 0 ? "#c62828"
              : r.stockBtl <= r.seuilMin ? "#e65100"
              : "#388e3c";
            const stockLabel = r.stockBtl === null ? "—" : `${fmt(r.stockBtl)} btl`;
            return `<tr>
              <td>${escapeHtml(r.article)}</td>
              <td>${escapeHtml(r.cat)}</td>
              <td style="text-align:right;color:#1976d2">${fmt(r.bouteilles)}</td>
              <td style="text-align:right;font-weight:600;color:${stockColor}">${stockLabel}</td>
              <td style="text-align:right"><strong>${fmt(r.ca)} FCFA</strong></td>
            </tr>`;
          }).join("")}
          <tr style="font-weight:700;background:#f5f5f5">
            <td colspan="2">TOTAL vendu</td>
            <td style="text-align:right;color:#1976d2">${fmt(totalBtl)}</td>
            <td></td>
            <td style="text-align:right">${fmt(totalCa)} FCFA</td>
          </tr>
        </tbody>
      </table>
    </div>
    ${unsoldHtml}`;
}

function printBoissonsVenduesPeriod() {
  const { start, end } = pdjBoissonsPeriod();
  const periodLabel = formatPeriodLabel(start, end);
  const ventesList = ventesForDateRange(start, end);
  const { sold, unsold } = splitBoissonsVenduesNonVendues(ventesList);
  if (!sold.length && !unsold.length) {
    showToast("Catalogue vide : aucun article a lister.");
    return;
  }
  const site = currentSite();
  const totalBtl = sold.reduce((sum, r) => sum + r.bouteilles, 0);
  const totalCa = sold.reduce((sum, r) => sum + r.ca, 0);
  const { top, bottom, showFlop } = topBottomByBottles(sold, { hideFlopWhenSmall: true });
  const topRows = top.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.article)}</td><td style="text-align:right">${fmt(r.bouteilles)}</td><td style="text-align:right">${fmt(r.ca)} FCFA</td></tr>`).join("");
  const flopRows = showFlop
    ? bottom.map((r, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(r.article)}</td><td style="text-align:right">${fmt(r.bouteilles)}</td><td style="text-align:right">${fmt(r.ca)} FCFA</td></tr>`).join("")
    : "";
  const detailRows = sold.map((r) => `<tr>
    <td>${escapeHtml(r.article)}</td>
    <td>${escapeHtml(r.cat)}</td>
    <td style="text-align:right">${fmt(r.bouteilles)}</td>
    <td style="text-align:right">${fmt(r.ca)} FCFA</td>
  </tr>`).join("");
  const unsoldRows = unsold.map((r) => `<tr>
    <td>${escapeHtml(r.article)}</td>
    <td>${escapeHtml(r.cat)}</td>
    <td style="text-align:right;color:#c62828">${fmt(r.stockBtl)}</td>
  </tr>`).join("");
  const rankColsHtml = sold.length
    ? '<div class="cols"><div><h3 style="font-size:12px;color:#1565c0">Plus vendues (qté)</h3><table><thead><tr><th>#</th><th>Article</th><th>Qté</th><th>CA</th></tr></thead><tbody>'
      + topRows
      + '</tbody></table></div>'
      + (showFlop
        ? '<div><h3 style="font-size:12px;color:#c62828">Moins vendues (qté)</h3><table><thead><tr><th>#</th><th>Article</th><th>Qté</th><th>CA</th></tr></thead><tbody>'
          + flopRows
          + '</tbody></table></div>'
        : '')
      + '</div>'
    : '';
  const soldBlock = sold.length ? `
  <div class="summary">
    <div class="box">Articles vendus<strong>${fmt(sold.length)}</strong></div>
    <div class="box">Quantite vendue (btl)<strong>${fmt(totalBtl)}</strong></div>
    <div class="box">CA net vendu<strong>${fmt(totalCa)} FCFA</strong></div>
    <div class="box">Non vendues<strong>${fmt(unsold.length)}</strong></div>
  </div>
  ${rankColsHtml}
  <h3 style="font-size:13px;margin-top:8px">Vendues — detail par article (tri CA net)</h3>
  <table>
    <thead><tr><th>Article</th><th>Categorie</th><th>Qté (btl)</th><th>CA net</th></tr></thead>
    <tbody>${detailRows}
      <tr style="font-weight:700;background:#f0f0f0"><td colspan="2">TOTAL vendu</td><td style="text-align:right">${fmt(totalBtl)}</td><td style="text-align:right">${fmt(totalCa)} FCFA</td></tr>
    </tbody>
  </table>` : `
  <div class="summary">
    <div class="box">Articles vendus<strong>0</strong></div>
    <div class="box">Non vendues<strong>${fmt(unsold.length)}</strong></div>
  </div>
  <p class="meta" style="margin:12px 0">Aucune vente enregistree sur cette periode.</p>`;
  const unsoldBlock = unsold.length ? `
  <h3 style="font-size:13px;margin-top:16px;color:#c62828">Non vendues sur la periode (${unsold.length})</h3>
  <p class="meta" style="margin:0 0 8px">Articles du catalogue sans vente — stock actuel en bouteilles.</p>
  <table>
    <thead><tr><th>Article</th><th>Categorie</th><th>Stock actuel (btl)</th></tr></thead>
    <tbody>${unsoldRows}</tbody>
  </table>` : "";
  const w = window.open("", "_blank", "width=900,height=900");
  if (!w) {
    showToast("Impossible d'ouvrir l'apercu du rapport.");
    return;
  }
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Point boissons ${escapeHtml(periodLabel)}</title>
  <style>
    body{font-family:Arial,sans-serif;color:#111;padding:24px;font-size:12px}
    h1,h2,h3{margin:0 0 8px}
    .meta{color:#555;font-size:11px;line-height:1.45}
    .summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:14px 0}
    .box{border:1px solid #111;padding:10px 12px}
    .box strong{display:block;font-size:16px;margin-top:4px}
    table{width:100%;border-collapse:collapse;margin:12px 0 18px;font-size:11px}
    th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}
    th{background:#eee}
    td:nth-child(n+3){text-align:right}
    .cols{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    ${PDJ_PREVIEW_PRINT_CSS}
    @media print{body{padding:12px}}
  </style></head><body>
  ${pdjPreviewPrintToolbarHtml()}
  <header style="display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #111;padding-bottom:12px;margin-bottom:8px">
    <div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p class="meta">${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p></div>
    <div><h2>Point boissons</h2><p class="meta">Periode : ${escapeHtml(periodLabel)}<br>Imprime le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div>
  </header>
  ${soldBlock}
  ${unsoldBlock}
  </body></html>`);
  w.document.close();
}

function stockCheckForSiteDate(dateStr, siteId = currentSiteId()) {
  if (!dateStr || !siteId) return null;
  return (state.stockChecks || []).find((item) => item.siteId === siteId && item.date === dateStr) || null;
}

function deduplicateStockChecks(arr) {
  if (!Array.isArray(arr) || arr.length <= 1) return arr;
  const seen = new Map();
  for (const sc of arr) {
    if (!sc?.siteId || !sc?.date) continue;
    const k = `${sc.siteId}|${sc.date}`;
    const existing = seen.get(k);
    if (!existing || (sc.createdAt || "") >= (existing.createdAt || "")) seen.set(k, sc);
  }
  return [...seen.values()];
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
  const pending = pendingManagerConfirmationCheck(siteId);
  if (pending) {
    const closed = String(pending.date || "").slice(0, 10);
    const nextAfter = addCalendarDaysIso(closed, 1);
    if (dateStr >= nextAfter) return closed;
  }
  const u = firstUnclosedJournalDate(siteId);
  if (!u) return null;
  if (u === dateStr && dayBookNeedsCashOpening(dayBookFor(dateStr, siteId))) return null;
  if (u !== dateStr) return u;
  return null;
}

/** Contournement de la chaîne des journées non clôturées : superadmin (toute date) ; gérant / admin (site) uniquement pour aujourd'hui ou la date de travail (maquis de nuit). */
function canBypassBlockingJournalForCashOpening(dateStr) {
  if (canSuperAdmin()) return true;
  const r = String(currentRole || "").trim();
  if (r !== "manager" && r !== "admin") return false;
  const t = today();
  const w = workingDate();
  return dateStr === t || dateStr === w;
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

/** Journée ouverte + pas de jour de repos planifié (serveuse). */
function assertCanSellOrToast(saleDateStr, siteId = currentSiteId()) {
  if (!assertJournalAllowsSalesOrToast(saleDateStr, siteId)) return false;
  const rest = serveusePlanningBlocksSale(saleDateStr, siteId);
  if (rest) {
    showToast(rest);
    return false;
  }
  return true;
}

function journalEncaisseDisabledForOrder(order) {
  if (!order) return false;
  const d = String(order.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return true;
  const sid = order.siteId || currentSiteId();
  if (serveusePlanningBlocksSale(d, sid)) return true;
  if (!PDJ_REQUIRE_CASH_OPENING) return false;
  return !journalAllowsSalesForDate(d, sid).ok;
}

function journalEncaisseBlockTitle(order) {
  if (!order) return "";
  const d = String(order.date || "").slice(0, 10);
  const sid = order.siteId || currentSiteId();
  const rest = serveusePlanningBlocksSale(d, sid);
  if (rest) return rest;
  const j = journalAllowsSalesForDate(d, sid);
  return j.ok ? "" : j.message;
}

function todaySortiesBottlesForArticle(article, saleDateStr = pdjCalendarDate()) {
  const stockItem = recordsForSite(state.stock).find((s) => s.article === article);
  return recordsForSite(state.ventes)
    .filter((v) => v.date.slice(0, 10) === saleDateStr && v.article === article)
    .reduce((sum, v) => sum + lineBottleQty(v, stockItem), 0);
}

function todayLossesForArticle(article, dateStr, openedAt) {
  const articleLow = String(article || "").toLowerCase();
  return (state.stockLosses || [])
    .filter((l) => {
      if (String(l.siteId || "") !== String(currentSiteId())) return false;
      if (String(l.article || "").toLowerCase() !== articleLow) return false;
      if ((l.date || "").slice(0, 10) === dateStr) return true;
      if (openedAt && l.createdAt && l.createdAt >= openedAt) return true;
      return false;
    })
    .reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
}

function todayEntreesFromPOForArticle(article, dateStr, openedAt) {
  return purchaseOrdersForSite()
    .filter((po) => {
      if (po.status !== "Reçue") return false;
      const effectiveDate = (po.receivedAt || po.date || "").slice(0, 10);
      if (effectiveDate === dateStr) return true;
      // Journée comptable multi-jour : inclure POs reçus après l'ouverture de caisse
      if (openedAt && po.receivedAt && po.receivedAt >= openedAt) return true;
      return false;
    })
    .reduce((sum, po) =>
      sum + (po.lines || [])
        .filter((l) => String(l.article || "").toLowerCase() === String(article || "").toLowerCase())
        .reduce((s, l) => s + Math.round((Number(l.cases) || 0) * (Number(l.caseSize) || 0)), 0), 0);
}

/** Résumé lecture seule d'une fiche de clôture (serveuse ou gérant hors correction administrateur). */
function htmlPdjClosedStockCheckReadOnly(closed, roleNoteHtml) {
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
          ${typeof closed.especesChargesJour === "number" && closed.especesChargesJour > 0
    ? `<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px"><span class="muted">Dépenses jour (espèces, info)</span><strong>${fmt(closed.especesChargesJour)} FCFA</strong></div>
          <p class="muted" style="margin:0;font-size:0.8rem;line-height:1.35">Non déduites du théorique (souvent réglées hors caisse de la journée).</p>`
    : ""}
          ${typeof closed.cashEcartEspeces === "number"
      ? `<div style="display:flex;justify-content:space-between;color:${closed.cashEcartEspeces === 0 ? "#72d7a9" : "#ff8e82"}"><span>Écart espèces</span><strong>${closed.cashEcartEspeces === 0 ? "OK" : `${closed.cashEcartEspeces > 0 ? "+" : ""}${fmt(closed.cashEcartEspeces)} FCFA`}</strong></div>`
      : ""}
        </div>`
    : "";
  return `
      ${cashBlock}
      <p class="muted" style="margin-bottom:10px;font-size:0.88rem">${roleNoteHtml}</p>
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
}

function renderDailyStockCheck() {
  try {
  const items = recordsForSite(state.stock).slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const dStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  let dayBook = dayBookFor(dStr, currentSiteId());
  if (!closed && dayBookNeedsCashOpening(dayBook)) {
    ensureAccountingDayOpenedFromPreviousClose(currentSiteId(), dStr);
    dayBook = dayBookFor(dStr, currentSiteId());
  }
  const pendingForClose = pendingOrdersForJournalDate(dStr, currentSiteId());
  const closeBlockedByPending = pendingForClose.length > 0;
  const blockedNoSales = pdjClosureBlockedNoSales(dStr);
  const noSalesBanner = pdjNoSalesForDate(dStr) ? pdjNoSalesClosureBannerHtml(dStr) : "";
  const container = document.getElementById("pdj-stock-check");
  const button = document.getElementById("close-day-btn");
  if (!container || !button) return;
  // Gérant (non-admin) sur site avec créneaux : clôture uniquement via fin de service serveuse
  if (canManagePdjAccounting() && !canAnyAdmin() && staffRequiresShiftWindowForSales() && !closed) {
    const pendingServ = pendingManagerConfirmationCheck(currentSiteId());
    const hasPendingForDate = pendingServ && String(pendingServ.date || "").slice(0, 10) === dStr;
    if (hasPendingForDate) {
      // Serveuse a soumis → masquer clôture directe, laisser le bloc de confirmation gérer
      container.innerHTML = "";
      button.disabled = true;
      button.className = "btn btn-secondary";
      button.textContent = "Fin de service en attente de validation";
      return;
    }
    // Serveuse n'a pas encore soumis → gérant doit attendre
    container.innerHTML = `<p class="muted" style="font-size:0.88rem;line-height:1.45">
      En attente de la fin de service de la serveuse. La clôture sera disponible dès réception.
    </p>`;
    button.disabled = true;
    button.className = "btn btn-secondary";
    button.textContent = "En attente de la serveuse";
    return;
  }
  if (!canClosePdjDay()) {
    container.innerHTML = staffRequiresShiftWindowForSales()
      ? `<p class="muted" style="font-size:0.88rem;line-height:1.45">La clôture est disponible pendant votre créneau de service (Planning → Mes horaires).</p>`
      : "";
    button.disabled = true;
    return;
  }
  const consultationOnly = isPdjBrowseConsultationOnly() && Boolean(closed);
  const superadminCorrection = Boolean(closed && canAnyAdmin() && !consultationOnly);
  const openingBlocked = PDJ_REQUIRE_CASH_OPENING && dayBookNeedsCashOpening(dayBook);
  const isPastDate = dStr !== today();
  const pendingBanner = closeBlockedByPending
    ? `<div class="inline-card" style="margin-bottom:12px;border-left:3px solid #ff8e82">
        <strong>Clôture impossible</strong>
        <p class="muted" style="margin-top:6px;font-size:0.86rem;line-height:1.45">
          ${pendingForClose.length} commande(s) au statut <strong>En attente</strong> pour le <strong>${escapeHtml(formatDateDdMmYyyy(dStr))}</strong>.
          Depuis <strong>Ventes</strong>, ouvrez chaque commande et passez-la en <strong>Servi</strong> (ou annulez-la) avant de clôturer la journée.
        </p>
      </div>`
    : "";
  button.textContent = superadminCorrection
    ? "Mettre à jour la clôture"
    : consultationOnly || (closed && canManagePdjAccounting() && !canAnyAdmin())
      ? "Journée clôturée"
      : closed
        ? "Revérifier la journée"
        : openingBlocked && !(isPastDate && canAnyAdmin()) && canManagePdjAccounting()
          ? "Ouverture requise"
          : "Clôturer la journée";
  if (consultationOnly) {
    button.disabled = true;
    button.title = "Journée clôturée — consultation seule";
    container.innerHTML = htmlPdjClosedStockCheckReadOnly(
      closed,
      "Consultation seule — cette journée est déjà clôturée. Utilisez « Imprimer clôture » ou revenez au jour comptable actuel pour travailler sur une autre date.",
    );
    return;
  }
  if (!items.length) {
    container.innerHTML = `${noSalesBanner}${emptyState("Aucun stock", "Ajoutez des articles avant de faire le point de fermeture.")}`;
    pdjApplyCloseDayButtonGate(button, {
      disabled: closeBlockedByPending,
      title: closeBlockedByPending
        ? `${pendingForClose.length} commande(s) en attente — traitez-les depuis Ventes avant clôture.`
        : null,
    });
    return;
  }

  if (!closed && openingBlocked && !(isPastDate && canAnyAdmin()) && canManagePdjAccounting()) {
    container.innerHTML = `${noSalesBanner}${emptyState(
      "Ouverture de caisse requise",
      "Validez le montant en caisse en haut de cette page avant la vérification stock et la clôture.",
    )}`;
    pdjApplyCloseDayButtonGate(button, { disabled: true });
    return;
  }
  pdjApplyCloseDayButtonGate(button, {
    disabled: closeBlockedByPending,
    title: closeBlockedByPending
      ? `${pendingForClose.length} commande(s) en attente — traitez-les depuis Ventes avant clôture.`
      : null,
  });

  if (!canManagePdjAccounting()) {
    // Serveuse en service : bouton actif pour soumettre la fin de service
    button.disabled = !canClosePdjDay();
    if (openingBlocked) {
      container.innerHTML = emptyState(
        "Ouverture de caisse (gérant)",
        "En attente de l'ouverture par un gérant ou un administrateur. Les serveuses peuvent consulter le reste du point du jour.",
      );
      return;
    }
    if (closed) {
      container.innerHTML = htmlPdjClosedStockCheckReadOnly(
        closed,
        "Lecture seule — vérification et clôture réservées au gérant ou à un administrateur.",
      );
      return;
    }
    const ventesJourRo = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
    const rowsOpen = items.map((item) => {
      const stockAtOpen = stockOpeningFromDayBook(item, dayBook) ?? stockActuel(item);
      const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
      const frigoVal = stockFrigo(item);
      const reserveVal = stockReserve(item);
      const remaining = frigoVal + reserveVal;
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
      ${noSalesBanner}${pendingBanner}
      <p class="muted" style="margin-bottom:10px;font-size:0.88rem">
        Vérification en lecture seule — le gérant confirmera le stock et la caisse. Cliquez sur <strong>Fin de service</strong> pour transmettre votre clôture.
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
    return;
  }

  if (closed && !canAnyAdmin()) {
    container.innerHTML = htmlPdjClosedStockCheckReadOnly(
      closed,
      "La journée est clôturée (lecture seule). Un administrateur peut corriger la fiche si nécessaire.",
    );
    button.disabled = true;
    button.removeAttribute("title");
    return;
  }

  const seedFromClose = closed && canAnyAdmin() ? closed : null;
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totauxJourOpen = paymentTotals(ventesJour);
  const especesVentes = Number(totauxJourOpen["Espèces"]) || Number(totauxJourOpen["EspÃ¨ces"]) || 0;
  const especesRecouvrement = especesFromCreditRecoveriesForDate(dStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces")
    || normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("EspÃ¨ces")
      ? sum + (Number(c.montant) || 0)
      : sum
  ), 0);
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  /** Théorique caisse = ouverture + ventes espèces + recouvrements crédit en espèces (charges non déduites). */
  const expectedEspeces = openingCash + especesVentes + especesRecouvrement;
  const closingSeed = seedFromClose && typeof seedFromClose.closingCashFcfa === "number"
    ? Math.round(Number(seedFromClose.closingCashFcfa))
    : null;
  const closingDraftKey = pdjOpeningCashDraftKey(currentSiteId(), dStr);
  const prevClosingEl = document.getElementById("pdj-closing-cash");
  if (prevClosingEl) pdjClosingCashDraftBySiteDate[closingDraftKey] = prevClosingEl.value;
  const domFrigo = new Map();
  const domReserve = new Map();
  const prevStockBox = document.getElementById("pdj-stock-check");
  if (prevStockBox) {
    prevStockBox.querySelectorAll("[data-check-frigo]").forEach((el) => {
      const raw = el.getAttribute("data-check-frigo");
      if (raw != null && raw !== "") domFrigo.set(Number(raw), el.value);
    });
    prevStockBox.querySelectorAll("[data-check-reserve]").forEach((el) => {
      const raw = el.getAttribute("data-check-reserve");
      if (raw != null && raw !== "") domReserve.set(Number(raw), el.value);
    });
  }
  let closingValForInput = "";
  if (prevClosingEl) closingValForInput = prevClosingEl.value;
  else if (Object.prototype.hasOwnProperty.call(pdjClosingCashDraftBySiteDate, closingDraftKey)) {
    closingValForInput = pdjClosingCashDraftBySiteDate[closingDraftKey];
  } else if (closingSeed != null) closingValForInput = String(closingSeed);
  const rows = items.map((item) => {
    const closedCheckItem = closed ? (closed.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const stockAtOpen = stockOpeningFromDayBook(item, dayBook)
      ?? closedCheckItem?.stockAvant
      ?? stockActuel(item);
    const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
    const seedCi = seedFromClose ? (seedFromClose.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const idn = Number(item.id);
    let frigoVal = seedCi != null ? Math.max(0, Number(seedCi.frigo) || 0) : stockFrigo(item);
    let reserveVal = seedCi != null ? Math.max(0, Number(seedCi.reserve) || 0) : stockReserve(item);
    if (domFrigo.has(idn)) frigoVal = Math.max(0, Number(domFrigo.get(idn)) || 0);
    if (domReserve.has(idn)) reserveVal = Math.max(0, Number(domReserve.get(idn)) || 0);
    const remaining = stockFrigo(item) + stockReserve(item);
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
  const hadClosingFocus = document.activeElement?.id === "pdj-closing-cash";
  const stockFp = `check|${currentSiteId()}|${dStr}|n${items.length}|v${pdjVentesCountForDate(dStr)}|${blockedNoSales ? "ns" : "ok"}|${closed ? "c" : "o"}|${superadminCorrection ? "adm" : "std"}`;
  const aeStock = document.activeElement;
  const focusInPdjCheck = aeStock instanceof HTMLElement && container.contains(aeStock) && (
    aeStock.id === "pdj-closing-cash" || aeStock.classList.contains("stock-check-input")
  );
  if (focusInPdjCheck && container.getAttribute("data-pdj-stock-fp") === stockFp) {
    pdjApplyCloseDayButtonGate(button, {
      disabled: closeBlockedByPending,
      title: closeBlockedByPending
        ? `${pendingForClose.length} commande(s) en attente — traitez-les depuis Ventes avant clôture.`
        : null,
    });
    return;
  }
  container.setAttribute("data-pdj-stock-fp", stockFp);
  container.innerHTML = `
      ${noSalesBanner}${pendingBanner}${correctionBanner}
      <div class="inline-card" style="margin-bottom:12px">
        <span class="muted">Référence ouverture</span>
        <strong>${escapeHtml(openedLabel)}</strong>
      </div>
      <div class="pdj-closing-cash-panel">
        <strong>Fermeture caisse (espèces)</strong>
        <p class="muted" style="margin-top:6px;font-size:0.88rem;line-height:1.45">
          Théorique en caisse : <strong>${fmt(expectedEspeces)} FCFA</strong>
          (ouverture ${fmt(openingCash)} + ventes espèces ${fmt(especesVentes)}${especesRecouvrement > 0 ? ` + recouvrement crédit espèces ${fmt(especesRecouvrement)}` : ""}).
          ${especesCharges > 0
    ? `Dépenses du jour enregistrées en espèces : <strong>${fmt(especesCharges)} FCFA</strong> — montant informatif, non déduit du théorique (souvent réglé hors caisse de la journée).`
    : "Aucune dépense en espèces enregistrée à cette date pour ce maquis."}
        </p>
        <div class="form-grid two-cols" style="margin-top:10px">
          <div class="form-group">
            <label for="pdj-closing-cash">Montant espèces dénombrées à la fermeture (FCFA)</label>
            <input id="pdj-closing-cash" type="number" min="0" step="1" placeholder="Comptage réel en caisse" value="${escapeHtml(closingValForInput)}">
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
  if (hadClosingFocus) {
    const neu = document.getElementById("pdj-closing-cash");
    if (neu) {
      neu.focus();
      const L = neu.value.length;
      try {
        neu.setSelectionRange(L, L);
      } catch (_) {
        /* ignore */
      }
    }
  }
  pdjApplyCloseDayButtonGate(button, {
    disabled: closeBlockedByPending,
    title: closeBlockedByPending
      ? `${pendingForClose.length} commande(s) en attente — traitez-les depuis Ventes avant clôture.`
      : null,
  });
  } finally {
    updatePdjPrintButtons();
  }
}

function renderDashboard() {
  syncDashboardPeriodCustomUi();
  const site = currentSite();
  const ventesAll = recordsForSite(state.ventes);
  const chargesAll = recordsForSite(state.charges);
  const ventes = recordsInDashboardPeriod(ventesAll, saleDateValue);
  const charges = recordsInDashboardPeriod(chargesAll, (c) => c.date);
  const stock = recordsForSite(state.stock);
  const period = dashboardPeriod();
  const kpiFoot = document.getElementById("dashboard-kpi-period-foot");
  if (kpiFoot) kpiFoot.textContent = `Periode : ${period.label}`;
  const caTotal = ventes.reduce((sum, vente) => sum + calcNet(vente), 0);
  const chargesTotal = charges.reduce((sum, charge) => sum + Number(charge.montant || 0), 0);
  const { margeBrute, beneficeEstime, excludedLines } = pdjEstimatedBenefitFromSales(ventes, chargesTotal);
  const objectif = Number(site?.objectifCA) || 0;
  const now = new Date();
  const { start: monthStart, end: monthEnd, daysInMonth } = monthPeriodBounds(now);
  const ventesMois = ventesEncaisseesForMonth(ventesAll, now);
  const caMois = ventesMois.reduce((sum, vente) => sum + calcNet(vente), 0);
  const pct = objectif > 0 ? Math.min(100, Math.round((caMois / objectif) * 100)) : 0;
  const reste = Math.max(0, objectif - caMois);
  const todayIso = today();
  const dayOfMonth = Math.min(daysInMonth, Number(todayIso.slice(8, 10)) || now.getDate());
  const daysLeft = Math.max(0, daysInMonth - dayOfMonth);
  const rythmeActuel = dayOfMonth > 0 ? Math.round(caMois / dayOfMonth) : 0;
  const rythmeNecessaire = daysLeft > 0 ? Math.round(reste / daysLeft) : (reste > 0 ? reste : 0);
  const enAvance = rythmeActuel >= rythmeNecessaire || reste <= 0;
  document.getElementById("kpi-ca").textContent = fmt(caTotal);
  const margeNode = document.getElementById("kpi-marge-brute");
  if (margeNode) {
    margeNode.textContent = fmt(margeBrute);
    margeNode.className = `kpi-value ${margeBrute >= 0 ? "green" : "red"}`;
  }
  document.getElementById("kpi-charges").textContent = fmt(chargesTotal);
  const beneficeNode = document.getElementById("kpi-benefice");
  beneficeNode.textContent = fmt(beneficeEstime);
  beneficeNode.className = `kpi-value ${beneficeEstime >= 0 ? "green" : "red"}`;
  document.getElementById("kpi-nb").textContent = String(ventes.length);
  const marginHint = document.getElementById("dashboard-kpi-margin-hint");
  if (marginHint) {
    if (excludedLines > 0) {
      marginHint.classList.remove("hidden");
      marginHint.innerHTML = `${excludedLines} ligne(s) de vente sans prix d’achat catalogue dans la période : la <strong>marge brute</strong> est sous-estimée. Complétez les prix d’achat (casier) dans le stock.`;
    } else {
      marginHint.classList.add("hidden");
      marginHint.textContent = "";
    }
  }
  document.getElementById("obj-pct").textContent = `${pct}% atteint`;
  document.getElementById("obj-val").textContent = `/ ${fmt(objectif)} FCFA`;
  document.getElementById("obj-bar").style.width = `${pct}%`;
  const objDetail = document.getElementById("obj-detail");
  if (objDetail) {
    objDetail.innerHTML = objectif > 0
      ? `${fmt(caMois)} FCFA encaissés depuis le ${isoDateToDdMmYyyy(monthStart)}<br>`
        + `Objectif : ${fmt(objectif)} FCFA · Reste : ${fmt(reste)} FCFA<br>`
        + `${daysLeft} jour${daysLeft > 1 ? "s" : ""} restant${daysLeft > 1 ? "s" : ""} dans le mois<br>`
        + `Rythme nécessaire : ${fmt(rythmeNecessaire)} FCFA/jour · `
        + `<span class="${enAvance ? "green" : "red"}">Rythme actuel : ${fmt(rythmeActuel)} FCFA/jour</span>`
      : `<span class="muted">Définissez un objectif mensuel dans Paramètres.</span>`;
  }
  renderBreakdown("cat-chart", ventes.reduce((acc, vente) => ((acc[vente.cat] = (acc[vente.cat] || 0) + calcNet(vente)), acc), {}), caTotal, "Aucune vente finalisee.");
  const chargesByCat = charges.reduce((acc, ch) => {
    const k = String(ch.cat || "Autres").trim() || "Autres";
    acc[k] = (acc[k] || 0) + Number(ch.montant || 0);
    return acc;
  }, {});
  renderBreakdown("charges-cat-chart", chargesByCat, chargesTotal, "Aucune charge enregistree.");
  renderHome2FAAlert();
  const stockAlertRuleHtml = stockAlertInclusiveSeuil(site)
    ? `<p class="muted" style="font-size:0.78rem;margin:0 0 10px;line-height:1.35">Règle alertes pour ce maquis : le stock (bouteilles) est signalé lorsqu'il est <strong>inférieur ou égal</strong> au seuil minimum de l'article (option activée dans Paramètres &gt; Profil).</p>`
    : `<p class="muted" style="font-size:0.78rem;margin:0 0 10px;line-height:1.35">Règle alertes pour ce maquis : le stock (bouteilles) est signalé lorsqu'il est <strong>strictement inférieur</strong> au seuil minimum. Cochez « Alerter dès le seuil atteint » dans Paramètres &gt; Profil pour alerter dès que le stock atteint le seuil (égalité incluse).</p>`;
  const alerts = stockAlertItemsForDashboard();
  document.getElementById("stock-alerts").innerHTML = stockAlertRuleHtml + (alerts.length
    ? `<div class="stock-alerts-toolbar">
          <button type="button" class="mini-btn" data-stock-alert-propose-all aria-label="Proposer commande pour toutes les alertes stock">Toutes les alertes</button>
          <button type="button" class="mini-btn" data-stock-alert-propose-selected aria-label="Proposer commande pour la sélection cochée">Sélection cochée</button>
          <button type="button" class="mini-btn mini-btn--soft" data-stock-alert-check-all aria-label="Cocher toutes les alertes stock">Tout cocher</button>
          <button type="button" class="mini-btn mini-btn--soft" data-stock-alert-uncheck-all aria-label="Décocher toutes les alertes stock">Tout décocher</button>
        </div>
        ${alerts.map((item) => {
      const art = escapeHtml(item.article);
      const act = stockActuel(item);
      const seuil = Number(item.seuilMin) || 0;
      const gravite = act <= 0 ? "Rupture" : `Sous seuil (${fmt(act)}/${fmt(seuil)} btl)`;
      return `<article class="list-item stock-alert-item${act <= 0 ? " stock-alert-item--rupture" : ""}">
        <label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer;flex:1;min-width:0;margin:0">
          <input type="checkbox" class="stock-alert-pick" data-stock-alert-pick="${item.id}" aria-label="Inclure ${art} dans une proposition groupée">
          <div style="min-width:0">
            <p class="list-item-title">${art}</p>
            <p class="list-item-sub">${escapeHtml(item.cat)} · ${gravite}</p>
          </div>
        </label>
        <div class="list-side">
          <div>
            <p class="list-item-amount" style="color:#ff8e82">${fmt(act)} bouteilles</p>
            <p class="list-item-date">Seuil : ${fmt(seuil)}</p>
          </div>
          <button type="button" class="mini-btn" data-propose-purchase="${item.id}" aria-label="Proposer commande pour ${art}">Commander · ${art}</button>
        </div>
      </article>`;
    }).join("")}`
    : emptyState("Tout va bien", "Aucune alerte stock critique pour le moment."));
  const encTotals = paymentTotalsEncaissements(ventes);
  const encTotal = Object.values(encTotals).reduce((s, v) => s + v, 0);
  const creditEmitted = creditClientEmittedTotal(ventes);
  document.getElementById("pay-chart-credit-foot")?.remove();
  renderBreakdown("pay-chart", encTotals, encTotal, "Aucun encaissement sur la période.");
  if (creditEmitted > 0) {
    const foot = document.createElement("p");
    foot.id = "pay-chart-credit-foot";
    foot.className = "muted";
    foot.style.cssText = "font-size:0.78rem;margin-top:10px";
    foot.innerHTML = `Crédit client émis sur la période : <strong>${fmt(creditEmitted)} FCFA</strong> (non compté en encaissements).`;
    document.getElementById("pay-chart")?.insertAdjacentElement("afterend", foot);
  }
  renderDashboardCasierKpis(stock);
  renderDashboardProductRank(ventes);
  syncMobileBottomBadges();
}

/** Récapitulatif imprimable : CA, marge brute, charges et bénéfice estimé sur la période du tableau de bord. */
function printDashboardPeriodMarginsReport() {
  if (!sessionUser) {
    showToast("Connectez-vous pour imprimer.");
    return;
  }
  syncDashboardPeriodCustomUi();
  const site = currentSite();
  const ventes = recordsInDashboardPeriod(recordsForSite(state.ventes), saleDateValue);
  const charges = recordsInDashboardPeriod(recordsForSite(state.charges), (c) => c.date);
  const period = dashboardPeriod();
  const caTotal = ventes.reduce((sum, v) => sum + calcNet(v), 0);
  const chargesTotal = charges.reduce((sum, c) => sum + Number(c.montant || 0), 0);
  const { margeBrute, beneficeEstime, excludedLines } = pdjEstimatedBenefitFromSales(ventes, chargesTotal);
  const encTotals = paymentTotalsEncaissements(ventes);
  const encTotal = Object.values(encTotals).reduce((s, v) => s + v, 0);
  const creditEmitted = creditClientEmittedTotal(ventes);
  const generatedAt = formatDateTimeDdMmYyyy(new Date().toISOString());
  const periodEsc = escapeHtml(period.label);
  const siteEsc = escapeHtml(site?.nom || "Maquis");
  const encRows = Object.entries(encTotals)
    .map(([m, a]) => `<tr><td>${escapeHtml(m)}</td><td style="text-align:right">${fmt(a)}</td></tr>`)
    .join("");
  const excludedBlock = excludedLines
    ? `<p style="color:#c0392b;font-size:12px;margin-top:12px"><strong>Attention :</strong> ${excludedLines} ligne(s) de vente sans prix d’achat catalogue — marge brute sous-estimée.</p>`
    : "";
  const creditBlock = creditEmitted > 0
    ? `<p class="muted" style="font-size:11px;margin-top:8px">Crédit client émis sur la période : ${fmt(creditEmitted)} FCFA (inclus dans le CA net ; non compté dans les encaissements ci-dessous).</p>`
    : "";
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Point période — ${siteEsc}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #111; padding: 20px; max-width: 640px; margin: 0 auto; }
    h1 { font-size: 20px; margin: 0 0 6px; }
    .meta { color: #555; font-size: 11px; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; }
    th { background: #eee; }
    .tot { font-weight: 700; background: #f5f5f5; }
    .highlight { font-size: 16px; font-weight: 700; margin-top: 16px; padding: 12px; border: 2px solid #111; }
    .green { color: #2a9d5c; }
    .red { color: #c0392b; }
    .muted { color: #666; }
    ${PDJ_PREVIEW_PRINT_CSS}
    @media print { body { padding: 12px; } }
  </style></head><body>
  ${pdjPreviewPrintToolbarHtml()}
  <h1>${siteEsc}</h1>
  <p class="meta">Point sur la période : <strong>${periodEsc}</strong><br>Édition : ${escapeHtml(generatedAt)} · Utilisateur : ${escapeHtml(sessionUser || "—")}</p>
  <table>
    <tbody>
      <tr><td>CA net (ventes, toutes modalités)</td><td style="text-align:right">${fmt(caTotal)} FCFA</td></tr>
      <tr><td>Encaissements (hors crédit client)</td><td style="text-align:right">${fmt(encTotal)} FCFA</td></tr>
      <tr><td>Marge brute (prix vente net − coût bouteilles)</td><td style="text-align:right" class="${margeBrute >= 0 ? "green" : "red"}">${fmt(margeBrute)} FCFA</td></tr>
      <tr><td>Charges</td><td style="text-align:right">${fmt(chargesTotal)} FCFA</td></tr>
      <tr class="tot"><td>Bénéfice estimé (marge − charges)</td><td style="text-align:right" class="${beneficeEstime >= 0 ? "green" : "red"}">${fmt(beneficeEstime)} FCFA</td></tr>
    </tbody>
  </table>
  ${creditBlock}
  ${excludedBlock}
  <p class="muted" style="margin-top:18px;font-size:11px">Détail des encaissements</p>
  <table><thead><tr><th>Mode</th><th style="text-align:right">Montant</th></tr></thead>
  <tbody>${encRows || "<tr><td colspan=\"2\" class=\"muted\">Aucun</td></tr>"}</tbody></table>
  <p class="muted" style="margin-top:20px;font-size:10px;text-align:center">${siteEsc} — Document indicatif — ${fmt(ventes.length)} vente(s)</p>
  </body></html>`;
  const w = window.open("", "_blank");
  if (!w) {
    showToast("Impossible d'ouvrir la fenêtre d'impression.");
    return;
  }
  w.document.write(html);
  w.document.close();
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
  const period = dashboardPeriod();
  const periodNote = period.mode === "all"
    ? "Cumul toutes periodes"
    : `Periode : ${escapeHtml(period.label)}`;
  const intro = `<p class="muted" style="margin:0 0 12px;font-size:0.82rem;line-height:1.4">${periodNote} — tri sur la <strong>quantite (bouteilles)</strong> par article.</p>`;
  host.innerHTML = intro + htmlProductRankLists(top, bottom, showFlop, { flopHint: "historique site" });
}

function renderDashboardCasierKpis(stockSiteList) {
  const all = casiersConsignesForSite().filter((c) => String(c.statut || "").toLowerCase() !== "retourne");
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
  const mult = reapproTargetMultiplier();
  const target = seuil * mult;
  const manque = Math.max(0, target - stock);
  const cs = Math.max(1, caseSize(item));
  const detail = seuil > 0
    ? `Calcul : cible ${fmt(target)} btl (${fmt(mult)} × seuil ${fmt(seuil)}) − stock ${fmt(stock)} = ${fmt(manque)} btl à couvrir ; lots arrondis au casier de ${fmt(cs)} btl.`
    : "";
  return { manque, lots: Math.ceil(manque / cs), detail };
}

function suggestPurchaseCases(stockItem) {
  const seuil = Math.max(0, Number(stockItem?.seuilMin) || Number(currentSite()?.seuilStock) || 5);
  const actuel = stockActuel(stockItem);
  const mult = reapproTargetMultiplier();
  const target = Math.max(seuil * mult, seuil);
  const deficitBottles = Math.max(0, target - actuel);
  const cs = Math.max(1, Number(caseSize(stockItem)) || 24);
  const cases = Math.max(1, Math.ceil(deficitBottles / cs));
  return { cases, caseSize: cs };
}

function stockAlertSeverityRank(item) {
  const actuel = stockActuel(item);
  const seuil = Math.max(0, Number(item.seuilMin) || 0);
  if (actuel <= 0) return 0;
  if (seuil <= 0) return 50;
  return actuel / seuil;
}

function stockAlertItemsForDashboard() {
  const stock = recordsForSite(state.stock);
  return stock
    .filter((item) => isStockBelowArticleSeuilForAlert(stockActuel(item), item.seuilMin))
    .sort((a, b) => stockAlertSeverityRank(a) - stockAlertSeverityRank(b));
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

let srvHistCategoryFilter = "all";
let srvHistServerPatchDone = false;

/** Extrait un nom après « Saisie rapide - marthe » ou « Saisie rapide · marthe ». */
function parseSaisieRapideClientLabel(label) {
  const s = String(label || "").trim();
  if (!s) return "";
  const dashMatch = s.match(/^saisie\s*rapide\s*[-–—]\s*(.+)$/i);
  if (dashMatch) return dashMatch[1].trim();
  const parts = s.split(/[-–—·]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2 && /saisie\s*rapide/i.test(parts[0])) return parts.slice(1).join(" ").trim();
  return s;
}

/** Associe un libellé table/client à un identifiant compte (serveuse/gérante du maquis). */
function matchStaffUsernameFromLabel(label, siteId = currentSiteId()) {
  const raw = String(label || "").trim().toLowerCase();
  if (!raw) return "";
  const sid = String(siteId || "").trim();
  const users = (state?.auth?.users || []).filter((u) => {
    const role = String(u.role || "").trim();
    if (role !== "serveuse" && role !== "manager") return false;
    if (!sid) return true;
    return (u.allowedSiteIds || []).some((id) => String(id) === sid);
  });
  for (const u of users) {
    const un = String(u.username || "").trim().toLowerCase();
    const dn = String(u.displayName || "").trim().toLowerCase();
    if (raw === un || raw === dn) return String(u.username || "").trim();
    if (dn && (raw === dn || raw.endsWith(dn) || raw.includes(dn))) return String(u.username || "").trim();
    if (un && (raw === un || raw.endsWith(un) || raw.includes(un))) return String(u.username || "").trim();
  }
  return "";
}

/** Serveur / encaisseur : champs vente, commande, crédit, ou déduction depuis table-client saisie rapide. */
function resolveSaleServerUsername(record) {
  if (!record) return "";
  const bad = (x) => {
    const t = String(x || "").trim();
    return !t || t === "-" || t === "—" || t === "–";
  };
  for (const field of ["server", "serveur"]) {
    const v = String(record[field] || "").trim();
    if (!bad(v)) return v;
  }
  const credit = String(record.creditIssuedBy || "").trim();
  if (!bad(credit)) return credit;
  if (Array.isArray(record.lignes)) {
    for (const line of record.lignes) {
      const fromLine = resolveSaleServerUsername(line);
      if (fromLine) return fromLine;
    }
  }
  if (record.sourceOrderId != null && record.sourceOrderId !== "") {
    const order = (state?.commandes || []).find((o) => Number(o.id) === Number(record.sourceOrderId));
    if (order) {
      const fromOrder = resolveSaleServerUsername(order);
      if (fromOrder) return fromOrder;
    }
  }
  const siteId = record.siteId || currentSiteId();
  for (const label of [record.table, record.client]) {
    const parsed = parseSaisieRapideClientLabel(label);
    const hit = matchStaffUsernameFromLabel(parsed || label, siteId);
    if (hit) return hit;
  }
  return "";
}

function isServeuseAccount() {
  return String(currentRole || "").trim() === "serveuse";
}

function venteBelongsToSessionServer(vente) {
  const sn = String(sessionUser || "").trim().toLowerCase();
  if (!sn) return false;
  const who = resolveSaleServerUsername(vente).trim().toLowerCase();
  if (!who) return false;
  if (who === sn) return true;
  const dn = staffDisplayName(sessionUser).trim().toLowerCase();
  return Boolean(dn && who === dn);
}

/** Corrige en base les ventes sans serveur quand le libellé client/table permet de les attribuer au compte connecté. */
async function patchMyVentasMissingServer() {
  if (!sessionUser || !Array.isArray(state?.ventes)) return;
  const sn = String(sessionUser).trim().toLowerCase();
  let changed = false;
  state.ventes.forEach((v) => {
    if (String(v.server || v.serveur || "").trim()) return;
    const inferred = resolveSaleServerUsername(v);
    if (!inferred || inferred.trim().toLowerCase() !== sn) return;
    v.server = inferred;
    v.serveur = inferred;
    changed = true;
  });
  if (!changed) return;
  try {
    await persistStatePatch({ ventes: state.ventes });
  } catch (_) {
    /* affichage déjà corrigé par resolveSaleServerUsername */
  }
}

function serveuseHistoryPeriod() {
  return {
    start: document.getElementById("srv-hist-period-start")?.value || "",
    end: document.getElementById("srv-hist-period-end")?.value || "",
  };
}

function salesForServeuseHistory() {
  const { start, end } = serveuseHistoryPeriod();
  return recordsForSite(state.ventes)
    .filter((item) => venteBelongsToSessionServer(item))
    .filter((item) => {
      const value = saleDateValue(item);
      const categoryOk = srvHistCategoryFilter === "all" || item.cat === srvHistCategoryFilter;
      const startOk = !start || value >= start;
      const endOk = !end || value <= end;
      return categoryOk && startOk && endOk;
    });
}

function applyServeuseHistoryPreset(preset) {
  const t = today();
  let start = t;
  let end = t;
  if (preset === "7d") start = addCalendarDaysIso(t, -6);
  else if (preset === "month") {
    start = `${t.slice(0, 7)}-01`;
    end = t;
  }
  const startEl = document.getElementById("srv-hist-period-start");
  const endEl = document.getElementById("srv-hist-period-end");
  if (startEl) startEl.value = start;
  if (endEl) endEl.value = end;
  document.querySelectorAll("[data-srv-hist-preset]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.srvHistPreset === preset);
  });
}

function renderServeuseHistTabs() {
  const host = document.getElementById("srv-hist-tabs");
  if (!host) return;
  const filters = [{ key: "all", label: "Toutes" }, ...categoryList().map((cat) => ({ key: cat, label: cat }))];
  host.innerHTML = filters.map(
    (f) => `<button type="button" class="tab ${f.key === srvHistCategoryFilter ? "active" : ""}" data-srv-hist-filter="${escapeHtml(f.key)}">${escapeHtml(f.label)}</button>`,
  ).join("");
}

async function renderServeuseSalesHistoryPage() {
  if (!isServeuseAccount()) return;
  if (!srvHistServerPatchDone) {
    srvHistServerPatchDone = true;
    await patchMyVentasMissingServer();
  }
  const startEl = document.getElementById("srv-hist-period-start");
  if (startEl && !startEl.value) applyServeuseHistoryPreset("today");
  renderServeuseHistTabs();
  const ventes = salesForServeuseHistory().slice().sort((a, b) => b.date.localeCompare(a.date));
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
  const total = ventes.reduce((sum, v) => sum + calcNet(v), 0);
  const metaEl = document.getElementById("srv-hist-count-meta");
  if (metaEl) {
    metaEl.textContent = invoices.size
      ? `${invoices.size} facture${invoices.size > 1 ? "s" : ""} · ${ventes.length} ligne(s)`
      : "0 facture";
  }
  const kpiHost = document.getElementById("srv-hist-kpis");
  if (kpiHost) {
    kpiHost.innerHTML = `
      <div class="pdj-kpi">
        <span class="kpi-label">Total période</span>
        <strong class="pdj-val amber">${fmt(total)} FCFA</strong>
      </div>
      <div class="pdj-kpi">
        <span class="kpi-label">Factures</span>
        <strong class="pdj-val amber">${fmt(invoices.size)}</strong>
      </div>
      <div class="pdj-kpi">
        <span class="kpi-label">Serveuse</span>
        <strong class="pdj-val" style="font-size:0.95rem">${escapeHtml(staffDisplayName(sessionUser))}</strong>
      </div>`;
  }
  const listEl = document.getElementById("srv-hist-list");
  if (!listEl) return;
  listEl.innerHTML = invoices.size
    ? [...invoices.values()].map((invoice) => {
      const invTotal = invoice.lignes.reduce((sum, line) => sum + calcNet(line), 0);
      return `<article class="order-card">
        <div class="section-head">
          <div>
            <h3>${escapeHtml(invoice.factureNumber)}</h3>
            <p class="list-item-sub">${escapeHtml(invoice.client)} · ${escapeHtml(formatDateDdMmYyyy(invoice.date))} · ${escapeHtml(invoice.paiement)}</p>
          </div>
          <div class="order-total">${fmt(invTotal)} FCFA</div>
        </div>
        <div class="order-lines">
          ${invoice.lignes.map((vente) => `<div class="order-line"><div><p class="list-item-title">${escapeHtml(vente.article)}</p><p class="list-item-sub">${escapeHtml(vente.cat)} · ${escapeHtml(lineQtyPriceLabel(vente, stockItemForArticle(vente.article)))}${vente.remise ? ` · -${fmt(vente.remise)}` : ""}</p></div><strong>${fmt(calcNet(vente))} FCFA</strong></div>`).join("")}
        </div>
        <div class="order-actions">
          <button type="button" class="mini-btn" data-print-invoice="${escapeHtml(invoice.factureNumber)}">Imprimer facture</button>
        </div>
      </article>`;
    }).join("")
    : emptyState("Aucune vente", "Aucune facture encaissée par vous sur cette période.");
}

function printServeuseSalesHistory() {
  const ventes = salesForServeuseHistory().slice().sort((a, b) => saleDateValue(a).localeCompare(saleDateValue(b)));
  if (!ventes.length) {
    showToast("Aucune vente à imprimer pour cette période.");
    return;
  }
  const site = currentSite();
  const { start, end } = serveuseHistoryPeriod();
  const periodLabel = start || end
    ? `Période : ${start ? formatDateDdMmYyyy(start) : "…"} au ${end ? formatDateDdMmYyyy(end) : "…"}`
    : "Période : toutes les dates";
  const total = ventes.reduce((sum, vente) => sum + calcNet(vente), 0);
  const payRows = Object.entries(paymentTotals(ventes))
    .map(([method, amount]) => `<tr><td>${escapeHtml(method)}</td><td>${fmt(amount)} FCFA</td></tr>`)
    .join("");
  const rows = ventes.map((vente) => `
    <tr>
      <td>${escapeHtml(formatDateDdMmYyyy(saleDateValue(vente)))}</td>
      <td>${escapeHtml(vente.factureNumber || `VENTE-${vente.id}`)}</td>
      <td>${escapeHtml(vente.client || "Client comptoir")}</td>
      <td>${escapeHtml(vente.article)}</td>
      <td>${escapeHtml(lineQtyLabel(vente, stockItemForArticle(vente.article)))}</td>
      <td>${escapeHtml(paymentLabel(vente))}</td>
      <td>${fmt(calcNet(vente))} FCFA</td>
    </tr>
  `).join("");
  const w = window.open("", "_blank", "width=900,height=900");
  if (!w) { showToast("Impossible d'ouvrir l'impression."); return; }
  w.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Mes ventes</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#111}h1{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:14px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:6px;text-align:left}th{background:#f5f5f5}.meta{color:#555;font-size:13px}</style></head><body>
    <h1>${escapeHtml(site?.nom || "Maquis")} — Mes ventes</h1>
    <p class="meta">${escapeHtml(staffDisplayName(sessionUser))} · ${escapeHtml(periodLabel)}</p>
    <p><strong>Total : ${fmt(total)} FCFA</strong> · ${ventes.length} ligne(s)</p>
    <table><thead><tr><th>Date</th><th>Facture</th><th>Client</th><th>Article</th><th>Qté</th><th>Paiement</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table>
    <h2 style="margin-top:18px;font-size:14px">Par mode de paiement</h2>
    <table><tbody>${payRows}</tbody></table>
    <script>window.onload=function(){window.print();}</script></body></html>`);
  w.document.close();
}

function renderSalesHistory() {
  const histPanel = document.getElementById("ventes-caisse-panel-historique");
  if (!histPanel || histPanel.classList.contains("hidden")) return;
  populateReplaceFactureSelect();
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
          ${invoice.lignes.map((vente) => {
            const venteDate = String(vente.date || "").slice(0, 10);
            const dayOpen = venteDate && !stockCheckForSiteDate(venteDate, vente.siteId || currentSiteId());
            const replaceBtn = sessionUser && dayOpen
              ? `<button type="button" class="mini-btn" data-replace-vente="${vente.id}" title="Remplacer cet article (journee ouverte uniquement)">Remplacer</button>`
              : "";
            return `<div class="order-line"><div><p class="list-item-title">${escapeHtml(vente.article)}</p><p class="list-item-sub">${escapeHtml(vente.cat)} · ${escapeHtml(lineQtyPriceLabel(vente, stockItemForArticle(vente.article)))}${vente.remise ? ` · -${fmt(vente.remise)}` : ""}</p></div><div style="display:flex;gap:6px;align-items:center">${replaceBtn}<button class="del-btn" type="button" data-delete-type="vente" data-id="${vente.id}">Suppr.</button></div></div>`;
          }).join("")}
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

/** Commandes du maquis pour la date comptable encore au statut explicite « En attente » (ex. commandes QR). */
function pendingOrdersForJournalDate(dateStr, siteId = currentSiteId()) {
  const multi = multiSiteActive();
  const d = String(dateStr || "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return [];
  return (state?.commandes || []).filter((o) => {
    if (!rowMatchesSite(o, siteId, multi)) return false;
    const od = String(o.date || "").trim().slice(0, 10);
    if (od !== d) return false;
    return String(o.status || "").trim() === "En attente";
  });
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

/** Cellule HTML : détail articles (ligne × qté — montant), pour tableau / impression. */
function orderManagementArticlesCell(order, maxLines = 25) {
  const lines = order?.lignes || [];
  if (!lines.length) return escapeHtml("—");
  const slice = lines.slice(0, maxLines);
  const seenKit = new Set();
  const rows = [];
  for (const l of slice) {
    const kg = l.kitGroupId;
    if (kg) {
      if (seenKit.has(kg)) continue;
      seenKit.add(kg);
      const group = lines.filter((x) => x.kitGroupId === kg);
      const mix = kitMixCompositionSummary(group.map((x) => ({ article: x.article, qty: Number(x.qty) || 0 })));
      const total = group.reduce((s, x) => s + calcNet(x), 0);
      rows.push(`Kit mixte ${fmt(Number(group[0]?.kitPrice) || total)} FCFA : ${escapeHtml(mix)}`);
      continue;
    }
    const art = String(l.article || l.libelle || "").trim() || "—";
    const si = stockItemForArticle(l.article);
    const qLabel = lineQtyLabel(l, si);
    rows.push(`${escapeHtml(art)} ×${qLabel} <span style="color:#555">(${fmt(calcNet(l))} FCFA)</span>`);
  }
  const more = lines.length > maxLines
    ? `<br><span style="color:#888;font-size:0.92em">… +${lines.length - maxLines} ligne(s)</span>`
    : "";
  return rows.join("<br>") + more;
}

/** Bloc HTML imprimable : tableau détaillé des lignes pour une commande. */
function orderPrintDetailBlock(order) {
  const lines = order?.lignes || [];
  const num = escapeHtml(String(order.factureNumber || order.id));
  const who = escapeHtml(orderServerDisplay(order));
  const cli = escapeHtml(order.table || order.client || "Comptoir");
  const tot = `${fmt(orderTotal(order))} FCFA`;
  if (!lines.length) {
    return `<div style="margin-top:12px;padding:8px;border:1px solid #ddd;border-radius:6px"><strong>${num}</strong> · ${cli} · ${tot}<br><span style="color:#888">Aucune ligne détaillée</span></div>`;
  }
  const body = lines.map((l) => {
    const art = escapeHtml(String(l.article || l.libelle || "—").trim());
    const q = fmt(Math.max(1, Math.round(Number(l.qty) || 1)));
    const pu = fmt(Number(l.prix) || 0);
    const net = fmt(calcNet(l));
    const pay = escapeHtml(String(l.paiement || "—").trim());
    return `<tr><td>${art}</td><td style="text-align:right">${q}</td><td style="text-align:right">${pu}</td><td style="text-align:right">${net} FCFA</td><td>${pay}</td></tr>`;
  }).join("");
  return `<div style="margin-top:14px;page-break-inside:avoid">
    <p style="margin:0 0 6px;font-size:12px;font-weight:700">${num} · ${cli} · ${tot} · <span style="font-weight:600;color:#333">Serveur : ${who}</span></p>
    <table style="width:100%;font-size:11px;border-collapse:collapse;margin:0 0 4px"><thead><tr style="background:#f2f2f2">
      <th style="text-align:left;padding:5px;border:1px solid #ddd">Article</th>
      <th style="text-align:right;padding:5px;border:1px solid #ddd">Qté</th>
      <th style="text-align:right;padding:5px;border:1px solid #ddd">Prix u.</th>
      <th style="text-align:right;padding:5px;border:1px solid #ddd">Total</th>
      <th style="text-align:left;padding:5px;border:1px solid #ddd">Paiement</th>
    </tr></thead><tbody>${body}</tbody></table>
  </div>`;
}

/** Serveur affiché : commande active, puis ventes liées (champs server / creditIssuedBy). */
function orderServerDisplay(order) {
  if (String(order?.source || "").trim() === "qr") return "Client QR";
  const who = resolveSaleServerUsername(order);
  return who ? staffDisplayName(who) : "Non renseigné";
}

function orderTime(order) {
  if (order?._isPaid && Array.isArray(order.lignes) && order.lignes.length) {
    const v = order.lignes[0];
    const fromVente = String(v?.soldAt || v?.createdAt || "").trim();
    if (fromVente.includes("T")) {
      try {
        const d = parseFlexibleDateTime(fromVente);
        if (!Number.isNaN(d.getTime())) return formatLocalHourMinute(d);
      } catch (_) {
        /* ignore */
      }
    }
  }
  const raw = String(order?.createdAt || order?.updatedAt || order?.date || "");
  if (raw.includes("T")) {
    try {
      const d = parseFlexibleDateTime(raw);
      if (!Number.isNaN(d.getTime())) return formatLocalHourMinute(d);
    } catch (_) {
      /* ignore */
    }
  }
  return "--:--";
}

/** Ventes déjà créées pour une commande (idempotence après échec réseau). */
function ventesLinkedToOrder(orderId) {
  const oid = Number(orderId);
  if (!oid) return [];
  return recordsForSite(state.ventes).filter((v) => Number(v.sourceOrderId) === oid);
}

/** Empreinte client + lignes pour dédupliquer commandes actives vs factures (données sans sourceOrderId). */
function orderPaymentFingerprint(order) {
  const client = String(order.client || "").trim().toLowerCase();
  const table = String(order.table || order.client || "").trim().toLowerCase();
  const day = saleDateValue(order);
  const lines = (order.lignes || [])
    .map((l) => `${String(l.article || "").trim()}|${Number(l.qty) || 0}|${Number(l.prix) || 0}`)
    .sort()
    .join(";");
  return `${day}|${client}|${table}|${lines}`;
}

function newOrderClientRequestId() {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/** Empreinte création commande (id client réseau ou contenu). */
function orderCreateFingerprint(order) {
  const crid = String(order?.clientRequestId || "").trim();
  if (crid) return `crid|${crid}`;
  const mode = String(order?.saisieMode || order?.source || "").trim().toLowerCase();
  const srv = String(order?.server || order?.serveur || "").trim().toLowerCase();
  return `${orderPaymentFingerprint(order)}|${mode}|${srv}`;
}

/** Commande active déjà identique (réseau / double clic). */
function findActiveOrderDuplicate(orderLike, sourceState = state) {
  const sid = String(orderLike?.siteId || currentSiteId() || "");
  const crid = String(orderLike?.clientRequestId || "").trim();
  const active = activeCommandesExcludingFinalized(sourceState?.commandes || [], sourceState)
    .filter((o) => rowMatchesSite(o, sid, multiSiteActive()));
  if (crid) {
    const hit = active.find((o) => String(o.clientRequestId || "").trim() === crid);
    if (hit) return hit;
  }
  const fp = orderCreateFingerprint(orderLike);
  return active.find((o) => orderCreateFingerprint(o) === fp) || null;
}

/** Supprime doublons id ou contenu dans state.commandes (commandes actives). */
function dedupeCommandesInState(sourceState = state) {
  const all = Array.isArray(sourceState?.commandes) ? [...sourceState.commandes] : [];
  if (!all.length) return false;
  const finalizedIds = new Set();
  recordsForSite(sourceState?.ventes || []).forEach((v) => {
    if (v.sourceOrderId != null && v.sourceOrderId !== "") finalizedIds.add(Number(v.sourceOrderId));
  });
  const byId = new Map();
  all.forEach((o) => {
    const id = Number(o.id);
    if (!Number.isFinite(id)) return;
    const prev = byId.get(id);
    if (!prev || String(o.createdAt || o.date || "") >= String(prev.createdAt || prev.date || "")) {
      byId.set(id, o);
    }
  });
  let list = Array.from(byId.values());
  const fpSeen = new Map();
  const drop = new Set();
  const sorted = [...list].sort(
    (a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")),
  );
  sorted.forEach((o) => {
    if (finalizedIds.has(Number(o.id))) return;
    if (!activeCommandesExcludingFinalized([o], sourceState).length) return;
    const fp = orderCreateFingerprint(o);
    if (fpSeen.has(fp)) drop.add(Number(o.id));
    else fpSeen.set(fp, Number(o.id));
  });
  const next = list.filter((o) => !drop.has(Number(o.id)));
  if (next.length === all.length && byId.size === all.length) return false;
  sourceState.commandes = next;
  return true;
}

/** Masque les commandes déjà encaissées (ventes liées) pour éviter doublon Servi + Payé. */
function activeCommandesExcludingFinalized(commandes, sourceState = state) {
  const finalizedIds = new Set();
  const paidFingerprints = new Set();
  recordsForSite(sourceState?.ventes || []).forEach((v) => {
    const sid = v.sourceOrderId;
    if (sid != null && sid !== "") finalizedIds.add(Number(sid));
  });
  paidOrdersFromSales().forEach((paid) => {
    if (paid.lignes?.length) paidFingerprints.add(orderPaymentFingerprint(paid));
  });
  return (commandes || []).filter((o) => {
    if (finalizedIds.has(Number(o.id))) return false;
    const st = String(orderStatus(o) || "").trim();
    if (st === "Paye" || st === "Payé" || st === "Annule" || st === "Annulé") return false;
    if (!o.lignes?.length) return true;
    // Ne pas supprimer une commande active qui a un clientRequestId unique —
    // le check sourceOrderId (finalizedIds) est suffisant pour les commandes modernes.
    if (o.clientRequestId) return true;
    return !paidFingerprints.has(orderPaymentFingerprint(o));
  });
}

/** Retire du state les commandes déjà facturées (réseau / ancien merge serveur). */
function pruneFinalizedCommandesFromState(sourceState = state) {
  const all = Array.isArray(sourceState?.commandes) ? sourceState.commandes : [];
  const pruned = activeCommandesExcludingFinalized(all, sourceState);
  if (pruned.length === all.length) return false;
  sourceState.commandes = pruned;
  return true;
}

/** Fusionne le delta commandes sans réinjecter les encaissements. */
function mergeCommandesFromPoll(incoming, { skipStaleDup = false } = {}) {
  if (skipStaleDup || !Array.isArray(incoming) || !incoming.length) return;
  const finalizedIds = new Set();
  recordsForSite(state.ventes).forEach((v) => {
    if (v.sourceOrderId != null && v.sourceOrderId !== "") finalizedIds.add(Number(v.sourceOrderId));
  });
  const paidFp = new Set(
    paidOrdersFromSales().filter((p) => p.lignes?.length).map((p) => orderPaymentFingerprint(p)),
  );
  const byId = new Map((state.commandes || []).map((order) => [order.id, order]));
  incoming.forEach((order) => {
    const oid = Number(order?.id);
    if (finalizedIds.has(oid)) return;
    if (order?.lignes?.length && paidFp.has(orderPaymentFingerprint(order))) return;
    byId.set(order.id, order);
  });
  state.commandes = activeCommandesExcludingFinalized(Array.from(byId.values()));
  dedupeCommandesInState();
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
        server: "",
        lignes: [],
        status: "Paye",
        _isPaid: true,
        createdAt: v.soldAt || v.createdAt,
      };
    }
    paidByFacture[key].lignes.push(v);
    const vs = resolveSaleServerUsername(v);
    if (vs && !String(paidByFacture[key].server || "").trim()) paidByFacture[key].server = vs;
    const ts = v.soldAt || v.createdAt;
    if (ts && !paidByFacture[key].createdAt) paidByFacture[key].createdAt = ts;
  });
  return Object.values(paidByFacture).map((o) => {
    let srv = String(o.server || "").trim();
    if (!srv || srv === "-") {
      for (const v of o.lignes || []) {
        const t = resolveSaleServerUsername(v);
        if (t) {
          srv = t;
          break;
        }
      }
    }
    o.server = srv || "";
    o.serveur = o.server;
    return o;
  });
}

/** Même agrégat que paidOrdersFromSales, limité à la date comptable PDJ active (maquis courant). */
function paidOrdersFromSalesForCurrentAccountingDay() {
  const d = pdjCalendarDate();
  return paidOrdersFromSales().filter((o) => String(o.date || "").trim().slice(0, 10) === d);
}

function populateReplaceFactureSelect() {
  const sel = document.getElementById("replace-facture-select");
  if (!sel) return;
  const prev = sel.value;
  const orders = paidOrdersFromSalesForCurrentAccountingDay()
    .slice()
    .sort((a, b) => String(b.factureNumber || "").localeCompare(String(a.factureNumber || "")));
  const opts = [`<option value="">— Sélectionnez une facture —</option>`];
  for (const o of orders) {
    const key = escapeHtml(String(o.id));
    const num = escapeHtml(String(o.factureNumber || o.id));
    const cli = escapeHtml(String(o.client || o.table || "Comptoir").slice(0, 32));
    const tot = fmt(o.lignes.reduce((s, l) => s + calcNet(l), 0));
    opts.push(`<option value="${key}">${num} · ${cli} · ${tot} FCFA</option>`);
  }
  sel.innerHTML = opts.join("");
  if (prev && orders.some((o) => String(o.id) === prev)) sel.value = prev;
  else sel.value = "";
  renderReplaceFactureLines(sel.value);
}

function renderReplaceFactureLines(factureKey) {
  const wrap = document.getElementById("replace-facture-lines-wrap");
  const tbody = document.getElementById("replace-facture-lines");
  if (!wrap || !tbody) return;
  if (!factureKey) {
    wrap.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  const order = paidOrdersFromSalesForCurrentAccountingDay().find((o) => String(o.id) === String(factureKey));
  if (!order?.lignes?.length) {
    wrap.classList.add("hidden");
    tbody.innerHTML = "";
    return;
  }
  tbody.innerHTML = order.lignes.map((v) => {
    const si = stockItemForArticle(v.article);
    ensureVentePackMetadata(v);
    const pack = linePackSize(v, si);
    const total = calcNet(v);
    const vDate = String(v.date || "").slice(0, 10);
    const dayOpen = vDate && !stockCheckForSiteDate(vDate, currentSiteId());
    const replaceCell = sessionUser && dayOpen
      ? `<button type="button" class="mini-btn" data-replace-vente="${v.id}" style="white-space:nowrap">Remplacer</button>`
      : `<span class="muted" style="font-size:0.8rem">Journée clôturée</span>`;
    const prixCell = pack > 1
      ? `${fmt(v.prix)} FCFA <span class="muted" style="font-size:0.78rem">/ kit</span>`
      : `${fmt(v.prix)} FCFA`;
    return `<tr>
      <td><strong>${escapeHtml(v.article)}</strong></td>
      <td>${escapeHtml(lineQtyLabel(v, si))}</td>
      <td style="text-align:right">${prixCell}</td>
      <td style="text-align:right">${fmt(total)} FCFA</td>
      <td style="text-align:right;padding-left:8px">${replaceCell}</td>
    </tr>`;
  }).join("");
  wrap.classList.remove("hidden");
}

function managementOrders() {
  return [...recordsForSite(state.commandes), ...paidOrdersFromSales()];
}

function orderFromManagementKey(orderKey) {
  const raw = String(orderKey ?? "").trim();
  if (!raw) return null;
  const orders = managementOrders();
  let found = orders.find((item) => String(item.id) === raw || String(item.factureNumber || "").trim() === raw);
  if (found) return found;
  const n = Number(raw);
  if (!Number.isNaN(n)) {
    found = orders.find((item) => {
      const oid = item.id;
      return (typeof oid === "number" && oid === n) || String(oid) === String(n);
    });
  }
  return found || null;
}

function openOrderDetailModal(orderKey) {
  const order = orderFromManagementKey(orderKey);
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
      .map(([method, amount]) => `<div><dt>${escapeHtml(method || "Paiement")}</dt><dd>${fmt(amount)} FCFA</dd></div>`)
      .join("")
    : `<div><dt>Paiement</dt><dd>${escapeHtml((order.lignes || [])[0]?.paiement || "-")}</dd></div>`;
  const lineRows = (order.lignes || []).map((line) => `
    <tr>
      <td>${escapeHtml(line.article)}</td>
      <td>${escapeHtml(line.cat || "-")}</td>
      <td>${escapeHtml(lineQtyLabel(line, stockItemForArticle(line.article)))}</td>
      <td style="text-align:right">${fmt(line.prix || 0)} FCFA</td>
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
      <div><dt>Serveur</dt><dd>${escapeHtml(orderServerDisplay(order))}</dd></div>
      <div><dt>Type</dt><dd>${orderType(order) === "a-emporter" ? "A emporter" : "Sur place"}</dd></div>
      <div><dt>Total</dt><dd><strong>${fmt(total)} FCFA</strong></dd></div>
      ${paymentRows}
    </dl>
    <div class="stock-table-wrap" style="margin-top:14px">
      <table class="stock-table">
        <thead><tr><th>Article</th><th>Categorie</th><th>Quantite</th><th style="text-align:right">Prix</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${lineRows || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:24px">Aucun article</td></tr>`}</tbody>
      </table>
    </div>
    <div class="order-actions" style="margin-top:14px">
      ${order._isPaid && order.factureNumber ? `<button type="button" class="mini-btn" data-print-invoice="${escapeHtml(order.factureNumber)}">Imprimer facture</button>` : `<button type="button" class="mini-btn" data-print-order="${escapeHtml(order.id)}">Ticket</button>`}
    </div>
  `;
  openModal("modal-order-detail");
}

/** Liste et métadonnées alignées sur les filtres « Gestion des commandes » (période, statut, type). */
function computeOrdersManagementList() {
  const { start, end } = ordersPeriod();
  const status = document.getElementById("orders-filter-status")?.value || "all";
  const type = document.getElementById("orders-filter-type")?.value || "all";
  const journalDay = pdjCalendarDate();
  const activeOrders = activeCommandesExcludingFinalized(recordsForSite(state.commandes));
  const salesToday = recordsForSite(state.ventes).filter((vente) => saleDateValue(vente) === journalDay);
  const paidOrders = paidOrdersFromSales();
  const baseOrders = status === "Paye"
    ? paidOrders
    : status === "all"
      ? [...activeOrders, ...paidOrders]
      : activeOrders;
  const orders = baseOrders.filter((order) => {
    const orderDay = saleDateValue(order);
    const dateOk = orderDay >= start && orderDay <= end;
    const statusOk = status === "all" || orderStatus(order) === status;
    const typeOk = type === "all" || orderType(order) === type;
    return dateOk && statusOk && typeOk;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { orders, start, end, status, type, activeOrders, salesToday, journalDay };
}

function printOrdersManagementList() {
  const { orders, start, end, status, type } = computeOrdersManagementList();
  if (!orders.length) {
    showToast("Aucune commande a imprimer pour cette periode.");
    return;
  }
  const site = currentSite();
  const periodLab = start === end
    ? formatDateDdMmYyyy(start)
    : `${formatDateDdMmYyyy(start)} au ${formatDateDdMmYyyy(end)}`;
  const statusLab = status === "all" ? "Tous les statuts" : escapeHtml(status);
  const typeLab = type === "all" ? "Tous les types" : type === "a-emporter" ? "A emporter" : "Sur place";
  const totalListe = orders.reduce((sum, order) => sum + orderTotal(order), 0);
  const rows = orders.map((order) => `
    <tr>
      <td>${escapeHtml(String(order.factureNumber || order.id))}</td>
      <td>${escapeHtml(orderPhysicalTable(order))}</td>
      <td>${escapeHtml(orderSaisieMode(order))}</td>
      <td>${escapeHtml(orderServerDisplay(order))}</td>
      <td>${escapeHtml(orderStatus(order))}</td>
      <td>${orderType(order) === "a-emporter" ? "A emporter" : "Sur place"}</td>
      <td style="text-align:left;max-width:240px;font-size:0.86rem;line-height:1.35;vertical-align:top" class="order-art-cell">${orderManagementArticlesCell(order)}</td>
      <td style="text-align:right">${fmt(orderTotal(order))} FCFA</td>
      <td>${escapeHtml(orderTime(order))}</td>
    </tr>
  `).join("");
  const ticketWindow = window.open("", "_blank", "width=1100,height=900");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir l'impression.");
    return;
  }
  const filtreMeta = `Periode : ${escapeHtml(periodLab)} &mdash; Statut : ${statusLab} &mdash; Type : ${escapeHtml(typeLab)}`;
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Commandes filtrées</title><style>body{font-family:Arial,sans-serif;color:#111;padding:28px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}.meta{color:#555;font-size:13px;line-height:1.45}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.box{border:1px solid #111;padding:12px}.box strong{display:block;font-size:18px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left;vertical-align:top}th{background:#f2f2f2}td:nth-child(7){text-align:right}.order-art-cell{max-width:280px;font-size:10.5px;line-height:1.35}${PDJ_PREVIEW_PRINT_CSS}@media print{body{padding:0}table{font-size:11px}}</style></head><body>${pdjPreviewPrintToolbarHtml()}<header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p><p class="meta">${filtreMeta}</p></div><div><h2>Gestion des commandes</h2><p class="meta">Imprimé le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div></header><div class="summary"><div class="box">Lignes affichées<strong>${fmt(orders.length)}</strong></div><div class="box">Total (liste)<strong>${fmt(totalListe)} FCFA</strong></div><div class="box">Période<strong>${escapeHtml(periodLab)}</strong></div></div><table><thead><tr><th>Numéro</th><th>Table / client</th><th>Serveur</th><th>Statut</th><th>Type</th><th>Articles (résumé)</th><th>Montant</th><th>Heure</th></tr></thead><tbody>${rows}</tbody></table></body></html>`);
  ticketWindow.document.close();
}

function renderOrdersManagement() {
  const { orders, activeOrders, salesToday, journalDay } = computeOrdersManagementList();

  document.getElementById("orders-today-kpi").textContent = String(activeOrders.filter((order) => saleDateValue(order) === journalDay).length + salesToday.length);
  document.getElementById("orders-pending-kpi").textContent = String(activeOrders.filter((order) => orderStatus(order) === "En attente").length);
  document.getElementById("orders-ca-kpi").textContent = `${fmt(salesToday.reduce((sum, vente) => sum + calcNet(vente), 0))} FCFA`;
  document.getElementById("orders-management-table").innerHTML = orders.length
    ? orders.map((order) => {
      const next = order._isPaid ? "" : nextOrderStatus(orderStatus(order));
      const encBlocked = next === "Encaisser" && journalEncaisseDisabledForOrder(order);
      const encTitle = encBlocked ? escapeHtml(journalEncaisseBlockTitle(order)) : "";
      const advanceBtn = next && !(next === "Encaisser" && encBlocked)
        ? `<button type="button" class="mini-btn${next === "Encaisser" ? " btn-encaisser" : ""}" data-advance-order="${order.id}">${escapeHtml(next)}</button>`
        : "";
      return `<tr>
        <td>#${escapeHtml(order.factureNumber || String(order.id))}</td>
        <td>${escapeHtml(orderPhysicalTable(order))}</td>
        <td class="col-hide-sm">${escapeHtml(orderSaisieMode(order))}</td>
        <td>${escapeHtml(orderServerDisplay(order))}</td>
        <td>${escapeHtml(orderStatus(order))}</td>
        <td class="col-hide-sm">${orderType(order) === "a-emporter" ? "A emporter" : "Sur place"}</td>
        <td class="order-art-cell">${orderManagementArticlesCell(order, 4)}</td>
        <td style="text-align:right;white-space:nowrap">${fmt(orderTotal(order))} FCFA</td>
        <td class="col-hide-sm">${escapeHtml(orderTime(order))}</td>
        <td class="col-actions">
          <div class="order-actions-cell">
            <button type="button" class="mini-btn" data-order-details="${escapeHtml(order.id)}">Details</button>
            ${order._isPaid ? "" : `<button type="button" class="mini-btn" data-activate-order="${order.id}">Ouvrir</button>`}
            ${order._isPaid ? "" : `<button type="button" class="mini-btn" data-kit-mix-order="${order.id}">Kit mixte</button>`}
            ${advanceBtn}
            ${encBlocked ? `<button type="button" class="mini-btn" disabled title="${encTitle}">Encaisser</button>` : ""}
            ${!order._isPaid && canDeleteOrder(order) ? `<button type="button" class="mini-btn del-btn" data-delete-order="${order.id}">Annuler</button>` : ""}
          </div>
        </td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:44px">Aucune commande trouvee</td></tr>`;
}

function renderOrders() {
  pruneFinalizedCommandesFromState();
  const orders = activeCommandesExcludingFinalized(recordsForSite(state.commandes)).slice().sort((a, b) => {
    if (activeOrderId) {
      if (a.id === activeOrderId) return -1;
      if (b.id === activeOrderId) return 1;
    }
    return b.date.localeCompare(a.date);
  });
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
          ${order.lignes.length ? order.lignes.map((line) => orderLineHtmlForBoard(order, line)).filter(Boolean).join("") : emptyState("Commande vide", "Ajoutez une premiere boisson a cette commande.")}
        </div>
        <div class="order-actions">
          <button type="button" class="mini-btn" data-activate-order="${order.id}">Ouvrir la commande</button>
          <button type="button" class="mini-btn" data-add-line-order="${order.id}">Ajouter un article</button>
          <button type="button" class="mini-btn" data-kit-mix-order="${order.id}">Kit mixte</button>
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

function srCartAction(idx, action, value) {
  const item = srCart[idx];
  if (!item) return;
  if (action === "remove") {
    srCart.splice(idx, 1);
  } else if (action === "set") {
    const qty = Math.max(0, Math.floor(Number(value) || 0));
    if (qty === 0) srCart.splice(idx, 1);
    else srCart[idx].qty = qty;
  }
  renderSrMenu(document.getElementById("sr-search")?.value || "");
  renderSrCart();
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
  const btnStyle = "border:1px solid #ddd;background:#f5f5f5;border-radius:6px;width:28px;height:28px;font-size:1rem;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;line-height:1";
  const delStyle = "border:none;background:none;color:#e53935;font-size:1.1rem;cursor:pointer;padding:0 2px;line-height:1";
  const int = srCart.map((c, i) => ({ ...c, _idx: i })).filter((c) => !c.location.startsWith("Ext"));
  const ext = srCart.map((c, i) => ({ ...c, _idx: i })).filter((c) => c.location.startsWith("Ext"));
  const section = (items, label, color) => {
    if (!items.length) return "";
    const sub = items.reduce((s, c) => s + c.prix * c.qty, 0);
    return `<div style="margin-bottom:10px;padding:10px;border-radius:8px;border:1px solid ${color}22;background:${color}0d">
      <p style="font-size:0.7rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${color};margin:0 0 6px">${label}</p>
      ${items.map((c) => `<div style="display:flex;align-items:center;gap:6px;padding:5px 0;border-bottom:1px solid rgba(0,0,0,0.06)">
        <span style="flex:1;font-size:0.85rem;color:var(--mm-text)">${escapeHtml(c.article)}${c.packSize > 1 ? ` ×${c.packSize}` : ""}</span>
        <button style="${btnStyle}" onclick="srCartAction(${c._idx},'set',${c.qty - 1})" type="button">−</button>
        <span style="min-width:20px;text-align:center;font-size:0.9rem;font-weight:600">${c.qty}</span>
        <button style="${btnStyle}" onclick="srCartAction(${c._idx},'set',${c.qty + 1})" type="button">+</button>
        <strong style="min-width:72px;text-align:right;font-size:0.85rem">${fmt(c.prix * c.qty)} FCFA</strong>
        <button style="${delStyle}" onclick="srCartAction(${c._idx},'remove')" type="button" title="Supprimer">✕</button>
      </div>`).join("")}
      <div style="display:flex;justify-content:flex-end;font-size:0.8rem;font-weight:600;color:${color};padding-top:5px">Sous-total : ${fmt(sub)} FCFA</div>
    </div>`;
  };
  container.innerHTML =
    section(int, "Cave (Interieur)", "#1976d2") +
    section(ext, "Terrasse (Exterieur)", "#388e3c");
}

function openSaisieRapide() {
  activeOrderId = null;
  openOrderEditor(null);
}

async function submitSaisieRapide() {
  if (!srCart.length) { showToast("Ajoutez au moins un article."); return; }
  if (saisieRapideSubmitInFlight.has("submit")) {
    showToast("Envoi en cours, patientez…");
    return;
  }
  const orderCtxWrap = document.getElementById("sr-order-context-wrap");
  const orderFormMode = Boolean(orderCtxWrap && !orderCtxWrap.classList.contains("hidden"));
  const btn = document.getElementById("sr-submit-btn");
  saisieRapideSubmitInFlight.add("submit");
  if (btn) { btn.disabled = true; btn.textContent = "Validation..."; }
  try {
    if (orderFormMode) {
      const date = document.getElementById("sr-date")?.value?.trim() || today();
      if (!assertCanSellOrToast(date, currentSiteId())) return;
      state.nextId = state.nextId || {};
      state.nextId.ligneCommande = Number(state.nextId.ligneCommande) || 0;
      const selectedOrderId = Number(document.getElementById("sr-order-select")?.value) || 0;
      const creatingNewOrder = !selectedOrderId;
      const existingOrder = selectedOrderId
        ? recordsForSite(state.commandes).find((item) => item.id === selectedOrderId)
        : null;
      const srClientTrim = (document.getElementById("sr-client")?.value ?? "").trim();
      if (!assertNomClientQrCommandeOuToast(srClientTrim, existingOrder)) return;
      const order = ensureOrder(
        document.getElementById("sr-client")?.value ?? "",
        date,
        document.getElementById("sr-note")?.value ?? "",
        selectedOrderId,
      );
      const errors = [];
      let added = 0;
      for (const item of srCart) {
        const product = findKnownProduct(item.article);
        if (!product) { errors.push(item.article); continue; }
        const packSize = Math.max(1, Number(item.packSize) || 1);
        const bottles = item.qty * packSize;
        const avail = stockAvailabilityForLine(product.article, bottles, order.id, null);
        if (!avail.stockItem || avail.available < bottles) {
          errors.push(`${item.article} (stock insuffisant : ${fmt(avail.available)} btl)`);
          continue;
        }
        state.nextId.ligneCommande += 1;
        const loc = item.location || document.getElementById("sr-location")?.value || "Intérieur";
        const line = {
          id: state.nextId.ligneCommande,
          date,
          article: product.article,
          cat: product.cat || "Autres",
          location: loc,
          formatQuantite: packSize,
          prix: item.prix,
          qty: item.qty,
          remise: 0,
          paiement: "A regler",
          note: "",
        };
        order.lignes.push(line);
        recordStaffAudit("create", "commande_ligne", `Ligne ajoutee · commande #${order.id} · ${order.client || ""}`, `${line.article} · ${fmt(calcNet(line))} FCFA`);
        added += 1;
      }
      if (!added) {
        if (creatingNewOrder && !(order.lignes && order.lignes.length)) {
          state.commandes = (state.commandes || []).filter((o) => o.id !== order.id);
          if (activeOrderId === order.id) activeOrderId = null;
        }
        showToast(errors.length ? `Aucune ligne ajoutee : ${errors.join(", ")}` : "Aucune ligne valide.");
        return;
      }
      await persistState();
      closeModal("modal-saisie-rapide");
      srCart = [];
      const vSel = document.getElementById("v-order-select");
      const srSel = document.getElementById("sr-order-select");
      if (vSel && srSel) vSel.value = srSel.value;
      const vDate = document.getElementById("v-date");
      if (vDate) vDate.value = document.getElementById("sr-date")?.value || "";
      const vClient = document.getElementById("v-client");
      if (vClient) vClient.value = document.getElementById("sr-client")?.value || "";
      const vNote = document.getElementById("v-note");
      if (vNote) vNote.value = document.getElementById("sr-note")?.value || "";
      syncFinalizeButtonJournalState();
      renderVentesPage();
      const warn = errors.length ? ` (${errors.length} ligne(s) ignoree(s))` : "";
      showToast(`${added} article(s) ajoute(s) a la commande.${warn}`);
      return;
    }

    const date = pdjCalendarDate();
    if (!assertCanSellOrToast(date, currentSiteId())) return;
    const tableLabel = document.getElementById("sr-client")?.value?.trim() || "Comptoir";
    state.nextId = state.nextId || {};
    const clientRequestId = srPendingClientRequestId || newOrderClientRequestId();
    srPendingClientRequestId = clientRequestId;
    let order = (state.commandes || []).find(
      (o) => String(o.clientRequestId || "").trim() === clientRequestId,
    );
    if (!order && srPendingOrderId) {
      order = (state.commandes || []).find((o) => Number(o.id) === Number(srPendingOrderId));
    }
    if (!order) {
      state.nextId.commande = (Number(state.nextId.commande) || 0) + 1;
      srPendingOrderId = state.nextId.commande;
      order = {
        id: srPendingOrderId,
        siteId: currentSiteId(),
        table: tableLabel,
        client: tableLabel,
        saisieMode: "Saisie rapide",
        date,
        createdAt: new Date().toISOString(),
        status: "Servi",
        type: "sur-place",
        server: sessionUser || "Serveuse",
        note: "",
        lignes: [],
        clientRequestId,
      };
    } else {
      srPendingOrderId = order.id;
      order.clientRequestId = clientRequestId;
      order.table = tableLabel;
      order.client = tableLabel;
      order.date = date;
      order.lignes = [];
      if (!String(order.server || order.serveur || "").trim()) {
        order.server = sessionUser || "Serveuse";
        order.serveur = order.server;
      }
    }
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
      const loc = item.location || document.getElementById("sr-location")?.value || "Intérieur";
      order.lignes.push({
        id: state.nextId.ligneCommande,
        date,
        article: product.article,
        cat: product.cat || "Autres",
        location: loc,
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
    order.clientRequestId = clientRequestId;
    const dup = findActiveOrderDuplicate(order);
    if (dup && Number(dup.id) !== Number(order.id)) {
      srPendingClientRequestId = null;
      srPendingOrderId = null;
      activeOrderId = dup.id;
      closeModal("modal-saisie-rapide");
      srCart = [];
      renderVentesPage();
      showToast(`Commande déjà enregistrée (#${dup.id}) — pas de doublon créé.`);
      return;
    }
    state.commandes = state.commandes || [];
    const already = state.commandes.some((o) => Number(o.id) === Number(order.id));
    if (!already) state.commandes.unshift(order);
    activeOrderId = order.id;
    dedupeCommandesInState();
    await persistState({ commandes: state.commandes, nextId: state.nextId });
    srPendingClientRequestId = null;
    srPendingOrderId = null;
    closeModal("modal-saisie-rapide");
    srCart = [];
    renderVentesPage();
    const warn = errors.length ? ` (${errors.length} article(s) ignores : stock insuffisant)` : "";
    showToast(`Commande creee : ${order.lignes.length} article(s) pour ${tableLabel}.${warn}`);
  } finally {
    saisieRapideSubmitInFlight.delete("submit");
    if (btn) { btn.disabled = false; btn.textContent = "Valider la commande"; }
  }
}

function renderVentesPage() {
  syncDualZonePricingUi();
  syncServeuseVentesPageRestDay();
  if (serveuseVentesModuleBlocked()) return;
  const gate = document.getElementById("ventes-journal-gate");
  if (gate) {
    const d = journalSaleDateFromDom();
    const sid = currentSiteId();
    const restMsg = serveusePlanningBlocksSale(d, sid);
    const j = journalAllowsSalesForDate(d, sid);
    const parts = [];
    if (restMsg) {
      parts.push(`<div class="inline-card ventes-rest-day-alert" role="alert">
        <strong>Hors service — ventes bloquées</strong>
        <p class="ventes-rest-day-alert-msg">${escapeHtml(restMsg)}</p>
      </div>`);
    }
    if (PDJ_REQUIRE_CASH_OPENING) {
      if (j.ok && !restMsg) {
        const closeHint = canClosePdjDay()
          ? " Clôturez la journée sur le <strong>Point du jour</strong> en fin de service."
          : "";
        parts.push(`<div class="inline-card" style="border-left:3px solid #72d7a9;margin-bottom:12px">
          <strong>Journée ouverte</strong> (${escapeHtml(isoDateToDdMmYyyy(d))}) — vous pouvez enregistrer des lignes de commande et encaisser.${closeHint}
        </div>`);
      } else if (!j.ok) {
        parts.push(`<div class="inline-card" style="border-left:3px solid #ff8e82;margin-bottom:12px">
          <strong>Ventes indisponibles pour cette date</strong>
          <p class="muted" style="margin:8px 0 0;line-height:1.45">${escapeHtml(j.message)}</p>
          <p class="muted" style="margin:6px 0 0;font-size:0.86rem;line-height:1.45">Ouvrez la journée (ou la suivante si celle-ci est déjà clôturée) depuis la page <strong>Point du jour</strong> — rôle gérant ou administrateur.</p>
        </div>`);
      }
    }
    gate.classList.toggle("hidden", !parts.length);
    gate.innerHTML = parts.join("");
  }
  document.getElementById("articles-list").innerHTML = recordsForSite(state.stock).map((item) => `<option value="${escapeHtml(item.article)}">`).join("");
  if (document.getElementById("modal-vente")?.classList.contains("open")) renderVenteArticlePicker();
  if (document.getElementById("modal-saisie-rapide")?.classList.contains("open")) {
    renderSrMenu(document.getElementById("sr-search")?.value || "");
  }
  renderOrdersManagement();
  renderQrAlertBadge();
  renderOrders();
  renderSalesHistory();
  if (currentPage === "historique-ventes") renderServeuseSalesHistoryPage().catch(() => {});
  renderCreditRecovery();
  renderConsignes();
  if (currentPage === "pdj") renderPointDuJour();
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

  const dPdj = pdjCalendarDate();
  for (const { vente } of entries) {
    const vd = String(vente?.date || "").trim().slice(0, 10);
    if (vd !== dPdj) {
      showToast("Choisissez une facture de la journée comptable en cours (liste Facture concernée).");
      return;
    }
  }

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
  const orders = paidOrdersFromSalesForCurrentAccountingDay()
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
  const order = paidOrdersFromSalesForCurrentAccountingDay().find((o) => String(o.id) === String(orderId));
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
  const consigneBtn = document.getElementById("save-consigne-btn");
  const prevConsigneText = consigneBtn ? consigneBtn.textContent : "";
  if (multi.length) {
    if (consigneBtn) { consigneBtn.disabled = true; consigneBtn.textContent = "Enregistrement…"; }
    try {
      await saveConsignesMultiFromFacture(multi);
    } finally {
      if (consigneBtn) { consigneBtn.disabled = false; consigneBtn.textContent = prevConsigneText; }
    }
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
  if (consigneBtn) { consigneBtn.disabled = true; consigneBtn.textContent = "Enregistrement…"; }
  try {
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
  } finally {
    if (consigneBtn) { consigneBtn.disabled = false; consigneBtn.textContent = prevConsigneText; }
  }
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

// ─── KIT MIXTE (plusieurs articles, meme prix kit, repartition bouteilles) ───

let kitMixCounts = {};

function kitMixTotalSelected() {
  return Object.values(kitMixCounts).reduce((s, n) => s + (Number(n) || 0), 0);
}

/** Ex. « 2 kits = 6 bouteilles = 5 000 FCFA » */
function kitMixOrderSummary(nbKits, bottlesPerKit, pricePerKit) {
  const n = Math.max(1, Math.min(99, Math.floor(Number(nbKits) || 1)));
  const sz = Math.max(1, Math.floor(Number(bottlesPerKit) || 3));
  const p = Math.max(0, Number(pricePerKit) || 0);
  const totalBtl = n * sz;
  const totalFcfa = n * p;
  const kitWord = n > 1 ? "kits" : "kit";
  const btlWord = totalBtl > 1 ? "bouteilles" : "bouteille";
  return `${fmt(n)} ${kitWord} = ${fmt(totalBtl)} ${btlWord} = ${fmt(totalFcfa)} FCFA`;
}

function readKitMixCountsFromDom() {
  const next = {};
  document.querySelectorAll("#kit-products-list .kit-mix-qty").forEach((input) => {
    const art = input.dataset.kitArticle;
    if (!art) return;
    next[art] = Math.max(0, Math.floor(Number(input.value) || 0));
  });
  kitMixCounts = next;
}

/** Produits ayant un format vente « kit » (ex. 3 btl = 2500 FCFA). */
function productsForKitOffer(price, location, size, asOfDate = ventePriceContextDate()) {
  const p = Number(price) || 0;
  const sz = Math.max(1, Number(size) || 3);
  if (p <= 0) return [];
  return knownProducts(asOfDate).filter((product) => {
    const stockItem = stockItemForArticle(product.article);
    const item = stockItem || product;
    const formats = normalizeSaleFormats(item, asOfDate);
    return formats.some((f) => {
      const q = Math.max(1, Number(f.quantite) || 1);
      return q === sz && formatPrice(f, location) === p;
    });
  });
}

function renderKitProducts() {
  readKitMixCountsFromDom();
  const price = Number(document.getElementById("kit-price")?.value) || 0;
  const location = document.getElementById("kit-location")?.value || "Intérieur";
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const container = document.getElementById("kit-products-list");
  const info = document.getElementById("kit-count-info");
  if (!container) return;
  if (price <= 0) {
    container.innerHTML = "";
    kitMixCounts = {};
    if (info) info.textContent = "Saisissez le prix du kit pour voir les articles compatibles.";
    return;
  }
  const products = productsForKitOffer(price, location, size);
  if (!products.length) {
    container.innerHTML = `<p class="muted" style="font-size:0.85rem">Aucun article avec un kit de ${fmt(size)} btl a ${fmt(price)} FCFA. Verifiez les formats de vente dans le catalogue stock.</p>`;
    kitMixCounts = {};
    if (info) info.textContent = "";
    return;
  }
  const totalBefore = kitMixTotalSelected();
  container.innerHTML = products.map((p) => {
    const art = p.article;
    const artEsc = escapeHtml(art);
    const cur = Math.max(0, Math.min(size, Number(kitMixCounts[art]) || 0));
    kitMixCounts[art] = cur;
    return `<div class="kit-mix-row" data-kit-article="${artEsc}">
      <span class="kit-mix-name">${artEsc}</span>
      <div class="kit-mix-qty-wrap">
        <button type="button" class="mini-btn kit-mix-dec" data-kit-article="${artEsc}" aria-label="Moins">−</button>
        <input type="number" class="kit-mix-qty" min="0" max="${size}" value="${cur}" data-kit-article="${artEsc}" inputmode="numeric">
        <button type="button" class="mini-btn kit-mix-inc" data-kit-article="${artEsc}" aria-label="Plus">+</button>
      </div>
    </div>`;
  }).join("");
  if (totalBefore > 0) {
    products.forEach((p) => {
      const kept = Math.min(size, Number(kitMixCounts[p.article]) || 0);
      const input = container.querySelector(`.kit-mix-qty[data-kit-article="${CSS.escape(p.article)}"]`);
      if (input) input.value = String(kept);
    });
  }
  updateKitCountInfo();
}

function updateKitCountInfo() {
  readKitMixCountsFromDom();
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const total = kitMixTotalSelected();
  const info = document.getElementById("kit-count-info");
  const banner = document.getElementById("kit-mix-summary-banner");
  const confirmBtn = document.getElementById("confirm-kit-btn");
  const price = Number(document.getElementById("kit-price")?.value) || 0;
  const nbKits = Math.max(1, Math.min(99, Math.floor(Number(document.getElementById("kit-mix-count")?.value) || 1)));
  const kitOk = total === size;
  const summary = price > 0 ? kitMixOrderSummary(nbKits, size, price) : "";
  const parts = Object.entries(kitMixCounts)
    .map(([article, qty]) => ({ article, qty: Math.max(0, Math.floor(Number(qty) || 0)) }))
    .filter((p) => p.qty > 0);
  const mixPerKit = kitOk && parts.length ? kitMixCompositionSummary(parts) : "";
  if (banner) {
    if (summary) {
      banner.textContent = summary;
      banner.classList.remove("hidden");
      banner.removeAttribute("hidden");
    } else {
      banner.textContent = "";
      banner.classList.add("hidden");
      banner.setAttribute("hidden", "");
    }
  }
  if (info) {
    const rest = size - total;
    if (!kitOk) {
      info.textContent = summary
        ? `Repartition par kit : ${fmt(total)} / ${fmt(size)} btl · reste ${fmt(Math.max(0, rest))} a repartir`
        : `${fmt(total)} / ${fmt(size)} btl par kit · reste ${fmt(Math.max(0, rest))} a repartir`;
    } else {
      info.textContent = mixPerKit ? `${mixPerKit} (par kit)` : "Composition valide — pret a ajouter.";
    }
    info.style.color = kitOk ? "var(--ok, #72d7a9)" : total > size ? "#ff8e82" : "";
  }
  if (confirmBtn) {
    const canAdd = kitOk && price > 0 && parts.length > 0;
    confirmBtn.disabled = !canAdd;
    confirmBtn.textContent = canAdd
      ? `Ajouter a la commande · ${summary}`
      : "Ajouter a la commande";
  }
  const atMax = total >= size;
  document.querySelectorAll("#kit-products-list .kit-mix-inc").forEach((btn) => {
    btn.disabled = atMax;
  });
  document.querySelectorAll("#kit-products-list .kit-mix-qty").forEach((input) => {
    const v = Number(input.value) || 0;
    input.disabled = atMax && v === 0;
  });
}

function kitMixCompositionSummary(parts) {
  return parts.map((p) => `${p.article} ×${p.qty}`).join(" + ");
}

function orderLineHtmlForBoard(order, line) {
  const batch = line.kitBatchId;
  if (batch) {
    const batchLines = (order.lignes || []).filter((l) => l.kitBatchId === batch);
    const first = batchLines[0];
    if (first && first.id !== line.id) return "";
    const nbKits = Number(line.kitUnitCount) || 1;
    const oneKitLines = batchLines.filter((l) => Number(l.kitUnitIndex) === 1);
    const mix = kitMixCompositionSummary(oneKitLines.map((l) => ({ article: l.article, qty: Number(l.qty) || 0 })));
    const priceKit = Number(line.kitPrice) || 0;
    const size = Number(line.kitSize) || oneKitLines.reduce((s, l) => s + (Number(l.qty) || 0), 0) || 3;
    const title = kitMixOrderSummary(nbKits, size, priceKit);
    return `<div class="order-line order-line-kit-mix">
      <div>
        <p class="list-item-title">${escapeHtml(title)}</p>
        <p class="list-item-sub">${escapeHtml(mix)} · ${escapeHtml(line.paiement || "A regler")}</p>
      </div>
      <div class="line-actions">
        <button type="button" class="mini-btn" data-remove-kit-batch="${escapeHtml(batch)}" data-order-id="${order.id}">Retirer</button>
      </div>
    </div>`;
  }
  const kg = line.kitGroupId;
  if (kg) {
    const group = (order.lignes || []).filter((l) => l.kitGroupId === kg);
    const first = group[0];
    if (first && first.id !== line.id) return "";
    const mix = kitMixCompositionSummary(group.map((l) => ({ article: l.article, qty: Number(l.qty) || 0 })));
    const total = group.reduce((s, l) => s + calcNet(l), 0);
    const priceKit = Number(line.kitPrice) || total;
    return `<div class="order-line order-line-kit-mix">
      <div>
        <p class="list-item-title">Kit mixte ${fmt(priceKit)} FCFA</p>
        <p class="list-item-sub">${escapeHtml(mix)} · ${escapeHtml(line.cat || "Autres")} · ${escapeHtml(line.paiement || "A regler")}</p>
      </div>
      <div class="line-actions">
        <button type="button" class="mini-btn" data-remove-kit-group="${escapeHtml(kg)}" data-order-id="${order.id}">Retirer le kit</button>
      </div>
    </div>`;
  }
  return `<div class="order-line"><div><p class="list-item-title">${escapeHtml(line.article)}</p><p class="list-item-sub">${escapeHtml(line.cat)} · ${escapeHtml(lineQtyPriceLabel(line, stockItemForArticle(line.article)))}${line.remise ? ` · -${fmt(line.remise)}` : ""} · ${escapeHtml(line.paiement)}</p></div><div class="line-actions"><button type="button" class="mini-btn" data-replace-line="${line.id}" data-order-id="${order.id}">Remplacer</button><button type="button" class="mini-btn" data-remove-line="${line.id}" data-order-id="${order.id}">Retirer</button></div></div>`;
}

function toggleKitMixBoard(show) {
  const panel = document.getElementById("kit-mix-board-panel");
  const btn = document.getElementById("kit-mixte-btn");
  if (!panel) return;
  const visible = show !== undefined ? Boolean(show) : panel.classList.contains("hidden");
  panel.classList.toggle("hidden", !visible);
  if (visible) panel.removeAttribute("hidden");
  else panel.setAttribute("hidden", "");
  if (btn) {
    btn.classList.toggle("active", visible);
    btn.setAttribute("aria-expanded", visible ? "true" : "false");
  }
  if (visible) {
    syncDualZonePricingUi();
    const dEl = document.getElementById("kit-board-date");
    if (dEl) dEl.value = pdjCalendarDate();
    kitMixCounts = {};
    renderKitProducts();
    window.requestAnimationFrame(() => document.getElementById("kit-board-client")?.focus());
  }
}

function openKitMixForOrder(orderId = null) {
  const oid = orderId != null ? Number(orderId) : 0;
  if (oid) {
    const order = recordsForSite(state.commandes).find((item) => item.id === oid);
    if (order) {
      activeOrderId = order.id;
      const c = document.getElementById("kit-board-client");
      const d = document.getElementById("kit-board-date");
      if (c) c.value = order.client || "";
      if (d) d.value = order.date || pdjCalendarDate();
    }
  }
  toggleKitMixBoard(true);
}

async function confirmKit() {
  readKitMixCountsFromDom();
  const size = Number(document.getElementById("kit-size")?.value) || 3;
  const price = Number(document.getElementById("kit-price")?.value) || 0;
  const location = document.getElementById("kit-location")?.value || "Intérieur";
  const nbKits = Math.max(1, Math.min(99, Math.floor(Number(document.getElementById("kit-mix-count")?.value) || 1)));
  const parts = Object.entries(kitMixCounts)
    .map(([article, qty]) => ({ article, qty: Math.max(0, Math.floor(Number(qty) || 0)) }))
    .filter((p) => p.qty > 0);
  const totalBottles = parts.reduce((s, p) => s + p.qty, 0);
  if (!parts.length) { showToast("Indiquez au moins une bouteille."); return; }
  if (price <= 0) { showToast("Saisissez le prix du kit."); return; }
  if (totalBottles !== size) {
    showToast(`Repartissez exactement ${fmt(size)} bouteille(s) par kit (actuellement ${fmt(totalBottles)}).`);
    return;
  }
  const clientName = (
    document.getElementById("kit-board-client")?.value
    || document.getElementById("v-client")?.value
    || ""
  ).trim();
  const date = document.getElementById("kit-board-date")?.value
    || document.getElementById("v-date")?.value
    || pdjCalendarDate();
  const note = document.getElementById("v-note")?.value || "";
  const selectedOrderId = Number(activeOrderId) || Number(document.getElementById("v-order-select")?.value) || 0;
  const existingOrder = selectedOrderId
    ? recordsForSite(state.commandes).find((item) => item.id === selectedOrderId)
    : null;
  if (!assertNomClientQrCommandeOuToast(clientName, existingOrder)) return;
  if (!assertCanSellOrToast(date, currentSiteId())) return;
  for (const part of parts) {
    const need = part.qty * nbKits;
    const availability = stockAvailabilityForLine(part.article, need, activeOrderId, null);
    if (!availability.stockItem || availability.available < need) {
      showToast(`Stock insuffisant : ${part.article} (besoin ${fmt(need)} btl, dispo ${fmt(availability.available)}).`);
      return;
    }
  }
  const order = ensureOrder(clientName, date, note);
  const kitBatchId = `kitbatch-${Date.now()}`;
  const mixBase = kitMixCompositionSummary(parts);
  state.nextId = state.nextId || {};
  for (let k = 0; k < nbKits; k++) {
    const kitGroupId = `${kitBatchId}-${k}`;
    const mixLabel = nbKits > 1 ? `${mixBase} (kit ${k + 1}/${nbKits})` : mixBase;
    parts.forEach((part, idx) => {
      const product = findKnownProduct(part.article, date);
      if (!product) return;
      state.nextId.ligneCommande = (Number(state.nextId.ligneCommande) || 0) + 1;
      order.lignes.push({
        id: state.nextId.ligneCommande,
        date,
        article: product.article,
        cat: product.cat || "Autres",
        location,
        formatQuantite: 1,
        packSize: 1,
        prix: idx === 0 ? price : 0,
        qty: part.qty,
        remise: 0,
        paiement: "A regler",
        kitGroupId,
        kitBatchId,
        kitPrice: price,
        kitSize: size,
        kitUnitCount: nbKits,
        kitUnitIndex: k + 1,
        kitMixLabel: idx === 0 ? mixLabel : undefined,
        saisieMode: "Kit mixte",
      });
    });
  }
  await persistState({ commandes: state.commandes, nextId: state.nextId });
  kitMixCounts = {};
  const bc = document.getElementById("kit-board-client");
  if (bc) bc.value = "";
  document.getElementById("kit-mix-count").value = "1";
  toggleKitMixBoard(false);
  renderVentesPage();
  showToast(`${kitMixOrderSummary(nbKits, size, price)} · ${mixBase}`);
}

// ─── REMPLACEMENT D'ARTICLE ───────────────────────────────────────────────────

let replacingLine = null; // { orderId, lineId, article }
let replacingVenteId = null; // id de la vente encaissee en cours de remplacement

function isOrderPaidForReplace(order) {
  const s = String(orderStatus(order) || "").trim();
  return s === "Paye" || s === "Payé" || s === "PayÃ©";
}

function replaceLineContext() {
  if (!replacingLine) return null;
  const order = recordsForSite(state.commandes).find((o) => o.id === replacingLine.orderId);
  if (!order) return null;
  const line = (order.lignes || []).find((l) => l.id === replacingLine.lineId);
  if (!line) return null;
  return { order, line };
}

/** Format catalogue aligné sur la ligne (qté / casier déjà saisis). */
function saleFormatForLine(line, product, asOfDate) {
  const stockItem = stockItemForArticle(product?.article || line?.article);
  const priceItem = stockItem || product;
  const d = asOfDate || line?.date || today();
  const formats = normalizeSaleFormats(priceItem, d);
  const wantQty = Math.max(1, Number(line.formatQuantite) || Number(line.packSize) || 1);
  return formats.find((f) => f.quantite === wantQty) || primarySaleFormat(priceItem, d);
}

function replaceLineCatalogPrice(line, product, orderDate) {
  const format = saleFormatForLine(line, product, orderDate);
  return formatPrice(format, line.location || "Intérieur");
}

function openReplaceModal(orderId, lineId) {
  const order = recordsForSite(state.commandes).find((o) => o.id === Number(orderId));
  if (!order) return;
  if (isOrderPaidForReplace(order)) {
    showToast("Commande deja encaissee : le remplacement n'est plus possible.");
    return;
  }
  const line = (order.lignes || []).find((l) => l.id === Number(lineId));
  if (!line) return;
  replacingLine = { orderId: Number(orderId), lineId: Number(lineId), article: line.article };
  const infoEl = document.getElementById("replace-current-info");
  if (infoEl) {
    infoEl.innerHTML = `Ligne a remplacer : <strong>${escapeHtml(line.article)}</strong> · ${escapeHtml(lineQtyPriceLabel(line, stockItemForArticle(line.article)))}`
      + `${order.client ? ` · ${escapeHtml(order.client)}` : ""}`
      + `<br><span class="muted" style="font-size:0.82rem">Cliquez sur le nouveau produit : la ligne est mise a jour tout de suite (avant encaissement).</span>`;
  }
  const qtyWrapCmd = document.getElementById("replace-qty-wrap");
  if (qtyWrapCmd) qtyWrapCmd.style.display = "none";
  const searchEl = document.getElementById("replace-search");
  if (searchEl) searchEl.value = "";
  renderReplacePicker("");
  openModal("modal-replace-article");
  window.requestAnimationFrame(() => searchEl?.focus());
}

function renderReplacePicker(query) {
  const picker = document.getElementById("replace-picker");
  const ctx = replaceLineContext();
  if (!picker || !ctx) return;
  const { line, order } = ctx;
  const q = (query || "").toLowerCase().trim();
  const currentKey = String(line.article || "").toLowerCase();
  const products = knownProducts(order?.date || today()).filter((p) => {
    if (p.article.toLowerCase() === currentKey) return false;
    return !q || p.article.toLowerCase().includes(q) || (p.cat || "").toLowerCase().includes(q);
  }).slice(0, 24);
  if (!products.length) {
    picker.innerHTML = `<p class="muted" style="padding:12px;font-size:0.88rem">Aucun autre produit ne correspond.</p>`;
    return;
  }
  picker.innerHTML = products.map((p) => {
    const enc = encodeURIComponent(p.article);
    const prix = replaceLineCatalogPrice(line, p, order?.date);
    const stockItem = stockItemForArticle(p.article);
    const avail = stockItem ? availableStock(stockItem) : null;
    const avLabel = avail == null ? "—" : `${fmt(avail)} btl`;
    return `<button type="button" class="vente-picker-row" data-pick-replace="${enc}">
      <span class="vente-picker-name">${escapeHtml(p.article)}</span>
      <span class="vente-picker-meta">${escapeHtml(p.cat || "—")} · ${fmt(prix)} FCFA · Stock ${avLabel}</span>
    </button>`;
  }).join("");
}

async function confirmReplace(newArticleName) {
  const article = String(newArticleName || "").trim();
  if (!replacingLine || !article) return;
  const order = recordsForSite(state.commandes).find((o) => o.id === replacingLine.orderId);
  if (!order) return;
  if (isOrderPaidForReplace(order)) {
    showToast("Commande deja encaissee : le remplacement n'est plus possible.");
    closeModal("modal-replace-article");
    replacingLine = null;
    return;
  }
  const line = (order.lignes || []).find((l) => l.id === replacingLine.lineId);
  if (!line) return;
  if (article.toLowerCase() === String(line.article || "").toLowerCase()) {
    showToast("Choisissez un produit different.");
    return;
  }
  const newProduct = findKnownProduct(article, order.date);
  if (!newProduct) {
    showToast("Produit introuvable.");
    return;
  }
  const format = saleFormatForLine(line, newProduct, order.date);
  const formatQty = Math.max(1, Number(format?.quantite) || 1);
  const prix = formatPrice(format, line.location || "Intérieur");
  if (prix <= 0) {
    showToast("Prix catalogue indisponible pour ce produit.");
    return;
  }
  const requestedBottles = (Number(line.qty) || 1) * formatQty;
  const availability = stockAvailabilityForLine(newProduct.article, requestedBottles, order.id, line.id);
  if (!availability.stockItem || availability.available < requestedBottles) {
    showToast(`Stock insuffisant pour ${newProduct.article}. Disponible : ${fmt(availability.available)} bouteille(s).`);
    return;
  }
  const prevArticle = line.article;
  const prevNet = calcNet(line);
  line.article = newProduct.article;
  line.cat = newProduct.cat || line.cat;
  line.formatQuantite = formatQty;
  line.prix = prix;
  recordStaffAudit(
    "update",
    "commande_ligne",
    `Remplacement · commande #${order.id} · ${order.client || ""}`,
    `${prevArticle} → ${line.article} · ${fmt(prevNet)} → ${fmt(calcNet(line))} FCFA`,
  );
  await persistState({ commandes: state.commandes });
  closeModal("modal-replace-article");
  replacingLine = null;
  renderVentesPage();
  showToast(`${prevArticle} remplace par ${line.article} (${fmt(calcNet(line))} FCFA).`);
}

function openReplaceVenteModal(venteId) {
  const vente = recordsForSite(state.ventes).find((v) => v.id === Number(venteId));
  if (!vente) return;
  ensureVentePackMetadata(vente);
  replacingVenteId = Number(venteId);
  replacingLine = null;
  const si = stockItemForArticle(vente.article);
  const pack = linePackSize(vente, si);
  const bottles = lineBottleQty(vente, si);
  const infoEl = document.getElementById("replace-current-info");
  if (infoEl) {
    infoEl.innerHTML = `Article encaisse a remplacer : <strong>${escapeHtml(vente.article)}</strong>`
      + ` · ${escapeHtml(lineQtyPriceLabel(vente, si))}`
      + `${vente.client ? ` · ${escapeHtml(vente.client)}` : ""}`
      + ` · Facture ${escapeHtml(vente.factureNumber || "")}`
      + `<br><span class="muted" style="font-size:0.82rem">Le stock de l'ancien article sera restitue (${fmt(bottles)} btl)`
      + `, le prix et le stock du nouveau seront appliques${pack > 1 ? ` (par kit de ${fmt(pack)} btl)` : ""}.</span>`;
  }
  const qtyWrap = document.getElementById("replace-qty-wrap");
  const qtyInput = document.getElementById("replace-qty");
  if (qtyWrap) qtyWrap.style.display = "";
  if (qtyInput) qtyInput.value = String(Math.max(1, Number(vente.qty) || 1));
  syncReplaceQtyFieldLabel(vente);
  const searchEl = document.getElementById("replace-search");
  if (searchEl) searchEl.value = "";
  renderReplaceVentePicker("", vente);
  openModal("modal-replace-article");
  window.requestAnimationFrame(() => searchEl?.focus());
}

function renderReplaceVentePicker(query, vente) {
  const picker = document.getElementById("replace-picker");
  if (!picker || !vente) return;
  const q = (query || "").toLowerCase().trim();
  const currentKey = String(vente.article || "").toLowerCase();
  const products = knownProducts(vente.date || today()).filter((p) => {
    if (p.article.toLowerCase() === currentKey) return false;
    return !q || p.article.toLowerCase().includes(q) || (p.cat || "").toLowerCase().includes(q);
  }).slice(0, 24);
  if (!products.length) {
    picker.innerHTML = `<p class="muted" style="padding:12px;font-size:0.88rem">Aucun autre produit ne correspond.</p>`;
    return;
  }
  picker.innerHTML = products.map((p) => {
    const enc = encodeURIComponent(p.article);
    const stockItem = stockItemForArticle(p.article);
    const format = saleFormatForLine(vente, p, vente.date);
    const newPrix = formatPrice(format, vente.location || "Intérieur");
    const avail = stockItem ? availableStock(stockItem) : null;
    const avLabel = avail == null ? "—" : `${fmt(avail)} btl`;
    return `<button type="button" class="vente-picker-row" data-pick-replace="${enc}">
      <span class="vente-picker-name">${escapeHtml(p.article)}</span>
      <span class="vente-picker-meta">${escapeHtml(p.cat || "—")} · ${fmt(newPrix)} FCFA · Stock ${avLabel}</span>
    </button>`;
  }).join("");
}

// Donnees en attente d'un supplement d'encaissement (remplacement article prix superieur)
let _pendingSupplement = null;

async function confirmReplaceVente(newArticleName) {
  const article = String(newArticleName || "").trim();
  if (!replacingVenteId || !article) return;
  const siteId = currentSiteId();
  const vente = (state.ventes || []).find((v) => v.id === replacingVenteId && (v.siteId || siteId) === siteId);
  if (!vente) {
    showToast("Vente introuvable.");
    closeModal("modal-replace-article");
    replacingVenteId = null;
    return;
  }
  if (article.toLowerCase() === String(vente.article || "").toLowerCase()) {
    showToast("Choisissez un produit different.");
    return;
  }
  ensureVentePackMetadata(vente);
  // Quantite saisie = nombre de kits (ou d'unites) ; le stock utilise qty × formatQuantite
  const qtyInput = document.getElementById("replace-qty");
  const newQty = Math.max(1, Math.floor(Number(qtyInput?.value) || Number(vente.qty) || 1));
  const originalQty = Math.max(1, Number(vente.qty) || 1);
  const newProduct = findKnownProduct(article, vente.date);
  if (!newProduct) {
    showToast("Produit introuvable dans le catalogue.");
    return;
  }
  const oldStockItem = stockItemForArticle(vente.article, siteId);
  // Bouteilles a restituer (basees sur la quantite originale de la vente)
  const oldBottles = lineBottleQty(vente, oldStockItem);
  const newStockItem = stockItemForArticle(newProduct.article, siteId);
  if (!newStockItem) {
    showToast(`Article "${newProduct.article}" sans fiche stock.`);
    return;
  }
  const newFormat = saleFormatForLine({ ...vente, qty: newQty }, newProduct, vente.date);
  const newFormatQty = Math.max(1, Number(newFormat?.quantite) || 1);
  const newBottles = newQty * newFormatQty;
  if (availableStock(newStockItem) < newBottles) {
    showToast(`Stock insuffisant pour ${newProduct.article}. Disponible : ${fmt(availableStock(newStockItem))} bouteille(s) (besoin : ${fmt(newBottles)}).`);
    return;
  }
  const newPrix = formatPrice(newFormat, vente.location || "Intérieur");
  const prevArticle = vente.article;
  const prevPrix = Number(vente.prix) || 0;
  const oldTotal = prevPrix * originalQty;
  const newTotal = newPrix * newQty;
  const diff = Math.round(newTotal - oldTotal);
  const oldPack = linePackSize(vente, oldStockItem);
  const qtyLine = newQty !== originalQty
    ? `\nQuantité : ${originalQty} → ${newQty}${oldPack > 1 ? ` kit(s) (${fmt(originalQty * oldPack)} → ${fmt(newQty * newFormatQty)} btl)` : ""}`
    : (oldPack > 1 ? `\n${fmt(originalQty)} kit(s) = ${fmt(oldBottles)} btl` : "");
  const prixLine = (newPrix !== prevPrix || newQty !== originalQty)
    ? `\nMontant : ${fmt(prevPrix)} × ${originalQty}${oldPack > 1 ? " kit" : ""} = ${fmt(oldTotal)} FCFA → ${fmt(newPrix)} × ${newQty}${newFormatQty > 1 ? " kit" : ""} = ${fmt(newTotal)} FCFA`
    + (diff > 0 ? ` — supplément ${fmt(diff)} FCFA à encaisser` : diff < 0 ? ` — différence ${fmt(Math.abs(diff))} FCFA` : "")
    : "";
  if (!window.confirm(
    `Remplacer "${prevArticle}" par "${newProduct.article}" sur la facture ${vente.factureNumber || "#" + vente.id} ?`
    + `${qtyLine}\nStock restitué : ${prevArticle} +${oldBottles} btl\nStock débité : ${newProduct.article} -${newBottles} btl`
    + prixLine,
  )) return;
  // Restituer le stock de l'ancien article (quantite originale)
  if (oldStockItem) {
    oldStockItem.sorties = Math.max(0, (Number(oldStockItem.sorties) || 0) - oldBottles);
    oldStockItem.frigo = (Number(oldStockItem.frigo) || 0) + oldBottles;
  }
  // Consommer le stock du nouvel article (nouvelle quantite)
  newStockItem.sorties = (Number(newStockItem.sorties) || 0) + newBottles;
  newStockItem.lastSortieAt = new Date().toISOString();
  newStockItem.lastSortieBy = sessionUser || "-";
  consumePhysicalStock(newStockItem, newBottles);
  // Mettre a jour la vente
  vente.article = newProduct.article;
  vente.cat = newProduct.cat || vente.cat;
  vente.qty = newQty;
  vente.formatQuantite = newFormatQty;
  if (newPrix > 0) vente.prix = newPrix;
  recordStaffAudit(
    "update", "vente",
    `Remplacement article · Facture ${vente.factureNumber || "#" + vente.id} · ${vente.client || ""}`,
    `${prevArticle} ×${originalQty} → ${vente.article} ×${newQty} · ${oldBottles} btl → ${newBottles} btl · ${fmt(oldTotal)} → ${fmt(newTotal)} FCFA`,
  );
  closeModal("modal-replace-article");
  replacingVenteId = null;
  if (diff > 0) {
    // Montant superieur : ouvrir l'encaissement du supplement avant de sauvegarder
    _pendingSupplement = { vente, diff };
    openSupplementModal(diff, newProduct.article, vente.client, vente.factureNumber);
  } else {
    await persistState({ ventes: state.ventes, stock: state.stock, staffAuditLog: state.staffAuditLog });
    renderSalesHistory();
    if (currentPage === "stock") renderStock();
    if (currentPage === "home") renderDashboard();
    showToast(`"${prevArticle}" ×${originalQty} → "${vente.article}" ×${newQty} · Stock ajuste.`);
  }
}

function openSupplementModal(diff, article, client, factureNumber) {
  document.getElementById("supplement-desc").textContent =
    `Supplément pour "${article}"${client ? ` · ${client}` : ""}${factureNumber ? ` · ${factureNumber}` : ""}`;
  document.getElementById("supplement-amount").textContent = `${fmt(diff)} FCFA`;
  document.querySelectorAll(".supp-pay-input").forEach((i) => { i.value = ""; });
  document.getElementById("supp-credit-name").value = "";
  document.getElementById("supp-reste").textContent = `Reste : ${fmt(diff)} FCFA`;
  document.getElementById("supp-reste").style.color = "#ff8e82";
  openModal("modal-supplement");
  document.getElementById("supp-cash")?.focus();
}

async function confirmSupplement() {
  if (!_pendingSupplement) return;
  const { vente, diff } = _pendingSupplement;
  const inputs = [
    ["Espèces", "supp-cash"],
    ["Wave", "supp-wave"],
    ["Orange Money", "supp-orange"],
    ["MTN MoMo", "supp-mtn"],
    ["Carte", "supp-card"],
    ["Crédit client", "supp-credit"],
  ].map(([method, id]) => ({ method, amount: Number(document.getElementById(id)?.value) || 0 }))
    .filter((item) => item.amount > 0);
  const paid = inputs.reduce((s, i) => s + i.amount, 0);
  if (!inputs.length) { showToast("Renseignez au moins un montant."); return; }
  if (Math.round(paid) !== Math.round(diff)) {
    showToast(`Le total saisi (${fmt(paid)} FCFA) doit être égal à ${fmt(diff)} FCFA.`);
    return;
  }
  const creditName = document.getElementById("supp-credit-name").value.trim();
  if (inputs.some((i) => isCreditClientMethod(i.method)) && !creditName) {
    showToast("Le nom du debiteur est obligatoire pour un credit client.");
    return;
  }
  const paymentMethod = inputs.length > 1 ? "Mixte" : inputs[0].method;
  // Enregistrer une vente supplementaire pour la difference
  const suppVente = {
    id: state.nextId.vente++,
    siteId: vente.siteId || currentSiteId(),
    factureNumber: vente.factureNumber,
    date: vente.date,
    soldAt: new Date().toISOString(),
    client: vente.client,
    table: vente.table,
    article: vente.article,
    cat: vente.cat,
    prix: diff,
    qty: 1,
    formatQuantite: 1,
    packSize: 1,
    remise: 0,
    paiement: paymentMethod,
    paiementDetails: inputs.map((i) => ({ method: i.method, amount: i.amount })),
    debiteur: creditName || undefined,
    server: vente.server || sessionUser || "",
    serveur: vente.serveur || sessionUser || "",
    note: "Supplément remplacement article",
  };
  state.ventes = [suppVente, ...state.ventes];
  recordStaffAudit(
    "create", "encaissement",
    `Supplément · Facture ${vente.factureNumber || ""} · ${vente.client || ""}`,
    `${fmt(diff)} FCFA · ${paymentMethod}`,
  );
  const suppBtn = document.getElementById("confirm-supplement-btn");
  const prevSuppText = suppBtn ? suppBtn.textContent : "";
  if (suppBtn) { suppBtn.disabled = true; suppBtn.textContent = "Enregistrement…"; }
  try {
    await persistState({ ventes: state.ventes, stock: state.stock, staffAuditLog: state.staffAuditLog, nextId: state.nextId });
    _pendingSupplement = null;
    closeModal("modal-supplement");
    renderSalesHistory();
    if (currentPage === "stock") renderStock();
    if (currentPage === "home") renderDashboard();
    showToast(`Supplément ${fmt(diff)} FCFA encaisse — ${paymentMethod}.`);
  } finally {
    if (suppBtn) { suppBtn.disabled = false; suppBtn.textContent = prevSuppText; }
  }
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
  const site = currentSite();
  renderStockFilterBar(allItems, site);
  const term = String(stockSearchTerm || "").trim().toLowerCase();
  let items = term
    ? allItems.filter((item) => String(item.article || "").toLowerCase().includes(term))
    : allItems;
  if (stockCatFilter !== "all") {
    items = items.filter((item) => String(item.cat || "") === stockCatFilter);
  }
  if (stockStatusFilter !== "all") {
    if (stockStatusFilter === "alert") {
      items = items.filter((item) => stockRowStatusKey(item, site) !== "ok");
    } else {
      items = items.filter((item) => stockRowStatusKey(item, site) === stockStatusFilter);
    }
  }
  const dualPricing = siteUsesDualZonePricing(site);
  const globalSeuil = Number(site?.seuilStock) || 5;
  // Valeur totale au coût d'achat sur TOUS les articles (pas seulement le filtre).
  const priceDay = today();
  const totalValue = allItems.reduce((sum, item) => sum + stockPurchaseValueFcfa(item), 0);
  let nbAlerte = 0;
  let nbOk = 0;

  const rows = items.map((item) => {
    const actuel = stockActuel(item);
    const frigo = stockFrigo(item);
    const reserve = stockReserve(item);
    const valeur = stockPurchaseValueFcfa(item);
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
    const { prixInt, prixExt } = resolveItemPrices(item, priceDay);
    const paBtl = prixAchatParBouteille(item);
    const margeInt = stockMarginPerBottle(item, "int", site, priceDay);
    const margeExt = stockMarginPerBottle(item, "ext", site, priceDay);
    const margeCasInt = stockMarginPerCase(item, "int", site, priceDay);
    const margeCasExt = stockMarginPerCase(item, "ext", site, priceDay);
    const promoBadge = promotionBadgeHtml(item, priceDay);
    const packCell = packSize > 1 ? `<span class="badge badge-amber">Kit de ${packSize}</span>` : `<span style="color:var(--muted)">Unite</span>`;
    const itemCaseSize = caseSize(item);
    const majIso = stockItemLastUpdatedAt(item);
    const statusKey = stockRowStatusKey(item, site);
    const majLabel = formatStockMajLabel(majIso);
    const majClass = stockMajCssClass(majIso, statusKey);

    const D = "scd"; // classe colonne detail
    return `<tr class="${isAlert ? "stock-row-alert" : ""}">
      <td>${escapeHtml(item.article)} ${promoBadge}</td>
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
      <td class="${D}" style="text-align:right">${paBtl > 0 ? fmt(Math.round(paBtl)) : "—"}</td>
      ${dualPricing
      ? `<td class="${D}" style="text-align:right">${fmt(prixInt)}</td>
      <td class="${D}" style="text-align:right">${fmt(prixExt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeInt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeExt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeCasInt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeCasExt)}</td>`
      : `<td class="${D}" style="text-align:right">${fmt(prixInt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeInt)}</td>
      <td class="${D}" style="text-align:right">${formatMarginFcfa(margeCasInt)}</td>`}
      <td class="${D}" style="text-align:right">${fmt(valeur)}</td>
      <td>${statusBadge}</td>
      <td class="stock-maj-cell ${majClass}" title="${escapeHtml(majIso || "")}">${escapeHtml(majLabel)}</td>
      <td class="stock-actions-cell">
        ${isFrigoLow && reserve > 0 ? `<button type="button" class="mini-btn" data-auto-fill-fridge="${item.id}">Remplir frigo</button>` : ""}
        <button type="button" class="stock-del-btn" style="background:rgba(197,79,65,0.18);color:#ff8e82" data-perte-id="${item.id}">Perte</button>
        ${canEditStockCatalog() ? `<button type="button" class="mini-btn" data-edit-stock="${item.id}">Modifier</button>` : ""}
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
    ? `<div class="stock-table-wrap" id="main-stock-table-wrap"><table class="stock-table${stockTableCompact ? " stock-compact" : ""}">
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
            <th class="th-orange scd" style="text-align:right">PA / btl.</th>
            ${dualPricing
            ? `<th class="th-orange scd" style="text-align:right">Prix Vente Int.</th>
            <th class="th-orange scd" style="text-align:right">Prix Vente Ext.</th>
            <th class="th-orange scd" style="text-align:right">Marge / btl. Int.</th>
            <th class="th-orange scd" style="text-align:right">Marge / btl. Ext.</th>
            <th class="th-orange scd" style="text-align:right">Marge / cas. Int.</th>
            <th class="th-orange scd" style="text-align:right">Marge / cas. Ext.</th>`
            : `<th class="th-orange scd" style="text-align:right">Prix vente</th>
            <th class="th-orange scd" style="text-align:right">Marge / btl.</th>
            <th class="th-orange scd" style="text-align:right">Marge / cas.</th>`}
            <th class="th-blue scd" style="text-align:right">Valeur stock</th>
            <th class="th-blue">Statut</th>
            <th class="th-blue">MAJ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table></div>`
    : term
      ? emptyState("Aucun resultat", `Aucun article ne correspond a "${stockSearchTerm}".`)
      : emptyState("Stock vide", "Ajoutez un article pour construire le catalogue.");
  initStockScrollMirror();
  renderStockMovements();
}

function initStockScrollMirror() {
  const wrap = document.getElementById("main-stock-table-wrap");
  if (!wrap) return;
  const table = wrap.querySelector("table");
  if (!table) return;
  const mirror = document.createElement("div");
  mirror.className = "stock-scroll-mirror";
  mirror.innerHTML = `<div style="height:1px;width:${table.scrollWidth}px"></div>`;
  wrap.parentNode.insertBefore(mirror, wrap);
  let syncing = false;
  mirror.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    wrap.scrollLeft = mirror.scrollLeft;
    syncing = false;
  }, { passive: true });
  wrap.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    mirror.scrollLeft = wrap.scrollLeft;
    syncing = false;
  }, { passive: true });
}

function renderCharges() {
  const chargesForSite = recordsForSite(state.charges);
  const total = chargesForSite.reduce((sum, charge) => sum + Number(charge.montant || 0), 0);
  document.getElementById("charges-total").textContent = `${fmt(total)} FCFA`;
  const charges = chargesForSite.slice().sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("charges-list").innerHTML = charges.length
    ? charges.map((charge) => `<article class="list-item"><div><p class="list-item-title">${escapeHtml(charge.lib)}</p><p class="list-item-sub">${escapeHtml(charge.cat)} · ${escapeHtml(charge.paiement)}</p></div><div class="list-side"><div><p class="list-item-amount" style="color:#ff8e82">${fmt(charge.montant)} FCFA</p><p class="list-item-date">${escapeHtml(formatDateDdMmYyyy(charge.date))}</p></div>${canDeleteCharge() ? `<button class="del-btn" type="button" data-delete-type="charge" data-id="${charge.id}">Suppr.</button>` : ""}</div></article>`).join("")
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
          ${canDeleteCharge() ? `<button class="del-btn" type="button" data-delete-type="charge" data-id="${charge.id}">Suppr.</button>` : ""}
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
  const visibleSites = canGlobalSuperAdmin()
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
  const visibleSites = canGlobalSuperAdmin()
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
  document.getElementById("new-user-password").placeholder = "Obligatoire à la création";
  const pWaUser = document.getElementById("new-user-wa-phone");
  if (pWaUser) pWaUser.value = "";
  document.getElementById("add-user-btn").textContent = "Enregistrer";
  const formCard = document.getElementById("user-form-card");
  if (formCard) formCard.style.display = "none";
  const toggleBtn = document.getElementById("toggle-add-user-form-btn");
  if (toggleBtn) toggleBtn.textContent = "+ Ajouter";
  const titleEl = document.getElementById("user-form-title");
  if (titleEl) titleEl.textContent = "Nouvel utilisateur";
  const metaEl = document.getElementById("user-form-meta");
  if (metaEl) metaEl.textContent = "Remplissez les champs ci-dessous";
  const crSel = document.getElementById("new-user-custom-role");
  if (crSel) crSel.value = "";
  renderUserSiteCheckboxes();
  populateCustomRoleSelect();
  renderPermissionCheckboxes();
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
  const pWaUserEdit = document.getElementById("new-user-wa-phone");
  if (pWaUserEdit) pWaUserEdit.value = user.waPhone || "";
  const pWa2faUserEdit = document.getElementById("new-user-wa2fa");
  if (pWa2faUserEdit) pWa2faUserEdit.checked = user.wa2faEnabled || false;
  document.getElementById("add-user-btn").textContent = "Enregistrer les modifications";
  const formCard = document.getElementById("user-form-card");
  if (formCard) { formCard.style.display = ""; formCard.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  const titleEl = document.getElementById("user-form-title");
  if (titleEl) titleEl.textContent = `Modifier — ${user.username}`;
  const metaEl = document.getElementById("user-form-meta");
  if (metaEl) metaEl.textContent = roleLabel(user.role, user.username);
  const toggleBtn = document.getElementById("toggle-add-user-form-btn");
  if (toggleBtn) toggleBtn.textContent = "Fermer";
  populateCustomRoleSelect();
  const crSel = document.getElementById("new-user-custom-role");
  if (crSel) crSel.value = user.customRoleId || "";
  renderPermissionCheckboxes(user);
  renderEditableUserSites(user);
}

/** Libellé affiché dans l'en-tête : nom complet si renseigné, sinon identifiant. */
function sessionUserDisplayLabel() {
  const sn = String(sessionUser || "").trim();
  if (!sn || !state) return sn;
  const u = (state.auth?.users || []).find((x) => String(x.username || "").trim().toLowerCase() === sn.toLowerCase());
  const full = String(u?.displayName || "").trim();
  return full || sn;
}

function roleLabel(role, username = "") {
  if (String(username || "").trim().toLowerCase() === "admin") return "Super administrateur";
  if (role === "superadmin") return "Super administrateur";
  if (role === "admin") return "Administrateur de maquis";
  if (role === "manager") return "Gérant";
  return "Serveuse";
}

// ── Système de permissions ───────────────────────────────────────────────────

const PERMISSIONS_DEF = [
  { id: "ventes",       label: "Ventes",       desc: "Prendre commandes et encaisser" },
  { id: "stock",        label: "Stock",         desc: "Voir et modifier le stock" },
  { id: "caisse",       label: "Caisse / PDJ",  desc: "Point du jour et clôtures" },
  { id: "charges",      label: "Charges",       desc: "Saisir les dépenses" },
  { id: "catalogue",    label: "Catalogue",     desc: "Gérer les produits et prix" },
  { id: "rapports",     label: "Rapports",      desc: "Historique et statistiques" },
  { id: "utilisateurs", label: "Utilisateurs",  desc: "Gérer les comptes" },
  { id: "parametres",   label: "Paramètres",    desc: "Configurer le maquis" },
];

const DEFAULT_ROLE_PERMISSIONS = {
  superadmin: { ventes:true, stock:true, caisse:true, charges:true, catalogue:true, rapports:true, utilisateurs:true, parametres:true },
  admin:      { ventes:true, stock:true, caisse:true, charges:true, catalogue:true, rapports:true, utilisateurs:true, parametres:true },
  manager:    { ventes:true, stock:true, caisse:true, charges:true, catalogue:true, rapports:true, utilisateurs:false, parametres:true },
  serveuse:   { ventes:true, stock:false, caisse:false, charges:false, catalogue:false, rapports:false, utilisateurs:false, parametres:false },
};

function getUserPermissions(user) {
  if (!user) return {};
  // 1. Rôle custom du maquis actif
  if (user.customRoleId) {
    const site = currentSite();
    const cr = (site?.customRoles || []).find((r) => r.id === user.customRoleId);
    if (cr?.permissions) return cr.permissions;
  }
  // 2. Permissions explicites sur le compte
  if (user.permissions && typeof user.permissions === "object") return user.permissions;
  // 3. Par défaut selon le rôle système
  return DEFAULT_ROLE_PERMISSIONS[user.role] || DEFAULT_ROLE_PERMISSIONS.serveuse;
}

function hasPermission(permId) {
  if (!state || !sessionUser) return false;
  const me = (state.auth?.users || []).find((u) => String(u.username || "").toLowerCase() === String(sessionUser || "").toLowerCase());
  if (!me) return false;
  if (String(me.username || "").toLowerCase() === "admin" || me.role === "superadmin") return true;
  const perms = getUserPermissions(me);
  return perms[permId] === true;
}

function renderPermissionCheckboxes(targetUser = null) {
  const container = document.getElementById("new-user-permissions");
  const sourceLabel = document.getElementById("perm-source-label");
  if (!container) return;
  const role = document.getElementById("new-user-role")?.value || "serveuse";
  const customRoleId = document.getElementById("new-user-custom-role")?.value || "";
  let perms = {};
  let source = "";
  if (customRoleId) {
    const site = currentSite();
    const cr = (site?.customRoles || []).find((r) => r.id === customRoleId);
    perms = cr?.permissions || {};
    source = `(hérité du rôle « ${escapeHtml(cr?.nom || customRoleId)} »)`;
  } else if (targetUser?.permissions && !customRoleId) {
    perms = targetUser.permissions;
    source = "(permissions personnalisées)";
  } else {
    perms = DEFAULT_ROLE_PERMISSIONS[role] || DEFAULT_ROLE_PERMISSIONS.serveuse;
    source = `(défaut ${roleLabel(role)})`;
  }
  if (sourceLabel) sourceLabel.textContent = source;
  const locked = Boolean(customRoleId);
  container.innerHTML = PERMISSIONS_DEF.map((p) => `
    <label style="display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid var(--line,#e5e7eb);cursor:${locked ? "default" : "pointer"};background:var(--mm-surface,#fff)">
      <input type="checkbox" data-perm="${p.id}" ${perms[p.id] ? "checked" : ""} ${locked ? "disabled" : ""} style="margin-top:2px;accent-color:#2563eb">
      <span>
        <span style="font-weight:600;font-size:0.88rem;display:block">${p.label}</span>
        <span style="font-size:0.76rem;color:var(--muted,#888)">${p.desc}</span>
      </span>
    </label>
  `).join("");
}

function populateCustomRoleSelect() {
  const sel = document.getElementById("new-user-custom-role");
  if (!sel) return;
  const site = currentSite();
  const roles = site?.customRoles || [];
  const current = sel.value;
  sel.innerHTML = `<option value="">— Permissions par défaut du rôle —</option>` +
    roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.nom)}</option>`).join("");
  if (current && roles.some((r) => r.id === current)) sel.value = current;
}

function renderCustomRolesList() {
  const container = document.getElementById("custom-roles-list");
  const siteLabel = document.getElementById("custom-roles-site-label");
  if (!container) return;
  const site = currentSite();
  if (siteLabel) siteLabel.textContent = site?.nom || "Maquis courant";
  const roles = site?.customRoles || [];
  if (!roles.length) {
    container.innerHTML = `<p class="muted" style="font-size:0.85rem">Aucun rôle personnalisé. Créez-en un ci-dessous.</p>`;
    return;
  }
  container.innerHTML = roles.map((r) => {
    const activePerms = PERMISSIONS_DEF.filter((p) => r.permissions?.[p.id]).map((p) => p.label).join(", ") || "Aucune";
    return `
      <div style="display:flex;align-items:flex-start;gap:10px;padding:10px 14px;border-radius:12px;border:1px solid var(--line,#e5e7eb);background:var(--mm-surface,#fff)">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;margin-bottom:3px">${escapeHtml(r.nom)}</div>
          <div style="font-size:0.78rem;color:var(--muted,#888);line-height:1.4">${escapeHtml(activePerms)}</div>
          <div id="perm-edit-${escapeHtml(r.id)}" style="display:none;margin-top:8px;display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
          <button type="button" class="mini-btn" data-edit-role="${escapeHtml(r.id)}">Modifier</button>
          <button type="button" class="mini-btn mini-btn--warn" data-delete-role="${escapeHtml(r.id)}">Supprimer</button>
        </div>
      </div>
    `;
  }).join("");
}

async function saveCustomRole(roleId = null) {
  const site = currentSite();
  if (!site) return;
  const nomInput = document.getElementById("new-role-name");
  const nom = String(nomInput?.value || "").trim();
  if (!nom) { showToast("Nom du rôle obligatoire."); return; }
  const perms = {};
  document.querySelectorAll("[data-role-perm]").forEach((cb) => { perms[cb.dataset.rolePerm] = cb.checked; });
  const sites = state.sites.map((s) => {
    if (s.id !== site.id) return s;
    const existing = s.customRoles || [];
    let updated;
    if (roleId) {
      updated = existing.map((r) => r.id === roleId ? { ...r, nom, permissions: perms } : r);
    } else {
      const id = "cr-" + Date.now();
      updated = [...existing, { id, nom, permissions: perms }];
    }
    return { ...s, customRoles: updated };
  });
  await persistState({ sites });
  if (nomInput) nomInput.value = "";
  document.getElementById("role-perm-form")?.remove();
  renderCustomRolesList();
  populateCustomRoleSelect();
  showToast(roleId ? `Rôle « ${nom} » modifié.` : `Rôle « ${nom} » créé.`);
}

async function deleteCustomRole(roleId) {
  const site = currentSite();
  if (!site) return;
  const role = (site.customRoles || []).find((r) => r.id === roleId);
  if (!window.confirm(`Supprimer le rôle « ${role?.nom || roleId} » ?`)) return;
  const sites = state.sites.map((s) => {
    if (s.id !== site.id) return s;
    return { ...s, customRoles: (s.customRoles || []).filter((r) => r.id !== roleId) };
  });
  await persistState({ sites });
  renderCustomRolesList();
  populateCustomRoleSelect();
  showToast("Rôle supprimé.");
}

function showRolePermForm(roleId = null) {
  document.getElementById("role-perm-form")?.remove();
  const site = currentSite();
  const existing = roleId ? (site?.customRoles || []).find((r) => r.id === roleId) : null;
  const perms = existing?.permissions || {};
  const form = document.createElement("div");
  form.id = "role-perm-form";
  form.style.cssText = "margin-top:12px;padding:12px;border-radius:12px;border:1px solid var(--line);background:var(--mm-surface,#fff)";
  form.innerHTML = `
    <p style="font-weight:600;margin-bottom:10px;font-size:0.9rem">${existing ? `Modifier « ${escapeHtml(existing.nom)} »` : "Permissions du nouveau rôle"}</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;margin-bottom:10px">
      ${PERMISSIONS_DEF.map((p) => `
        <label style="display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;border:1px solid var(--line);cursor:pointer;font-size:0.85rem">
          <input type="checkbox" data-role-perm="${p.id}" ${perms[p.id] ? "checked" : ""} style="accent-color:#2563eb">
          ${p.label}
        </label>
      `).join("")}
    </div>
    <div style="display:flex;gap:8px">
      <button type="button" class="btn btn-primary" style="font-size:0.88rem" onclick="saveCustomRole(${roleId ? `'${roleId}'` : "null"}).catch(handleApiError)">Enregistrer</button>
      <button type="button" class="btn btn-outline" style="font-size:0.88rem" onclick="document.getElementById('role-perm-form')?.remove()">Annuler</button>
    </div>
  `;
  document.getElementById("add-custom-role-btn")?.after(form);
}

function _userRoleColor(role, username) {
  if (String(username || "").trim().toLowerCase() === "admin" || role === "superadmin") return "#7c3aed";
  if (role === "admin") return "#2563eb";
  if (role === "manager") return "#0891b2";
  return "#059669";
}

function _userInitials(user) {
  const name = String(user.displayName || user.username || "?").trim();
  const parts = name.split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

function renderUsersList() {
  const container = document.getElementById("users-list");
  if (!container) return;
  const search = String(document.getElementById("users-search")?.value || "").trim().toLowerCase();
  const allUsers = state.auth.users || [];
  let users = canSuperAdmin() || canSiteAdmin()
    ? allUsers
    : allUsers.filter((u) => u.role === "serveuse" && (u.allowedSiteIds || []).some((sid) => allowedSiteIds.includes(sid)));
  if (search) {
    users = users.filter((u) =>
      String(u.username || "").toLowerCase().includes(search) ||
      String(u.displayName || "").toLowerCase().includes(search) ||
      roleLabel(u.role, u.username).toLowerCase().includes(search)
    );
  }

  // Compteurs
  const statsEl = document.getElementById("users-stats");
  if (statsEl) {
    const counts = {};
    allUsers.forEach((u) => { counts[u.role] = (counts[u.role] || 0) + 1; });
    const parts = [];
    if (counts.superadmin || counts.admin) parts.push(`${(counts.superadmin || 0) + (counts.admin || 0)} admin`);
    if (counts.manager) parts.push(`${counts.manager} gérant${counts.manager > 1 ? "s" : ""}`);
    if (counts.serveuse) parts.push(`${counts.serveuse} serveuse${counts.serveuse > 1 ? "s" : ""}`);
    statsEl.textContent = parts.join(" · ");
  }

  if (!users.length) {
    container.innerHTML = emptyState(search ? "Aucun résultat" : "Aucun utilisateur", search ? `Aucun compte ne correspond à « ${escapeHtml(search)} ».` : "Cliquez sur « + Ajouter » pour créer un compte.");
    return;
  }

  container.innerHTML = users.map((user) => {
    const color = _userRoleColor(user.role, user.username);
    const initials = escapeHtml(_userInitials(user));
    const label = roleLabel(user.role, user.username);
    const siteNames = (user.allowedSiteIds || []).map((sid) => {
      const site = (state.sites || []).find((s) => s.id === sid);
      return escapeHtml(site ? site.nom : sid);
    }).join(" · ") || "Aucun maquis";
    const isSelf = user.username === sessionUser;
    const canEdit = canAnyAdmin() || user.role === "serveuse";
    const canDelete = !isSelf && (canAnyAdmin() || user.role === "serveuse");
    const waTag = user.waPhone ? `<span style="font-size:0.78rem;color:var(--muted,#888)">📱 ${escapeHtml(user.waPhone)}</span>` : "";
    const twoFaTag = user.twoFactorEnabled
      ? `<span style="font-size:0.75rem;padding:2px 7px;border-radius:20px;background:#dcfce7;color:#166534;font-weight:600">2FA</span>`
      : `<span style="font-size:0.75rem;padding:2px 7px;border-radius:20px;background:#fef9c3;color:#713f12">Sans 2FA</span>`;
    const selfTag = isSelf ? `<span style="font-size:0.75rem;padding:2px 7px;border-radius:20px;background:#eff6ff;color:#1d4ed8;font-weight:600">Connecté(e)</span>` : "";
    return `
      <div style="display:flex;align-items:center;gap:12px;background:var(--mm-surface,#fff);border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:12px 14px;transition:box-shadow .15s" onmouseover="this.style.boxShadow='0 2px 12px rgba(0,0,0,0.08)'" onmouseout="this.style.boxShadow=''">
        <div style="width:42px;height:42px;border-radius:50%;background:${color};color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.95rem;font-weight:700;flex-shrink:0">${initials}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px">
            <span style="font-weight:600;font-size:0.96rem">${escapeHtml(user.username)}</span>
            ${user.displayName ? `<span style="color:var(--muted,#888);font-size:0.85rem">· ${escapeHtml(String(user.displayName).trim())}</span>` : ""}
            <span style="font-size:0.75rem;padding:2px 8px;border-radius:20px;background:${color}22;color:${color};font-weight:600">${escapeHtml(label)}</span>
            ${twoFaTag}${selfTag}
          </div>
          <div style="font-size:0.82rem;color:var(--muted,#888);display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <span>${siteNames}</span>
            ${waTag}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:5px;flex-shrink:0">
          ${canEdit ? `<button type="button" class="mini-btn" data-edit-user="${escapeHtml(user.username)}">Modifier</button>` : ""}
          ${canDelete ? `<button type="button" class="mini-btn mini-btn--warn" data-delete-user="${escapeHtml(user.username)}">Supprimer</button>` : ""}
          ${user.twoFactorEnabled
            ? `<button type="button" class="mini-btn" data-disable-2fa="${escapeHtml(user.username)}">Désactiver 2FA</button>`
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
  if (!canGlobalSuperAdmin() && role === "superadmin") {
    showToast("Seul le super administrateur global peut creer un super administrateur.");
    return;
  }
  if (!canGlobalSuperAdmin() && role === "admin") {
    showToast("Seul le super administrateur global peut creer un administrateur de maquis.");
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
  const waPhone = (document.getElementById("new-user-wa-phone")?.value || "").trim();
  const wa2faEnabled = document.getElementById("new-user-wa2fa")?.checked || false;
  const customRoleId = (document.getElementById("new-user-custom-role")?.value || "").trim();
  const permChecks = document.querySelectorAll("[data-perm]");
  const permissions = {};
  permChecks.forEach((cb) => { permissions[cb.dataset.perm] = cb.checked; });
  const newUsers = editUsername
    ? users.map((user) => user.username === editUsername
      ? { ...user, username, ...(password ? { password } : {}), role, allowedSiteIds, waPhone, wa2faEnabled, customRoleId, permissions }
      : user)
    : [...users, { username, password, role, allowedSiteIds, waPhone, wa2faEnabled, customRoleId, permissions }];
  await persistState({ auth: { users: newUsers } });
  const patchIdx = (state.auth?.users || []).findIndex((u) => u.username === username);
  if (patchIdx >= 0) {
    state.auth.users[patchIdx] = { ...state.auth.users[patchIdx], wa2faEnabled, waPhone };
  }
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
  if (!sel || !canGlobalSuperAdmin() || !state) return;
  const sites = state.sites || [];
  const prev = sel.value || "";
  sel.innerHTML = sites.length
    ? sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nom)} (${escapeHtml(s.id)})</option>`).join("")
    : `<option value="">— Aucun maquis —</option>`;
  const cur = currentSiteId();
  if (sites.some((s) => String(s.id) === String(prev))) sel.value = prev;
  else if (sites.some((s) => String(s.id) === String(cur))) sel.value = String(cur);
  populateJournalShiftSiteSelect();
}

function populateJournalShiftSiteSelect() {
  const sel = document.getElementById("shift-journal-site-select");
  if (!sel || !state) return;
  if (!canGlobalSuperAdmin()) {
    sel.innerHTML = "";
    return;
  }
  const sites = state.sites || [];
  const prev = sel.value || "";
  sel.innerHTML = [
    `<option value="">Tous les maquis</option>`,
    ...sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nom)} (${escapeHtml(s.id)})</option>`),
  ].join("");
  if (prev === "") sel.value = "";
  else if (sites.some((s) => String(s.id) === String(prev))) sel.value = prev;
  else {
    const cur = currentSiteId();
    sel.value = sites.some((s) => String(s.id) === String(cur)) ? String(cur) : "";
  }
}

function renderSitesList() {
  const container = document.getElementById("sites-list");
  if (!container) return;
  if (!canManageMaquisBackups()) {
    container.innerHTML = "";
    populatePurgeMaquisSelect();
    return;
  }
  const sites = sitesVisibleToSession();
  if (!sites.length) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:12px 0">Aucun maquis enregistre.</p>`;
    populatePurgeMaquisSelect();
    return;
  }
  const canDelete = canGlobalSuperAdmin() && sites.length > 1;
  container.innerHTML = sites.map((site) => `
    <article class="list-item">
      <div style="min-width:0;flex:1">
        <p class="list-item-title">${escapeHtml(site.nom)}</p>
        <p class="list-item-sub">${escapeHtml(site.id)}${site.ville ? " · " + escapeHtml(site.ville) : ""}${site.pays ? ", " + escapeHtml(site.pays) : ""}</p>
      </div>
      <div class="list-side">
        <button type="button" class="mini-btn" data-site-backup="${escapeHtml(site.id)}" title="Sauvegarder ${escapeHtml(site.nom)} sur le serveur">Sauvegarder</button>
        ${canDelete ? `<button type="button" class="mini-btn" data-delete-site="${escapeHtml(site.id)}" style="background:#e53935;color:#fff;margin-left:6px" title="Supprimer ${escapeHtml(site.nom)}">Supprimer</button>` : ""}
      </div>
    </article>`).join("");
  container.querySelectorAll("[data-site-backup]").forEach((btn) => {
    btn.addEventListener("click", () => createSiteBackupOnServer(btn.dataset.siteBackup));
  });
  if (canDelete) {
    container.querySelectorAll("[data-delete-site]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const siteId = btn.dataset.deleteSite;
        const site = (state.sites || []).find((s) => s.id === siteId);
        const nom = site?.nom || siteId;
        if (window.confirm(`Supprimer le maquis "${nom}" ?\n\nCette action est irréversible.`)) {
          deleteSite(siteId).catch(handleApiError);
        }
      });
    });
  }
  populatePurgeMaquisSelect();
}

async function addSite() {
  if (!canGlobalSuperAdmin()) {
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
  const allBeforeIds = new Set((sitesBefore || []).map((s) => s.id));
  const newUsers = (state.auth?.users || []).map((user) => {
    const currentAllowed = new Set(user.allowedSiteIds || []);
    const r = normalizeRoleForUsername(user.username, user.role);
    if (r === "superadmin") {
      const coversAll = allBeforeIds.size > 0 && [...allBeforeIds].every((id) => currentAllowed.has(id));
      if (coversAll || String(user.username || "").trim().toLowerCase() === "admin") {
        currentAllowed.add(siteId);
      }
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
  allowedSiteIds = canGlobalSuperAdmin()
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
  if (!canGlobalSuperAdmin()) {
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
  if (canGlobalSuperAdmin()) allowedSiteIds = (state.sites || []).map((s) => s.id);
  if (state.activeSiteId === siteId) {
    await persistState({ activeSiteId: newSites[0]?.id || null });
  }
  renderSitesList();
  renderSiteSwitcher();
  renderUserSiteCheckboxes();
  renderUsersList();
  showToast(`Maquis "${site.nom}" supprime.`);
}

// ─── Correction de facture ───────────────────────────────────────────────────

function renderCorrectionPanel() {
  const input = document.getElementById("corr-facture-num");
  const result = document.getElementById("corr-result");
  if (input) input.value = "";
  if (result) result.innerHTML = "";
}

function searchFactureForCorrection() {
  const num = String(document.getElementById("corr-facture-num")?.value || "").trim();
  if (!num) { showToast("Saisissez un numéro de facture."); return; }
  const ventes = (state.ventes || []).filter(
    (v) => String(v.factureNumber || "").trim() === num && v.siteId === currentSiteId(),
  );
  const result = document.getElementById("corr-result");
  if (!result) return;
  if (!ventes.length) {
    result.innerHTML = `<p class="muted" style="padding:10px 0">Facture &laquo;${escapeHtml(num)}&raquo; introuvable pour ce maquis.</p>`;
    return;
  }
  renderCorrectionResult(num, ventes);
}

function renderCorrectionResult(factureNum, ventes) {
  const container = document.getElementById("corr-result");
  if (!container) return;
  const firstV = ventes[0];
  const client = firstV.client || "—";
  const date = firstV.date || "—";
  const table = firstV.table || "—";
  const currentPay = paymentLabel(firstV) || firstV.paiement || "—";
  const isMultiPay = ventes.some((v) => (v.paiementDetails || []).length > 1);

  const lines = ventes.map((v, i) => `
    <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap">
      <div style="flex:1;min-width:120px">
        <strong>${escapeHtml(v.article)}</strong>
        <span class="muted" style="font-size:0.85rem;margin-left:8px">${fmt(v.prix)} FCFA / u</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="font-size:0.85rem;color:var(--muted)">Qté :</label>
        <input type="number" id="corr-qty-${i}" value="${Number(v.qty) || 0}" min="0" step="1"
               style="width:72px;padding:6px 10px;border-radius:8px;border:1px solid var(--line);font-size:0.93rem"
               data-vente-id="${escapeHtml(String(v.id))}">
      </div>
    </div>`).join("");

  const payOptions = PAYMENT_METHODS.map(
    (m) => `<option value="${escapeHtml(m)}" ${m === currentPay ? "selected" : ""}>${escapeHtml(m)}</option>`,
  ).join("");

  container.innerHTML = `
    <div style="background:var(--surface2,#f5f5f5);border-radius:12px;padding:14px;margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;margin-bottom:10px">
        <strong>${escapeHtml(factureNum)}</strong>
        <span class="muted">${escapeHtml(date)}</span>
        <span class="muted">${escapeHtml(client)}${table !== "—" ? " · Table " + escapeHtml(table) : ""}</span>
      </div>
      ${lines}
    </div>

    <div style="margin-bottom:14px">
      <label style="font-weight:600;display:block;margin-bottom:6px">Corriger le moyen de paiement</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <span class="muted" style="font-size:0.88rem">Actuel : <strong>${escapeHtml(currentPay)}</strong>${isMultiPay ? " (paiement mixte — sera remplacé par un seul mode)" : ""}</span>
        <select id="corr-pay-method" style="padding:9px 12px;border-radius:10px;border:1px solid var(--line);font-size:0.93rem">
          ${payOptions}
        </select>
      </div>
    </div>

    <div style="margin-bottom:16px">
      <label for="corr-motif" style="font-weight:600;display:block;margin-bottom:6px">Motif de la correction <span style="color:#e53935">*</span></label>
      <input id="corr-motif" type="text" placeholder="Ex : erreur saisie paiement, rectification quantité…"
             style="width:100%;padding:11px 14px;border-radius:12px;border:1px solid var(--line);font-size:0.93rem;box-sizing:border-box">
    </div>

    <div class="button-stack">
      <button id="corr-apply-pay-btn" class="btn btn-primary" type="button">Appliquer correction paiement</button>
      <button id="corr-apply-qty-btn" class="btn btn-outline" type="button">Appliquer correction quantités</button>
    </div>`;

  document.getElementById("corr-apply-pay-btn")?.addEventListener("click", () =>
    applyPaymentCorrection(factureNum, ventes).catch(handleApiError));
  document.getElementById("corr-apply-qty-btn")?.addEventListener("click", () =>
    applyQtyCorrection(factureNum, ventes).catch(handleApiError));
}

async function applyPaymentCorrection(factureNum, originalVentes) {
  const motif = String(document.getElementById("corr-motif")?.value || "").trim();
  if (!motif) { showToast("Le motif est obligatoire."); return; }
  const newMethod = document.getElementById("corr-pay-method")?.value;
  if (!newMethod) return;
  const oldMethod = paymentLabel(originalVentes[0]) || originalVentes[0].paiement || "?";
  if (newMethod === oldMethod) { showToast("Le mode de paiement est déjà " + newMethod); return; }

  const ids = new Set(originalVentes.map((v) => v.id));
  state.ventes = (state.ventes || []).map((v) => {
    if (!ids.has(v.id)) return v;
    const net = (Number(v.prix) || 0) * (Number(v.qty) || 0) - (Number(v.remise) || 0);
    return { ...v, paiement: newMethod, paiementDetails: [{ method: newMethod, amount: net }] };
  });

  recordStaffAudit("update", "correction_paiement",
    `Correction paiement ${factureNum} : ${oldMethod} → ${newMethod}`,
    `Motif : ${motif}`);
  await persistState({ ventes: state.ventes, staffAuditLog: state.staffAuditLog, nextId: state.nextId });
  showToast(`Paiement de ${factureNum} corrigé : ${newMethod}`);
  const refreshed = (state.ventes || []).filter(
    (v) => String(v.factureNumber || "").trim() === factureNum && v.siteId === currentSiteId(),
  );
  renderCorrectionResult(factureNum, refreshed);
}

async function applyQtyCorrection(factureNum, originalVentes) {
  const motif = String(document.getElementById("corr-motif")?.value || "").trim();
  if (!motif) { showToast("Le motif est obligatoire."); return; }

  const changes = [];
  originalVentes.forEach((v, i) => {
    const input = document.getElementById(`corr-qty-${i}`);
    if (!input) return;
    const newQty = Number(input.value);
    if (isNaN(newQty) || newQty < 0) return;
    if (newQty !== Number(v.qty)) changes.push({ v, oldQty: Number(v.qty), newQty });
  });
  if (!changes.length) { showToast("Aucune quantité modifiée."); return; }

  const siteId = currentSiteId();
  const idMap = new Map(changes.map((c) => [c.v.id, c]));

  state.ventes = (state.ventes || [])
    .map((v) => {
      const c = idMap.get(v.id);
      if (!c) return v;
      const newNet = c.newQty * (Number(v.prix) || 0) - (Number(v.remise) || 0);
      const updated = { ...v, qty: c.newQty, total: c.newQty * (Number(v.prix) || 0) };
      if (Array.isArray(v.paiementDetails) && v.paiementDetails.length) {
        const total = v.paiementDetails.reduce((s, d) => s + (Number(d.amount) || 0), 0);
        updated.paiementDetails = v.paiementDetails.map((d) => ({
          ...d,
          amount: total > 0 ? Math.round((Number(d.amount) || 0) / total * newNet) : 0,
        }));
      }
      return updated;
    })
    .filter((v) => {
      const c = idMap.get(v.id);
      return !c || c.newQty > 0;
    });

  changes.forEach(({ v, oldQty, newQty }) => {
    const entry = (state.stock || []).find(
      (s) => s.siteId === siteId &&
             String(s.article || "").toLowerCase() === String(v.article || "").toLowerCase(),
    );
    if (entry) entry.sorties = Math.max(0, (Number(entry.sorties) || 0) + (newQty - oldQty));
  });

  const desc = changes.map((c) => `${c.v.article}: ${c.oldQty}→${c.newQty}`).join(", ");
  recordStaffAudit("update", "correction_quantite",
    `Correction qtés ${factureNum} : ${desc}`,
    `Motif : ${motif}`);
  await persistState({ ventes: state.ventes, stock: state.stock, staffAuditLog: state.staffAuditLog, nextId: state.nextId });
  showToast(`Quantités de ${factureNum} corrigées.`);
  const refreshed = (state.ventes || []).filter(
    (v) => String(v.factureNumber || "").trim() === factureNum && v.siteId === currentSiteId(),
  );
  if (refreshed.length) renderCorrectionResult(factureNum, refreshed);
  else document.getElementById("corr-result").innerHTML = `<p class="muted" style="padding:10px 0">Toutes les lignes ont été retirées (quantité 0).</p>`;
}

// ─────────────────────────────────────────────────────────────────────────────

function loadParamsForm() {
  const site = currentSite();
  document.getElementById("p-nom").value = site?.nom || "";
  document.getElementById("p-ville").value = site?.ville || "";
  document.getElementById("p-pays").value = site?.pays || "";
  document.getElementById("p-gerant").value = site?.gerant || "";
  document.getElementById("p-obj").value = site?.objectifCA || 500000;
  document.getElementById("p-seuil").value = site?.seuilStock || 5;
  const pReappro = document.getElementById("p-reappro-mult");
  if (pReappro) pReappro.value = String(reapproTargetMultiplier(site));
  document.getElementById("p-prefixe").value = site?.prefixeFacture || "";
  const pSmsQr = document.getElementById("p-sms-qr");
  if (pSmsQr) pSmsQr.value = site?.smsQrAlert || "";
  const pWaPhones = document.getElementById("p-wa-phones");
  if (pWaPhones) pWaPhones.value = site?.waNotifyPhones || "";
  // Préserver l'état UI si le site côté serveur n'a pas encore de champ `waEvents`
  const pWaEvCommande = document.getElementById("p-wa-ev-commande");
  const pWaEvFinService = document.getElementById("p-wa-ev-fin-service");
  const pWaEvCloture = document.getElementById("p-wa-ev-cloture");
  const pWaEvStock = document.getElementById("p-wa-ev-stock");
  if (Object.prototype.hasOwnProperty.call(site || {}, "waEvents")) {
    const waEvents = Array.isArray(site?.waEvents) ? site.waEvents : [];
    if (pWaEvCommande) pWaEvCommande.checked = waEvents.includes("commande_qr");
    if (pWaEvFinService) pWaEvFinService.checked = waEvents.includes("fin_service");
    if (pWaEvCloture) pWaEvCloture.checked = waEvents.includes("cloture_journee");
    if (pWaEvStock) pWaEvStock.checked = waEvents.includes("alerte_stock");
  } else {
    // site sans propriété waEvents connue : ne pas toucher les cases (préserver choix utilisateur)
  }
  const pSingleEnabled = document.getElementById("p-single-br-enabled");
  const pSingleName = document.getElementById("p-single-br-name");
  if (pSingleEnabled) pSingleEnabled.checked = Boolean(site?.singleBreweryOnly);
  if (pSingleName) {
    populateBrasserieFournisseurSelect(pSingleName, { mode: "catalog", preservedValue: site?.singleBreweryName || "" });
  }
  const pHasRestaurant = document.getElementById("p-has-restaurant");
  if (pHasRestaurant) pHasRestaurant.checked = Boolean(site?.hasRestaurant);
  const dualZonePricingEl = document.getElementById("p-dual-zone-pricing");
  if (dualZonePricingEl) dualZonePricingEl.checked = siteUsesDualZonePricing(site);
  const pStockAlertInclusive = document.getElementById("p-stock-alert-inclusive-seuil");
  if (pStockAlertInclusive) pStockAlertInclusive.checked = Boolean(site?.stockAlertInclusiveSeuil);
  const pAutoClotureEnabled = document.getElementById("p-auto-cloture-enabled");
  if (pAutoClotureEnabled) pAutoClotureEnabled.checked = Boolean(site?.autoClotureEnabled);
  const pAutoClotureTime = document.getElementById("p-auto-cloture-time");
  if (pAutoClotureTime) pAutoClotureTime.value = site?.autoClotureTime || "23:00";
  syncAutoClotureTimeVisibility();
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
  syncUserAccountPanel();
  syncPeriodCustomUi("export");
}

function syncUserAccountPanel() {
  const sn = String(sessionUser || "").trim();
  const me = sn && state ? (state.auth?.users || []).find((u) => String(u.username || "").trim().toLowerCase() === sn.toLowerCase()) : null;
  const userEl = document.getElementById("ua-username");
  const nameEl = document.getElementById("ua-display-name");
  const pw = document.getElementById("ua-password");
  const pwc = document.getElementById("ua-password-confirm");
  if (userEl) userEl.value = me?.username || sn || "";
  if (nameEl) nameEl.value = String(me?.displayName || "").trim();
  if (pw) pw.value = "";
  if (pwc) pwc.value = "";
  const waPhoneEl = document.getElementById("ua-wa-phone");
  if (waPhoneEl) waPhoneEl.value = String(me?.waPhone || "").trim();
  const waFa2El = document.getElementById("ua-wa2fa");
  if (waFa2El) waFa2El.checked = me?.wa2faEnabled || false;
  const twoFaHost = document.getElementById("ua-2fa-actions");
  if (twoFaHost && me) {
    twoFaHost.innerHTML = me.twoFactorEnabled
      ? `<span class="badge badge-green">2FA activé</span>`
        + ` <button type="button" class="mini-btn" id="ua-2fa-disable-btn" data-disable-2fa="${escapeHtml(me.username)}">Désactiver le 2FA</button>`
      : `<button type="button" class="btn btn-primary" id="ua-2fa-setup-btn" data-setup-2fa-self="${escapeHtml(me.username)}">Activer le 2FA sur mon compte</button>`;
    document.getElementById("ua-2fa-setup-btn")?.addEventListener("click", () => {
      setupTwoFactor(me.username).catch(handleApiError);
    });
  } else if (twoFaHost) {
    twoFaHost.innerHTML = "";
  }
}

async function saveMyUserProfile() {
  const sn = String(sessionUser || "").trim();
  if (!sn || !state) {
    showToast("Session requise.");
    return;
  }
  const me = (state.auth.users || []).find((u) => String(u.username || "").trim().toLowerCase() === sn.toLowerCase());
  if (!me) {
    showToast("Compte introuvable.");
    return;
  }
  const displayName = String(document.getElementById("ua-display-name")?.value || "").trim().slice(0, 120);
  const waPhone = String(document.getElementById("ua-wa-phone")?.value || "").trim();
  const wa2faEnabled = document.getElementById("ua-wa2fa")?.checked || false;
  const pw1 = String(document.getElementById("ua-password")?.value || "");
  const pw2 = String(document.getElementById("ua-password-confirm")?.value || "");
  if (pw1 || pw2) {
    if (pw1 !== pw2) {
      showToast("Les mots de passe ne correspondent pas.");
      return;
    }
    if (pw1.length < 6) {
      showToast("Mot de passe trop court (6 caracteres minimum).");
      return;
    }
  }
  const payload = {
    username: me.username,
    role: me.role,
    allowedSiteIds: [...(me.allowedSiteIds || [])],
    displayName,
    waPhone,
    wa2faEnabled,
    ...(pw1 ? { password: pw1 } : {}),
  };
  recordStaffAudit("update", "profil_utilisateur", `Profil ${me.username}`, displayName ? `Nom affiche : ${displayName}` : "Mise a jour");
  await persistState({ auth: { users: [payload], partial: true } });
  // Patch local pour garantir que wa2faEnabled/waPhone sont visibles même si le serveur
  // ne les renvoie pas encore dans public_state_for_session (ex. avant déploiement).
  const savedIdx = (state.auth?.users || []).findIndex((u) => String(u.username || "").toLowerCase() === sn.toLowerCase());
  if (savedIdx >= 0) {
    state.auth.users[savedIdx] = { ...state.auth.users[savedIdx], wa2faEnabled, waPhone: waPhone || state.auth.users[savedIdx].waPhone || "" };
  }
  document.getElementById("ua-password").value = "";
  document.getElementById("ua-password-confirm").value = "";
  renderTopbar();
  syncUserAccountPanel();
  showToast(pw1 ? "Profil enregistre. Si la session se ferme, reconnectez-vous avec le nouveau mot de passe." : "Profil enregistre.");
}

function populateOrderSelect() {
  const orders = activeCommandesExcludingFinalized(recordsForSite(state.commandes))
    .map((order) => ({ value: String(order.id), label: order.client || `Commande ${order.id}` }));
  const options = [{ value: "", label: "Saisie rapide" }, ...orders];
  const html = options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join("");
  const vSel = document.getElementById("v-order-select");
  if (vSel) {
    vSel.innerHTML = html;
    vSel.value = activeOrderId ? String(activeOrderId) : "";
  }
  const srSel = document.getElementById("sr-order-select");
  if (srSel) {
    srSel.innerHTML = html;
    srSel.value = activeOrderId ? String(activeOrderId) : "";
  }
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
  const sid = currentSiteId();
  const allowJournal = journalAllowsSalesForDate(saleD, sid).ok;
  const allowPlanning = !serveusePlanningBlocksSale(saleD, sid);
  btn.disabled = !id || !allowJournal || !allowPlanning;
}

function openOrderEditor(orderId = null) {
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
  openModal("modal-vente");
  window.requestAnimationFrame(() => document.getElementById("v-article-search")?.focus());
}

function resetOrderForm() {
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

function getMainShellScrollEl() {
  return document.querySelector(".main-shell");
}

/** Évite que la synchro live remonte la page en haut après un re-rendu. */
function withPreservedMainShellScroll(fn, { preScrollX = null } = {}) {
  const shell = getMainShellScrollEl();
  const shellY = shell ? shell.scrollTop : 0;
  const winY = window.scrollY || window.pageYOffset || 0;
  const stockWrap = document.getElementById("main-stock-table-wrap");
  const stockScrollX = preScrollX !== null ? preScrollX : (stockWrap ? stockWrap.scrollLeft : 0);
  fn();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (shell && shell.scrollTop !== shellY) shell.scrollTop = shellY;
      if (Math.abs((window.scrollY || window.pageYOffset || 0) - winY) > 1) {
        window.scrollTo(0, winY);
      }
      if (stockScrollX > 0) {
        const newWrap = document.getElementById("main-stock-table-wrap");
        if (newWrap) {
          newWrap.scrollLeft = stockScrollX;
          const mirror = newWrap.previousElementSibling;
          if (mirror && mirror.classList.contains("stock-scroll-mirror")) {
            mirror.scrollLeft = stockScrollX;
          }
        }
      }
    });
  });
}

/** Interaction récente (scroll, touch, saisie) : ne pas re-rendre pendant 5 s après. */
const LIVE_SYNC_DEFER_MS = 5000;

function shouldDeferLiveSyncRender() {
  if (modalIsOpen()) return true;
  if (Date.now() - _lastUserInteractionAt < LIVE_SYNC_DEFER_MS) return true;
  const ae = document.activeElement;
  if (!(ae instanceof HTMLElement)) return false;
  if (ae.matches("input, textarea, select")) {
    const pageEl = document.getElementById(`page-${currentPage}`);
    if (pageEl && pageEl.contains(ae)) return true;
  }
  return false;
}

function hhmmToMinutes(hhmm) {
  const parts = String(hhmm || "").trim().split(":");
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return -1;
  return hh * 60 + mm;
}

/** Journée comptable éligible à la clôture auto (heure locale de l'appareil). */
function autoClotureIsDueForJournal(site, dStr, now = new Date()) {
  if (!site?.autoClotureEnabled || !site?.autoClotureTime || !dStr) return false;
  if (stockCheckForSiteDate(dStr, currentSiteId())) return false;
  const clotureMins = hhmmToMinutes(site.autoClotureTime);
  if (clotureMins < 0) return false;
  const todayIso = today();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  if (dStr < todayIso) return true;
  if (dStr === todayIso && nowMins >= clotureMins) return true;
  return false;
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

/** Prochaine occurrence locale de l'heure de clôture auto (aujourd'hui ou demain si déjà passée). */
function nextAutoClotureLocalTargetDate(now, hh, mm) {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

function formatAutoClotureRemaining(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const r = min % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Dès quelle heure locale afficher le compte à rebours le soir (en plus de la fenêtre nuit &lt; 8 h). */
const AUTO_CLOTURE_COUNTDOWN_EVENING_FROM_HOUR = 22;
/** Afficher aussi le compte à rebours s'il reste au plus ce délai avant l'heure programmée (toute heure de la journée). */
const AUTO_CLOTURE_COUNTDOWN_LAST_MS = 60 * 60 * 1000;

/** Compte à rebours clôture auto : à partir de 22 h ou toute la nuit jusqu'à 8 h, ou dès qu'il reste ≤ 1 h avant l'heure programmée. */
function updateAutoClotureCountdown() {
  const el = document.getElementById("topbar-auto-cloture-countdown");
  if (!el) return;
  if (!state || !sessionUser) {
    el.classList.add("hidden");
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const site = currentSite();
  if (!site?.autoClotureEnabled || !site?.autoClotureTime) {
    el.classList.add("hidden");
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const parts = String(site.autoClotureTime).trim().split(":");
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) {
    el.classList.add("hidden");
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const siteId = currentSiteId();
  const dStr = workingDate();
  if (!dStr || stockCheckForSiteDate(dStr, siteId)) {
    el.classList.add("hidden");
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  const now = new Date();
  const hour = now.getHours();
  const target = nextAutoClotureLocalTargetDate(now, hh, mm);
  const remaining = target.getTime() - now.getTime();
  const timeLabel = String(site.autoClotureTime).trim().slice(0, 5);
  if (remaining <= 0) {
    el.classList.remove("hidden");
    el.textContent = "Clôture automatique…";
    el.title = `Journée ${dStr} · heure programmée ${timeLabel} — traitement en cours ou consultez le point du jour.`;
    return;
  }
  const inEveningOrNight = hour >= AUTO_CLOTURE_COUNTDOWN_EVENING_FROM_HOUR || hour < NIGHT_SHIFT_CUTOFF_HOUR;
  const inLastHourBeforeClose = remaining <= AUTO_CLOTURE_COUNTDOWN_LAST_MS;
  if (!inEveningOrNight && !inLastHourBeforeClose) {
    el.classList.add("hidden");
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  el.classList.remove("hidden");
  el.textContent = `Clôture auto dans ${formatAutoClotureRemaining(remaining)}`;
  el.title = `Journée comptable ${dStr} · clôture automatique à ${timeLabel} (heure locale). Visible à partir de ${AUTO_CLOTURE_COUNTDOWN_EVENING_FROM_HOUR} h ou la nuit (avant ${NIGHT_SHIFT_CUTOFF_HOUR} h), ou dès qu'il reste au plus 1 h ; sinon masqué entre ${NIGHT_SHIFT_CUTOFF_HOUR} h et ${AUTO_CLOTURE_COUNTDOWN_EVENING_FROM_HOUR} h.`;
}

function updateAppLiveClock() {
  const timeEl = document.getElementById("topbar-live-clock-time");
  const zoneEl = document.getElementById("topbar-live-clock-zone");
  if (!timeEl) return;
  const now = new Date();
  timeEl.textContent = new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).format(now);
  if (zoneEl) {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const offMin = -now.getTimezoneOffset();
      const sign = offMin >= 0 ? "+" : "-";
      const ah = Math.floor(Math.abs(offMin) / 60);
      const am = Math.abs(offMin) % 60;
      const offStr = am ? `${sign}${ah}h${pad2(am)}` : `${sign}${ah}h`;
      zoneEl.textContent = `${tz ? ` · ${tz}` : ""} (UTC${offStr})`;
    } catch (_) {
      zoneEl.textContent = "";
    }
  }
  updateAutoClotureCountdown();
}

function startAppLiveClock() {
  stopAppLiveClock();
  updateAppLiveClock();
  appLiveClockTimer = window.setInterval(updateAppLiveClock, 1000);
}

function stopAppLiveClock() {
  if (appLiveClockTimer != null) {
    clearInterval(appLiveClockTimer);
    appLiveClockTimer = null;
  }
}

function syncAutoClotureTimeVisibility() {
  const enabled = document.getElementById("p-auto-cloture-enabled")?.checked;
  const wrap = document.getElementById("p-auto-cloture-time-wrap");
  if (wrap) wrap.classList.toggle("hidden", !enabled);
}

function startAutoClotureSchedule() {
  stopAutoClotureSchedule();
  _scheduleNextAutoClotureTimeout();
}

function stopAutoClotureSchedule() {
  if (autoClotureTimer != null) {
    clearTimeout(autoClotureTimer);
    autoClotureTimer = null;
  }
}

/** Tente une clôture immédiate si l'heure est dépassée (y compris après minuit pour la veille). */
function _tryAutoClotureIfDueNow() {
  if (!state || !sessionUser || !canManagePdjAccounting()) return;
  const site = currentSite();
  if (!site?.autoClotureEnabled) return;
  const dStr = workingDate();
  if (!dStr || !autoClotureIsDueForJournal(site, dStr)) return;
  if (_autoClotureManualReopened.has(`${currentSiteId()}|${dStr}`)) return;
  const dayBookCurrent = dayBookFor(dStr);
  if (dayBookCurrent?.manualReopenedAt) return;
  _triggerAutoClotureNow();
}

function _scheduleNextAutoClotureTimeout() {
  if (!state || !sessionUser) return;
  const site = currentSite();
  if (!site?.autoClotureEnabled || !site?.autoClotureTime) return;

  _tryAutoClotureIfDueNow();

  const now = new Date();
  const dStr = workingDate();
  const siteId = currentSiteId();
  if (dStr && !stockCheckForSiteDate(dStr, siteId) && autoClotureIsDueForJournal(site, dStr, now)) {
    autoClotureTimer = window.setTimeout(() => {
      _tryAutoClotureIfDueNow();
      _scheduleNextAutoClotureTimeout();
    }, 60_000);
    return;
  }

  const parts = String(site.autoClotureTime).split(":");
  const hh = Number(parts[0]);
  const mm = Number(parts[1]);
  if (Number.isNaN(hh) || Number.isNaN(mm)) return;

  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);

  const msUntil = Math.max(1000, target.getTime() - now.getTime());
  autoClotureTimer = window.setTimeout(() => {
    _triggerAutoClotureNow();
    _scheduleNextAutoClotureTimeout();
  }, msUntil);
}

function _triggerAutoClotureNow() {
  if (_autoClotureInProgress) return;
  if (!state || !sessionUser) return;
  if (!canManagePdjAccounting()) return;
  const site = currentSite();
  if (!site?.autoClotureEnabled) return;
  const dStr = workingDate();
  if (!dStr) return;
  if (stockCheckForSiteDate(dStr, currentSiteId())) return;
  if (_autoClotureManualReopened.has(`${currentSiteId()}|${dStr}`)) return;
  const dayBookCurrent = dayBookFor(dStr);
  if (dayBookCurrent?.manualReopenedAt) return;
  _autoClotureInProgress = true;
  performAutoClotureBackground(dStr)
    .catch(console.error)
    .finally(() => { _autoClotureInProgress = false; });
}

async function performAutoClotureBackground(dStr) {
  if (!canManagePdjAccounting()) return;
  const siteId = currentSiteId();
  if (stockCheckForSiteDate(dStr, siteId)) return;
  const items = recordsForSite(state.stock);
  if (!items.length) return;
  // Ne pas cloture automatiquement un jour sans ventes ni dayBook ouvert
  const dayBook = dayBookFor(dStr, siteId);
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  if (!ventesJour.length && !dayBook) {
    console.info("[auto-cloture] Jour sans ventes ni caisse ouverte — ignoré.", dStr, siteId);
    return;
  }
  const pendingForClose = pendingOrdersForJournalDate(dStr, siteId);
  if (pendingForClose.length) {
    showToast(`Clôture auto impossible : ${pendingForClose.length} commande(s) en attente pour le ${formatDateDdMmYyyy(dStr)}.`);
    return;
  }
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum : sum + a, 0);
  const creditEmisJour = creditIssuedOnDate(dStr);
  const caCreances = totalCreditOutstanding();
  const especesVentes = Number(totauxJour["Espèces"]) || Number(totauxJour["EspÃ¨ces"]) || 0;
  const especesRecouvrement = especesFromCreditRecoveriesForDate(dStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces")
    || normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("EspÃ¨ces")
      ? sum + (Number(c.montant) || 0) : sum
  ), 0);
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  const expectedEspecesCash = openingCash + especesVentes + especesRecouvrement;
  const closingCashFcfa = expectedEspecesCash;
  const cashEcartEspeces = 0;

  const existingCloseCheck = stockCheckForSiteDate(dStr, siteId);
  const checkedItems = items.map((item) => {
    const frigo = Math.max(0, stockFrigo(item));
    const reserve = Math.max(0, stockReserve(item));
    const existingCloseItem = existingCloseCheck ? (existingCloseCheck.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const stockAtOpen = stockOpeningFromDayBook(item, dayBook) ?? existingCloseItem?.stockAvant ?? stockActuel(item);
    const sortiesToday = todaySortiesBottlesForArticle(item.article, dStr);
    const expectedRemaining = frigo + reserve;
    const counted = frigo + reserve;
    return {
      id: item.id,
      article: item.article,
      cat: item.cat || "",
      stockAvant: stockAtOpen,
      sortiesToday,
      expected: expectedRemaining,
      frigo,
      reserve,
      counted,
      ecart: counted - expectedRemaining,
      stockApres: counted,
    };
  });

  const prevClose = (state.stockChecks || []).find((sc) => sc.siteId === siteId && sc.date === dStr);
  checkedItems.forEach((checked) => {
    const item = state.stock.find((stockItem) => stockItem.id === checked.id);
    if (!item) return;
    item.frigo = checked.frigo;
    item.reserve = checked.reserve;
    if (prevClose) {
      const prev = (prevClose.items || []).find((pi) => pi.id === checked.id);
      if (prev) {
        if (prev.sortiesToday > 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - prev.sortiesToday);
        if (prev.ecart > 0) item.entrees = Math.max(0, (Number(item.entrees) || 0) - prev.ecart);
        if (prev.ecart < 0) item.sorties = Math.max(0, (Number(item.sorties) || 0) - Math.abs(prev.ecart));
      }
    }
    if (checked.sortiesToday > 0) {
      item.sorties = (Number(item.sorties) || 0) + checked.sortiesToday;
      item.lastSortieAt = new Date().toISOString();
      item.lastSortieBy = "auto-cloture";
    }
    if (checked.ecart > 0) item.entrees = (Number(item.entrees) || 0) + checked.ecart;
    if (checked.ecart < 0) item.sorties = (Number(item.sorties) || 0) + Math.abs(checked.ecart);
  });

  const check = {
    id: Date.now(),
    siteId,
    date: dStr,
    createdAt: new Date().toISOString(),
    openedAt: dayBook?.openedAt || "",
    openingCashFcfa: openingCash,
    closingCashFcfa,
    expectedEspecesCash,
    cashEcartEspeces,
    especesChargesJour: especesCharges,
    caEncaisse,
    caCreances,
    caCreancesEmisesJour: creditEmisJour,
    nbVentes: ventesJour.length,
    totauxJour,
    items: checkedItems,
    autoClose: true,
  };
  state.stockChecks = [
    check,
    ...(state.stockChecks || []).filter((sc) => !(sc.siteId === check.siteId && sc.date === check.date)),
  ];
  _autoClotureManualReopened.delete(`${siteId}|${dStr}`);
  recordStaffAudit(
    "update",
    "cloture_jour",
    `Clôture automatique ${formatDateDdMmYyyy(dStr)}`,
    `Programmée · ${new Date().toLocaleTimeString("fr-FR")} · CA ${fmt(caEncaisse)} FCFA · ${ventesJour.length} vente(s) · stock théorique`,
  );
  const autoOpen = autoOpenNextAccountingDayAfterClose(siteId, dStr, closingCashFcfa, { actorLabel: "auto-cloture" });
  if (!autoOpen) {
    const pdjMapClose = { ...(state.pdjWorkDateBySite || {}) };
    if (pdjMapClose[siteId] === dStr) delete pdjMapClose[siteId];
    state.pdjWorkDateBySite = pdjMapClose;
  }
  await persistState({
    stock: state.stock,
    stockChecks: state.stockChecks,
    dayBooks: state.dayBooks,
    pdjWorkDateBySite: state.pdjWorkDateBySite,
  });
  if (autoOpen?.nextDate) {
    setPdjBrowseDate(null);
    syncPdjWorkDateInput();
    pdjSubTab = "synthese";
  }
  renderDashboard();
  renderPointDuJour();
  renderStock();
  const nextMsg = autoOpen?.nextDate
    ? ` Journée suivante (${formatDateDdMmYyyy(autoOpen.nextDate)}) ouverte automatiquement.`
    : "";
  showToast(`Clôture auto : journée du ${formatDateDdMmYyyy(dStr)} clôturée (stock théorique, caisse théorique).${nextMsg}`);
}

async function syncStateSilently() {
  if (!state || modalIsOpen()) return;
  if (currentPage === "planning") {
    try {
      await refreshWorkShiftsFromServer({ replaceSite: true });
      lsSaveWorkShifts();
    } catch {
      /* garder l'état local */
    }
    renderPlanningMine();
    if (canManageTeamSchedule()) renderPlanningTeam();
    return;
  }
  if (!["ventes", "home", "stock", "pdj", "commandes"].includes(currentPage)) return;
  _tryAutoClotureIfDueNow();
  const deferRender = shouldDeferLiveSyncRender();

  if (currentPage === "stock") {
    // Full reload for stock page — delta only returns commandes, not stock/purchases
    try {
      const fresh = await apiRequest(API.state, { cache: "no-store" });
      if (fresh) {
        const _casiers = state.casiers ?? [];
        const _casierMouvements = state.casierMouvements ?? [];
        const _workShifts = workShiftsAll();
        const _nextCasier = state.nextId?.casier;
        const _nextCasierMvt = state.nextId?.casierMouvement;
        state = mergeStateFromServerResponse(fresh, state, null);
        if (_workShifts.length) {
          state.workShifts = mergeWorkShiftsFromServer(state.workShifts || [], _workShifts);
        }
        if (!state.pdjWorkDateBySite || typeof state.pdjWorkDateBySite !== "object") state.pdjWorkDateBySite = {};
        if (!state.nextId) state.nextId = {};
        if (!state.casiers?.length && _casiers.length) state.casiers = _casiers;
        if (!state.casierMouvements?.length && _casierMouvements.length) state.casierMouvements = _casierMouvements;
        if (!state.nextId.casier && _nextCasier) state.nextId.casier = _nextCasier;
        if (!state.nextId.casierMouvement && _nextCasierMvt) state.nextId.casierMouvement = _nextCasierMvt;
        lsSaveCasiers();
      }
    } catch (e) { return; }
    applyPdjWorkDateToVentesAndOrderDom();
    syncPdjWorkDateInput();
    renderTopbar();
    // renderSiteSwitcher appelle syncDualZonePricingUi → renderStock → scrollLeft=0
    // On capture le scroll AVANT et on englobe tout dans withPreservedMainShellScroll
    // pour restaurer dans les deux cas (deferRender ou non)
    const _preScrollX = (() => { const w = document.getElementById("main-stock-table-wrap"); return w ? w.scrollLeft : 0; })();
    withPreservedMainShellScroll(() => {
      renderSiteSwitcher();
      if (!deferRender) {
        renderStock();
        if (stockSubTab === "mouvements") renderStockMovements();
        else if (stockSubTab === "achats") renderPurchaseOrders();
        else if (stockSubTab === "creanciers") renderCreanciers();
        else if (stockSubTab === "casiers") renderCasiers();
      }
    }, { preScrollX: _preScrollX });
    return;
  }

  const previousQrIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
  const since = state?.meta?.updatedAt || "";
  let delta = null;
  /** True si le delta contient des commandes « nouvelles » pour ce poll (évite faux positifs quand le serveur renvoie les mêmes QR tant que meta.updatedAt est inchangé). */
  let hadCmdDelta = false;
  let cmdPollDupStaleMeta = false;
  try {
    const metaBeforePoll = String(state?.meta?.updatedAt || "");
    delta = await apiRequest(`${API.changes}?since=${encodeURIComponent(since)}&siteId=${encodeURIComponent(currentSiteId())}`);
    const incoming = (delta?.changes?.commandes || []).slice();
    const metaAfterPoll = String(delta?.meta?.updatedAt ?? "");
    const pollMetaUnchanged = Boolean(metaBeforePoll) && metaAfterPoll === metaBeforePoll;
    cmdPollDupStaleMeta = incoming.length > 0 && pollMetaUnchanged;
    hadCmdDelta = incoming.length > 0 && !pollMetaUnchanged;
    if (incoming.length) {
      mergeCommandesFromPoll(incoming, { skipStaleDup: cmdPollDupStaleMeta });
    }
    pruneFinalizedCommandesFromState();
    if (delta?.meta) {
      state.meta = delta.meta;
    }
  } catch (error) {
    // Fallback: if delta endpoint fails, reload full state.
    const fresh = await apiRequest(API.state, { cache: "no-store" });
    if (fresh) {
      const _workShifts = workShiftsAll();
      state = mergeStateFromServerResponse(fresh, state, null);
      if (_workShifts.length) {
        state.workShifts = mergeWorkShiftsFromServer(state.workShifts || [], _workShifts);
      }
    }
    if (!state.pdjWorkDateBySite || typeof state.pdjWorkDateBySite !== "object") state.pdjWorkDateBySite = {};
    delta = null;
  }
  let skipPdjFullRender = false;
  if (delta && typeof delta.pdjWorkDateBySite === "object") {
    const incPdj = delta.pdjWorkDateBySite;
    const prevPdj = state.pdjWorkDateBySite || {};
    skipPdjFullRender = currentPage === "pdj" && !hadCmdDelta && shallowEqualPdjWorkDateMaps(prevPdj, incPdj);
    // Notification serveuse : le gérant vient de valider sa fin de service
    const sid = currentSiteId();
    const fcKey = `_fc_${sid}`;
    const newFc = incPdj[fcKey];
    const prevFc = prevPdj[fcKey];
    if (newFc && newFc.closedBy === sessionUser && (!prevFc || prevFc.at !== newFc.at)) {
      showToast(`Votre fin de service du ${isoDateToDdMmYyyy(newFc.date)} a été validée par ${newFc.confirmedBy || "le gérant"}. Bonne journée !`);
    }
    state.pdjWorkDateBySite = { ...prevPdj, ...incPdj };
    applyPdjWorkDateToVentesAndOrderDom();
    syncPdjWorkDateInput();
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
  if (currentPage === "home" && !deferRender) {
    withPreservedMainShellScroll(() => renderDashboard());
  }
  if (currentPage === "ventes" && !deferRender) {
    withPreservedMainShellScroll(() => renderVentesPage());
  }
  if (currentPage === "pdj" && !deferRender && !skipPdjFullRender) {
    withPreservedMainShellScroll(() => {
      renderPointDuJour();
      setPdjSubTab(pdjSubTab);
    });
  }
}

/**
 * Superadmin : décale d’un jour toutes les dates « journée » (PDJ, ventes, commandes, etc.).
 * `siteIdFilter` vide = tous les maquis. Ordre des dayBooks/stockChecks évite les collisions (siteId, date).
 */
async function applySuperadminAccountingJournalDayShift(deltaDays, siteIdFilter = "") {
  if (!canGlobalSuperAdmin()) {
    showToast("Reserve au super administrateur.");
    return;
  }
  const d = Number(deltaDays);
  if (d !== 1 && d !== -1) {
    showToast("Decalage autorise : +1 ou -1 jour uniquement.");
    return;
  }
  const sid = String(siteIdFilter || "").trim();
  const multi = multiSiteActive();
  const rowInScope = (row) => {
    if (!row || typeof row !== "object") return false;
    if (!sid) return true;
    return rowMatchesSite(row, sid, multi);
  };

  const orderedDayBookLike = (rows) => {
    const scoped = (rows || []).filter((r) => r && r.date && rowInScope(r));
    const desc = d > 0;
    const sign = desc ? -1 : 1;
    scoped.sort((a, b2) => {
      const c = String(a.siteId || "").localeCompare(String(b2.siteId || ""));
      if (c !== 0) return c;
      return sign * String(a.date).localeCompare(String(b2.date));
    });
    return scoped;
  };

  for (const b of orderedDayBookLike(state.dayBooks)) {
    b.date = addCalendarDaysIso(b.date, d);
    if (b.openedAt) b.openedAt = shiftIsoDatetimeLeadingCalendarDay(b.openedAt, d);
    if (b.openingRecordedAt) b.openingRecordedAt = shiftIsoDatetimeLeadingCalendarDay(b.openingRecordedAt, d);
  }
  for (const sc of orderedDayBookLike(state.stockChecks)) {
    sc.date = addCalendarDaysIso(sc.date, d);
    if (sc.createdAt) sc.createdAt = shiftIsoDatetimeLeadingCalendarDay(sc.createdAt, d);
    if (sc.openedAt) sc.openedAt = shiftIsoDatetimeLeadingCalendarDay(sc.openedAt, d);
  }

  for (const v of state.ventes || []) {
    if (!v || !v.date || !rowInScope(v)) continue;
    v.date = addCalendarDaysIso(v.date, d);
  }

  for (const o of state.commandes || []) {
    if (!o || !rowInScope(o)) continue;
    if (o.date) o.date = addCalendarDaysIso(String(o.date).slice(0, 10), d);
    for (const line of o.lignes || []) {
      if (line && line.date) line.date = addCalendarDaysIso(String(line.date).slice(0, 10), d);
    }
  }

  for (const c of state.charges || []) {
    if (!c || !c.date || !rowInScope(c)) continue;
    c.date = addCalendarDaysIso(String(c.date).slice(0, 10), d);
  }

  for (const c of state.consignes || []) {
    if (!c || !rowInScope(c)) continue;
    ["date", "dateRetour", "dateReutilisation"].forEach((k) => {
      if (!c[k]) return;
      const head = String(c[k]).trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) return;
      c[k] = addCalendarDaysIso(head, d);
    });
  }

  for (const r of state.creditRecoveries || []) {
    if (!r || !rowInScope(r)) continue;
    if (r.date) r.date = addCalendarDaysIso(String(r.date).slice(0, 10), d);
    if (r.paidAt) r.paidAt = shiftIsoDatetimeLeadingCalendarDay(r.paidAt, d);
    if (r.createdAt) r.createdAt = shiftIsoDatetimeLeadingCalendarDay(r.createdAt, d);
  }

  for (const po of state.purchaseOrders || []) {
    if (!po || !rowInScope(po)) continue;
    if (po.date) po.date = addCalendarDaysIso(String(po.date).slice(0, 10), d);
  }

  for (const e of state.stockEntrees || []) {
    if (!e || !e.date || !rowInScope(e)) continue;
    e.date = addCalendarDaysIso(String(e.date).slice(0, 10), d);
  }

  for (const loss of state.stockLosses || []) {
    if (!loss || !rowInScope(loss)) continue;
    if (loss.date) loss.date = addCalendarDaysIso(String(loss.date).slice(0, 10), d);
    if (loss.createdAt) loss.createdAt = shiftIsoDatetimeLeadingCalendarDay(loss.createdAt, d);
  }

  for (const m of state.casierMouvements || []) {
    if (!m || !rowInScope(m)) continue;
    if (m.date) m.date = addCalendarDaysIso(String(m.date).slice(0, 10), d);
    if (m.createdAt) m.createdAt = shiftIsoDatetimeLeadingCalendarDay(m.createdAt, d);
  }

  const pdjMap = { ...(state.pdjWorkDateBySite || {}) };
  for (const k of Object.keys(pdjMap)) {
    if (sid && String(k) !== sid) continue;
    const v = pdjMap[k];
    if (!v) continue;
    const head = String(v).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(head)) continue;
    pdjMap[k] = addCalendarDaysIso(head, d);
  }
  state.pdjWorkDateBySite = pdjMap;

  const scopeLabel = sid ? `maquis ${sid}` : "tous les maquis";
  recordStaffAudit(
    "update",
    "journal_calendar_shift",
    `Decalage dates comptables ${d > 0 ? "+1" : "-1"} jour`,
    scopeLabel,
  );

  await persistState({
    ventes: state.ventes,
    commandes: state.commandes,
    stockChecks: state.stockChecks,
    stockEntrees: state.stockEntrees,
    stockLosses: state.stockLosses,
    dayBooks: state.dayBooks,
    charges: state.charges,
    consignes: state.consignes,
    creditRecoveries: state.creditRecoveries,
    purchaseOrders: state.purchaseOrders,
    casierMouvements: state.casierMouvements,
    pdjWorkDateBySite: state.pdjWorkDateBySite,
  });

  renderPointDuJour();
  renderVentesPage();
  renderDashboard();
  renderCharges();
  renderCreditRecovery();
  renderPurchaseOrders();
  showToast(`Dates comptables decalees (${d > 0 ? "+1" : "-1"} jour, ${scopeLabel}).`);
}

/** Liste alignee avec server.py (_SITE_SCOPED_ROW_KEYS) — secours purge maquis via PUT si route POST absente (vieux serveur). */
const PURGE_MAQUIS_ROW_KEYS = [
  "ventes", "stock", "commandes", "stockChecks", "stockEntrees", "stockLosses",
  "dayBooks", "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
  "creditRecoveries", "charges", "staffAuditLog",
];

/** Clés acceptées par PUT /api/state (aligné server.py). */
const STATE_PUT_ROW_KEYS = [
  "ventes", "stock", "commandes", "stockChecks", "stockEntrees", "stockLosses",
  "dayBooks", "purchaseOrders", "supplierPrices", "casiers", "casierMouvements",
  "creditRecoveries", "consignes", "charges", "staffAuditLog", "workShifts",
];

/**
 * Corps PUT : uniquement les clés présentes dans `overrides` (+ activeSiteId).
 * Si `overrides` est vide → sauvegarde complète (comportement historique de persistState()).
 */
function buildStatePutBody(overrides = {}) {
  const o = overrides && typeof overrides === "object" ? overrides : {};
  const explicit = Object.keys(o);
  const body = { activeSiteId: o.activeSiteId ?? state.activeSiteId };

  if (!explicit.length) {
    body.sites = state.sites;
    body.ventes = state.ventes;
    body.stock = state.stock;
    body.commandes = state.commandes;
    body.stockChecks = state.stockChecks ?? [];
    body.stockLosses = state.stockLosses ?? [];
    body.stockEntrees = state.stockEntrees ?? [];
    body.dayBooks = state.dayBooks ?? [];
    body.pdjWorkDateBySite = state.pdjWorkDateBySite ?? {};
    body.purchaseOrders = state.purchaseOrders ?? [];
    body.supplierPrices = state.supplierPrices ?? [];
    body.creditRecoveries = state.creditRecoveries ?? [];
    body.consignes = state.consignes ?? [];
    body.categories = state.categories ?? CATEGORIES;
    body.charges = state.charges;
    body.nextId = state.nextId;
    body.staffAuditLog = state.staffAuditLog ?? [];
    /* workShifts : jamais en sauvegarde complète — évite d'écraser le planning (PUT partiel dédié). */
    body.auth = { users: state.auth?.users || [] };
    body.casiers = state.casiers ?? [];
    body.casierMouvements = state.casierMouvements ?? [];
    return body;
  }

  if (Object.prototype.hasOwnProperty.call(o, "sites")) body.sites = o.sites;
  STATE_PUT_ROW_KEYS.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(o, key)) body[key] = o[key];
  });
  if (Object.prototype.hasOwnProperty.call(o, "pdjWorkDateBySite")) body.pdjWorkDateBySite = o.pdjWorkDateBySite;
  if (Object.prototype.hasOwnProperty.call(o, "categories")) body.categories = o.categories;
  if (Object.prototype.hasOwnProperty.call(o, "nextId")) body.nextId = o.nextId;
  if (Object.prototype.hasOwnProperty.call(o, "auth")) body.auth = o.auth;
  if (Object.prototype.hasOwnProperty.call(o, "params")) body.params = o.params;
  if (Object.prototype.hasOwnProperty.call(o, "workShiftsScopedSnapshot")) {
    body.workShiftsScopedSnapshot = Boolean(o.workShiftsScopedSnapshot);
  }
  return body;
}

/** Clés réellement envoyées dans le corps PUT (hors activeSiteId). */
function patchedKeysFromPutBody(body) {
  return new Set(
    Object.keys(body || {}).filter((k) => k !== "activeSiteId" && k !== "params"),
  );
}

/**
 * Fusionne la réponse PUT /api/state.
 * @param {Set<string>|null} patchedKeys — clés modifiées par ce PUT ; les autres collections restent inchangées côté client.
 *   `null` = sauvegarde complète (toutes les clés du corps sont appliquées, avec garde-fou anti-tableau vide).
 */
function mergeStateFromServerResponse(incoming, previous, patchedKeys = null) {
  if (!incoming || typeof incoming !== "object") return previous;
  const prev = previous && typeof previous === "object" ? previous : {};
  const out = { ...prev };

  if (incoming.meta) out.meta = incoming.meta;
  if (incoming.activeSiteId != null) out.activeSiteId = incoming.activeSiteId;
  if (incoming.auth && typeof incoming.auth === "object") out.auth = incoming.auth;
  if (incoming.sites && (!patchedKeys || patchedKeys.has("sites"))) out.sites = incoming.sites;
  if (incoming.categories && (!patchedKeys || patchedKeys.has("categories"))) {
    out.categories = incoming.categories;
  }

  const applyListKey = (key) => {
    if (patchedKeys && !patchedKeys.has(key)) return;
    const inc = incoming[key];
    if (!Array.isArray(inc)) return;
    const old = prev[key];
    if (key === "workShifts") {
      out[key] = inc;
      return;
    }
    // Pour commandes : toujours appliquer le tableau serveur (même vide = suppression ok)
    let arr = (key === "commandes" || inc.length > 0 || !Array.isArray(old) || old.length === 0) ? inc : old;
    // Dédupliquer les stockChecks par (siteId, date) : garder le plus récent
    if (key === "stockChecks" && arr.length > 1) {
      const seen = new Map();
      for (const sc of arr) {
        if (!sc?.siteId || !sc?.date) continue;
        const k = `${sc.siteId}|${sc.date}`;
        const existing = seen.get(k);
        if (!existing || (sc.createdAt || "") >= (existing.createdAt || "")) seen.set(k, sc);
      }
      arr = [...seen.values()];
    }
    out[key] = arr;
  };

  STATE_PUT_ROW_KEYS.forEach(applyListKey);

  if (!patchedKeys || patchedKeys.has("pdjWorkDateBySite")) {
    if (incoming.pdjWorkDateBySite && typeof incoming.pdjWorkDateBySite === "object") {
      out.pdjWorkDateBySite = incoming.pdjWorkDateBySite;
    }
  }
  if (!patchedKeys || patchedKeys.has("nextId")) {
    if (incoming.nextId && typeof incoming.nextId === "object") {
      out.nextId = { ...(prev.nextId || {}), ...incoming.nextId };
    }
  }
  return out;
}

function applyPersistStateResponseExtras(overrides, _stockChecks) {
  if (!state.casiers?.length && (overrides.casiers ?? state.casiers ?? []).length) {
    state.casiers = overrides.casiers ?? state.casiers;
  }
  if (!state.casierMouvements?.length && (overrides.casierMouvements ?? state.casierMouvements ?? []).length) {
    state.casierMouvements = overrides.casierMouvements ?? state.casierMouvements;
  }
  if (!state.consignes?.length && (overrides.consignes ?? state.consignes ?? []).length) {
    state.consignes = overrides.consignes ?? state.consignes;
  }
  if (!state.supplierPrices?.length && (overrides.supplierPrices ?? state.supplierPrices ?? []).length) {
    state.supplierPrices = overrides.supplierPrices ?? state.supplierPrices;
  }
  if (overrides.stockChecks !== undefined && _stockChecks.length) {
    const merged = [...(state.stockChecks || [])];
    _stockChecks.forEach((sc) => {
      if (!sc?.siteId || !sc?.date) return;
      const idx = merged.findIndex((x) => x.siteId === sc.siteId && x.date === sc.date);
      if (idx >= 0) merged[idx] = sc;
      else merged.push(sc);
    });
    state.stockChecks = merged;
  }
  lsSaveCasiers();
  renderTopbar();
}

async function purgeMaquisDataViaStatePut(siteId, keepStockCatalog) {
  if (!canGlobalSuperAdmin()) throw new Error("Reserve au super administrateur.");
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
  const pm = { ...(state.pdjWorkDateBySite || {}) };
  delete pm[sid];
  overrides.pdjWorkDateBySite = pm;
  await persistState(overrides);
}

async function persistState(overrides = {}) {
  const _stockChecks = overrides.stockChecks ?? state.stockChecks ?? [];
  if (overrides.commandes !== undefined || !Object.keys(overrides || {}).length) {
    dedupeCommandesInState();
    pruneFinalizedCommandesFromState();
    if (overrides.commandes !== undefined) overrides.commandes = state.commandes;
  }
  const prev = state;
  const body = buildStatePutBody(overrides);
  const isFullSave = !Object.keys(overrides || {}).length;
  const patchedKeys = isFullSave ? null : patchedKeysFromPutBody(body);
  const opId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const incoming = await apiRequest(API.state, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "X-Op-Id": opId },
  });
  if (incoming?.idempotent) return;
  state = mergeStateFromServerResponse(incoming, prev, patchedKeys);
  applyPersistStateResponseExtras(overrides, _stockChecks);
}

/**
 * PUT /api/state avec uniquement les clés fournies — le serveur fusionne avec l'état courant.
 * À utiliser pour les actions qui ne touchent qu'un petit ensemble (ex. catalogue stock) :
 * évite d'envoyer tout l'historique ventes / commandes / etc., nettement plus rapide.
 */
async function persistStatePatch(patch) {
  if (!patch || typeof patch !== "object") throw new Error("persistStatePatch: patch invalide.");
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error("persistStatePatch: patch vide.");
  if (patch.commandes !== undefined) {
    dedupeCommandesInState();
    pruneFinalizedCommandesFromState();
    patch.commandes = state.commandes;
  }
  const _stockChecks = patch.stockChecks ?? [];
  const prev = state;
  const body = buildStatePutBody(
    patch.activeSiteId !== undefined ? patch : { activeSiteId: state.activeSiteId, ...patch },
  );
  const patchedKeys = patchedKeysFromPutBody(body);
  const opId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const incoming = await apiRequest(API.state, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "X-Op-Id": opId },
  });
  if (incoming?.idempotent) return;
  state = mergeStateFromServerResponse(incoming, prev, patchedKeys);
  if (patchedKeys.has("commandes")) {
    pruneFinalizedCommandesFromState();
  }
  if (Array.isArray(patch.workShifts) && patchedKeys.has("workShifts")) {
    applyWorkShiftsAfterSave(patch.workShifts, { snapshot: Boolean(patch.workShiftsScopedSnapshot) });
  }
  applyPersistStateResponseExtras(patch, _stockChecks);
}

async function refreshStateFromServer() {
  try {
    const fresh = await apiRequest(API.state, { cache: "no-store" });
    if (fresh && typeof fresh === "object") {
      state = mergeStateFromServerResponse(fresh, state, null);
      if (!state.pdjWorkDateBySite || typeof state.pdjWorkDateBySite !== "object") state.pdjWorkDateBySite = {};
      if (!state.nextId || typeof state.nextId !== "object") state.nextId = {};
    }
  } catch (error) {
    console.warn("refreshStateFromServer failed", error);
  }
}

function openCreditFacturesJourModal() {
  const dStr = pdjCalendarDate();
  const ventesJour = recordsForSite(state.ventes).filter((v) => {
    if (v.date.slice(0, 10) !== dStr) return false;
    return isCreditClientMethod(v.paiement) ||
      (v.paiementDetails || []).some((d) => isCreditClientMethod(d.method));
  });

  const grouped = new Map();
  ventesJour.forEach((v) => {
    const key = v.factureNumber || `V-${v.id}`;
    if (!grouped.has(key)) grouped.set(key, { factureNumber: key, ventes: [], debiteur: v.debiteur || v.client || "" });
    grouped.get(key).ventes.push(v);
  });

  const titleEl = document.getElementById("modal-credit-factures-title");
  if (titleEl) titleEl.textContent = `Factures crédit — ${formatDateDdMmYyyy(dStr)}`;

  const listEl = document.getElementById("modal-credit-factures-list");
  if (!listEl) return;

  if (!grouped.size) {
    listEl.innerHTML = `<p class="muted" style="padding:10px 0">Aucune vente crédit client pour cette journée.</p>`;
    openModal("modal-credit-factures");
    return;
  }

  listEl.innerHTML = [...grouped.values()].map(({ factureNumber, ventes: vs, debiteur }) => {
    const total = vs.reduce((s, v) => s + calcNet(v), 0);
    const articles = vs.map((v) => `${v.qty > 1 ? v.qty + "×" : ""}${escapeHtml(v.article)}`).join(", ");
    const heure = vs[0]?.createdAt ? new Date(vs[0].createdAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : "";
    const hasDebtor = Boolean(debiteur && debiteur.trim() && debiteur.trim().toLowerCase() !== "client inconnu");
    return `<div class="list-item" style="cursor:pointer;border-left:3px solid ${hasDebtor ? "#72d7a9" : "#ff8e82"};padding-left:10px;margin-bottom:8px"
              data-credit-facture="${escapeHtml(factureNumber)}"
              data-credit-debiteur="${escapeHtml(debiteur)}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <strong>${escapeHtml(factureNumber)}</strong>
        <span class="badge" style="background:#f5f5f5;color:#333">${fmt(total)} FCFA</span>
      </div>
      <div class="muted" style="font-size:0.82rem;margin-top:2px">${articles}${heure ? " · " + heure : ""}</div>
      ${hasDebtor ? `<div style="font-size:0.82rem;color:#388e3c;margin-top:2px">Débiteur : ${escapeHtml(debiteur)}</div>` : `<div style="font-size:0.82rem;color:#d32f2f;margin-top:2px">Débiteur non renseigné</div>`}
    </div>`;
  }).join("");

  listEl.querySelectorAll("[data-credit-facture]").forEach((el) => {
    el.addEventListener("click", () => {
      const debiteur = el.dataset.creditDebiteur || "";
      const nameInput = document.getElementById("credit-name");
      if (nameInput) { nameInput.value = debiteur; nameInput.focus(); }
      closeModal("modal-credit-factures");
    });
  });

  openModal("modal-credit-factures");
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
        <strong>Aucun solde débiteur actif</strong> — soit tous les crédits sont soldés, soit aucune vente n’a été encaissée en « Crédit client » pour ce maquis. L’historique ci‑dessous masque chaque versement ${CREDIT_HISTORY_SETTLED_RETENTION_DAYS} jours après sa date (si le client est soldé).
      </div>
      ${historyHtml}`;
    return;
  }

  const agesByDebtor = creditAgeInDaysByDebtor();
  const rowsHtml = entries.map(([name, amount]) => {
    const installments = byDebtor[name] || [];
    const age = agesByDebtor[name] || 0;
    const isUrgent = age > 3;
    const urgentBadge = isUrgent
      ? `<span style="display:inline-block;margin-left:7px;background:#ff3b30;color:#fff;font-size:0.68rem;font-weight:700;padding:1px 6px;border-radius:4px;letter-spacing:0.03em;vertical-align:middle">⚠ ${age}j</span>`
      : "";
    const rowBg = isUrgent ? "background:#fff5f5;" : "";
    const headRow = `
            <tr class="credit-debtor-summary" style="${rowBg}">
              <td><strong>${escapeHtml(name)}</strong>${urgentBadge}</td>
              <td class="muted" style="font-size:0.9rem">${escapeHtml(issuerByDebtor[name] || "—")}</td>
              <td class="muted" style="font-size:0.9rem;white-space:nowrap">${creditOpenedByDebtor[name]
                ? `<button type="button" class="credit-moment-btn" data-credit-open-detail="${escapeHtml(name)}" title="Voir toutes les ventes à crédit pour ce client">${escapeHtml(creditOpenedByDebtor[name])}</button>`
                : "—"}</td>
              <td style="text-align:right"><strong style="color:#ff8e82">${fmt(amount)} FCFA</strong></td>
              <td><button type="button" class="mini-btn${isUrgent ? " btn-urgent-credit" : ""}" data-credit-fill="${escapeHtml(name)}">Encaisser</button></td>
            </tr>`;
    const instRows = installments.length
      ? [`<tr class="credit-installment-row"><td colspan="5" class="credit-installment-label">Échéances enregistrées (${installments.length})</td></tr>`,
        ...installments.map((p) => `
            <tr class="credit-installment-row">
              <td colspan="3" style="padding-left:1.1rem;font-size:0.88rem">
                <span class="muted">↳</span>
                <button type="button" class="credit-moment-btn" data-credit-pay-detail="${String(p.id)}" title="Voir le détail du versement">${escapeHtml(formatCreditPaidAt(p))}</button>
                · ${escapeHtml(p.paiement || "—")}
                · <span class="muted">${escapeHtml(formatCreditRecoveryNote(p))}</span>
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

let _creditRecoverySaveInFlight = false;
let _lastCreditRecoverySaveFingerprint = "";
let _lastCreditRecoverySaveFingerprintAt = 0;
const CREDIT_RECOVERY_SAVE_DEDUPE_MS = 4500;

function creditRecoveryIsDuplicateInSite(nameNorm, applied, method, paidAtIso, sourceState = state) {
  const payIso = String(paidAtIso || "").trim();
  const m = String(method || "").trim();
  return creditRecoveriesForSite(sourceState).some(
    (x) =>
      debtorDisplayKey(x.debiteur) === nameNorm &&
      Math.round(Number(x.montant) || 0) === applied &&
      String(x.paiement || "").trim() === m &&
      String(x.paidAt || "").trim() === payIso,
  );
}

function creditRecoveryIsDoublon(p) {
  const nameNorm = debtorDisplayKey(p.debiteur);
  const amount = Math.round(Number(p.montant) || 0);
  const method = String(p.paiement || "").trim();
  const date = String(p.date || "").slice(0, 10);
  return creditRecoveriesForSite().some(
    (x) =>
      Number(x.id) !== Number(p.id) &&
      debtorDisplayKey(x.debiteur) === nameNorm &&
      Math.round(Number(x.montant) || 0) === amount &&
      String(x.paiement || "").trim() === method &&
      String(x.date || "").slice(0, 10) === date,
  );
}

async function saveCreditRecovery() {
  const name = (document.getElementById("credit-name")?.value || "").trim();
  const nameNorm = debtorDisplayKey(name);
  const amountRaw = document.getElementById("credit-amount")?.value;
  const montant = Math.round(Number(digitsOnlyFcfaString(String(amountRaw ?? ""))) || Number(amountRaw) || 0);
  const method = document.getElementById("credit-method")?.value || "Espèces";
  const dtInput = document.getElementById("credit-datetime")?.value?.trim() || "";
  const noteRaw = (document.getElementById("credit-note")?.value || "").trim();
  const note = noteRaw || CREDIT_RECOVERY_DEFAULT_NOTE;
  if (!name) { showToast("Le nom du client débiteur est obligatoire."); return; }
  if (montant <= 0) { showToast("Entrez un montant valide."); return; }
  const siteId = currentSiteId();
  if (!siteId) {
    showToast("Maquis actif non défini : sélectionnez un maquis avant d'enregistrer un versement.");
    return;
  }

  let paidAtIso = new Date().toISOString();
  let dateCalendar = today();
  if (dtInput) {
    const parsed = parseDateTimeLocalInput(dtInput);
    if (!Number.isNaN(parsed.getTime())) {
      paidAtIso = parsed.toISOString();
      dateCalendar = dtInput.slice(0, 10);
    }
  }

  const dueMap = creditOutstandingMap();
  const remaining = Math.round(Number(dueMap[nameNorm]) || 0);
  if (remaining <= 0) {
    showToast(
      "Aucun solde « crédit client » en cours pour ce nom sur ce maquis. Vérifiez l'orthographe (identique aux ventes) et le maquis sélectionné.",
    );
    return;
  }
  const applied = Math.min(montant, remaining);
  if (applied <= 0) {
    showToast("Ce client n'a plus de crédit en cours.");
    return;
  }

  if (_creditRecoverySaveInFlight) {
    showToast("Enregistrement en cours…");
    return;
  }

  const saveBtn = document.getElementById("credit-save-btn");
  const prevCreditText = saveBtn ? saveBtn.textContent : "";
  _creditRecoverySaveInFlight = true;
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Enregistrement…"; }

  try {
    if (creditRecoveryIsDuplicateInSite(nameNorm, applied, method, paidAtIso)) {
      showToast("Ce versement est déjà enregistré (doublon évité).");
      _creditRecoverySaveInFlight = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevCreditText; }
      return;
    }
    const fp = `${nameNorm}|${applied}|${method}|${paidAtIso}`;
    const now = Date.now();
    if (fp === _lastCreditRecoverySaveFingerprint && now - _lastCreditRecoverySaveFingerprintAt < CREDIT_RECOVERY_SAVE_DEDUPE_MS) {
      showToast("Versement déjà pris en compte.");
      _creditRecoverySaveInFlight = false;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevCreditText; }
      return;
    }

    const row = {
      id: state.nextId.creditRecovery++,
      siteId,
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
    _lastCreditRecoverySaveFingerprint = fp;
    _lastCreditRecoverySaveFingerprintAt = Date.now();
    document.getElementById("credit-name").value = nameNorm;
    document.getElementById("credit-amount").value = "";
    document.getElementById("credit-note").value = "";
    const creditDt = document.getElementById("credit-datetime");
    if (creditDt) creditDt.value = datetimeLocalNow();
    const pdjDay = pdjCalendarDate();
    const payDay = creditRecoveryAccountingDate(row);
    const cashHint = isEspecesPaymentMethod(method)
      ? " Compté dans la caisse espèces du point du jour si la date correspond."
      : " Compté dans le CA encaissé (PDJ) ; les paiements mobile/carte ne augmentent pas la caisse espèces.";
    const dayHint = payDay && payDay !== pdjDay
      ? ` Journée PDJ affichée : ${formatDateDdMmYyyy(pdjDay)} — versement rattaché au ${formatDateDdMmYyyy(payDay)}.`
      : "";
    showToast(`Versement enregistré.${cashHint}${dayHint}`);
    renderCreditRecovery();
    renderDashboard();
    renderPointDuJour();
  } catch (err) {
    _creditRecoverySaveInFlight = false;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevCreditText; }
    throw err;
  }
  _creditRecoverySaveInFlight = false;
  if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = prevCreditText; }
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
  await persistState({ purchaseOrders: state.purchaseOrders, supplierPrices: state.supplierPrices, casiers: state.casiers, nextId: state.nextId });
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
  if (po.status === "Reçue") return false;
  po.status = "Reçue";
  const rangerCasiers = opts.rangerCasiers !== false;
  const receivedTotal = Math.round(linesReceived.reduce((sum, l) => sum + (Number(l.amount) || 0), 0));
  if (!linesReceived.length || receivedTotal <= 0) { po.status = "En attente"; return false; }

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
        .filter((c) => (Number(c.bouteillesVides) || 0) === 0 && (Number(c.quantiteActuelle) || 0) < (Number(c.capacite) || 0))
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
      // Réutiliser les casiers vides existants avant d'en créer de nouveaux
      const vides = (state.casiers || [])
        .filter((c) => c.siteId === siteId && String(c.article || "").toLowerCase() === String(item.article || "").toLowerCase())
        .filter((c) => (Number(c.quantiteActuelle) || 0) === 0 && (Number(c.bouteillesVides) || 0) === 0)
        .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));
      vides.forEach((c) => {
        if (remaining <= 0) return;
        const cap = Math.max(1, Number(c.capacite) || cs);
        const fill = Math.min(cap, remaining);
        c.quantiteActuelle = fill;
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
          quantite: fill,
          source: "fournisseur",
          motif: "",
          commentaire: `Réception ${po.supplier || "fournisseur"}`,
          user: sessionUser || "system",
          role: currentRole || "-",
          date: po.date || today(),
          createdAt: new Date().toISOString(),
        });
        remaining -= fill;
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

function orderIsQrCommande(order) {
  return String(order?.source || "").trim() === "qr";
}

/** Commande creee par QR : nom client / table obligatoire pour la suite du traitement. */
function assertNomClientQrCommandeOuToast(clientTrim, existingOrder) {
  if (!existingOrder || !orderIsQrCommande(existingOrder)) return true;
  if (String(clientTrim || "").trim()) return true;
  showToast("Indiquez le nom du client ou de la table (obligatoire pour les commandes creees par QR).");
  return false;
}

/** Si le formulaire vente affiche la même commande, reprend le nom client saisi avant encaissement. */
function syncOrderClientFromVentesFormIfEditing(order) {
  if (!order) return;
  const vSel = Number(document.getElementById("v-order-select")?.value) || 0;
  if (vSel !== order.id) return;
  const t = (document.getElementById("v-client")?.value || "").trim();
  if (t) order.client = t;
}

function ensureOrder(clientName, date, note, selectedOrderIdOverride = undefined, { clientRequestId = "" } = {}) {
  const selectedOrderId = selectedOrderIdOverride !== undefined && selectedOrderIdOverride !== null
    ? Number(selectedOrderIdOverride) || 0
    : (Number(document.getElementById("v-order-select")?.value) || activeOrderId);
  let order = selectedOrderId ? recordsForSite(state.commandes).find((item) => item.id === selectedOrderId) : null;
  if (!order) {
    const draft = {
      siteId: currentSiteId(),
      client: clientName.trim() || "Client",
      table: clientName.trim() || "Client",
      date,
      saisieMode: "Commande",
      server: sessionUser || "Serveur",
      lignes: [],
      clientRequestId: String(clientRequestId || "").trim(),
    };
    const dup = findActiveOrderDuplicate(draft);
    if (dup) {
      order = dup;
      activeOrderId = order.id;
      return order;
    }
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
      clientRequestId: draft.clientRequestId || newOrderClientRequestId(),
    };
    dedupeCommandesInState();
    state.commandes.unshift(order);
  } else {
    order.client = clientName.trim() || order.client;
    order.date = date;
    order.note = note.trim();
    if (!String(order.server || "").trim() && !String(order.serveur || "").trim()) {
      order.server = sessionUser || "Serveur";
      order.serveur = order.server;
    }
  }
  activeOrderId = order.id;
  return order;
}

async function saveOrderLine() {
  const article = document.getElementById("v-article").value.trim();
  const date = document.getElementById("v-date").value || today();
  const product = findKnownProduct(article, date);
  const format = selectedSaleFormat(product, date);
  const prix = formatPrice(format, document.getElementById("v-location").value);
  if (!article || !product || prix <= 0) {
    showToast("Choisissez un article du stock avec un prix catalogue.");
    return;
  }
  const selectedOrderId = Number(document.getElementById("v-order-select").value) || activeOrderId;
  const creatingNewOrder = !selectedOrderId;
  if (!assertCanSellOrToast(date, currentSiteId())) return;
  const existingOrder = selectedOrderId
    ? recordsForSite(state.commandes).find((item) => item.id === selectedOrderId)
    : null;
  const clientTrim = (document.getElementById("v-client").value || "").trim();
  if (!assertNomClientQrCommandeOuToast(clientTrim, existingOrder)) return;
  const order = ensureOrder(document.getElementById("v-client").value, date, document.getElementById("v-note").value);
  const requestedBottles = (Number(document.getElementById("v-qty").value) || 1) * Math.max(1, Number(format?.quantite) || Number(product?.packSize) || 1);
  const availability = stockAvailabilityForLine(product.article, requestedBottles, order.id, null);
  if (!availability.stockItem || availability.available < requestedBottles) {
    if (creatingNewOrder && !(order.lignes && order.lignes.length)) {
      state.commandes = (state.commandes || []).filter((o) => o.id !== order.id);
      if (activeOrderId === order.id) activeOrderId = null;
    }
    showToast(`Stock insuffisant pour ${product.article}. Disponible: ${fmt(availability.available)} bouteille(s).`);
    return;
  }
  const line = {
    id: state.nextId.ligneCommande++,
    date,
    article: product?.article || article,
    cat: product?.cat || "Autres",
    location: document.getElementById("v-location").value,
    formatQuantite: Math.max(1, Number(format?.quantite) || Number(product?.packSize) || 1),
    prix,
    qty: Number(document.getElementById("v-qty").value) || 1,
    remise: 0,
    paiement: "A regler",
    note: document.getElementById("v-note").value.trim(),
  };
  order.lignes.push(line);
  recordStaffAudit("create", "commande_ligne", `Ligne ajoutee · commande #${order.id} · ${order.client || ""}`, `${line.article} · ${fmt(calcNet(line))} FCFA`);
  const saveLineBtn = document.getElementById("save-vente-btn");
  const prevSaveLineText = saveLineBtn ? saveLineBtn.textContent : "";
  if (saveLineBtn) { saveLineBtn.disabled = true; saveLineBtn.textContent = "Enregistrement…"; }
  try {
    await persistState();
    closeModal("modal-vente");
    resetOrderForm();
    renderVentesPage();
    showToast("Ligne ajoutee a la commande.");
  } finally {
    if (saveLineBtn) { saveLineBtn.disabled = false; saveLineBtn.textContent = prevSaveLineText; }
  }
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
    return { error: `Le total saisi (${fmt(paidTotal)} FCFA) doit être égal à ${fmt(total)} FCFA.` };
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
  const oid = Number(orderId);
  if (!oid) return;
  if (finalizeOrderInFlight.has(oid)) {
    showToast("Encaissement déjà en cours, patientez…");
    return;
  }
  const order = state.commandes.find((item) => item.id === oid);
  if (!order || !order.lignes.length) {
    const linked = ventesLinkedToOrder(oid);
    if (linked.length) {
      const fn = linked[0].factureNumber || "";
      state.commandes = state.commandes.filter((item) => item.id !== oid);
      if (activeOrderId === oid) activeOrderId = null;
      pendingFinalizeOrderId = null;
      try {
        await persistStatePatch({ commandes: state.commandes });
        renderVentesPage();
        showToast(fn ? `Commande déjà encaissée (${fn}).` : "Commande déjà encaissée.");
      } catch (e) {
        handleApiError(e);
      }
    } else {
      showToast("Aucune ligne a facturer pour ce client.");
    }
    return;
  }
  syncOrderClientFromVentesFormIfEditing(order);
  if (orderIsQrCommande(order) && !String(order.client || "").trim()) {
    showToast("Indiquez le nom du client ou de la table (obligatoire pour les commandes creees par QR).");
    return;
  }
  const saleDateGuard = String(order.date || today()).slice(0, 10);
  if (!assertCanSellOrToast(saleDateGuard, order.siteId || currentSiteId())) return;
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

  const existingVentes = ventesLinkedToOrder(oid);
  if (existingVentes.length) {
    const factureNumber = existingVentes[0].factureNumber || "";
    state.commandes = state.commandes.filter((item) => item.id !== oid);
    if (activeOrderId === oid) activeOrderId = null;
    pendingFinalizeOrderId = null;
    try {
      await persistStatePatch({ commandes: state.commandes });
      closeModal("modal-vente");
      closeModal("modal-finalize");
      resetOrderForm();
      renderVentesPage();
      showToast(factureNumber ? `Déjà encaissée : ${factureNumber}` : "Commande déjà encaissée.");
      if (factureNumber) showFinalizeSuccess(factureNumber);
    } catch (e) {
      handleApiError(e);
    }
    return;
  }

  const paymentMethod = paymentMix.details.length > 1 ? "Mixte" : paymentMix.details[0].method;
  const site = currentSite();
  const factureNumber = `${site?.prefixeFacture || "FAC"}-${String(state.nextId.invoice++).padStart(4, "0")}`;
  const encaisseAt = new Date().toISOString();
  const creditIssuedBy = paymentMix.details.some((d) => isCreditClientMethod(d.method))
    ? String(sessionUser || "").trim()
    : "";
  const encaisseur = String(sessionUser || order.server || order.serveur || "").trim() || "Serveur";

  const rollback = {
    ventes: state.ventes,
    commandes: state.commandes,
    stock: JSON.parse(JSON.stringify(state.stock || [])),
    nextId: { ...(state.nextId || {}) },
    casiers: state.casiers,
    casierMouvements: state.casierMouvements,
  };

  finalizeOrderInFlight.add(oid);
  const finalizeBtn = document.getElementById("confirm-finalize-btn");
  const prevFinalizeText = finalizeBtn ? finalizeBtn.textContent : "";
  if (finalizeBtn) { finalizeBtn.disabled = true; finalizeBtn.textContent = "Enregistrement…"; }

  try {
    const ventes = order.lignes.map((line) => ({
      id: state.nextId.vente++,
      siteId: order.siteId || currentSiteId(),
      sourceOrderId: oid,
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
      server: encaisseur,
      serveur: encaisseur,
      note: line.note || order.note || "",
      kitGroupId: line.kitGroupId || undefined,
      kitMixLabel: line.kitMixLabel || undefined,
      kitPrice: line.kitPrice || undefined,
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
        drainArticleCasiers(stockItem.article, bottles, { motif: "vente", commentaire: `Facture ${factureNumber}`, factureNumber });
        const saleDate = String(line.date || order.date || today()).slice(0, 10);
        const promoForLine = activePromotion(stockItem, saleDate);
        if (promoForLine && promoForLine.stockPromoRestant != null) {
          const cs = Math.max(1, caseSize(stockItem));
          const casiersSold = bottles / cs;
          const promoIdx = (stockItem.promotions || []).findIndex((p) => Number(p.id) === promoForLine.id);
          if (promoIdx >= 0) {
            stockItem.promotions[promoIdx].stockPromoRestant = Math.max(0, (Number(stockItem.promotions[promoIdx].stockPromoRestant) || 0) - casiersSold);
          }
        }
      }
    });

    state.commandes = state.commandes.filter((item) => item.id !== oid);
    if (activeOrderId === oid) activeOrderId = null;
    pendingFinalizeOrderId = null;
    recordStaffAudit("create", "encaissement", `Facture ${factureNumber} · ${order.client || "Client"}`, `Total ${fmt(orderTotal)} FCFA · ${paymentMethod}${paymentMix.creditName ? ` · debiteur ${paymentMix.creditName}` : ""}`);

    pruneFinalizedCommandesFromState();
    await persistStatePatch({
      ventes: state.ventes,
      commandes: state.commandes,
      stock: state.stock,
      nextId: state.nextId,
      casiers: state.casiers,
      casierMouvements: state.casierMouvements,
    });

    closeModal("modal-vente");
    closeModal("modal-finalize");
    resetOrderForm();
    if (currentPage === "home") renderDashboard();
    if (currentPage === "stock" && stockSubTab === "casiers") renderCasiers();
    renderVentesPage();
    showToast(`Facture ${factureNumber} enregistree pour ${order.client}.`);
    showFinalizeSuccess(factureNumber);
  } catch (e) {
    state.ventes = rollback.ventes;
    state.commandes = rollback.commandes;
    state.stock = rollback.stock;
    state.nextId = rollback.nextId;
    state.casiers = rollback.casiers;
    state.casierMouvements = rollback.casierMouvements;
    handleApiError(e);
    const net =
      !navigator.onLine
      || (typeof e?.message === "string" && (e.message.includes("Failed to fetch") || e.message.includes("NetworkError")));
    showToast(net ? "Problème réseau : rien n'a été encaissé. Réessayez." : "L'encaissement n'a pas été enregistré.");
  } finally {
    finalizeOrderInFlight.delete(oid);
    if (finalizeBtn) { finalizeBtn.disabled = false; finalizeBtn.textContent = prevFinalizeText; }
  }
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
  syncOrderClientFromVentesFormIfEditing(order);
  if (orderIsQrCommande(order) && !String(order.client || "").trim()) {
    showToast("Indiquez le nom du client ou de la table (obligatoire pour les commandes creees par QR).");
    return;
  }
  const saleD = String(order.date || today()).slice(0, 10);
  if (!assertCanSellOrToast(saleD, order.siteId || currentSiteId())) return;
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
  const dual = siteUsesDualZonePricing();
  const kitInt = document.getElementById("s-prix-kit-int");
  const input = document.getElementById("s-price-location-value");
  if (!dual) {
    if (input) input.value = kitInt?.value || "";
    return;
  }
  const location = document.getElementById("s-price-location")?.value || "int";
  const hiddenId = location === "ext" ? "s-prix-kit-ext" : "s-prix-kit-int";
  if (input) input.value = document.getElementById(hiddenId)?.value || "";
}

function commitStockPriceInput() {
  const dual = siteUsesDualZonePricing();
  const input = document.getElementById("s-price-location-value");
  const kitInt = document.getElementById("s-prix-kit-int");
  const kitExt = document.getElementById("s-prix-kit-ext");
  if (!dual) {
    const v = input?.value ?? "";
    if (kitInt) kitInt.value = v;
    if (kitExt) kitExt.value = v;
    return;
  }
  const location = document.getElementById("s-price-location")?.value || "int";
  const hiddenId = location === "ext" ? "s-prix-kit-ext" : "s-prix-kit-int";
  const hidden = document.getElementById(hiddenId);
  if (hidden && input) hidden.value = input.value;
}

function renderStockSaleFormats(formats = [{ quantite: 1, prixInterieur: "", prixExterieur: "" }]) {
  const container = document.getElementById("sale-formats-list");
  if (!container) return;
  const dual = siteUsesDualZonePricing();
  const rows = formats.length ? formats : [{ quantite: 1, prixInterieur: "", prixExterieur: "" }];
  container.innerHTML = rows.map((format, index) => `
    <div class="sale-format-row" data-format-row>
      <div class="form-group">
        <label>Quantite</label>
        <input class="stock-format-qty" type="number" min="1" value="${escapeHtml(format.quantite || 1)}" placeholder="1">
      </div>
      ${dual
      ? `<div class="form-group">
        <label>Prix cave</label>
        <input class="stock-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || "")}" placeholder="ex: 700">
      </div>
      <div class="form-group">
        <label>Prix maquis</label>
        <input class="stock-format-ext" type="number" min="0" value="${escapeHtml(format.prixExterieur || "")}" placeholder="ex: 600">
      </div>`
      : `<div class="form-group">
        <label>Prix de vente (FCFA)</label>
        <input class="stock-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || format.prixExterieur || "")}" placeholder="ex: 700">
      </div>`}
      <button type="button" class="mini-btn" data-remove-sale-format="${index}" ${rows.length <= 1 ? "disabled" : ""}>Retirer</button>
    </div>
  `).join("");
  renderStockMargePreview();
}

function readPromoFormatsFromRow(promoRow) {
  const dual = siteUsesDualZonePricing();
  const byQuantity = new Map();
  [...promoRow.querySelectorAll("[data-promo-format-row]")].forEach((fRow) => {
    const quantite = Math.max(1, Number(fRow.querySelector(".promo-format-qty")?.value) || 1);
    const prixInterieur = Number(fRow.querySelector(".promo-format-int")?.value) || 0;
    const prixExterieur = dual
      ? (Number(fRow.querySelector(".promo-format-ext")?.value) || prixInterieur)
      : prixInterieur;
    if (prixInterieur > 0) byQuantity.set(quantite, { quantite, prixInterieur, prixExterieur });
  });
  return [...byQuantity.values()].sort((a, b) => a.quantite - b.quantite);
}

function readStockPromotions() {
  return [...document.querySelectorAll("[data-promo-row]")].map((row) => {
    const srRaw = row.querySelector(".promo-stock-restant")?.value?.trim();
    return {
      id: Number(row.dataset.promoId) || 0,
      libelle: row.querySelector(".promo-libelle")?.value?.trim() || "Promotion",
      dateDebut: row.querySelector(".promo-debut")?.value || "",
      dateFin: row.querySelector(".promo-fin")?.value?.trim() || "",
      formatsVente: readPromoFormatsFromRow(row),
      stockPromoRestant: srRaw !== "" && srRaw != null ? Number(srRaw) : null,
    };
  }).filter((p) => p.dateDebut && p.formatsVente.length);
}

function renderStockPromotions(promotions = []) {
  const container = document.getElementById("stock-promotions-list");
  if (!container) return;
  const dual = siteUsesDualZonePricing();
  const rows = Array.isArray(promotions) ? promotions : [];
  container.innerHTML = rows.length
    ? rows.map((p) => {
      const pid = Number(p.id) || Date.now() + Math.floor(Math.random() * 1000);
      const formats = normalizeSaleFormatsFromRaw(p.formatsVente, p);
      const formatRows = (formats.length ? formats : [{ quantite: 1, prixInterieur: "", prixExterieur: "" }]).map((format) => `
        <div class="sale-format-row" data-promo-format-row>
          <div class="form-group">
            <label>Qté</label>
            <input class="promo-format-qty" type="number" min="1" value="${escapeHtml(format.quantite || 1)}">
          </div>
          ${dual
          ? `<div class="form-group"><label>Cave</label><input class="promo-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || "")}"></div>
          <div class="form-group"><label>Maquis</label><input class="promo-format-ext" type="number" min="0" value="${escapeHtml(format.prixExterieur || "")}"></div>`
          : `<div class="form-group"><label>Prix vente</label><input class="promo-format-int" type="number" min="0" value="${escapeHtml(format.prixInterieur || format.prixExterieur || "")}"></div>`}
        </div>
      `).join("");
      return `<div class="stock-promo-card" data-promo-row data-promo-id="${pid}">
        <div class="form-grid two-cols">
          <div class="form-group">
            <label>Libellé</label>
            <input class="promo-libelle" type="text" value="${escapeHtml(p.libelle || "")}" placeholder="ex: Promo weekend">
          </div>
          <div class="form-group">
            <label>&nbsp;</label>
            <button type="button" class="mini-btn" data-copy-catalog-to-promo="${pid}">Copier tarifs catalogue</button>
          </div>
        </div>
        <div class="form-grid two-cols">
          <div class="form-group">
            <label>Date début</label>
            <input class="promo-debut" type="date" value="${escapeHtml(p.dateDebut || today())}">
          </div>
          <div class="form-group">
            <label>Date fin (optionnel)</label>
            <input class="promo-fin" type="date" value="${escapeHtml(p.dateFin || "")}">
          </div>
        </div>
        <div class="form-group">
          <label>Casiers promo restants <span class="form-hint" style="display:inline">(laisser vide = illimité)</span></label>
          <input class="promo-stock-restant" type="number" min="0" step="0.01" value="${p.stockPromoRestant != null ? escapeHtml(String(p.stockPromoRestant)) : ""}" placeholder="ex: 5">
        </div>
        ${p.stockPromoRestant != null && p.stockPromoRestant <= 0 ? `<p class="form-hint" style="color:var(--danger,#e53e3e);font-weight:600;">⚠ Stock promo épuisé — prix catalogue actif automatiquement.</p>` : ""}
        <p class="form-hint">Tarifs promo (mêmes formats que le catalogue)</p>
        <div class="sale-formats-list">${formatRows}</div>
        <button type="button" class="mini-btn stock-promo-remove" data-remove-promo="${pid}">Retirer cette promotion</button>
      </div>`;
    }).join("")
    : `<p class="form-hint muted">Aucune promotion programmée. Le tarif catalogue s'applique en permanence.</p>`;
}

function addStockPromotion() {
  renderStockPromotions([
    ...readStockPromotions(),
    {
      id: Date.now(),
      libelle: "Promotion",
      dateDebut: today(),
      dateFin: "",
      stockPromoRestant: null,
      formatsVente: readStockSaleFormats(),
    },
  ]);
}

function copyCatalogPricesToPromo(promoId) {
  const promos = readStockPromotions();
  const idx = promos.findIndex((p) => Number(p.id) === Number(promoId));
  if (idx < 0) return;
  promos[idx] = { ...promos[idx], formatsVente: readStockSaleFormats() };
  renderStockPromotions(promos);
  showToast("Tarifs catalogue copiés dans la promotion.");
}

function stockMarginPreviewFromDom() {
  const cs = Math.max(1, Number(document.getElementById("s-case-size")?.value) || 24);
  const paCasier = Number(document.getElementById("s-prix")?.value) || 0;
  const paBtl = paCasier > 0 ? paCasier / cs : 0;
  const dual = siteUsesDualZonePricing();
  const rows = [...document.querySelectorAll("[data-format-row]")];
  const priced = rows.map((row) => {
    const q = Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1);
    const int = Number(row.querySelector(".stock-format-int")?.value) || 0;
    const ext = dual
      ? (Number(row.querySelector(".stock-format-ext")?.value) || int)
      : int;
    return { q, int, ext };
  }).filter((r) => r.int > 0);
  const primary = priced.find((r) => r.q === 1) || priced[0];
  let pvInt = 0;
  let pvExt = 0;
  let packNote = "";
  if (primary) {
    pvInt = primary.int / primary.q;
    pvExt = primary.ext / primary.q;
    if (primary.q > 1) {
      packNote = ` (prix unitaire déduit du format ×${primary.q})`;
    }
  }
  return { cs, paCasier, paBtl, pvInt, pvExt, packNote, dual };
}

function renderStockMargePreview() {
  const host = document.getElementById("stock-marge-preview");
  if (!host) return;
  const { cs, paCasier, paBtl, pvInt, pvExt, packNote, dual } = stockMarginPreviewFromDom();
  if (paCasier <= 0 && pvInt <= 0 && pvExt <= 0) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  const lines = [];
  if (paCasier > 0) {
    lines.push(`<div class="margin-line"><span>Prix achat / bouteille</span><strong>${fmt(Math.round(paBtl))} FCFA</strong></div>`);
    lines.push(`<p class="form-hint" style="margin:0 0 6px">Casier ${fmt(paCasier)} FCFA ÷ ${fmt(cs)} btl.</p>`);
  } else {
    lines.push(`<p class="form-hint" style="margin:0 0 6px">Renseignez le prix du casier pour voir le coût par bouteille.</p>`);
  }
  const addZone = (label, pv, zone) => {
    if (pv <= 0) return;
    const mBtl = paBtl > 0 ? pv - paBtl : null;
    const mCas = mBtl != null ? mBtl * cs : null;
    lines.push(`<div class="margin-line"><span>Prix vente ${label}${packNote}</span><strong>${fmt(Math.round(pv))} FCFA / btl.</strong></div>`);
    if (mBtl != null) {
      lines.push(`<div class="margin-line"><span>Bénéfice / bouteille (${label})</span>${formatMarginFcfa(mBtl)} FCFA</div>`);
      lines.push(`<div class="margin-line"><span>Bénéfice / casier (${label})</span>${formatMarginFcfa(mCas)} FCFA</div>`);
    }
  };
  if (dual) {
    addZone("cave", pvInt, "int");
    addZone("maquis", pvExt, "ext");
  } else {
    addZone("unitaire", pvInt || pvExt, "int");
  }
  if (paBtl > 0 && pvInt <= 0 && pvExt <= 0) {
    lines.push(`<p class="form-hint" style="margin:6px 0 0">Ajoutez un prix de vente (format ×1 ou kit) pour voir le bénéfice.</p>`);
  }
  host.innerHTML = `<p class="stock-marge-preview-title">Rentabilité (calcul automatique)</p>${lines.join("")}`;
}

function readStockSaleFormats() {
  const dual = siteUsesDualZonePricing();
  const rows = [...document.querySelectorAll("[data-format-row]")];
  const byQuantity = new Map();
  rows.forEach((row) => {
    const quantite = Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1);
    const prixInterieur = Number(row.querySelector(".stock-format-int")?.value) || 0;
    const prixExterieur = dual
      ? (Number(row.querySelector(".stock-format-ext")?.value) || prixInterieur)
      : prixInterieur;
    if (prixInterieur > 0) byQuantity.set(quantite, { quantite, prixInterieur, prixExterieur });
  });
  return [...byQuantity.values()].sort((a, b) => a.quantite - b.quantite);
}

/** Les champs « Prix kit » du modal peuvent différer des inputs des lignes formats ; on les impose pour éviter de ré-enregistrer d’anciens prix. */
function mergeStockModalKitPricesIntoFormats(formats) {
  const kitInt = Number(document.getElementById("s-prix-kit-int")?.value) || 0;
  const kitExt = Number(document.getElementById("s-prix-kit-ext")?.value) || 0;
  const packFromForm = Math.max(1, Number(document.getElementById("s-pack")?.value) || 1);
  if (kitInt <= 0) return formats;
  const ext = siteUsesDualZonePricing() ? (kitExt > 0 ? kitExt : kitInt) : kitInt;
  const list = Array.isArray(formats) ? formats.slice() : [];
  if (!list.length) {
    return [{ quantite: packFromForm, prixInterieur: kitInt, prixExterieur: ext }];
  }
  const targetQty = list.some((f) => f.quantite === packFromForm) ? packFromForm : list[0].quantite;
  let hit = false;
  const out = list.map((f) => {
    if (f.quantite === targetQty) {
      hit = true;
      return { quantite: f.quantite, prixInterieur: kitInt, prixExterieur: ext };
    }
    return f;
  });
  if (!hit) {
    out.push({ quantite: targetQty, prixInterieur: kitInt, prixExterieur: ext });
    out.sort((a, b) => a.quantite - b.quantite);
  }
  return out;
}

function addStockSaleFormat() {
  const dual = siteUsesDualZonePricing();
  const formats = [...document.querySelectorAll("[data-format-row]")].map((row) => {
    const pi = Number(row.querySelector(".stock-format-int")?.value) || "";
    const pe = dual ? (Number(row.querySelector(".stock-format-ext")?.value) || "") : pi;
    return {
      quantite: Math.max(1, Number(row.querySelector(".stock-format-qty")?.value) || 1),
      prixInterieur: pi,
      prixExterieur: pe,
    };
  });
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
  renderStockPromotions([]);
  updateStockPriceInput();
  renderStockMargePreview();
  document.getElementById("stock-modal-title").textContent = "Nouvel article en stock";
  document.getElementById("save-stock-btn").textContent = "Enregistrer l'article";
  syncSingleBreweryUi();
}

function openEditStock(itemId) {
  if (!canEditStockCatalog()) {
    showToast("Modification du catalogue reservee aux administrateurs.");
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
  if (!siteUsesDualZonePricing()) {
    document.getElementById("s-prix-kit-ext").value = document.getElementById("s-prix-kit-int").value;
  }
  document.getElementById("s-price-location").value = "int";
  renderStockSaleFormats(baseSaleFormats(item));
  renderStockPromotions(normalizePromotions(item));
  updateStockPriceInput();
  renderStockMargePreview();
  document.getElementById("stock-modal-title").textContent = `Modifier : ${item.article}`;
  document.getElementById("save-stock-btn").textContent = "Enregistrer les modifications";
  syncSingleBreweryUi();
  openModal("modal-stock");
}

async function saveStock() {
  commitStockPriceInput();
  const editId = document.getElementById("s-edit-id").value;
  if (editId && !canEditStockCatalog()) {
    showToast("Modification du catalogue reservee aux administrateurs.");
    return;
  }
  if (!editId && !canManage()) {
    showToast("Ajout au catalogue reserve au gerant ou administrateur.");
    return;
  }
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
  fields.formatsVente = mergeStockModalKitPricesIntoFormats(readStockSaleFormats());
  if (!siteUsesDualZonePricing()) {
    fields.formatsVente = fields.formatsVente.map((f) => ({
      ...f,
      prixExterieur: f.prixInterieur,
    }));
  }
  const primaryFormat = fields.formatsVente.find((format) => format.quantite === 1) || fields.formatsVente[0];
  fields.packSize = Math.max(1, Number(primaryFormat?.quantite) || Number(document.getElementById("s-pack").value) || 1);
  fields.prixVenteInt = Number(primaryFormat?.prixInterieur) || Number(document.getElementById("s-prix-kit-int").value) || 0;
  fields.prixVenteExt = Number(primaryFormat?.prixExterieur) || Number(document.getElementById("s-prix-kit-ext").value) || fields.prixVenteInt;
  if (!siteUsesDualZonePricing()) {
    fields.prixVenteExt = fields.prixVenteInt;
  }
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
    showToast(
      siteUsesDualZonePricing()
        ? "Prix achat et au moins un format avec prix cave obligatoires."
        : "Prix achat et au moins un format avec prix de vente obligatoires.",
    );
    return;
  }
  if (fields.prixVenteExt <= 0) {
    fields.prixVenteExt = fields.prixVenteInt;
  }
  fields.promotions = readStockPromotions();
  let _rollbackSnapshot = null;
  if (editId) {
    const item = state.stock.find((i) => i.id === Number(editId));
    if (item) {
      const before = JSON.parse(JSON.stringify(item));
      _rollbackSnapshot = before;
      Object.assign(item, fields);
      touchStockItemUpdated(item);
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
      pushChange("Promotions", (before.promotions || []).length, (item.promotions || []).length);
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
    const newItem = { id: state.nextId.stock++, siteId: currentSiteId(), entrees: 0, sorties: 0, createdAt: new Date().toISOString(), createdBy: sessionUser || "-", ...fields };
    touchStockItemUpdated(newItem);
    state.stock.push(newItem);
    recordStaffAudit("create", "catalogue_article", `Article ajoute : ${articleName}`, `${fields.cat} · PA ${fmt(fields.prixAchat)}/cas. · vente int. ${fmt(fields.prixVenteInt)}`);
  }
  const saveBtn = document.getElementById("save-stock-btn");
  const prevBtnHtml = saveBtn ? saveBtn.innerHTML : "";
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Enregistrement…";
  }
  let saveOk = false;
  try {
    await persistStatePatch({
      stock: state.stock,
      nextId: state.nextId,
      staffAuditLog: state.staffAuditLog,
    });
    saveOk = true;
  } catch (err) {
    // Rollback : restaurer l'état local pour que la sync ne perde pas les données
    if (editId && _rollbackSnapshot) {
      const rollbackItem = state.stock.find((i) => i.id === Number(editId));
      if (rollbackItem) Object.assign(rollbackItem, _rollbackSnapshot);
    } else if (!editId) {
      state.stock = state.stock.filter((i) => i.id !== state.nextId.stock - 1);
    }
    state.staffAuditLog = (state.staffAuditLog || []).slice(0, -1);
    throw err;
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = prevBtnHtml;
    }
  }
  if (!saveOk) return;
  closeModal("modal-stock");
  resetStockForm();
  populateCategorySelects();
  if (currentPage === "home") renderDashboard();
  renderStock();
  if (currentPage === "stock" && stockSubTab === "casiers") renderCasiers();
  showToast(editId ? `"${articleName}" mis a jour.` : "Article catalogue ajoute.");
}

/** Acteur (compte) ayant enregistré l'encaissement, indexé par numéro de facture — utile si les ventes n'ont pas encore le champ serveur. */
function encaissementActorByFactureNumber(sourceState = state) {
  const map = Object.create(null);
  const log = Array.isArray(sourceState?.staffAuditLog) ? sourceState.staffAuditLog : [];
  for (const row of log) {
    if (String(row?.entity || "").trim() !== "encaissement") continue;
    const m = String(row.summary || "").match(/Facture\s+([A-Za-z0-9_-]+)/i);
    if (!m) continue;
    const fn = m[1].trim();
    if (!fn || map[fn]) continue;
    const actor = String(row.actor || "").trim();
    if (actor) map[fn] = actor;
  }
  return map;
}

function stockMovementDateValue(item) {
  return String(item.date || item.createdAt || "").slice(0, 10);
}

/** Libellé « Utilisateur » pour la traçabilité : ne pas attribuer la vente à la personne qui consulte l’écran. */
function formatStockMovementUser(item) {
  const raw = String(item?.user ?? "").trim();
  if (!raw || raw === "-" || raw === "—" || raw === "–") return "Non renseigné";
  if (/^admin$/i.test(raw)) return "Import / identifiant système hérité";
  return raw;
}

function stockMovements() {
  const siteId = currentSiteId();
  const multiSite = multiSiteActive();
  const movements = [];

  recordsForSite(state.stock).forEach((item) => {
    const created = item.createdAt || today();
    if (Number(item.init) > 0) {
      movements.push({
        date: created,
        article: item.article,
        type: "entree",
        qty: Number(item.init) || 0,
        unit: "Bouteille",
        reason: "Stock initial (catalogue)",
        user: item.createdBy || "",
      });
    }
  });

  (state.stockEntrees || [])
    .filter((e) => rowMatchesSite(e, siteId, multiSite))
    .forEach((e) => {
      const stockRow = (state.stock || []).find((s) => s.siteId === siteId && s.article === e.article) || {};
      movements.push({
        date: e.date,
        article: e.article,
        type: "entree",
        qty: e.qty,
        unit: "Bouteille",
        reason: `Achat fournisseur (${fmtPurchaseCases(e.cases)} casier(s) × ${fmt(e.caseSize)} btl)`,
        user: e.user || e.createdBy || stockRow.lastReapproBy || stockRow.createdBy || "",
      });
    });

  (state.stockLosses || []).filter((l) => rowMatchesSite(l, siteId, multiSite)).forEach((loss) => {
    movements.push({
      date: loss.date || loss.createdAt || today(),
      article: loss.article,
      type: "sortie",
      qty: loss.qty,
      unit: "Bouteille",
      reason: `Perte : ${loss.motif}${loss.notes ? " – " + loss.notes : ""}`,
      user: loss.createdBy || "",
    });
  });

  const encActors = encaissementActorByFactureNumber(state);
  recordsForSite(state.ventes).forEach((vente) => {
    const stockItem = stockItemForArticle(vente.article, siteId);
    const fn = String(vente.factureNumber || "").trim();
    const fromAudit = fn ? encActors[fn] : "";
    const seller = [vente.server, vente.serveur, vente.creditIssuedBy, fromAudit]
      .map((x) => String(x || "").trim())
      .find((x) => x && x !== "-" && x !== "—" && x !== "–") || "";
    movements.push({
      date: vente.date || today(),
      article: vente.article,
      type: "sortie",
      qty: lineBottleQty(vente, stockItem),
      unit: "Bouteille",
      reason: fn ? `Vente · facture ${fn}` : `Vente · ligne #${vente.id}`,
      user: seller,
    });
  });
  return movements;
}

function renderStockMovements() {
  const start = document.getElementById("stock-move-start")?.value || "";
  const end = document.getElementById("stock-move-end")?.value || "";
  const type = document.getElementById("stock-move-type")?.value || "all";
  const inPeriod = (item) => {
    const date = stockMovementDateValue(item);
    return (!start || date >= start) && (!end || date <= end);
  };
  const allInPeriod = stockMovements().filter(inPeriod);
  const movements = allInPeriod
    .filter((item) => type === "all" || item.type === type)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const entreePeriod = allInPeriod.filter((item) => item.type === "entree").reduce((sum, item) => sum + item.qty, 0);
  const sortiePeriod = allInPeriod.filter((item) => item.type === "sortie").reduce((sum, item) => sum + item.qty, 0);
  document.getElementById("stock-movement-count").textContent = `${fmt(movements.length)} mouvement(s)`;
  document.getElementById("stock-movement-summary").innerHTML = `
    <div class="pdj-kpi"><span class="kpi-label">Lignes affichées</span><strong class="pdj-val amber">${fmt(movements.length)}</strong></div>
    <div class="pdj-kpi"><span class="kpi-label">Entrées (période)</span><strong class="pdj-val amber">${fmt(entreePeriod)}</strong></div>
    <div class="pdj-kpi"><span class="kpi-label">Sorties (période)</span><strong class="pdj-val red">${fmt(sortiePeriod)}</strong></div>
  `;
  document.getElementById("stock-movement-list").innerHTML = movements.length
    ? movements.map((item) => `<tr>
      <td>${escapeHtml(formatDateDdMmYyyy(item.date || item.createdAt))}</td>
      <td>${escapeHtml(item.article)}</td>
      <td>${item.type === "entree" ? "Entree" : "Sortie"}</td>
      <td style="text-align:right">${fmt(item.qty)}</td>
      <td>${escapeHtml(item.unit)}</td>
      <td>${escapeHtml(item.reason)}</td>
      <td>${escapeHtml(formatStockMovementUser(item))}</td>
    </tr>`).join("")
    : `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:32px">Aucun mouvement trouve</td></tr>`;
}

function closureCashSnapshot(dStr) {
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum : sum + a, 0);
  const creditEmisJour = creditIssuedOnDate(dStr);
  const caCreances = totalCreditOutstanding();
  const especesVentes = Number(totauxJour["Espèces"]) || Number(totauxJour["EspÃ¨ces"]) || 0;
  const especesRecouvrement = especesFromCreditRecoveriesForDate(dStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces")
    || normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("EspÃ¨ces")
      ? sum + (Number(c.montant) || 0)
      : sum
  ), 0);
  const dayBook = dayBookFor(dStr, currentSiteId());
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  /** Même règle que l'écran PDJ : théorique = ouverture + ventes espèces + recouvrement crédit espèces. */
  const expectedEspecesCash = openingCash + especesVentes + especesRecouvrement;
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
  if (!canClosePdjDay()) {
    const shifts = activeWorkShiftsNow(sessionUser, currentSiteId());
    if (staffRequiresShiftWindowForSales() && !shifts.length) {
      showToast("Clôture réservée à votre créneau de service (voir Planning → Mes horaires).");
    } else {
      showToast("Clôture de journée non autorisée pour ce compte.");
    }
    return;
  }
  const items = recordsForSite(state.stock);
  if (!items.length) {
    showToast("Aucun stock a verifier.");
    return;
  }
  const dStr = pdjCalendarDate();
  const pendingForClose = pendingOrdersForJournalDate(dStr, currentSiteId());
  // Ne pas comparer dStr à today() : la journée ouverte peut être la veille (nuit / décalage)
  // jusqu'à clôture — seuls les admins peuvent choisir une autre date via le sélecteur PDJ.
  let dayBook = dayBookFor(dStr, currentSiteId());
  const isPastDateCorrection = dStr !== today() && canAnyAdmin();
  if (!isPastDateCorrection && PDJ_REQUIRE_CASH_OPENING && (!dayBook || dayBookNeedsCashOpening(dayBook))) {
    ensureAccountingDayOpenedFromPreviousClose(currentSiteId(), dStr);
    dayBook = dayBookFor(dStr, currentSiteId());
  }
  if (!isPastDateCorrection && PDJ_REQUIRE_CASH_OPENING && (!dayBook || dayBookNeedsCashOpening(dayBook))) {
    const prevClosed = previousClosedJournalDate(dStr, currentSiteId());
    showToast(prevClosed
      ? `La journée du ${formatDateDdMmYyyy(dStr)} doit être ouverte automatiquement après la clôture du ${formatDateDdMmYyyy(prevClosed)}. Rechargez la page (Ctrl+F5).`
      : dStr === today()
        ? "Enregistrez d'abord l'ouverture de caisse pour aujourd'hui."
        : "Enregistrez d'abord l'ouverture de caisse pour cette journee.");
    return;
  }
  if (pendingForClose.length) {
    showToast(
      `${pendingForClose.length} commande(s) en attente pour le ${formatDateDdMmYyyy(dStr)}. Passez-les en « Servi » ou annulez-les (Ventes) avant de clôturer.`,
    );
    return;
  }
  if (pdjClosureBlockedNoSales(dStr)) {
    showToast("Clôture impossible : aucune vente enregistrée pour cette date. Enregistrez au moins une vente avant de clôturer.");
    return;
  }
  const isFinDeService = !canManagePdjAccounting();
  const closingRaw = document.getElementById("pdj-closing-cash")?.value;
  if (!isFinDeService && !isPastDateCorrection && (closingRaw === undefined || closingRaw === null || String(closingRaw).trim() === "")) {
    showToast("Saisissez le montant espèces dénombrées à la fermeture.");
    return;
  }
  const closingCashFcfa = isFinDeService ? 0 : Math.max(0, Number(closingRaw) || 0);
  if (!isFinDeService && Number.isNaN(closingCashFcfa)) {
    showToast("Montant de fermeture invalide.");
    return;
  }

  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce((sum, [m, a]) => String(m).includes("dit client") ? sum : sum + a, 0);
  const creditEmisJour = creditIssuedOnDate(dStr);
  const caCreances = totalCreditOutstanding();
  const especesVentes = Number(totauxJour["Espèces"]) || Number(totauxJour["EspÃ¨ces"]) || 0;
  const especesRecouvrement = especesFromCreditRecoveriesForDate(dStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);
  const especesCharges = chargesJour.reduce((sum, c) => (
    normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("Espèces")
    || normalizePaymentMethodKey(c.paiement) === normalizePaymentMethodKey("EspÃ¨ces")
      ? sum + (Number(c.montant) || 0)
      : sum
  ), 0);
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  /** Même règle que l'écran PDJ : théorique = ouverture + ventes espèces + recouvrement crédit espèces. */
  const expectedEspecesCash = openingCash + especesVentes + especesRecouvrement;
  const cashEcartEspeces = closingCashFcfa - expectedEspecesCash;

  const recapCloture = isFinDeService
    ? [
        `Date : ${formatDateDdMmYyyy(dStr)}`,
        `CA encaissé : ${fmt(caEncaisse)} FCFA`,
        `Ventes du jour : ${ventesJour.length}`,
        `Stock : le gérant vérifiera le stock physique et la caisse lors de la validation.`,
      ].join("\n")
    : [
        `Date : ${formatDateDdMmYyyy(dStr)}`,
        `CA encaissé : ${fmt(caEncaisse)} FCFA`,
        `Reste à recouvrer (crédit) : ${fmt(caCreances)} FCFA`,
        `Ventes du jour : ${ventesJour.length}`,
        `Caisse espèces : théorique ${fmt(expectedEspecesCash)} · dénombré ${fmt(closingCashFcfa)} · écart ${cashEcartEspeces > 0 ? "+" : ""}${fmt(cashEcartEspeces)}`,
      ].join("\n");
  const confirmMsg = isFinDeService
    ? `Confirmer la fin de service ?\n\nLa journée du ${formatDateDdMmYyyy(dStr)} sera transmise au gérant pour validation. Vous ne pourrez plus ajouter de ventes après confirmation.\n\n${recapCloture}`
    : `Confirmer la clôture de journée ?\n\nCette opération enregistre le stock et la caisse pour la date choisie.\n\n${recapCloture}`;
  if (!window.confirm(confirmMsg)) {
    return;
  }

  const existingCloseCheck = stockCheckForSiteDate(dStr, currentSiteId());
  const checkedItems = items.map((item) => {
    const frigo = isFinDeService
      ? Math.max(0, stockFrigo(item))
      : Math.max(0, Number(document.querySelector(`[data-check-frigo="${item.id}"]`)?.value) || 0);
    const reserve = isFinDeService
      ? Math.max(0, stockReserve(item))
      : Math.max(0, Number(document.querySelector(`[data-check-reserve="${item.id}"]`)?.value) || 0);
    const existingCloseItem = existingCloseCheck ? (existingCloseCheck.items || []).find((ci) => Number(ci.id) === Number(item.id)) : null;
    const stockAtOpen = stockOpeningFromDayBook(item, dayBook)
      ?? existingCloseItem?.stockAvant
      ?? stockActuel(item);
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
  // Avertissement informatif uniquement pour les non-admins (pas pour la serveuse : le gérant vérifie)
  if (stockGaps.length && !canAnyAdmin() && !isFinDeService) {
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
  const closedByRole = String(currentRole || "").trim();
  const managerClose = canManagePdjAccounting();
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
    especesChargesJour: especesCharges,
    caEncaisse,
    caCreances,
    caCreancesEmisesJour: creditEmisJour,
    nbVentes: ventesJour.length,
    totauxJour,
    items: checkedItems,
    closedBy: sessionUser || "",
    closedByRole,
    managerConfirmedAt: managerClose ? new Date().toISOString() : null,
    managerConfirmedBy: managerClose ? (sessionUser || "") : null,
    noSalesReason: ventesJour.length === 0
      ? String(document.getElementById("pdj-no-sales-reason")?.value ?? _pdjNoSalesReasonDraft).trim() || undefined
      : undefined,
  };
  state.stockChecks = [
    check,
    ...(state.stockChecks || []).filter((item) => !(item.siteId === check.siteId && item.date === check.date)),
  ];
  _pdjNoSalesReasonDraft = "";
  // Clôture manuelle : effacer le marqueur de réouverture pour ce jour
  _autoClotureManualReopened.delete(`${check.siteId}|${check.date}`);
  const dayBookToUnmark = (state.dayBooks || []).find((b) => b.siteId === check.siteId && b.date === check.date);
  if (dayBookToUnmark) delete dayBookToUnmark.manualReopenedAt;
  const gapLines = stockGaps
    .slice()
    .sort((a, b) => Math.abs(Number(b.ecart) || 0) - Math.abs(Number(a.ecart) || 0))
    .map((g, i) => {
      const sign = g.ecart > 0 ? "+" : "";
      return `${i + 1}. ${g.article} · ouv ${fmt(g.stockAvant)} · ventes ${fmt(g.sortiesToday)} · theo ${fmt(g.expected)} · compte ${fmt(g.counted)} (F ${fmt(g.frigo)} / R ${fmt(g.reserve)}) · ecart ${sign}${fmt(g.ecart)}`;
    });
  const cashBlock = [
    `Date: ${formatDateDdMmYyyy(dStr)}`,
    `CA encaisse: ${fmt(caEncaisse)} FCFA · Reste a recouvrer: ${fmt(caCreances)} FCFA · Credits emis jour: ${fmt(creditEmisJour)} FCFA · Nb ventes: ${fmt(ventesJour.length)}`,
    `Caisse especes: ouverture ${fmt(openingCash)} · ventes ${fmt(especesVentes)} · recouvrement credit especes ${fmt(especesFromCreditRecoveriesForDate(dStr))} · depenses jour espèces (info) ${fmt(especesCharges)} · theorique ${fmt(expectedEspecesCash)} · denombre ${fmt(closingCashFcfa)} · ecart ${cashEcartEspeces > 0 ? "+" : ""}${fmt(cashEcartEspeces)}`,
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
  const sidClose = currentSiteId();
  const autoOpen = managerClose && !isPastDateCorrection
    ? autoOpenNextAccountingDayAfterClose(sidClose, dStr, closingCashFcfa, { actorLabel: sessionUser })
    : null;
  if (isPastDateCorrection && managerClose) {
    // Reclôture d'une date passée : rafraîchir uniquement le snapshot du lendemain
    // si son dayBook existe déjà (ne pas créer de nouvelle ouverture).
    const nextD = addCalendarDaysIso(dStr, 1);
    const nextBook = dayBookFor(nextD, sidClose);
    if (nextBook && !dayBookNeedsCashOpening(nextBook)) {
      const snap = captureOpeningStockSnapshot();
      nextBook.openingStockById = snap;
      nextBook.autoOpenedFromDate = dStr;
      state.dayBooks = [nextBook, ...(state.dayBooks || []).filter((b) => !(b.siteId === sidClose && b.date === nextD))];
    }
  }
  if (!autoOpen && managerClose) {
    const pdjMapClose = { ...(state.pdjWorkDateBySite || {}) };
    if (pdjMapClose[sidClose] === dStr) delete pdjMapClose[sidClose];
    state.pdjWorkDateBySite = pdjMapClose;
  }
  const savedStockChecks = state.stockChecks;
  const closeBtn = document.getElementById("close-day-btn");
  const prevCloseText = closeBtn ? closeBtn.textContent : "";
  if (closeBtn) { closeBtn.disabled = true; closeBtn.textContent = "Clôture en cours…"; }
  try {
    await persistState({
      stock: state.stock,
      stockChecks: state.stockChecks,
      dayBooks: state.dayBooks,
      pdjWorkDateBySite: state.pdjWorkDateBySite,
    });
    if (!stockCheckForSiteDate(dStr, sidClose) && savedStockChecks?.length) {
      state.stockChecks = savedStockChecks;
    }
    delete pdjClosingCashDraftBySiteDate[pdjOpeningCashDraftKey(sidClose, dStr)];
    if (autoOpen?.nextDate) {
      setPdjBrowseDate(null);
      syncPdjWorkDateInput();
      pdjSubTab = "synthese";
    } else {
      setPdjBrowseDate(dStr);
      pdjSubTab = "cloture";
    }
    renderStock();
    renderDashboard();
    renderPointDuJour();
    setPdjSubTab(pdjSubTab, { scrollTop: true });
    if (isFinDeService) {
      showToast(`Fin de service du ${formatDateDdMmYyyy(dStr)} transmise au gérant. En attente de validation.`);
    } else {
      const cashHint = cashEcartEspeces === 0 ? "" : ` Écart espèces : ${cashEcartEspeces > 0 ? "+" : ""}${fmt(cashEcartEspeces)} FCFA.`;
      const nextMsg = autoOpen?.nextDate
        ? ` Journée suivante (${formatDateDdMmYyyy(autoOpen.nextDate)}) ouverte automatiquement avec ${fmt(closingCashFcfa)} FCFA en caisse.`
        : managerClose
          ? " Onglet Clôture : imprimez le rapport si besoin."
          : " En attente de confirmation par la gérante avant ouverture du jour suivant.";
      showToast(`Journée du ${formatDateDdMmYyyy(dStr)} clôturée.${cashHint}${nextMsg}`);
    }
  } finally {
    if (closeBtn) { closeBtn.disabled = false; closeBtn.textContent = prevCloseText; }
  }
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
  const chargeBtn = document.getElementById("save-charge-btn");
  const prevChargeText = chargeBtn ? chargeBtn.textContent : "";
  if (chargeBtn) { chargeBtn.disabled = true; chargeBtn.textContent = "Enregistrement…"; }
  try {
    await persistState();
    closeModal("modal-charge");
    document.getElementById("c-date").value = today();
    document.getElementById("c-lib").value = "";
    document.getElementById("c-montant").value = "";
    renderDashboard();
    renderCharges();
    showToast("Depense enregistree.");
  } finally {
    if (chargeBtn) { chargeBtn.disabled = false; chargeBtn.textContent = prevChargeText; }
  }
}

async function testWhatsappNotification() {
  const feedback = document.getElementById("wa-test-feedback");
  const btn = document.getElementById("wa-test-btn");
  const rawPhones = (document.getElementById("p-wa-phones")?.value || "").trim();
  const phone = rawPhones.split(",")[0].trim();
  if (!phone) {
    if (feedback) { feedback.textContent = "Renseignez au moins un numéro WhatsApp ci-dessus."; feedback.style.color = "#e53935"; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Envoi…"; }
  if (feedback) { feedback.textContent = ""; feedback.style.color = ""; }
  try {
    const res = await apiRequest("/api/wa-test", { method: "POST", body: JSON.stringify({ phone }) });
    if (res?.ok) {
      if (feedback) { feedback.textContent = `✅ Message envoyé à ${res.to || phone}`; feedback.style.color = "#2e7d32"; }
    } else {
      if (feedback) { feedback.textContent = `Erreur : ${res?.error || "réponse inattendue"}` ; feedback.style.color = "#e53935"; }
    }
  } catch (err) {
    if (feedback) { feedback.textContent = `Erreur : ${err?.message || err}`; feedback.style.color = "#e53935"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Envoyer un message test"; }
  }
}

async function saveParams() {
  const site = currentSite();
  if (!site) { showToast("Erreur : maquis introuvable. Rechargez la page."); return; }
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
    hasRestaurant: Boolean(document.getElementById("p-has-restaurant")?.checked),
    dualZonePricing: dualPricingChecked,
    smsQrAlert: (document.getElementById("p-sms-qr")?.value || "").trim(),
    waNotifyPhones: (document.getElementById("p-wa-phones")?.value || "").trim(),
    waEvents: [
      document.getElementById("p-wa-ev-commande")?.checked ? "commande_qr" : null,
      document.getElementById("p-wa-ev-fin-service")?.checked ? "fin_service" : null,
      document.getElementById("p-wa-ev-cloture")?.checked ? "cloture_journee" : null,
      document.getElementById("p-wa-ev-stock")?.checked ? "alerte_stock" : null,
    ].filter(Boolean),
    singleBreweryOnly,
    singleBreweryName: singleBreweryOnly ? singleBreweryName : "",
    stockAlertInclusiveSeuil: Boolean(document.getElementById("p-stock-alert-inclusive-seuil")?.checked),
    reapproTargetMultiplier: Math.min(10, Math.max(1, Number(document.getElementById("p-reappro-mult")?.value) || 2)),
    autoClotureEnabled: Boolean(document.getElementById("p-auto-cloture-enabled")?.checked),
    autoClotureTime: String(document.getElementById("p-auto-cloture-time")?.value || "23:00").slice(0, 5),
  } : item);
  const paramsBtn = document.getElementById("save-params-btn");
  const prevParamsText = paramsBtn ? paramsBtn.textContent : "";
  if (paramsBtn) { paramsBtn.disabled = true; paramsBtn.textContent = "Enregistrement…"; }
  try {
    await persistState({ sites: updatedSites, categories: cleanCategories });
    try { populateCategorySelects(); } catch (e) { console.error(e); }
    // Ne pas forcer un rechargement immédiat du formulaire : laisser la fusion d'état
    // côté client/server mettre à jour `state` puis rafraîchir l'UI de manière contrôlée.
    try { renderTopbar(); renderSiteSwitcher(); renderHero(); } catch (e) { console.error(e); }
    // Recalcule le timer si l'heure de cloture automatique a change
    try { startAutoClotureSchedule(); } catch (e) { console.error(e); }
    showToast("Paramètres sauvegardés.");
  } finally {
    if (paramsBtn) { paramsBtn.disabled = false; paramsBtn.textContent = prevParamsText; }
  }
}

async function restoreFromJson() {
  if (!canGlobalSuperAdmin()) {
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
  if (!canManageMaquisBackups()) {
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
      const hint403 = Number(fetchErr?.status) === 403
        ? `<span class="muted">Si vous venez d&apos;obtenir les droits administrateur, <strong>déconnectez-vous puis reconnectez-vous</strong>. Sinon redémarrez le serveur Python (<code>server.py</code>) pour appliquer la dernière version.${maquisBackupAllowed === false ? " Le serveur refuse explicitement la sauvegarde pour ce compte (vérifiez le rôle et les maquis autorisés dans Paramètres → Utilisateurs)." : ""}</span><br><br>`
        : "";
      infoEl.innerHTML =
        `${hint403}${hint404}<span style="color:#c62828"><strong>Liste des sauvegardes inaccessible${st}</strong><br>${msg}</span><br>`
        + `<span class="muted">Les copies dans <code>backups/</code> sont créées <strong>à chaque enregistrement</strong> par le serveur (fichiers <code>data-*.json</code> ou <code>app-*.sqlite3</code>). Si la liste reste vide après mise à jour du serveur, vérifiez que le dossier <code>backups</code> existe à côté de <code>server.py</code> et les droits disque.</span>`;
    }
    console.error(fetchErr);
  }

  if (data) {
    if (infoEl) {
      const mode = escapeHtml(data.storageMode || "?");
      const k = escapeHtml(String(data.keepCount ?? 30));
      const note = escapeHtml(data.autoNote || "");
      const scopedNote = escapeHtml(data.scopedNote || "");
      const via = fallbackFromState
        ? `<p class="muted" style="margin:0 0 8px">Liste obtenue via <code>/api/state</code> (<code>/api/admin/backups</code> non disponible sur ce deploiement).</p>`
        : "";
      infoEl.innerHTML =
        `${via}${scopedNote ? `<p class="muted" style="margin:0 0 8px">${scopedNote}</p>` : ""}${note}<br><strong>Stockage serveur&nbsp;:</strong> ${mode} · jusqu&apos;a <strong>${k}</strong> fichiers <code>data-*.json</code> et <code>app-*.sqlite3</code> conserves.<br>Pour plus de gardes&nbsp;: <code>MAQUIS_MANAGER_BACKUP_KEEP</code> (3-100), ou <code>TDB_BAR_BACKUP_KEEP</code> (ancien nom, encore accepte).`;
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

  const sites = sitesVisibleToSession();
  siteSel.innerHTML = sites.length
    ? sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.nom)} (${escapeHtml(s.id)})</option>`).join("")
    : `<option value="">—</option>`;
  const cur = currentSiteId();
  if (prevSite && sites.some((s) => String(s.id) === prevSite)) siteSel.value = prevSite;
  else if (cur && sites.some((s) => String(s.id) === String(cur))) siteSel.value = String(cur);
}

async function restoreSelectedSiteFromBackup() {
  if (!canManageMaquisBackups()) {
    showToast("Reserve aux administrateurs de maquis.");
    return;
  }
  const backupFile = document.getElementById("restore-backup-file")?.value?.trim();
  const siteId = document.getElementById("restore-backup-site")?.value?.trim();
  const site = sitesVisibleToSession().find((s) => String(s.id) === siteId);
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

  const dualExport = siteUsesDualZonePricing();
  const rows = items.map((item) => {
    const { prixInt, prixExt } = resolveItemPrices(item);
    const base = {
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
    };
    if (dualExport) {
      return { ...base, "Prix Vente Int. (FCFA)": prixInt, "Prix Vente Ext. (FCFA)": prixExt };
    }
    return { ...base, "Prix Vente (FCFA)": prixInt };
  });

  const ws = XLSX.utils.json_to_sheet(rows);
  // Largeurs de colonnes
  ws["!cols"] = (dualExport ? [22, 18, 13, 10, 17, 13, 13, 16, 12, 13, 15, 22, 22, 22] : [22, 18, 13, 10, 17, 13, 13, 16, 12, 13, 15, 22, 22]).map((w) => ({ wch: w }));
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

      const dualImport = siteUsesDualZonePricing();
      let created = 0, updated = 0, skipped = 0;
      for (const row of rows) {
        const articleName = String(row["Article"] || "").trim();
        if (!articleName) { skipped++; continue; }

        const caseS = excelImportedCaseSize(row);
        const packS = Math.max(1, Number(row["Btl / kit"]) || 1);
        const initBtl = Math.max(0, Number(row["Stock Initial (btl)"]) || 0);
        const prixAchat = Number(row["Prix Achat / cas. (FCFA)"]) || 0;
        let prixVenteInt;
        let prixVenteExt;
        if (dualImport) {
          prixVenteInt = Number(row["Prix Vente Int. (FCFA)"]) || 0;
          prixVenteExt = Number(row["Prix Vente Ext. (FCFA)"]) || prixVenteInt;
        } else {
          const singleCol = Number(row["Prix Vente (FCFA)"]) || 0;
          prixVenteInt = singleCol || Number(row["Prix Vente Int. (FCFA)"]) || 0;
          prixVenteExt = prixVenteInt;
        }
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

async function createSiteBackupOnServer(siteId) {
  if (!canManageMaquisBackups()) { showToast("Reserve aux administrateurs de maquis."); return; }
  const site = sitesVisibleToSession().find((s) => String(s.id) === String(siteId));
  if (!site) { showToast("Maquis introuvable."); return; }
  if (!window.confirm(`Sauvegarder uniquement le maquis "${site.nom}" sur le serveur ?\n\nFichier : site-${site.nom}-${siteId}-YYYYMMDD-HHMMSS.json dans backups/`)) return;
  try {
    const r = await apiRequest(API.createSiteBackup, { method: "POST", body: JSON.stringify({ siteId }) });
    const f = String(r?.file || "").trim();
    showToast(f ? `Sauvegarde maquis : ${f}` : `Sauvegarde de "${site.nom}" enregistree.`);
    refreshRestoreBackupUi().catch(() => {});
  } catch (error) {
    handleApiError(error);
  }
}

async function createManualBackupOnServer() {
  if (!canGlobalSuperAdmin()) {
    showToast("Reserve au super administrateur.");
    return;
  }
  if (!window.confirm(
    "Enregistrer une copie de secours sur le serveur (dossier backups/) ?\n\n"
    + "Le fichier sera nomme avec le suffixe -manuel (conserve en nombre limite).",
  )) {
    return;
  }
  try {
    const r = await apiRequest(API.createManualBackup, { method: "POST", body: JSON.stringify({}) });
    const f = String(r?.file || "").trim();
    recordStaffAudit("create", "backup_manuel_serveur", f ? `Fichier ${f}` : "Snapshot serveur", "");
    await persistState({ staffAuditLog: state.staffAuditLog, nextId: state.nextId }).catch(() => {});
    showToast(f ? `Sauvegarde serveur : ${f}` : "Sauvegarde serveur enregistree.");
    refreshRestoreBackupUi().catch(() => {});
  } catch (error) {
    const msg = typeof error?.message === "string" ? error.message : "";
    if (error?.status === 404 || msg.includes("404") || msg.includes("introuvable")) {
      showToast("Route serveur absente : mettez a jour server.py et redemarrez le serveur.");
    } else {
      handleApiError(error);
    }
  }
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
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Facture ${escapeHtml(factureNumber)}</title><style>body{font-family:Arial,sans-serif;padding:32px;color:#111;background:#fff}header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #222;padding-bottom:16px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:14px}th,td{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}th:last-child,td:last-child{text-align:right}.meta{color:#555}.totals{margin-top:18px;display:flex;justify-content:flex-end}.totals-box{min-width:300px;border:1px solid #111;padding:16px}.totals-box p{display:flex;justify-content:space-between;margin-bottom:6px}.grand{font-size:20px;font-weight:700;border-top:1px solid #111;padding-top:8px;margin-top:8px}.footer{margin-top:26px;color:#666;font-size:12px}.pay-label{font-size:12px;color:#555;font-weight:700;text-transform:uppercase;margin-bottom:4px}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} - ${escapeHtml(site?.pays || "")}</p><p>Gerant: ${escapeHtml(site?.gerant || "-")}</p></div><div><h2>Facture</h2><p class="meta">Numero: ${escapeHtml(factureNumber)}</p><p class="meta">Date: ${escapeHtml(formatDateDdMmYyyy(lignes[0].date))}</p><p class="meta">Client: ${escapeHtml(client)}</p></div></header><table><thead><tr><th>Article</th><th>Qte</th><th>Prix unit.</th><th>Total</th></tr></thead><tbody>${lignes.map((line) => `<tr><td>${escapeHtml(line.article)}</td><td>${escapeHtml(lineQtyLabel(line, stockItemForArticle(line.article)))}</td><td>${fmt(line.prix)} FCFA</td><td>${fmt(calcNet(line))} FCFA</td></tr>`).join("")}</tbody></table><div class="totals"><div class="totals-box">${isMixed ? `<p class="pay-label" style="display:block">Paiement mixte</p>` : ""}${paymentSection}${creditSection}<p class="grand"><span>Total facture</span><span>${fmt(total)} FCFA</span></p></div></div><p class="footer">Merci pour votre visite.</p><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function updatePdjPrintButtons() {
  const headerBtn = document.getElementById("print-pdj-control-btn");
  const serveuseBtn = document.getElementById("print-pdj-serveuse-btn");
  const closureBtn = document.getElementById("print-closure-btn");
  const dStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  const canPrint = Boolean(sessionUser);
  const label = closed
    ? `Imprimer le point du ${formatDateDdMmYyyy(dStr)} (cloture)`
    : `Imprimer le point du ${formatDateDdMmYyyy(dStr)} (controle)`;
  if (headerBtn) {
    headerBtn.classList.toggle("hidden", !canPrint);
    headerBtn.textContent = label;
  }
  if (serveuseBtn) {
    serveuseBtn.textContent = closed
      ? `Imprimer le point du ${formatDateDdMmYyyy(dStr)}`
      : "Imprimer le point du jour";
  }
  if (closureBtn) {
    closureBtn.classList.toggle("hidden", !closed || !canManagePdjAccounting());
  }
}

/** Barre d'aperçu PDJ : pas d'impression auto, bouton Imprimer à côté. */
function pdjPreviewPrintToolbarHtml() {
  return `<div class="print-toolbar no-print">
    <span>Apercu du rapport — utilisez <strong>Imprimer</strong> pour lancer l'impression.</span>
    <button type="button" onclick="window.print()">Imprimer</button>
  </div>`;
}

const PDJ_PREVIEW_PRINT_CSS = `
    .print-toolbar { position: sticky; top: 0; z-index: 1000; display: flex; align-items: center;
      justify-content: space-between; flex-wrap: wrap; gap: 10px; padding: 10px 14px;
      margin: -16px -16px 14px; background: #eef3f8; border-bottom: 1px solid #b8c5d4; font-size: 12px; }
    .print-toolbar button { padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer;
      border: none; border-radius: 6px; background: #1565c0; color: #fff; }
    .print-toolbar button:hover { background: #0d47a1; }
    @media print { .no-print { display: none !important; } }`;

function printPdjDayControl() {
  if (!sessionUser) return;
  const reportDateStr = pdjCalendarDate();
  const closed = stockCheckForSiteDate(reportDateStr, currentSiteId());
  if (closed) {
    printDayClosure();
    return;
  }
  printPdjProvisionalReport(reportDateStr);
}

function printPdjProvisionalReport(reportDateStr) {
  const site = currentSite();
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === reportDateStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === reportDateStr);
  const recouvrementJour = creditRecoveriesForPdjDate(reportDateStr);
  const totauxJour = paymentTotals(ventesJour);
  const caEncaisse = Object.entries(totauxJour).reduce(
    (sum, [method, amount]) => (String(method).includes("dit client") ? sum : sum + amount),
    0,
  );
  const caRecouvrement = recouvrementJour.reduce((sum, r) => sum + (Number(r.montant) || 0), 0);
  const caEncaisseTotal = caEncaisse + caRecouvrement;
  const creditEmisJour = creditIssuedOnDate(reportDateStr);
  const caCreances = totalCreditOutstanding();
  const chargesTotal = chargesJour.reduce((sum, c) => sum + Number(c.montant || 0), 0);
  const { margeBrute, beneficeEstime, excludedLines } = pdjEstimatedBenefitFromSales(ventesJour, chargesTotal);
  const dayBook = dayBookFor(reportDateStr, currentSiteId());
  const openingCash = Number(dayBook?.openingCashFcfa) || 0;
  const especesVentes = Number(totauxJour["Espèces"]) || Number(totauxJour["EspÃ¨ces"]) || 0;
  const especesRecouvrement = especesFromCreditRecoveriesForDate(reportDateStr);
  const expectedEspeces = openingCash + especesVentes + especesRecouvrement;

  const byArticle = {};
  ventesJour.forEach((v) => {
    if (!byArticle[v.article]) {
      byArticle[v.article] = { qty: 0, montant: 0, especes: 0, wave: 0, orange: 0, mtn: 0, carte: 0, credit: 0 };
    }
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

  let totalQty = 0;
  let totalMontant = 0;
  let totalEsp = 0;
  let totalWave = 0;
  let totalOrange = 0;
  let totalMtn = 0;
  let totalCarte = 0;
  let totalCredit = 0;
  const ficheRows = Object.entries(byArticle)
    .sort((a, b) => a[0].localeCompare(b[0], "fr"))
    .map(([article, v]) => {
      totalQty += v.qty;
      totalMontant += v.montant;
      totalEsp += v.especes;
      totalWave += v.wave;
      totalOrange += v.orange;
      totalMtn += v.mtn;
      totalCarte += v.carte;
      totalCredit += v.credit;
      return `<tr>
      <td>${escapeHtml(article)}</td>
      <td style="text-align:right">${fmt(v.qty)}</td>
      <td style="text-align:right">${fmt(v.montant)}</td>
      <td style="text-align:right">${v.wave ? fmt(v.wave) : ""}</td>
      <td style="text-align:right">${v.orange ? fmt(v.orange) : ""}</td>
      <td style="text-align:right">${v.mtn ? fmt(v.mtn) : ""}</td>
      <td style="text-align:right">${v.credit ? fmt(v.credit) : ""}</td>
      <td style="text-align:right">${v.carte ? fmt(v.carte) : ""}</td>
      <td style="text-align:right">${v.especes ? fmt(v.especes) : ""}</td>
    </tr>`;
    })
    .join("");

  const paymentRows = Object.entries(totauxJour)
    .filter(([m]) => !String(m).includes("dit client"))
    .map(([m, a]) => `<div class="box-row"><span>${escapeHtml(m)}</span><strong>${fmt(a)} FCFA</strong></div>`)
    .join("");
  const recoveryRows = recouvrementJour
    .map((r) => `<div class="box-row" style="font-size:10px"><span>${escapeHtml(debtorDisplayKey(r.debiteur))} · ${escapeHtml(r.paiement || "")}</span><strong>${fmt(r.montant)} FCFA</strong></div>`)
    .join("");

  const dateLabel = formatDateDdMmYyyy(reportDateStr);
  const generatedAt = formatDateTimeDdMmYyyy(new Date().toISOString());
  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <title>Point du jour ${dateLabel}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 11px; padding: 16px; color: #111; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; border-bottom: 2px solid #111; padding-bottom: 8px; }
    .header h1 { font-size: 18px; }
    .header .meta { font-size: 10px; color: #555; text-align: right; max-width: 48%; line-height: 1.45; }
    .banner { background: #fff8e6; border: 1px solid #e6c200; padding: 8px 10px; margin-bottom: 10px; font-size: 10px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 0; }
    th, td { padding: 4px 6px; border: 1px solid #ccc; text-align: left; }
    th { background: #ddd; font-weight: 700; font-size: 9px; text-transform: uppercase; text-align: center; }
    tr:nth-child(even) { background: #fafafa; }
    .total-row td { font-weight: 700; background: #eee; border-top: 2px solid #333; }
    .bottom-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
    .box { border: 1px solid #ccc; padding: 8px 12px; }
    .box h3 { font-size: 10px; text-transform: uppercase; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
    .box-row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; gap: 8px; }
    .summary-box { border: 2px solid #111; padding: 8px 14px; margin-top: 0; }
    .summary-box .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #eee; }
    .footer { margin-top: 14px; font-size: 9px; color: #aaa; text-align: center; }
    ${PDJ_PREVIEW_PRINT_CSS}
    @media print { body { padding: 8px; } }
  </style></head><body>
  ${pdjPreviewPrintToolbarHtml()}
  <div class="header">
    <div>
      <h1>${escapeHtml(site?.nom || "Maquis")}</h1>
      <div style="font-size:10px;margin-top:2px">POINT DU JOUR — ${dateLabel}</div>
    </div>
    <div class="meta">Edition : ${generatedAt}<br>Gerant : ${escapeHtml(sessionUser || "-")}<br>${ventesJour.length} vente(s) · ${recouvrementJour.length} versement(s) recouvrement</div>
  </div>
  <div class="banner"><strong>Journee non cloturee</strong> — document de controle provisoire. Les totaux peuvent evoluer tant que la journee n'est pas cloturee.</div>
  <table>
    <thead><tr>
      <th style="text-align:left">Article</th><th>Qte</th><th>Montant</th>
      <th>Wave</th><th>Orange</th><th>MTN</th><th>Credit</th><th>Carte</th><th>Caisse</th>
    </tr></thead>
    <tbody>
      ${ficheRows || `<tr><td colspan="9" style="text-align:center;color:#888;padding:16px">Aucune vente sur cette date</td></tr>`}
      ${ficheRows ? `<tr class="total-row"><td>TOTAL</td><td style="text-align:right">${fmt(totalQty)}</td><td style="text-align:right">${fmt(totalMontant)}</td>
        <td style="text-align:right">${fmt(totalWave)}</td><td style="text-align:right">${fmt(totalOrange)}</td>
        <td style="text-align:right">${fmt(totalMtn)}</td><td style="text-align:right">${fmt(totalCredit)}</td>
        <td style="text-align:right">${fmt(totalCarte)}</td><td style="text-align:right">${fmt(totalEsp)}</td></tr>` : ""}
    </tbody>
  </table>
  <div class="bottom-grid">
    <div class="box">
      <h3>Encaissements</h3>
      ${paymentRows || `<div class="box-row muted">Aucun encaissement</div>`}
      ${caRecouvrement ? `<div class="box-row" style="margin-top:6px;border-top:1px solid #eee;padding-top:6px"><span>Recouvrement credit</span><strong>${fmt(caRecouvrement)} FCFA</strong></div>` : ""}
      ${recoveryRows}
      <div class="box-row" style="font-weight:700;margin-top:6px"><span>Total encaisse jour</span><strong>${fmt(caEncaisseTotal)} FCFA</strong></div>
      ${caCreances ? `<div class="box-row" style="color:#c0392b;font-weight:700"><span>Reste a recouvrer (tous clients)</span><strong>${fmt(caCreances)} FCFA</strong></div>` : ""}
      ${creditEmisJour ? `<div class="box-row"><span>Credits emis ce jour</span><strong>${fmt(creditEmisJour)} FCFA</strong></div>` : ""}
      ${openingCash || expectedEspeces ? `<h3 style="margin-top:10px">Caisse especes</h3>
        <div class="box-row"><span>Ouverture</span><strong>${fmt(openingCash)} FCFA</strong></div>
        <div class="box-row"><span>Theorique (ouv. + ventes + recouvr.)</span><strong>${fmt(expectedEspeces)} FCFA</strong></div>` : ""}
    </div>
    <div>
      <div class="summary-box">
        <div class="row"><span>CA encaisse (jour)</span><strong>${fmt(caEncaisseTotal)} FCFA</strong></div>
        <div class="row" title="Somme (prix vente net − prix achat / bouteille × qté bouteilles) sur les ventes du jour."><span>Marge brute (ventes)</span><strong>${fmt(margeBrute)} FCFA</strong></div>
        ${chargesTotal ? `<div class="row"><span>Charges du jour</span><strong>- ${fmt(chargesTotal)} FCFA</strong></div>` : ""}
        <div class="row" title="Marge brute moins charges. Le recouvrement crédit n’entre pas dans la marge."><span>Bénéfice estimé</span><strong style="color:${beneficeEstime >= 0 ? "#2a9d5c" : "#c0392b"}">${fmt(beneficeEstime)} FCFA</strong></div>
        ${excludedLines ? `<p style="font-size:10px;color:#c0392b;margin:6px 0 0;line-height:1.35">${excludedLines} ligne(s) sans prix d’achat catalogue : marge incomplète. Indiquez le prix d’achat du casier dans le catalogue stock.</p>` : ""}
      </div>
      <div style="margin-top:10px;border:1px solid #ccc;padding:8px 12px">
        <div style="font-size:10px;font-weight:700;margin-bottom:6px">Controle gerant</div>
        <div style="display:flex;justify-content:space-between"><span>Signature :</span><span style="min-width:120px;border-bottom:1px solid #999">&nbsp;</span></div>
      </div>
    </div>
  </div>
  <div class="footer">${escapeHtml(site?.nom || "")} — Point provisoire — ${dateLabel}</div>
  </body></html>`;

  const w = window.open("", "_blank");
  if (!w) {
    showToast("Impossible d'ouvrir l'apercu du rapport.");
    return;
  }
  w.document.write(html);
  w.document.close();
}

function printDayClosure(reportDateStr) {
  const dStr = String(reportDateStr || pdjCalendarDate()).slice(0, 10);
  const closed = stockCheckForSiteDate(dStr, currentSiteId());
  if (!closed) {
    showToast(`Journee du ${formatDateDdMmYyyy(dStr)} non cloturee : utilisez « Imprimer le point du jour » pour un controle provisoire.`);
    return;
  }
  const site = currentSite();
  const ventesJour = recordsForSite(state.ventes).filter((v) => v.date.slice(0, 10) === dStr);
  const chargesJour = recordsForSite(state.charges).filter((c) => (c.date || "").slice(0, 10) === dStr);

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

  const creancesEntries = Object.entries(creditOutstandingMap()).sort((a, b) => b[1] - a[1]);
  const caCreancesRestantes = totalCreditOutstanding();

  const totauxJour = closed.totauxJour || paymentTotals(ventesJour);
  const tEspeces = totauxJour["Espèces"] || 0;
  const tWave = totauxJour["Wave"] || 0;
  const tOrange = totauxJour["Orange Money"] || 0;
  const tMtn = totauxJour["MTN MoMo"] || 0;
  const tCarte = totauxJour["Carte"] || 0;
  const tCredit = totauxJour["Crédit client"] || 0;
  const caEncaisse = closed.caEncaisse || 0;
  const caCreances = caCreancesRestantes;
  const creditEmisJourPrint = closed.caCreancesEmisesJour ?? creditIssuedOnDate(dStr);
  const chargesTotal = chargesJour.reduce((sum, c) => sum + Number(c.montant || 0), 0);
  const { margeBrute, beneficeEstime, excludedLines } = pdjEstimatedBenefitFromSales(ventesJour, chargesTotal);
  const gaps = (closed.items || []).filter((ci) => ci.ecart !== 0).length;
  const cashCloseRows =
    typeof closed.openingCashFcfa === "number"
      ? `<h3 style="margin-top:10px;padding-top:8px;border-top:1px solid #ddd">Caisse espèces</h3>
      <div class="box-row"><span>Ouverture</span><strong>${fmt(closed.openingCashFcfa)} FCFA</strong></div>
      ${typeof closed.closingCashFcfa === "number" ? `<div class="box-row"><span>Fermeture (dénombrement)</span><strong>${fmt(closed.closingCashFcfa)} FCFA</strong></div>` : ""}
      ${typeof closed.expectedEspecesCash === "number" ? `<div class="box-row"><span>Théorique caisse</span><strong>${fmt(closed.expectedEspecesCash)} FCFA</strong></div>` : ""}
      ${typeof closed.especesChargesJour === "number" && closed.especesChargesJour > 0 ? `<div class="box-row"><span>Dépenses jour (espèces, info)</span><strong>${fmt(closed.especesChargesJour)} FCFA</strong></div>` : ""}
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

  const dateLabel = formatDateDdMmYyyy(closed.date || dStr);
  const generatedAt = formatDateTimeDdMmYyyy(closed.createdAt);

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
  <title>Fiche de clôture ${formatDateDdMmYyyy(dStr)}</title>
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
    ${PDJ_PREVIEW_PRINT_CSS}
    @media print { body { padding: 8px; } }
  </style></head><body>
  ${pdjPreviewPrintToolbarHtml()}

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
      ${caCreances ? `<div class="box-row" style="color:#c0392b;font-weight:700;margin-top:6px;border-top:1px solid #f0c0b0;padding-top:5px"><span>Reste a recouvrer</span><strong>${fmt(caCreances)} FCFA</strong></div>${creancesEntries.map(([nom, montant]) => `<div class="box-row" style="padding-left:14px;font-size:10px;color:#c0392b"><span>↳ ${escapeHtml(nom)}</span><span>${fmt(montant)} FCFA</span></div>`).join("")}` : ""}
      ${cashCloseRows}
    </div>
    <div>
      <div class="summary-box">
        <div class="row"><span>CA encaisse</span><strong>${fmt(caEncaisse)} FCFA</strong></div>
        <div class="row" title="Somme (prix vente net − prix achat / bouteille × qté bouteilles) sur les ventes du jour."><span>Marge brute (ventes)</span><strong>${fmt(margeBrute)} FCFA</strong></div>
        ${chargesTotal ? `<div class="row"><span>Charges du jour</span><strong>- ${fmt(chargesTotal)} FCFA</strong></div>` : ""}
        ${chargesJour.map((c) => `<div class="row" style="font-size:10px;color:#555;padding-left:12px"><span>${escapeHtml(c.lib || c.libelle || c.cat || c.categorie || "Charge")}</span><span>${fmt(c.montant)} FCFA</span></div>`).join("")}
        <div class="row" title="Marge brute moins charges (hors effet de trésorerie créances)."><span>Bénéfice estimé</span><strong style="color:${beneficeEstime >= 0 ? "#2a9d5c" : "#c0392b"}">${fmt(beneficeEstime)} FCFA</strong></div>
        ${excludedLines ? `<p style="font-size:10px;color:#c0392b;margin:6px 0 0;line-height:1.35">${excludedLines} ligne(s) sans prix d’achat catalogue : marge incomplète.</p>` : ""}
      </div>
      <div style="margin-top:10px;border:1px solid #ccc;padding:8px 12px">
        <div style="font-size:10px;text-transform:uppercase;font-weight:700;margin-bottom:6px">Versement</div>
        <div style="display:flex;justify-content:space-between"><span>Versement depot :</span><span style="min-width:100px;border-bottom:1px solid #999">&nbsp;</span></div>
        <div style="display:flex;justify-content:space-between;margin-top:6px"><span>Signature :</span><span style="min-width:100px;border-bottom:1px solid #999">&nbsp;</span></div>
      </div>
    </div>
  </div>

  <div class="footer">${escapeHtml(site?.nom || "Maquis Manager")} &mdash; Fiche de clôture générée automatiquement &mdash; ${escapeHtml(formatDateDdMmYyyy(dStr))}</div>
  </body></html>`;

  const w = window.open("", "_blank");
  if (!w) { showToast("Impossible d'ouvrir l'apercu du rapport."); return; }
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
      <td>${escapeHtml(paymentLabel(vente))}</td>
      <td>${fmt(calcNet(vente))} FCFA</td>
    </tr>
  `).join("");
  const ticketWindow = window.open("", "_blank", "width=1100,height=900");
  if (!ticketWindow) {
    showToast("Impossible d'ouvrir l'impression.");
    return;
  }
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Historique des ventes</title><style>body{font-family:Arial,sans-serif;color:#111;padding:28px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}.meta{color:#555}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.box{border:1px solid #111;padding:12px}.box strong{display:block;font-size:18px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left}th{background:#f2f2f2}td:nth-child(6),td:nth-child(7),td:nth-child(9),.pay td:last-child{text-align:right}.pay{max-width:420px;margin-top:10px}@media print{body{padding:0}table{font-size:11px}}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p><p class="meta">${escapeHtml(periodLabel)}${currentFilter !== "all" ? ` - Categorie : ${escapeHtml(currentFilter)}` : ""}</p></div><div><h2>Historique des ventes</h2><p class="meta">Imprime le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div></header><div class="summary"><div class="box">Total ventes<strong>${fmt(total)} FCFA</strong></div><div class="box">Transactions<strong>${fmt(ventes.length)}</strong></div></div><h2>Encaissements</h2><table class="pay"><tbody>${payRows}</tbody></table><h2>Detail</h2><table><thead><tr><th>Date</th><th>Facture</th><th>Client</th><th>Article</th><th>Categorie</th><th>Qte</th><th>Prix</th><th>Paiement</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=function(){window.print();}</script></body></html>`);
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
    const valeur = stockPurchaseValueFcfa(item);
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
  ticketWindow.document.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Point du stock</title><style>body{font-family:Arial,sans-serif;color:#111;padding:28px}header{display:flex;justify-content:space-between;gap:18px;border-bottom:2px solid #111;padding-bottom:14px;margin-bottom:18px}h1,h2,p{margin:0 0 8px}.meta{color:#555}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:16px 0}.box{border:1px solid #111;padding:12px}.box strong{display:block;font-size:18px;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:7px 6px;text-align:left}th{background:#f2f2f2}td:nth-child(n+3){text-align:right}td:last-child{text-align:left}@media print{body{padding:0}table{font-size:10px}}</style></head><body><header><div><h1>${escapeHtml(site?.nom || "Maquis")}</h1><p>${escapeHtml(site?.ville || "")} ${escapeHtml(site?.pays || "")}</p></div><div><h2>Point du stock</h2><p class="meta">Imprime le ${escapeHtml(formatDateTimeDdMmYyyy(new Date()))}</p></div></header><div class="summary"><div class="box">Articles<strong>${fmt(items.length)}</strong></div><div class="box">Valeur du stock<strong>${fmt(totalValue)} FCFA</strong></div><div class="box">Articles en alerte<strong>${fmt(alertCount)}</strong></div></div><table><thead><tr><th>Article</th><th>Categorie</th><th>Btl/kit</th><th>Btl/casier</th><th>Frigo</th><th>Reserve</th><th>Initial cas.</th><th>Entrees cas.</th><th>Sorties btl</th><th>Stock btl</th><th>Seuil</th><th>Achat/cas.</th><th>Vente int.</th><th>Vente ext.</th><th>Valeur stock</th><th>Statut</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=function(){window.print();}</script></body></html>`);
  ticketWindow.document.close();
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  if (id === "modal-order-detail") {
    suppressOrderDetailBackdropUntil = Date.now() + 450;
  }
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
  }
  if (id === "modal-order-detail") suppressOrderDetailBackdropUntil = 0;
  if (id === "modal-purchase-receive") pendingReceivePurchaseId = null;
  if (id === "modal-finalize") resetFinalizeModalUi();
  if (id === "modal-saisie-rapide") { srCart = []; }
  if (id === "modal-casier-edit") pendingPurchaseCasierResume = false;
  if (id === "modal-replace-article") {
    replacingLine = null; replacingVenteId = null;
    const qw = document.getElementById("replace-qty-wrap");
    if (qw) qw.style.display = "none";
  }
  if (id === "modal-supplement") { _pendingSupplement = null; }
}

async function removeOrderLine(orderId, lineId) {
  const order = state.commandes.find((item) => item.id === orderId);
  if (!order) return;
  const line = order.lignes.find((item) => item.id === lineId);
  const kitGroupId = line?.kitGroupId;
  recordStaffAudit("delete", "commande_ligne", `Ligne retiree · commande #${orderId} · ${order.client || ""}`, line ? `${line.article} · ${fmt(calcNet(line))} FCFA` : "");
  order.lignes = kitGroupId
    ? order.lignes.filter((item) => item.kitGroupId !== kitGroupId)
    : order.lignes.filter((item) => item.id !== lineId);
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
  if (!canDeleteCharge()) {
    showToast("Suppression des charges reservee aux administrateurs.");
    return;
  }
  const ch = (state.charges || []).find((item) => item.id === id);
  const label = ch
    ? `${ch.lib} · ${fmt(ch.montant)} FCFA · ${formatDateDdMmYyyy(ch.date)}`
    : `Dépense #${id}`;
  if (!window.confirm(`Supprimer cette dépense ?\n\n${label}\n\nAction irréversible.`)) {
    return;
  }
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

function openFrigoModal() {
  const searchEl = document.getElementById("frigo-search");
  if (searchEl) searchEl.value = "";
  renderFrigoPicker("");
  openModal("modal-remplir-frigo");
  window.requestAnimationFrame(() => searchEl?.focus());
}

function renderFrigoPicker(query) {
  const picker = document.getElementById("frigo-picker");
  if (!picker) return;
  const q = (query || "").toLowerCase().trim();
  const items = recordsForSite(state.stock)
    .filter((item) => {
      const hasReserve = stockReserve(item) > 0;
      const matchQ = !q || item.article.toLowerCase().includes(q) || (item.cat || "").toLowerCase().includes(q);
      return hasReserve && matchQ;
    })
    .sort((a, b) => a.article.localeCompare(b.article, "fr"));
  if (!items.length) {
    picker.innerHTML = `<p class="muted" style="padding:12px;font-size:0.88rem">${q ? "Aucun article ne correspond." : "Aucun article avec du stock en réserve."}</p>`;
    return;
  }
  picker.innerHTML = items.map((item) => {
    const frigo = stockFrigo(item);
    const reserve = stockReserve(item);
    const frigoLow = isFrigoLowForAlert(frigo, Number(item.seuilMin) || 0);
    const badge = frigoLow ? `<span class="badge badge-amber" style="font-size:0.7rem;margin-left:4px">Frigo bas</span>` : "";
    return `<div class="order-line" style="align-items:center;padding:10px 4px;border-bottom:1px solid #f0f0f0">
      <div style="flex:1">
        <p class="list-item-title" style="margin:0">${escapeHtml(item.article)}${badge}</p>
        <p class="list-item-sub" style="margin:2px 0 0">Frigo : <strong>${fmt(frigo)}</strong> btl · Réserve : <strong>${fmt(reserve)}</strong> btl</p>
      </div>
      <button type="button" class="btn btn-outline" style="width:auto;padding:6px 14px;font-size:0.85rem" data-fill-frigo-id="${item.id}">Remplir</button>
    </div>`;
  }).join("");
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
  const reapproBtn = document.getElementById("save-reappro-btn");
  const prevReapproText = reapproBtn ? reapproBtn.textContent : "";
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
    if (reapproBtn) { reapproBtn.disabled = true; reapproBtn.textContent = "Enregistrement…"; }
    try {
      await persistState();
      closeModal("modal-reappro");
      renderVentesPage();
      renderStock();
      showToast(`${fmt(bottles)} bouteille(s) mises au frigo.`);
    } finally {
      if (reapproBtn) { reapproBtn.disabled = false; reapproBtn.textContent = prevReapproText; }
    }
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
  if (reapproBtn) { reapproBtn.disabled = true; reapproBtn.textContent = "Enregistrement…"; }
  try {
    await persistState({ stock: state.stock, charges: state.charges, nextId: state.nextId, stockEntrees: state.stockEntrees });
    closeModal("modal-reappro");
    renderStock();
    renderDashboard();
    renderCharges();
    const chargeMsg = prixCasier > 0 ? ` · Depense de ${fmt(cases * prixCasier)} FCFA enregistree.` : "";
    showToast(`+${fmt(cases)} casier(s) (${fmt(bottles)} btl) pour "${item.article}".${chargeMsg}`);
  } finally {
    if (reapproBtn) { reapproBtn.disabled = false; reapproBtn.textContent = prevReapproText; }
  }
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
  if (!window.confirm(
    `Enregistrer une perte de ${fmt(qty)} btl sur « ${item.article} » ?\n\nMotif : ${motif}${notes ? `\nNote : ${notes}` : ""}`,
  )) {
    return;
  }
  item.sorties = (Number(item.sorties) || 0) + qty;
  consumePhysicalStock(item, qty);
  item.lastSortieAt = new Date().toISOString();
  item.lastSortieBy = sessionUser || "-";
  touchStockItemUpdated(item);
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
  const perteBtn = document.getElementById("save-perte-btn");
  const prevPerteText = perteBtn ? perteBtn.textContent : "";
  if (perteBtn) { perteBtn.disabled = true; perteBtn.textContent = "Enregistrement…"; }
  try {
    await persistState({ stock: state.stock, stockLosses: state.stockLosses });
    closeModal("modal-perte");
    renderStock();
    renderDashboard();
    showToast(`Perte de ${fmt(qty)} btl "${item.article}" enregistree (${motif}).`);
  } finally {
    if (perteBtn) { perteBtn.disabled = false; perteBtn.textContent = prevPerteText; }
  }
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
let casierPhysMvtUi = { dateFrom: "", dateTo: "", user: "", page: 1, pageSize: 50 };
let casierViewMode = "lots"; // "lots" | "physique"

function casierPhysMvtDateKey(m) {
  const d = String(m?.date || (m?.createdAt || "").slice(0, 10));
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "";
}

function filteredCasierPhysMouvements() {
  const from = String(casierPhysMvtUi.dateFrom || "").trim();
  const to = String(casierPhysMvtUi.dateTo || "").trim();
  const u = String(casierPhysMvtUi.user || "").trim().toLowerCase();
  return casierMouvementsForSite()
    .filter((m) => {
      const dk = casierPhysMvtDateKey(m);
      if (from && dk && dk < from) return false;
      if (to && dk && dk > to) return false;
      if (u && !String(m.user || "").toLowerCase().includes(u)) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
}

function syncCasierPhysFilterDatalists() {
  const all = casiersConsignesForSite();
  const brasseries = new Set();
  const emplacements = new Set();
  const users = new Set();
  all.forEach((c) => {
    const stockIt = stockItemForArticle(c.article);
    const br = normalizeBrasserieName(stockIt?.brasserie || c.article || "");
    if (br) brasseries.add(br);
    const emp = String(c.emplacement || "").trim();
    if (emp) emplacements.add(emp);
  });
  casierMouvementsForSite().forEach((m) => {
    const u = String(m.user || "").trim();
    if (u) users.add(u);
  });
  const fillDl = (id, values) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = [...values].sort((a, b) => a.localeCompare(b, "fr")).map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  };
  fillDl("casier-phys-dl-brasserie", brasseries);
  fillDl("casier-phys-dl-emplacement", emplacements);
  fillDl("casier-phys-dl-users", users);
}

function exportCasierPhysMouvementsCsv() {
  const rows = filteredCasierPhysMouvements();
  const header = ["Date", "Casier", "Article", "Type", "Quantite", "Source_motif", "Commentaire", "Utilisateur", "Facture"];
  const data = rows.map((m) => [
    formatDateDdMmYyyy(m.date || (m.createdAt || "").slice(0, 10)),
    m.casierCode || "",
    m.article || "",
    m.type === "retour_vide" ? "Retour vides" : m.type === "sortie" ? "Sortie" : "Entree",
    m.type === "retour_vide" && m.nbCasiers ? `${m.nbCasiers} cas. (${m.quantite} btl)` : String(m.quantite ?? ""),
    m.type === "retour_vide" ? (m.commentaire || "retour fournisseur") : m.type === "sortie" ? (m.motif || "") : (m.source || ""),
    m.commentaire || "",
    m.user || "",
    m.factureNumber || m.facture || "",
  ]);
  const slug = exportFileSlug();
  downloadCsvFile(`mouvements_casiers_${slug}.csv`, header, data);
  showToast(`${fmt(rows.length)} mouvement(s) exporte(s).`);
}

function renderCasierPhysMvtPagination(total, page, pageSize) {
  const host = document.getElementById("casier-phys-mvt-pagination");
  if (!host) return;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), pages);
  casierPhysMvtUi.page = p;
  if (total <= pageSize) {
    host.classList.add("hidden");
    host.innerHTML = "";
    return;
  }
  host.classList.remove("hidden");
  host.innerHTML = `
    <button type="button" class="btn btn-outline" data-casier-mvt-page="${p - 1}" ${p <= 1 ? "disabled" : ""} style="width:auto;min-height:40px">Precedent</button>
    <span class="muted" style="font-size:0.88rem">Page ${p} / ${pages} · ${fmt(total)} mouvement(s)</span>
    <button type="button" class="btn btn-outline" data-casier-mvt-page="${p + 1}" ${p >= pages ? "disabled" : ""} style="width:auto;min-height:40px">Suivant</button>`;
}

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
  try { await persistStatePatch({ casiers: state.casiers }); } catch {}
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
  // Garantir que bouteillesVides ne dépasse jamais la capacité
  casier.bouteillesVides = Math.min(Math.max(0, Number(casier.bouteillesVides) || 0), cap);
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
      factureNumber: opts.factureNumber || "",
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

  // Auto-créer un casier de collecte uniquement si la brasserie+format est déjà suivie en casiers physiques.
  // Sans casier existant, le module n'est pas activé pour cette brasserie → pas de prolifération.
  if (remaining > 0) {
    const hasExistingForBr = state.casiers.some((c) => {
      if (c.siteId !== siteId) return false;
      const cBr = normalizeBrasserieName(stockItemForArticle(c.article)?.brasserie || "");
      return (srcBr ? cBr === srcBr : String(c.article || "").toLowerCase() === String(article || "").toLowerCase())
        && Math.max(1, Number(c.capacite) || 24) === cap;
    });
    if (!hasExistingForBr) return;
  }
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

async function purgerCasiersVides() {
  if (!canAnyAdmin()) { showToast("Réservé aux administrateurs."); return; }
  const siteId = currentSiteId();
  const phantoms = (state.casiers || []).filter((c) =>
    c.siteId === siteId &&
    (Number(c.quantiteActuelle) || 0) === 0 &&
    (Number(c.bouteillesVides) || 0) === 0
  );
  if (!phantoms.length) { showToast("Aucun casier vide à purger."); return; }
  if (!confirm(`Supprimer ${phantoms.length} casier(s) entièrement vides (sans bouteilles pleines ni vides) ?`)) return;
  const ids = new Set(phantoms.map((c) => c.id));
  state.casiers = state.casiers.filter((c) => !ids.has(c.id));
  recordStaffAudit("delete", "casier_purge", `Purge ${phantoms.length} casier(s) vides`, `Casiers sans bouteilles pleines ni vides supprimés.`);
  try {
    await persistStatePatch({ casiers: state.casiers, nextId: state.nextId });
  } catch (e) { showToast("Erreur lors de la sauvegarde."); return; }
  renderCasiers();
  showToast(`${phantoms.length} casier(s) vide(s) supprimé(s).`);
}

async function syncCasiersManquants(opts = {}) {
  if (!opts.silent && !canAnyAdmin()) { showToast("Réservé aux administrateurs."); return 0; }
  const siteId = currentSiteId();
  state.casiers = state.casiers || [];
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.casier) state.nextId.casier = 1;
  const eligible = recordsForSite(state.stock).filter((item) => lotType(item) === "casier");
  if (!eligible.length) return 0; // stock pas encore chargé — ne rien effacer
  const now = new Date().toISOString();

  // Calcul de ce que les casiers devraient contenir
  const target = new Map();
  eligible.forEach((item) => {
    const btl = Math.max(0, stockActuel(item));
    if (btl > 0) target.set(String(item.article || "").toLowerCase().trim(), { item, btl, cap: Math.max(1, caseSize(item)) });
  });

  // Calcul de ce que les casiers contiennent actuellement pour ce site
  const current = new Map();
  state.casiers.filter((c) => rowMatchesSite(c, siteId, multiSiteActive())).forEach((c) => {
    const k = String(c.article || "").toLowerCase().trim();
    current.set(k, (current.get(k) || 0) + Math.max(0, Number(c.quantiteActuelle) || 0));
  });

  // Vérifie si tout est déjà synchronisé
  let inSync = target.size === current.size;
  if (inSync) {
    for (const [k, { btl }] of target) {
      if ((current.get(k) || 0) !== btl) { inSync = false; break; }
    }
  }
  if (inSync) {
    if (!opts.silent) showToast("Les casiers sont déjà à jour avec le stock.");
    return 0;
  }

  // Supprime TOUS les casiers du site et recrée depuis le stock
  state.casiers = state.casiers.filter((c) => !rowMatchesSite(c, siteId, multiSiteActive()));
  target.forEach(({ item, btl, cap }) => {
    const fullCount = Math.floor(btl / cap);
    const remainder = btl % cap;
    for (let i = 0; i < fullCount; i++) {
      const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
        capacite: cap, quantiteActuelle: cap, bouteillesVides: 0,
        emplacement: "Réserve", statut: "plein", createdAt: now, createdBy: sessionUser || "-", autoSynced: true };
      recomputeCasierStatus(c);
      state.casiers.push(c);
    }
    if (remainder > 0) {
      const c = { id: state.nextId.casier++, siteId, code: nextCasierCode(), article: item.article,
        capacite: cap, quantiteActuelle: remainder, bouteillesVides: 0,
        emplacement: "Réserve", statut: "partiel", createdAt: now, createdBy: sessionUser || "-", autoSynced: true };
      recomputeCasierStatus(c);
      state.casiers.push(c);
    }
  });
  lsSaveCasiers();
  try {
    await persistStatePatch({ casiers: state.casiers, nextId: state.nextId });
  } catch (e) { lsSaveCasiers(); }
  if (!opts.silent) {
    renderCasiers();
    showToast("Casiers synchronisés avec le stock.");
  }
  return 1;
}

async function syncCasiersFromStockEtVentes() {
  if (!canAnyAdmin()) { showToast("Réservé aux administrateurs."); return; }
  const siteId = currentSiteId();
  const eligible = recordsForSite(state.stock).filter((item) => lotType(item) === "casier");
  if (!eligible.length) { showToast("Aucun article en stock pour initialiser les casiers."); return; }

  let previewPleins = 0;
  eligible.forEach((item) => {
    const cap = Math.max(1, caseSize(item));
    previewPleins += Math.ceil(Math.max(0, stockActuel(item)) / cap);
  });

  if (!confirm(
    `Recréer les casiers depuis le stock actuel ?\n\n` +
    `  • ${previewPleins} casier(s) PLEINS/PARTIELS (stock actuel)\n\n` +
    `Les casiers existants de ce site seront remplacés.`
  )) return;

  state.casiers = state.casiers || [];
  state.casierMouvements = state.casierMouvements || [];
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.casier) state.nextId.casier = 1;

  // Supprimer les casiers du site courant
  state.casiers = state.casiers.filter((c) => !rowMatchesSite(c, siteId, multiSiteActive()));

  const now = new Date().toISOString();
  let createdPleins = 0;

  eligible.forEach((item) => {
    const cap = Math.max(1, caseSize(item));
    const stockBtl = Math.max(0, stockActuel(item));
    if (stockBtl <= 0) return;
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
  });

  lsSaveCasiers();
  recordStaffAudit("create", "casier_sync",
    `Sync casiers: ${createdPleins} casier(s)`,
    `Initialisation depuis stock actuel du site (casiers vides exclus).`
  );
  try {
    await persistStatePatch({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
  } catch (e) { lsSaveCasiers(); }
  renderCasiers();
  showToast(`${fmt(createdPleins)} casier(s) créé(s) depuis le stock actuel.`);
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
        bouteillesVides: 0,
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
        bouteillesVides: 0,
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
      await persistStatePatch({ casiers: state.casiers, nextId: state.nextId });
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
  await persistStatePatch({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
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
  await persistStatePatch({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
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
  let stockDeducted = false;
  if (motifKey === "frigo") {
    frigoPlan = buildCasierToFrigoStockPlan(casier, q);
    if (!frigoPlan.ok) {
      showToast(frigoPlan.msg || "Transfert frigo impossible.");
      return false;
    }
  } else {
    // Vente, casse, transfert, autre → déduire du stock catalogue pour rester cohérent
    const candidates = stockCandidatesForCasierFrigoTransfer(casier);
    if (candidates.length) {
      const now = new Date().toISOString();
      let rem = q;
      candidates.forEach((it) => normalizePhysicalStock(it));
      for (const it of candidates) {
        if (rem <= 0) break;
        const avail = stockActuel(it);
        if (avail <= 0) continue;
        const take = Math.min(rem, avail);
        consumePhysicalStock(it, take);
        it.sorties = (Number(it.sorties) || 0) + take;
        it.lastSortieAt = now;
        it.lastSortieBy = sessionUser || "-";
        rem -= take;
      }
      stockDeducted = true;
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
  await persistStatePatch({
    casiers: state.casiers,
    casierMouvements: state.casierMouvements,
    nextId: state.nextId,
    ...((frigoPlan && frigoPlan.ok) || stockDeducted ? { stock: state.stock } : {}),
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
  await persistStatePatch({ casiers: state.casiers });
  return true;
}

async function retourVidesGroupeBrasserie(br, cap, nbCasiers, filterArticle = "") {
  if (!canMoveCasier()) { showToast("Connexion requise."); return 0; }
  const matchingVides = casiersForSite().filter((c) => {
    const stockIt = stockItemForArticle(c.article);
    const cBr = normalizeBrasserieName(stockIt?.brasserie || "");
    return cBr === br &&
      Math.max(1, Number(c.capacite) || 1) === cap &&
      (!filterArticle || (c.article || "") === filterArticle) &&
      (Number(c.quantiteActuelle) || 0) === 0 &&
      (Number(c.bouteillesVides) || 0) > 0;
  }).slice(0, nbCasiers);
  const label = filterArticle ? `${br} B${cap} · ${filterArticle}` : `${br} B${cap}`;
  return _retourVidesLot(matchingVides, cap, label);
}

async function _retourVidesLot(matchingVides, cap, label) {
  if (!matchingVides.length) { showToast("Aucun casier de vides trouvé."); return 0; }
  const siteId = currentSiteId();
  state.casierMouvements = state.casierMouvements || [];
  state.nextId = state.nextId || {};
  if (!state.nextId.casierMouvement) state.nextId.casierMouvement = 1;
  const now = new Date().toISOString();
  let processed = 0;
  const idsToDelete = [];
  for (const casier of matchingVides) {
    const vides = Math.max(0, Number(casier.bouteillesVides) || 0);
    if (vides < cap) continue; // pas assez de bouteilles vides pour un casier
    casier.bouteillesVides = Math.max(0, vides - cap);
    casier.statut = "retourne"; // rendu au fournisseur
    recomputeCasierStatus(casier);
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
    // Casier complètement vide après retour : supprimer (il repart chez le fournisseur)
    if ((Number(casier.bouteillesVides) || 0) === 0 && (Number(casier.quantiteActuelle) || 0) === 0) {
      idsToDelete.push(casier.id);
    }
    processed++;
  }
  if (!processed) { showToast("Aucun casier traité."); return 0; }
  if (idsToDelete.length > 0) {
    state.casiers = state.casiers.filter((c) => !idsToDelete.includes(c.id));
  }
  lsSaveCasiers();
  recordStaffAudit("create", "casier_retour_vide",
    `Retour ${label} : ${processed} casier(s)`,
    `${processed} casier(s) × ${cap} btl = ${processed * cap} btl vides retournées fournisseur`
  );
  await persistStatePatch({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
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
  if (String(casier.statut || "").toLowerCase() === "retourne" && (Number(casier.bouteillesVides) || 0) === 0) {
    showToast("Ce casier a déjà été retourné au fournisseur.");
    return false;
  }
  const cap = Math.max(1, Number(casier.capacite) || 24);
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (q <= 0) { showToast("Quantité invalide."); return false; }
  const statutCasier = String(casier.statut || "").toLowerCase();
  const rawVides = Math.max(0, Number(casier.bouteillesVides) || 0);
  const vides = (statutCasier === "vide" && rawVides === 0) ? cap : rawVides;
  if (q > vides) { showToast(`Seulement ${fmt(vides)} bouteille(s) vide(s) dans ce casier.`); return false; }
  const nbCasiers = Math.floor(q / cap);
  casier.bouteillesVides = Math.max(0, vides - q);
  if (casier.bouteillesVides === 0) casier.statut = "retourne";
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
  // Casier complètement rendu (vide) : supprimer de l'inventaire (reparti chez le fournisseur)
  if ((Number(casier.bouteillesVides) || 0) === 0 && (Number(casier.quantiteActuelle) || 0) === 0) {
    state.casiers = state.casiers.filter((c) => c.id !== casier.id);
  }
  await persistStatePatch({ casiers: state.casiers, casierMouvements: state.casierMouvements, nextId: state.nextId });
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
  syncCasierPhysFilterDatalists();
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
  const actifs = all.filter((c) => String(c.statut || "").toLowerCase() !== "retourne");
  const kpis = { total: actifs.length, plein: 0, partiel: 0, vide: 0, btlVides: 0 };
  actifs.forEach((c) => {
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

  // Grouper par brasserie > article (chaque article = une ligne, sépare naturellement B12 50/65cl et B12 100cl)
  const _clFromArticle = (art) => { const m = String(art || "").match(/\b(\d+)\s*cl\b/i) || String(art || "").match(/\b(\d+)\s*$/); return m ? Number(m[1]) : null; };
  const _clBucket = (art) => { const cl = _clFromArticle(art); if (cl === null) return "std"; if (cl >= 90) return "100cl"; if (cl >= 45 && cl <= 80) return "50-65cl"; return `${cl}cl`; };
  const _clLabel = (art) => { const b = _clBucket(art); if (b === "100cl") return "100 cl"; if (b === "50-65cl") return "50-65 cl"; const cl = _clFromArticle(art); return cl !== null ? `${cl} cl` : ""; };
  const byBr = {};
  filtered.forEach((c) => {
    const stockIt = stockItemForArticle(c.article);
    const rawBr = normalizeBrasserieName(stockIt?.brasserie || "");
    if (!rawBr) return;
    const cap = Math.max(1, Number(c.capacite) || 24);
    const artKey = String(c.article || "").toLowerCase().trim();
    const grpKey = `${cap}|${artKey}`;
    if (!byBr[rawBr]) byBr[rawBr] = {};
    if (!byBr[rawBr][grpKey]) byBr[rawBr][grpKey] = { cap, article: c.article || "—", clLabel: _clLabel(c.article), pleins: 0, partiels: 0, vides: 0, btlPleines: 0, btlVides: 0 };
    const g = byBr[rawBr][grpKey];
    const st = String(c.statut || "vide").toLowerCase();
    if (st === "plein") g.pleins++;
    else if (st === "partiel") g.partiels++;
    else g.vides++;
    const btlP = Math.max(0, Number(c.quantiteActuelle) || 0);
    const btlV = Math.max(0, Number(c.bouteillesVides) || 0);
    g.btlPleines += btlP;
    g.btlVides += btlV;
  });

  if (!Object.keys(byBr).length) {
    list.innerHTML = emptyState(
      all.length ? "Aucun casier ne correspond" : "Aucun casier physique",
      all.length ? "Ajustez les filtres ci-dessus." : "Cliquez sur '+ Nouveau casier' pour démarrer.",
    );
  } else {
    let html = "";
    Object.entries(byBr).sort(([a], [b]) => a.localeCompare(b, "fr")).forEach(([br, groups]) => {
      // trier par capacité décroissante puis par nom d'article (B24 avant B12, articles alphabétiques)
      const entries = Object.entries(groups).sort(([, ga], [, gb]) => {
        if (gb.cap !== ga.cap) return gb.cap - ga.cap;
        return (ga.article || "").localeCompare(gb.article || "", "fr");
      });
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
                  ? `<button type="button" class="mini-btn" data-casier-grp-retour-br="${escapeHtml(br)}" data-casier-grp-retour-cap="${g.cap}" data-casier-grp-retour-article="${escapeHtml(g.article)}" style="background:rgba(230,81,0,0.12);color:#e65100;font-weight:700">↩ Retourner ${fmt(fullVides)}</button>`
                  : enCoursFmt > 0 ? `<span style="color:#9e9e9e;font-size:0.75rem">${fmt(enCoursFmt)} btl en cours</span>` : "";
                return `<tr style="background:#fff">
                  <td style="text-align:center">
                    <span style="background:#e3f2fd;color:#1565c0;padding:2px 9px;border-radius:5px;font-size:0.8rem;font-weight:700">B${g.cap}</span>${g.clLabel ? `<span style="font-size:0.72rem;color:#546e7a;margin-left:5px">${escapeHtml(g.clLabel)}</span>` : ""}
                    <div style="font-size:0.74rem;color:#546e7a;margin-top:2px">${escapeHtml(g.article)}</div>
                  </td>
                  <td style="text-align:right;font-weight:700;color:#2e7d32">${fmt(g.pleins)}</td>
                  <td style="text-align:right;font-weight:700;color:#f57c00">${fmt(g.partiels)}</td>
                  <td style="text-align:right;font-weight:700;color:#e53935">${fmt(g.vides)}</td>
                  <td style="text-align:right;font-weight:700;${fullVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(fullVides)}</td>
                  <td style="text-align:right;font-weight:700;color:#1976d2">${fmt(g.btlPleines)}</td>
                  <td style="text-align:right;font-weight:700;${g.btlVides > 0 ? "color:#e65100" : "color:#9e9e9e"}">${fmt(g.btlVides)}</td>
                  <td style="white-space:nowrap;text-align:right">${retourBtn}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    });
    list.innerHTML = html;
  }

  const mvtList = document.getElementById("casier-phys-mvt-list");
  const mvtCount = document.getElementById("casier-phys-mvt-count");
  if (mvtList) {
    const mvts = filteredCasierPhysMouvements();
    const pageSize = Math.max(10, Math.min(500, Number(casierPhysMvtUi.pageSize) || 50));
    const pages = Math.max(1, Math.ceil(mvts.length / pageSize));
    if (casierPhysMvtUi.page > pages) casierPhysMvtUi.page = pages;
    if (casierPhysMvtUi.page < 1) casierPhysMvtUi.page = 1;
    const start = (casierPhysMvtUi.page - 1) * pageSize;
    const pageRows = mvts.slice(start, start + pageSize);
    if (mvtCount) {
      mvtCount.textContent = mvts.length
        ? `${fmt(mvts.length)} mouvement(s)${mvts.length > pageSize ? ` · page ${casierPhysMvtUi.page}/${pages}` : ""}`
        : "0 mouvement";
    }
    renderCasierPhysMvtPagination(mvts.length, casierPhysMvtUi.page, pageSize);
    const head = pageRows;
    if (!head.length) {
      mvtList.innerHTML = emptyState("Aucun mouvement", "Ajustez les filtres ou enregistrez une entrée / sortie de casier.");
    } else {
      mvtList.innerHTML = `<div class="stock-table-wrap"><table class="stock-table casier-mvt-table">
        <thead><tr>
          <th>Date</th>
          <th>Casier</th>
          <th>Article</th>
          <th>Type</th>
          <th style="text-align:right">Qté</th>
          <th>Source / motif</th>
          <th class="casier-mvt-col-note">Note</th>
          <th>Utilisateur</th>
          <th>Facture</th>
        </tr></thead>
        <tbody>
          ${head.map((m) => `<tr>
            <td>${escapeHtml(formatDateDdMmYyyy(m.date || (m.createdAt || "").slice(0, 10)))}</td>
            <td>${findCasierById(Number(m.casierId)) ? `<button type="button" class="link-btn" data-casier-mvt-detail="${Number(m.casierId) || ""}" style="font-weight:700;padding:0;border:none;background:none;color:var(--mm-primary);cursor:pointer;text-decoration:underline">${escapeHtml(m.casierCode || "-")}</button>` : `<span style="font-weight:600;color:#9e9e9e;text-decoration:line-through" title="Casier supprimé">${escapeHtml(m.casierCode || "-")}</span>`}</td>
            <td>${escapeHtml(m.article || "-")}</td>
            <td>${m.type === "retour_vide" ? "<span class='badge badge-amber'>Retour vides</span>" : m.type === "sortie" ? "<span class='badge badge-red'>Sortie</span>" : "<span class='badge badge-green'>Entrée</span>"}</td>
            <td style="text-align:right">${m.type === "retour_vide" && m.nbCasiers ? `<strong>${fmt(m.nbCasiers)} casier(s)</strong> <span class="muted">(${fmt(m.quantite)} btl)</span>` : fmt(m.quantite)}</td>
            <td>${escapeHtml(m.type === "retour_vide" ? (m.commentaire || "retour fournisseur") : m.type === "sortie" ? (m.motif || "") : (m.source || ""))}</td>
            <td class="casier-mvt-col-note">${escapeHtml(m.commentaire || "")}</td>
            <td>${escapeHtml(m.user || "-")}</td>
            <td>${escapeHtml(m.factureNumber || m.facture || "-")}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>`;
    }
  }
}

function openCasierPhysDetailModal(casierId) {
  const c = findCasierById(Number(casierId));
  if (!c) { showToast("Casier introuvable."); return; }
  const cap = Math.max(1, Number(c.capacite) || 1);
  const cur = Math.max(0, Number(c.quantiteActuelle) || 0);
  const vides = Math.max(0, Number(c.bouteillesVides) || 0);
  const mvts = casierMouvementsForSite()
    .filter((m) => Number(m.casierId) === Number(c.id))
    .sort((a, b) => String(b.createdAt || b.date || "").localeCompare(String(a.createdAt || a.date || "")));
  const titleEl = document.getElementById("casier-detail-title");
  const summaryEl = document.getElementById("casier-detail-summary");
  const listEl = document.getElementById("casier-detail-mvt-list");
  if (titleEl) titleEl.textContent = `${c.code} · ${c.article || "—"}`;
  if (summaryEl) {
    summaryEl.innerHTML = `
      <p><strong>Emplacement :</strong> ${escapeHtml(c.emplacement || "—")}</p>
      <p><strong>Stock :</strong> ${fmt(cur)}/${fmt(cap)} btl · <strong>Vides :</strong> ${fmt(vides)} btl</p>
      <p><strong>Statut :</strong> ${escapeHtml(c.statut || "—")} · <strong>Dernier mouvement :</strong> ${escapeHtml(formatDateDdMmYyyy((c.lastMoveAt || "").slice(0, 10)))} ${escapeHtml(c.lastMoveBy || "")}</p>`;
  }
  if (listEl) {
    if (!mvts.length) {
      listEl.innerHTML = emptyState("Aucun mouvement", "Les entrées et sorties de ce casier apparaîtront ici.");
    } else {
      listEl.innerHTML = `<table class="stock-table casier-mvt-table">
        <thead><tr>
          <th>Date</th><th>Type</th><th style="text-align:right">Qté</th><th>Source / motif</th><th class="casier-mvt-col-note">Note</th><th>Utilisateur</th>
        </tr></thead>
        <tbody>${mvts.map((m) => `<tr>
          <td>${escapeHtml(formatDateDdMmYyyy(m.date || (m.createdAt || "").slice(0, 10)))}</td>
          <td>${m.type === "retour_vide" ? "<span class='badge badge-amber'>Retour vides</span>" : m.type === "sortie" ? "<span class='badge badge-red'>Sortie</span>" : "<span class='badge badge-green'>Entrée</span>"}</td>
          <td style="text-align:right">${fmt(m.quantite)}</td>
          <td>${escapeHtml(m.type === "sortie" ? (m.motif || "") : (m.source || m.commentaire || ""))}</td>
          <td class="casier-mvt-col-note">${escapeHtml(m.commentaire || "")}</td>
          <td>${escapeHtml(m.user || "-")}</td>
        </tr>`).join("")}</tbody>
      </table>`;
    }
  }
  openModal("modal-casier-detail");
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
  if (empEl) empEl.value = "Réserve";
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
  const emplacement = String(document.getElementById("casier-edit-emplacement")?.value || "Réserve").trim();
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
  if (qtyEl) {
    qtyEl.value = "";
    qtyEl.removeAttribute("max");
  }
  const motifEl = document.getElementById("casier-phys-move-motif");
  if (motifEl && t === "sortie") motifEl.value = "vente";
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
  const qtyEl = document.getElementById("casier-phys-move-qty");
  const maxQty = t === "entree" ? Math.max(0, cap - cur) : cur;
  if (qtyEl) {
    if (maxQty > 0) {
      qtyEl.max = String(maxQty);
      qtyEl.min = "1";
    } else {
      qtyEl.removeAttribute("max");
    }
  }
  if (info) info.textContent = `${c.code} · ${c.article} · ${fmt(cur)}/${fmt(cap)} btl · ${c.statut || "-"} · empl: ${c.emplacement || "-"}`;
  if (preview) {
    if (qty <= 0) { preview.textContent = maxQty > 0 ? `Quantité max : ${fmt(maxQty)} btl.` : (t === "entree" ? "Casier plein." : "Casier vide."); return; }
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
  const casier = findCasierById(id);
  if (!casier) { showToast("Casier introuvable."); return; }
  const cap = Math.max(1, Number(casier.capacite) || 1);
  const cur = Math.max(0, Number(casier.quantiteActuelle) || 0);
  if (t === "entree" && cur + qty > cap) {
    showToast(`Capacité dépassée (max ${fmt(cap - cur)} btl).`);
    return;
  }
  if (t === "sortie" && qty > cur) {
    showToast(`Stock insuffisant (max ${fmt(cur)} btl).`);
    return;
  }
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
    syncUserAccountPanel();
    renderHome2FAAlert();
    showToast(`2FA activé pour "${username}".`);
  } catch (error) {
    showToast(error.message || "Code invalide ou expire.");
  }
}

async function disableTwoFactor(username) {
  try {
    await apiRequest(API.twoFaDisable, { method: "POST", body: JSON.stringify({ username }) });
    state = await apiRequest(API.state);
    renderUsersList();
    syncUserAccountPanel();
    renderHome2FAAlert();
    showToast(`2FA désactivé pour "${username}".`);
  } catch (error) {
    showToast(error.message || "Erreur lors de la desactivation 2FA.");
  }
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const totpSection = document.getElementById("totp-section");
  const waOtpSection = document.getElementById("wa-otp-section");
  const errorEl = document.getElementById("login-error");
  try {
    if (pendingWaUsername) {
      // Vérification code OTP WhatsApp
      const code = document.getElementById("login-wa-otp").value.trim();
      const session = await apiRequest("/api/2fa/wa-verify", {
        method: "POST",
        body: JSON.stringify({ username: pendingWaUsername, code }),
      });
      pendingWaUsername = null;
      waOtpSection.classList.add("hidden");
      document.getElementById("login-wa-otp").value = "";
      document.querySelector("#login-form button[type=submit]").textContent = "Ouvrir le tableau de bord";
      applySessionFieldsFromApi(session);
      errorEl.textContent = "";
      setAuthVisible(true);
      await bootstrapAuthenticatedApp();
      showToast("Connexion réussie.");
    } else if (pendingPreAuthToken) {
      const code = document.getElementById("login-totp").value.trim();
      const session = await apiRequest(API.twoFaVerify, {
        method: "POST",
        body: JSON.stringify({ preAuthToken: pendingPreAuthToken, code }),
      });
      pendingPreAuthToken = null;
      totpSection.classList.add("hidden");
      document.getElementById("login-totp").value = "";
      document.querySelector("#login-form button[type=submit]").textContent = "Ouvrir le tableau de bord";
      applySessionFieldsFromApi(session);
      errorEl.textContent = "";
      setAuthVisible(true);
      await bootstrapAuthenticatedApp();
      showToast("Connexion réussie.");
    } else {
      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;
      const result = await apiRequest(API.login, { method: "POST", body: JSON.stringify({ username, password }) });
      if (result.require2fa === "whatsapp") {
        pendingWaUsername = result.username;
        waOtpSection.classList.remove("hidden");
        document.getElementById("login-wa-otp").focus();
        document.querySelector("#login-form button[type=submit]").textContent = "Verifier le code WhatsApp";
        errorEl.textContent = "";
      } else if (result.needsTwoFactor) {
        pendingPreAuthToken = result.preAuthToken;
        totpSection.classList.remove("hidden");
        document.getElementById("login-totp").focus();
        document.querySelector("#login-form button[type=submit]").textContent = "Verifier le code";
        errorEl.textContent = "";
      } else {
        applySessionFieldsFromApi(result);
        errorEl.textContent = "";
        setAuthVisible(true);
        await bootstrapAuthenticatedApp();
        const me = state?.auth?.users?.find((u) => u.username === result.username);
        if (me && !me.twoFactorEnabled) {
          showToast("Activez la 2FA dans Parametres > Acces pour securiser votre compte.");
        }
        showToast("Connexion réussie.");
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
  stopAppLiveClock();
  stopAutoClotureSchedule();
  state = null;
  sessionUser = null;
  currentRole = null;
  allowedSiteIds = [];
  globalSuperadmin = null;
  maquisBackupAllowed = null;
  sessionDeadlineUnix = null;
  csrfToken = null;
  activeOrderId = null;
  pdjViewDateBySite = {};
  pdjBrowseConsultationOnly = false;
  pendingFinalizeOrderId = null;
  pendingPreAuthToken = null;
  pendingWaUsername = null;
  qrAlertCount = 0;
  knownQrOrderIds = new Set();
  document.getElementById("totp-section").classList.add("hidden");
  document.getElementById("login-totp").value = "";
  document.getElementById("wa-otp-section")?.classList.add("hidden");
  document.getElementById("login-wa-otp") && (document.getElementById("login-wa-otp").value = "");
  document.querySelector("#login-form button[type=submit]").textContent = "Ouvrir le tableau de bord";
  setAuthVisible(false);
  showToast("Session fermee.");
}

function migrateCasiersVidesBouteillesVides() {
  if (!Array.isArray(state.casiers)) return;
  const now = new Date().toISOString();
  let changed = false;

  // 1. Casiers vides (qty=0) sans bouteillesVides jamais initialisées (legacy) → initialiser à capacite
  // On ne touche PAS aux casiers où bouteillesVides est explicitement 0 (nouveau code)
  state.casiers.forEach((c) => {
    const cap = Math.max(1, Number(c.capacite) || 24);
    const qty = Math.max(0, Number(c.quantiteActuelle) || 0);
    const statut = String(c.statut || "").toLowerCase();
    // c.bouteillesVides == null : champ absent = données legacy → migrer
    // c.bouteillesVides === 0   : champ présent et vide volontairement → ne pas toucher
    if (qty <= 0 && c.bouteillesVides == null && statut !== "retourne") {
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
  if (!state.pdjWorkDateBySite || typeof state.pdjWorkDateBySite !== "object") state.pdjWorkDateBySite = {};
  if (!Array.isArray(state.dayBooks)) state.dayBooks = [];
  if (!Array.isArray(state.stockEntrees)) state.stockEntrees = [];
  if (!Array.isArray(state.stockLosses)) state.stockLosses = [];
  if (!Array.isArray(state.casiers)) state.casiers = [];
  if (!Array.isArray(state.casierMouvements)) state.casierMouvements = [];
  if (!Array.isArray(state.staffAuditLog)) state.staffAuditLog = [];
  if (!Array.isArray(state.workShifts)) state.workShifts = [];
  // Nettoyer les doublons de stockChecks (même siteId + date) accumulés par sessions concurrentes
  state.stockChecks = deduplicateStockChecks(state.stockChecks || []);
  pruneFinalizedCommandesFromState();
  const siteId = String(currentSiteId() || "").trim();
  if (siteId && workShiftsForSite(siteId).length) {
    lsSaveWorkShifts();
  } else {
    lsRestoreWorkShifts();
  }
  if (!state.nextId) state.nextId = {};
  if (!state.nextId.stockEntree || Number.isNaN(Number(state.nextId.stockEntree))) state.nextId.stockEntree = 100;
  if (!state.nextId.stockLoss || Number.isNaN(Number(state.nextId.stockLoss))) state.nextId.stockLoss = 100;
  if (!state.nextId.creditRecovery) state.nextId.creditRecovery = 100;
  if (!state.nextId.casier || Number.isNaN(Number(state.nextId.casier))) state.nextId.casier = 1;
  if (!state.nextId.casierMouvement || Number.isNaN(Number(state.nextId.casierMouvement))) state.nextId.casierMouvement = 1;
  if (!state.nextId.workShift || Number.isNaN(Number(state.nextId.workShift))) state.nextId.workShift = 100;
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
  ventesDomPdjStamp = "";
  syncPdjWorkDateInput();
  syncVentesJournalDateInputsFromPdj(pdjCalendarDate(), { force: true });
  document.getElementById("c-date").value = today();
  const consigneDateEl = document.getElementById("consigne-date");
  if (consigneDateEl) consigneDateEl.value = pdjCalendarDate();
  const creditDt = document.getElementById("credit-datetime");
  if (creditDt) creditDt.value = datetimeLocalNow();
  initExportPeriodDom();
  document.getElementById("stock-move-start").value = today().slice(0, 8) + "01";
  document.getElementById("stock-move-end").value = today();
  populateOrderSelect();
  renderTopbar();
  applyProductionUiGuards();
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
  startAppLiveClock();
  startAutoClotureSchedule();
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
  document.getElementById("v-preview").textContent = `${fmt(prix * qty)} FCFA`;
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
  const order = recordsForSite(state.commandes).find((o) => o.id === Number(orderId));
  if (!order) {
    showToast("Commande introuvable.");
    return;
  }
  activeOrderId = order.id;
  clearQrAlert();
  if (currentPage === "ventes" && ventesSubTab !== "commandes") {
    setVentesSubTab("commandes");
    renderVentesPage();
  } else {
    renderOrders();
  }
  syncVenteFormFromActiveOrder();
  const label = order.client || `Commande #${order.id}`;
  showToast(`${label} ouverte — ajoutez, remplacez ou retirez des articles ci-dessous.`);
  window.requestAnimationFrame(() => {
    document.getElementById("ventes-card-board")?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.requestAnimationFrame(() => {
      document.querySelector(".order-card.active")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  });
}

/** Aligne le formulaire vente (hors modal) sur la commande active — utile apres « Ouvrir la commande ». */
function syncVenteFormFromActiveOrder() {
  const order = activeOrderId ? recordsForSite(state.commandes).find((o) => o.id === activeOrderId) : null;
  if (!order) return;
  const vDate = document.getElementById("v-date");
  if (vDate) vDate.value = order.date || pdjCalendarDate();
  const vClient = document.getElementById("v-client");
  if (vClient) vClient.value = order.client || "";
  const vNote = document.getElementById("v-note");
  if (vNote) vNote.value = order.note || "";
  const vSel = document.getElementById("v-order-select");
  if (vSel) vSel.value = String(order.id);
  syncFinalizeButtonJournalState();
}

function _markUserInteraction() {
  _lastUserInteractionAt = Date.now();
}

function attachEvents() {
  installFcfaThousandsDelegation();
  // Toute interaction utilisateur suspend le re-rendu live (scroll, toucher, clavier)
  document.addEventListener("scroll", _markUserInteraction, { passive: true, capture: true });
  document.addEventListener("touchstart", _markUserInteraction, { passive: true });
  document.addEventListener("touchmove", _markUserInteraction, { passive: true });
  document.addEventListener("keydown", _markUserInteraction, { passive: true });
  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
  document.getElementById("logout-btn").addEventListener("click", () => logout());
  document.getElementById("site-switcher").addEventListener("change", () => {
    const siteId = document.getElementById("site-switcher").value;
    if (!canAccessSite(siteId)) return;
    state.activeSiteId = siteId;
    activeOrderId = null;
    pdjBrowseConsultationOnly = false;
    delete pdjViewDateBySite[siteId];
    knownQrOrderIds = new Set(qrOrdersForCurrentSite(state).map((item) => item.id));
    clearQrAlert();
    syncPdjWorkDateInput();
    ventesDomPdjStamp = "";
    syncVentesJournalDateInputsFromPdj(pdjCalendarDate(), { force: true });
    renderTopbar();
    renderDashboard();
    renderVentesPage();
    renderStock();
    renderCharges();
    renderCasierPhysique();
    loadParamsForm();
    if (currentPage === "planning") renderPlanningPage().catch(handleApiError);
    resetOrderForm();
    persistStatePatch({ activeSiteId: siteId }).catch(handleApiError);
  });
  document.getElementById("new-order-btn").addEventListener("click", () => {
    activeOrderId = null;
    resetOrderForm();
    openOrderEditor();
  });
  document.getElementById("fill-fridge-btn")?.addEventListener("click", openFrigoModal);
  document.getElementById("frigo-search")?.addEventListener("input", (e) => renderFrigoPicker(e.target.value));
  document.getElementById("frigo-picker")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fill-frigo-id]");
    if (!btn) return;
    const itemId = Number(btn.dataset.fillFrigoId);
    closeModal("modal-remplir-frigo");
    openReapproModal(itemId, "frigo");
  });
  document.getElementById("print-orders-management-btn")?.addEventListener("click", printOrdersManagementList);
  document.getElementById("orders-management-table")?.addEventListener("click", (event) => {
    const detailBtn = event.target.closest("[data-order-details]");
    if (!detailBtn) return;
    event.preventDefault();
    event.stopPropagation();
    openOrderDetailModal(detailBtn.getAttribute("data-order-details") || "");
  });
  ["orders-filter-date-start", "orders-filter-date-end", "orders-filter-status", "orders-filter-type"].forEach((id) => {
    document.getElementById(id).addEventListener("change", renderOrdersManagement);
  });
  initDashboardPeriodDom();
  document.getElementById("dashboard-print-margins-btn")?.addEventListener("click", printDashboardPeriodMarginsReport);
  document.getElementById("obj-formula-tip")?.addEventListener("click", showObjectifFormulaTip);
  document.getElementById("dashboard-period-mode")?.addEventListener("change", () => {
    syncDashboardPeriodCustomUi();
    renderDashboard();
  });
  ["dashboard-period-start", "dashboard-period-end"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", renderDashboard);
  });
  document.getElementById("export-period-mode")?.addEventListener("change", () => syncPeriodCustomUi("export"));
  ["export-period-start", "export-period-end"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => syncPeriodCustomUi("export"));
  });
  // Saisie rapide
  document.getElementById("saisie-rapide-btn")?.addEventListener("click", openSaisieRapide);
  document.getElementById("kit-mixte-btn")?.addEventListener("click", () => toggleKitMixBoard());
  document.getElementById("sr-submit-btn")?.addEventListener("click", () => submitSaisieRapide().catch(handleApiError));
  document.getElementById("sr-search")?.addEventListener("input", (e) => renderSrMenu(e.target.value));
  document.getElementById("sr-order-select")?.addEventListener("change", () => {
    const srSel = document.getElementById("sr-order-select");
    const vSel = document.getElementById("v-order-select");
    if (!srSel) return;
    const id = Number(srSel.value) || null;
    activeOrderId = id;
    if (vSel) vSel.value = srSel.value;
    const order = id ? recordsForSite(state.commandes).find((o) => o.id === id) : null;
    const srClient = document.getElementById("sr-client");
    const srDate = document.getElementById("sr-date");
    const srNote = document.getElementById("sr-note");
    if (order && srClient && srDate && srNote) {
      srClient.value = order.client || srClient.value;
      srDate.value = order.date || srDate.value;
      srNote.value = order.note != null ? order.note : srNote.value;
    }
    const vDate = document.getElementById("v-date");
    if (vDate && srDate) vDate.value = srDate.value || vDate.value;
    const vClient = document.getElementById("v-client");
    if (vClient && srClient) vClient.value = srClient.value;
    const vNote = document.getElementById("v-note");
    if (vNote && srNote) vNote.value = srNote.value;
    syncFinalizeButtonJournalState();
  });
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
  // Sélecteur de facture pour remplacement d'article
  document.getElementById("replace-facture-select")?.addEventListener("change", (e) => {
    renderReplaceFactureLines(e.target.value);
  });
  document.getElementById("replace-facture-lines-wrap")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-replace-vente]");
    if (!btn) return;
    openReplaceVenteModal(Number(btn.dataset.replaceVente));
  });
  document.getElementById("cancel-consigne-btn")?.addEventListener("click", () => {
    document.getElementById("consigne-form-wrap")?.classList.add("hidden");
  });
  // Casier order modal
  document.getElementById("co-brasserie")?.addEventListener("change", renderCasierOrderPreview);
  document.getElementById("co-cs")?.addEventListener("change", renderCasierOrderPreview);
  document.getElementById("co-vides")?.addEventListener("input", renderCasierOrderPreview);
  document.getElementById("co-submit-btn")?.addEventListener("click", submitCasierOrder);
  document.getElementById("stock-card-casiers")?.addEventListener("click", (e) => {
    if (e.target.closest(".purge-casiers-btn")) {
      purgerCasiersVides().catch(handleApiError);
      return;
    }
    if (e.target.closest(".sync-casiers-manquants-btn")) {
      syncCasiersManquants().catch(handleApiError);
      return;
    }
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
  const bindCasierMvtFilter = (id, key) => {
    document.getElementById(id)?.addEventListener("change", (e) => {
      casierPhysMvtUi[key] = e.target.value;
      casierPhysMvtUi.page = 1;
      renderCasierPhysique();
    });
    document.getElementById(id)?.addEventListener("input", (e) => {
      casierPhysMvtUi[key] = e.target.value;
      casierPhysMvtUi.page = 1;
      renderCasierPhysique();
    });
  };
  bindCasierMvtFilter("casier-phys-mvt-from", "dateFrom");
  bindCasierMvtFilter("casier-phys-mvt-to", "dateTo");
  bindCasierMvtFilter("casier-phys-mvt-user", "user");
  document.getElementById("casier-phys-mvt-page-size")?.addEventListener("change", (e) => {
    casierPhysMvtUi.pageSize = Math.max(10, Math.min(500, Number(e.target.value) || 50));
    casierPhysMvtUi.page = 1;
    renderCasierPhysique();
  });
  document.getElementById("casier-phys-mvt-export")?.addEventListener("click", exportCasierPhysMouvementsCsv);
  document.getElementById("casier-phys-mvt-pagination")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-casier-mvt-page]");
    if (!btn || btn.disabled) return;
    casierPhysMvtUi.page = Math.max(1, Number(btn.dataset.casierMvtPage) || 1);
    renderCasierPhysique();
  });
  document.getElementById("casier-phys-mvt-list")?.addEventListener("click", (e) => {
    const detailBtn = e.target.closest("[data-casier-mvt-detail]");
    if (detailBtn) {
      const id = Number(detailBtn.dataset.casierMvtDetail);
      if (id) openCasierPhysDetailModal(id);
    }
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
      const filterArticle = grpRetourBtn.dataset.casierGrpRetourArticle || "";
      const maxCasiers = casiersForSite().filter((c) => {
        const stockIt = stockItemForArticle(c.article);
        const cBr = normalizeBrasserieName(stockIt?.brasserie || "");
        return cBr === br &&
          Math.max(1, Number(c.capacite) || 1) === cap &&
          (!filterArticle || (c.article || "") === filterArticle) &&
          Math.max(0, Number(c.bouteillesVides) || 0) >= cap;
      }).length;
      if (maxCasiers < 1) { showToast("Pas de casier complet de vides à retourner."); return; }
      const label = filterArticle ? `${br} · B${cap} · ${filterArticle}` : `${br} · B${cap}`;
      const raw = window.prompt(
        `Combien de casiers vides à retourner au fournisseur ?\n${label}\n(max ${fmt(maxCasiers)} casier(s))`,
        String(maxCasiers)
      );
      const nb = Math.max(0, Math.min(maxCasiers, Math.floor(Number(raw) || 0)));
      if (!nb) return;
      retourVidesGroupeBrasserie(br, cap, nb, filterArticle)
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
  document.getElementById("kit-price")?.addEventListener("input", () => { renderKitProducts(); updateKitCountInfo(); });
  document.getElementById("kit-size")?.addEventListener("change", () => { kitMixCounts = {}; renderKitProducts(); });
  document.getElementById("kit-location")?.addEventListener("change", renderKitProducts);
  document.getElementById("kit-mix-count")?.addEventListener("input", updateKitCountInfo);
  document.getElementById("kit-mix-count")?.addEventListener("change", updateKitCountInfo);
  document.getElementById("kit-products-list")?.addEventListener("click", (e) => {
    const dec = e.target.closest(".kit-mix-dec");
    const inc = e.target.closest(".kit-mix-inc");
    const row = e.target.closest(".kit-mix-row");
    if (!row) return;
    const art = row.dataset.kitArticle;
    if (!art) return;
    const input = row.querySelector(".kit-mix-qty");
    if (!input) return;
    let v = Number(input.value) || 0;
    if (dec) v = Math.max(0, v - 1);
    if (inc) {
      const size = Number(document.getElementById("kit-size")?.value) || 3;
      if (kitMixTotalSelected() >= size) return;
      v += 1;
    }
    input.value = String(v);
    kitMixCounts[art] = v;
    updateKitCountInfo();
  });
  document.getElementById("kit-products-list")?.addEventListener("input", (e) => {
    if (!e.target.classList.contains("kit-mix-qty")) return;
    const art = e.target.dataset.kitArticle;
    if (art) kitMixCounts[art] = Math.max(0, Math.floor(Number(e.target.value) || 0));
    updateKitCountInfo();
  });
  document.getElementById("confirm-kit-btn")?.addEventListener("click", () => confirmKit().catch(handleApiError));
  // Remplacement d'article (commande en cours OU vente encaissee)
  document.getElementById("replace-search")?.addEventListener("input", (e) => {
    if (replacingVenteId != null) {
      const vente = (state.ventes || []).find((v) => v.id === replacingVenteId);
      renderReplaceVentePicker(e.target.value, vente);
    } else {
      renderReplacePicker(e.target.value);
    }
  });
  document.getElementById("replace-picker")?.addEventListener("click", async (e) => {
    const item = e.target.closest("[data-pick-replace]");
    if (!item) return;
    const article = decodeURIComponent(item.getAttribute("data-pick-replace") || "");
    const prevHtml = item.innerHTML;
    item.disabled = true;
    item.textContent = "Enregistrement…";
    try {
      if (replacingVenteId != null) {
        await confirmReplaceVente(article);
      } else {
        await confirmReplace(article);
      }
    } catch (err) {
      handleApiError(err);
    } finally {
      if (item.isConnected) { item.disabled = false; item.innerHTML = prevHtml; }
    }
  });
  // Bouton Remplacer sur vente encaissee (delegue depuis ventes-list)
  document.getElementById("ventes-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-replace-vente]");
    if (!btn) return;
    openReplaceVenteModal(Number(btn.dataset.replaceVente));
  });
  document.getElementById("generate-qr-btn").addEventListener("click", renderQrPreview);
  document.getElementById("print-all-qr-btn").addEventListener("click", () => printAllQrTables());
  document.getElementById("print-qr-int-btn").addEventListener("click", () => printQrCard("Intérieur"));
  document.getElementById("print-qr-ext-btn").addEventListener("click", () => printQrCard("Extérieur"));
  document.getElementById("new-site-single-br-enabled")?.addEventListener("change", syncSingleBreweryUi);
  document.getElementById("p-single-br-enabled")?.addEventListener("change", syncSingleBreweryUi);
  document.getElementById("p-auto-cloture-enabled")?.addEventListener("change", syncAutoClotureTimeVisibility);
document.getElementById("fab-btn").addEventListener("click", () => {
    if (currentPage === "ventes") {
      if (ventesSubTab === "consignes") {
        const wrap = document.getElementById("consigne-form-wrap");
        if (wrap) { resetConsigneForm(); wrap.classList.remove("hidden"); document.getElementById("consigne-client")?.focus(); }
        return;
      }
      if (ventesSubTab === "caisse" && caisseInnerTab === "recouvrement") {
        openCreditFacturesJourModal();
        return;
      }
      openOrderEditor(activeOrderId || null);
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
  // Supplement encaissement (remplacement article prix superieur)
  document.getElementById("confirm-supplement-btn")?.addEventListener("click", () => confirmSupplement().catch(handleApiError));
  document.querySelectorAll(".supp-pay-input").forEach((input) => {
    input.addEventListener("input", () => {
      const diff = _pendingSupplement?.diff || 0;
      const paid = [...document.querySelectorAll(".supp-pay-input")].reduce((s, i) => s + (Number(i.value) || 0), 0);
      const reste = diff - paid;
      const el = document.getElementById("supp-reste");
      if (el) { el.textContent = reste === 0 ? "Montant complet" : `Reste : ${fmt(Math.abs(reste))} FCFA${reste < 0 ? " (trop)" : ""}`; el.style.color = reste === 0 ? "#72d7a9" : "#ff8e82"; }
    });
  });
  document.getElementById("print-finalize-btn")?.addEventListener("click", () => {
    const n = document.getElementById("print-finalize-btn")?.dataset.facture;
    if (n) printInvoice(n);
  });
  document.getElementById("finalize-done-close")?.addEventListener("click", () => closeModal("modal-finalize"));
  document.getElementById("save-stock-btn").addEventListener("click", () => saveStock().catch(handleApiError));
  document.getElementById("add-sale-format-btn").addEventListener("click", addStockSaleFormat);
  document.getElementById("add-stock-promo-btn")?.addEventListener("click", addStockPromotion);
  document.getElementById("stock-promotions-list")?.addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-catalog-to-promo]");
    if (copyBtn) {
      copyCatalogPricesToPromo(copyBtn.dataset.copyCatalogToPromo);
      return;
    }
    const removeBtn = e.target.closest("[data-remove-promo]");
    if (removeBtn) {
      const id = Number(removeBtn.dataset.removePromo);
      renderStockPromotions(readStockPromotions().filter((p) => Number(p.id) !== id));
    }
  });
  document.getElementById("v-date")?.addEventListener("change", () => {
    const product = findKnownProduct(document.getElementById("v-article")?.value || "");
    populateSaleFormatSelect(product, null, ventePriceContextDate());
    updateKitInfo(product);
    renderVenteArticlePicker();
  });
  ["s-prix", "s-case-size"].forEach((id) => {
    document.getElementById(id)?.addEventListener("input", renderStockMargePreview);
  });
  document.getElementById("sale-formats-list")?.addEventListener("input", renderStockMargePreview);
  document.getElementById("s-price-location").addEventListener("change", () => {
    updateStockPriceInput();
  });
  document.getElementById("s-price-location-value").addEventListener("input", commitStockPriceInput);
  document.getElementById("save-charge-btn").addEventListener("click", () => saveCharge().catch(handleApiError));
  document.getElementById("save-params-btn").addEventListener("click", () => saveParams().catch(handleApiError));
  document.getElementById("wa-test-btn")?.addEventListener("click", () => testWhatsappNotification().catch(handleApiError));
  document.getElementById("save-user-profile-btn")?.addEventListener("click", () => saveMyUserProfile().catch(handleApiError));
  document.getElementById("print-sales-history-btn").addEventListener("click", printSalesHistory);
  document.getElementById("print-srv-hist-btn")?.addEventListener("click", printServeuseSalesHistory);
  document.getElementById("page-historique-ventes")?.addEventListener("click", (event) => {
    const preset = event.target.closest("[data-srv-hist-preset]");
    if (preset) {
      applyServeuseHistoryPreset(preset.dataset.srvHistPreset);
      renderServeuseSalesHistoryPage();
      return;
    }
    const filterBtn = event.target.closest("[data-srv-hist-filter]");
    if (filterBtn) {
      srvHistCategoryFilter = filterBtn.dataset.srvHistFilter || "all";
      renderServeuseSalesHistoryPage();
    }
  });
  ["srv-hist-period-start", "srv-hist-period-end"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      if (currentPage === "historique-ventes") renderServeuseSalesHistoryPage().catch(() => {});
    });
  });
  document.getElementById("print-stock-report-btn").addEventListener("click", printStockReport);
  document.getElementById("export-stock-excel-btn").addEventListener("click", exportStockExcel);
  document.getElementById("import-stock-excel-btn").addEventListener("click", () => document.getElementById("import-stock-file").click());
  document.getElementById("import-stock-file").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) { importStockExcel(file).catch(handleApiError); e.target.value = ""; }
  });
  document.getElementById("print-closure-btn")?.addEventListener("click", printPdjDayControl);
  document.getElementById("print-pdj-control-btn")?.addEventListener("click", printPdjDayControl);
  document.getElementById("print-pdj-boissons-btn")?.addEventListener("click", printBoissonsVenduesPeriod);
  ["pdj-boissons-date-start", "pdj-boissons-date-end"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      if (currentPage === "pdj") renderPointDuJour();
    });
  });
  document.getElementById("print-pdj-serveuse-btn")?.addEventListener("click", printPdjDayControl);
  document.getElementById("pdj-work-date")?.addEventListener("change", () => {
    pdjBrowseConsultationOnly = false;
    delete pdjViewDateBySite[currentSiteId()];
    ventesDomPdjStamp = "";
    syncPdjWorkDateInput({ keepCurrentValue: true });
    renderTopbar();
    renderOrdersManagement();
    if (currentPage === "pdj") {
      pdjSubTab = suggestPdjSubTabForDay();
      renderPointDuJour();
      setPdjSubTab(pdjSubTab);
    }
    if (currentPage === "ventes") renderVentesPage();
  });
  document.getElementById("pdj-closed-archive")?.addEventListener("click", (e) => {
    const printBtn = e.target.closest("[data-pdj-print-closure]");
    if (printBtn) {
      printDayClosure(printBtn.getAttribute("data-pdj-print-closure"));
      return;
    }
    const browseBtn = e.target.closest("[data-pdj-browse-date]");
    if (browseBtn) {
      setPdjBrowseDate(browseBtn.getAttribute("data-pdj-browse-date"), { consultationOnly: true });
      pdjSubTab = suggestPdjSubTabForDay();
      renderPointDuJour();
      setPdjSubTab(pdjSubTab);
      showToast(`Journée du ${formatDateDdMmYyyy(pdjCalendarDate())} affichée.`);
      return;
    }
    if (e.target.closest("[data-pdj-browse-today]")) {
      setPdjBrowseDate(null);
      renderPointDuJour();
      showToast("Retour au jour comptable actuel.");
    }
  });
  document.getElementById("pdj-apply-work-date")?.addEventListener("click", () => {
    persistPdjWorkDateFromSuperPicker().catch(handleApiError);
  });
  document.getElementById("close-day-btn").addEventListener("click", () => {
    if (!canClosePdjDay()) {
      if (staffRequiresShiftWindowForSales() && !staffIsOnDutyNow()) {
        showToast("Clôture réservée à votre créneau de service (Planning → Mes horaires).");
      } else {
        showToast("Clôture réservée au gérant ou à un administrateur.");
      }
      return;
    }
    if (isPdjBrowseConsultationOnly()) {
      showToast("Consultation seule : cette journée est déjà clôturée.");
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
  document.getElementById("add-site-btn")?.addEventListener("click", () => addSite().catch(handleApiError));
  document.getElementById("cancel-edit-user-btn").addEventListener("click", resetUserForm);
  document.getElementById("toggle-add-user-form-btn")?.addEventListener("click", () => {
    const formCard = document.getElementById("user-form-card");
    const btn = document.getElementById("toggle-add-user-form-btn");
    if (!formCard) return;
    const isVisible = formCard.style.display !== "none";
    if (isVisible) {
      resetUserForm();
    } else {
      formCard.style.display = "";
      if (btn) btn.textContent = "Fermer";
      renderUserSiteCheckboxes();
      formCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
  document.getElementById("users-search")?.addEventListener("input", () => renderUsersList());
  document.getElementById("new-user-role")?.addEventListener("change", () => renderPermissionCheckboxes());
  document.getElementById("new-user-custom-role")?.addEventListener("change", () => renderPermissionCheckboxes());
  document.getElementById("add-custom-role-btn")?.addEventListener("click", () => showRolePermForm());
  document.getElementById("custom-roles-list")?.addEventListener("click", (e) => {
    const editId = e.target.closest("[data-edit-role]")?.dataset.editRole;
    const delId = e.target.closest("[data-delete-role]")?.dataset.deleteRole;
    if (editId) showRolePermForm(editId);
    if (delId) deleteCustomRole(delId).catch(handleApiError);
  });
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
  document.getElementById("export-html-report-btn")?.addEventListener("click", exportHtmlReport);
  document.getElementById("export-btn")?.addEventListener("click", exportData);
  document.getElementById("export-ventes-excel-btn")?.addEventListener("click", exportExcelVentesMonth);
  document.getElementById("export-charges-excel-btn")?.addEventListener("click", exportExcelChargesMonth);
  document.getElementById("export-compta-excel-btn")?.addEventListener("click", exportExcelComptaMonth);
  document.getElementById("top-journal-close-btn")?.addEventListener("click", () => {
    navigate("pdj", { pdjSubTab: "cloture" });
    showToast("Onglet Clôture : vérifiez le stock et clôturez la journée comptable.");
  });
  document.getElementById("stock-filter-bar")?.addEventListener("click", (e) => {
    const catBtn = e.target.closest("[data-stock-cat-filter]");
    if (catBtn) {
      stockCatFilter = catBtn.getAttribute("data-stock-cat-filter") || "all";
      if (currentPage === "stock") renderStock();
      return;
    }
    const stBtn = e.target.closest("[data-stock-status-filter]");
    if (stBtn) {
      stockStatusFilter = stBtn.getAttribute("data-stock-status-filter") || "all";
      if (currentPage === "stock") renderStock();
    }
  });
  document.getElementById("top-backup-download-btn")?.addEventListener("click", () => exportData());
  document.getElementById("top-backup-server-btn")?.addEventListener("click", () => createManualBackupOnServer().catch(handleApiError));
  document.getElementById("reset-btn")?.addEventListener("click", async () => {
    if (!canGlobalSuperAdmin()) {
      showToast("Seul le super administrateur peut reinitialiser l'application.");
      return;
    }
    if (!window.confirm("Reinitialiser toutes les donnees de l'application ?")) return;
    const reauthToken = await requireReauth();
    if (!reauthToken) return;
    try {
      state = await apiRequest(API.reset, { method: "POST", body: JSON.stringify({ reauthToken }) });
      activeOrderId = null;
      await bootstrapAuthenticatedApp({ skipCasierLsRestore: true });
      lsSaveCasiers();
      showToast("Application reinitialisee.");
    } catch (error) {
      handleApiError(error);
    }
  });
  document.getElementById("purge-maquis-btn")?.addEventListener("click", async () => {
    if (!canGlobalSuperAdmin()) {
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
    const reauthToken = await requireReauth();
    if (!reauthToken) return;
    try {
      let compatPut = false;
      try {
        await apiRequest(API.purgeMaquis, { method: "POST", body: JSON.stringify({ siteId, keepStockCatalog: keepCat, reauthToken }) });
      } catch (first) {
        const st = first?.status;
        const apiMsg = typeof first?.message === "string" ? first.message : "";
        const unknownRoute =
          st === 404 || apiMsg.includes("Route API introuvable") || apiMsg.includes("NOT_FOUND") || /\b404\b/.test(apiMsg);
        if (!canGlobalSuperAdmin() || !unknownRoute) throw first;
        await purgeMaquisDataViaStatePut(siteId, keepCat);
        compatPut = true;
      }
      activeOrderId = null;
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
  document.getElementById("shift-journal-day-btn")?.addEventListener("click", async () => {
    if (!canGlobalSuperAdmin()) {
      showToast("Seul le super administrateur peut decaler les dates comptables.");
      return;
    }
    const deltaEl = document.getElementById("shift-journal-delta");
    const d = Number(deltaEl?.value);
    const siteId = currentSiteId();
    const siteLabel = (state?.sites || []).find((s) => String(s.id) === String(siteId))?.nom || siteId;
    const dir = d > 0 ? "AVANCER (+1 jour)" : "RECULER (-1 jour)";
    const msg1 =
      `${dir} — toutes les dates de journée (ventes, PDJ, clôtures stock, commandes, charges, consignes, crédits, achats, casiers…) pour : ${siteLabel}.\n\n`
      + "Faites une sauvegarde (dossier backups/) avant de continuer. Cette operation est difficile a annuler sans restauration.";
    if (!window.confirm(msg1)) return;
    if (!window.confirm("Confirmation finale : appliquer le decalage d'un jour sur le serveur ?")) return;
    try {
      await applySuperadminAccountingJournalDayShift(d, siteId);
    } catch (error) {
      handleApiError(error);
    }
  });
  document.getElementById("corr-search-btn")?.addEventListener("click", () => searchFactureForCorrection());
  document.getElementById("corr-facture-num")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchFactureForCorrection();
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
  bindPlanningEvents();
  document.querySelectorAll(".nav-btn").forEach((button) => button.addEventListener("click", () => handleNavButtonClick(button)));
  bindMobileMoreSheet();
  document.getElementById("page-pdj")?.addEventListener("click", (event) => {
    const pdjTab = event.target.closest("[data-subtab-pdj]");
    if (pdjTab) {
      setPdjSubTab(pdjTab.dataset.subtabPdj || "synthese");
      return;
    }
    if (event.target.closest("#pdj-opening-submit")) recordCashOpening().catch(handleApiError);
  });
  document.getElementById("page-pdj")?.addEventListener("input", (event) => {
    const t = event.target;
    if (!t) return;
    if (t.id === "pdj-opening-cash") {
      const sid = currentSiteId();
      const d = pdjCalendarDate();
      pdjOpeningCashDraftBySiteDate[pdjOpeningCashDraftKey(sid, d)] = t.value;
      return;
    }
    if (t.id === "pdj-closing-cash") {
      const sid = currentSiteId();
      const d = pdjCalendarDate();
      pdjClosingCashDraftBySiteDate[pdjOpeningCashDraftKey(sid, d)] = t.value;
    }
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
    const theorique = parseFormattedIntegerFr(row.cells[3]?.textContent);
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
    const activateOrder = event.target.closest("[data-activate-order]");
    if (activateOrder) {
      takeOverOrder(Number(activateOrder.dataset.activateOrder));
      return;
    }
    const addLine = event.target.closest("[data-add-line-order]");
    if (addLine) {
      openOrderEditor(Number(addLine.dataset.addLineOrder));
      return;
    }
    const kitMixOrder = event.target.closest("[data-kit-mix-order]");
    if (kitMixOrder) {
      openKitMixForOrder(Number(kitMixOrder.dataset.kitMixOrder));
      return;
    }
    const removeKitBatch = event.target.closest("[data-remove-kit-batch]");
    if (removeKitBatch && window.confirm("Retirer tout le lot de kits mixtes ?")) {
      const order = state.commandes.find((item) => item.id === Number(removeKitBatch.dataset.orderId));
      const batch = removeKitBatch.dataset.removeKitBatch;
      if (order && batch) {
        order.lignes = order.lignes.filter((l) => l.kitBatchId !== batch);
        if (!order.lignes.length) {
          state.commandes = state.commandes.filter((item) => item.id !== order.id);
          if (activeOrderId === order.id) activeOrderId = null;
        }
        persistState({ commandes: state.commandes }).then(() => {
          renderVentesPage();
          showToast("Kit(s) mixte(s) retire(s).");
        }).catch(handleApiError);
      }
      return;
    }
    const removeKitGroup = event.target.closest("[data-remove-kit-group]");
    if (removeKitGroup && window.confirm("Retirer tout le kit mixte de la commande ?")) {
      const order = state.commandes.find((item) => item.id === Number(removeKitGroup.dataset.orderId));
      const kg = removeKitGroup.dataset.removeKitGroup;
      if (order && kg) {
        order.lignes = order.lignes.filter((l) => l.kitGroupId !== kg);
        if (!order.lignes.length) {
          state.commandes = state.commandes.filter((item) => item.id !== order.id);
          if (activeOrderId === order.id) activeOrderId = null;
        }
        persistState({ commandes: state.commandes }).then(() => {
          renderVentesPage();
          showToast("Kit mixte retire.");
        }).catch(handleApiError);
      }
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
    if (type === "charge") {
      if (!canDeleteCharge()) {
        showToast("Suppression des charges reservee aux administrateurs.");
        return;
      }
      deleteCharge(id).catch(handleApiError);
    }
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
      if (event.target !== overlay) return;
      if (overlay.id === "modal-order-detail" && Date.now() < suppressOrderDetailBackdropUntil) return;
      closeModal(overlay.id);
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
  ["v-prix", "v-qty"].forEach((id) => document.getElementById(id)?.addEventListener("input", updateVentePreview));
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
      const openDet = event.target.closest("[data-credit-open-detail]");
      if (openDet) {
        const raw = openDet.getAttribute("data-credit-open-detail") || "";
        openCreditDebtorOpenedDetailModal(raw);
        return;
      }
      const payDet = event.target.closest("[data-credit-pay-detail]");
      if (payDet) {
        const rid = payDet.getAttribute("data-credit-pay-detail") || "";
        openCreditPaymentDetailModal(rid);
        return;
      }
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
  const creditDetailBody = document.getElementById("credit-detail-body");
  if (creditDetailBody) {
    creditDetailBody.addEventListener("click", (event) => {
      const delBtn = event.target.closest("[data-delete-credit-recovery]");
      if (!delBtn) return;
      const rid = delBtn.getAttribute("data-delete-credit-recovery") || "";
      deleteCreditRecovery(rid).catch(handleApiError);
    });
  }
}

function applyProductionUiGuards() {
  const jsonBtn = document.getElementById("top-backup-download-btn");
  if (jsonBtn) {
    jsonBtn.classList.toggle("hidden", !shouldShowLocalJsonBackupUi());
  }
}

async function init() {
  attachEvents();
  applyProductionUiGuards();
  setAuthVisible(false);
  try {
    const session = await apiRequest(API.session);
    applySessionFieldsFromApi(session);
    setAuthVisible(true);
    await bootstrapAuthenticatedApp();
  } catch (error) {
    setAuthVisible(false);
  }
}

init();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
}
