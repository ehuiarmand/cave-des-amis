/* ============================================================
   restaurant-module.js — Module Restaurant pour Maquis Manager
   ============================================================
   PRINCIPE : 100 % additif.
   - Aucune modification des données existantes (ventes, stock boissons, commandes…)
   - S'active uniquement si site.hasRestaurant === true
   - Utilise les fonctions globales existantes : escapeHtml, fmt, showToast,
     handleApiError, currentSiteId, currentSite, recordsForSite, persistStatePatch,
     navigate, canManage, canSiteAdmin, isServeuseAccount, today, applyRoleVisibility
   - Lignes commande food : { ...ligneExistante, type: "food" }
     rétrocompat : type absent → boisson
   ============================================================ */

"use strict";

// ── 1. HELPERS ──────────────────────────────────────────────

/** Retourne true si le site courant a le module restaurant activé. */
function siteHasRestaurant() {
  return Boolean(currentSite()?.hasRestaurant);
}

/** Catégories cuisine (ordre d'affichage). */
const RST_CATEGORIES = ["Entrées", "Plats", "Desserts", "Accompagnements", "Autres"];

/** Couleurs par catégorie pour les badges. */
const RST_CAT_CLASS = {
  "Entrées":        "rst-cat-entrees",
  "Plats":          "rst-cat-plats",
  "Desserts":       "rst-cat-desserts",
  "Accompagnements":"rst-cat-accomp",
  "Autres":         "rst-cat-autres",
};

/** Filtre courant sur la page menu-cuisine. */
let rstMenuFilter = "Tous";

/** Filtre courant sur la page stock-cuisine. */
let rstStockFilter = "Tous";

/** Retourne les plats du menu pour le site courant. */
function rstMenuItems() {
  if (!state?.restaurantMenu) return [];
  const multi = typeof multiSiteActive === "function" ? multiSiteActive() : false;
  const siteId = currentSiteId();
  return (state.restaurantMenu || []).filter((item) => {
    if (!multi) return true;
    return !item.siteId || item.siteId === siteId;
  });
}

/** Retourne les ingrédients pour le site courant. */
function rstIngrItems() {
  if (!state?.ingredientStock) return [];
  const multi = typeof multiSiteActive === "function" ? multiSiteActive() : false;
  const siteId = currentSiteId();
  return (state.ingredientStock || []).filter((item) => {
    if (!multi) return true;
    return !item.siteId || item.siteId === siteId;
  });
}

/** Prochain ID pour les plats. */
function rstNextMenuId() {
  state.nextId = state.nextId || {};
  state.nextId.restaurantMenu = (Number(state.nextId.restaurantMenu) || 0) + 1;
  return state.nextId.restaurantMenu;
}

/** Prochain ID pour les ingrédients. */
function rstNextIngrId() {
  state.nextId = state.nextId || {};
  state.nextId.ingredientStock = (Number(state.nextId.ingredientStock) || 0) + 1;
  return state.nextId.ingredientStock;
}

/** Classe CSS pour un badge catégorie. */
function rstCatClass(cat) {
  return RST_CAT_CLASS[cat] || "rst-cat-autres";
}

// ── 2. VISIBILITÉ DU MODULE ──────────────────────────────────

/** Cache les nav items restaurant si le module est inactif sur ce site. */
function rstApplyVisibility() {
  const active = siteHasRestaurant();
  document.querySelectorAll(".restaurant-module-nav").forEach((el) => {
    el.classList.toggle("hidden", !active);
  });
  // Si on est sur une page restaurant mais que le module est désactivé → rediriger
  if (!active && (currentPage === "menu-cuisine" || currentPage === "stock-cuisine")) {
    navigate("home");
  }
}

// ── 3. HOOKS NAVIGATE + ROLE VISIBILITY ─────────────────────

(function rstInstallHooks() {
  // Attendre que les fonctions de app-orders.js soient disponibles
  if (typeof navigate !== "function" || typeof applyRoleVisibility !== "function") {
    window.addEventListener("DOMContentLoaded", rstInstallHooks);
    return;
  }

  // Wrapper navigate pour rendre les pages restaurant
  const _origNavigate = window.navigate;
  window.navigate = function (page, opts = {}) {
    _origNavigate(page, opts);
    if (page === "menu-cuisine") rstRenderMenuPage();
    if (page === "stock-cuisine") rstRenderStockPage();
  };

  // Wrapper applyRoleVisibility pour gérer la visibilité restaurant
  const _origApplyRoleVisibility = window.applyRoleVisibility;
  window.applyRoleVisibility = function () {
    _origApplyRoleVisibility();
    rstApplyVisibility();
  };

  // Wrapper renderSrMenu pour ajouter les onglets food
  if (typeof renderSrMenu === "function") {
    const _origRenderSrMenu = window.renderSrMenu;
    window.renderSrMenu = function (query) {
      _origRenderSrMenu(query);
      rstInjectSrTabs();
    };
  }
})();

// ── 4. PAGE MENU CUISINE ─────────────────────────────────────

