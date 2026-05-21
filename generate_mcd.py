"""Génère MCD et MLD en PNG via matplotlib."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# ── Couleurs ──────────────────────────────────────────────────────────────────
C_ENTITY   = "#1565C0"   # bleu entité principale
C_ENTITY2  = "#2E7D32"   # vert entité secondaire
C_ENTITY3  = "#6A1B9A"   # violet entité annexe
C_REL      = "#E65100"   # orange relation
C_TITLE_BG = "#E3F2FD"
C_BG       = "#FAFAFA"

def entity_box(ax, x, y, w, h, title, attrs, color=C_ENTITY, attr_color="#37474F"):
    """Dessine une entité UML-style."""
    # En-tête coloré
    ax.add_patch(FancyBboxPatch((x, y + h*0.62), w, h*0.38,
        boxstyle="round,pad=0.01", fc=color, ec=color, lw=0, zorder=3))
    ax.text(x + w/2, y + h*0.81, title, ha="center", va="center",
            fontsize=7.5, fontweight="bold", color="white", zorder=4)
    # Corps
    ax.add_patch(FancyBboxPatch((x, y), w, h*0.62,
        boxstyle="round,pad=0.01", fc="white", ec=color, lw=1.5, zorder=3))
    step = h * 0.62 / max(len(attrs)+1, 1)
    for i, attr in enumerate(attrs):
        pk = attr.startswith("#")
        fk = attr.endswith("*")
        clean = attr.lstrip("#").rstrip("*")
        ax.text(x + 0.07, y + h*0.62 - step*(i+0.85),
                ("🔑 " if pk else "  ") + clean + (" →" if fk else ""),
                fontsize=5.8, va="center", color="#B71C1C" if pk else attr_color,
                fontstyle="italic" if fk else "normal", zorder=4)

def arrow(ax, x1, y1, x2, y2, label="", color="#546E7A"):
    ax.annotate("", xy=(x2, y2), xytext=(x1, y1),
                arrowprops=dict(arrowstyle="-|>", color=color, lw=1.3),
                zorder=2)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx+0.05, my+0.05, label, fontsize=5.5, color=color,
                ha="center", va="center",
                bbox=dict(fc="white", ec="none", pad=1))

def line(ax, x1, y1, x2, y2, label="", card1="", card2="", color="#546E7A"):
    ax.plot([x1, x2], [y1, y2], color=color, lw=1.2, zorder=2)
    if label:
        mx, my = (x1+x2)/2, (y1+y2)/2
        ax.text(mx, my+0.08, label, fontsize=5.2, color=color,
                ha="center", va="bottom",
                bbox=dict(fc="white", ec="none", pad=1))
    if card1:
        ax.text(x1+(x2-x1)*0.15, y1+(y2-y1)*0.15, card1,
                fontsize=5.5, color=C_REL, ha="center", va="center", fontweight="bold")
    if card2:
        ax.text(x1+(x2-x1)*0.85, y1+(y2-y1)*0.85, card2,
                fontsize=5.5, color=C_REL, ha="center", va="center", fontweight="bold")

# ═══════════════════════════════════════════════════════════════════════════════
#  MCD
# ═══════════════════════════════════════════════════════════════════════════════
def draw_mcd():
    fig, ax = plt.subplots(figsize=(22, 16))
    ax.set_xlim(0, 22); ax.set_ylim(0, 16)
    ax.set_facecolor(C_BG)
    fig.patch.set_facecolor(C_BG)
    ax.axis("off")
    ax.set_title("MCD — Maquis Manager / Cave des Amis",
                 fontsize=14, fontweight="bold", color=C_ENTITY, pad=12)

    W, H = 2.8, 2.2   # largeur/hauteur boîte standard

    # ── Entités et positions ─────────────────────────────────────────────────
    entities = {
        "SITE":        (0.3,  13.0, ["#id", "nom", "prefixeFacture", "dualZonePricing"], C_ENTITY),
        "UTILISATEUR": (0.3,  10.2, ["#username", "nom", "role", "motDePasseHash"], C_ENTITY),
        "CATEGORIE":   (0.3,   7.2, ["#id", "nom", "couleur", "ordre"], C_ENTITY2),
        "ARTICLE":     (3.8,  10.0, ["#id", "article", "siteId*", "cat*",
                                      "prixInt", "prixExt", "frigo", "reserve"], C_ENTITY),
        "COMMANDE":    (7.5,  12.5, ["#id", "siteId*", "client", "date",
                                      "statut", "serveur*", "note"], C_ENTITY),
        "VENTE":       (7.5,   9.5, ["#id", "siteId*", "article*", "serveur*",
                                      "qty", "prix", "packSize", "date",
                                      "factureNumber", "paiement", "remise"], C_ENTITY),
        "CMD_FOURN":   (3.8,   6.8, ["#id", "siteId*", "fournisseur",
                                      "statut", "date"], C_ENTITY2),
        "ENTREE_STOCK":(3.8,   4.0, ["#id", "siteId*", "article*",
                                      "purchaseOrderId*", "qty", "cases",
                                      "caseSize", "fournisseur", "date"], C_ENTITY2),
        "PRIX_FOURN":  (0.3,   4.2, ["#id", "siteId*", "article*",
                                      "fournisseur", "prixUnitaire"], C_ENTITY2),
        "CASIER":      (11.2, 12.0, ["#id", "siteId*", "code", "article*",
                                      "capacite", "quantiteActuelle", "statut"], C_ENTITY3),
        "MVT_CASIER":  (11.2,  9.2, ["#id", "siteId*", "casierId*",
                                      "article*", "type", "quantite",
                                      "source", "user*", "date"], C_ENTITY3),
        "CTRL_STOCK":  (11.2,  6.5, ["#(siteId*,date)", "articles[]", "validePar*"], C_ENTITY3),
        "JOURNAL":     (11.2,  4.5, ["#(siteId*,date)", "recettes",
                                      "charges", "soldeCaisse"], C_ENTITY3),
        "CHARGE":      (14.8, 12.5, ["#id", "siteId*", "libelle",
                                      "montant", "categorie", "date", "user*"], C_ENTITY3),
        "CONSIGNE":    (14.8,  9.8, ["#id", "siteId*", "article*",
                                      "casierCode", "quantite", "client", "date"], C_ENTITY3),
        "CREDIT_REC":  (14.8,  7.2, ["#id", "siteId*", "client",
                                      "montant", "factures[]", "date"], C_ENTITY3),
        "PLANNING":    (18.4, 12.5, ["#id", "siteId*", "username*",
                                      "date", "heureDebut", "heureFin"], C_ENTITY2),
        "AUDIT":       (18.4,  9.8, ["#id", "siteId*", "username*",
                                      "action", "details", "date"], C_ENTITY2),
    }

    coords = {}
    for name, (x, y, attrs, color) in entities.items():
        entity_box(ax, x, y, W, H, name, attrs, color)
        cx, cy = x + W/2, y + H/2
        coords[name] = (x, y, W, H, cx, cy)

    def mid_edge(name, side):
        x, y, w, h, cx, cy = coords[name]
        if side == "right":  return (x+w, cy)
        if side == "left":   return (x,   cy)
        if side == "top":    return (cx,  y+h)
        if side == "bottom": return (cx,  y)

    # ── Relations ─────────────────────────────────────────────────────────────
    rels = [
        ("SITE",       "right",  "ARTICLE",     "left",   "possède",  "1,1","1,N"),
        ("SITE",       "right",  "COMMANDE",    "left",   "ouvre",    "1,1","1,N"),
        ("SITE",       "right",  "VENTE",       "left",   "enregistre","1,1","1,N"),
        ("CATEGORIE",  "right",  "ARTICLE",     "left",   "classifie","1,1","1,N"),
        ("UTILISATEUR","right",  "VENTE",       "left",   "réalise",  "1,1","0,N"),
        ("ARTICLE",    "right",  "VENTE",       "left",   "vendu dans","1,1","0,N"),
        ("COMMANDE",   "bottom", "VENTE",       "top",    "contient", "1,1","0,N"),
        ("ARTICLE",    "bottom", "ENTREE_STOCK","top",    "reçu via", "1,1","0,N"),
        ("CMD_FOURN",  "bottom", "ENTREE_STOCK","top",    "génère",   "1,1","0,1"),
        ("ARTICLE",    "left",   "PRIX_FOURN",  "right",  "tarifié",  "1,1","0,N"),
        ("ARTICLE",    "right",  "CASIER",      "left",   "stocké dans","1,1","0,N"),
        ("CASIER",     "bottom", "MVT_CASIER",  "top",    "mouvement","1,1","1,N"),
        ("SITE",       "right",  "CTRL_STOCK",  "left",   "clôture",  "1,1","0,N"),
        ("SITE",       "right",  "JOURNAL",     "left",   "journal",  "1,1","0,N"),
        ("SITE",       "right",  "CHARGE",      "left",   "dépense",  "1,1","0,N"),
        ("ARTICLE",    "right",  "CONSIGNE",    "left",   "consignée","1,1","0,N"),
        ("SITE",       "right",  "CREDIT_REC",  "left",   "recouvre", "1,1","0,N"),
        ("UTILISATEUR","right",  "PLANNING",    "left",   "planifié", "1,1","0,N"),
        ("UTILISATEUR","right",  "AUDIT",       "left",   "audité",   "1,1","0,N"),
    ]

    for (e1, s1, e2, s2, lbl, c1, c2) in rels:
        p1 = mid_edge(e1, s1)
        p2 = mid_edge(e2, s2)
        line(ax, p1[0], p1[1], p2[0], p2[1], lbl, c1, c2, "#78909C")

    # Légende
    legend = [
        mpatches.Patch(fc=C_ENTITY,  label="Entités principales"),
        mpatches.Patch(fc=C_ENTITY2, label="Entités opérationnelles"),
        mpatches.Patch(fc=C_ENTITY3, label="Entités annexes"),
    ]
    ax.legend(handles=legend, loc="lower right", fontsize=8, framealpha=0.9)
    ax.text(0.2, 0.3, "🔑 = clé primaire   → = clé étrangère   (x,y) = cardinalités",
            fontsize=7, color="#546E7A")

    plt.tight_layout()
    out = os.path.join(OUT_DIR, "MCD_Maquis_Manager.png")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"MCD sauvegardé : {out}")

# ═══════════════════════════════════════════════════════════════════════════════
#  MLD
# ═══════════════════════════════════════════════════════════════════════════════
def draw_mld():
    tables = [
        ("SITE",           ["#id", "nom", "prefixeFacture", "dualZonePricing", "adresse"],                     C_ENTITY),
        ("UTILISATEUR",    ["#username", "nom", "role", "motDePasseHash", "siteId→SITE"],                       C_ENTITY),
        ("CATEGORIE",      ["#id", "nom", "couleur", "ordre"],                                                  C_ENTITY2),
        ("ARTICLE",        ["#id", "article", "siteId→SITE", "cat→CATEGORIE",
                             "prixInterieur", "prixExterieur", "frigo",
                             "reserve", "entrees", "sorties", "alerteMin"],                                     C_ENTITY),
        ("COMMANDE",       ["#id", "siteId→SITE", "client", "date",
                             "statut", "serveur→UTILISATEUR", "note", "createdAt"],                             C_ENTITY),
        ("VENTE",          ["#id", "siteId→SITE", "article→ARTICLE",
                             "sourceOrderId→COMMANDE", "serveur→UTILISATEUR",
                             "qty", "packSize", "prix", "remise",
                             "date", "factureNumber", "paiement",
                             "client", "location", "debiteur"],                                                 C_ENTITY),
        ("CMD_FOURNISSEUR", ["#id", "siteId→SITE", "fournisseur", "statut",
                              "date", "articles[]", "createdBy→UTILISATEUR"],                                   C_ENTITY2),
        ("ENTREE_STOCK",   ["#id", "siteId→SITE", "article→ARTICLE",
                             "purchaseOrderId→CMD_FOURNISSEUR",
                             "qty", "cases", "caseSize", "fournisseur", "date",
                             "user→UTILISATEUR"],                                                               C_ENTITY2),
        ("PRIX_FOURNISSEUR",["#id", "siteId→SITE", "article→ARTICLE",
                              "fournisseur", "prixUnitaire", "prixCasse", "updatedAt"],                         C_ENTITY2),
        ("CASIER",         ["#id", "siteId→SITE", "code", "article→ARTICLE",
                             "capacite", "quantiteActuelle", "bouteillesVides",
                             "statut", "createdAt", "lastMoveAt"],                                              C_ENTITY3),
        ("MVT_CASIER",     ["#id", "siteId→SITE", "casierId→CASIER",
                             "article→ARTICLE", "type", "quantite",
                             "source", "motif", "user→UTILISATEUR", "date"],                                    C_ENTITY3),
        ("CONTROLE_STOCK", ["#siteId→SITE", "#date", "articles[]",
                             "validePar→UTILISATEUR", "createdAt"],                                             C_ENTITY3),
        ("JOURNAL_JOUR",   ["#siteId→SITE", "#date", "recettes",
                             "charges", "soldeCaisse", "note",
                             "cloturePar→UTILISATEUR"],                                                         C_ENTITY3),
        ("CHARGE",         ["#id", "siteId→SITE", "libelle", "montant",
                             "categorie", "date", "user→UTILISATEUR"],                                         C_ENTITY3),
        ("CONSIGNE",       ["#id", "siteId→SITE", "article→ARTICLE",
                             "casierCode", "quantite", "client",
                             "statut", "date", "renduAt", "user→UTILISATEUR"],                                  C_ENTITY3),
        ("CREDIT_RECOVERY",["#id", "siteId→SITE", "client", "montant",
                             "factures[]", "date", "encaissePar→UTILISATEUR"],                                  C_ENTITY3),
        ("PLANNING",       ["#id", "siteId→SITE", "username→UTILISATEUR",
                             "date", "heureDebut", "heureFin", "poste"],                                        C_ENTITY2),
        ("AUDIT_PERSONNEL",["#id", "siteId→SITE", "username→UTILISATEUR",
                             "action", "details", "date"],                                                      C_ENTITY2),
    ]

    ncols = 4
    nrows = -(-len(tables) // ncols)
    fig_w = ncols * 5.5
    fig_h = nrows * 5.0

    fig, axes = plt.subplots(nrows, ncols, figsize=(fig_w, fig_h))
    fig.patch.set_facecolor(C_BG)
    fig.suptitle("MLD — Maquis Manager / Cave des Amis",
                 fontsize=15, fontweight="bold", color=C_ENTITY, y=1.01)

    axes_flat = axes.flatten() if hasattr(axes, "flatten") else [axes]

    for i, (name, attrs, color) in enumerate(tables):
        ax = axes_flat[i]
        ax.set_facecolor(C_BG)
        ax.set_xlim(0, 1); ax.set_ylim(0, 1)
        ax.axis("off")

        # En-tête
        ax.add_patch(FancyBboxPatch((0.02, 0.82), 0.96, 0.16,
            boxstyle="round,pad=0.01", fc=color, ec=color, lw=0))
        ax.text(0.5, 0.90, name, ha="center", va="center",
                fontsize=9, fontweight="bold", color="white")

        # Corps
        n = len(attrs)
        row_h = min(0.78 / max(n, 1), 0.11)
        ax.add_patch(FancyBboxPatch((0.02, 0.82 - n*row_h - 0.02), 0.96, n*row_h + 0.02,
            boxstyle="round,pad=0.01", fc="white", ec=color, lw=1.5))

        for j, attr in enumerate(attrs):
            pk  = attr.startswith("#")
            fk  = "→" in attr
            txt = attr.lstrip("#")
            ypos = 0.82 - (j + 0.6) * row_h
            style = dict(fontsize=7.5, va="center")
            if pk:
                style.update(color="#B71C1C", fontweight="bold")
                prefix = "PK  "
            elif fk:
                style.update(color="#1565C0", fontstyle="italic")
                prefix = "FK  "
            else:
                style.update(color="#37474F")
                prefix = "      "
            ax.text(0.08, ypos, prefix + txt, **style)

    # Masquer les axes inutilisés
    for i in range(len(tables), len(axes_flat)):
        axes_flat[i].set_visible(False)

    # Légende globale
    legend = [
        mpatches.Patch(fc=C_ENTITY,  label="Entités principales"),
        mpatches.Patch(fc=C_ENTITY2, label="Entités opérationnelles"),
        mpatches.Patch(fc=C_ENTITY3, label="Entités annexes"),
        mpatches.Patch(fc="#B71C1C", label="PK = clé primaire"),
        mpatches.Patch(fc="#1565C0", label="FK = clé étrangère"),
    ]
    fig.legend(handles=legend, loc="lower center", ncol=5,
               fontsize=8, framealpha=0.9, bbox_to_anchor=(0.5, -0.01))

    plt.tight_layout()
    out = os.path.join(OUT_DIR, "MLD_Maquis_Manager.png")
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()
    print(f"MLD sauvegardé : {out}")

if __name__ == "__main__":
    draw_mcd()
    draw_mld()
    print("Terminé.")
