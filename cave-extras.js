/* ============================================================
   Cave Manager — composants vanilla (suite & fin)
   ------------------------------------------------------------
   <cave-badge>      — pastille statut/alerte (5 tons)
   <cave-checklist>  — liste à cocher pour clôture PDJ
   <cave-receipt>    — récap façon reçu papier + tampon
   <cave-list>       — tableau éditorial avec colonnes typées

   <cave-order-pad>  — voir cave-order-pad.js (gros composant)
   ============================================================ */

(function () {

  const fmtFCFA = (n) => {
    if (n == null || isNaN(n)) return '—';
    const sign = n < 0 ? '-' : '';
    return sign + Math.abs(n).toLocaleString('fr-FR').replace(/,/g, ' ') + ' F';
  };

  // ─────────────────────────────────────────────────────────
  // <cave-badge>
  //   <cave-badge tone="amber">en attente</cave-badge>
  //   <cave-badge tone="forest" dot>Encaissé</cave-badge>
  // Tons : neutral | amber | forest | terracotta | claret | ink
  // ─────────────────────────────────────────────────────────
  if (!customElements.get('cave-badge')) {
    class CaveBadge extends HTMLElement {
      static get observedAttributes() { return ['tone', 'dot']; }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }
      render() {
        const tone = this.getAttribute('tone') || 'neutral';
        const dot  = this.hasAttribute('dot');
        // sauvegarder le texte avant de réécrire innerHTML
        if (!this._text) this._text = this.textContent.trim();
        const text = this._text;
        this.dataset.tone = tone;
        this.innerHTML = `${dot ? '<span class="cv-bdot"></span>' : ''}<span>${text}</span>`;
      }
    }
    customElements.define('cave-badge', CaveBadge);
  }

  // ─────────────────────────────────────────────────────────
  // <cave-checklist>
  //
  //   <cave-checklist items='[
  //     {"key":"stock","title":"Vérifier stock physique","sub":"Comparer affiché vs réel."},
  //     {"key":"casiers","title":"Recompter les casiers","sub":"19 casiers, 3 vides à remonter."},
  //     {"key":"fond","title":"Fond de caisse","sub":"Le système attend 268 300 F."}
  //   ]'></cave-checklist>
  //
  // Émet l'événement "change" avec detail = { key, checked, allChecked }
  // Méthode .values() retourne {key: checked} pour récupérer l'état
  // ─────────────────────────────────────────────────────────
  if (!customElements.get('cave-checklist')) {
    class CaveChecklist extends HTMLElement {
      static get observedAttributes() { return ['items']; }
      constructor() { super(); this._state = {}; }
      connectedCallback() {
        this.render();
        this.addEventListener('change', this._onChange);
      }
      attributeChangedCallback() { if (this.isConnected) this.render(); }
      values() { return { ...this._state }; }
      allChecked() {
        const items = this._items();
        return items.length > 0 && items.every(i => this._state[i.key]);
      }
      _items() {
        try { return JSON.parse(this.getAttribute('items') || '[]'); }
        catch (e) { return []; }
      }
      _onChange = (e) => {
        if (e.target.matches('input[type="checkbox"]')) {
          const key = e.target.dataset.key;
          this._state[key] = e.target.checked;
          // update status label
          const row = e.target.closest('.cv-chk-row');
          if (row) row.dataset.checked = e.target.checked ? 'true' : 'false';
          this.dispatchEvent(new CustomEvent('item-change', {
            detail: { key, checked: e.target.checked, allChecked: this.allChecked() },
            bubbles: true,
          }));
        }
      }
      render() {
        const items = this._items();
        this.innerHTML = `
          <div class="cv-checklist">
            ${items.map(it => {
              const checked = this._state[it.key] === true;
              return `
                <label class="cv-chk-row" data-checked="${checked}">
                  <input type="checkbox" data-key="${it.key}" ${checked ? 'checked' : ''}>
                  <div class="cv-chk-body">
                    <div class="cv-chk-title">${it.title}</div>
                    ${it.sub ? `<div class="cv-chk-sub">${it.sub}</div>` : ''}
                  </div>
                  <span class="cv-chk-status">
                    <span class="cv-chk-status-pending">À vérifier</span>
                    <span class="cv-chk-status-done">OK</span>
                  </span>
                </label>
              `;
            }).join('')}
          </div>
        `;
      }
    }
    customElements.define('cave-checklist', CaveChecklist);
  }

  // ─────────────────────────────────────────────────────────
  // <cave-receipt>
  //
  //   <cave-receipt stamp="Prêt à clôturer" stamp-tone="forest">
  //     <div slot="header">
  //       <span class="cv-rcp-eyebrow">Récapitulatif</span>
  //       <h3>Fiche de clôture</h3>
  //     </div>
  //     <cave-receipt-line label="CA encaissé" value="408 900 F"></cave-receipt-line>
  //     <cave-receipt-line label="Créances" value="78 500 F"></cave-receipt-line>
  //     <cave-receipt-line label="Charges" value="-191 500 F"></cave-receipt-line>
  //     <hr>
  //     <cave-receipt-line label="Bénéfice indicatif" value="217 400 F" bold></cave-receipt-line>
  //   </cave-receipt>
  //
  // ─────────────────────────────────────────────────────────
  if (!customElements.get('cave-receipt')) {
    class CaveReceipt extends HTMLElement {
      static get observedAttributes() { return ['stamp', 'stamp-tone']; }
      connectedCallback() {
        if (!this._original) this._original = this.innerHTML;
        this.render();
      }
      attributeChangedCallback() { if (this.isConnected) this.render(); }
      render() {
        const stamp = this.getAttribute('stamp');
        const tone = this.getAttribute('stamp-tone') || 'claret';
        this.innerHTML = `
          <div class="cv-receipt">
            <div class="cv-receipt-body">${this._original || ''}</div>
            ${stamp ? `<div class="cv-receipt-stamp-row">
                        <span class="cv-stamp" data-tone="${tone}">${stamp}</span>
                       </div>` : ''}
          </div>
        `;
      }
    }
    customElements.define('cave-receipt', CaveReceipt);
  }

  if (!customElements.get('cave-receipt-line')) {
    class CaveReceiptLine extends HTMLElement {
      connectedCallback() {
        const label = this.getAttribute('label') || '';
        const value = this.getAttribute('value') || '';
        const bold  = this.hasAttribute('bold');
        this.innerHTML = `
          <div class="cv-rcp-line ${bold ? 'is-bold' : ''}">
            <span class="cv-rcp-lbl">${label}</span>
            <span class="cv-rcp-val">${value}</span>
          </div>
        `;
      }
    }
    customElements.define('cave-receipt-line', CaveReceiptLine);
  }

  // ─────────────────────────────────────────────────────────
  // <cave-list>
  //
  //   <cave-list
  //     columns='[
  //       {"key":"id","label":"Ticket","mono":true,"strong":true,"width":"110px"},
  //       {"key":"heure","label":"Heure","mono":true,"muted":true,"width":"70px"},
  //       {"key":"table","label":"Table"},
  //       {"key":"total","label":"Total","num":true,"strong":true,"format":"FCFA","width":"110px"},
  //       {"key":"statut","label":"Statut","badge":"status","width":"90px"}
  //     ]'
  //     rows='[
  //       {"id":"CDAYOP-0298","heure":"21:42","table":"Table 12","total":12400,"statut":{"label":"Encaissée","tone":"forest"}},
  //       ...
  //     ]'>
  //   </cave-list>
  //
  // Colonnes :
  //   key       - clé dans la donnée
  //   label     - en-tête
  //   width     - largeur fixe (px ou fr ou auto)
  //   num       - aligné à droite + mono + tabular nums
  //   mono      - police mono
  //   strong    - poids 500
  //   muted     - couleur muted
  //   format    - "FCFA" pour formater en F CFA
  //   badge     - "tone" prend la valeur comme tone, "status" prend {label, tone}
  // ─────────────────────────────────────────────────────────
  if (!customElements.get('cave-list')) {
    class CaveList extends HTMLElement {
      static get observedAttributes() { return ['columns', 'rows']; }
      connectedCallback() { this.render(); }
      attributeChangedCallback() { if (this.isConnected) this.render(); }

      set rows(arr) { this._rows = arr; this.removeAttribute('rows'); this.render(); }
      get rows() {
        if (this._rows) return this._rows;
        try { return JSON.parse(this.getAttribute('rows') || '[]'); }
        catch (e) { return []; }
      }
      set columns(arr) { this._cols = arr; this.removeAttribute('columns'); this.render(); }
      get columns() {
        if (this._cols) return this._cols;
        try { return JSON.parse(this.getAttribute('columns') || '[]'); }
        catch (e) { return []; }
      }

      _cellValue(col, row) {
        const v = row[col.key];
        if (col.badge === 'status' && v && typeof v === 'object') {
          return `<cave-badge tone="${v.tone || 'neutral'}" dot>${v.label}</cave-badge>`;
        }
        if (col.badge === 'tone') {
          return `<cave-badge tone="${v || 'neutral'}">${v}</cave-badge>`;
        }
        if (col.badge === 'simple') {
          return `<cave-badge tone="neutral">${v}</cave-badge>`;
        }
        if (col.format === 'FCFA') return fmtFCFA(v);
        if (col.format === 'num')  return (Number(v) || 0).toLocaleString('fr-FR').replace(/,/g, ' ');
        return v == null ? '—' : v;
      }

      _classes(col) {
        const cls = [];
        if (col.num)    cls.push('cv-c-num');
        if (col.mono)   cls.push('cv-c-mono');
        if (col.strong) cls.push('cv-c-strong');
        if (col.muted)  cls.push('cv-c-muted');
        return cls.join(' ');
      }

      render() {
        const cols = this.columns;
        const rows = this.rows;
        if (!cols.length) { this.innerHTML = '<div class="cv-empty">Aucune colonne.</div>'; return; }

        const gridCols = cols.map(c => c.width || '1fr').join(' ');

        const head = cols.map(c =>
          `<span class="cv-c ${c.num ? 'cv-c-num' : ''}">${c.label}</span>`
        ).join('');

        const body = rows.length === 0
          ? `<div class="cv-list-empty">Aucune ligne.</div>`
          : rows.map(r => `
            <div class="cv-list-row" style="grid-template-columns: ${gridCols};">
              ${cols.map(c => `<span class="cv-c ${this._classes(c)}">${this._cellValue(c, r)}</span>`).join('')}
            </div>
          `).join('');

        this.innerHTML = `
          <div class="cv-list">
            <div class="cv-list-row cv-list-head" style="grid-template-columns: ${gridCols};">
              ${head}
            </div>
            ${body}
          </div>
        `;
      }
    }
    customElements.define('cave-list', CaveList);
  }

})();