function rstRenderMenuPage() {
  const root = document.getElementById("page-menu-cuisine");
  if (!root) return;

  if (!siteHasRestaurant()) {
    root.innerHTML = "<p style='padding:24px;color:#9e9e9e'>Module restaurant non activé pour cet établissement.</p>";
    return;
  }

  const isManager = typeof canManage === "function" ? canManage() : false;
  const isAdmin   = typeof canSiteAdmin === "function" ? canSiteAdmin() : false;
  const canEdit   = isManager || isAdmin;

  const items = rstMenuItems();
  const filtered = rstMenuFilter === "Tous"
    ? items
    : items.filter((p) => p.categorie === rstMenuFilter);

  // KPI rapide
  const total = items.length;
  const dispos = items.filter((p) => p.disponible !== false).length;

  // Filtres catégorie
  const allCats = ["Tous", ...RST_CATEGORIES.filter((c) => items.some((p) => p.categorie === c))];
  const filterBtns = allCats.map((c) =>
    `<button type="button" class="rst-cat-filter-btn${rstMenuFilter === c ? " active" : ""}"
      onclick="rstSetMenuFilter(${JSON.stringify(c)})">${escapeHtml(c)}</button>`
  ).join("");

  // Cartes plats
  let cardsHtml = "";
  if (!filtered.length) {
    cardsHtml = `<div class="rst-empty"><span class="rst-empty-icon">🍽</span>
      ${rstMenuFilter === "Tous" ? "Aucun plat dans le menu. Ajoutez votre premier plat." : "Aucun plat dans cette catégorie."}
    </div>`;
  } else {
    cardsHtml = `<div class="rst-plat-grid">` +
      filtered.map((item) => rstPlatCard(item, canEdit)).join("") +
    `</div>`;
  }

  root.innerHTML = `
    <div class="section-head" style="flex-wrap:wrap;gap:8px">
      <h2>Menu cuisine</h2>
      ${canEdit ? `<button class="btn btn-primary" type="button" onclick="rstOpenPlatModal(null)">+ Ajouter un plat</button>` : ""}
    </div>
    <div class="inline-card" style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:4px">
      <span><strong>${total}</strong> <span class="muted">plats au menu</span></span>
      <span><strong style="color:#2e7d32">${dispos}</strong> <span class="muted">disponibles</span></span>
      <span><strong style="color:#c62828">${total - dispos}</strong> <span class="muted">indisponibles</span></span>
    </div>
    <div class="rst-cat-filters">${filterBtns}</div>
    ${cardsHtml}
    ${rstPlatModal()}
  `;
}

function rstSetMenuFilter(cat) {
  rstMenuFilter = cat;
  rstRenderMenuPage();
}

function rstPlatCard(item, canEdit) {
  const dispo = item.disponible !== false;
  return `
    <div class="rst-plat-card${dispo ? "" : " indisponible"}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px">
        <span class="rst-plat-name">${escapeHtml(item.nom)}</span>
        <span class="rst-badge-dispo ${dispo ? "on" : "off"}">${dispo ? "Dispo" : "Indispo"}</span>
      </div>
      <span class="rst-plat-cat ${rstCatClass(item.categorie)}">${escapeHtml(item.categorie || "Autres")}</span>
      <span class="rst-plat-prix">${fmt(item.prix || 0)} FCFA</span>
      ${item.description ? `<span class="rst-plat-desc" title="${escapeHtml(item.description)}">${escapeHtml(item.description)}</span>` : ""}
      ${item.ingredients?.length ? `<span style="font-size:0.75rem;color:#9e9e9e">${item.ingredients.length} ingrédient(s)</span>` : ""}
      ${canEdit ? `
        <div class="rst-plat-actions">
          <button type="button" class="btn btn-sm btn-outline" onclick="rstOpenPlatModal(${item.id})">Modifier</button>
          <button type="button" class="btn btn-sm btn-outline" onclick="rstToggleDispo(${item.id})">${dispo ? "Désactiver" : "Activer"}</button>
          <button type="button" class="btn btn-sm" style="background:#ffebee;color:#c62828;border:none;border-radius:6px;padding:4px 10px;font-size:0.8rem;cursor:pointer" onclick="rstDeletePlat(${item.id})">Suppr.</button>
        </div>` : ""}
    </div>`;
}

// ── 5. MODAL AJOUT / ÉDITION PLAT ────────────────────────────

