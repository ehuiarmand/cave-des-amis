"""
=============================================================================
APPLICATION GRAPHIQUE — DÉMONSTRATION SÉCURISATION TECHNIQUE
bcrypt (hachage mots de passe) + AES-256-GCM (chiffrement données)
INPHB IC 2026
=============================================================================
"""
import tkinter as tk
from tkinter import ttk, messagebox
import os, base64, threading, time
import bcrypt
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import load_dotenv

load_dotenv()

# ── Palette ────────────────────────────────────────────────────────────────────
VERT        = "#1a5c38"
VERT_CLAIR  = "#2e7d52"
VERT_BG     = "#e8f5e0"
ORANGE      = "#c85a0a"
ORANGE_BG   = "#fff3e0"
ROUGE       = "#c62828"
ROUGE_BG    = "#fdecea"
BLEU        = "#1565c0"
BLEU_BG     = "#e3f2fd"
BLANC       = "#ffffff"
GRIS_BG     = "#f5f5f5"
GRIS_BORDER = "#dddddd"
GRIS_TXT    = "#212121"
GRIS_LIGHT  = "#757575"
NOIR        = "#000000"

F_TITRE  = ("Segoe UI", 11, "bold")
F_NORMAL = ("Segoe UI", 10)
F_SMALL  = ("Segoe UI", 9)
F_MONO   = ("Consolas", 9)
F_GRAND  = ("Segoe UI", 13, "bold")

# ── Clé AES ────────────────────────────────────────────────────────────────────
def charger_cle():
    k = os.environ.get("AES_SECRET_KEY")
    if k:
        cle = base64.b64decode(k)
        if len(cle) == 32: return cle
    cle = AESGCM.generate_key(bit_length=256)
    with open(".env", "a") as f:
        f.write(f"\nAES_SECRET_KEY={base64.b64encode(cle).decode()}\n")
    return cle

CLE_AES = charger_cle()

# ══════════════════════════════════════════════════════════════════════════════
# WIDGETS UTILITAIRES
# ══════════════════════════════════════════════════════════════════════════════

class Btn(tk.Button):
    def __init__(self, p, bg=VERT, fg=BLANC, **kw):
        super().__init__(p, bg=bg, fg=fg, font=F_TITRE,
                         relief="flat", bd=0, padx=18, pady=8,
                         cursor="hand2",
                         activebackground=VERT_CLAIR if bg==VERT else "#a04808",
                         activeforeground=BLANC, **kw)
        hover = VERT_CLAIR if bg == VERT else "#a04808"
        self.bind("<Enter>", lambda e: self.config(bg=hover))
        self.bind("<Leave>", lambda e: self.config(bg=bg))

