"""
=============================================================================
MODULE INTERFACE — Affichage console
=============================================================================
"""
import os

# ─── Couleurs ANSI ────────────────────────────────────────────────────────────
RESET  = "\033[0m"
BOLD   = "\033[1m"
VERT   = "\033[92m"
ROUGE  = "\033[91m"
JAUNE  = "\033[93m"
BLEU   = "\033[94m"
CYAN   = "\033[96m"
GRIS   = "\033[90m"
BLANC  = "\033[97m"

def cls():
    os.system("cls" if os.name == "nt" else "clear")

def titre(texte, couleur=CYAN):
    largeur = 60
    print(f"\n{couleur}{'═'*largeur}{RESET}")
    print(f"{couleur}{BOLD}  {texte.center(largeur-4)}{RESET}")
    print(f"{couleur}{'═'*largeur}{RESET}\n")

def sous_titre(texte, couleur=BLEU):
    print(f"\n{couleur}{BOLD}  ── {texte} ──{RESET}\n")

def separateur(couleur=GRIS):
    print(f"{couleur}  {'─'*56}{RESET}")

def ok(msg):
    print(f"\n  {VERT}✓  {msg}{RESET}")

def erreur(msg):
    print(f"\n  {ROUGE}✗  {msg}{RESET}")

def info(msg):
    print(f"  {JAUNE}ℹ  {msg}{RESET}")

def champ(label, valeur, masquer=False):
    val = "●●●●●●●●" if masquer else valeur
    print(f"  {GRIS}{label:<22}{RESET}{BLANC}{val}{RESET}")

def tableau_ligne(cols, widths, header=False):
    couleur = BLEU if header else RESET
    gras    = BOLD if header else ""
    ligne = "  │"
    for val, w in zip(cols, widths):
        texte = str(val)[:w-1].ljust(w)
        ligne += f" {couleur}{gras}{texte}{RESET} │"
    print(ligne)

def tableau(headers, rows, widths):
    total = sum(w + 3 for w in widths) + 1
    sep_h = "  ├" + "┼".join("─"*(w+2) for w in widths) + "┤"
    top   = "  ┌" + "┬".join("─"*(w+2) for w in widths) + "┐"
    bot   = "  └" + "┴".join("─"*(w+2) for w in widths) + "┘"
    print(top)
    tableau_ligne(headers, widths, header=True)
    print(sep_h)
    if rows:
        for row in rows:
            tableau_ligne(row, widths)
    else:
        print(f"  │ {GRIS}{'Aucune donnée'.center(total-4)}{RESET} │")
    print(bot)

def saisie(prompt, masquer=False):
    print(f"  {CYAN}▶  {prompt}{RESET}", end="")
    if masquer:
        import getpass
        return getpass.getpass("")
    return input("")

def pause():
    print(f"\n  {GRIS}Appuyez sur Entrée pour continuer...{RESET}", end="")
    input()

def menu(options: list[str]) -> str:
    for i, opt in enumerate(options, 1):
        print(f"  {CYAN}[{i}]{RESET}  {opt}")
    separateur()
    return saisie("Votre choix : ")
