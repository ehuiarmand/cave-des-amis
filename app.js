const STORAGE_KEY = "tdb_bar_app_v2";

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
  Snacks: "#7adbb2",
  Autres: "#b5b5b5",
  "Espèces": "#1976d2",
  "Orange Money": "#ff9d57",
  "MTN MoMo": "#ffe16d",
  Wave: "#69d6ff",
  Carte: "#a68bff",
  "Crédit client": "#ff8e82",
};

function createDefaultState() {
  return {
    auth: {
      username: "admin",
      password: "admin123",
      sessionUser: null,
    },
    params: {
      nom: "Mon Bar Chez Moi",
      ville: "Douala",
      pays: "Cameroun",
      gerant: "",
      objectifCA: 500000,
      seuilStock: 5,
    },
    ventes: [
      { id: 1, date: "2026-04-21", article: "Castel Beer 65cl", cat: "Bières", prix: 700, qty: 10, remise: 0, paiement: "Espèces" },
      { id: 2, date: "2026-04-22", article: "Coca-Cola 33cl", cat: "Sodas & Jus", prix: 350, qty: 8, remise: 0, paiement: "Orange Money" },
      { id: 3, date: "2026-04-22", article: "Eau Minérale 1.5L", cat: "Eaux", prix: 200, qty: 5, remise: 200, paiement: "Espèces" },
      { id: 4, date: "2026-04-23", article: "Heineken 33cl", cat: "Bières", prix: 600, qty: 15, remise: 0, paiement: "MTN MoMo" },
      { id: 5, date: "2026-04-23", article: "Jus d'Ananas 50cl", cat: "Sodas & Jus", prix: 300, qty: 6, remise: 0, paiement: "Wave" },
      { id: 6, date: "2026-04-24", article: "Whisky J&B 5cl", cat: "Vins & Spiritueux", prix: 1500, qty: 3, remise: 0, paiement: "Espèces" },
      { id: 7, date: "2026-04-24", article: "Cacahuètes sachet", cat: "Snacks", prix: 150, qty: 12, remise: 300, paiement: "Espèces" },
      { id: 8, date: "2026-04-25", article: "Fanta Orange 33cl", cat: "Sodas & Jus", prix: 300, qty: 9, remise: 0, paiement: "Wave" },
      { id: 9, date: "2026-04-26", article: "Vin Rouge 15cl", cat: "Vins & Spiritueux", prix: 800, qty: 2, remise: 0, paiement: "Espèces" },
      { id: 10, date: "2026-04-26", article: "33 Export", cat: "Bières", prix: 600, qty: 8, remise: 0, paiement: "MTN MoMo" },
    ],
    stock: [
      { id: 1, article: "Castel Beer 65cl", cat: "Bières", init: 100, entrees: 50, seuilMin: 5, prixAchat: 700 },
      { id: 2, article: "Heineken 33cl", cat: "Bières", init: 60, entrees: 20, seuilMin: 5, prixAchat: 600 },
      { id: 3, article: "Coca-Cola 33cl", cat: "Sodas & Jus", init: 80, entrees: 30, seuilMin: 5, prixAchat: 200 },
      { id: 4, article: "Fanta Orange 33cl", cat: "Sodas & Jus", init: 60, entrees: 20, seuilMin: 5, prixAchat: 180 },
      { id: 5, article: "Eau Minérale 1.5L", cat: "Eaux", init: 120, entrees: 48, seuilMin: 5, prixAchat: 150 },
      { id: 6, article: "Whisky J&B 70cl", cat: "Vins & Spiritueux", init: 12, entrees: 0, seuilMin: 3, prixAchat: 8000 },
      { id: 7, article: "Vin Rouge 75cl", cat: "Vins & Spiritueux", init: 24, entrees: 6, seuilMin: 3, prixAchat: 3500 },
      { id: 8, article: "Cacahuètes sachet", cat: "Snacks", init: 200, entrees: 100, seuilMin: 10, prixAchat: 80 },
    ],
    charges: [
      { id: 1, date: "2026-04-21", lib: "Loyer mensuel", cat: "Loyer", montant: 150000, paiement: "Espèces" },
      { id: 2, date: "2026-04-21", lib: "Salaire barman", cat: "Salaires", montant: 80000, paiement: "Orange Money" },
      { id: 3, date: "2026-04-22", lib: "Facture ENEO/SENELEC", cat: "Électricité", montant: 35000, paiement: "Orange Money" },
      { id: 4, date: "2026-04-23", lib: "Achat boissons", cat: "Achats boissons", montant: 52500, paiement: "Espèces" },
      { id: 5, date: "2026-04-25", lib: "Entretien & nettoyage", cat: "Entretien", montant: 8000, paiement: "Wave" },
    ],
    nextId: {
      vente: 100,
      stock: 100,
      charge: 100,
    },
  };
}

