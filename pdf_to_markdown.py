"""
PDF → Markdown  —  Convertisseur amélioré
Fonctionnalités :
  • Sélection multiple de PDFs (lot)
  • Barre de progression par fichier et globale
  • Aperçu du Markdown généré
  • Dossier de sortie auto (même dossier que le PDF) ou personnalisé
  • Ouvrir le fichier après conversion
  • Glisser-déposer (drag & drop)
  • Journal de conversion (succès / erreurs)
"""

import threading
import subprocess
import sys
import os
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

# ── Vérification dépendances ──────────────────────────────────────────────────
try:
    from markitdown import MarkItDown
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "markitdown"])
    from markitdown import MarkItDown

try:
    from tkinterdnd2 import DND_FILES, TkinterDnD
    DND_OK = True
except ImportError:
    DND_OK = False

# ── Constantes UI ─────────────────────────────────────────────────────────────
BG       = "#F5F5F5"
ACCENT   = "#2E7D32"
ACCENT_H = "#1B5E20"
WHITE    = "#FFFFFF"
BORDER   = "#E0E0E0"
TEXT     = "#212121"
MUTED    = "#757575"
RED      = "#C62828"
FONT     = ("Segoe UI", 10)
FONT_B   = ("Segoe UI", 10, "bold")
FONT_BIG = ("Segoe UI", 13, "bold")
MONO     = ("Consolas", 9)


