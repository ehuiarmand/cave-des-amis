const API = {
  login: "/api/login",
  logout: "/api/logout",
  session: "/api/session",
  state: "/api/state",
  reset: "/api/reset",
};

const CATEGORIES = [
  "Bières",
  "Sodas & Jus",
  "Eaux",
  "Vins & Spiritueux",
  "Cocktails",
  "Snacks",
  "Autres",
];

const PAYMENT_METHODS = [
  "Espèces",
  "Orange Money",
  "MTN MoMo",
  "Wave",
  "Carte",
  "Crédit client",
];

const CHARGE_CATEGORIES = [
  "Loyer",
  "Salaires",
  "Électricité",
  "Eau",
  "Gaz / Charbon",
  "Achats boissons",
  "Achats snacks",
  "Téléphone",
  "Transport",
  "Entretien",
  "Impôts & taxes",
  "Autres",
];

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
let currentPage = "home";
let currentFilter = "all";
let sessionUser = null;
let csrfToken = null;

function fmt(number) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(number) || 0));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function isoDateToDdMmYyyy(iso) {
  const s = String(iso ?? "").trim().slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : (s || "—");
}

function formatDateDdMmYyyy(input) {
  if (input == null || input === "") return "—";
  const str = String(input).trim();
  const dOnly = str.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(dOnly)) return isoDateToDdMmYyyy(dOnly);
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return str || "—";
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
}

function formatVentesCountFr(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (n === 0) return "0 vente";
  if (n === 1) return "1 vente";
  return `${n} ventes`;
}