let state = loadState();
let currentPage = "home";
let currentFilter = "all";

function loadState() {
  const fallback = createDefaultState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      auth: { ...fallback.auth, ...(parsed.auth || {}) },
      params: { ...fallback.params, ...(parsed.params || {}) },
      nextId: { ...fallback.nextId, ...(parsed.nextId || {}) },
      ventes: Array.isArray(parsed.ventes) ? parsed.ventes : fallback.ventes,
      stock: Array.isArray(parsed.stock) ? parsed.stock : fallback.stock,
      charges: Array.isArray(parsed.charges) ? parsed.charges : fallback.charges,
    };
  } catch (error) {
    return fallback;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function resetState() {
  state = createDefaultState();
  saveState();
}

function fmt(number) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(number) || 0));
}

function today() {
  return new Date().toISOString().slice(0, 10);
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

function renderAuthState() {
  const authScreen = document.getElementById("auth-screen");
  const appShell = document.getElementById("app-shell");
  if (state.auth.sessionUser) {
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");
    document.getElementById("session-user").textContent = state.auth.sessionUser;
  } else {
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");
    document.getElementById("login-username").value = state.auth.username || "";
    document.getElementById("login-password").value = "";
  }
}

function renderTopbar() {
  document.getElementById("top-bar-name").textContent = state.params.nom || "Mon Bar";
  document.getElementById("top-date").textContent = new Date().toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function renderHero() {
  const titles = {
    home: "Le coeur de votre bar, en temps reel.",
    ventes: "Chaque encaissement reste visible et actionnable.",
    stock: "Gardez les ruptures loin du comptoir.",
    charges: "Suivez les sorties d'argent sans perdre le rythme.",
    params: "Pilotez votre espace de travail et votre acces.",
  };
  const copies = {
    home: "Suivez les ventes, le stock et les charges sur une seule interface.",
    ventes: "Filtrez vite par categorie, ajoutez une vente et gardez un historique lisible.",
    stock: "Les niveaux critiques ressortent vite pour vous aider a reapprovisionner a temps.",
    charges: "Visualisez les depenses du mois et supprimez les erreurs en un clic.",
    params: "Modifiez le profil du bar, l'objectif mensuel et les identifiants administrateur.",
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
  const fab = document.getElementById("fab-btn");
  fab.classList.toggle("hidden", !["ventes", "stock", "charges"].includes(page));
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

function renderDashboard() {
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
  const alertsMarkup = alerts.length
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
  document.getElementById("stock-alerts").innerHTML = alertsMarkup;

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

  if (!ventes.length) {
    document.getElementById("ventes-list").innerHTML = emptyState("Aucune vente", "Ajoutez une vente pour alimenter l'historique.");
    return;
  }

  document.getElementById("ventes-list").innerHTML = ventes.map((vente) => `
    <article class="list-item">
      <div>
        <p class="list-item-title">${escapeHtml(vente.article)}</p>
        <p class="list-item-sub">
          ${escapeHtml(vente.cat)} · ${fmt(vente.qty)} x ${fmt(vente.prix)} FCFA${vente.remise ? ` · -${fmt(vente.remise)}` : ""} · ${escapeHtml(vente.paiement)}
        </p>
      </div>
      <div class="list-side">
        <div>
          <p class="list-item-amount">${fmt(calcNet(vente))} FCFA</p>
          <p class="list-item-date">${escapeHtml(vente.date)}</p>
        </div>
        <button class="del-btn" type="button" data-delete-type="vente" data-id="${vente.id}">Suppr.</button>
      </div>
    </article>
  `).join("");
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
  const html = charges.map((charge) => `
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
  `).join("");
  document.getElementById("charges-list").innerHTML = html || emptyState("Aucune charge", "Ajoutez une depense pour suivre les sorties du mois.");
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

function saveParams() {
  state.params.nom = document.getElementById("p-nom").value.trim() || "Mon Bar";
  state.params.ville = document.getElementById("p-ville").value.trim();
  state.params.pays = document.getElementById("p-pays").value.trim();
  state.params.gerant = document.getElementById("p-gerant").value.trim();
  state.params.objectifCA = Number(document.getElementById("p-obj").value) || 500000;
  state.params.seuilStock = Number(document.getElementById("p-seuil").value) || 5;
  state.auth.username = document.getElementById("p-user").value.trim() || "admin";
  const newPassword = document.getElementById("p-pass").value;
  if (newPassword.trim()) {
    state.auth.password = newPassword;
  }
  if (state.auth.sessionUser) {
    state.auth.sessionUser = state.auth.username;
  }
  saveState();
  renderTopbar();
  renderAuthState();
  renderHero();
  showToast("Parametres sauvegardes.");
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
  link.download = `tdb_bar_${today()}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function addVente() {
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
  saveState();
  closeModal("modal-vente");
  clearVenteForm();
  renderDashboard();
  renderVentes(currentFilter);
  showToast("Vente enregistree.");
}

function addStock() {
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
  saveState();
  closeModal("modal-stock");
  clearStockForm();
  renderDashboard();
  renderStock();
  showToast("Article de stock ajoute.");
}

function addCharge() {
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
  saveState();
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

function deleteRecord(type, id) {
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
  saveState();
  renderDashboard();
  showToast("Element supprime.");
}

function handleLoginSubmit(event) {
  event.preventDefault();
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;
  const errorNode = document.getElementById("login-error");
  if (username === state.auth.username && password === state.auth.password) {
    state.auth.sessionUser = username;
    saveState();
    errorNode.textContent = "";
    renderAuthState();
    renderApp();
    showToast("Connexion reussie.");
    return;
  }
  errorNode.textContent = "Identifiants invalides. Verifiez le nom d'utilisateur et le mot de passe.";
}

function logout() {
  state.auth.sessionUser = null;
  saveState();
  renderAuthState();
  showToast("Session fermee.");
}

function attachEvents() {
  document.getElementById("login-form").addEventListener("submit", handleLoginSubmit);
  document.getElementById("logout-btn").addEventListener("click", logout);
  document.getElementById("fab-btn").addEventListener("click", openFab);
  document.getElementById("save-vente-btn").addEventListener("click", addVente);
  document.getElementById("save-stock-btn").addEventListener("click", addStock);
  document.getElementById("save-charge-btn").addEventListener("click", addCharge);
  document.getElementById("save-params-btn").addEventListener("click", saveParams);
  document.getElementById("export-btn").addEventListener("click", exportData);
  document.getElementById("reset-btn").addEventListener("click", () => {
    if (!window.confirm("Reinitialiser toutes les donnees de l'application ?")) {
      return;
    }
    resetState();
    renderAuthState();
    renderApp();
    showToast("Application reinitialisee.");
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
        deleteRecord(type, id);
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

function renderApp() {
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

function init() {
  attachEvents();
  renderAuthState();
  renderApp();
}

init();
