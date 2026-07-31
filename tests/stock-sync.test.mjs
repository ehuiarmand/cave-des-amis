/**
 * Tests unitaires — matching articles + logique réparation réception/stock.
 * Exécution : node --test tests/stock-sync.test.mjs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function loadUtilsShared() {
  const code = readFileSync(join(root, "utils-shared.js"), "utf8");
  const sandbox = { console };
  vm.runInNewContext(code, sandbox);
  return sandbox;
}

describe("articleMatchKey", () => {
  it("normalise casse, trim, accents et apostrophes typographiques", () => {
    const { articleMatchKey } = loadUtilsShared();
    assert.equal(articleMatchKey("  CODY'S BLEU  "), "cody's bleu");
    assert.equal(articleMatchKey("CODY’S BLEU"), "cody's bleu"); // ’ U+2019
    assert.equal(articleMatchKey("Codys bleu"), "codys bleu");
    assert.equal(articleMatchKey("Carré d'or"), articleMatchKey("Carre d'or"));
  });

  it("permet de matcher CODY'S BLEU malgré une apostrophe différente", () => {
    const { articleMatchKey, articlesMatch } = loadUtilsShared();
    assert.equal(articlesMatch("CODY'S BLEU", "CODY’S BLEU"), true);
    assert.equal(articlesMatch("CODY'S BLEU", "cody's bleu"), true);
    assert.equal(articlesMatch("CODY'S BLEU", "CODY'S BLANC"), false);
  });
});

describe("purchaseOrderCandidateDates", () => {
  it("inclut date PO, receivedAt et ±1 jour (workingDate vs calendrier)", () => {
    const { purchaseOrderCandidateDates } = loadUtilsShared();
    const dates = purchaseOrderCandidateDates({
      date: "2026-05-09",
      receivedAt: "2026-05-10T00:18:48.803Z",
    });
    assert.ok(dates.includes("2026-05-09"));
    assert.ok(dates.includes("2026-05-10"));
    assert.ok(dates.includes("2026-05-11"));
  });
});

describe("computePurchaseStockRepairPlan", () => {
  it("agrège les lignes dupliquées du même article", () => {
    const { computePurchaseStockRepairPlan } = loadUtilsShared();
    const plan = computePurchaseStockRepairPlan({
      po: {
        id: 110,
        siteId: "maquis-1",
        date: "2026-05-09",
        receivedAt: "2026-05-09T16:47:32.450Z",
        lines: [
          { article: "Sucrerie CARE D'OR", cases: 1, caseSize: 24 },
          { article: "Sucrerie CARE D'OR", cases: 1, caseSize: 24 },
        ],
      },
      stock: [{ id: 1, siteId: "maquis-1", article: "Sucrerie CARE D'OR", caseSize: 24 }],
      stockEntrees: [],
      findStockItem: (article) =>
        article.toLowerCase().includes("care")
          ? { id: 1, siteId: "maquis-1", article: "Sucrerie CARE D'OR", caseSize: 24 }
          : null,
    });
    assert.equal(plan.expectedByKey.get("sucrerie care d'or").expected, 48);
    assert.equal(plan.additions[0].missing, 48);
  });

  it("rattache les entrées legacy (sans purchaseOrderId) au lieu de doubler", () => {
    const { computePurchaseStockRepairPlan } = loadUtilsShared();
    const legacy = {
      id: 119,
      siteId: "maquis-1",
      article: "CODY'S BLEU",
      qty: 24,
      date: "2026-05-09",
      purchaseOrderId: null,
    };
    const plan = computePurchaseStockRepairPlan({
      po: {
        id: 116,
        siteId: "maquis-1",
        date: "2026-05-09",
        receivedAt: "2026-05-10T00:18:48.803Z",
        lines: [{ article: "CODY'S BLEU", cases: 1, caseSize: 24 }],
      },
      stock: [{ id: 246, siteId: "maquis-1", article: "CODY'S BLEU", caseSize: 24 }],
      stockEntrees: [legacy],
      findStockItem: () => ({ id: 246, siteId: "maquis-1", article: "CODY'S BLEU", caseSize: 24 }),
    });
    assert.equal(plan.additions.length, 0);
    assert.equal(plan.linkEntrees.length, 1);
    assert.equal(plan.linkEntrees[0].id, 119);
    assert.equal(plan.bottlesToAdd, 0);
    assert.equal(plan.legacyLinkedBottles, 24);
  });

  it("n'ajoute que le manque si legacy couvre partiellement", () => {
    const { computePurchaseStockRepairPlan } = loadUtilsShared();
    const plan = computePurchaseStockRepairPlan({
      po: {
        id: 200,
        siteId: "maquis-1",
        date: "2026-07-28",
        receivedAt: "2026-07-28T12:00:00.000Z",
        lines: [{ article: "CASTEL 50", cases: 4, caseSize: 12 }],
      },
      stock: [{ id: 10, siteId: "maquis-1", article: "CASTEL 50", caseSize: 12 }],
      stockEntrees: [
        { id: 1, siteId: "maquis-1", article: "CASTEL 50", qty: 24, date: "2026-07-28", purchaseOrderId: null },
      ],
      findStockItem: () => ({ id: 10, siteId: "maquis-1", article: "CASTEL 50", caseSize: 12 }),
    });
    assert.equal(plan.bottlesToAdd, 24);
    assert.equal(plan.legacyLinkedBottles, 24);
  });

  it("détecte needsRepair=false quand legacy couvre tout (date décalée)", () => {
    const { purchaseOrderCoveredBottles } = loadUtilsShared();
    const covered = purchaseOrderCoveredBottles({
      po: {
        id: 116,
        siteId: "maquis-1",
        date: "2026-05-09",
        receivedAt: "2026-05-10T00:18:48.803Z",
        lines: [{ article: "CODY'S BLEU", cases: 1, caseSize: 24 }],
      },
      stockEntrees: [
        { id: 119, siteId: "maquis-1", article: "CODY'S BLEU", qty: 24, date: "2026-05-09", purchaseOrderId: null },
      ],
      findStockItem: () => ({ article: "CODY'S BLEU", caseSize: 24 }),
      siteId: "maquis-1",
    });
    assert.equal(covered.linked, 0);
    assert.equal(covered.legacy, 24);
    assert.equal(covered.total, 24);
    assert.equal(covered.expected, 24);
    assert.equal(covered.needsRepair, false);
  });

  it("ne compte pas une entrée liée au mauvais article comme couverture", () => {
    const { purchaseOrderCoveredBottles } = loadUtilsShared();
    const covered = purchaseOrderCoveredBottles({
      po: {
        id: 50,
        siteId: "maquis-1",
        date: "2026-07-28",
        receivedAt: "2026-07-28T10:00:00.000Z",
        lines: [{ article: "CODY'S BLEU", cases: 1, caseSize: 24 }],
      },
      stockEntrees: [
        { id: 1, siteId: "maquis-1", article: "CASTEL 50", qty: 24, date: "2026-07-28", purchaseOrderId: 50 },
      ],
      findStockItem: (article) =>
        article.includes("CODY")
          ? { article: "CODY'S BLEU", caseSize: 24 }
          : { article: "CASTEL 50", caseSize: 12 },
      siteId: "maquis-1",
    });
    assert.equal(covered.linked, 0);
    assert.equal(covered.needsRepair, true);
  });
});

/**
 * Régression clôture PDJ — empreinte de détection de "stock modifié".
 *
 * closeAccountingDay() compare, pour chaque article, l'empreinte
 * `entrées|sorties|pertes` figée dans le DOM au rendu (renderDailyStockCheck)
 * à une empreinte recalculée juste avant validation. Si les deux côtés
 * n'utilisent PAS les mêmes fonctions de comptage, l'empreinte diverge sans
 * qu'aucun stock n'ait bougé : la clôture est bloquée à tort ET la saisie
 * physique de l'admin est écrasée par le stock catalogue (perte de donnée +
 * écart réel masqué).
 *
 * Les prédicats ci-dessous reproduisent fidèlement app-orders.js :
 *  - RENDU  : todayLossesForArticle(article, dStr, openedAt)
 *             → date == dStr  OU  (openedAt && createdAt >= openedAt)
 *  - PLAGE  : pertesForArticlePeriod(article, dStr, dStr) [ancien freshSnap]
 *             → (date || createdAt) dans [dStr, dStr]
 * Le correctif fait recalculer le freshSnap avec le prédicat RENDU.
 */