class PdfConverter(TkinterDnD.Tk if DND_OK else tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("PDF → Markdown")
        self.geometry("780x640")
        self.minsize(680, 540)
        self.configure(bg=BG)
        self.resizable(True, True)

        self.pdf_paths: list[Path] = []
        self.out_dir_var  = tk.StringVar(value="")
        self.same_dir_var = tk.BooleanVar(value=True)
        self.open_var     = tk.BooleanVar(value=False)
        self.running      = False

        self._build_ui()
        self._toggle_outdir()

    # ── Construction UI ───────────────────────────────────────────────────────
    def _build_ui(self):
        # Titre
        tk.Label(self, text="Convertisseur PDF → Markdown",
                 font=FONT_BIG, bg=BG, fg=ACCENT).pack(pady=(16, 4))
        tk.Label(self, text="Glissez vos PDF ici ou utilisez le bouton Ajouter",
                 font=FONT, bg=BG, fg=MUTED).pack(pady=(0, 10))

        # ── Zone de drop / liste PDFs ─────────────────────────────────────────
        frame_list = tk.LabelFrame(self, text=" Fichiers PDF ", font=FONT_B,
                                   bg=BG, fg=TEXT, bd=1, relief="solid")
        frame_list.pack(fill="both", expand=True, padx=16, pady=4)

        self.listbox = tk.Listbox(frame_list, font=FONT, bg=WHITE, fg=TEXT,
                                  selectmode="extended", bd=0,
                                  highlightthickness=1, highlightbackground=BORDER,
                                  activestyle="none", selectbackground=ACCENT,
                                  selectforeground=WHITE)
        sb = ttk.Scrollbar(frame_list, orient="vertical",
                           command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.listbox.pack(fill="both", expand=True, padx=6, pady=6)

        if DND_OK:
            self.listbox.drop_target_register(DND_FILES)
            self.listbox.dnd_bind("<<Drop>>", self._on_drop)

        # Boutons liste
        btn_row = tk.Frame(frame_list, bg=BG)
        btn_row.pack(fill="x", padx=6, pady=(0, 6))
        self._btn(btn_row, "+ Ajouter PDF(s)",  self._add_pdfs,   ACCENT).pack(side="left", padx=(0,6))
        self._btn(btn_row, "− Supprimer sel.",  self._remove_sel, "#546E7A").pack(side="left", padx=(0,6))
        self._btn(btn_row, "✕ Vider la liste",  self._clear_list, RED).pack(side="left")
        self.lbl_count = tk.Label(btn_row, text="0 fichier(s)", font=FONT,
                                  bg=BG, fg=MUTED)
        self.lbl_count.pack(side="right")

        # ── Dossier de sortie ─────────────────────────────────────────────────
        frame_out = tk.LabelFrame(self, text=" Dossier de sortie ", font=FONT_B,
                                  bg=BG, fg=TEXT, bd=1, relief="solid")
        frame_out.pack(fill="x", padx=16, pady=4)

        tk.Checkbutton(frame_out, text="Même dossier que le PDF",
                       variable=self.same_dir_var, font=FONT, bg=BG, fg=TEXT,
                       activebackground=BG, command=self._toggle_outdir).pack(
            anchor="w", padx=8, pady=(4, 2))

        self.out_row = tk.Frame(frame_out, bg=BG)
        self.out_row.pack(fill="x", padx=8, pady=(0, 6))
        self.out_entry = tk.Entry(self.out_row, textvariable=self.out_dir_var,
                                  font=FONT, bg=WHITE, relief="solid", bd=1)
        self.out_entry.pack(side="left", fill="x", expand=True)
        self._btn(self.out_row, "Parcourir", self._choose_out, ACCENT).pack(side="left", padx=(6,0))

        # ── Options ───────────────────────────────────────────────────────────
        opt_row = tk.Frame(self, bg=BG)
        opt_row.pack(fill="x", padx=16, pady=2)
        tk.Checkbutton(opt_row, text="Ouvrir le fichier .md après conversion",
                       variable=self.open_var, font=FONT, bg=BG, fg=TEXT,
                       activebackground=BG).pack(side="left")

        # ── Progression ───────────────────────────────────────────────────────
        prog_frame = tk.Frame(self, bg=BG)
        prog_frame.pack(fill="x", padx=16, pady=6)

        self.lbl_file = tk.Label(prog_frame, text="Prêt", font=FONT,
                                 bg=BG, fg=MUTED, anchor="w")
        self.lbl_file.pack(fill="x")

        self.prog_file = ttk.Progressbar(prog_frame, mode="determinate", maximum=100)
        self.prog_file.pack(fill="x", pady=(2,4))

        self.lbl_total = tk.Label(prog_frame, text="", font=FONT, bg=BG,
                                  fg=MUTED, anchor="w")
        self.lbl_total.pack(fill="x")
        self.prog_total = ttk.Progressbar(prog_frame, mode="determinate", maximum=100)
        self.prog_total.pack(fill="x")

        # ── Bouton convertir + journal ────────────────────────────────────────
        self.btn_convert = tk.Button(self, text="▶  Convertir",
                                     font=("Segoe UI", 11, "bold"),
                                     bg=ACCENT, fg=WHITE, activebackground=ACCENT_H,
                                     activeforeground=WHITE, relief="flat",
                                     cursor="hand2", height=2,
                                     command=self._start_conversion)
        self.btn_convert.pack(fill="x", padx=16, pady=(8, 4))

        log_frame = tk.LabelFrame(self, text=" Journal ", font=FONT_B,
                                  bg=BG, fg=TEXT, bd=1, relief="solid")
        log_frame.pack(fill="both", expand=False, padx=16, pady=(0, 12))
        self.log = tk.Text(log_frame, height=5, font=MONO, bg="#FAFAFA",
                           fg=TEXT, relief="flat", state="disabled",
                           wrap="word")
        log_sb = ttk.Scrollbar(log_frame, orient="vertical",
                               command=self.log.yview)
        self.log.configure(yscrollcommand=log_sb.set)
        log_sb.pack(side="right", fill="y")
        self.log.pack(fill="both", expand=True, padx=4, pady=4)
        self.log.tag_config("ok",  foreground=ACCENT)
        self.log.tag_config("err", foreground=RED)
        self.log.tag_config("inf", foreground=MUTED)

    def _btn(self, parent, text, cmd, color):
        return tk.Button(parent, text=text, command=cmd, font=FONT,
                         bg=color, fg=WHITE, activebackground=color,
                         activeforeground=WHITE, relief="flat",
                         cursor="hand2", padx=10, pady=4)

    # ── Gestion fichiers ──────────────────────────────────────────────────────
    def _add_pdfs(self):
        paths = filedialog.askopenfilenames(
            title="Sélectionner des PDFs",
            filetypes=[("Fichiers PDF", "*.pdf"), ("Tous", "*.*")])
        for p in paths:
            self._add_path(p)

    def _on_drop(self, event):
        raw = event.data
        paths = self.tk.splitlist(raw)
        for p in paths:
            if p.lower().endswith(".pdf"):
                self._add_path(p)

    def _add_path(self, p):
        path = Path(p)
        if path not in self.pdf_paths:
            self.pdf_paths.append(path)
            self.listbox.insert("end", str(path))
            self._update_count()

    def _remove_sel(self):
        for i in reversed(self.listbox.curselection()):
            self.listbox.delete(i)
            self.pdf_paths.pop(i)
        self._update_count()

    def _clear_list(self):
        self.listbox.delete(0, "end")
        self.pdf_paths.clear()
        self._update_count()

    def _update_count(self):
        n = len(self.pdf_paths)
        self.lbl_count.config(text=f"{n} fichier(s)")

    # ── Dossier sortie ────────────────────────────────────────────────────────
    def _toggle_outdir(self):
        state = "disabled" if self.same_dir_var.get() else "normal"
        self.out_entry.config(state=state)
        for w in self.out_row.winfo_children():
            if isinstance(w, tk.Button):
                w.config(state=state)

    def _choose_out(self):
        d = filedialog.askdirectory(title="Choisir le dossier de sortie")
        if d:
            self.out_dir_var.set(d)

    # ── Journal ───────────────────────────────────────────────────────────────
    def _log(self, msg, tag="inf"):
        self.log.config(state="normal")
        self.log.insert("end", msg + "\n", tag)
        self.log.see("end")
        self.log.config(state="disabled")

    # ── Conversion ────────────────────────────────────────────────────────────
    def _start_conversion(self):
        if self.running:
            return
        if not self.pdf_paths:
            messagebox.showwarning("Aucun fichier", "Ajoutez au moins un fichier PDF.")
            return
        if not self.same_dir_var.get() and not self.out_dir_var.get().strip():
            messagebox.showwarning("Dossier manquant", "Choisissez un dossier de sortie.")
            return
        self.running = True
        self.btn_convert.config(state="disabled", text="Conversion en cours…")
        thread = threading.Thread(target=self._run_conversion, daemon=True)
        thread.start()

    def _run_conversion(self):
        md_engine = MarkItDown()
        total = len(self.pdf_paths)
        ok = err = 0
        last_out = None

        self._log(f"─── Démarrage : {total} fichier(s) ───", "inf")

        for i, pdf in enumerate(self.pdf_paths):
            pct_total = int(i / total * 100)
            self.after(0, self._set_progress, pct_total, 0,
                       f"Fichier {i+1}/{total} : {pdf.name}",
                       f"Progression globale : {i}/{total}")

            try:
                # Progression fichier simulée (markitdown ne donne pas de callback)
                self.after(0, self._set_progress, pct_total, 30, None, None)

                result = md_engine.convert(str(pdf))

                self.after(0, self._set_progress, pct_total, 80, None, None)

                if self.same_dir_var.get():
                    out_dir = pdf.parent
                else:
                    out_dir = Path(self.out_dir_var.get().strip())

                out_dir.mkdir(parents=True, exist_ok=True)
                out_file = out_dir / (pdf.stem + ".md")
                out_file.write_text(result.text_content, encoding="utf-8")
                last_out = out_file
                ok += 1
                self.after(0, self._set_progress, pct_total, 100, None, None)
                self.after(0, self._log, f"✓ {pdf.name}  →  {out_file.name}", "ok")

            except Exception as e:
                err += 1
                self.after(0, self._log, f"✗ {pdf.name}  —  {e}", "err")

        self.after(0, self._set_progress, 100, 100,
                   "Terminé", f"Terminé : {ok} réussi(s), {err} erreur(s)")
        self.after(0, self._log,
                   f"─── Terminé : {ok} OK  /  {err} erreur(s) ───", "inf")
        self.after(0, self._done, ok, err, last_out)

    def _set_progress(self, total_pct, file_pct, lbl_file, lbl_total):
        self.prog_total["value"] = total_pct
        self.prog_file["value"]  = file_pct
        if lbl_file  is not None: self.lbl_file.config(text=lbl_file)
        if lbl_total is not None: self.lbl_total.config(text=lbl_total)

    def _done(self, ok, err, last_out):
        self.running = False
        self.btn_convert.config(state="normal", text="▶  Convertir")
        msg = f"{ok} fichier(s) converti(s) avec succès."
        if err:
            msg += f"\n{err} erreur(s) — voir le journal."
        messagebox.showinfo("Conversion terminée", msg)
        if self.open_var.get() and last_out and last_out.exists():
            os.startfile(str(last_out))


if __name__ == "__main__":
    app = PdfConverter()
    app.mainloop()
