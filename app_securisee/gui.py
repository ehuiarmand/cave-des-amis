"""
=============================================================================
INTERFACE GRAPHIQUE — CLINIQUE SÉCURISÉE INPHB
tkinter + ttk  (inclus avec Python, aucune installation requise)
=============================================================================
"""
import tkinter as tk
from tkinter import ttk, messagebox, font
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from securite        import hacher_mot_de_passe, verifier_mot_de_passe, chiffrer, dechiffrer
import base_de_donnees as bdd

# ── Palette INPHB ──────────────────────────────────────────────────────────────
VERT        = "#1a5c38"
VERT_CLAIR  = "#2e7d52"
VERT_BG     = "#e8f5e0"
ORANGE      = "#c85a0a"
ORANGE_BG   = "#fff3e0"
BLANC       = "#ffffff"
GRIS_BG     = "#f4f4f4"
GRIS_BORDER = "#cccccc"
GRIS_TXT    = "#333333"
GRIS_LIGHT  = "#888888"
ROUGE       = "#c62828"
BLEU        = "#1565c0"

# ── Polices ────────────────────────────────────────────────────────────────────
FONT_TITRE  = ("Segoe UI", 20, "bold")
FONT_SOUS   = ("Segoe UI", 13, "bold")
FONT_NORMAL = ("Segoe UI", 11)
FONT_BOLD   = ("Segoe UI", 11, "bold")
FONT_SMALL  = ("Segoe UI", 9)
FONT_MONO   = ("Consolas",  9)

# ══════════════════════════════════════════════════════════════════════════════
# WIDGETS PERSONNALISÉS
# ══════════════════════════════════════════════════════════════════════════════

class BoutonVert(tk.Button):
    def __init__(self, parent, **kw):
        super().__init__(parent,
            bg=VERT, fg=BLANC, font=FONT_BOLD,
            relief="flat", bd=0, padx=20, pady=10,
            cursor="hand2", activebackground=VERT_CLAIR, activeforeground=BLANC,
            **kw)
        self.bind("<Enter>", lambda e: self.config(bg=VERT_CLAIR))
        self.bind("<Leave>", lambda e: self.config(bg=VERT))

class BoutonOrange(tk.Button):
    def __init__(self, parent, **kw):
        super().__init__(parent,
            bg=ORANGE, fg=BLANC, font=FONT_BOLD,
            relief="flat", bd=0, padx=20, pady=10,
            cursor="hand2", activebackground="#a04808", activeforeground=BLANC,
            **kw)
        self.bind("<Enter>", lambda e: self.config(bg="#a04808"))
        self.bind("<Leave>", lambda e: self.config(bg=ORANGE))

class BoutonGris(tk.Button):
    def __init__(self, parent, **kw):
        super().__init__(parent,
            bg=GRIS_BG, fg=GRIS_TXT, font=FONT_NORMAL,
            relief="flat", bd=1, padx=16, pady=8,
            cursor="hand2", activebackground=GRIS_BORDER,
            **kw)

class Champ(tk.Frame):
    """Label + Entry stylisé"""
    def __init__(self, parent, label, masquer=False, **kw):
        super().__init__(parent, bg=BLANC)
        tk.Label(self, text=label, font=FONT_SMALL, bg=BLANC,
                 fg=GRIS_LIGHT).pack(anchor="w")
        self.var = tk.StringVar()
        show = "●" if masquer else ""
        self.entry = tk.Entry(self, textvariable=self.var, font=FONT_NORMAL,
                              show=show, relief="solid", bd=1,
                              highlightthickness=1,
                              highlightbackground=GRIS_BORDER,
                              highlightcolor=VERT,
                              bg=BLANC, fg=GRIS_TXT, **kw)
        self.entry.pack(fill="x", ipady=6)
    def get(self): return self.var.get().strip()
    def set(self, v): self.var.set(v)
    def focus(self): self.entry.focus()

class CarteStat(tk.Frame):
    """Carte avec un chiffre et un label"""
    def __init__(self, parent, nombre, label, couleur=VERT, **kw):
        super().__init__(parent, bg=BLANC, relief="solid", bd=1, padx=16, pady=12)
        tk.Label(self, text=str(nombre), font=("Segoe UI", 28, "bold"),
                 fg=couleur, bg=BLANC).pack()
        tk.Label(self, text=label, font=FONT_SMALL,
                 fg=GRIS_LIGHT, bg=BLANC).pack()

class Separateur(tk.Frame):
    def __init__(self, parent, couleur=GRIS_BORDER, **kw):
        super().__init__(parent, bg=couleur, height=1, **kw)

