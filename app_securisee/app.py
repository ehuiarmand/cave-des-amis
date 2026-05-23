"""
=============================================================================
APPLICATION CLINIQUE SÉCURISÉE — INPHB IC 2026
=============================================================================
Sécurisation technique :
  • Mots de passe  →  Hachage bcrypt (rounds=12)
  • Données santé  →  Chiffrement AES-256-GCM
  • Journalisation →  Logs de connexion en BDD
=============================================================================
"""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

from securite        import hacher_mot_de_passe, verifier_mot_de_passe, chiffrer, dechiffrer
import base_de_donnees as bdd
import interface       as ui

# ─── Utilisateur connecté (session en mémoire) ───────────────────────────────
session = {"user": None}

# =============================================================================
# AUTHENTIFICATION
# =============================================================================

def ecran_connexion():
    ui.cls()
    ui.titre("🔐  CONNEXION", ui.VERT)
    email = ui.saisie("Email        : ")
    mdp   = ui.saisie("Mot de passe : ", masquer=True)

    user = bdd.trouver_utilisateur(email)

    if user and verifier_mot_de_passe(mdp, user["mot_de_passe"]):
        session["user"] = dict(user)
        bdd.ajouter_log(email, "CONNEXION", "SUCCÈS")
        ui.ok(f"Bienvenue, {user['nom']} !")
        ui.pause()
        return True
    else:
        bdd.ajouter_log(email, "CONNEXION", "ÉCHEC")
        ui.erreur("Email ou mot de passe incorrect.")
        ui.pause()
        return False


def ecran_inscription():
    ui.cls()
    ui.titre("📝  CRÉER UN COMPTE", ui.BLEU)

    nom   = ui.saisie("Nom complet  : ")
    email = ui.saisie("Email        : ")

    mdp   = ui.saisie("Mot de passe : ", masquer=True)
    conf  = ui.saisie("Confirmation : ", masquer=True)

    if mdp != conf:
        ui.erreur("Les mots de passe ne correspondent pas.")
        ui.pause()
        return

    if len(mdp) < 8:
        ui.erreur("Le mot de passe doit contenir au moins 8 caractères.")
        ui.pause()
        return

    ui.info("Hachage du mot de passe en cours (bcrypt rounds=12)...")
    mdp_hache = hacher_mot_de_passe(mdp)

    succes = bdd.creer_utilisateur(nom, email, mdp_hache)
    if succes:
        bdd.ajouter_log(email, "INSCRIPTION", "SUCCÈS")
        ui.ok("Compte créé avec succès ! Vous pouvez maintenant vous connecter.")
    else:
        ui.erreur("Cet email est déjà utilisé.")

    ui.pause()


# =============================================================================
# MENU PRINCIPAL — PATIENT
# =============================================================================

def menu_patient():
    while True:
        ui.cls()
        user = session["user"]
        ui.titre(f"👤  ESPACE PATIENT — {user['nom']}", ui.CYAN)
        choix = ui.menu([
            "Voir mon dossier médical",
            "Modifier mon dossier médical",
            "Changer mon mot de passe",
            "Se déconnecter",
        ])

        if choix == "1":
            voir_dossier(user["id"])
        elif choix == "2":
            modifier_dossier(user["id"])
        elif choix == "3":
            changer_mdp(user)
        elif choix == "4":
            session["user"] = None
            bdd.ajouter_log(user["email"], "DÉCONNEXION", "SUCCÈS")
            break
        else:
            ui.erreur("Choix invalide.")
            ui.pause()


