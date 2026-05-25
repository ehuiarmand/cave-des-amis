/* ============================================================
   <cave-order-pad> — order pad complet (catalogue + ticket)
   ------------------------------------------------------------
   Le composant interactif le plus complet : un catalogue
   d'articles à gauche (avec recherche + catégories + zone
   intérieur/extérieur), un ticket à droite (avec quantités
   ajustables, modes de paiement, total live).

   Usage minimal :

     <cave-order-pad id="pad"
       table="Table 04"
       serveuse="Nadia">
     </cave-order-pad>

     <script>
       const pad = document.getElementById('pad');
       // 1. Fournir le catalogue depuis vos données
       pad.catalog = [
         { id: 1, nom: 'Guinness 33', cat: 'Bières', prix: 700, stock: 142, emoji: '🍺' },
         ...
       ];
       // 2. Écouter l'encaissement
       pad.addEventListener('checkout', (e) => {
         const { items, total, paiement, table } = e.detail;
         // POST vers /api/ventes par exemple
       });
     </script>
   ============================================================ */

(function () {
  if (customElements.get('cave-order-pad')) return;

  const fmtFCFA = (n) => {
    if (n == null || isNaN(n)) return '—';
    return Math.abs(n).toLocaleString('fr-FR').replace(/,/g, ' ') + ' F';
  };

  class CaveOrderPad extends HTMLElement {
    static get observedAttributes() {
      return ['table', 'serveuse', 'zone', 'currency'];
    }

    constructor() {
      super();
      this._cart = [];
      this._cat = 'Toutes';
      this._search = '';
      this._paiement = 'Espèces';
      this._zone = 'Intérieur';
      this._catalog = [];
      this._paymentModes = ['Espèces', 'Wave', 'Orange Money', 'MTN MoMo', 'Crédit'];
    }

    connectedCallback() { this.render(); }
    attributeChangedCallback(name) {
      if (name === 'zone') this._zone = this.getAttribute('zone') || 'Intérieur';
      if (this.isConnected) this._update();
    }

    // ── API publique ────────────────────────────────────────
    set catalog(arr) { this._catalog = arr || []; if (this.isConnected) this._update(); }
    get catalog() { return this._catalog; }

    set paymentModes(arr) { this._paymentModes = arr || []; if (this.isConnected) this._update(); }

    get cart() { return [...this._cart]; }
    get total() { return this._cart.reduce((s, c) => s + c.prix * c.qty, 0); }

    clear() { this._cart = []; this._update(); }

    addItem(item, qty = 1) {
      const existing = this._cart.find(c => c.id === item.id);
      if (existing) existing.qty += qty;
      else this._cart.push({ ...item, qty });
      this._update();
    }

    // ── Filtres ─────────────────────────────────────────────
    _categories() {
      const cats = new Set(['Toutes']);
      this._catalog.forEach(p => cats.add(p.cat));
      return [...cats];
    }
    _filtered() {
      const s = this._search.toLowerCase().trim();
      return this._catalog.filter(p =>
        (this._cat === 'Toutes' || p.cat === this._cat) &&
        (s === '' || p.nom.toLowerCase().includes(s))
      );
    }

    // ── Handlers ────────────────────────────────────────────
    _onClick = (e) => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const action = t.dataset.action;

      if (action === 'add') {
        const id = Number(t.dataset.id);
        const it = this._catalog.find(p => p.id === id);
        if (it) this.addItem(it);
      }
      else if (action === 'qty+') {
        const id = Number(t.dataset.id);
        const it = this._cart.find(c => c.id === id);
        if (it) { it.qty++; this._update(); }
      }
      else if (action === 'qty-') {
        const id = Number(t.dataset.id);
        const it = this._cart.find(c => c.id === id);
        if (it) {
          it.qty--;
          if (it.qty <= 0) this._cart = this._cart.filter(c => c.id !== id);
          this._update();
        }
      }
      else if (action === 'remove') {
        const id = Number(t.dataset.id);
        this._cart = this._cart.filter(c => c.id !== id);
        this._update();
      }
      else if (action === 'cat') {
        this._cat = t.dataset.cat;
        this._update();
      }
      else if (action === 'zone') {
        this._zone = t.dataset.zone;
        this.setAttribute('zone', this._zone);
        this._update();
      }
      else if (action === 'pay') {
        this._paiement = t.dataset.mode;
        this._update();
      }
      else if (action === 'checkout') {
        if (this._cart.length === 0) return;
        this.dispatchEvent(new CustomEvent('checkout', {
          detail: {
            items:     this.cart,
            total:     this.total,
            paiement:  this._paiement,
            table:     this.getAttribute('table'),
            serveuse:  this.getAttribute('serveuse'),
            zone:      this._zone,
          },
          bubbles: true,
        }));
      }
      else if (action === 'hold') {
        this.dispatchEvent(new CustomEvent('hold', {
          detail: { items: this.cart, total: this.total }, bubbles: true,
        }));
      }
    };

    _onInput = (e) => {
      if (e.target.matches('input[data-role="search"]')) {
        this._search = e.target.value;
        this._renderCatalog();
      }
    };

    // ── Render ──────────────────────────────────────────────
    _update() {
      this._renderCatalog();
      this._renderCart();
    }

    _renderCatalog() {
      const grid = this.querySelector('[data-role="catalog"]');
      if (!grid) return;
      const filtered = this._filtered();
      if (filtered.length === 0) {
        grid.innerHTML = '<div class="cv-empty">Aucun article</div>';
        return;
      }
      grid.innerHTML = filtered.map(p => {
        const alerte = (p.stock != null && p.seuil != null && p.stock <= p.seuil);
        return `
          <button type="button" class="cv-prod" data-action="add" data-id="${p.id}">
            <span class="cv-prod-icon">${p.emoji || '·'}</span>
            <span class="cv-prod-info">
              <span class="cv-prod-name">${p.nom}</span>
              <span class="cv-prod-meta">${fmtFCFA(p.prix)}${p.stock != null ? ' · ' + p.stock + ' en stock' : ''}</span>
            </span>
            ${alerte ? '<span class="cv-prod-alert" title="Stock bas">!</span>' : ''}
            <span class="cv-prod-add">+</span>
          </button>
        `;
      }).join('');

      // Update active category
      this.querySelectorAll('[data-action="cat"]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.cat === this._cat);
      });
      // Update active zone
      this.querySelectorAll('[data-action="zone"]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.zone === this._zone);
      });
    }

    _renderCart() {
      const wrap = this.querySelector('[data-role="cart-lines"]');
      const tot  = this.querySelector('[data-role="cart-total"]');
      const cta  = this.querySelector('[data-role="cart-cta"]');
      if (!wrap) return;
      const total = this.total;

      if (this._cart.length === 0) {
        wrap.innerHTML = `
          <div class="cv-cart-empty">
            <div class="cv-cart-empty-mark"></div>
            <h4>Ticket vide</h4>
            <p>Cliquez un article du catalogue pour démarrer.</p>
          </div>
        `;
      } else {
        wrap.innerHTML = this._cart.map(c => `
          <div class="cv-cart-line">
            <span class="cv-cart-emoji">${c.emoji || '·'}</span>
            <span class="cv-cart-info">
              <span class="cv-cart-name">${c.nom}</span>
              <span class="cv-cart-unit">${fmtFCFA(c.prix)} l'unité</span>
            </span>
            <span class="cv-qty">
              <button type="button" data-action="qty-" data-id="${c.id}">−</button>
              <span>${c.qty}</span>
              <button type="button" data-action="qty+" data-id="${c.id}">+</button>
            </span>
            <span class="cv-cart-amt">${fmtFCFA(c.prix * c.qty)}</span>
            <button type="button" class="cv-cart-x" data-action="remove" data-id="${c.id}">×</button>
          </div>
        `).join('');
      }

      if (tot) tot.textContent = fmtFCFA(total);
      if (cta) {
        cta.disabled = this._cart.length === 0;
        cta.querySelector('[data-role="cta-label"]').textContent =
          this._cart.length === 0 ? 'Encaisser' : `Encaisser ${fmtFCFA(total)}`;
      }

      // Update count in header
      const count = this.querySelector('[data-role="cart-count"]');
      if (count) count.textContent = `${this._cart.length} article${this._cart.length > 1 ? 's' : ''}`;

      // Update active payment
      this.querySelectorAll('[data-action="pay"]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.mode === this._paiement);
      });
    }

    render() {
      const table    = this.getAttribute('table')    || 'Comptoir';
      const serveuse = this.getAttribute('serveuse') || '';
      this._zone     = this.getAttribute('zone')     || 'Intérieur';

      const cats = this._categories();
      const catTabs = cats.map(c => {
        const count = c === 'Toutes' ? this._catalog.length : this._catalog.filter(p => p.cat === c).length;
        return `<button type="button" class="cv-tab" data-action="cat" data-cat="${c}">
                  ${c}<span class="cv-tab-count">${count}</span>
                </button>`;
      }).join('');

      const zoneTabs = ['Intérieur', 'Extérieur'].map(z =>
        `<button type="button" class="cv-pill" data-action="zone" data-zone="${z}">${z}</button>`
      ).join('');

      const payModes = this._paymentModes.map(m =>
        `<button type="button" class="cv-pay" data-action="pay" data-mode="${m}">${m}</button>`
      ).join('');

      this.innerHTML = `
        <div class="cv-op">
          <!-- CATALOG -->
          <div class="cv-op-catalog">
            <div class="cv-op-bar">
              <div class="cv-search">
                <span class="cv-search-icon">⌕</span>
                <input type="text" placeholder="Rechercher un article…" data-role="search">
              </div>
              <div class="cv-pill-group">${zoneTabs}</div>
            </div>
            <div class="cv-tabs">${catTabs}</div>
            <div class="cv-catalog-grid" data-role="catalog"></div>
          </div>

          <!-- CART -->
          <aside class="cv-op-cart">
            <header class="cv-cart-head">
              <div>
                <p class="cv-eyebrow">Ticket en cours</p>
                <h3 class="cv-cart-title">${table}</h3>
                <p class="cv-cart-sub">${serveuse ? 'Serveuse · ' + serveuse + ' · ' : ''}<span data-role="cart-count">0 article</span></p>
              </div>
            </header>

            <div class="cv-cart-lines" data-role="cart-lines"></div>

            <div class="cv-cart-totals">
              <div class="cv-cart-total-row">
                <span>Total à régler</span>
                <strong data-role="cart-total">0 F</strong>
              </div>
            </div>

            <div class="cv-cart-pay">
              <p class="cv-eyebrow">Mode de paiement</p>
              <div class="cv-pay-grid">${payModes}</div>
            </div>

            <div class="cv-cart-cta-row">
              <button type="button" class="cv-btn cv-btn-outline" data-action="hold">
                Mettre en attente
              </button>
              <button type="button" class="cv-btn cv-btn-primary" data-role="cart-cta" data-action="checkout" disabled>
                <span data-role="cta-label">Encaisser</span>
              </button>
            </div>
          </aside>
        </div>
      `;

      this.addEventListener('click', this._onClick);
      this.addEventListener('input', this._onInput);

      this._update();
    }
  }

  customElements.define('cave-order-pad', CaveOrderPad);
})();
