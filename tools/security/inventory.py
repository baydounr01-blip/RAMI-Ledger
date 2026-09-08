#!/usr/bin/env python3
"""Inventario de TODO lo que el software contacta o ejecuta, sacado del código
fuente Rust (sin comentarios ni módulos de test): URLs y nombres de host en
literales, programas externos que se lanzan (Command::new), variables de
entorno que se leen y sockets de escucha. Se compara con la lista aprobada
SECURITY-INVENTORY.txt: cualquier destino o comando nuevo hace fallar el CI
hasta que alguien lo revise y lo apruebe a mano. Así una «puerta trasera»
(telemetría, control remoto, exfiltración) no puede entrar sin dejar rastro.

Uso: tools/security/inventory.py            # imprime el inventario
     tools/security/inventory.py --check    # falla si difiere de la lista
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "chain" / "crates"
LIST = ROOT / "SECURITY-INVENTORY.txt"

URL = re.compile(r'https?://[A-Za-z0-9./_-]+')
# Nombre de host en un literal de cadena: "seed.quantbot.army:30301", "evil.net".
HOST = re.compile(r'"([a-z0-9-]+(?:\.[a-z0-9-]+)*\.([a-z]{2,6}))(:[0-9]+)?"')
CMD = re.compile(r'Command::new\("([^"]+)"\)')
# Programa elegido en tiempo de ejecución (p. ej. la lista de navegadores).
CMD_DYN = re.compile(r'Command::new\(([^")][^)]*)\)')
ENV = re.compile(r'env::var(?:_os)?\("([A-Za-z0-9_]+)"')
BIND = re.compile(r'bind\(\(?("[^"]+"|Ipv4Addr::UNSPECIFIED)')
# Direcciones locales/plantillas que no son destinos remotos.
SKIP_URL = ("http://127.0.0.1", "http://localhost", "http://host", "http://x", "http://192.168.1.1", "http://schemas.xmlsoap.org")
# Dominios de primer nivel que cuentan como «host» en un literal (así
# "install.failed" o "btn.later", claves de texto, no se confunden con hosts).
TLDS = {"com", "net", "org", "io", "army", "es", "eu", "dev", "xyz", "info", "me", "co", "uk", "de", "fr", "ru",
        "cn", "onion", "cloud", "app", "site", "online", "tech", "sh", "to", "ly", "gg", "tv", "cc", "ws", "top"}


def code_without_comments_and_tests(text: str) -> str:
    idx = text.find("#[cfg(test)]")
    if idx != -1:
        text = text[:idx]
    # Quita comentarios `//…` (pero no el `//` de `https://`).
    return "\n".join(re.sub(r'(?<!:)//.*', '', line) for line in text.splitlines())


def inventory() -> str:
    hosts, execs, envs, listens = set(), set(), set(), set()
    for path in sorted(SRC.rglob("*.rs")):
        # Los tests de integración (crates/*/tests/) no entran en los binarios.
        if "tests" in path.relative_to(SRC).parts:
            continue
        code = code_without_comments_and_tests(path.read_text(encoding="utf-8", errors="replace"))
        for m in URL.finditer(code):
            u = m.group(0).rstrip(".")
            if not u.startswith(SKIP_URL):
                hosts.add(u)
        for m in HOST.finditer(code):
            if m.group(2) not in TLDS:
                continue
            hosts.add(m.group(1) + (m.group(3) or ""))
        execs.update(CMD.findall(code))
        execs.update(f"(dinámico) {e.strip()}" for e in CMD_DYN.findall(code))
        envs.update(ENV.findall(code))
        listens.update(x.strip('"') for x in BIND.findall(code))
    out = ["# hosts y URLs (literales del código Rust, sin comentarios ni tests)"]
    out += [f"host: {h}" for h in sorted(hosts)]
    out.append("# programas externos (Command::new)")
    out += [f"exec: {e}" for e in sorted(execs)]
    out.append("# variables de entorno leídas")
    out += [f"env: {e}" for e in sorted(envs)]
    out.append("# sockets de escucha")
    out += [f"listen: {l}" for l in sorted(listens)]
    return "\n".join(out) + "\n"


def main() -> int:
    inv = inventory()
    if "--check" not in sys.argv:
        sys.stdout.write(inv)
        return 0
    approved = LIST.read_text(encoding="utf-8") if LIST.exists() else ""
    if inv != approved:
        import difflib
        sys.stdout.writelines(difflib.unified_diff(approved.splitlines(True), inv.splitlines(True), "SECURITY-INVENTORY.txt", "inventario actual"))
        print("::error::el inventario de red/procesos difiere de SECURITY-INVENTORY.txt: revisa el cambio y, si es legítimo, actualiza la lista", file=sys.stderr)
        return 1
    print("✓ inventario de red y procesos igual a la lista aprobada")
    return 0


if __name__ == "__main__":
    sys.exit(main())
