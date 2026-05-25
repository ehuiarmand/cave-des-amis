/* ============================================================
   Cave Manager — composants vanilla JS (suite)
   ------------------------------------------------------------
   3 composants autonomes, aucune dépendance :

     <cave-kpi-hero>      — grande carte KPI avec progression
     <cave-bar-chart>     — barres verticales (ventes par heure)
     <cave-payment-bar>   — barre empilée + légende (modes paiement)

   Chargement :
     <script src="cave-components.js"></script>
     <link rel="stylesheet" href="cave-components.css">
   ============================================================ */

(function () {
  const fmtFCFA = (n) => {
    if (n == null || isNaN(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + Math.abs(n).toLocaleString('fr-FR').replace(/,/g, ' ') + ' F';
  };
  const fmtPct = (n) => Math.round(n * 100) + ' %';
  const parseNum = (v) => {
    const n = Number(String(v).replace(/[^\d.-]/g, ''));
    return isNaN(n) ? 0 : n;
  };

  // ─────────────────────────────────────────────────────────────
  // <cave-kpi-hero>
  // ─────────────────────────────────────────────────────────────
  //
  // Usage :
  //   <cave-kpi-hero
  //     label="Chiffre d'affaires du jour"
  //     value="487400"
  //     objectif="500000"
  //     hier="412800"
  //     unite="F">
  //   </cave-kpi-hero>
  //
  // Attributs :
  //   label     (str) — petite étiquette en haut
  //   value     (num) — la valeur principale (en F CFA par défaut)
  //   objectif  (num, optionnel) — objectif pour la barre de progression
  //   hier      (num, optionnel) — valeur d'hier pour le delta %
  //   unite     (str) — "F" (default) ou autre
  //   sub       (str, optionnel) — sous-texte personnalisé
  //
  if (!customElements.get('cave-kpi-hero')) {
    class CaveKpiHero extends HTMLElement {
      static get observedAttributes() {
        return ['label', 'value', 'objectif', 'hier', 'unite', 'sub'];
      }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }

      render() {
        const label    = this.getAttribute('label') || 'Valeur';
        const value    = parseNum(this.getAttribute('value'));
        const objectif = this.getAttribute('objectif') ? parseNum(this.getAttribute('objectif')) : null;
        const hier     = this.getAttribute('hier') ? parseNum(this.getAttribute('hier')) : null;
        const unite    = this.getAttribute('unite') || 'F';
        const subRaw   = this.getAttribute('sub');

        const valueFmt = unite === 'F'
          ? fmtFCFA(value)
          : value.toLocaleString('fr-FR').replace(/,/g, ' ') + (unite ? ' ' + unite : '');

        let delta = '';
        if (hier != null && hier > 0) {
          const pct = Math.round(((value - hier) / hier) * 100);
          const cls = pct >= 0 ? 'pos' : 'neg';
          const arrow = pct >= 0 ? '↑' : '↓';
          delta = `<div class="cv-delta ${cls}">
                     <span class="cv-delta-arrow">${arrow}</span>
                     <span>${pct >= 0 ? '+' : ''}${pct}%</span>
                     <span class="cv-delta-label">vs hier (${unite === 'F' ? fmtFCFA(hier) : hier})</span>
                   </div>`;
        }

        let progress = '';
        if (objectif != null && objectif > 0) {
          const ratio = Math.min(1, value / objectif);
          const reste = Math.max(0, objectif - value);
          progress = `
            <div class="cv-progress">
              <div class="cv-progress-track">
                <div class="cv-progress-fill" style="width: ${ratio * 100}%;"></div>
              </div>
              <div class="cv-progress-label">
                Objectif ${unite === 'F' ? fmtFCFA(objectif) : objectif} ·
                ${reste > 0 ? `reste ${unite === 'F' ? fmtFCFA(reste) : reste}` : `atteint à ${fmtPct(ratio)}`}
              </div>
            </div>`;
        }

        const sub = subRaw ? `<div class="cv-sub">${subRaw}</div>` : '';

        this.innerHTML = `
          <div class="cv-kpi-hero">
            <div class="cv-label">${label}</div>
            <div class="cv-value">${valueFmt}</div>
            ${sub}
            ${delta}
            ${progress}
          </div>
        `;
      }
    }
    customElements.define('cave-kpi-hero', CaveKpiHero);
  }

  // ─────────────────────────────────────────────────────────────
  // <cave-bar-chart>
  // ─────────────────────────────────────────────────────────────
  //
  // Usage :
  //   <cave-bar-chart
  //     data='[{"x":"11h","y":8000},{"x":"12h","y":24000}, ...]'
  //     height="180">
  //   </cave-bar-chart>
  //
  // Ou via JS pour des données live :
  //   document.querySelector('cave-bar-chart').data = [...];
  //
  if (!customElements.get('cave-bar-chart')) {
    class CaveBarChart extends HTMLElement {
      static get observedAttributes() { return ['data', 'height']; }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }

      set data(arr) {
        this._data = arr;
        this.removeAttribute('data');
        this.render();
      }
      get data() {
        if (this._data) return this._data;
        try { return JSON.parse(this.getAttribute('data') || '[]'); }
        catch (e) { return []; }
      }

      render() {
        const data = this.data;
        const height = parseInt(this.getAttribute('height') || '160', 10);
        if (!data.length) {
          this.innerHTML = '<div class="cv-empty">Aucune donnée</div>';
          return;
        }
        const max = Math.max(...data.map(d => Number(d.y) || 0), 1);
        const bars = data.map(d => {
          const h = ((Number(d.y) || 0) / max) * 100;
          return `
            <div class="cv-bar-col" title="${d.x} : ${fmtFCFA(d.y)}">
              <div class="cv-bar-tooltip">${fmtFCFA(d.y)}</div>
              <div class="cv-bar" style="height: ${h}%;"></div>
              <div class="cv-bar-label">${d.x}</div>
            </div>`;
        }).join('');

        this.innerHTML = `
          <div class="cv-bar-chart" style="height: ${height}px;">
            ${bars}
          </div>
        `;
      }
    }
    customElements.define('cave-bar-chart', CaveBarChart);
  }

  // ─────────────────────────────────────────────────────────────
  // <cave-payment-bar>
  // ─────────────────────────────────────────────────────────────
  //
  // Usage :
  //   <cave-payment-bar
  //     data='[{"mode":"Espèces","montant":268300,"couleur":"amber"},
  //             {"mode":"Wave","montant":122400,"couleur":"forest"},
  //             {"mode":"Orange Money","montant":68600,"couleur":"terracotta"},
  //             {"mode":"MTN MoMo","montant":28100,"couleur":"ink"}]'>
  //   </cave-payment-bar>
  //
  // Couleurs supportées : amber, forest, terracotta, ink, claret
  //
  if (!customElements.get('cave-payment-bar')) {
    class CavePaymentBar extends HTMLElement {
      static get observedAttributes() { return ['data']; }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }

      set data(arr) {
        this._data = arr;
        this.removeAttribute('data');
        this.render();
      }
      get data() {
        if (this._data) return this._data;
        try { return JSON.parse(this.getAttribute('data') || '[]'); }
        catch (e) { return []; }
      }

      render() {
        const items = this.data;
        if (!items.length) {
          this.innerHTML = '<div class="cv-empty">Aucune donnée</div>';
          return;
        }
        const total = items.reduce((s, it) => s + (Number(it.montant) || 0), 0) || 1;
        const colors = ['amber', 'forest', 'terracotta', 'ink', 'claret'];

        const segs = items.map((it, i) => {
          const pct = (Number(it.montant) || 0) / total;
          const c = it.couleur || colors[i % colors.length];
          return `<div class="cv-seg" data-color="${c}" style="width:${pct * 100}%;"
                       title="${it.mode} · ${fmtFCFA(it.montant)}"></div>`;
        }).join('');

        const legend = items.map((it, i) => {
          const pct = (Number(it.montant) || 0) / total;
          const c = it.couleur || colors[i % colors.length];
          return `
            <li>
              <span class="cv-swatch" data-color="${c}"></span>
              <span class="cv-mode">${it.mode}</span>
              <span class="cv-amt">${fmtFCFA(it.montant)}</span>
              <span class="cv-pct">${fmtPct(pct)}</span>
            </li>`;
        }).join('');

        this.innerHTML = `
          <div class="cv-paybar">
            <div class="cv-paybar-track">${segs}</div>
            <ul class="cv-paybar-legend">${legend}</ul>
          </div>
        `;
      }
    }
    customElements.define('cave-payment-bar', CavePaymentBar);
  }
})();
