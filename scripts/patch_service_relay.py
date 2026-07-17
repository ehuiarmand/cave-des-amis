"""Demande de prise de service (serveuse) + validation gérante."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent
SRV = ROOT / "server.py"
JS = ROOT / "app-orders.js"
HTML = ROOT / "index.html"
SCHEMA = ROOT / "schema.sql"

SERVER_FN = '''
def merge_service_relay_serveuse(
    current: list[Any],
    incoming: list[Any],
    session: dict[str, Any],
    allowed: set[str],
    site_ids: list[str],
) -> list[Any]:
    """Serveuse : ajouter uniquement sa propre demande en attente (status=pending)."""
    canon = str(session.get("username", "")).strip()
    key = canon.casefold()
    kept = [copy.deepcopy(r) for r in (current or []) if isinstance(r, dict)]

    def in_scope(row: dict[str, Any]) -> bool:
        es = row_effective_site_id(row, site_ids, allowed)
        return es is not None and es in allowed

    for row in incoming or []:
        if not isinstance(row, dict) or not in_scope(row):
            continue
        if str(row.get("username", "")).strip().casefold() != key:
            continue
        st = str(row.get("status") or "pending").strip().lower()
        if st != "pending":
            continue
        site_id = str(row.get("siteId") or "")
        day = str(row.get("date") or "")[:10]
        kept = [
            r for r in kept
            if not (
                isinstance(r, dict)
                and str(r.get("username", "")).strip().casefold() == key
                and str(r.get("siteId") or "") == site_id
                and str(r.get("date") or "")[:10] == day
                and str(r.get("status") or "approved").strip().lower() == "pending"
            )
        ]
        kept.append({
            **row,
            "username": canon,
            "status": "pending",
            "requestedAt": row.get("requestedAt") or row.get("takenAt") or utc_now_iso(),
        })
    return kept

'''

JS_BLOCK = '''
function serviceRelayIsApproved(row) {
  const st = String(row?.status || "").trim().toLowerCase();
  if (st === "approved") return true;
  if (st === "pending" || st === "rejected") return false;
  return true;
}

function pendingServiceRelayRequest(username = sessionUser, siteId = currentSiteId()) {
  const un = String(username || "").trim().toLowerCase();
  const sid = String(siteId || "");
  const d = workingDate(siteId);
  if (!un || !sid || !d) return null;
  return (state.serviceRelay || []).find(
    (r) => String(r.siteId || "") === sid
      && String(r.date || "").slice(0, 10) === d
      && String(r.username || "").trim().toLowerCase() === un
      && String(r.status || "pending").trim().toLowerCase() === "pending",
  ) || null;
}

function serviceRelayRequestsForSite(siteId = currentSiteId(), includeResolved = false) {
  const sid = String(siteId || "");
  const d = workingDate(siteId);
  return (state.serviceRelay || []).filter((r) => {
    if (String(r.siteId || "") !== sid) return false;
    if (String(r.date || "").slice(0, 10) !== d) return false;
    const st = String(r.status || "pending").trim().toLowerCase();
    if (!includeResolved && st !== "pending") return false;
    return true;
  });
}

function renderPlanningRelayRequests() {
  const box = document.getElementById("planning-team-relay-requests");
  if (!box || !canManageTeamSchedule()) return;
  const rows = serviceRelayRequestsForSite(currentSiteId(), false);
  if (!rows.length) {
    box.innerHTML = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<div class="section-head" style="margin-bottom:8px"><h4 style="margin:0">Demandes de prise de service</h4></div>`
    + rows.map((r) => {
      const from = r.takenFrom ? staffDisplayName(r.takenFrom) : "personne";
      const who = escapeHtml(staffDisplayName(r.username));
      return `<article class="list-item"><div><p class="list-item-title">${who}</p><p class="list-item-sub">Remplace ${escapeHtml(from)} · ${escapeHtml(formatDateTimeDdMmYyyy(r.requestedAt || r.takenAt || ""))}</p></div><div class="list-side" style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" class="mini-btn" data-relay-approve="${escapeHtml(String(r.id))}">Autoriser</button><button type="button" class="mini-btn del-btn" data-relay-reject="${escapeHtml(String(r.id))}">Refuser</button></div></article>`;
    }).join("");
  box.querySelectorAll("[data-relay-approve]").forEach((btn) => {
    btn.addEventListener("click", () => approveServiceRelayRequest(btn.getAttribute("data-relay-approve")).catch(handleApiError));
  });
  box.querySelectorAll("[data-relay-reject]").forEach((btn) => {
    btn.addEventListener("click", () => rejectServiceRelayRequest(btn.getAttribute("data-relay-reject")).catch(handleApiError));
  });
}

async function approveServiceRelayRequest(id) {
  if (!canManageTeamSchedule()) { showToast("Accès refusé."); return; }
  const rid = String(id || "");
  const row = (state.serviceRelay || []).find((r) => String(r.id) === rid);
  if (!row) { showToast("Demande introuvable."); return; }
  if (!window.confirm(`Autoriser ${staffDisplayName(row.username)} à prendre le service ?`)) return;
  row.status = "approved";
  row.decidedAt = new Date().toISOString();
  row.decidedBy = sessionUser;
  row.takenAt = row.takenAt || row.requestedAt || row.decidedAt;
  recordStaffAudit("update", "planning", "Prise de service autorisée", `${row.username} ← ${row.takenFrom || "—"}`);
  await persistState({ serviceRelay: state.serviceRelay, staffAuditLog: state.staffAuditLog });
  showToast(`${staffDisplayName(row.username)} peut vendre.`);
  renderPlanningMine();
  renderPlanningTeam();
  syncServeuseVentesPageRestDay();
}

async function rejectServiceRelayRequest(id) {
  if (!canManageTeamSchedule()) { showToast("Accès refusé."); return; }
  const rid = String(id || "");
  const row = (state.serviceRelay || []).find((r) => String(r.id) === rid);
  if (!row) { showToast("Demande introuvable."); return; }
  if (!window.confirm(`Refuser la demande de ${staffDisplayName(row.username)} ?`)) return;
  row.status = "rejected";
  row.decidedAt = new Date().toISOString();
  row.decidedBy = sessionUser;
  recordStaffAudit("update", "planning", "Prise de service refusée", row.username);
  await persistState({ serviceRelay: state.serviceRelay, staffAuditLog: state.staffAuditLog });
  showToast("Demande refusée.");
  renderPlanningTeam();
  renderPlanningMine();
}

'''


def patch_server(text: str) -> str:
    if "merge_service_relay_serveuse" in text:
        print("server.py already patched")
        return text
    anchor = "def merge_scoped_rows("
    text = text.replace(anchor, SERVER_FN + anchor, 1)
    text = text.replace(
        '"workShifts",\n)',
        '"workShifts",\n    "serviceRelay",\n)',
        1,
    )
    text = text.replace(
        '"loyaltyClients":   ("loyalty_clients",  "int"),\n',
        '"loyaltyClients":   ("loyalty_clients",  "int"),\n    "serviceRelay":     ("service_relay",    "int"),\n',
        1,
    )
    text = text.replace(
        '"loyaltyClients": [],\n    "consignes": [],',
        '"loyaltyClients": [],\n    "serviceRelay": [],\n    "consignes": [],',
        1,
    )
    text = text.replace(
        '"loyaltyClient": 1,\n    },',
        '"loyaltyClient": 1,\n        "serviceRelay": 1,\n    },',
        1,
    )
    for old, new in [
        ('"loyaltyClients", "consignes", "charges", "staffAuditLog", "workShifts",',
         '"loyaltyClients", "serviceRelay", "consignes", "charges", "staffAuditLog", "workShifts",'),
        ('"creditRecoveries", "clientAvoirs", "loyaltyClients",\n            })',
         '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay",\n            })'),
        ('"creditRecoveries", "clientAvoirs", "loyaltyClients", "consignes", "charges", "staffAuditLog",\n                "stockEntrees"',
         '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay", "consignes", "charges", "staffAuditLog",\n                "stockEntrees"'),
    ]:
        text = text.replace(old, new, 1)
    # blocs de migration / fusion
    text = text.replace(
        '"loyaltyClients": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("loyaltyClients", [])],\n',
        '"loyaltyClients": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("loyaltyClients", [])],\n            "serviceRelay": [{**item, "siteId": item.get("siteId", site_id)} for item in payload.get("serviceRelay", [])],\n',
        1,
    )
    text = text.replace(
        '"loyaltyClients": copy.deepcopy(s.get("loyaltyClients", [])),\n',
        '"loyaltyClients": copy.deepcopy(s.get("loyaltyClients", [])),\n                "serviceRelay": copy.deepcopy(s.get("serviceRelay", [])),\n',
        1,
    )
    text = text.replace(
        '"loyaltyClients": filter_site_rows(self._state.get("loyaltyClients", [])),\n',
        '"loyaltyClients": filter_site_rows(self._state.get("loyaltyClients", [])),\n                "serviceRelay": filter_site_rows(self._state.get("serviceRelay", [])),\n',
        1,
    )
    text = text.replace(
        'merged["loyaltyClients"] = payload.get("loyaltyClients", merged.get("loyaltyClients", []))\n',
        'merged["loyaltyClients"] = payload.get("loyaltyClients", merged.get("loyaltyClients", []))\n        merged["serviceRelay"] = payload.get("serviceRelay", merged.get("serviceRelay", []))\n',
        2,
    )
    text = text.replace(
        '            merged["loyaltyClients"] = payload.get("loyaltyClients", merged.get("loyaltyClients", []))\n            merged["consignes"]',
        '            merged["loyaltyClients"] = payload.get("loyaltyClients", merged.get("loyaltyClients", []))\n            merged["serviceRelay"] = payload.get("serviceRelay", merged.get("serviceRelay", []))\n            merged["consignes"]',
        1,
    )
    text = text.replace(
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "consignes", "charges", "staffAuditLog",\n                "stockEntrees", "stockLosses", "workShifts",\n            ]',
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay", "consignes", "charges", "staffAuditLog",\n                "stockEntrees", "stockLosses", "workShifts",\n            ]',
        1,
    )
    text = text.replace(
        '"creditRecoveries", "clientAvoirs", "loyaltyClients",\n            })',
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay",\n            })',
        1,
    )
    text = text.replace(
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "consignes", "charges", "staffAuditLog",\n                "stockEntrees", "stockLosses", "workShifts",\n            ]\n            # Retirer',
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay", "consignes", "charges", "staffAuditLog",\n                "stockEntrees", "stockLosses", "workShifts",\n            ]\n            # Retirer',
        1,
    )
    text = text.replace(
        '"stockEntrees", "stockLosses", "workShifts",\n            })',
        '"stockEntrees", "stockLosses", "workShifts", "serviceRelay",\n            })',
        1,
    )
    merge_branch = """                    elif _key == "commandes":
                        current[_key] = merge_commandes_scoped("""
    merge_new = """                    elif _key == "serviceRelay":
                        if str(session.get("role", "")).strip().lower() == "serveuse":
                            current[_key] = merge_service_relay_serveuse(
                                current.get(_key, []),
                                payload[_key],
                                session,
                                allowed,
                                sid_list,
                            )
                        else:
                            current[_key] = merge_scoped_rows(
                                current.get(_key, []),
                                payload[_key],
                                allowed,
                                sid_list,
                            )
                    elif _key == "commandes":
                        current[_key] = merge_commandes_scoped("""
    if merge_branch not in text:
        raise SystemExit("PUT merge branch not found")
    text = text.replace(merge_branch, merge_new, 1)
    return text


def patch_js(text: str) -> str:
    if "function serviceRelayIsApproved" in text:
        print("app-orders.js already patched")
        return text
    anchor = "function currentServeuseOnDuty(siteId = currentSiteId()) {"
    text = text.replace(anchor, JS_BLOCK + anchor, 1)
    old_relay = """  const todayRelay = (state.serviceRelay || []).filter(
    (r) => String(r.siteId || "") === sid && String(r.date || "").slice(0, 10) === d,
  );"""
    new_relay = """  const todayRelay = (state.serviceRelay || []).filter(
    (r) => String(r.siteId || "") === sid && String(r.date || "").slice(0, 10) === d && serviceRelayIsApproved(r),
  );"""
    text = text.replace(old_relay, new_relay, 1)
    old_take = """async function takeService() {
  const siteId = currentSiteId();
  const d = workingDate(siteId);
  if (!d) return;
  const onDuty = currentServeuseOnDuty(siteId);
  const me = String(sessionUser || "").trim().toLowerCase();
  if (onDuty === me) return;
  const fromName = onDuty ? staffDisplayName(onDuty) : null;
  const msg = fromName
    ? `Prendre le service de ${fromName} ?`
    : "Démarrer le service ?";
  if (!window.confirm(msg)) return;
  if (!Array.isArray(state.serviceRelay)) state.serviceRelay = [];
  state.serviceRelay.push({
    id: Date.now(),
    siteId,
    date: d,
    username: me,
    takenAt: new Date().toISOString(),
    takenFrom: onDuty || null,
  });
  recordStaffAudit("update", "planning",
    `Prise de service`,
    fromName ? `${me} a pris le service de ${fromName}` : `${me} a démarré le service`);
  await persistState({ serviceRelay: state.serviceRelay, staffAuditLog: state.staffAuditLog });
  showToast(fromName ? `Service pris de ${fromName}.` : "Service démarré.");
  renderPlanningMine();
  if (canManageTeamSchedule()) renderPlanningTeam();
}"""
    new_take = """async function requestTakeService() {
  const siteId = currentSiteId();
  const d = workingDate(siteId);
  if (!d) return;
  const onDuty = currentServeuseOnDuty(siteId);
  const me = String(sessionUser || "").trim().toLowerCase();
  if (onDuty === me) return;
  if (pendingServiceRelayRequest(me, siteId)) {
    showToast("Demande déjà envoyée — en attente de la gérante.");
    return;
  }
  const fromName = onDuty ? staffDisplayName(onDuty) : null;
  const msg = fromName
    ? `Demander à la gérante l'autorisation de remplacer ${fromName} ?`
    : "Demander à la gérante l'autorisation de démarrer le service ?";
  if (!window.confirm(msg)) return;
  if (!Array.isArray(state.serviceRelay)) state.serviceRelay = [];
  if (!state.nextId) state.nextId = {};
  if (state.nextId.serviceRelay == null) {
    const maxId = state.serviceRelay.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
    state.nextId.serviceRelay = Math.max(1, maxId + 1);
  }
  state.serviceRelay.unshift({
    id: state.nextId.serviceRelay++,
    siteId,
    date: d,
    username: me,
    status: "pending",
    requestedAt: new Date().toISOString(),
    takenFrom: onDuty || null,
  });
  recordStaffAudit("update", "planning", "Demande prise de service", fromName ? `${me} → ${fromName}` : me);
  await persistState({ serviceRelay: state.serviceRelay, nextId: state.nextId, staffAuditLog: state.staffAuditLog });
  showToast("Demande envoyée à la gérante.");
  renderPlanningMine();
}"""
    text = text.replace(old_take, new_take, 1)
    old_ui = """  const canSell = staffIsOnDutyNow(siteId);
  const showTakeServiceBtn = !canSell && isServeuseAccount();"""
    new_ui = """  const canSell = staffIsOnDutyNow(siteId);
  const pendingRelay = pendingServiceRelayRequest(sessionUser, siteId);
  const showTakeServiceBtn = !canSell && isServeuseAccount() && !pendingRelay;"""
    text = text.replace(old_ui, new_ui, 1)
    old_btn = """      const btnLabel = onDutyName ? "Prendre le service" : "Démarrer le service";
      const _openSvc = serveuseHasOpenServiceToday();
      sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #e08a1e;padding:10px 12px;font-size:0.88rem">
        <strong>${title}</strong>
        <p style="margin:4px 0 8px;font-size:0.83rem;color:var(--muted)">Cliquez pour pouvoir vendre.</p>
        <button type="button" class="btn btn-sm btn-outline" id="take-service-btn">${btnLabel}</button>"""
    new_btn = """      const btnLabel = onDutyName ? "Demander à la gérante" : "Demander à démarrer";
      const _openSvc = serveuseHasOpenServiceToday();
      sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #e08a1e;padding:10px 12px;font-size:0.88rem">
        <strong>${title}</strong>
        <p style="margin:4px 0 8px;font-size:0.83rem;color:var(--muted)">La gérante doit autoriser la prise de service dans Planning → Équipe.</p>
        <button type="button" class="btn btn-sm btn-outline" id="take-service-btn">${btnLabel}</button>"""
    text = text.replace(old_btn, new_btn, 1)
    text = text.replace(
        'document.getElementById("take-service-btn")?.addEventListener("click", () => takeService().catch(handleApiError));',
        'document.getElementById("take-service-btn")?.addEventListener("click", () => requestTakeService().catch(handleApiError));',
        1,
    )
    pending_ui = """    } else if (canSell) {"""
    pending_insert = """    } else if (pendingRelay) {
      sumEl.innerHTML = `<div class="inline-card" style="border-left:3px solid #e08a1e;padding:10px 12px;font-size:0.88rem">
        <strong>Demande en attente</strong>
        <p style="margin:4px 0 0;font-size:0.83rem;color:var(--muted)">La gérante doit valider dans Planning → Équipe avant que vous puissiez vendre.</p>
      </div>`;
    } else if (canSell) {"""
    text = text.replace(pending_ui, pending_insert, 1)
    text = text.replace(
        '  document.getElementById("take-service-btn")?.addEventListener("click", () => requestTakeService().catch(handleApiError));',
        '  document.getElementById("take-service-btn")?.addEventListener("click", () => requestTakeService().catch(handleApiError));',
        1,
    )
    text = text.replace(
        """  if (serviceNowEl) {
    const siteId = currentSiteId();
    const onDuty = currentServeuseOnDuty(siteId);""",
        """  renderPlanningRelayRequests();
  if (serviceNowEl) {
    const siteId = currentSiteId();
    const onDuty = currentServeuseOnDuty(siteId);""",
        1,
    )
    text = text.replace(
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "consignes", "charges", "staffAuditLog", "workShifts",\n];',
        '"creditRecoveries", "clientAvoirs", "loyaltyClients", "serviceRelay", "consignes", "charges", "staffAuditLog", "workShifts",\n];',
        1,
    )
    text = text.replace(
        '  if (!Array.isArray(state.workShifts)) state.workShifts = [];',
        '  if (!Array.isArray(state.workShifts)) state.workShifts = [];\n  if (!Array.isArray(state.serviceRelay)) state.serviceRelay = [];',
        1,
    )
    text = text.replace(
        '      if (!Array.isArray(state.loyaltyClients)) state.loyaltyClients = [];',
        '      if (!Array.isArray(state.loyaltyClients)) state.loyaltyClients = [];\n      if (!Array.isArray(state.serviceRelay)) state.serviceRelay = [];',
        1,
    )
    return text


def patch_html(text: str) -> str:
    if 'id="planning-team-relay-requests"' in text:
        return text
    text = text.replace(
        '<div id="planning-team-service-now" style="margin-bottom:10px"></div>',
        '<div id="planning-team-relay-requests" class="hidden" style="margin-bottom:12px"></div>\n            <div id="planning-team-service-now" style="margin-bottom:10px"></div>',
        1,
    )
    text = text.replace(
        'Planifiez les créneaux des serveuses et gérantes du maquis actif.',
        'Planifiez les créneaux et validez les demandes de prise de service.',
        1,
    )
    text = text.replace("app-orders.js?v=368", "app-orders.js?v=369", 1)
    return text


def patch_schema(text: str) -> str:
    if "service_relay" in text:
        return text
    block = '''
-- Prises de service (demandes + validations gérante)
CREATE TABLE IF NOT EXISTS service_relay (
    row_id  BIGSERIAL PRIMARY KEY,
    item_id BIGINT,
    site_id TEXT,
    data    JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_service_relay_site_id ON service_relay (site_id);

'''
    return text.replace("-- Charges (dépenses)", block + "-- Charges (dépenses)", 1)


def main() -> None:
    SRV.write_text(patch_server(SRV.read_text(encoding="utf-8")), encoding="utf-8")
    print("patched server.py")
    JS.write_text(patch_js(JS.read_text(encoding="utf-8")), encoding="utf-8")
    print("patched app-orders.js")
    HTML.write_text(patch_html(HTML.read_text(encoding="utf-8")), encoding="utf-8")
    print("patched index.html")
    SCHEMA.write_text(patch_schema(SCHEMA.read_text(encoding="utf-8")), encoding="utf-8")
    print("patched schema.sql")


if __name__ == "__main__":
    main()
