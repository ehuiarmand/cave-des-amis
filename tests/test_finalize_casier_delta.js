/**
 * Régression : le delta casiers/casierMouvements calculé par finalizeOrder
 * doit refléter les mutations faites par drainArticleCasiers.
 *
 * Bug (v387-v389) : rollback.casiers / rollback.casierMouvements étaient de
 * simples RÉFÉRENCES vers state.casiers / state.casierMouvements, tableaux
 * mutés EN PLACE par drainArticleCasiers (décrément quantiteActuelle, unshift
 * des mouvements). Le « avant » et le « après » pointant sur les mêmes objets,
 * rowsChangedSince() et newRowsPrepended() renvoyaient toujours [] → le
 * décrément des casiers et les mouvements de sortie n'étaient jamais persistés
 * côté serveur (perte silencieuse, annulée au prochain resync).
 *
 * Correctif : capturer un vrai snapshot (deep copy des casiers, copie du tableau
 * de mouvements) AVANT les mutations.
 *
 * Ce test extrait les deux fonctions utilitaires réelles de app-orders.js et
 * rejoue le motif de mutation, en vérifiant les deux invariants.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `fonction ${name} introuvable dans app-orders.js`);
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`accolade de fin non trouvée pour ${name}`);
}

const source = fs.readFileSync(path.join(__dirname, "..", "app-orders.js"), "utf8");
const rowsChangedSinceSrc = extractFunction(source, "rowsChangedSince");
const newRowsPrependedSrc = extractFunction(source, "newRowsPrepended");

// eslint-disable-next-line no-new-func
const { rowsChangedSince, newRowsPrepended } = new Function(
  `${rowsChangedSinceSrc}\n${newRowsPrependedSrc}\nreturn { rowsChangedSince, newRowsPrepended };`,
)();

const SITE = "maquis-1";

function freshState() {
  return {
    casiers: [
      { id: 1, siteId: SITE, article: "Beaufort", quantiteActuelle: 24, capacite: 24 },
      { id: 2, siteId: SITE, article: "Flag", quantiteActuelle: 12, capacite: 24 },
    ],
    casierMouvements: [
      { id: 10, siteId: SITE, type: "entree", quantite: 24 },
    ],
  };
}

// Simule le drain effectué par drainArticleCasiers : mutation en place + unshift.
function simulateDrain(state) {
  state.casiers[0].quantiteActuelle = 20; // vente de 4 bouteilles
  state.casierMouvements.unshift({ id: 11, siteId: SITE, type: "sortie", quantite: 4 });
}

// 1) Reproduction du bug : « avant » = référence vers les mêmes tableaux/objets.
(function reproduceBug() {
  const state = freshState();
  const badBeforeCasiers = state.casiers; // référence
  const badBeforeMvts = state.casierMouvements; // référence
  simulateDrain(state);

  const casierDelta = rowsChangedSince(badBeforeCasiers, state.casiers, SITE);
  const mvtDelta = newRowsPrepended(badBeforeMvts, state.casierMouvements);

  // Le bug : les deltas sont vides alors qu'il y a bien eu des changements.
  assert.strictEqual(casierDelta.length, 0, "attendu: référence => delta casiers vide (bug)");
  assert.strictEqual(mvtDelta.length, 0, "attendu: référence => delta mouvements vide (bug)");
})();

// 2) Correctif : « avant » = snapshot réel capturé avant mutation.
(function verifyFix() {
  const state = freshState();
  const beforeCasiers = JSON.parse(JSON.stringify(state.casiers)); // deep copy
  const beforeMvts = state.casierMouvements.slice(); // copie du tableau
  simulateDrain(state);

  const casierDelta = rowsChangedSince(beforeCasiers, state.casiers, SITE);
  const mvtDelta = newRowsPrepended(beforeMvts, state.casierMouvements);

  assert.strictEqual(casierDelta.length, 1, "snapshot => 1 casier modifié détecté");
  assert.strictEqual(casierDelta[0].id, 1, "le casier modifié est bien le n°1");
  assert.strictEqual(casierDelta[0].quantiteActuelle, 20, "quantité décrémentée persistée");

  assert.strictEqual(mvtDelta.length, 1, "snapshot => 1 nouveau mouvement détecté");
  assert.strictEqual(mvtDelta[0].id, 11, "le mouvement de sortie est bien remonté");
})();

console.log("OK: régression casier delta finalizeOrder (snapshot avant mutation)");
