"""Donne au compte « tanoh » les mêmes droits super-admin global que « admin »."""
from pathlib import Path

JS = Path(__file__).resolve().parent.parent / "app-orders.js"
HTML = Path(__file__).resolve().parent.parent / "index.html"
t = JS.read_text(encoding="utf-8")

t = t.replace(
    """function canGlobalSuperAdmin() {
  if (String(sessionUser || "").trim().toLowerCase() === "admin") return true;""",
    """function canGlobalSuperAdmin() {
  const _gsUn = String(sessionUser || "").trim().toLowerCase();
  if (_gsUn === "admin" || _gsUn === "tanoh") return true;""",
    1,
)

t = t.replace(
    """function normalizeRoleForUsername(username, role) {
  if (String(username || "").trim().toLowerCase() === "admin") return "superadmin";
  return role;
}""",
    """function normalizeRoleForUsername(username, role) {
  const un = String(username || "").trim().toLowerCase();
  if (un === "admin" || un === "tanoh") return "superadmin";
  return role;
}""",
    1,
)

JS.write_text(t, encoding="utf-8")
html = HTML.read_text(encoding="utf-8")
for v in ("372", "371", "370"):
    if f"app-orders.js?v={v}" in html:
        html = html.replace(f"app-orders.js?v={v}", "app-orders.js?v=373")
        break
HTML.write_text(html, encoding="utf-8")
print("ok")