class Champ(tk.Frame):
    def __init__(self, p, label, masquer=False, mono=False, **kw):
        super().__init__(p, bg=BLANC)
        tk.Label(self, text=label, font=F_SMALL,
                 bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w")
        self.var = tk.StringVar()
        fn = F_MONO if mono else F_NORMAL
        self.entry = tk.Entry(self, textvariable=self.var, font=fn,
                              show="●" if masquer else "",
                              relief="solid", bd=1,
                              highlightthickness=2,
                              highlightbackground=GRIS_BORDER,
                              highlightcolor=VERT,
                              bg=BLANC, fg=GRIS_TXT, **kw)
        self.entry.pack(fill="x", ipady=6)
    def get(self):    return self.var.get().strip()
    def set(self, v): self.var.set(v)
    def clear(self):  self.var.set("")

class ZoneResultat(tk.Frame):
    """Zone affichant un résultat avec icône, couleur et texte monospace."""
    def __init__(self, p, **kw):
        super().__init__(p, bg=GRIS_BG, relief="solid", bd=1, **kw)
        self._icone = tk.Label(self, font=("Segoe UI", 18),
                               bg=GRIS_BG, fg=GRIS_LIGHT)
        self._icone.pack(side="left", padx=(12,6), pady=8)
        right = tk.Frame(self, bg=GRIS_BG)
        right.pack(side="left", fill="both", expand=True, pady=8, padx=(0,10))
        self._label = tk.Label(right, text="", font=F_SMALL,
                               bg=GRIS_BG, fg=GRIS_LIGHT, anchor="w")
        self._label.pack(anchor="w")
        self._valeur = tk.Text(right, font=F_MONO, height=2,
                               bg=GRIS_BG, fg=GRIS_TXT,
                               relief="flat", bd=0, wrap="char",
                               state="disabled", cursor="arrow")
        self._valeur.pack(fill="x")

    def afficher(self, icone, label, valeur, bg=GRIS_BG, fg=GRIS_TXT):
        self.config(bg=bg)
        self._icone.config(text=icone, bg=bg)
        self._label.config(text=label, bg=bg, fg=fg)
        self._valeur.config(state="normal", bg=bg, fg=fg)
        self._valeur.delete("1.0", "end")
        self._valeur.insert("1.0", valeur)
        self._valeur.config(state="disabled")

class Separateur(tk.Frame):
    def __init__(self, p, c=GRIS_BORDER, **kw):
        super().__init__(p, bg=c, height=1, **kw)

class Badge(tk.Label):
    def __init__(self, p, texte, bg, fg=BLANC, **kw):
        super().__init__(p, text=texte, font=F_SMALL,
                         bg=bg, fg=fg, padx=8, pady=2, **kw)

# ══════════════════════════════════════════════════════════════════════════════
# APPLICATION PRINCIPALE
# ══════════════════════════════════════════════════════════════════════════════

class AppDemo(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Sécurisation Technique — bcrypt & AES-256-GCM | INPHB IC 2026")
        self.geometry("980x700")
        self.minsize(860, 620)
        self.configure(bg=GRIS_BG)
        self.resizable(True, True)

        # Centrer
        self.update_idletasks()
        x = (self.winfo_screenwidth()  - 980) // 2
        y = (self.winfo_screenheight() - 700) // 2
        self.geometry(f"980x700+{x}+{y}")

        self._construire_ui()

    # ── Construction de l'interface ───────────────────────────────────────────
    def _construire_ui(self):
        # ── En-tête ───────────────────────────────────────────────────────────
        entete = tk.Frame(self, bg=VERT, height=64)
        entete.pack(fill="x")
        entete.pack_propagate(False)

        tk.Label(entete, text="🔐", font=("Segoe UI", 22),
                 bg=VERT, fg=BLANC).pack(side="left", padx=(16, 6), pady=10)
        gauche_hdr = tk.Frame(entete, bg=VERT)
        gauche_hdr.pack(side="left", pady=10)
        tk.Label(gauche_hdr, text="Sécurisation Technique — Étape 3",
                 font=("Segoe UI", 14, "bold"), bg=VERT, fg=BLANC).pack(anchor="w")
        tk.Label(gauche_hdr, text="bcrypt  •  AES-256-GCM  •  ANSSI",
                 font=F_SMALL, bg=VERT, fg="#c9d9b0").pack(anchor="w")

        tk.Label(entete, text="INPHB / EFSPC — IC 2026",
                 font=F_SMALL, bg=VERT, fg="#c9d9b0").pack(side="right", padx=20)

        tk.Frame(self, bg=ORANGE, height=3).pack(fill="x")

        # ── Onglets ───────────────────────────────────────────────────────────
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TNotebook",        background=GRIS_BG, borderwidth=0)
        style.configure("TNotebook.Tab",    font=F_TITRE, padding=[16, 8],
                        background=GRIS_BG, foreground=GRIS_LIGHT)
        style.map("TNotebook.Tab",
                  background=[("selected", BLANC)],
                  foreground=[("selected", VERT)])

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True, padx=0, pady=0)

        # Onglet 1 : bcrypt
        onglet1 = tk.Frame(nb, bg=BLANC)
        nb.add(onglet1, text="  🔑  Partie 1 — Hachage bcrypt  ")
        self._onglet_bcrypt(onglet1)

        # Onglet 2 : AES
        onglet2 = tk.Frame(nb, bg=BLANC)
        nb.add(onglet2, text="  🔒  Partie 2 — Chiffrement AES-256-GCM  ")
        self._onglet_aes(onglet2)

        # Onglet 3 : Comparaison
        onglet3 = tk.Frame(nb, bg=BLANC)
        nb.add(onglet3, text="  📊  Résumé & Comparaison  ")
        self._onglet_resume(onglet3)

    # ══════════════════════════════════════════════════════════════════════════
    # ONGLET 1 — HACHAGE BCRYPT
    # ══════════════════════════════════════════════════════════════════════════
    def _onglet_bcrypt(self, parent):
        # Deux colonnes
        parent.columnconfigure(0, weight=1)
        parent.columnconfigure(1, weight=1)
        parent.rowconfigure(0, weight=1)

        # ── Colonne gauche : HACHAGE ──────────────────────────────────────────
        gauche = tk.Frame(parent, bg=BLANC)
        gauche.grid(row=0, column=0, sticky="nsew", padx=(20,10), pady=16)

        self._section_titre(gauche, "🔑", "Hacher un mot de passe", VERT)

        tk.Label(gauche,
                 text="Saisissez un mot de passe → bcrypt génère un hachage unique\n"
                      "avec sel aléatoire intégré (rounds=12, recommandation ANSSI).",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT, justify="left",
                 wraplength=380).pack(anchor="w", pady=(0, 12))

        self._mdp_hachage = Champ(gauche, "Mot de passe à hacher", masquer=True, width=40)
        self._mdp_hachage.pack(fill="x", pady=(0, 6))

        # Facteur de coût
        fc_frame = tk.Frame(gauche, bg=BLANC)
        fc_frame.pack(fill="x", pady=(0, 12))
        tk.Label(fc_frame, text="Facteur de coût (rounds) :",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(side="left")
        self._rounds_var = tk.IntVar(value=12)
        for v, lbl in [(10,"10 (min)"), (12,"12 (conseillé)"), (14,"14 (fort)")]:
            tk.Radiobutton(fc_frame, text=lbl, variable=self._rounds_var,
                           value=v, bg=BLANC, font=F_SMALL,
                           activebackground=BLANC,
                           fg=VERT if v==12 else GRIS_TXT).pack(side="left", padx=4)

        self._btn_hacher = Btn(gauche, text="Hacher le mot de passe →",
                               command=self._hacher)
        self._btn_hacher.pack(anchor="w", pady=(0, 10))

        # Barre de progression (bcrypt est lent intentionnellement)
        self._prog_var = tk.DoubleVar()
        self._prog = ttk.Progressbar(gauche, variable=self._prog_var,
                                     maximum=100, mode="indeterminate",
                                     length=380)
        self._prog.pack(fill="x", pady=(0, 8))
        self._prog_lbl = tk.Label(gauche, text="", font=F_SMALL,
                                  bg=BLANC, fg=GRIS_LIGHT)
        self._prog_lbl.pack(anchor="w")

        # Résultat hachage
        tk.Label(gauche, text="Résultat :", font=F_TITRE,
                 bg=BLANC, fg=GRIS_TXT).pack(anchor="w", pady=(8, 2))
        self._res_hachage = ZoneResultat(gauche)
        self._res_hachage.pack(fill="x", pady=(0, 8))

        # Anatomie du hachage
        self._anatomie_frame = tk.Frame(gauche, bg=GRIS_BG,
                                        relief="solid", bd=1)
        self._anatomie_frame.pack(fill="x", pady=(0, 8))

        Separateur(gauche).pack(fill="x", pady=8)

        # ── Preuve unicité du sel ──────────────────────────────────────────────
        self._section_titre(gauche, "🧪", "Preuve : chaque hachage est unique", BLEU)
        tk.Label(gauche,
                 text="Même mot de passe haché deux fois = résultats différents (sel aléatoire).",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", pady=(0, 6))

        Btn(gauche, text="Générer 2 hachages du même mot de passe", bg=BLEU,
            command=self._prouver_sel).pack(anchor="w", pady=(0, 6))
        self._res_sel1 = ZoneResultat(gauche)
        self._res_sel1.pack(fill="x", pady=(0, 4))
        self._res_sel2 = ZoneResultat(gauche)
        self._res_sel2.pack(fill="x")

        # ── Colonne droite : VÉRIFICATION ─────────────────────────────────────
        droite = tk.Frame(parent, bg=BLANC)
        droite.grid(row=0, column=1, sticky="nsew", padx=(10,20), pady=16)

        self._section_titre(droite, "✅", "Vérifier un mot de passe", ORANGE)

        tk.Label(droite,
                 text="bcrypt compare le mot de passe saisi avec le hachage stocké\n"
                      "sans jamais déchiffrer — comparaison en temps constant (anti timing attack).",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT, justify="left",
                 wraplength=380).pack(anchor="w", pady=(0, 12))

        self._mdp_verif = Champ(droite, "Mot de passe à vérifier", masquer=True, width=40)
        self._mdp_verif.pack(fill="x", pady=(0, 6))

        tk.Label(droite, text="Hachage stocké en BDD :", font=F_SMALL,
                 bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w")
        self._hachage_bdd = tk.Text(droite, font=F_MONO, height=3,
                                     relief="solid", bd=1, fg=GRIS_TXT,
                                     bg=BLANC, wrap="char")
        self._hachage_bdd.pack(fill="x", pady=(0, 2))
        tk.Label(droite, text="(copié automatiquement depuis le hachage généré à gauche)",
                 font=("Segoe UI", 8), bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", pady=(0, 10))

        Btn(droite, text="Vérifier →", bg=ORANGE, command=self._verifier).pack(anchor="w", pady=(0, 10))

        self._res_verif = ZoneResultat(droite)
        self._res_verif.pack(fill="x", pady=(0, 12))

        # ── Explication anatomique ─────────────────────────────────────────────
        Separateur(droite).pack(fill="x", pady=8)
        self._section_titre(droite, "🔬", "Anatomie du hachage bcrypt", VERT)

        anatomie = [
            ("$2b$", VERT,   "Version de bcrypt"),
            ("12$",  ORANGE, "Facteur de coût (rounds)"),
            ("xxx…", BLEU,   "Sel aléatoire (22 chars)"),
            ("yyy…", ROUGE,  "Hachage résultant (31 chars)"),
        ]
        for val, couleur, desc in anatomie:
            row = tk.Frame(droite, bg=BLANC)
            row.pack(fill="x", pady=2)
            tk.Label(row, text=val, font=F_MONO, bg=couleur, fg=BLANC,
                     padx=6, pady=2).pack(side="left")
            tk.Label(row, text=f"  →  {desc}", font=F_SMALL,
                     bg=BLANC, fg=GRIS_TXT).pack(side="left")

    # ── Actions bcrypt ─────────────────────────────────────────────────────────
    def _hacher(self):
        mdp = self._mdp_hachage.get()
        if not mdp:
            messagebox.showwarning("Champ vide", "Saisissez un mot de passe.")
            return

        self._btn_hacher.config(state="disabled", text="Calcul en cours…")
        self._prog.start(10)
        self._prog_lbl.config(text=f"bcrypt calcule 2^{self._rounds_var.get()} itérations… (normal, c'est intentionnellement lent)")

        rounds = self._rounds_var.get()

        def calcul():
            t0 = time.time()
            sel    = bcrypt.gensalt(rounds=rounds)
            hachage = bcrypt.hashpw(mdp.encode(), sel).decode()
            duree  = time.time() - t0
            self.after(0, lambda: self._afficher_hachage(hachage, duree))

        threading.Thread(target=calcul, daemon=True).start()

    def _afficher_hachage(self, hachage, duree):
        self._prog.stop()
        self._prog_lbl.config(
            text=f"✓ Calculé en {duree:.2f} s  (lenteur voulue : décourage le brute-force)")
        self._btn_hacher.config(state="normal", text="Hacher le mot de passe →")

        self._res_hachage.afficher(
            "✅", "Hachage bcrypt (à stocker en BDD — JAMAIS le mot de passe en clair) :",
            hachage, bg=VERT_BG, fg=VERT)

        # Copier dans la zone de vérification
        self._hachage_bdd.delete("1.0", "end")
        self._hachage_bdd.insert("1.0", hachage)

        # Anatomie
        for w in self._anatomie_frame.winfo_children():
            w.destroy()
        try:
            parties = hachage.split("$")  # ['', '2b', '12', 'sel+hash']
            version = f"${parties[1]}$"
            cout    = f"{parties[2]}$"
            sel_txt = parties[3][:22] if len(parties) > 3 else ""
            hash_txt= parties[3][22:] if len(parties) > 3 else ""

            tk.Label(self._anatomie_frame,
                     text="Décomposition du hachage :",
                     font=F_SMALL, bg=GRIS_BG, fg=GRIS_LIGHT
                     ).pack(anchor="w", padx=8, pady=(6,2))

            ligne = tk.Frame(self._anatomie_frame, bg=GRIS_BG)
            ligne.pack(padx=8, pady=(0,8), anchor="w")
            for txt, bg in [(version, VERT), (cout, ORANGE),
                             (sel_txt, BLEU),  (hash_txt, ROUGE)]:
                tk.Label(ligne, text=txt, font=F_MONO, bg=bg, fg=BLANC,
                         padx=4, pady=2).pack(side="left")
        except Exception:
            pass

    def _verifier(self):
        mdp    = self._mdp_verif.get()
        hachage = self._hachage_bdd.get("1.0", "end").strip()
        if not mdp or not hachage:
            messagebox.showwarning("Champs vides",
                "Saisissez un mot de passe ET un hachage.")
            return
        try:
            ok = bcrypt.checkpw(mdp.encode(), hachage.encode())
            if ok:
                self._res_verif.afficher(
                    "✅", "ACCÈS AUTORISÉ — Le mot de passe correspond au hachage.",
                    f"bcrypt.checkpw() → True\nMot de passe correct.",
                    bg=VERT_BG, fg=VERT)
            else:
                self._res_verif.afficher(
                    "❌", "ACCÈS REFUSÉ — Mot de passe incorrect.",
                    f"bcrypt.checkpw() → False\nLe hash ne correspond pas.",
                    bg=ROUGE_BG, fg=ROUGE)
        except Exception as e:
            self._res_verif.afficher("⚠️", "Hachage invalide.",
                str(e), bg=ORANGE_BG, fg=ORANGE)

    def _prouver_sel(self):
        mdp = "test_unicite_sel"
        h1  = bcrypt.hashpw(mdp.encode(), bcrypt.gensalt(rounds=4)).decode()
        h2  = bcrypt.hashpw(mdp.encode(), bcrypt.gensalt(rounds=4)).decode()
        self._res_sel1.afficher("1️⃣", f"Hachage 1 du mot de passe « {mdp} » :",
                                 h1, bg=BLEU_BG, fg=BLEU)
        self._res_sel2.afficher("2️⃣", f"Hachage 2 du même mot de passe :",
                                 h2 + f"\n→ Identiques ? {'OUI ⚠️' if h1==h2 else 'NON ✅  (sel différent à chaque fois)'}",
                                 bg=VERT_BG if h1!=h2 else ROUGE_BG,
                                 fg=VERT if h1!=h2 else ROUGE)

    # ══════════════════════════════════════════════════════════════════════════
    # ONGLET 2 — CHIFFREMENT AES-256-GCM
    # ══════════════════════════════════════════════════════════════════════════
    def _onglet_aes(self, parent):
        parent.columnconfigure(0, weight=1)
        parent.columnconfigure(1, weight=1)
        parent.rowconfigure(0, weight=1)

        # ── Colonne gauche : CHIFFREMENT ──────────────────────────────────────
        gauche = tk.Frame(parent, bg=BLANC)
        gauche.grid(row=0, column=0, sticky="nsew", padx=(20,10), pady=16)

        self._section_titre(gauche, "🔒", "Chiffrer une donnée sensible", VERT)

        tk.Label(gauche,
                 text="Saisissez une donnée médicale → AES-256-GCM la chiffre\n"
                      "avec un nonce aléatoire unique (96 bits) + tag d'intégrité.",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT, justify="left",
                 wraplength=380).pack(anchor="w", pady=(0, 10))

        # Suggestions rapides
        sug_frame = tk.Frame(gauche, bg=BLANC)
        sug_frame.pack(fill="x", pady=(0, 8))
        tk.Label(sug_frame, text="Exemples :", font=F_SMALL,
                 bg=BLANC, fg=GRIS_LIGHT).pack(side="left")
        suggestions = [
            "Diabète type 2",
            "Allergie pénicilline",
            "Groupe sanguin A+",
            "Hypertension artérielle",
        ]
        for sug in suggestions:
            tk.Button(sug_frame, text=sug, font=("Segoe UI", 8),
                      bg=VERT_BG, fg=VERT, relief="flat", padx=6, pady=2,
                      cursor="hand2",
                      command=lambda s=sug: self._donnee_claire.set(s)
                      ).pack(side="left", padx=2)

        self._donnee_claire = Champ(gauche, "Donnée en clair à chiffrer", width=40)
        self._donnee_claire.pack(fill="x", pady=(0, 10))

        # Info clé
        cle_b64 = base64.b64encode(CLE_AES).decode()
        cle_frame = tk.Frame(gauche, bg=GRIS_BG, relief="solid", bd=1)
        cle_frame.pack(fill="x", pady=(0, 10))
        tk.Label(cle_frame, text="🗝️  Clé AES-256 active (fichier .env) :",
                 font=F_SMALL, bg=GRIS_BG, fg=GRIS_LIGHT).pack(anchor="w", padx=8, pady=(4,0))
        tk.Label(cle_frame, text=cle_b64[:44]+"…", font=F_MONO,
                 bg=GRIS_BG, fg=VERT).pack(anchor="w", padx=8, pady=(0,4))

        Btn(gauche, text="Chiffrer (AES-256-GCM) →",
            command=self._chiffrer).pack(anchor="w", pady=(0, 10))

        tk.Label(gauche, text="Résultat stocké en BDD (Base64) :",
                 font=F_TITRE, bg=BLANC, fg=GRIS_TXT).pack(anchor="w", pady=(4,2))
        self._res_chiffre = ZoneResultat(gauche)
        self._res_chiffre.pack(fill="x", pady=(0, 8))

        # Décomposition nonce + chiffré
        self._decomp_frame = tk.Frame(gauche, bg=GRIS_BG, relief="solid", bd=1)
        self._decomp_frame.pack(fill="x", pady=(0, 8))

        Separateur(gauche).pack(fill="x", pady=8)

        # ── Chiffrement multiple : preuve nonce ────────────────────────────────
        self._section_titre(gauche, "🧪", "Preuve : chaque chiffrement est unique", BLEU)
        tk.Label(gauche,
                 text="Même donnée chiffrée deux fois = résultats différents (nonce aléatoire).",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", pady=(0, 6))
        Btn(gauche, text="Chiffrer 2x la même donnée", bg=BLEU,
            command=self._prouver_nonce).pack(anchor="w", pady=(0, 6))
        self._res_nonce1 = ZoneResultat(gauche)
        self._res_nonce1.pack(fill="x", pady=(0, 4))
        self._res_nonce2 = ZoneResultat(gauche)
        self._res_nonce2.pack(fill="x")

        # ── Colonne droite : DÉCHIFFREMENT ────────────────────────────────────
        droite = tk.Frame(parent, bg=BLANC)
        droite.grid(row=0, column=1, sticky="nsew", padx=(10,20), pady=16)

        self._section_titre(droite, "🔓", "Déchiffrer une donnée", ORANGE)

        tk.Label(droite,
                 text="Collez une donnée chiffrée (Base64) → AES-256-GCM la déchiffre\n"
                      "ET vérifie l'intégrité (tag GCM). Toute altération est détectée.",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT, justify="left",
                 wraplength=380).pack(anchor="w", pady=(0, 10))

        tk.Label(droite, text="Donnée chiffrée (Base64 — depuis BDD) :",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w")
        self._input_dechiffre = tk.Text(droite, font=F_MONO, height=3,
                                         relief="solid", bd=1,
                                         fg=GRIS_TXT, bg=BLANC, wrap="char")
        self._input_dechiffre.pack(fill="x", pady=(0, 2))
        tk.Label(droite,
                 text="(copié automatiquement depuis le chiffrement à gauche)",
                 font=("Segoe UI", 8), bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", pady=(0, 10))

        Btn(droite, text="Déchiffrer →", bg=ORANGE,
            command=self._dechiffrer).pack(anchor="w", pady=(0, 10))

        self._res_dechiffre = ZoneResultat(droite)
        self._res_dechiffre.pack(fill="x", pady=(0, 12))

        # ── Test d'altération ──────────────────────────────────────────────────
        Separateur(droite).pack(fill="x", pady=8)
        self._section_titre(droite, "⚠️", "Test d'intégrité GCM", ROUGE)

        tk.Label(droite,
                 text="Si les données sont altérées (bit flipping, injection SQL…),\n"
                      "le tag GCM détecte immédiatement la corruption.",
                 font=F_SMALL, bg=BLANC, fg=GRIS_LIGHT, justify="left",
                 wraplength=380).pack(anchor="w", pady=(0, 8))

        Btn(droite, text="Simuler une altération des données", bg=ROUGE,
            command=self._tester_integrite).pack(anchor="w", pady=(0, 8))

        self._res_integrite = ZoneResultat(droite)
        self._res_integrite.pack(fill="x", pady=(0, 8))

        # ── Explication AES-GCM ────────────────────────────────────────────────
        Separateur(droite).pack(fill="x", pady=8)
        self._section_titre(droite, "🔬", "Structure du chiffré stocké", VERT)

        struct = [
            ("Nonce (12o)",   VERT,   "Nombre aléatoire unique — non secret, stocké avec le chiffré"),
            ("Chiffré",       ORANGE, "Données chiffrées par AES en mode compteur"),
            ("Tag (16o)",     ROUGE,  "Signature d'intégrité GCM — détecte toute modification"),
        ]
        for val, couleur, desc in struct:
            row = tk.Frame(droite, bg=BLANC)
            row.pack(fill="x", pady=2)
            tk.Label(row, text=val, font=F_MONO, bg=couleur, fg=BLANC,
                     padx=6, pady=2, width=12, anchor="center").pack(side="left")
            tk.Label(row, text=f"  {desc}", font=F_SMALL,
                     bg=BLANC, fg=GRIS_TXT, wraplength=280,
                     justify="left").pack(side="left")

    # ── Actions AES ────────────────────────────────────────────────────────────
    def _chiffrer(self):
        texte = self._donnee_claire.get()
        if not texte:
            messagebox.showwarning("Champ vide", "Saisissez une donnée à chiffrer.")
            return
        aesgcm  = AESGCM(CLE_AES)
        nonce   = os.urandom(12)
        chiffre = aesgcm.encrypt(nonce, texte.encode(), None)
        resultat = base64.b64encode(nonce + chiffre).decode()

        self._res_chiffre.afficher(
            "🔒",
            "Donnée chiffrée AES-256-GCM (Base64) — illisible sans la clé :",
            resultat, bg=VERT_BG, fg=VERT)

        self._input_dechiffre.delete("1.0", "end")
        self._input_dechiffre.insert("1.0", resultat)

        # Décomposition
        for w in self._decomp_frame.winfo_children():
            w.destroy()
        nonce_b64  = base64.b64encode(nonce).decode()
        chiffre_b64 = base64.b64encode(chiffre[:-16]).decode()
        tag_b64    = base64.b64encode(chiffre[-16:]).decode()

        tk.Label(self._decomp_frame, text="Décomposition du chiffré :",
                 font=F_SMALL, bg=GRIS_BG, fg=GRIS_LIGHT).pack(anchor="w", padx=8, pady=(6,2))
        for label, val, couleur in [
            ("Nonce (12 o) :", nonce_b64,   VERT),
            ("Chiffré      :", chiffre_b64, ORANGE),
            ("Tag GCM(16o) :", tag_b64,     ROUGE),
        ]:
            r = tk.Frame(self._decomp_frame, bg=GRIS_BG)
            r.pack(fill="x", padx=8, pady=1)
            tk.Label(r, text=label, font=F_SMALL, bg=GRIS_BG,
                     fg=couleur, width=14, anchor="w").pack(side="left")
            tk.Label(r, text=val[:40]+"…" if len(val)>40 else val,
                     font=F_MONO, bg=GRIS_BG, fg=GRIS_TXT).pack(side="left")
        tk.Frame(self._decomp_frame, bg=GRIS_BG, height=4).pack()

    def _dechiffrer(self):
        b64 = self._input_dechiffre.get("1.0", "end").strip()
        if not b64:
            messagebox.showwarning("Vide", "Collez une donnée chiffrée.")
            return
        try:
            aesgcm = AESGCM(CLE_AES)
            brut   = base64.b64decode(b64)
            nonce  = brut[:12]
            clair  = aesgcm.decrypt(nonce, brut[12:], None).decode()
            self._res_dechiffre.afficher(
                "🔓", "Donnée déchiffrée avec succès ✅  (intégrité GCM vérifiée) :",
                clair, bg=VERT_BG, fg=VERT)
        except Exception:
            self._res_dechiffre.afficher(
                "❌", "Déchiffrement impossible — données altérées ou clé incorrecte.",
                "cryptography.exceptions.InvalidTag\n"
                "Le tag GCM ne correspond pas : données corrompues ou clé différente.",
                bg=ROUGE_BG, fg=ROUGE)

    def _prouver_nonce(self):
        texte = "Diabète type 2, allergie pénicilline"
        def enc():
            aesgcm = AESGCM(CLE_AES)
            n = os.urandom(12)
            c = aesgcm.encrypt(n, texte.encode(), None)
            return base64.b64encode(n + c).decode()
        e1, e2 = enc(), enc()
        self._res_nonce1.afficher("1️⃣", f"Chiffré 1 : « {texte} »",
                                   e1, bg=BLEU_BG, fg=BLEU)
        self._res_nonce2.afficher("2️⃣", "Chiffré 2 — même donnée, résultat différent :",
                                   e2 + f"\n→ Identiques ? {'OUI ⚠️' if e1==e2 else 'NON ✅  (nonce différent à chaque fois)'}",
                                   bg=VERT_BG if e1!=e2 else ROUGE_BG,
                                   fg=VERT if e1!=e2 else ROUGE)

    def _tester_integrite(self):
        texte = "Données médicales sensibles"
        aesgcm  = AESGCM(CLE_AES)
        nonce   = os.urandom(12)
        chiffre = aesgcm.encrypt(nonce, texte.encode(), None)
        b64_original = base64.b64encode(nonce + chiffre).decode()

        # Altérer 1 octet au milieu
        brut_altere = bytearray(nonce + chiffre)
        idx = len(brut_altere) // 2
        brut_altere[idx] ^= 0xFF
        b64_altere = base64.b64encode(bytes(brut_altere)).decode()

        try:
            aesgcm.decrypt(nonce, bytes(brut_altere)[12:], None)
            msg = "Aucune erreur détectée (inattendu)"
            bg, fg = ORANGE_BG, ORANGE
        except Exception:
            msg = ("✅  Altération détectée par le tag GCM !\n"
                   "InvalidTag — 1 seul bit modifié suffit à invalider le déchiffrement.\n"
                   "Les données altérées sont REJETÉES automatiquement.")
            bg, fg = VERT_BG, VERT

        self._res_integrite.afficher("🛡️",
            "Résultat du test d'altération (1 octet modifié) :", msg, bg=bg, fg=fg)

    # ══════════════════════════════════════════════════════════════════════════
    # ONGLET 3 — RÉSUMÉ
    # ══════════════════════════════════════════════════════════════════════════
    def _onglet_resume(self, parent):
        canvas = tk.Canvas(parent, bg=BLANC, highlightthickness=0)
        scroll = ttk.Scrollbar(parent, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        canvas.pack(fill="both", expand=True)

        frame = tk.Frame(canvas, bg=BLANC)
        win   = canvas.create_window((0,0), window=frame, anchor="nw")
        canvas.bind("<Configure>",
                    lambda e: canvas.itemconfig(win, width=e.width))
        frame.bind("<Configure>",
                   lambda e: canvas.configure(scrollregion=canvas.bbox("all")))

        inner = tk.Frame(frame, bg=BLANC)
        inner.pack(fill="x", padx=24, pady=16)

        # Tableau comparatif
        self._section_titre(inner, "📊", "Comparaison des deux techniques", VERT)
        tk.Label(inner, text="", bg=BLANC).pack()

        headers = ["Critère", "Hachage bcrypt", "Chiffrement AES-256-GCM"]
        rows = [
            ["Réversible ?",          "❌ Non (sens unique)",    "✅ Oui (avec la clé)"],
            ["Utilisé pour",          "Mots de passe",           "Données à relire"],
            ["Clé nécessaire ?",      "Non",                     "Oui (AES_SECRET_KEY)"],
            ["Sel / Nonce",           "Sel intégré automatique", "Nonce 96 bits par opération"],
            ["Intégrité garantie ?",  "Non applicable",          "✅ Oui (tag GCM 128 bits)"],
            ["Standard",              "ANSSI, NIST recommandé",  "NIST FIPS 197 + SP 800-38D"],
            ["BDD volée ?",           "MDP introuvable",         "Données illisibles sans clé"],
            ["Résistance brute-force","✅ Lent par design",       "✅ 2^256 combinaisons"],
        ]

        colW = [220, 220, 240]
        hdr_row = tk.Frame(inner, bg=BLANC)
        hdr_row.pack(fill="x")
        for h, w in zip(headers, colW):
            tk.Label(hdr_row, text=h, font=F_TITRE, bg=VERT, fg=BLANC,
                     width=w//7, anchor="center", padx=8, pady=6,
                     relief="solid", bd=1).pack(side="left", padx=1)

        for i, row in enumerate(rows):
            bg = BLANC if i % 2 == 0 else GRIS_BG
            r = tk.Frame(inner, bg=BLANC)
            r.pack(fill="x")
            colors = [bg, bg, bg]
            for j, (cell, w) in enumerate(zip(row, colW)):
                c = colors[j]
                tk.Label(r, text=cell, font=F_NORMAL, bg=c, fg=GRIS_TXT,
                         width=w//7, anchor="w", padx=8, pady=5,
                         relief="solid", bd=1,
                         wraplength=w-20).pack(side="left", padx=1)

        tk.Label(inner, text="", bg=BLANC).pack(pady=4)
        Separateur(inner).pack(fill="x", pady=8)

        # Récapitulatif sécurité
        self._section_titre(inner, "🏥", "Profil médical — ce qui est stocké en BDD", ORANGE)
        tk.Label(inner, text="", bg=BLANC).pack()

        champs_bdd = [
            ("nom",                  "Kouassi Jean-Baptiste",  BLANC,   "En clair (non sensible)"),
            ("email",                "jb.kouassi@inphb.ci",    BLANC,   "En clair (identifiant)"),
            ("mot_de_passe",         "$2b$12$xK9m…ZqR",        VERT_BG, "🔑 Hachage bcrypt"),
            ("antecedents_medicaux", "aGX9kzP3mN7q…",          VERT_BG, "🔒 AES-256-GCM chiffré"),
            ("allergies",            "rEGJH45XUdJi…",          VERT_BG, "🔒 AES-256-GCM chiffré"),
            ("traitements",          "mK8pL2nQ9xWe…",          VERT_BG, "🔒 AES-256-GCM chiffré"),
        ]
        for champ_n, valeur, bg, note in champs_bdd:
            r = tk.Frame(inner, bg=BLANC, relief="solid", bd=1)
            r.pack(fill="x", pady=2)
            tk.Label(r, text=champ_n, font=F_MONO, bg=GRIS_BG, fg=VERT,
                     width=24, anchor="w", padx=8, pady=6).pack(side="left")
            tk.Label(r, text=valeur, font=F_MONO, bg=bg, fg=GRIS_TXT,
                     anchor="w", padx=8).pack(side="left", fill="x", expand=True)
            tk.Label(r, text=note, font=F_SMALL, bg=bg, fg=GRIS_LIGHT,
                     padx=8).pack(side="right")

        tk.Label(inner, text="", bg=BLANC).pack(pady=4)
        Separateur(inner).pack(fill="x", pady=8)

        # Note clé AES
        note_cle = tk.Frame(inner, bg=ORANGE_BG, relief="solid", bd=1)
        note_cle.pack(fill="x", pady=4)
        tk.Label(note_cle,
                 text="⚠️  Clé AES — règles de sécurité",
                 font=F_TITRE, bg=ORANGE_BG, fg=ORANGE).pack(anchor="w", padx=12, pady=(8,2))
        for regel in [
            "✅  Stockée dans le fichier .env (chargé via python-dotenv)",
            "✅  En production : HashiCorp Vault, AWS Secrets Manager, Azure Key Vault",
            "❌  JAMAIS dans le code source (Git l'exposerait publiquement)",
            "❌  JAMAIS dans la base de données (compromettrait tous les chiffrés)",
            "✅  Ajouter .env dans .gitignore pour ne pas la committer",
        ]:
            tk.Label(note_cle, text=f"  {regel}", font=F_SMALL,
                     bg=ORANGE_BG, fg=GRIS_TXT, anchor="w").pack(anchor="w", padx=12)
        tk.Label(note_cle, text="", bg=ORANGE_BG).pack()

    # ── Utilitaire titre de section ────────────────────────────────────────────
    def _section_titre(self, parent, icone, texte, couleur):
        frame = tk.Frame(parent, bg=BLANC)
        frame.pack(fill="x", pady=(0, 4))
        tk.Label(frame, text=icone, font=("Segoe UI", 16),
                 bg=BLANC).pack(side="left")
        tk.Label(frame, text=texte, font=F_GRAND,
                 bg=BLANC, fg=couleur).pack(side="left", padx=4)
        Separateur(parent, couleur).pack(fill="x", pady=(0, 8))


# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app = AppDemo()
    app.mainloop()
