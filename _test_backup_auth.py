import json
import sqlite3
from pathlib import Path

import server

BASE = Path(__file__).parent
conn = sqlite3.connect(str(BASE / "app.sqlite3"))
raw = conn.execute("SELECT v FROM kv WHERE k='state'").fetchone()
conn.close()
if not raw:
    print("no state in sqlite")
    raise SystemExit(1)
state = json.loads(raw[0])
for u in state.get("auth", {}).get("users", []):
    if "romy" in str(u.get("username", "")).lower():
        print("DB user:", {k: u.get(k) for k in ("username", "role", "allowedSiteIds")})
print("sites:", [s.get("id") for s in state.get("sites", [])])

store = server.DataStore()
store._state = state
session = {
    "username": "romy",
    "role": "admin",
    "allowedSiteIds": ["ROMY"],
    "globalSuperadmin": False,
}
bs = server.resolve_backup_session(session, store)
all_ids = store.all_site_ids()
print("resolved:", bs.get("role"), bs.get("allowedSiteIds"), bs.get("globalSuperadmin"))
print("can backup:", server.session_can_manage_maquis_backups(bs, all_site_ids=all_ids))
print("can backup raw session:", server.session_can_manage_maquis_backups(session, all_site_ids=all_ids))
