from pathlib import Path

p = Path(__file__).resolve().parent.parent / "app-orders.js"
t = p.read_text(encoding="utf-8")
old = """/** Vrai si la serveuse courante est en service (via vente ou prise explicite). */
function serveuseIsOnSalesRelay(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  const current = currentServeuseOnDuty(siteId);
  if (current === null) return true; // personne → n'importe qui peut démarrer
  return current === String(sessionUser || "").trim().toLowerCase();
}"""
new = """/** Vrai si la serveuse courante est la vendeuse / relais autorisé du jour. */
function serveuseIsOnSalesRelay(siteId = currentSiteId()) {
  if (!staffRequiresShiftWindowForSales()) return false;
  const current = currentServeuseOnDuty(siteId);
  if (current === null) return false;
  return current === String(sessionUser || "").trim().toLowerCase();
}"""
if old not in t:
    raise SystemExit("pattern not found")
p.write_text(t.replace(old, new, 1), encoding="utf-8")
print("patched serveuseIsOnSalesRelay")
