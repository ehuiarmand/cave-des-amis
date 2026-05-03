const customerState = {
  siteId: null,
  site: null,
  menu: [],
  cart: [],
  sentOrders: [],
  totalDue: 0,
  totalPaid: 0,
  table: "",
  alias: "",
  location: "Intérieur",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmt(value) {
  return new Intl.NumberFormat("fr-FR").format(Math.round(Number(value) || 0));
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

async function customerApi(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const contentType = response.headers.get("Content-Type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (!payload) {
    const text = await response.text().catch(() => "");
    if (text.trim().startsWith("<!DOCTYPE") || text.trim().startsWith("<html")) {
      throw new Error("Le serveur renvoie une page au lieu d'une reponse API. Rechargez la page ou redeployez la derniere mise a jour.");
    }
    throw new Error(`Reponse serveur invalide (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

function getParams() {
  const params = new URLSearchParams(window.location.search);
  customerState.siteId = params.get("site") || "";
  customerState.table = params.get("table") || "";
  customerState.alias = params.get("alias") || "";
  customerState.location = params.get("location") || "Intérieur";
}

function clientStorageKey() {
  // Prefer a per-site key so the client's name follows them across scans/tables.
  // (Older versions used a per-table key; we keep it as fallback in loadSavedClientName.)
  return `tdb_client_${customerState.siteId}`;
}

function loadSavedClientName() {
  try {
    const direct = localStorage.getItem(clientStorageKey()) || "";
    if (direct) return direct;
    // Backward compatibility: try per-table key used previously.
    const t = customerState.table || customerState.alias || "Comptoir";
    return localStorage.getItem(`tdb_client_${customerState.siteId}_${t}`) || "";
  } catch {
    return "";
  }
}

function saveClientName(name) {
  if (!name) return;
  try { localStorage.setItem(clientStorageKey(), name); } catch {}
}

function clearSavedClientName() {
  try { localStorage.removeItem(clientStorageKey()); } catch {}
}

function applySavedNameUI() {
  const nameInput = document.getElementById("customer-name");
  const btn = document.getElementById("change-saved-name-btn");
  const hint = document.getElementById("saved-name-hint");
  if (!nameInput || !btn || !hint) return;

  const saved = loadSavedClientName();
  if (saved) {
    if (!nameInput.value) nameInput.value = saved;
    // Keep the field editable while the user is actively editing.
    // We only lock it when it isn't focused (prevents "1 letter then locked" bug).
    nameInput.readOnly = document.activeElement !== nameInput;
    btn.classList.remove("hidden");
    hint.classList.remove("hidden");
  } else {
    nameInput.readOnly = false;
    btn.classList.add("hidden");
    hint.classList.add("hidden");
  }
}

function menuKey(item) {
  return item.key || `${item.article}::${item.packSize || 1}`;
}

function articleKeyFromMenuItem(item) {
  return String(item?.article || "").trim().toLowerCase();
}

function maxQtyForMenuKey(menuItem, excludeKey = null) {
  const packSize = Math.max(1, Number(menuItem.packSize || menuItem.formatQuantite || 1));
  const bottlesAvail = Math.max(0, Number(menuItem.availableBottles ?? menuItem.available ?? Number.MAX_SAFE_INTEGER));
  const articleKey = articleKeyFromMenuItem(menuItem);
  const usedElsewhere = customerState.cart.reduce((sum, line) => {
    if (!line || line.key === excludeKey) return sum;
    if (articleKeyFromMenuItem(line) !== articleKey) return sum;
    const ps = Math.max(1, Number(line.packSize || 1));
    return sum + (Number(line.qty) || 0) * ps;
  }, 0);
  const remaining = Math.max(0, bottlesAvail - usedElsewhere);
  return Math.floor(remaining / packSize);
}

function cartQty(key) {
  return (customerState.cart.find((c) => c.key === key) || {}).qty || 0;
}

/** Filtre menu QR (nom + categorie, plusieurs mots). */
function menuItemsFilteredForSearch() {
  const searchEl = document.getElementById("qr-menu-search");
  const q = searchEl ? String(searchEl.value || "").trim().toLowerCase() : "";
  const items = customerState.menu || [];
  if (!q) return items;
  const terms = q.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const a = String(item.article || "").toLowerCase();
    const c = String(item.cat || "").toLowerCase();
    return terms.every((t) => a.includes(t) || c.includes(t));
  });
}

function renderMenu() {
  const container = document.getElementById("customer-menu");
  if (!customerState.menu.length) {
    container.innerHTML = `<div class="empty-state"><strong>Menu vide</strong><p class="empty-copy">Aucun article disponible pour ce maquis.</p></div>`;
    return;
  }

  const filtered = menuItemsFilteredForSearch();
  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><strong>Aucun resultat</strong><p class="empty-copy">Modifiez votre recherche ou effacez le champ pour afficher tout le menu.</p></div>`;
    return;
  }

  const byCategory = {};
  filtered.forEach((item) => {
    if (!byCategory[item.cat]) byCategory[item.cat] = [];
    byCategory[item.cat].push(item);
  });

  container.innerHTML = Object.entries(byCategory).map(([cat, items]) => `
    <div class="menu-category">
      <p class="menu-cat-label">${escapeHtml(cat)}</p>
      ${items.map((item) => {
        const key = menuKey(item);
        const qty = cartQty(key);
        const packLabel = item.packSize > 1 ? `<span class="menu-pack-tag">Kit de ${item.packSize}</span>` : "";
        return `
          <article class="menu-item">
            <div class="menu-item-info">
              <p class="list-item-title">${escapeHtml(item.article)}</p>
              <p class="list-item-sub">${fmt(item.prix)} FCFA${item.packSize > 1 ? ` / kit de ${item.packSize} bouteilles` : ""}</p>
              ${packLabel}
            </div>
            <div class="menu-qty-ctrl">
              <button type="button" class="qty-btn" data-dec-menu="${escapeHtml(key)}">−</button>
              <input type="number" class="qty-input" min="0" value="${qty}" data-menu-key="${escapeHtml(key)}">
              <button type="button" class="qty-btn" data-inc-menu="${escapeHtml(key)}">+</button>
            </div>
          </article>`;
      }).join("")}
    </div>
  `).join("");
}

function renderCart() {
  const container = document.getElementById("customer-cart");
  const total = customerState.cart.reduce((sum, item) => sum + (item.prix * item.qty), 0);
  document.getElementById("customer-total").textContent = `${fmt(total)} FCFA`;
  if (!customerState.cart.length) {
    container.innerHTML = `<p class="muted" style="text-align:center;padding:12px 0">Aucun article sélectionné.</p>`;
  }
  if (!customerState.cart.length) return;
  container.innerHTML = customerState.cart.map((item) => {
    const packInfo = item.packSize > 1 ? ` (kit de ${item.packSize})` : "";
    return `<div class="cart-line">
      <span>${escapeHtml(item.article)}${packInfo}</span>
      <span>${item.qty} × ${fmt(item.prix)} FCFA = <strong>${fmt(item.qty * item.prix)} FCFA</strong></span>
    </div>`;
  }).join("");
}

function renderSentOrders() {
  const container = document.getElementById("customer-sent-orders");
  if (!container) return;
  if (!customerState.sentOrders.length) {
    container.innerHTML = "";
    return;
  }
  const totalDue = customerState.totalDue || 0;
  const totalPaid = customerState.totalPaid || 0;
  const hasDue = totalDue > 0;
  const hasPaid = totalPaid > 0;
  let summaryHtml = `<div class="inline-card" style="margin:12px 0;flex-direction:column;gap:6px;align-items:flex-start">
    <p class="eyebrow" style="margin:0">Votre facture — ${escapeHtml(customerState.table || customerState.alias || "Comptoir")}</p>
    ${hasDue ? `<div style="display:flex;justify-content:space-between;width:100%"><span class="muted">A regler</span><strong style="color:#1976d2">${fmt(totalDue)} FCFA</strong></div>` : ""}
    ${hasPaid ? `<div style="display:flex;justify-content:space-between;width:100%"><span class="muted">Deja regle</span><strong style="color:#72d7a9">${fmt(totalPaid)} FCFA</strong></div>` : ""}
    ${!hasDue ? `<strong style="color:#72d7a9">✓ Facture entierement reglee</strong>` : ""}
  </div>`;
  let orderIndex = 0;
  const ordersHtml = customerState.sentOrders.map((order, idx) => {
    if (!order.paid) orderIndex++;
    const label = order.paid ? `Facture reglee — ${escapeHtml(formatDateDdMmYyyy(order.date))}` : `Commande ${orderIndex} — ${escapeHtml(formatDateDdMmYyyy(order.date))}`;
    const detailId = `order-detail-${idx}`;
    const lines = (order.lignes || []).map((line) => {
      const packInfo = Number(line.formatQuantite || 1) > 1 ? ` · kit de ${fmt(line.formatQuantite)}` : "";
      const lineTotal = (Number(line.prix) || 0) * (Number(line.qty) || 0) - (Number(line.remise) || 0);
      return `<div class="customer-order-line"><span>${fmt(line.qty)} x ${escapeHtml(line.article)}${packInfo}</span><strong>${fmt(lineTotal)} FCFA</strong></div>`;
    }).join("");
    return `<article class="list-item" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div>
          <p class="list-item-title">${label}</p>
          <p class="list-item-sub">${fmt(order.items)} article(s) · ${fmt(order.total)} FCFA · Statut : ${escapeHtml(order.status)}</p>
        </div>
        <span class="badge ${order.paid ? "badge-green" : "badge-amber"}">${order.paid ? "Reglee" : "A regler"}</span>
      </div>
      ${lines ? `<button type="button" class="btn btn-outline" style="font-size:12px;padding:4px 10px;width:auto;align-self:flex-start" onclick="var d=document.getElementById('${detailId}');d.style.display=d.style.display==='none'?'block':'none';this.textContent=d.style.display==='none'?'Voir details':'Masquer details'">Voir details</button>
      <div id="${detailId}" class="customer-order-lines" style="display:none">${lines}</div>` : ""}
    </article>`;
  }).join("");
  container.innerHTML = summaryHtml + ordersHtml;
}

async function loadCustomerOrders() {
  if (!customerState.siteId) return;
  const table = document.getElementById("customer-table")?.value.trim() || customerState.table || customerState.alias || "Comptoir";
  const client = (document.getElementById("customer-name")?.value.trim() || loadSavedClientName() || "").toUpperCase();
  if (!client) { renderSentOrders(); return; }
  const payload = await customerApi(
    `/api/public/orders?siteId=${encodeURIComponent(customerState.siteId)}&table=${encodeURIComponent(table)}&client=${encodeURIComponent(client)}`
  );
  customerState.sentOrders = payload.orders || [];
  customerState.totalDue = payload.totalDue || 0;
  customerState.totalPaid = payload.totalPaid || 0;
  renderSentOrders();
}

function resetForNextOrder() {
  customerState.cart = [];
  document.getElementById("customer-note").value = "";
  document.getElementById("customer-feedback").textContent = "";
  document.getElementById("send-order-btn").disabled = false;
  document.getElementById("new-customer-order-btn").classList.add("hidden");
  const qs = document.getElementById("qr-menu-search");
  if (qs) qs.value = "";
  renderMenu();
  renderCart();
  document.getElementById("customer-menu").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setMenuQty(key, qty) {
  const menuItem = customerState.menu.find((item) => menuKey(item) === key);
  if (!menuItem) return;
  qty = Math.max(0, Math.round(qty));
  const maxQty = maxQtyForMenuKey(menuItem, key);
  if (qty > maxQty) qty = maxQty;
  const idx = customerState.cart.findIndex((item) => item.key === key);
  if (qty <= 0) {
    if (idx >= 0) customerState.cart.splice(idx, 1);
  } else if (idx >= 0) {
    customerState.cart[idx].qty = qty;
  } else {
    customerState.cart.push({
      key,
      article: menuItem.article,
      cat: menuItem.cat,
      prix: menuItem.prix,
      packSize: menuItem.packSize || menuItem.formatQuantite || 1,
      availableBottles: menuItem.availableBottles,
      qty,
    });
  }
  const input = document.querySelector(`.qty-input[data-menu-key="${CSS.escape(key)}"]`);
  if (input && Number(input.value) !== qty) input.value = String(qty);
  renderCart();
}

async function sendOrder() {
  const clientName = document.getElementById("customer-name").value.trim().toUpperCase();
  const table = document.getElementById("customer-table").value.trim() || customerState.table || customerState.alias || "Comptoir";
  const note = document.getElementById("customer-note").value.trim();
  const feedback = document.getElementById("customer-feedback");
  if (!customerState.cart.length) {
    feedback.textContent = "Ajoutez au moins un article.";
    return;
  }
  feedback.textContent = "";
  document.getElementById("send-order-btn").disabled = true;
  try {
    const sentTotal = customerState.cart.reduce((sum, item) => sum + (item.prix * item.qty), 0);
    const sentItems = customerState.cart.reduce((sum, item) => sum + item.qty, 0);
    const result = await customerApi("/api/public/order", {
      method: "POST",
      body: JSON.stringify({
        siteId: customerState.siteId,
        client: clientName,
        table,
        note,
        location: customerState.location,
        items: customerState.cart.map((item) => ({ article: item.article, qty: item.qty, formatQuantite: item.packSize || 1 })),
      }),
    });
    saveClientName(clientName);
    customerState.cart = [];
    renderMenu();
    renderCart();
    await loadCustomerOrders();
    feedback.style.color = "#72d7a9";
    feedback.textContent = `Commande ajoutee. Total a regler : ${fmt(customerState.totalDue)} FCFA.`;
    document.getElementById("new-customer-order-btn").classList.remove("hidden");
  } catch (error) {
    feedback.style.color = "";
    feedback.textContent = error.message;
  }
  document.getElementById("send-order-btn").disabled = false;
}

async function initCustomer() {
  getParams();
  if (!customerState.siteId) {
    document.getElementById("customer-feedback").textContent = "Lien QR incomplet.";
    return;
  }
  try {
    const payload = await customerApi(
      `/api/public/menu?siteId=${encodeURIComponent(customerState.siteId)}&location=${encodeURIComponent(customerState.location)}`
    );
    customerState.site = payload.site;
    customerState.menu = payload.menu;

    document.getElementById("order-site-name").textContent = payload.site.nom;
    document.getElementById("order-site-copy").textContent =
      `${payload.site.ville || ""} ${payload.site.pays || ""}`.trim() || "Passez votre commande ici.";
    document.getElementById("order-table-label").textContent =
      customerState.table || customerState.alias || "Comptoir";
    document.getElementById("customer-table").value = customerState.table || customerState.alias || "";

    const locLabel = customerState.location;
    document.getElementById("order-location-label").textContent = locLabel;
    document.getElementById("order-location-badge").style.display = "";
    document.getElementById("menu-location-tag").textContent =
      `Prix ${locLabel === "Extérieur" ? "terrasse" : "cave"}`;

    applySavedNameUI();

    renderMenu();
    renderCart();
    await loadCustomerOrders();
    window.requestAnimationFrame(() => document.getElementById("qr-menu-search")?.focus());
  } catch (error) {
    document.getElementById("customer-feedback").textContent = error.message;
  }

  const qrMenuSearch = document.getElementById("qr-menu-search");
  if (qrMenuSearch) {
    qrMenuSearch.addEventListener("input", () => renderMenu());
  }

  document.getElementById("customer-menu").addEventListener("click", (event) => {
    const inc = event.target.closest("[data-inc-menu]");
    if (inc) { setMenuQty(inc.dataset.incMenu, cartQty(inc.dataset.incMenu) + 1); return; }
    const dec = event.target.closest("[data-dec-menu]");
    if (dec) { setMenuQty(dec.dataset.decMenu, cartQty(dec.dataset.decMenu) - 1); return; }
  });

  document.getElementById("customer-menu").addEventListener("change", (event) => {
    const input = event.target.closest(".qty-input");
    if (input) setMenuQty(input.dataset.menuKey, Number(input.value));
  });

  document.getElementById("send-order-btn").addEventListener("click", sendOrder);
  document.getElementById("new-customer-order-btn").addEventListener("click", resetForNextOrder);
  let nameDebounce = null;
  const nameInput = document.getElementById("customer-name");
  nameInput.addEventListener("input", (e) => {
    e.target.value = e.target.value.toUpperCase();
    const v = e.target.value.trim();
    if (v) {
      saveClientName(v);
    }
    clearTimeout(nameDebounce);
    nameDebounce = setTimeout(() => loadCustomerOrders().catch(() => {}), 350);
  });
  nameInput.addEventListener("change", () => {
    loadCustomerOrders().catch(() => {});
    applySavedNameUI();
  });
  nameInput.addEventListener("blur", () => applySavedNameUI());

  document.getElementById("change-saved-name-btn").addEventListener("click", () => {
    clearSavedClientName();
    const input = document.getElementById("customer-name");
    input.readOnly = false;
    input.value = "";
    applySavedNameUI();
    renderSentOrders();
    input.focus();
  });
  document.getElementById("customer-table").addEventListener("change", () => loadCustomerOrders().catch(() => {}));
}

initCustomer();
