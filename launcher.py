import subprocess
import sys
import re
import threading
import os
import time

TUNNEL_UUID = "b35163c4-614c-4479-ba61-27aff1f69c8e"
TUNNEL_NAME = "maquis-manager"
HOSTNAME = "app.cave-des-amis.com"
CREDENTIALS_FILE = os.path.join(os.path.expanduser("~"), ".cloudflared", f"{TUNNEL_UUID}.json")
CONFIG_FILE = os.path.join(os.path.expanduser("~"), ".cloudflared", "config.yml")

detected_port = [None]
port_found = threading.Event()

def lire_serveur(proc):
    for line in iter(proc.stdout.readline, ""):
        print(line, end="", flush=True)
        if "running on" in line.lower():
            m = re.search(r":(\d+)", line)
            if m:
                detected_port[0] = m.group(1)
                port_found.set()

script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

env = os.environ.copy()
env["PYTHONUNBUFFERED"] = "1"

print("Demarrage du serveur Maquis Manager...")
server = subprocess.Popen(
    [sys.executable, "-u", "server.py"],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
    cwd=script_dir,
    env=env,
)

t = threading.Thread(target=lire_serveur, args=(server,), daemon=True)
t.start()

port_found.wait(timeout=10)

if not detected_port[0]:
    print("ERREUR : impossible de detecter le port du serveur.")
    server.terminate()
    sys.exit(1)

port = detected_port[0]
print(f"Serveur detecte sur le port {port}")

# Lancement de ngrok pour exposer le port local
print("Demarrage du tunnel ngrok...")
ngrok_process = subprocess.Popen(
    [os.path.join(script_dir, "ngrok.exe"), "http", str(port)],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
)

# Attendre que ngrok affiche l'URL
ngrok_url = None
for line in iter(ngrok_process.stdout.readline, ""):
    print(line, end="", flush=True)
    if "Forwarding" in line and "https://" in line:
        # Extraire l'URL après ->
        parts = line.split("->")
        if len(parts) > 1:
            url_part = parts[0].strip().split()[-1]  # Prendre la dernière partie avant ->
            if url_part.startswith("https://"):
                ngrok_url = url_part
                break

if not ngrok_url:
    print("ERREUR : impossible de detecter l'URL ngrok.")
    server.terminate()
    ngrok_process.terminate()
    sys.exit(1)

print()
print("  ================================================")
print(f"  Votre application est accessible sur :")
print(f"  {ngrok_url}")
print("  ================================================")
print()

# Garder les processus actifs
try:
    server.wait()
except KeyboardInterrupt:
    pass
finally:
    ngrok_process.terminate()
    server.terminate()