def voir_dossier(user_id):
    ui.cls()
    ui.titre("📋  MON DOSSIER MÉDICAL", ui.BLEU)
    dossier = bdd.lire_dossier(user_id)

    if not dossier:
        ui.info("Aucun dossier médical enregistré.")
        ui.pause()
        return

    ui.sous_titre("Données déchiffrées (AES-256-GCM)")

    champs = [
        ("Groupe sanguin",  "groupe_sanguin"),
        ("Antécédents",     "antecedents"),
        ("Allergies",       "allergies"),
        ("Traitements",     "traitements"),
        ("Notes",           "notes"),
    ]

    for label, col in champs:
        valeur_chiffree = dossier[col]
        if valeur_chiffree:
            try:
                valeur = dechiffrer(valeur_chiffree)
            except Exception:
                valeur = "[Erreur de déchiffrement]"
        else:
            valeur = "—"
        ui.champ(label, valeur)

    ui.separateur()
    ui.info(f"Dernière mise à jour : {dossier['modifie_le']}")
    ui.pause()


def modifier_dossier(user_id):
    ui.cls()
    ui.titre("✏️   MODIFIER MON DOSSIER", ui.JAUNE)
    ui.info("Toutes les données seront chiffrées (AES-256-GCM) avant stockage.\n")

    groupe     = ui.saisie("Groupe sanguin (ex: A+)        : ")
    antecedents = ui.saisie("Antécédents médicaux           : ")
    allergies   = ui.saisie("Allergies connues              : ")
    traitements = ui.saisie("Traitements en cours           : ")
    notes       = ui.saisie("Notes complémentaires          : ")

    ui.info("Chiffrement AES-256-GCM en cours...")

    bdd.creer_ou_maj_dossier(
        user_id,
        chiffrer(antecedents)  if antecedents  else "",
        chiffrer(allergies)    if allergies    else "",
        chiffrer(traitements)  if traitements  else "",
        chiffrer(groupe)       if groupe       else "",
        chiffrer(notes)        if notes        else "",
    )

    ui.ok("Dossier médical sauvegardé et chiffré avec succès.")
    ui.pause()


def changer_mdp(user):
    ui.cls()
    ui.titre("🔑  CHANGER MON MOT DE PASSE", ui.JAUNE)

    ancien = ui.saisie("Ancien mot de passe : ", masquer=True)
    if not verifier_mot_de_passe(ancien, user["mot_de_passe"]):
        ui.erreur("Ancien mot de passe incorrect.")
        ui.pause()
        return

    nouveau  = ui.saisie("Nouveau mot de passe : ", masquer=True)
    confirm  = ui.saisie("Confirmation         : ", masquer=True)

    if nouveau != confirm:
        ui.erreur("Les mots de passe ne correspondent pas.")
        ui.pause()
        return

    if len(nouveau) < 8:
        ui.erreur("Minimum 8 caractères requis.")
        ui.pause()
        return

    nouveau_hache = hacher_mot_de_passe(nouveau)
    conn = bdd.connexion()
    conn.execute("UPDATE utilisateurs SET mot_de_passe=? WHERE id=?",
                 (nouveau_hache, user["id"]))
    conn.commit()
    conn.close()
    session["user"]["mot_de_passe"] = nouveau_hache
    bdd.ajouter_log(user["email"], "CHANGEMENT_MDP", "SUCCÈS")
    ui.ok("Mot de passe modifié avec succès.")
    ui.pause()


# =============================================================================
# MENU ADMINISTRATEUR
# =============================================================================

def menu_admin():
    while True:
        ui.cls()
        user = session["user"]
        ui.titre(f"⚙️   ESPACE ADMIN — {user['nom']}", ui.ROUGE)
        choix = ui.menu([
            "Lister tous les utilisateurs",
            "Créer un utilisateur",
            "Modifier un utilisateur",
            "Supprimer un utilisateur",
            "Voir le journal de connexion",
            "Voir un dossier médical (déchiffré)",
            "Se déconnecter",
        ])

        if choix == "1":
            admin_lister_users()
        elif choix == "2":
            ecran_inscription()
        elif choix == "3":
            admin_modifier_user()
        elif choix == "4":
            admin_supprimer_user()
        elif choix == "5":
            admin_voir_journal()
        elif choix == "6":
            admin_voir_dossier()
        elif choix == "7":
            session["user"] = None
            bdd.ajouter_log(user["email"], "DÉCONNEXION", "SUCCÈS")
            break
        else:
            ui.erreur("Choix invalide.")
            ui.pause()


