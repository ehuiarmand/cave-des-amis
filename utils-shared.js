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

/**
 * Clé de comparaison article / brasserie : trim, casse, accents, apostrophes typographiques.
 * Ex. "CODY'S BLEU" === "CODY’S BLEU" (U+2019).
 */
function articleMatchKey(name) {
  return String(name ?? "")
    .trim()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'")
    .toLowerCase();
}

function articlesMatch(a, b) {
  const ka = articleMatchKey(a);
  const kb = articleMatchKey(b);
  return Boolean(ka) && ka === kb;
}

/** Dates candidates pour rattacher une entrée stock legacy à une réception. */
function purchaseOrderCandidateDates(po) {
  const dates = new Set();
  const add = (v) => {
    const d = String(v || "").slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
  };
  add(po?.date);
  add(po?.receivedAt);
  const base = String(po?.receivedAt || po?.date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(base)) {
    const t = Date.parse(`${base}T12:00:00.000Z`);
    if (!Number.isNaN(t)) {
      add(new Date(t - 86400000).toISOString());
      add(new Date(t + 86400000).toISOString());
    }
  }
  return [...dates];
}

function purchaseLineBottlesPure(line, stockItem) {
  const cases = Number(line?.cases) || 0;
  if (cases <= 0) return 0;
  const cs = Number(line?.caseSize) || (stockItem ? (Number(stockItem.caseSize) || 24) : 24);
  return Math.round(cases * cs);
}

/**
 * Calcule couverture stock d'une PO (entrées liées + legacy sans purchaseOrderId).
 * findStockItem(article) → stock row | null
 */
function purchaseOrderCoveredBottles({ po, stockEntrees, findStockItem, siteId }) {
  const sid = siteId ?? po?.siteId;
  const dates = new Set(purchaseOrderCandidateDates(po));
  const poId = Number(po?.id);
  let expected = 0;
  let linked = 0;
  let legacy = 0;
  const expectedByKey = new Map();

  (po?.lines || []).forEach((line) => {
    const item = findStockItem(line.article, sid);
    const bottles = purchaseLineBottlesPure(line, item);
    expected += bottles;
    if (!item || bottles <= 0) return;
    const key = articleMatchKey(item.article);
    const prev = expectedByKey.get(key) || { expected: 0, articleKeys: new Set() };
    prev.expected += bottles;
    prev.articleKeys.add(articleMatchKey(line.article));
    prev.articleKeys.add(key);
    expectedByKey.set(key, prev);
  });

  const entrees = stockEntrees || [];
  const siteOk = (e) =>
    sid == null
    || e.siteId == null
    || e.siteId === ""
    || String(e.siteId) === String(sid);

  // Couverture liée : uniquement les entrées dont l'article correspond à une ligne attendue
  expectedByKey.forEach((v, key) => {
    const linkedForKey = entrees
      .filter((e) =>
        Number(e.purchaseOrderId) === poId
        && siteOk(e)
        && v.articleKeys.has(articleMatchKey(e.article)),
      )
      .reduce((s, e) => s + (Number(e.qty) || 0), 0);
    linked += Math.min(v.expected, linkedForKey);
  });

  // Legacy : sans purchaseOrderId, même site, article attendu, date candidate — plafonné au besoin restant
  expectedByKey.forEach((v, key) => {
    const linkedForKey = entrees
      .filter((e) =>
        Number(e.purchaseOrderId) === poId
        && siteOk(e)
        && v.articleKeys.has(articleMatchKey(e.article)),
      )
      .reduce((s, e) => s + (Number(e.qty) || 0), 0);
    let need = Math.max(0, v.expected - linkedForKey);
    if (need <= 0) return;
    for (const e of entrees) {
      if (need <= 0) break;
      if (e.purchaseOrderId) continue;
      if (!siteOk(e)) continue;
      if (!v.articleKeys.has(articleMatchKey(e.article))) continue;
      if (!dates.has(String(e.date || "").slice(0, 10))) continue;
      const q = Number(e.qty) || 0;
      const take = Math.min(need, q);
      legacy += take;
      need -= take;
    }
  });

  const total = linked + legacy;
  return {
    expected,
    linked,
    legacy,
    total,
    needsRepair: expected > 0 && total < expected,
  };
}

/**
 * Plan de réparation : rattache legacy puis calcule ajouts manquants (anti double-comptage).
 * findStockItem(article) → item | null
 */
function computePurchaseStockRepairPlan({ po, stockEntrees, findStockItem, siteId }) {
  const sid = siteId ?? po?.siteId;
  const dates = new Set(purchaseOrderCandidateDates(po));
  const poId = Number(po?.id);
  const entrees = stockEntrees || [];
  const expectedByKey = new Map();
  const skippedArticles = [];

  (po?.lines || []).forEach((line) => {
    const cases = Number(line.cases) || 0;
    if (cases <= 0) return;
    const item = findStockItem(line.article, sid);
    if (!item) {
      skippedArticles.push(String(line.article || "").trim() || "?");
      return;
    }
    const bottles = purchaseLineBottlesPure(line, item);
    const key = articleMatchKey(item.article);
    const prev = expectedByKey.get(key) || {
      item,
      expected: 0,
      articleKeys: new Set([articleMatchKey(line.article), key]),
    };
    prev.expected += bottles;
    prev.articleKeys.add(articleMatchKey(line.article));
    prev.articleKeys.add(key);
    expectedByKey.set(key, prev);
  });

  const appliedByKey = new Map();
  entrees.forEach((e) => {
    if (Number(e.purchaseOrderId) !== poId) return;
    if (sid != null && e.siteId != null && e.siteId !== "" && String(e.siteId) !== String(sid)) return;
    const key = articleMatchKey(e.article);
    appliedByKey.set(key, (appliedByKey.get(key) || 0) + (Number(e.qty) || 0));
  });

  const linkEntrees = [];
  let legacyLinkedBottles = 0;
  const usedLegacyIds = new Set();

  expectedByKey.forEach((v, key) => {
    let need = v.expected - (appliedByKey.get(key) || 0);
    if (need <= 0) return;
    for (const e of entrees) {
      if (need <= 0) break;
      if (e.purchaseOrderId) continue;
      if (usedLegacyIds.has(e.id)) continue;
      if (sid != null && e.siteId != null && e.siteId !== "" && String(e.siteId) !== String(sid)) continue;
      if (!v.articleKeys.has(articleMatchKey(e.article))) continue;
      if (!dates.has(String(e.date || "").slice(0, 10))) continue;
      usedLegacyIds.add(e.id);
      linkEntrees.push(e);
      const q = Number(e.qty) || 0;
      appliedByKey.set(key, (appliedByKey.get(key) || 0) + q);
      legacyLinkedBottles += q;
      need -= q;
    }
  });

  const additions = [];
  let bottlesToAdd = 0;
  expectedByKey.forEach((v, key) => {
    const missing = v.expected - (appliedByKey.get(key) || 0);
    if (missing <= 0) return;
    additions.push({ key, item: v.item, missing, expected: v.expected });
    bottlesToAdd += missing;
  });

  return {
    expectedByKey,
    appliedByKey,
    linkEntrees,
    additions,
    bottlesToAdd,
    legacyLinkedBottles,
    skippedArticles,
  };
}
