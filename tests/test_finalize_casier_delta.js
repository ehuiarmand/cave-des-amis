/**
 * Régression : finalizeOrder doit persister le delta casiers / casierMouvements.
 *
 * Bug (avant correctif) : rollback.casiers = state.casiers (référence) et
 * rollback.casierMouvements = state.casierMouvements (référence). drainArticleCasiers
 * mute ces mêmes tableaux/objets en place, donc :
 *   - rowsChangedSince(rollback.casiers, state.casiers, siteId) compare les objets à
 *     eux-mêmes -> renvoie toujours [] (le décrément de quantiteActuelle est perdu) ;
 *   - newRowsPrepended(rollback.casierMouvements, state.casierMouvements) compare la
 *     longueur d'un tableau à lui-même -> renvoie toujours [] (mouvement de sortie perdu).
 *
 * Correctif : snapshot (copie) de state.casiers / casierMouvements dans rollback AVANT
 * la mutation. Ce test extrait les VRAIES fonctions rowsChangedSince / newRowsPrepended
 * depuis app-orders.js et vérifie que le snapshot produit bien le delta attendu.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "app-orders.js"), "utf8");

function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Fonction ${name} introuvable dans app-orders.js`);
  // Trouver la première accolade ouvrante puis équilibrer.
  let i = src.indexOf("{", start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i);
}

// eslint-disable-next-line no-eval
eval(extractFn("rowsChangedSince"));
// eslint-disable-next-line no-eval
eval(extractFn("newRowsPrepended"));

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error("ECHEC:", msg); }
  else console.log("OK:", msg);
}

const SITE = "site1";

function buildState() {
  return {
    casiers: [
      { id: 1, siteId: SITE, article: "biere", quantiteActuelle: 24, capacite: 24 },
      { id: 2, siteId: SITE, article: "biere", quantiteActuelle: 12, capacite: 24 },
    ],
    casierMouvements: [
      { id: 100, siteId: SITE, casierId: 1, type: "entree", quantite: 24 },
    ],
  };
}

// Simule ce que fait drainArticleCasiers : mutation en place d'un casier + unshift mouvement.
function drainInPlace(state) {
  const c = state.casiers.find((x) => x.id === 2);
  c.quantiteActuelle = c.quantiteActuelle - 6; // 12 -> 6
  state.casierMouvements.unshift({ id: 101, siteId: SITE, casierId: 2, type: "sortie", quantite: 6 });
}

// --- Reproduction du BUG (rollback par référence) ---
{
  const state = buildState();
  const rollback = { casiers: state.casiers, casierMouvements: state.casierMouvements };
  drainInPlace(state);
  const casiersDelta = rowsChangedSince(rollback.casiers, state.casiers, SITE);
  const mvtsDelta = newRowsPrepended(rollback.casierMouvements, state.casierMouvements);
  assert(casiersDelta.length === 0, "BUG reproduit : delta casiers vide avec rollback par référence");
  assert(mvtsDelta.length === 0, "BUG reproduit : delta mouvements vide avec rollback par référence");
}

// --- Comportement CORRIGE (rollback par snapshot) ---
{
  const state = buildState();
  const rollback = {
    casiers: JSON.parse(JSON.stringify(state.casiers || [])),
    casierMouvements: (state.casierMouvements || []).slice(),
  };
  drainInPlace(state);
  const casiersDelta = rowsChangedSince(rollback.casiers, state.casiers, SITE);
  const mvtsDelta = newRowsPrepended(rollback.casierMouvements, state.casierMouvements);
  assert(casiersDelta.length === 1 && casiersDelta[0].id === 2 && casiersDelta[0].quantiteActuelle === 6,
    "CORRECTIF : le casier décrémenté (id=2, qte=6) est dans le delta");
  assert(mvtsDelta.length === 1 && mvtsDelta[0].id === 101 && mvtsDelta[0].type === "sortie",
    "CORRECTIF : le mouvement de sortie (id=101) est dans le delta");
}

// --- Vérifie que le code source contient bien le snapshot (pas la référence) ---
{
  const rollbackBlock = src.slice(src.indexOf("const rollback = {"), src.indexOf("const rollback = {") + 900);
  assert(/casiers:\s*JSON\.parse\(JSON\.stringify\(state\.casiers/.test(rollbackBlock),
    "SOURCE : rollback.casiers utilise un snapshot (JSON.parse/stringify)");
  assert(/casierMouvements:\s*\(state\.casierMouvements\s*\|\|\s*\[\]\)\.slice\(\)/.test(rollbackBlock),
    "SOURCE : rollback.casierMouvements utilise un snapshot (.slice())");
}

if (failures) {
  console.error(`\n${failures} assertion(s) en échec.`);
  process.exit(1);
}
console.log("\nToutes les assertions passent.");
