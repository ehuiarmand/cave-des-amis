"""Eviter la reinitialisation demo au demarrage PostgreSQL + miroir data.json."""
from pathlib import Path

SRV = Path(__file__).resolve().parent.parent / "server.py"
t = SRV.read_text(encoding="utf-8")

HELPER = '''
def _is_builtin_demo_state(payload: dict[str, Any]) -> bool:
    """Etat d'installation vierge (Mon Bar Chez Moi / Maquis Plateau)."""
    sites = payload.get("sites") if isinstance(payload, dict) else None
    if not isinstance(sites, list) or len(sites) != 2:
        return False
    rows = [s for s in sites if isinstance(s, dict)]
    if len(rows) != 2:
        return False
    ids = sorted(str(s.get("id", "")) for s in rows)
    names = {str(s.get("nom", "")) for s in rows}
    return ids == ["maquis-1", "maquis-2"] and {"Mon Bar Chez Moi", "Maquis Plateau"}.issubset(names)


'''

if "_is_builtin_demo_state" not in t:
    t = t.replace("def build_default_state() -> dict[str, Any]:", HELPER + "def build_default_state() -> dict[str, Any]:", 1)

OLD_FALLBACK = '''    def _load_disk_state_fallback(self) -> dict[str, Any] | None:
        """PostgreSQL/SQLite vide : reprendre data.json ou la sauvegarde la plus récente."""
        candidates: list[Path] = []
        if self.path.exists():
            candidates.append(self.path)
        for bp in sorted(BACKUP_DIR.glob("data-*.json"), key=lambda p: p.name, reverse=True)[:10]:
            if bp not in candidates:
                candidates.append(bp)
        for fp in candidates:
            try:
                payload = json.loads(fp.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and payload.get("sites"):
                print(f"[startup] Reprise depuis {fp.name}", flush=True)
                return payload
        return None'''

NEW_FALLBACK = '''    def _load_disk_state_fallback(self, *, skip_demo: bool = True) -> dict[str, Any] | None:
        """PostgreSQL/SQLite vide : reprendre data.json ou sauvegarde (ignore la demo si possible)."""
        candidates: list[Path] = []
        if self.path.exists():
            candidates.append(self.path)
        for bp in sorted(BACKUP_DIR.glob("data-*.json"), key=lambda p: p.name, reverse=True)[: max(10, BACKUP_KEEP_COUNT)]:
            if bp not in candidates:
                candidates.append(bp)
        demo_fallback: dict[str, Any] | None = None
        for fp in candidates:
            try:
                payload = json.loads(fp.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(payload, dict) or not payload.get("sites"):
                continue
            if skip_demo and _is_builtin_demo_state(payload):
                if demo_fallback is None:
                    demo_fallback = payload
                continue
            print(f"[startup] Reprise depuis {fp.name}", flush=True)
            return payload
        if demo_fallback is not None:
            print("[startup] Avertissement : seule la copie demo a ete trouvee sur disque.", flush=True)
            return demo_fallback
        return None'''

if OLD_FALLBACK not in t:
    raise SystemExit("fallback block not found")
t = t.replace(OLD_FALLBACK, NEW_FALLBACK, 1)

OLD_INIT = '''                initial = build_default_state()
                if pg_load_ok:
                    # Première utilisation : PostgreSQL vide → initialiser normalement
                    self._write(initial)
                # Si pg_load_ok est False, on NE RIEN ÉCRIT en PostgreSQL
                return initial'''

NEW_INIT = '''                print(
                    "[startup] ALERTE : PostgreSQL vide et aucune sauvegarde exploitable — etat demo charge EN MEMOIRE UNIQUEMENT.",
                    flush=True,
                )
                initial = build_default_state()
                # Ne jamais ecraser PostgreSQL avec la demo si des backups existent mais illisibles.
                if pg_load_ok and not list(BACKUP_DIR.glob("data-*.json")):
                    self._write(initial)
                return initial'''

if OLD_INIT not in t:
    raise SystemExit("init block not found")
t = t.replace(OLD_INIT, NEW_INIT, 1)

MIRROR_FN = '''    def _mirror_json_file(self, body: str) -> None:
        """Copie miroir data.json (recuperation si PostgreSQL est vide au prochain demarrage)."""
        tmp_path = self.path.with_suffix(self.path.suffix + ".tmp")
        with open(tmp_path, "w", encoding="utf-8") as _f:
            _f.write(body)
            _f.flush()
            try:
                os.fsync(_f.fileno())
            except OSError:
                pass
        try:
            tmp_path.replace(self.path)
        finally:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    def _write(self, payload: dict[str, Any], changed_keys: set | None = None) -> None:'''

if "_mirror_json_file" not in t:
    t = t.replace("    def _write(self, payload: dict[str, Any], changed_keys: set | None = None) -> None:", MIRROR_FN, 1)

OLD_PG_WRITE_TAIL = '''            except OSError:
                pass
            self._last_etag = self._compute_etag()
            return

        if self._sqlite_enabled:'''

NEW_PG_WRITE_TAIL = '''            except OSError:
                pass
            try:
                self._mirror_json_file(body)
            except OSError as _mirror_exc:
                print(f"[startup] Miroir data.json ignore : {_mirror_exc}", flush=True)
            self._last_etag = self._compute_etag()
            return

        if self._sqlite_enabled:'''

if OLD_PG_WRITE_TAIL not in t:
    raise SystemExit("pg write tail not found")
t = t.replace(OLD_PG_WRITE_TAIL, NEW_PG_WRITE_TAIL, 1)

SRV.write_text(t, encoding="utf-8")
print("ok")