function rstPlatModal() {
  return `
  <div id="rst-modal-plat" class="modal-overlay" aria-hidden="true">
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="section-head">
        <h3 id="rst-modal-plat-title">Nouveau plat</h3>
        <button class="icon-btn" type="button" onclick="rstClosePlatModal()">Fermer</button>
      </div>
      <div class="form-grid two-cols" style="padding:4px 0 12px">
        <div class="form-group" style="grid-column:1/-1">
          <label for="rst-p-nom">Nom du plat *</label>
          <input id="rst-p-nom" type="text" placeholder="ex: Poulet braisé, Attiéké poisson…" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="rst-p-cat">Catégorie</label>
          <select id="rst-p-cat">
            ${RST_CATEGORIES.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("")}
          </select>
        </div>
        <div class="form-group">
          <label for="rst-p-prix">Prix de vente (FCFA) *</label>
          <input id="rst-p-prix" type="number" min="0" step="50" placeholder="2500">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label for="rst-p-desc">Description (optionnel)</label>
          <input id="rst-p-desc" type="text" placeholder="ex: Servi avec du foutou et sauce graine">
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label class="checkbox-label" style="display:flex;align-items:center;gap:10px;cursor:pointer">
            <input id="rst-p-dispo" type="checkbox" checked style="width:auto;margin:0">
            <span>Disponible à la vente</span>
          </label>
        </div>
        <div class="form-group" style="grid-column:1/-1">
          <label>Ingrédients (optionnel — pour suivi stock cuisine)</label>
          <div id="rst-ingr-list" class="rst-modal-ingredients"></div>
          <button type="button" class="btn btn-sm btn-outline" style="margin-top:8px" onclick="rstAddIngrRow()">+ Ajouter un ingrédient</button>
        </div>
      </div>
      <div class="button-stack" style="position:sticky;bottom:0;background:var(--card-bg,#fff);padding:10px 0 6px;z-index:2;box-shadow:0 -2px 8px rgba(0,0,0,.06)">
        <button id="rst-modal-plat-save" class="btn btn-primary" type="button" onclick="rstSavePlat()">Enregistrer</button>
        <button class="btn btn-outline" type="button" onclick="rstClosePlatModal()">Annuler</button>
      </div>
      <input type="hidden" id="rst-p-edit-id" value="">
    </div>
  </div>`;
}

/** ID du plat en cours d'édition (null = création). */
let _rstEditingPlatId = null;