describe("closeAccountingDay stale snapshot (pertes, journée comptable multi-jour)", () => {
  const renderLossPredicate = (loss, dStr, openedAt) => {
    if ((loss.date || "").slice(0, 10) === dStr) return true;
    if (openedAt && loss.createdAt && loss.createdAt >= openedAt) return true;
    return false;
  };
  const periodLossPredicate = (loss, dStr) => {
    const d = (loss.date || loss.createdAt || "").slice(0, 10);
    return d === dStr;
  };
  const sumLosses = (losses, pred) => losses.reduce((s, l) => s + (pred(l) ? l.qty : 0), 0);

  // Maquis de nuit : journée comptable "26-07" ouverte la veille au soir,
  // encore ouverte après minuit. Une perte saisie à 01h porte la date
  // CALENDAIRE du 27 (stockLosses.push -> date: today()) alors qu'elle
  // appartient à la journée comptable du 26.
  const dStr = "2026-07-26";
  const openedAt = "2026-07-26T19:00:00.000Z";
  const nightLoss = { article: "CASTEL 50", qty: 3, date: "2026-07-27", createdAt: "2026-07-27T01:00:00.000Z" };

  it("le rendu compte la perte d'après-minuit, la plage stricte l'ignore (source du bug)", () => {
    const rendered = sumLosses([nightLoss], (l) => renderLossPredicate(l, dStr, openedAt));
    const period = sumLosses([nightLoss], (l) => periodLossPredicate(l, dStr));
    assert.equal(rendered, 3);
    assert.equal(period, 0);
    assert.notEqual(rendered, period); // divergence => clôture bloquée à tort avant le fix
  });

  it("après correctif : les deux côtés utilisent le prédicat du rendu et concordent (pas de faux blocage)", () => {
    const renderSnap = sumLosses([nightLoss], (l) => renderLossPredicate(l, dStr, openedAt));
    const freshSnap = sumLosses([nightLoss], (l) => renderLossPredicate(l, dStr, openedAt));
    assert.equal(renderSnap, freshSnap);
  });

  it("une perte réellement ajoutée après le rendu est toujours détectée (protection conservée)", () => {
    const beforeRender = [nightLoss];
    const afterConcurrentAdd = [nightLoss, { article: "CASTEL 50", qty: 2, date: dStr, createdAt: "2026-07-26T22:00:00.000Z" }];
    const renderSnap = sumLosses(beforeRender, (l) => renderLossPredicate(l, dStr, openedAt));
    const freshSnap = sumLosses(afterConcurrentAdd, (l) => renderLossPredicate(l, dStr, openedAt));
    assert.notEqual(renderSnap, freshSnap); // vrai changement => clôture bloquée (comportement voulu)
  });
});