def admin_lister_users():
    ui.cls()
    ui.titre("👥  LISTE DES UTILISATEURS", ui.BLEU)
    users = bdd.lister_utilisateurs()
    ui.tableau(
        ["ID", "Nom", "Email", "Rôle", "Créé le"],
        [[u["id"], u["nom"], u["email"], u["role"], u["cree_le"][:16]] for u in users],
        [4, 22, 28, 8, 16]
    )
    ui.pause()


def admin_modifier_user():
    ui.cls()
    ui.titre("✏️   MODIFIER UTILISATEUR", ui.JAUNE)
    admin_lister_users()
    uid  = ui.saisie("ID de l'utilisateur à modifier : ")
    nom  = ui.saisie("Nouveau nom                    : ")
    role = ui.saisie("Nouveau rôle (patient/admin)   : ")
    bdd.modifier_utilisateur(uid, nom, role)
    ui.ok("Utilisateur modifié.")
    ui.pause()


def admin_supprimer_user():
    ui.cls()
    ui.titre("🗑️   SUPPRIMER UTILISATEUR", ui.ROUGE)
    admin_lister_users()
    uid = ui.saisie("ID de l'utilisateur à supprimer : ")
    conf = ui.saisie(f"Confirmer la suppression de l'ID {uid} ? (oui/non) : ")
    if conf.lower() == "oui":
        bdd.supprimer_utilisateur(uid)
        ui.ok("Utilisateur et dossier médical supprimés.")
    else:
        ui.info("Suppression annulée.")
    ui.pause()


def admin_voir_journal():
    ui.cls()
    ui.titre("📜  JOURNAL DE CONNEXION (20 derniers)", ui.CYAN)
    logs = bdd.lire_journal(20)
    ui.tableau(
        ["ID", "Email", "Action", "Statut", "Date"],
        [[l["id"], l["email"], l["action"], l["statut"], l["date_heure"][:16]] for l in logs],
        [4, 26, 18, 8, 16]
    )
    ui.pause()


def admin_voir_dossier():
    ui.cls()
    ui.titre("🏥  DOSSIER MÉDICAL — ADMIN", ui.BLEU)
    admin_lister_users()
    uid = ui.saisie("ID du patient : ")
    voir_dossier(int(uid))


# =============================================================================
# MENU D'ACCUEIL
# =============================================================================

def menu_accueil():
    while True:
        ui.cls()
        ui.titre("🏥  CLINIQUE SÉCURISÉE — INPHB IC 2026", ui.VERT)
        print(f"  {ui.GRIS}Sécurisation : bcrypt (mots de passe) + AES-256-GCM (données){ui.RESET}\n")
        choix = ui.menu([
            "Se connecter",
            "Créer un compte",
            "Quitter",
        ])

        if choix == "1":
            if ecran_connexion():
                if session["user"]["role"] == "admin":
                    menu_admin()
                else:
                    menu_patient()
        elif choix == "2":
            ecran_inscription()
        elif choix == "3":
            ui.cls()
            print(f"\n  {ui.VERT}Au revoir !{ui.RESET}\n")
            sys.exit(0)
        else:
            ui.erreur("Choix invalide.")
            ui.pause()


# =============================================================================
# POINT D'ENTRÉE
# =============================================================================

if __name__ == "__main__":
    # Initialisation de la base de données
    bdd.initialiser()

    # Créer un compte admin par défaut s'il n'existe pas
    if not bdd.trouver_utilisateur("admin@clinique.ci"):
        mdp_admin = hacher_mot_de_passe("Admin@2024!")
        bdd.creer_utilisateur("Administrateur", "admin@clinique.ci", mdp_admin, role="admin")
        print(f"\n  {ui.JAUNE}[INIT] Compte admin créé :{ui.RESET}")
        print(f"        Email    : admin@clinique.ci")
        print(f"        Mot de passe : Admin@2024!\n")
        ui.pause()

    menu_accueil()
