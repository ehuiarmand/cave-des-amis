from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "app-orders.js"
HTML = ROOT / "index.html"

t = JS.read_text(encoding="utf-8")
if 'restoreFromBackup: "/api/admin/restore-from-backup"' not in t:
    t = t.replace(
        '  restoreSiteFromBackup: "/api/admin/restore-site-from-backup",',
        '  restoreSiteFromBackup: "/api/admin/restore-site-from-backup",\n  restoreFromBackup: "/api/admin/restore-from-backup",',
        1,
    )

RESTORE_FN = """
async function restoreFullFromBackup() {
  if (!canGlobalSuperAdmin()) {
    showToast("Seul le super administrateur peut restaurer tous les maquis.");
    return;
  }
  const backupFile = document.getElementById("restore-backup-file")?.value?.trim();
  if (!backupFile) {
    showToast("Choisissez une sauvegarde dans la liste.");
    return;
  }
  if (
    !window.confirm(
      `Restaurer TOUS les maquis depuis la sauvegarde "${backupFile}" ?\\n\\n`
      + "L'état actuel sera entièrement remplacé (sites, ventes, stock, utilisateurs…).\\n"
      + "Choisissez une date récente avant l'incident — pas besoin du fichier du 26 mai.",
    )
  ) {
    return;
  }
  try {
    state = await apiRequest(API.restoreFromBackup, { method: "POST", body: JSON.stringify({ backupFile }) });
    allowedSiteIds = state.allowedSiteIds || allowedSiteIds;
    globalSuperadmin = state.globalSuperadmin;
    await bootstrapAuthenticatedApp({ skipCasierLsRestore: true });
    lsSaveCasiers();
    showToast(`Restauration complete depuis ${backupFile}. Rechargez la page si besoin.`);
  } catch (error) {
    handleApiError(error);
  }
}

"""

if "async function restoreFullFromBackup" not in t:
    t = t.replace("async function restoreSelectedSiteFromBackup()", RESTORE_FN + "async function restoreSelectedSiteFromBackup()", 1)

if 'getElementById("restore-full-backup-btn")' not in t:
    t = t.replace(
        '  document.getElementById("restore-site-backup-btn")?.addEventListener("click", () => restoreSelectedSiteFromBackup().catch(handleApiError));',
        '  document.getElementById("restore-site-backup-btn")?.addEventListener("click", () => restoreSelectedSiteFromBackup().catch(handleApiError));\n  document.getElementById("restore-full-backup-btn")?.addEventListener("click", () => restoreFullFromBackup().catch(handleApiError));',
        1,
    )

JS.write_text(t, encoding="utf-8")

html = HTML.read_text(encoding="utf-8")
btn = '<button id="restore-full-backup-btn" class="btn btn-outline global-superadmin-only" type="button">Restaurer tous les maquis depuis cette sauvegarde</button>'
if "restore-full-backup-btn" not in html:
    html = html.replace(
        '<button id="restore-site-backup-btn" class="btn btn-primary" type="button">Restaurer ce maquis depuis la sauvegarde choisie</button>',
        '<button id="restore-site-backup-btn" class="btn btn-primary" type="button">Restaurer ce maquis depuis la sauvegarde choisie</button>\n              ' + btn,
        1,
    )
for v in ("373", "372", "371"):
    if f"app-orders.js?v={v}" in html:
        html = html.replace(f"app-orders.js?v={v}", "app-orders.js?v=374")
        break
HTML.write_text(html, encoding="utf-8")
print("ok")
