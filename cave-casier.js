/* ============================================================
   <cave-casier> — Web component pour visualiser un casier
   ------------------------------------------------------------
   Vanilla JS, aucune dépendance. Marche partout.

   Utilisation dans votre index.html :

     <cave-casier
       code="CAS-A03"
       article="Guinness 33"
       capacite="24"
       qte="18"
       emplacement="Réserve A"
       statut="partiel"></cave-casier>

   Statuts possibles : "plein" | "partiel" | "vide"

   Pour mettre à jour depuis votre JS :

     const el = document.querySelector('cave-casier[code="CAS-A03"]');
     el.setAttribute('qte', '12');         // se met à jour tout seul
     el.setAttribute('statut', 'partiel');

   Pour générer une grille depuis vos données serveur :

     const grid = document.getElementById('casiers-grid');
     casiers.forEach(c => {
       const el = document.createElement('cave-casier');
       el.setAttribute('code', c.code);
       el.setAttribute('article', c.article);
       el.setAttribute('capacite', c.capacite);
       el.setAttribute('qte', c.qte);
       el.setAttribute('emplacement', c.emplacement);
       el.setAttribute('statut', c.statut);
       grid.appendChild(el);
     });

   ============================================================ */

(function () {
  if (customElements.get('cave-casier')) return;

  class CaveCasier extends HTMLElement {
    static get observedAttributes() {
      return ['code', 'article', 'capacite', 'qte', 'emplacement', 'statut'];
    }

    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }

    render() {
      const code        = this.getAttribute('code')        || '—';
      const article     = this.getAttribute('article')     || '—';
      const emplacement = this.getAttribute('emplacement') || '';
      const capacite    = parseInt(this.getAttribute('capacite')    || '24', 10);
      const qte         = parseInt(this.getAttribute('qte')         || '0', 10);
      let   statut      = (this.getAttribute('statut') || '').toLowerCase();

      // Statut auto si non fourni
      if (!statut) {
        if (qte === 0) statut = 'vide';
        else if (qte >= capacite) statut = 'plein';
        else statut = 'partiel';
      }

      const cols = capacite > 12 ? 6 : 4;
      const rows = Math.ceil(capacite / cols);

      this.dataset.statut = statut;

      let bottles = '';
      for (let i = 0; i < capacite; i++) {
        const filled = i < qte;
        bottles += `<span class="cv-bottle" data-filled="${filled}"></span>`;
      }

      const statutLabel = { plein: 'Plein', partiel: 'Partiel', vide: 'Vide' }[statut] || statut;

      this.innerHTML = `
        <div class="cv-head">
          <span class="cv-code">${code}</span>
          <span class="cv-badge" data-statut="${statut}">
            <span class="cv-dot"></span>${statutLabel}
          </span>
        </div>
        <div class="cv-article">${article}</div>
        <div class="cv-visual" style="grid-template-columns: repeat(${cols}, 1fr); grid-template-rows: repeat(${rows}, 1fr);">
          ${bottles}
        </div>
        <div class="cv-foot">
          <span class="cv-mono">${qte}/${capacite}</span>
          <span class="cv-loc">${emplacement}</span>
        </div>
      `;
    }
  }

  customElements.define('cave-casier', CaveCasier);
})();