# ══════════════════════════════════════════════════════════════════════════════
# APPLICATION PRINCIPALE
# ══════════════════════════════════════════════════════════════════════════════

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Clinique Sécurisée — INPHB IC 2026")
        self.geometry("900x650")
        self.minsize(800, 580)
        self.configure(bg=GRIS_BG)
        self.resizable(True, True)

        # Centrer la fenêtre
        self.update_idletasks()
        x = (self.winfo_screenwidth()  - 900) // 2
        y = (self.winfo_screenheight() - 650) // 2
        self.geometry(f"900x650+{x}+{y}")

        self.session = {"user": None}

        # Conteneur principal
        self.conteneur = tk.Frame(self, bg=GRIS_BG)
        self.conteneur.pack(fill="both", expand=True)

        bdd.initialiser()
        self._creer_admin_defaut()
        self.afficher_connexion()

    def _creer_admin_defaut(self):
        if not bdd.trouver_utilisateur("admin@clinique.ci"):
            bdd.creer_utilisateur(
                "Administrateur", "admin@clinique.ci",
                hacher_mot_de_passe("Admin@2024!"), role="admin"
            )

    def vider(self):
        for w in self.conteneur.winfo_children():
            w.destroy()

    # ══════════════════════════════════════════════════════════════════════════
    # BARRE DE NAVIGATION
    # ══════════════════════════════════════════════════════════════════════════
    def navbar(self, titre_page, bouton_label=None, bouton_cmd=None):
        nav = tk.Frame(self.conteneur, bg=VERT, height=56)
        nav.pack(fill="x")
        nav.pack_propagate(False)

        # Logo + titre
        tk.Label(nav, text="🏥", font=("Segoe UI", 18),
                 bg=VERT, fg=BLANC).pack(side="left", padx=(16, 4), pady=10)
        tk.Label(nav, text=titre_page, font=("Segoe UI", 13, "bold"),
                 bg=VERT, fg=BLANC).pack(side="left", pady=10)

        # Trait orange bas
        trait = tk.Frame(self.conteneur, bg=ORANGE, height=3)
        trait.pack(fill="x")

        # Bouton droite (déconnexion ou retour)
        if bouton_label and bouton_cmd:
            tk.Button(nav, text=bouton_label, font=FONT_SMALL,
                      bg=ORANGE, fg=BLANC, relief="flat", padx=12, pady=6,
                      cursor="hand2", activebackground="#a04808",
                      command=bouton_cmd).pack(side="right", padx=16, pady=10)

        # Nom utilisateur
        if self.session["user"]:
            u = self.session["user"]
            tk.Label(nav, text=f"👤  {u['nom']}  [{u['role']}]",
                     font=FONT_SMALL, bg=VERT, fg="#c9d9b0").pack(side="right", padx=8)

    # ══════════════════════════════════════════════════════════════════════════
    # ÉCRAN CONNEXION
    # ══════════════════════════════════════════════════════════════════════════
    def afficher_connexion(self):
        self.vider()
        self.session["user"] = None

        # Fond vert gauche
        gauche = tk.Frame(self.conteneur, bg=VERT, width=360)
        gauche.pack(side="left", fill="y")
        gauche.pack_propagate(False)

        tk.Label(gauche, text="🏥", font=("Segoe UI", 56),
                 bg=VERT, fg=BLANC).pack(pady=(80, 10))
        tk.Label(gauche, text="Clinique\nSécurisée", font=("Segoe UI", 22, "bold"),
                 bg=VERT, fg=BLANC, justify="center").pack()
        tk.Label(gauche, text="INPHB — IC 2026",
                 font=FONT_SMALL, bg=VERT, fg="#c9d9b0").pack(pady=(6, 0))

        Separateur(gauche, couleur="#2e7d52").pack(fill="x", padx=40, pady=20)

        tk.Label(gauche, text="🔐  bcrypt  •  AES-256-GCM",
                 font=FONT_SMALL, bg=VERT, fg="#c9d9b0").pack()
        tk.Label(gauche, text="Vos données sont sécurisées",
                 font=FONT_SMALL, bg=VERT, fg="#a0c0a0").pack(pady=(4, 0))

        # Formulaire droite
        droite = tk.Frame(self.conteneur, bg=BLANC)
        droite.pack(side="right", fill="both", expand=True)

        form = tk.Frame(droite, bg=BLANC)
        form.place(relx=0.5, rely=0.5, anchor="center")

        tk.Label(form, text="Connexion", font=FONT_TITRE,
                 bg=BLANC, fg=VERT).pack(anchor="w", pady=(0, 4))
        tk.Label(form, text="Accédez à votre espace sécurisé",
                 font=FONT_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", pady=(0, 24))

        self._email    = Champ(form, "Adresse email", width=36)
        self._email.pack(fill="x", pady=(0, 12))
        self._mdp      = Champ(form, "Mot de passe", masquer=True, width=36)
        self._mdp.pack(fill="x", pady=(0, 20))
        self._email.focus()

        BoutonVert(form, text="Se connecter →", width=28,
                   command=self._connexion).pack(fill="x", pady=(0, 10))

        tk.Label(form, text="─────────────────────────────",
                 font=FONT_SMALL, bg=BLANC, fg=GRIS_BORDER).pack(pady=4)
        tk.Label(form, text="Pas encore de compte ?",
                 font=FONT_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack()
        tk.Button(form, text="Créer un compte",
                  font=FONT_SMALL, bg=BLANC, fg=VERT,
                  relief="flat", cursor="hand2",
                  command=self.afficher_inscription).pack(pady=4)

        # Touche Entrée
        self.bind("<Return>", lambda e: self._connexion())

    def _connexion(self):
        email = self._email.get()
        mdp   = self._mdp.get()
        if not email or not mdp:
            messagebox.showwarning("Champs vides", "Veuillez remplir tous les champs.")
            return
        user = bdd.trouver_utilisateur(email)
        if user and verifier_mot_de_passe(mdp, user["mot_de_passe"]):
            self.session["user"] = dict(user)
            bdd.ajouter_log(email, "CONNEXION", "SUCCÈS")
            if user["role"] == "admin":
                self.afficher_dashboard_admin()
            else:
                self.afficher_dashboard_patient()
        else:
            bdd.ajouter_log(email, "CONNEXION", "ÉCHEC")
            messagebox.showerror("Accès refusé", "Email ou mot de passe incorrect.")

    # ══════════════════════════════════════════════════════════════════════════
    # ÉCRAN INSCRIPTION
    # ══════════════════════════════════════════════════════════════════════════
    def afficher_inscription(self):
        self.vider()
        self.unbind("<Return>")

        main = tk.Frame(self.conteneur, bg=GRIS_BG)
        main.pack(fill="both", expand=True)

        # En-tête
        hdr = tk.Frame(main, bg=VERT, height=56)
        hdr.pack(fill="x"); hdr.pack_propagate(False)
        tk.Label(hdr, text="🏥  Créer un compte", font=("Segoe UI", 13, "bold"),
                 bg=VERT, fg=BLANC).pack(side="left", padx=20, pady=14)
        tk.Frame(main, bg=ORANGE, height=3).pack(fill="x")

        # Carte centrale
        carte = tk.Frame(main, bg=BLANC, relief="solid", bd=1)
        carte.place(relx=0.5, rely=0.5, anchor="center", width=480, height=480)

        tk.Label(carte, text="Nouveau compte",
                 font=FONT_SOUS, bg=BLANC, fg=VERT).pack(pady=(24, 4))
        Separateur(carte).pack(fill="x", padx=24, pady=(0, 16))

        self._i_nom   = Champ(carte, "Nom complet", width=40)
        self._i_nom.pack(fill="x", padx=24, pady=(0, 10))
        self._i_email = Champ(carte, "Adresse email", width=40)
        self._i_email.pack(fill="x", padx=24, pady=(0, 10))
        self._i_mdp   = Champ(carte, "Mot de passe (8 caractères min.)", masquer=True, width=40)
        self._i_mdp.pack(fill="x", padx=24, pady=(0, 10))
        self._i_conf  = Champ(carte, "Confirmer le mot de passe", masquer=True, width=40)
        self._i_conf.pack(fill="x", padx=24, pady=(0, 20))

        BoutonVert(carte, text="Créer mon compte",
                   command=self._inscrire).pack(padx=24, fill="x")
        tk.Button(carte, text="← Retour à la connexion",
                  font=FONT_SMALL, bg=BLANC, fg=ORANGE,
                  relief="flat", cursor="hand2",
                  command=self.afficher_connexion).pack(pady=10)

    def _inscrire(self):
        nom  = self._i_nom.get()
        email = self._i_email.get()
        mdp  = self._i_mdp.get()
        conf = self._i_conf.get()

        if not all([nom, email, mdp, conf]):
            messagebox.showwarning("Champs vides", "Tous les champs sont obligatoires.")
            return
        if mdp != conf:
            messagebox.showerror("Erreur", "Les mots de passe ne correspondent pas.")
            return
        if len(mdp) < 8:
            messagebox.showerror("Erreur", "Le mot de passe doit faire au moins 8 caractères.")
            return
        mdp_hache = hacher_mot_de_passe(mdp)
        if bdd.creer_utilisateur(nom, email, mdp_hache):
            bdd.ajouter_log(email, "INSCRIPTION", "SUCCÈS")
            messagebox.showinfo("Succès", f"Compte créé pour {nom} !\nVous pouvez maintenant vous connecter.")
            self.afficher_connexion()
        else:
            messagebox.showerror("Erreur", "Cet email est déjà utilisé.")

    # ══════════════════════════════════════════════════════════════════════════
    # DASHBOARD PATIENT
    # ══════════════════════════════════════════════════════════════════════════
    def afficher_dashboard_patient(self):
        self.vider()
        u = self.session["user"]

        self.navbar(f"Espace Patient",
                    "🚪 Déconnexion", self.afficher_connexion)

        # Corps
        corps = tk.Frame(self.conteneur, bg=GRIS_BG)
        corps.pack(fill="both", expand=True, padx=24, pady=20)

        # Message bienvenue
        bvn = tk.Frame(corps, bg=VERT_BG, relief="solid", bd=1)
        bvn.pack(fill="x", pady=(0, 16))
        tk.Label(bvn, text=f"  👋  Bonjour, {u['nom']} !",
                 font=FONT_SOUS, bg=VERT_BG, fg=VERT).pack(side="left", pady=12)
        tk.Label(bvn, text="Vos données médicales sont chiffrées AES-256-GCM",
                 font=FONT_SMALL, bg=VERT_BG, fg=GRIS_LIGHT).pack(side="right", padx=16)

        # Deux cartes d'actions
        grille = tk.Frame(corps, bg=GRIS_BG)
        grille.pack(fill="both", expand=True)
        grille.columnconfigure(0, weight=1)
        grille.columnconfigure(1, weight=1)

        # Carte dossier médical
        self._carte_action(grille, 0, "📋", "Mon Dossier Médical",
                           "Consultez vos antécédents,\nallergies et traitements.",
                           "Voir mon dossier", VERT,
                           lambda: self.afficher_dossier_patient(u["id"]))

        # Carte modifier
        self._carte_action(grille, 1, "✏️", "Modifier mon Dossier",
                           "Mettez à jour vos informations\nmédiales de santé.",
                           "Modifier", ORANGE,
                           lambda: self.afficher_formulaire_dossier(u["id"]))

        # Changer MDP en bas
        bas = tk.Frame(corps, bg=GRIS_BG)
        bas.pack(fill="x", pady=(16, 0))
        BoutonGris(bas, text="🔑  Changer mon mot de passe",
                   command=lambda: self.afficher_changer_mdp(u)).pack(side="left")

    def _carte_action(self, parent, col, icone, titre, desc, btn_txt, couleur, cmd):
        carte = tk.Frame(parent, bg=BLANC, relief="solid", bd=1)
        carte.grid(row=0, column=col, padx=(0 if col else 0, 8 if col == 0 else 0),
                   pady=4, sticky="nsew")
        parent.rowconfigure(0, weight=1)

        tk.Label(carte, text=icone, font=("Segoe UI", 40),
                 bg=BLANC).pack(pady=(28, 8))
        tk.Label(carte, text=titre, font=FONT_SOUS,
                 bg=BLANC, fg=couleur).pack()
        tk.Label(carte, text=desc, font=FONT_SMALL,
                 bg=BLANC, fg=GRIS_LIGHT, justify="center").pack(pady=(6, 20))

        if couleur == VERT:
            BoutonVert(carte, text=btn_txt, command=cmd).pack(pady=(0, 24))
        else:
            BoutonOrange(carte, text=btn_txt, command=cmd).pack(pady=(0, 24))

    # ── Voir dossier médical ──────────────────────────────────────────────────
    def afficher_dossier_patient(self, user_id):
        self.vider()
        self.navbar("📋  Mon Dossier Médical",
                    "← Retour", self.afficher_dashboard_patient)

        corps = tk.Frame(self.conteneur, bg=GRIS_BG)
        corps.pack(fill="both", expand=True, padx=24, pady=20)

        dossier = bdd.lire_dossier(user_id)
        if not dossier:
            tk.Label(corps, text="Aucun dossier médical enregistré.",
                     font=FONT_NORMAL, bg=GRIS_BG, fg=GRIS_LIGHT).pack(pady=40)
            BoutonVert(corps, text="Créer mon dossier",
                       command=lambda: self.afficher_formulaire_dossier(user_id)).pack()
            return

        # Badge sécurité
        badge = tk.Frame(corps, bg=VERT_BG, relief="solid", bd=1)
        badge.pack(fill="x", pady=(0, 16))
        tk.Label(badge, text="🔓  Données déchiffrées avec votre clé AES-256-GCM",
                 font=FONT_SMALL, bg=VERT_BG, fg=VERT).pack(pady=8, side="left", padx=12)
        tk.Label(badge, text=f"Dernière mise à jour : {dossier['modifie_le'][:16]}",
                 font=FONT_SMALL, bg=VERT_BG, fg=GRIS_LIGHT).pack(pady=8, side="right", padx=12)

        # Grille des champs
        grille = tk.Frame(corps, bg=GRIS_BG)
        grille.pack(fill="both", expand=True)

        champs_dossier = [
            ("🩸 Groupe Sanguin",    "groupe_sanguin"),
            ("📝 Antécédents",       "antecedents"),
            ("⚠️ Allergies",         "allergies"),
            ("💊 Traitements",       "traitements"),
            ("📌 Notes",             "notes"),
        ]

        for i, (label, col) in enumerate(champs_dossier):
            r, c = divmod(i, 2)
            frame = tk.Frame(grille, bg=BLANC, relief="solid", bd=1)
            frame.grid(row=r, column=c, padx=(0, 8 if c == 0 else 0),
                       pady=6, sticky="nsew")
            grille.columnconfigure(c, weight=1)

            tk.Label(frame, text=label, font=FONT_BOLD,
                     bg=BLANC, fg=VERT).pack(anchor="w", padx=14, pady=(10, 2))
            Separateur(frame).pack(fill="x", padx=14)

            valeur_chiffree = dossier[col]
            if valeur_chiffree:
                try:
                    valeur = dechiffrer(valeur_chiffree)
                except Exception:
                    valeur = "[Erreur de déchiffrement]"
            else:
                valeur = "—"

            tk.Label(frame, text=valeur, font=FONT_NORMAL,
                     bg=BLANC, fg=GRIS_TXT, wraplength=280,
                     justify="left").pack(anchor="w", padx=14, pady=(6, 12))

        # Bouton modifier
        BoutonOrange(corps, text="✏️  Modifier mon dossier",
                     command=lambda: self.afficher_formulaire_dossier(user_id)
                     ).pack(pady=16, anchor="e")

    # ── Formulaire dossier ────────────────────────────────────────────────────
    def afficher_formulaire_dossier(self, user_id):
        self.vider()
        self.navbar("✏️  Modifier mon Dossier Médical",
                    "← Retour", self.afficher_dashboard_patient)

        # Scrollable
        canvas = tk.Canvas(self.conteneur, bg=GRIS_BG, highlightthickness=0)
        scroll = ttk.Scrollbar(self.conteneur, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=scroll.set)
        scroll.pack(side="right", fill="y")
        canvas.pack(fill="both", expand=True)

        frame = tk.Frame(canvas, bg=GRIS_BG)
        win   = canvas.create_window((0, 0), window=frame, anchor="nw")

        def on_resize(e): canvas.itemconfig(win, width=e.width)
        canvas.bind("<Configure>", on_resize)
        frame.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))

        inner = tk.Frame(frame, bg=BLANC, relief="solid", bd=1)
        inner.pack(fill="x", padx=24, pady=20)

        tk.Label(inner, text="ℹ️  Toutes les données seront chiffrées AES-256-GCM avant stockage.",
                 font=FONT_SMALL, bg=ORANGE_BG, fg=ORANGE).pack(fill="x", padx=0, pady=0, ipady=8)

        # Pré-remplir si dossier existant
        dossier = bdd.lire_dossier(user_id)
        def dec(col):
            if dossier and dossier[col]:
                try: return dechiffrer(dossier[col])
                except: return ""
            return ""

        champs = [
            ("🩸 Groupe sanguin",  "groupe"),
            ("📝 Antécédents médicaux", "antecedents"),
            ("⚠️ Allergies",       "allergies"),
            ("💊 Traitements en cours", "traitements"),
            ("📌 Notes complémentaires", "notes"),
        ]
        cols_db = ["groupe_sanguin", "antecedents", "allergies", "traitements", "notes"]
        self._f_vars = {}

        for (label, key), col in zip(champs, cols_db):
            tk.Label(inner, text=label, font=FONT_BOLD,
                     bg=BLANC, fg=VERT).pack(anchor="w", padx=20, pady=(14, 2))
            var = tk.StringVar(value=dec(col))
            txt = tk.Text(inner, font=FONT_NORMAL, height=3, relief="solid", bd=1,
                          fg=GRIS_TXT, bg=BLANC, wrap="word")
            txt.insert("1.0", dec(col))
            txt.pack(fill="x", padx=20, pady=(0, 2))
            self._f_vars[key] = txt

        # Boutons
        btns = tk.Frame(inner, bg=BLANC)
        btns.pack(fill="x", padx=20, pady=16)
        BoutonVert(btns, text="💾  Enregistrer et chiffrer",
                   command=lambda: self._sauvegarder_dossier(user_id)).pack(side="left")
        BoutonGris(btns, text="Annuler",
                   command=self.afficher_dashboard_patient).pack(side="left", padx=10)

    def _sauvegarder_dossier(self, user_id):
        def get(key): return self._f_vars[key].get("1.0", "end").strip()
        groupe      = get("groupe")
        antecedents = get("antecedents")
        allergies   = get("allergies")
        traitements = get("traitements")
        notes       = get("notes")

        bdd.creer_ou_maj_dossier(
            user_id,
            chiffrer(antecedents)  if antecedents  else "",
            chiffrer(allergies)    if allergies     else "",
            chiffrer(traitements)  if traitements   else "",
            chiffrer(groupe)       if groupe        else "",
            chiffrer(notes)        if notes         else "",
        )
        messagebox.showinfo("✅ Sauvegardé",
                            "Dossier médical chiffré et sauvegardé avec succès !")
        self.afficher_dossier_patient(user_id)

    # ── Changer mot de passe ──────────────────────────────────────────────────
    def afficher_changer_mdp(self, user):
        win = tk.Toplevel(self)
        win.title("Changer mon mot de passe")
        win.geometry("400x380")
        win.configure(bg=BLANC)
        win.resizable(False, False)
        win.grab_set()

        tk.Frame(win, bg=VERT, height=48).pack(fill="x")
        tk.Label(win, text="🔑  Changer mon mot de passe",
                 font=FONT_SOUS, bg=BLANC, fg=VERT).pack(pady=(16, 4))
        Separateur(win).pack(fill="x", padx=24, pady=8)

        ancien  = Champ(win, "Ancien mot de passe",   masquer=True)
        ancien.pack(fill="x", padx=24, pady=(0, 8))
        nouveau = Champ(win, "Nouveau mot de passe",  masquer=True)
        nouveau.pack(fill="x", padx=24, pady=(0, 8))
        confirm = Champ(win, "Confirmer",              masquer=True)
        confirm.pack(fill="x", padx=24, pady=(0, 16))

        def valider():
            if not verifier_mot_de_passe(ancien.get(), user["mot_de_passe"]):
                messagebox.showerror("Erreur", "Ancien mot de passe incorrect.", parent=win)
                return
            if nouveau.get() != confirm.get():
                messagebox.showerror("Erreur", "Les mots de passe ne correspondent pas.", parent=win)
                return
            if len(nouveau.get()) < 8:
                messagebox.showerror("Erreur", "Minimum 8 caractères.", parent=win)
                return
            h = hacher_mot_de_passe(nouveau.get())
            conn = bdd.connexion()
            conn.execute("UPDATE utilisateurs SET mot_de_passe=? WHERE id=?", (h, user["id"]))
            conn.commit(); conn.close()
            self.session["user"]["mot_de_passe"] = h
            bdd.ajouter_log(user["email"], "CHANGEMENT_MDP", "SUCCÈS")
            messagebox.showinfo("✅ Succès", "Mot de passe modifié !", parent=win)
            win.destroy()

        BoutonVert(win, text="Modifier mon mot de passe", command=valider).pack(padx=24, fill="x")

    # ══════════════════════════════════════════════════════════════════════════
    # DASHBOARD ADMINISTRATEUR
    # ══════════════════════════════════════════════════════════════════════════
    def afficher_dashboard_admin(self):
        self.vider()
        self.navbar("⚙️  Espace Administrateur",
                    "🚪 Déconnexion", self.afficher_connexion)

        # Sidebar + contenu
        corps = tk.Frame(self.conteneur, bg=GRIS_BG)
        corps.pack(fill="both", expand=True)

        # ── Sidebar ──────────────────────────────────────────────────────────
        sidebar = tk.Frame(corps, bg=VERT, width=200)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)

        tk.Label(sidebar, text="Navigation", font=FONT_SMALL,
                 bg=VERT, fg="#c9d9b0").pack(pady=(20, 8), padx=16, anchor="w")
        Separateur(sidebar, couleur="#2e7d52").pack(fill="x", padx=16, pady=4)

        self._contenu_admin = tk.Frame(corps, bg=GRIS_BG)
        self._contenu_admin.pack(fill="both", expand=True)

        menus_admin = [
            ("👥  Utilisateurs",    self._admin_utilisateurs),
            ("🏥  Dossiers",        self._admin_dossiers),
            ("📜  Journal",         self._admin_journal),
        ]
        for label, cmd in menus_admin:
            btn = tk.Button(sidebar, text=label, font=FONT_NORMAL,
                            bg=VERT, fg=BLANC, relief="flat", anchor="w",
                            padx=16, pady=10, cursor="hand2",
                            activebackground=VERT_CLAIR, activeforeground=BLANC,
                            command=cmd)
            btn.pack(fill="x")

        # Afficher onglet utilisateurs par défaut
        self._admin_utilisateurs()

    def _vider_contenu_admin(self):
        for w in self._contenu_admin.winfo_children():
            w.destroy()

    # ── Admin : liste utilisateurs ────────────────────────────────────────────
    def _admin_utilisateurs(self):
        self._vider_contenu_admin()
        c = self._contenu_admin

        # En-tête
        hdr = tk.Frame(c, bg=BLANC)
        hdr.pack(fill="x", padx=16, pady=(16, 0))
        tk.Label(hdr, text="👥  Gestion des Utilisateurs",
                 font=FONT_SOUS, bg=BLANC, fg=VERT).pack(side="left")
        BoutonVert(hdr, text="+ Ajouter", pady=6,
                   command=self._admin_ajouter_user).pack(side="right", padx=4)
        BoutonGris(hdr, text="🔄 Actualiser",
                   command=self._admin_utilisateurs).pack(side="right", padx=4)

        Separateur(c).pack(fill="x", padx=16, pady=8)

        # Tableau
        colonnes = ("ID", "Nom", "Email", "Rôle", "Créé le")
        tree_frame = tk.Frame(c, bg=GRIS_BG)
        tree_frame.pack(fill="both", expand=True, padx=16)

        style = ttk.Style()
        style.configure("Treeview", font=FONT_NORMAL, rowheight=30, background=BLANC)
        style.configure("Treeview.Heading", font=FONT_BOLD, background=VERT, foreground=BLANC)
        style.map("Treeview", background=[("selected", VERT_CLAIR)])

        tree = ttk.Treeview(tree_frame, columns=colonnes, show="headings", selectmode="browse")
        largeurs = [40, 180, 220, 70, 140]
        for col, w in zip(colonnes, largeurs):
            tree.heading(col, text=col)
            tree.column(col, width=w, anchor="center")

        for u in bdd.lister_utilisateurs():
            tree.insert("", "end", values=(
                u["id"], u["nom"], u["email"], u["role"], u["cree_le"][:16]
            ))

        sb = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        tree.pack(fill="both", expand=True)

        # Boutons action
        act = tk.Frame(c, bg=GRIS_BG)
        act.pack(fill="x", padx=16, pady=8)

        def get_sel():
            sel = tree.selection()
            if not sel:
                messagebox.showwarning("Sélection", "Sélectionnez un utilisateur.")
                return None
            return tree.item(sel[0])["values"]

        BoutonOrange(act, text="✏️  Modifier", pady=6,
                     command=lambda: self._admin_modifier_user(get_sel())).pack(side="left", padx=(0,8))
        tk.Button(act, text="🗑️  Supprimer", font=FONT_NORMAL,
                  bg=ROUGE, fg=BLANC, relief="flat", padx=16, pady=8,
                  cursor="hand2",
                  command=lambda: self._admin_supprimer_user(get_sel(),
                                                              self._admin_utilisateurs)
                  ).pack(side="left")

    def _admin_ajouter_user(self):
        self._admin_form_user(None)

    def _admin_modifier_user(self, vals):
        if vals: self._admin_form_user(vals)

    def _admin_form_user(self, vals):
        win = tk.Toplevel(self)
        win.title("Utilisateur")
        win.geometry("420x400")
        win.configure(bg=BLANC)
        win.resizable(False, False)
        win.grab_set()

        titre_txt = "Modifier l'utilisateur" if vals else "Nouvel utilisateur"
        tk.Frame(win, bg=VERT, height=48).pack(fill="x")
        tk.Label(win, text=titre_txt, font=FONT_SOUS, bg=BLANC, fg=VERT).pack(pady=(14, 4))
        Separateur(win).pack(fill="x", padx=24, pady=6)

        nom_f   = Champ(win, "Nom complet", width=38)
        nom_f.pack(fill="x", padx=24, pady=(0, 10))
        email_f = Champ(win, "Email", width=38)
        email_f.pack(fill="x", padx=24, pady=(0, 10))

        tk.Label(win, text="Rôle", font=FONT_SMALL, bg=BLANC, fg=GRIS_LIGHT).pack(anchor="w", padx=24)
        role_var = tk.StringVar(value="patient")
        r_frame  = tk.Frame(win, bg=BLANC)
        r_frame.pack(anchor="w", padx=24, pady=(2, 10))
        tk.Radiobutton(r_frame, text="Patient", variable=role_var, value="patient",
                       bg=BLANC, font=FONT_NORMAL).pack(side="left")
        tk.Radiobutton(r_frame, text="Admin", variable=role_var, value="admin",
                       bg=BLANC, font=FONT_NORMAL).pack(side="left", padx=16)

        if vals:
            nom_f.set(vals[1])
            email_f.set(vals[2])
            role_var.set(vals[3])
            email_f.entry.config(state="disabled")

        def sauver():
            if not vals:  # Création
                mdp_tmp = "Temp@1234"
                h = hacher_mot_de_passe(mdp_tmp)
                if bdd.creer_utilisateur(nom_f.get(), email_f.get(), h, role_var.get()):
                    messagebox.showinfo("✅", f"Compte créé.\nMot de passe provisoire : {mdp_tmp}", parent=win)
                    win.destroy(); self._admin_utilisateurs()
                else:
                    messagebox.showerror("Erreur", "Email déjà utilisé.", parent=win)
            else:
                bdd.modifier_utilisateur(vals[0], nom_f.get(), role_var.get())
                messagebox.showinfo("✅", "Utilisateur modifié.", parent=win)
                win.destroy(); self._admin_utilisateurs()

        BoutonVert(win, text="Enregistrer", command=sauver).pack(padx=24, fill="x", pady=8)

    def _admin_supprimer_user(self, vals, refresh):
        if not vals: return
        if messagebox.askyesno("Confirmer", f"Supprimer {vals[1]} ({vals[2]}) ?"):
            bdd.supprimer_utilisateur(vals[0])
            refresh()

    # ── Admin : dossiers médicaux ─────────────────────────────────────────────
    def _admin_dossiers(self):
        self._vider_contenu_admin()
        c = self._contenu_admin

        tk.Label(c, text="🏥  Dossiers Médicaux",
                 font=FONT_SOUS, bg=GRIS_BG, fg=VERT).pack(anchor="w", padx=16, pady=(16, 4))
        Separateur(c).pack(fill="x", padx=16, pady=4)
        tk.Label(c, text="Sélectionnez un patient pour consulter son dossier déchiffré.",
                 font=FONT_SMALL, bg=GRIS_BG, fg=GRIS_LIGHT).pack(anchor="w", padx=16, pady=(0, 8))

        users = bdd.lister_utilisateurs()
        for u in users:
            if u["role"] == "patient":
                row = tk.Frame(c, bg=BLANC, relief="solid", bd=1)
                row.pack(fill="x", padx=16, pady=3)
                tk.Label(row, text=f"👤  {u['nom']}", font=FONT_BOLD,
                         bg=BLANC, fg=VERT).pack(side="left", padx=14, pady=10)
                tk.Label(row, text=u["email"], font=FONT_SMALL,
                         bg=BLANC, fg=GRIS_LIGHT).pack(side="left")
                BoutonVert(row, text="Voir dossier", pady=4,
                           command=lambda uid=u["id"]: self._admin_voir_dossier(uid)
                           ).pack(side="right", padx=10, pady=6)

    def _admin_voir_dossier(self, user_id):
        self.vider()
        self.navbar("🏥  Dossier médical — Admin",
                    "← Retour", self.afficher_dashboard_admin)
        self.afficher_dossier_patient(user_id)

    # ── Admin : journal ───────────────────────────────────────────────────────
    def _admin_journal(self):
        self._vider_contenu_admin()
        c = self._contenu_admin

        hdr = tk.Frame(c, bg=GRIS_BG)
        hdr.pack(fill="x", padx=16, pady=(16, 0))
        tk.Label(hdr, text="📜  Journal de Connexion",
                 font=FONT_SOUS, bg=GRIS_BG, fg=VERT).pack(side="left")
        BoutonGris(hdr, text="🔄 Actualiser",
                   command=self._admin_journal).pack(side="right")
        Separateur(c).pack(fill="x", padx=16, pady=8)

        colonnes = ("ID", "Email", "Action", "Statut", "Date")
        tree_frame = tk.Frame(c, bg=GRIS_BG)
        tree_frame.pack(fill="both", expand=True, padx=16)

        tree = ttk.Treeview(tree_frame, columns=colonnes, show="headings", selectmode="none")
        largeurs = [40, 210, 140, 70, 150]
        for col, w in zip(colonnes, largeurs):
            tree.heading(col, text=col)
            tree.column(col, width=w, anchor="center")

        # Couleurs selon statut
        tree.tag_configure("ok",    background="#e8f5e0", foreground="#1a5c38")
        tree.tag_configure("echec", background="#fdecea", foreground="#c62828")

        for log in bdd.lire_journal(50):
            tag = "ok" if log["statut"] == "SUCCÈS" else "echec"
            tree.insert("", "end", values=(
                log["id"], log["email"], log["action"],
                log["statut"], log["date_heure"][:16]
            ), tags=(tag,))

        sb = ttk.Scrollbar(tree_frame, orient="vertical", command=tree.yview)
        tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        tree.pack(fill="both", expand=True)


# ══════════════════════════════════════════════════════════════════════════════
# LANCEMENT
# ══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    app = App()
    app.mainloop()