function rstOpenPlatModal(id) {
  _rstEditingPlatId = id;
  const modal = document.getElementById("rst-modal-plat");
  if (!modal) { rstRenderMenuPage(); setTimeout(() => rstOpenPlatModal(id), 80); return; }

  document.getElementById("rst-modal-plat-title").textContent = id ? "Modifier le plat" : "Nouveau plat";
  document.getElementById("rst-p-edit-id").value = id ?? "";

  if (id) {
    const item = rstMenuItems().find((p) => p.id === id);
    if (!item) return;
    document.getElementById("rst-p-nom").value = item.nom || "";
    document.getElementById("rst-p-cat").value = item.categorie || "Plats";
    document.getElementById("rst-p-prix").value = item.prix || "";
    document.getElementById("rst-p-desc").value = item.description || "";
    document.getElementById("rst-p-dispo").checked = item.disponible !== false;
    rstRenderIngrList(item.ingredients || []);
  } else {
    document.getElementById("rst-p-nom").value = "";
    document.getElementById("rst-p-cat").value = "Plats";
    document.getElementById("rst-p-prix").value = "";
    document.getElementById("rst-p-desc").value = "";
    document.getElementById("rst-p-dispo").checked = true;
    rstRenderIngrList([]);
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("rst-p-nom").focus();
}

function rstClosePlatModal() {
  const modal = document.getElementById("rst-modal-plat");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function rstRenderIngrList(ingredients) {
  const list = document.getElementById("rst-ingr-list");
  if (!list) return;
  if (!ingredients.length) {
    list.innerHTML = "<p style='font-size:0.8rem;color:#9e9e9e;margin:0'>Aucun ingrédient. Ajoutez-en pour activer le suivi de stock cuisine.</p>";
    return;
  }
  list.innerHTML = ingredients.map((ing, i) => `
    <div class="rst-ingr-row" data-ingr-idx="${i}">
      <input type="text" class="rst-ingr-nom" value="${escapeHtml(ing.nom || "")}" placeholder="Ingrédient">
      <input type="number" class="rst-ingr-qte" value="${ing.quantite || ""}" min="0" step="0.1" placeholder="Qté">
      <input type="text" class="rst-ingr-unite" value="${escapeHtml(ing.unite || "")}" placeholder="Unité">
      <button type="button" onclick="rstRemoveIngrRow(${i})" style="background:none;border:none;cursor:pointer;color:#f44336;font-size:1.1rem;padding:0 4px">×</button>
    </div>`).join("");
}

function rstAddIngrRow() {
  const list = document.getElementById("rst-ingr-list");
  if (!list) return;
  const current = rstReadIngrFromModal();
  rstRenderIngrList([...current, { nom: "", quantite: "", unite: "" }]);
}

function rstRemoveIngrRow(idx) {
  const current = rstReadIngrFromModal();
  current.splice(idx, 1);
  rstRenderIngrList(current);
}

function rstReadIngrFromModal() {
  const rows = document.querySelectorAll("#rst-ingr-list .rst-ingr-row");
  const result = [];
  rows.forEach((row) => {
    const nom = row.querySelector(".rst-ingr-nom")?.value?.trim() || "";
    const quantite = parseFloat(row.querySelector(".rst-ingr-qte")?.value) || 0;
    const unite = row.querySelector(".rst-ingr-unite")?.value?.trim() || "";
    if (nom) result.push({ nom, quantite, unite });
  });
  return result;
}

async function rstSavePlat() {
  const nom = document.getElementById("rst-p-nom")?.value?.trim();
  const prix = Number(document.getElementById("rst-p-prix")?.value) || 0;
  if (!nom) { showToast("Saisissez le nom du plat."); return; }
  if (!prix) { showToast("Saisissez le prix de vente."); return; }

  const editId = _rstEditingPlatId;
  const item = {
    nom,
    categorie: document.getElementById("rst-p-cat")?.value || "Plats",
    prix,
    description: document.getElementById("rst-p-desc")?.value?.trim() || "",
    disponible: document.getElementById("rst-p-dispo")?.checked !== false,
    ingredients: rstReadIngrFromModal(),
    siteId: currentSiteId(),
  };

  state.restaurantMenu = state.restaurantMenu || [];

  if (editId) {
    const idx = state.restaurantMenu.findIndex((p) => p.id === editId);
    if (idx >= 0) state.restaurantMenu[idx] = { ...state.restaurantMenu[idx], ...item };
  } else {
    item.id = rstNextMenuId();
    state.restaurantMenu.push(item);
  }

  const btn = document.getElementById("rst-modal-plat-save");
  if (btn) { btn.disabled = true; btn.textContent = "Enregistrement…"; }
  try {
    await persistStatePatch({ restaurantMenu: state.restaurantMenu, nextId: state.nextId });
    showToast(editId ? "Plat mis à jour." : "Plat ajouté au menu.");
    rstClosePlatModal();
    rstRenderMenuPage();
  } catch (err) {
    showToast("Erreur lors de l'enregistrement.");
    console.error("[restaurant-module] rstSavePlat:", err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Enregistrer"; }
  }
}

async function rstToggleDispo(id) {
  const item = (state.restaurantMenu || []).find((p) => p.id === id);
  if (!item) return;
  item.disponible = !item.disponible;
  try {
    await persistStatePatch({ restaurantMenu: state.restaurantMenu });
    rstRenderMenuPage();
  } catch (err) {
    showToast("Erreur lors de la mise à jour.");
    console.error("[restaurant-module] rstToggleDispo:", err);
  }
}

async function rstDeletePlat(id) {
  const item = (state.restaurantMenu || []).find((p) => p.id === id);
  if (!item) return;
  if (!confirm(`Supprimer le plat « ${item.nom} » du menu ?`)) return;
  state.restaurantMenu = (state.restaurantMenu || []).filter((p) => p.id !== id);
  try {
    await persistStatePatch({ restaurantMenu: state.restaurantMenu });
    showToast("Plat supprimé.");
    rstRenderMenuPage();
  } catch (err) {
    showToast("Erreur lors de la suppression.");
    console.error("[restaurant-module] rstDeletePlat:", err);
  }
}

// ── 6. PAGE STOCK INGRÉDIENTS ─────────────────────────────────

function rstRenderStockPage() {
  const root = document.getElementById("page-stock-cuisine");
  if (!root) return;

  if (!siteHasRestaurant()) {
    root.innerHTML = "<p style='padding:24px;color:#9e9e9e'>Module restaurant non activé pour cet établissement.</p>";
    return;
  }

  const canEdit = (typeof canManage === "function" ? canManage() : false) ||
                  (typeof canSiteAdmin === "function" ? canSiteAdmin() : false);

  const items = rstIngrItems();
  const alertes = items.filter((i) => (i.quantite || 0) <= (i.seuilMin || 0));

  let tableHtml = "";
  if (!items.length) {
    tableHtml = `<div class="rst-empty"><span class="rst-empty-icon">🥕</span>
      Aucun ingrédient enregistré. Ajoutez vos matières premières ici,<br>
      ou associez des ingrédients aux plats via le menu cuisine.
    </div>`;
  } else {
    tableHtml = `
      <div style="overflow-x:auto">
        <table class="rst-ingr-table">
          <thead>
            <tr>
              <th>Ingrédient</th>
              <th>Quantité</th>
              <th>Unité</th>
              <th>Seuil min</th>
              <th>État</th>
              ${canEdit ? "<th>Actions</th>" : ""}
            </tr>
          </thead>
          <tbody>
            ${items.map((item) => rstIngrRow(item, canEdit)).join("")}
          </tbody>
        </table>
      </div>`;
  }

  root.innerHTML = `
    <div class="section-head" style="flex-wrap:wrap;gap:8px">
      <h2>Stock ingrédients</h2>
      ${canEdit ? `<button class="btn btn-primary" type="button" onclick="rstOpenIngrModal(null)">+ Ajouter un ingrédient</button>` : ""}
    </div>
    ${alertes.length ? `
      <div class="inline-card" style="background:#fff3e0;border-color:#ffb74d;margin-bottom:12px">
        <span style="color:#e65100;font-weight:700">⚠ ${alertes.length} ingrédient(s) sous le seuil :</span>
        <span style="color:#bf360c"> ${alertes.map((i) => escapeHtml(i.nom)).join(", ")}</span>
      </div>` : ""}
    ${tableHtml}
    ${rstIngrModal()}
  `;
}

function rstIngrRow(item, canEdit) {
  const alerte = (item.quantite || 0) <= (item.seuilMin || 0);
  return `
    <tr class="${alerte ? "rst-alerte-seuil" : ""}">
      <td><strong>${escapeHtml(item.nom)}</strong></td>
      <td>${fmt(item.quantite || 0)}</td>
      <td>${escapeHtml(item.unite || "—")}</td>
      <td>${fmt(item.seuilMin || 0)}</td>
      <td>${alerte
        ? "<span class='rst-badge-dispo off'>Stock bas</span>"
        : "<span class='rst-badge-dispo on'>OK</span>"}</td>
      ${canEdit ? `<td>
        <button type="button" class="btn btn-sm btn-outline" onclick="rstOpenIngrModal(${item.id})">Modifier</button>
        <button type="button" class="btn btn-sm" style="background:#ffebee;color:#c62828;border:none;border-radius:6px;padding:4px 10px;font-size:0.8rem;cursor:pointer;margin-left:4px" onclick="rstDeleteIngr(${item.id})">Suppr.</button>
      </td>` : ""}
    </tr>`;
}

function rstIngrModal() {
  return `
  <div id="rst-modal-ingr" class="modal-overlay hidden" aria-hidden="true">
    <div class="modal">
      <div class="modal-handle"></div>
      <div class="section-head">
        <h3 id="rst-modal-ingr-title">Nouvel ingrédient</h3>
        <button class="icon-btn" type="button" onclick="rstCloseIngrModal()">Fermer</button>
      </div>
      <div class="form-grid two-cols" style="padding:4px 0 12px">
        <div class="form-group" style="grid-column:1/-1">
          <label for="rst-i-nom">Nom *</label>
          <input id="rst-i-nom" type="text" placeholder="ex: Tomates, Huile, Riz…" autocomplete="off">
        </div>
        <div class="form-group">
          <label for="rst-i-qte">Quantité en stock *</label>
          <input id="rst-i-qte" type="number" min="0" step="0.1" placeholder="0">
        </div>
        <div class="form-group">
          <label for="rst-i-unite">Unité</label>
          <input id="rst-i-unite" type="text" placeholder="kg, L, unité…" list="rst-unite-list">
          <datalist id="rst-unite-list">
            <option value="kg">
            <option value="g">
            <option value="L">
            <option value="cl">
            <option value="unité">
            <option value="sachet">
            <option value="boite">
          </datalist>
        </div>
        <div class="form-group">
          <label for="rst-i-seuil">Seuil d'alerte</label>
          <input id="rst-i-seuil" type="number" min="0" step="0.1" placeholder="0">
        </div>
        <div class="form-group">
          <label for="rst-i-prix">Prix unitaire (FCFA)</label>
          <input id="rst-i-prix" type="number" min="0" step="10" placeholder="0">
        </div>
      </div>
      <div class="button-stack" style="position:sticky;bottom:0;background:var(--card-bg,#fff);padding:10px 0 6px;z-index:2;box-shadow:0 -2px 8px rgba(0,0,0,.06)">
        <button id="rst-modal-ingr-save" class="btn btn-primary" type="button" onclick="rstSaveIngr()">Enregistrer</button>
        <button class="btn btn-outline" type="button" onclick="rstCloseIngrModal()">Annuler</button>
      </div>
      <input type="hidden" id="rst-i-edit-id" value="">
    </div>
  </div>`;
}

let _rstEditingIngrId = null;

function rstOpenIngrModal(id) {
  _rstEditingIngrId = id;
  const modal = document.getElementById("rst-modal-ingr");
  if (!modal) { rstRenderStockPage(); setTimeout(() => rstOpenIngrModal(id), 80); return; }

  document.getElementById("rst-modal-ingr-title").textContent = id ? "Modifier l'ingrédient" : "Nouvel ingrédient";
  document.getElementById("rst-i-edit-id").value = id ?? "";

  if (id) {
    const item = rstIngrItems().find((i) => i.id === id);
    if (!item) return;
    document.getElementById("rst-i-nom").value = item.nom || "";
    document.getElementById("rst-i-qte").value = item.quantite ?? "";
    document.getElementById("rst-i-unite").value = item.unite || "";
    document.getElementById("rst-i-seuil").value = item.seuilMin ?? "";
    document.getElementById("rst-i-prix").value = item.prixUnitaire ?? "";
  } else {
    ["rst-i-nom","rst-i-qte","rst-i-unite","rst-i-seuil","rst-i-prix"]
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ""; });
  }

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("rst-i-nom").focus();
}

function rstCloseIngrModal() {
  const modal = document.getElementById("rst-modal-ingr");
  if (!modal) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

async function rstSaveIngr() {
  const nom = document.getElementById("rst-i-nom")?.value?.trim();
  if (!nom) { showToast("Saisissez le nom de l'ingrédient."); return; }

  const item = {
    nom,
    quantite: parseFloat(document.getElementById("rst-i-qte")?.value) || 0,
    unite: document.getElementById("rst-i-unite")?.value?.trim() || "",
    seuilMin: parseFloat(document.getElementById("rst-i-seuil")?.value) || 0,
    prixUnitaire: parseFloat(document.getElementById("rst-i-prix")?.value) || 0,
    siteId: currentSiteId(),
  };

  state.ingredientStock = state.ingredientStock || [];
  const editId = _rstEditingIngrId;

  if (editId) {
    const idx = state.ingredientStock.findIndex((i) => i.id === editId);
    if (idx >= 0) state.ingredientStock[idx] = { ...state.ingredientStock[idx], ...item };
  } else {
    item.id = rstNextIngrId();
    state.ingredientStock.push(item);
  }

  const btn = document.getElementById("rst-modal-ingr-save");
  if (btn) { btn.disabled = true; btn.textContent = "Enregistrement…"; }
  try {
    await persistStatePatch({ ingredientStock: state.ingredientStock, nextId: state.nextId });
    showToast(editId ? "Ingrédient mis à jour." : "Ingrédient ajouté.");
    rstCloseIngrModal();
    rstRenderStockPage();
  } catch (err) {
    showToast("Erreur lors de l'enregistrement.");
    console.error("[restaurant-module] rstSaveIngr:", err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Enregistrer"; }
  }
}

async function rstDeleteIngr(id) {
  const item = (state.ingredientStock || []).find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`Supprimer l'ingrédient « ${item.nom} » ?`)) return;
  state.ingredientStock = (state.ingredientStock || []).filter((i) => i.id !== id);
  try {
    await persistStatePatch({ ingredientStock: state.ingredientStock });
    showToast("Ingrédient supprimé.");
    rstRenderStockPage();
  } catch (err) {
    showToast("Erreur lors de la suppression.");
    console.error("[restaurant-module] rstDeleteIngr:", err);
  }
}

// ── 7. SAISIE RAPIDE — ONGLET PLATS ──────────────────────────

/** Indique si l'onglet actif de la saisie rapide est "food". */
let _rstSrFoodActive = false;

/** Panier food de la saisie rapide : [{ id, nom, cat, prix, qty }] */
let rstFoodCart = [];

/**
 * Injecte les onglets Boissons / Plats dans le modal saisie rapide.
 * Appelé après chaque renderSrMenu().
 */
function rstInjectSrTabs() {
  if (!siteHasRestaurant()) return;
  const srMenu = document.getElementById("sr-menu");
  if (!srMenu) return;
  // Injecter les onglets une seule fois (vérification par présence)
  const already = document.getElementById("rst-sr-tabs");
  if (!already) {
    const tabsHtml = `
      <div id="rst-sr-tabs" class="rst-sr-tabs">
        <button type="button" class="rst-sr-tab${!_rstSrFoodActive ? " active" : ""}" onclick="rstSrSwitchTab('boissons')">🍺 Boissons</button>
        <button type="button" class="rst-sr-tab${_rstSrFoodActive ? " active" : ""}" onclick="rstSrSwitchTab('food')">🍽 Plats</button>
      </div>
      <div id="rst-sr-food-menu" style="${_rstSrFoodActive ? "" : "display:none"}"></div>`;
    srMenu.insertAdjacentHTML("beforebegin", tabsHtml);
  }
  // Synchroniser visibilité
  const tabs = document.getElementById("rst-sr-tabs");
  const foodMenu = document.getElementById("rst-sr-food-menu");
  if (tabs) {
    tabs.querySelectorAll(".rst-sr-tab").forEach((btn) => {
      btn.classList.toggle("active", btn.textContent.includes(_rstSrFoodActive ? "Plats" : "Boissons"));
    });
  }
  if (srMenu) srMenu.style.display = _rstSrFoodActive ? "none" : "";
  if (foodMenu) {
    foodMenu.style.display = _rstSrFoodActive ? "" : "none";
    if (_rstSrFoodActive) rstRenderFoodMenu();
  }
}

function rstSrSwitchTab(tab) {
  _rstSrFoodActive = (tab === "food");
  // Re-render sr-menu boissons via le hook existant
  if (typeof renderSrMenu === "function") {
    renderSrMenu(document.getElementById("sr-search")?.value || "");
  }
  // Mettre à jour le food menu si on passe sur food
  const foodMenu = document.getElementById("rst-sr-food-menu");
  const srMenu = document.getElementById("sr-menu");
  if (foodMenu) { foodMenu.style.display = _rstSrFoodActive ? "" : "none"; }
  if (srMenu)   { srMenu.style.display = _rstSrFoodActive ? "none" : ""; }
  if (_rstSrFoodActive) rstRenderFoodMenu();
  // Mettre à jour les onglets
  document.querySelectorAll(".rst-sr-tab").forEach((btn) => {
    btn.classList.toggle("active",
      (_rstSrFoodActive && btn.textContent.includes("Plats")) ||
      (!_rstSrFoodActive && btn.textContent.includes("Boissons"))
    );
  });
}

function rstRenderFoodMenu() {
  const container = document.getElementById("rst-sr-food-menu");
  if (!container) return;
  const query = (document.getElementById("sr-search")?.value || "").toLowerCase().trim();
  const items = rstMenuItems()
    .filter((p) => p.disponible !== false)
    .filter((p) => !query || p.nom.toLowerCase().includes(query) || (p.categorie || "").toLowerCase().includes(query));

  if (!items.length) {
    container.innerHTML = "<p style='text-align:center;padding:20px;color:#757575'>Aucun plat disponible.</p>";
    return;
  }

  const byCategory = {};
  items.forEach((item) => {
    const cat = item.categorie || "Autres";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(item);
  });

  let html = "";
  RST_CATEGORIES.concat(["Autres"]).forEach((cat) => {
    if (!byCategory[cat]?.length) return;
    html += `<div style='margin-bottom:14px'>
      <p style='font-size:0.7rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#9e9e9e;margin:0 0 6px 2px'>${escapeHtml(cat)}</p>`;
    byCategory[cat].forEach((item) => {
      const qty = (rstFoodCart.find((c) => c.id === item.id) || {}).qty || 0;
      const selected = qty > 0;
      html += `
        <div class="rst-sr-food-card${selected ? " selected" : ""}">
          <div style="flex:1;min-width:0;overflow:hidden">
            <p class="rst-sr-food-name">${escapeHtml(item.nom)}</p>
            <p class="rst-sr-food-meta">${fmt(item.prix || 0)} FCFA · ${escapeHtml(item.categorie || "")}</p>
          </div>
          <div class="rst-sr-food-qty-wrap">
            ${selected ? `<button type="button" onclick="rstFoodUpdateQty(${item.id},-1)" style="width:30px;height:30px;border-radius:50%;border:1px solid #bdbdbd;background:#fff;font-size:1.1rem;cursor:pointer;color:#212121">−</button>
            <span class="rst-food-qty-val">${qty}</span>` : ""}
            <button type="button" onclick="rstFoodUpdateQty(${item.id},1)" style="width:30px;height:30px;border-radius:50%;border:none;background:#7b1fa2;color:#fff;font-size:1.2rem;cursor:pointer;font-weight:700">+</button>
          </div>
        </div>`;
    });
    html += "</div>";
  });
  container.innerHTML = html;
}

function rstFoodUpdateQty(id, delta) {
  const item = rstMenuItems().find((p) => p.id === id);
  if (!item) return;
  const idx = rstFoodCart.findIndex((c) => c.id === id);
  const current = idx >= 0 ? rstFoodCart[idx].qty : 0;
  const next = Math.max(0, current + delta);
  if (next === 0 && idx >= 0) rstFoodCart.splice(idx, 1);
  else if (next > 0 && idx >= 0) rstFoodCart[idx].qty = next;
  else if (next > 0) rstFoodCart.push({ id, nom: item.nom, cat: item.categorie || "Plats", prix: item.prix || 0, qty: next });
  rstRenderFoodMenu();
  rstRenderFoodCartSummary();
}

/**
 * Affiche un résumé des plats dans le sr-cart existant.
 * Les items food sont ajoutés à la suite du panier boissons.
 */
function rstRenderFoodCartSummary() {
  const totalEl = document.getElementById("sr-total");
  if (!totalEl) return;
  // Recalcul total = boissons + food
  const boissonTotal = (typeof srCart !== "undefined" ? srCart : [])
    .reduce((s, c) => s + c.prix * c.qty, 0);
  const foodTotal = rstFoodCart.reduce((s, c) => s + c.prix * c.qty, 0);
  totalEl.textContent = `${fmt(boissonTotal + foodTotal)} FCFA`;
}

/**
 * Hook sur submitSaisieRapide : ajoute les lignes food au panier global srCart
 * sous forme d'items spéciaux { type: "food", ... } avant la soumission.
 * Puis nettoie rstFoodCart après succès.
 */
(function rstHookSubmitSaisieRapide() {
  const _origSubmit = window.submitSaisieRapide;
  if (typeof _origSubmit !== "function") {
    // submitSaisieRapide pas encore chargé — on patche au DOMContentLoaded
    document.addEventListener("DOMContentLoaded", rstHookSubmitSaisieRapide);
    return;
  }
  window.submitSaisieRapide = async function () {
    // Injecter les items food dans srCart avant soumission
    const foodInjected = [];
    rstFoodCart.forEach((fc) => {
      const fake = {
        article: fc.nom,
        cat: fc.cat,
        prix: fc.prix,
        packSize: 1,
        qty: fc.qty,
        location: document.getElementById("sr-location")?.value || "Intérieur",
        _isFood: true,  // marqueur interne
      };
      srCart.push(fake);
      foodInjected.push(fake);
    });

    try {
      await _origSubmit();
      // Succès : vider le panier food
      rstFoodCart = [];
      _rstSrFoodActive = false;
      // Supprimer les onglets food (seront re-injectés à la prochaine ouverture)
      document.getElementById("rst-sr-tabs")?.remove();
      document.getElementById("rst-sr-food-menu")?.remove();
    } catch (err) {
      // En cas d'erreur, retirer les items food injectés du srCart
      foodInjected.forEach((fi) => {
        const idx = srCart.indexOf(fi);
        if (idx >= 0) srCart.splice(idx, 1);
      });
      throw err;
    }
  };
})();

// Marquer les lignes food dans order.lignes après que submitSaisieRapide
// les ait créées. On patch via un hook sur persistState si nécessaire.
// NOTE: Les articles food sont distingués par findKnownProduct retournant null →
// app-orders.js les ignore avec errors.push(). On neutralise ce comportement
// en wrappant findKnownProduct pour les items _isFood.
(function rstPatchFindKnownProduct() {
  if (typeof findKnownProduct !== "function") return;
  const _orig = window.findKnownProduct;
  window.findKnownProduct = function (article) {
    const result = _orig(article);
    if (result) return result;
    // Chercher dans le menu restaurant (lignes food)
    const foodItem = (state?.restaurantMenu || []).find((p) => p.nom === article);
    if (foodItem) {
      // Retourner un objet compatible avec la structure stock attendue par submitSaisieRapide
      return {
        article: foodItem.nom,
        cat: foodItem.categorie || "Plats",
        prixInt: foodItem.prix,
        prixExt: foodItem.prix,
        prixVenteInt: foodItem.prix,
        prixVenteExt: foodItem.prix,
        formatsVente: [],
        _isFood: true,
        // pas de stock à vérifier
      };
    }
    return null;
  };
})();

// Neutraliser la vérification de stock pour les items food
(function rstPatchStockAvailability() {
  if (typeof stockAvailabilityForLine !== "function") return;
  const _orig = window.stockAvailabilityForLine;
  window.stockAvailabilityForLine = function (article, ...rest) {
    const foodItem = (state?.restaurantMenu || []).find((p) => p.nom === article);
    if (foodItem) {
      // Disponibilité illimitée pour les plats (pas de stock bouteilles)
      return { available: Infinity, stockItem: { article, _isFood: true } };
    }
    return _orig(article, ...rest);
  };
})();

// Marquer les lignes food dans order.lignes (type: "food")
(function rstPatchOrderLineCreation() {
  // On patch le listener sr-submit-btn pour marquer les lignes food après création
  document.addEventListener("click", function (e) {
    if (e.target && e.target.id === "sr-submit-btn") {
      // Mémoriser les noms food avant soumission
      window._rstPendingFoodNames = new Set(rstFoodCart.map((fc) => fc.nom));
    }
  }, true);
})();

// ── 8. DÉDUCTION STOCK INGRÉDIENTS ───────────────────────────

/**
 * Déduit les ingrédients du stock cuisine quand un plat est vendu.
 * Appelé après succès de submitSaisieRapide si des items food ont été soumis.
 * Non bloquant : les erreurs de déduction sont loguées mais n'empêchent pas la vente.
 */
async function rstDeductIngredients(foodItems) {
  if (!foodItems.length) return;
  if (!state?.ingredientStock?.length) return;

  let changed = false;
  foodItems.forEach(({ id, qty }) => {
    const plat = (state.restaurantMenu || []).find((p) => p.id === id);
    if (!plat?.ingredients?.length) return;
    plat.ingredients.forEach((ing) => {
      const ingrItem = (state.ingredientStock || []).find(
        (i) => i.nom.toLowerCase() === ing.nom.toLowerCase() && i.siteId === currentSiteId()
      );
      if (!ingrItem) return;
      ingrItem.quantite = Math.max(0, (ingrItem.quantite || 0) - (ing.quantite || 0) * qty);
      changed = true;
    });
  });

  if (changed) {
    try {
      await persistStatePatch({ ingredientStock: state.ingredientStock });
    } catch (err) {
      console.error("[restaurant-module] rstDeductIngredients:", err);
    }
  }
}

// ── 9. RAFRAÎCHISSEMENT AU CHANGEMENT D'ÉTAT ─────────────────

/**
 * Quand l'état global change (sync serveur), re-rendre les pages restaurant actives.
 * Appelé en wrappant la logique de sync existante.
 */
(function rstWatchStateChanges() {
  const _origMerge = window.mergeStateFromServerResponse;
  if (typeof _origMerge !== "function") return;
  window.mergeStateFromServerResponse = function (...args) {
    const result = _origMerge(...args);
    if (currentPage === "menu-cuisine") rstRenderMenuPage();
    if (currentPage === "stock-cuisine") rstRenderStockPage();
    return result;
  };
})();

// ── 10. INIT AU CHARGEMENT ───────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
  // Réinitialiser le panier food quand le modal saisie rapide se ferme
  document.addEventListener("click", function (e) {
    if (e.target?.dataset?.close === "modal-saisie-rapide" ||
        e.target?.classList?.contains("close-modal")) {
      rstFoodCart = [];
      _rstSrFoodActive = false;
      document.getElementById("rst-sr-tabs")?.remove();
      document.getElementById("rst-sr-food-menu")?.remove();
    }
  });

  // S'assurer que les clés restaurant existent dans l'état dès le premier chargement
  if (state && !state.restaurantMenu) state.restaurantMenu = [];
  if (state && !state.ingredientStock) state.ingredientStock = [];

  // Appliquer la visibilité initiale
  setTimeout(rstApplyVisibility, 100);
});