function calcNet(vente) {
  return (vente.prix * vente.qty) - vente.remise;
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
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (csrfToken && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers["X-CSRF-Token"] = csrfToken;
  }
  const response = await fetch(url, {
    credentials: "same-origin",
    headers,
    ...options,
  });

  const isJson = (response.headers.get("Content-Type") || "").includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function emptyState(title, message) {
  return `
    <div class="empty-state">
      <strong>${escapeHtml(title)}</strong>
      <p class="empty-copy">${escapeHtml(message)}</p>
    </div>
  `;
}

function populateSelect(id, values) {
  document.getElementById(id).innerHTML = values.map((value) => `<option>${escapeHtml(value)}</option>`).join("");
}

function setAuthVisible(isAuthenticated) {
  document.getElementById("auth-screen").classList.toggle("hidden", isAuthenticated);
  document.getElementById("app-shell").classList.toggle("hidden", !isAuthenticated);
}

function renderTopbar() {
  document.getElementById("top-bar-name").textContent = state?.params?.nom || "Mon Bar";
  document.getElementById("top-date").textContent = formatDateDdMmYyyy(new Date());
  document.getElementById("session-user").textContent = sessionUser || state?.auth?.username || "admin";
}

function renderHero() {
  const titles = {
    home: "Le cœur de votre bar, en temps réel.",
    ventes: "Chaque encaissement reste visible et actionnable.",
    stock: "Gardez les ruptures loin du comptoir.",
    charges: "Suivez les sorties d'argent sans perdre le rythme.",
    params: "Pilotez votre espace de travail et votre acces.",
  };
  const copies = {
    home: "Les données sont chargées depuis le serveur et protégées par une session active.",
    ventes: "Ajoutez une vente, filtrez par catégorie et gardez un historique propre.",
    stock: "Le stock est centralisé côté serveur, avec alertes visibles pour l'équipe.",
    charges: "Les dépenses sont enregistrées dans l'API pour éviter les pertes de données locales.",
    params: "Changez le profil du bar et les identifiants admin depuis un seul écran.",
  };
  document.getElementById("hero-title").textContent = titles[currentPage];
  document.getElementById("hero-copy").textContent = copies[currentPage];
}

function navigate(page) {
  currentPage = page;
  document.querySelectorAll(".page").forEach((node) => node.classList.remove("active"));
  document.getElementById(`page-${page}`).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.getElementById("fab-btn").classList.toggle("hidden", !["ventes", "stock", "charges"].includes(page));
  renderHero();
  if (page === "home") renderDashboard();
  if (page === "ventes") renderVentes(currentFilter);
  if (page === "stock") renderStock();
  if (page === "charges") renderCharges();
  if (page === "params") loadParamsForm();
}

function renderTabs() {
  const container = document.getElementById("ventes-tabs");
  const filters = [{ key: "all", label: "Toutes" }, ...CATEGORIES.map((cat) => ({ key: cat, label: cat }))];
  container.innerHTML = filters.map((filter) => `
    <button type="button" class="tab ${filter.key === currentFilter ? "active" : ""}" data-filter="${escapeHtml(filter.key)}">
      ${escapeHtml(filter.label)}
    </button>
  `).join("");
}

function renderBreakdown(targetId, collection, total, emptyMessage) {
  const entries = Object.entries(collection).sort((a, b) => b[1] - a[1]);
  const html = entries.length
    ? entries.map(([label, value]) => {
      const pct = total > 0 ? Math.round((value / total) * 100) : 0;
      const color = COLORS[label] || "#b5b5b5";
      return `
        <div class="cat-row">
          <span class="cat-dot" style="background:${color}"></span>
          <span>${escapeHtml(label)}</span>
          <span class="cat-bar"><span class="cat-fill" style="width:${pct}%;background:${color}"></span></span>
          <strong>${pct}%</strong>
        </div>
      `;
    }).join("")
    : `<div class="empty-state">${escapeHtml(emptyMessage)}</div>`;
  document.getElementById(targetId).innerHTML = html;
}

function renderPointDuJour() {
  const todayStr = today();
  const ventesJour = state.ventes.filter((v) => v.date.slice(0, 10) === todayStr);
  
  // Séparer les ventes encaissées des créances
  const ventesEncaissees = ventesJour.filter((v) => v.paiement !== "A regler");
  const ventesCreances = ventesJour.filter((v) => v.paiement === "A regler");
  
  const caJour = ventesEncaissees.reduce((sum, v) => sum + calcNet(v), 0);
  const creancesJour = ventesCreances.reduce((sum, v) => sum + calcNet(v), 0);
  const remisesJour = ventesJour.reduce((sum, v) => sum + (v.remise || 0), 0);

  document.getElementById("pdj-date").textContent = formatDateDdMmYyyy(new Date());
  document.getElementById("pdj-ca").textContent = `${fmt(caJour)} FCFA`;
  document.getElementById("pdj-creances").textContent = `${fmt(creancesJour)} FCFA`;
  document.getElementById("pdj-nb").textContent = String(ventesJour.length);
  document.getElementById("pdj-remises").textContent = `${fmt(remisesJour)} FCFA`;
  document.getElementById("pdj-ventes-count").textContent = formatVentesCountFr(ventesJour.length);

  // Regrouper les paiements encaissés : Espèces vs Mobile Money
  const paiementsRegroupes = ventesEncaissees.reduce((acc, v) => {
    let categorie = v.paiement;
    // Regrouper les services de mobile money
    if (categorie === "Orange Money" || categorie === "MTN MoMo") {
      categorie = "Mobile Money";
    }
    acc[categorie] = (acc[categorie] || 0) + calcNet(v);
    return acc;
  }, {});

  renderBreakdown(
    "pdj-pay-chart",
    paiementsRegroupes,
    caJour,
    "Aucune vente encaissee aujourd'hui.",
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
              <p class="list-item-amount">${fmt(calcNet(v))} FCFA</p>
              <p class="list-item-date">${v.factureNumber ? escapeHtml(v.factureNumber) : escapeHtml(formatDateDdMmYyyy(todayStr))}</p>
            </div>
          </div>
        </article>
      `).join("")
    : emptyState("Aucune vente aujourd'hui", "Les ventes du jour apparaissent ici des qu'elles sont enregistrees.");
}

function renderDashboard() {
  renderPointDuJour();
  const caTotal = state.ventes.reduce((sum, vente) => sum + calcNet(vente), 0);
  const chargesTotal = state.charges.reduce((sum, charge) => sum + charge.montant, 0);
  const benefice = caTotal - chargesTotal;
  const objectif = Number(state.params.objectifCA) || 0;
  const pct = objectif > 0 ? Math.min(100, Math.round((caTotal / objectif) * 100)) : 0;

  document.getElementById("kpi-ca").textContent = fmt(caTotal);
  document.getElementById("kpi-charges").textContent = fmt(chargesTotal);
  const beneficeNode = document.getElementById("kpi-benefice");
  beneficeNode.textContent = fmt(benefice);
  beneficeNode.className = `kpi-value ${benefice >= 0 ? "green" : "red"}`;
  document.getElementById("kpi-nb").textContent = String(state.ventes.length);
  document.getElementById("obj-pct").textContent = `${pct}%`;
  document.getElementById("obj-val").textContent = `/ ${fmt(objectif)} FCFA`;
  document.getElementById("obj-bar").style.width = `${pct}%`;

  renderBreakdown(
    "cat-chart",
    state.ventes.reduce((acc, vente) => {
      acc[vente.cat] = (acc[vente.cat] || 0) + calcNet(vente);
      return acc;
    }, {}),
    caTotal,
    "Aucune vente enregistree pour le moment.",
  );

  const alerts = state.stock.filter((item) => (item.init + item.entrees) <= item.seuilMin);
  document.getElementById("stock-alerts").innerHTML = alerts.length
    ? alerts.map((item) => `
        <article class="list-item">
          <div>
            <p class="list-item-title">${escapeHtml(item.article)}</p>
            <p class="list-item-sub">${escapeHtml(item.cat)}</p>
          </div>
          <div class="list-side">
            <div>
              <p class="list-item-amount" style="color:#ff8e82">${fmt(item.init + item.entrees)} unites</p>
              <p class="list-item-date">Seuil: ${fmt(item.seuilMin)}</p>
            </div>
          </div>
        </article>
      `).join("")
    : emptyState("Tout va bien", "Aucune alerte stock critique pour le moment.");

  renderBreakdown(
    "pay-chart",
    state.ventes.reduce((acc, vente) => {
      acc[vente.paiement] = (acc[vente.paiement] || 0) + calcNet(vente);
      return acc;
    }, {}),
    caTotal,
    "Aucun paiement disponible tant qu'aucune vente n'est enregistree.",
  );
}

function renderVentes(filter = "all") {
  currentFilter = filter;
  renderTabs();
  const articles = [...new Set(state.ventes.map((vente) => vente.article))];
  document.getElementById("articles-list").innerHTML = articles.map((article) => `<option value="${escapeHtml(article)}">`).join("");
  const ventes = (filter === "all" ? state.ventes : state.ventes.filter((vente) => vente.cat === filter))
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date));

  document.getElementById("ventes-list").innerHTML = ventes.length
    ? ventes.map((vente) => `
        <article class="list-item">
          <div>
            <p class="list-item-title">${escapeHtml(vente.article)}</p>
            <p class="list-item-sub">${escapeHtml(vente.cat)} · ${fmt(vente.qty)} x ${fmt(vente.prix)} FCFA${vente.remise ? ` · -${fmt(vente.remise)}` : ""} · ${escapeHtml(vente.paiement)}</p>
          </div>
          <div class="list-side">
            <div>
              <p class="list-item-amount">${fmt(calcNet(vente))} FCFA</p>
              <p class="list-item-date">${escapeHtml(formatDateDdMmYyyy(vente.date))}</p>
            </div>
            <button class="del-btn" type="button" data-delete-type="vente" data-id="${vente.id}">Suppr.</button>
          </div>
        </article>
      `).join("")
    : emptyState("Aucune vente", "Ajoutez une vente pour alimenter l'historique.");
}

function renderStock() {
  let totalValue = 0;
  const items = state.stock.slice().sort((a, b) => a.article.localeCompare(b.article, "fr"));
  const html = items.map((item) => {
    const actuel = item.init + item.entrees;
    const valeur = actuel * (item.prixAchat || 0);
    totalValue += valeur;
    let badgeClass = "badge-green";
    let status = "OK";
    if (actuel <= 0) {
      badgeClass = "badge-red";
      status = "RUPTURE";
    } else if (actuel <= item.seuilMin) {
      badgeClass = "badge-red";
      status = "CRITIQUE";
    } else if (actuel <= item.seuilMin * 2) {
      badgeClass = "badge-amber";
      status = "FAIBLE";
    }
    return `
      <article class="list-item">
        <div>
          <p class="list-item-title">${escapeHtml(item.article)}</p>
          <p class="list-item-sub">${escapeHtml(item.cat)} · Seuil: ${fmt(item.seuilMin)} · Achat: ${fmt(item.prixAchat)} FCFA</p>
          <span class="badge ${badgeClass}">${status}</span>
        </div>
        <div class="list-side">
          <div>
            <p class="list-item-amount">${fmt(actuel)} unites</p>
            <p class="list-item-date">${fmt(valeur)} FCFA</p>
          </div>
          <button class="del-btn" type="button" data-delete-type="stock" data-id="${item.id}">Suppr.</button>
        </div>
      </article>
    `;
  }).join("");

  document.getElementById("stock-nb").textContent = String(state.stock.length);
  document.getElementById("stock-val").textContent = fmt(totalValue);
  document.getElementById("stock-list").innerHTML = html || emptyState("Stock vide", "Ajoutez un article pour suivre vos unites disponibles.");
}

function renderCharges() {
  const total = state.charges.reduce((sum, charge) => sum + charge.montant, 0);
  document.getElementById("charges-total").textContent = `${fmt(total)} FCFA`;
  const charges = state.charges.slice().sort((a, b) => b.date.localeCompare(a.date));
  document.getElementById("charges-list").innerHTML = charges.length
    ? charges.map((charge) => `
        <article class="list-item">
          <div>
            <p class="list-item-title">${escapeHtml(charge.lib)}</p>
            <p class="list-item-sub">${escapeHtml(charge.cat)} · ${escapeHtml(charge.paiement)}</p>
          </div>
          <div class="list-side">
            <div>
              <p class="list-item-amount" style="color:#ff8e82">${fmt(charge.montant)} FCFA</p>
              <p class="list-item-date">${escapeHtml(charge.date)}</p>
            </div>
            <button class="del-btn" type="button" data-delete-type="charge" data-id="${charge.id}">Suppr.</button>
          </div>
        </article>
      `).join("")
    : emptyState("Aucune charge", "Ajoutez une depense pour suivre les sorties du mois.");
}

function loadParamsForm() {
  document.getElementById("p-nom").value = state.params.nom || "";
  document.getElementById("p-ville").value = state.params.ville || "";
  document.getElementById("p-pays").value = state.params.pays || "";
  document.getElementById("p-gerant").value = state.params.gerant || "";
  document.getElementById("p-obj").value = state.params.objectifCA || 500000;
  document.getElementById("p-seuil").value = state.params.seuilStock || 5;
  document.getElementById("p-user").value = state.auth.username || "admin";
  document.getElementById("p-pass").value = "";
}

async function persistState(overrides = {}) {
  const payload = {
    params: overrides.params || state.params,
    ventes: overrides.ventes || state.ventes,
    stock: overrides.stock || state.stock,
    charges: overrides.charges || state.charges,
    nextId: overrides.nextId || state.nextId,
    auth: overrides.auth || { username: state.auth.username },
  };
  state = await apiRequest(API.state, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  renderTopbar();
}

async function saveParams() {
  const newParams = {
    nom: document.getElementById("p-nom").value.trim() || "Mon Bar",
    ville: document.getElementById("p-ville").value.trim(),
    pays: document.getElementById("p-pays").value.trim(),
    gerant: document.getElementById("p-gerant").value.trim(),
    objectifCA: Number(document.getElementById("p-obj").value) || 500000,
    seuilStock: Number(document.getElementById("p-seuil").value) || 5,
  };
  const username = document.getElementById("p-user").value.trim() || "admin";
  const password = document.getElementById("p-pass").value;
  await persistState({
    params: newParams,
    auth: {
      username,
      password,
    },
  });
  sessionUser = username;
  renderTopbar();
  renderHero();
  showToast("Paramètres sauvegardés.");
}

function exportData() {
  const payload = {
    params: state.params,
    ventes: state.ventes,
    stock: state.stock,
    charges: state.charges,
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `maquis_manager_${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function addVente() {
  const vente = {
    id: state.nextId.vente++,
    date: document.getElementById("v-date").value || today(),
    article: document.getElementById("v-article").value.trim(),
    cat: document.getElementById("v-cat").value,
    prix: Number(document.getElementById("v-prix").value) || 0,
    qty: Number(document.getElementById("v-qty").value) || 1,
    remise: Number(document.getElementById("v-remise").value) || 0,
    paiement: document.getElementById("v-pay").value,
  };
  if (!vente.article || vente.prix <= 0) {
    showToast("Article et prix obligatoires.");
    return;
  }
  state.ventes.unshift(vente);
  await persistState();
  closeModal("modal-vente");
  clearVenteForm();
  renderDashboard();
  renderVentes(currentFilter);
  showToast("Vente enregistree.");
}

async function addStock() {
  const article = {
    id: state.nextId.stock++,
    article: document.getElementById("s-article").value.trim(),
    cat: document.getElementById("s-cat").value,
    init: Number(document.getElementById("s-init").value) || 0,
    entrees: Number(document.getElementById("s-entrees").value) || 0,
    seuilMin: Number(document.getElementById("s-seuil").value) || 5,
    prixAchat: Number(document.getElementById("s-prix").value) || 0,
  };
  if (!article.article) {
    showToast("Nom de l'article obligatoire.");
    return;
  }
  state.stock.push(article);
  await persistState();
  closeModal("modal-stock");
  clearStockForm();
  renderDashboard();
  renderStock();
  showToast("Article de stock ajoute.");
}

async function addCharge() {
  const charge = {
    id: state.nextId.charge++,
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
  await persistState();
  closeModal("modal-charge");
  clearChargeForm();
  renderDashboard();
  renderCharges();
  showToast("Depense enregistree.");
}

function clearVenteForm() {
  document.getElementById("v-date").value = today();
  document.getElementById("v-article").value = "";
  document.getElementById("v-prix").value = "";
  document.getElementById("v-qty").value = "1";
  document.getElementById("v-remise").value = "0";
  updateVentePreview();
}

function clearStockForm() {
  document.getElementById("s-article").value = "";
  document.getElementById("s-init").value = "0";
  document.getElementById("s-entrees").value = "0";
  document.getElementById("s-seuil").value = "5";
  document.getElementById("s-prix").value = "";
}

function clearChargeForm() {
  document.getElementById("c-date").value = today();
  document.getElementById("c-lib").value = "";
  document.getElementById("c-montant").value = "";
}

function updateVentePreview() {
  const prix = Number(document.getElementById("v-prix").value) || 0;
  const qty = Number(document.getElementById("v-qty").value) || 0;
  const remise = Number(document.getElementById("v-remise").value) || 0;
  document.getElementById("v-preview").textContent = `${fmt((prix * qty) - remise)} FCFA`;
}

function openModal(id) {
  document.getElementById(id).classList.add("open");
}

function closeModal(id) {
  document.getElementById(id).classList.remove("open");
}

function openFab() {
  if (currentPage === "ventes") {
    document.getElementById("v-date").value = today();
    updateVentePreview();
    openModal("modal-vente");
  }
  if (currentPage === "stock") {
    openModal("modal-stock");
  }
  if (currentPage === "charges") {
    document.getElementById("c-date").value = today();
    openModal("modal-charge");
  }
}

async function deleteRecord(type, id) {
  if (type === "vente") {
    state.ventes = state.ventes.filter((item) => item.id !== id);
    renderVentes(currentFilter);
  }
  if (type === "stock") {
    state.stock = state.stock.filter((item) => item.id !== id);
    renderStock();
  }
  if (type === "charge") {
    state.charges = state.charges.filter((item) => item.id !== id);
    renderCharges();
  }
  await persistState();
  renderDashboard();
  showToast("Element supprime.");
}

async function handleLoginSubmit(event) {
  event.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errorNode = document.getElementById("login-error");
  try {
    const payload = await apiRequest(API.login, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    sessionUser = payload.username;
    if (typeof payload.csrfToken === "string" && payload.csrfToken.trim()) {
      csrfToken = payload.csrfToken.trim();
    }
    errorNode.textContent = "";
    setAuthVisible(true);
    await bootstrapAuthenticatedApp();
    showToast("Connexion réussie.");
  } catch (error) {
    errorNode.textContent = error.message;
  }
}

async function logout() {
  let portalUrl = "http://localhost:9000";
  try {
    const data = await apiRequest(API.logout, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (data && data.portalUrl) portalUrl = data.portalUrl;
  } catch (error) {
    console.error(error);
  }
  sessionUser = null;
  csrfToken = null;
  state = null;
  window.location.href = portalUrl;
}

async function bootstrapAuthenticatedApp() {
  state = await apiRequest(API.state);
  populateSelect("v-cat", CATEGORIES);
  populateSelect("v-pay", PAYMENT_METHODS);
  populateSelect("c-cat", CHARGE_CATEGORIES);
  populateSelect("c-pay", PAYMENT_METHODS);
  populateSelect("s-cat", CATEGORIES);
  renderTopbar();
  renderHero();
  renderDashboard();
  renderVentes(currentFilter);
  renderStock();
  renderCharges();
  loadParamsForm();
  document.getElementById("v-date").value = today();
  document.getElementById("c-date").value = today();
  updateVentePreview();
  navigate(currentPage);
}

function attachEvents() {
  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("fab-btn").addEventListener("click", openFab);
  document.getElementById("save-vente-btn").addEventListener("click", () => addVente().catch(handleApiError));
  document.getElementById("save-stock-btn").addEventListener("click", () => addStock().catch(handleApiError));
  document.getElementById("save-charge-btn").addEventListener("click", () => addCharge().catch(handleApiError));
  document.getElementById("save-params-btn").addEventListener("click", () => saveParams().catch(handleApiError));
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("reset-btn").addEventListener("click", async () => {
    if (!window.confirm("Reinitialiser toutes les donnees de l'application ?")) {
      return;
    }
    try {
      state = await apiRequest(API.reset, {
        method: "POST",
        body: JSON.stringify({}),
      });
      renderTopbar();
      renderDashboard();
      renderVentes("all");
      renderStock();
      renderCharges();
      loadParamsForm();
      currentFilter = "all";
      navigate("home");
      showToast("Application reinitialisee.");
    } catch (error) {
      handleApiError(error);
    }
  });

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.addEventListener("click", () => navigate(button.dataset.page));
  });

  document.getElementById("ventes-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-filter]");
    if (!button) return;
    renderVentes(button.dataset.filter);
  });

  document.body.addEventListener("click", (event) => {
    const closeButton = event.target.closest(".close-modal");
    if (closeButton) {
      closeModal(closeButton.dataset.close);
      return;
    }

    const deleteButton = event.target.closest("[data-delete-type]");
    if (deleteButton) {
      const type = deleteButton.dataset.deleteType;
      const id = Number(deleteButton.dataset.id);
      const labels = { vente: "cette vente", stock: "cet article", charge: "cette depense" };
      if (window.confirm(`Supprimer ${labels[type]} ?`)) {
        deleteRecord(type, id).catch(handleApiError);
      }
    }
  });

  document.querySelectorAll(".modal-overlay").forEach((overlay) => {
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        overlay.classList.remove("open");
      }
    });
  });

  ["v-prix", "v-qty", "v-remise"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateVentePreview);
  });
}

function handleApiError(error) {
  console.error(error);
  if (error?.status === 401) {
    logout();
    return;
  }
  showToast(error?.message || "Une erreur est survenue.");
}

async function init() {
  attachEvents();
  setAuthVisible(false);
  try {
    const session = await apiRequest(API.session);
    sessionUser = session.username;
    if (typeof session.csrfToken === "string" && session.csrfToken.trim()) {
      csrfToken = session.csrfToken.trim();
    }
    setAuthVisible(true);
    await bootstrapAuthenticatedApp();
  } catch (error) {
    setAuthVisible(false);
  }
}

init();
