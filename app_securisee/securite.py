"""
=============================================================================
MODULE SÉCURITÉ — bcrypt + AES-256-GCM
=============================================================================
"""
import os
import bcrypt
import base64
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import load_dotenv

load_dotenv()

# ─── Clé AES ─────────────────────────────────────────────────────────────────
def get_aes_key() -> bytes:
    key_b64 = os.environ.get("AES_SECRET_KEY")
    if key_b64:
        key = base64.b64decode(key_b64)
        if len(key) != 32:
            raise ValueError("Clé AES invalide : doit faire 32 octets (256 bits).")
        return key
    # Génération automatique si absente (développement)
    nouvelle_cle = AESGCM.generate_key(bit_length=256)
    cle_b64 = base64.b64encode(nouvelle_cle).decode()
    # Écrire dans .env automatiquement
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    with open(env_path, "a") as f:
        f.write(f"\nAES_SECRET_KEY={cle_b64}\n")
    print("[INFO] Clé AES générée et sauvegardée dans .env")
    return nouvelle_cle

CLE_AES = get_aes_key()

# ─── HACHAGE BCRYPT ───────────────────────────────────────────────────────────
def hacher_mot_de_passe(mdp: str) -> str:
    sel   = bcrypt.gensalt(rounds=12)
    hache = bcrypt.hashpw(mdp.encode("utf-8"), sel)
    return hache.decode("utf-8")

def verifier_mot_de_passe(mdp: str, hache_bdd: str) -> bool:
    return bcrypt.checkpw(mdp.encode("utf-8"), hache_bdd.encode("utf-8"))

# ─── CHIFFREMENT AES-256-GCM ──────────────────────────────────────────────────
def chiffrer(texte: str) -> str:
    aesgcm = AESGCM(CLE_AES)
    nonce  = os.urandom(12)
    chiffre = aesgcm.encrypt(nonce, texte.encode("utf-8"), None)
    return base64.b64encode(nonce + chiffre).decode("utf-8")

def dechiffrer(texte_chiffre_b64: str) -> str:
    aesgcm     = AESGCM(CLE_AES)
    brut       = base64.b64decode(texte_chiffre_b64)
    nonce      = brut[:12]
    chiffre    = brut[12:]
    clair      = aesgcm.decrypt(nonce, chiffre, None)
    return clair.decode("utf-8")
