"""
=============================================================================
MODULE BASE DE DONNÉES — SQLite
=============================================================================
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "clinique.db")

def connexion():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def initialiser():
    """Crée les tables si elles n'existent pas."""
    conn = connexion()
    cur  = conn.cursor()

    # Table utilisateurs (authentification)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS utilisateurs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            nom         TEXT    NOT NULL,
            email       TEXT    UNIQUE NOT NULL,
            mot_de_passe TEXT   NOT NULL,
            role        TEXT    NOT NULL DEFAULT 'patient',
            cree_le     DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Table dossiers médicaux (données sensibles chiffrées)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS dossiers_medicaux (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            utilisateur_id      INTEGER NOT NULL,
            antecedents         TEXT,
            allergies           TEXT,
            traitements         TEXT,
            groupe_sanguin      TEXT,
            notes               TEXT,
            modifie_le          DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (utilisateur_id) REFERENCES utilisateurs(id)
        )
    """)

    # Table journal (logs de connexion)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS journal (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            email       TEXT,
            action      TEXT,
            statut      TEXT,
            date_heure  DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    conn.commit()
    conn.close()

# ─── Utilisateurs ─────────────────────────────────────────────────────────────
def creer_utilisateur(nom, email, mdp_hache, role="patient"):
    conn = connexion()
    try:
        conn.execute(
            "INSERT INTO utilisateurs (nom, email, mot_de_passe, role) VALUES (?,?,?,?)",
            (nom, email, mdp_hache, role)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False  # Email déjà utilisé
    finally:
        conn.close()

def trouver_utilisateur(email):
    conn = connexion()
    user = conn.execute(
        "SELECT * FROM utilisateurs WHERE email = ?", (email,)
    ).fetchone()
    conn.close()
    return user

def lister_utilisateurs():
    conn = connexion()
    users = conn.execute(
        "SELECT id, nom, email, role, cree_le FROM utilisateurs ORDER BY id"
    ).fetchall()
    conn.close()
    return users

def modifier_utilisateur(user_id, nom, role):
    conn = connexion()
    conn.execute(
        "UPDATE utilisateurs SET nom=?, role=? WHERE id=?",
        (nom, role, user_id)
    )
    conn.commit()
    conn.close()

def supprimer_utilisateur(user_id):
    conn = connexion()
    conn.execute("DELETE FROM dossiers_medicaux WHERE utilisateur_id=?", (user_id,))
    conn.execute("DELETE FROM utilisateurs WHERE id=?", (user_id,))
    conn.commit()
    conn.close()

# ─── Dossiers médicaux ────────────────────────────────────────────────────────
def creer_ou_maj_dossier(user_id, antecedents, allergies, traitements, groupe, notes):
    conn = connexion()
    existant = conn.execute(
        "SELECT id FROM dossiers_medicaux WHERE utilisateur_id=?", (user_id,)
    ).fetchone()
    if existant:
        conn.execute("""
            UPDATE dossiers_medicaux
            SET antecedents=?, allergies=?, traitements=?, groupe_sanguin=?,
                notes=?, modifie_le=CURRENT_TIMESTAMP
            WHERE utilisateur_id=?
        """, (antecedents, allergies, traitements, groupe, notes, user_id))
    else:
        conn.execute("""
            INSERT INTO dossiers_medicaux
            (utilisateur_id, antecedents, allergies, traitements, groupe_sanguin, notes)
            VALUES (?,?,?,?,?,?)
        """, (user_id, antecedents, allergies, traitements, groupe, notes))
    conn.commit()
    conn.close()

def lire_dossier(user_id):
    conn = connexion()
    dossier = conn.execute(
        "SELECT * FROM dossiers_medicaux WHERE utilisateur_id=?", (user_id,)
    ).fetchone()
    conn.close()
    return dossier

# ─── Journal ──────────────────────────────────────────────────────────────────
def ajouter_log(email, action, statut):
    conn = connexion()
    conn.execute(
        "INSERT INTO journal (email, action, statut) VALUES (?,?,?)",
        (email, action, statut)
    )
    conn.commit()
    conn.close()

def lire_journal(limite=20):
    conn = connexion()
    logs = conn.execute(
        "SELECT * FROM journal ORDER BY id DESC LIMIT ?", (limite,)
    ).fetchall()
    conn.close()
    return logs
