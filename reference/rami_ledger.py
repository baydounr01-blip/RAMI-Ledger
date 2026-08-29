#!/usr/bin/env python3
# ╔══════════════════════════════════════════════════════════════════╗
# ║   RAMI v1 — Registro Anclado de Mensajes Inmutables             ║
# ║   Cadena de compromisos · Ed25519 · Merkle · OpenTimestamps    ║
# ║                                                                 ║
# ║   El motor publica sha256(señal ‖ nonce) ANTES del hecho.       ║
# ║   Revela la señal cuando el trade cierra.                       ║
# ║   Cualquiera verifica que el track record no está ajustado     ║
# ║   a posteriori. Sin token. Sin minar. Sin dependencias.        ║
# ║   El anclaje a Bitcoin hereda ~1.000 EH/s por 0 €.             ║
# ║                                                                 ║
# ║   Esta es la REFERENCIA canónica (Python). El nodo Rust de     ║
# ║   RAMI-Chain (../chain) reproduce su canonicalización,         ║
# ║   hashing, Merkle y firmas bit a bit.                          ║
# ║                                                                 ║
# ║   CLI:                                                          ║
# ║     python rami_ledger.py init                                  ║
# ║     python rami_ledger.py commit señal.json    (objeto o lista) ║
# ║     python rami_ledger.py commit '{"pair":"BTC","dir":"LONG"}'  ║
# ║     python rami_ledger.py reveal <commit> [...] | --all         ║
# ║     python rami_ledger.py anchor [--upgrade]   (requiere ots)   ║
# ║     python rami_ledger.py verify                                ║
# ║     python rami_ledger.py export              → signals.json   ║
# ║     python rami_ledger.py show [n] | status                    ║
# ║                                                                 ║
# ║   CANON (para verificar desde Rust/TypeScript): JSON con       ║
# ║   claves ordenadas, sin espacios, floats enteros → int.        ║
# ║   Redondea los floats de la señal (round(x,4)) y evita         ║
# ║   magnitudes < 1e-4.                                            ║
# ╚══════════════════════════════════════════════════════════════════╝

import os, sys, json, hashlib, tempfile, subprocess, shutil, time, signal
import secrets as _secrets
from datetime import datetime, timezone

if hasattr(signal, "SIGPIPE"):                # `| head` no debe romper el proceso
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)

VERSION      = 1
LEDGER_DIR   = os.environ.get("RAMI_LEDGER_DIR", "rami_ledger")
GENESIS_PREV = "0" * 64

# ══════════════════════════════════════════════════════════════════
# ED25519 — backend `cryptography` si existe (rápido), si no puro
# Python RFC 8032 §6 (coordenadas extendidas, sin deps). Ambos pasan
# el mismo vector de prueba antes de firmar nada.
# ══════════════════════════════════════════════════════════════════

try:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import (
        Ed25519PrivateKey as _CPriv, Ed25519PublicKey as _CPub)
    ED25519_BACKEND = "cryptography"
except BaseException:                        # incluye panics de pyo3 sin cffi
    ED25519_BACKEND = "python"
if os.environ.get("RAMI_FORCE_PY"):          # forzar backend puro (pruebas / Termux)
    ED25519_BACKEND = "python"

_p = 2**255 - 19
_l = 2**252 + 27742317777372353535851937790883648493

def _H(m):       return hashlib.sha512(m).digest()
def _inv(x):     return pow(x, _p - 2, _p)
def _H_modl(m):  return int.from_bytes(_H(m), "little") % _l

_d       = (-121665 * _inv(121666)) % _p
_sqrt_m1 = pow(2, (_p - 1) // 4, _p)

def _recover_x(y, sign):
    if y >= _p: return None
    x2 = (y*y - 1) * _inv(_d*y*y + 1)
    if x2 == 0: return None if sign else 0
    x = pow(x2, (_p + 3) // 8, _p)
    if (x*x - x2) % _p != 0: x = x * _sqrt_m1 % _p
    if (x*x - x2) % _p != 0: return None
    if (x & 1) != sign: x = _p - x
    return x

_gy = (4 * _inv(5)) % _p
_gx = _recover_x(_gy, 0)
_G  = (_gx, _gy, 1, _gx * _gy % _p)

def _add(P, Q):
    A = (P[1]-P[0]) * (Q[1]-Q[0]) % _p
    B = (P[1]+P[0]) * (Q[1]+Q[0]) % _p
    C = 2 * P[3] * Q[3] * _d % _p
    D = 2 * P[2] * Q[2] % _p
    E, F, G, H = B-A, D-C, D+C, B+A
    return (E*F % _p, G*H % _p, F*G % _p, E*H % _p)

def _mul(s, P):
    Q = (0, 1, 1, 0)
    while s > 0:
        if s & 1: Q = _add(Q, P)
        P = _add(P, P); s >>= 1
    return Q

def _eq(P, Q):
    return ((P[0]*Q[2] - Q[0]*P[2]) % _p == 0 and
            (P[1]*Q[2] - Q[1]*P[2]) % _p == 0)

def _compress(P):
    zi = _inv(P[2]); x = P[0]*zi % _p; y = P[1]*zi % _p
    return (y | ((x & 1) << 255)).to_bytes(32, "little")

def _decompress(s):
    if len(s) != 32: return None
    y = int.from_bytes(s, "little"); sign = y >> 255; y &= (1 << 255) - 1
    x = _recover_x(y, sign)
    return None if x is None else (x, y, 1, x*y % _p)

def _expand(sk):
    h = _H(sk); a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8; a |= 1 << 254
    return a, h[32:]

def _py_publickey(sk):
    a, _ = _expand(sk); return _compress(_mul(a, _G))

def _py_sign(m, sk, pk):
    a, prefix = _expand(sk)
    r  = _H_modl(prefix + m)
    Rs = _compress(_mul(r, _G))
    h  = _H_modl(Rs + pk + m)
    return Rs + ((r + h*a) % _l).to_bytes(32, "little")

def _py_verify(sig, m, pk):
    if len(sig) != 64 or len(pk) != 32: return False
    A = _decompress(pk); R = _decompress(sig[:32])
    if A is None or R is None: return False
    S = int.from_bytes(sig[32:], "little")
    if S >= _l: return False
    h = _H_modl(sig[:32] + pk + m)
    return _eq(_mul(S, _G), _add(R, _mul(h, A)))

def ed25519_publickey(sk: bytes) -> bytes:
    if ED25519_BACKEND == "cryptography":
        from cryptography.hazmat.primitives import serialization as _ser
        return _CPriv.from_private_bytes(sk).public_key().public_bytes(
            _ser.Encoding.Raw, _ser.PublicFormat.Raw)
    return _py_publickey(sk)

def ed25519_sign(m: bytes, sk: bytes, pk: bytes) -> bytes:
    if ED25519_BACKEND == "cryptography":
        return _CPriv.from_private_bytes(sk).sign(m)
    return _py_sign(m, sk, pk)

def ed25519_verify(sig: bytes, m: bytes, pk: bytes) -> bool:
    if ED25519_BACKEND == "cryptography":
        try:
            _CPub.from_public_bytes(pk).verify(sig, m); return True
        except Exception:
            return False
    return _py_verify(sig, m, pk)

_SELFTESTED = False

def ed25519_selftest():
    """Vector 1 de RFC 8032. Si esto falla, NADA de lo demás es fiable."""
    global _SELFTESTED
    if _SELFTESTED: return
    sk  = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    pk  = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    sig = bytes.fromhex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e0652249015"
                        "55fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
    ok  = (ed25519_publickey(sk) == pk
           and ed25519_sign(b"", sk, pk) == sig
           and ed25519_verify(sig, b"", pk)
           and not ed25519_verify(sig, b"x", pk)
           and _py_publickey(sk) == pk          # el backend puro se prueba SIEMPRE
           and _py_sign(b"", sk, pk) == sig
           and _py_verify(sig, b"", pk))
    if not ok:
        die(f"SELFTEST Ed25519 FALLIDO (backend {ED25519_BACKEND}) — no uses este binario")
    _SELFTESTED = True

# ══════════════════════════════════════════════════════════════════
# PRIMITIVAS DEL LEDGER
# ══════════════════════════════════════════════════════════════════

def die(msg, code=1):
    print(f"✗ {msg}", file=sys.stderr); sys.exit(code)

def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def _norm(o):
    """Floats enteros → int, para que Python y Rust/JS canonicen igual."""
    if isinstance(o, bool):  return o
    if isinstance(o, float): return int(o) if o.is_integer() and abs(o) < 2**53 else o
    if isinstance(o, dict):  return {k: _norm(v) for k, v in o.items()}
    if isinstance(o, list):  return [_norm(v) for v in o]
    return o

def canon(obj) -> str:
    return json.dumps(_norm(obj), sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False)

def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()

def merkle_root(leaves_hex) -> str:
    if not leaves_hex: return sha256(b"")
    layer = [bytes.fromhex(x) for x in leaves_hex]
    while len(layer) > 1:
        if len(layer) % 2: layer.append(layer[-1])
        layer = [hashlib.sha256(layer[i] + layer[i+1]).digest()
                 for i in range(0, len(layer), 2)]
    return layer[0].hex()

def commit_hash(signal, nonce_hex: str) -> str:
    return sha256(canon(signal).encode("utf-8") + bytes.fromhex(nonce_hex))

def reveal_leaf(rev) -> str:
    return sha256(canon(rev).encode("utf-8"))

def block_body(height, prev, ts, commits, reveals, pubkey=None):
    body = {"v": VERSION, "height": height, "prev": prev, "ts": ts,
            "commits": list(commits), "reveals": list(reveals)}
    if pubkey: body["pubkey"] = pubkey
    body["merkle_root"] = merkle_root(commits + [reveal_leaf(r) for r in reveals])
    return body

def block_hash(block) -> str:
    b = {k: v for k, v in block.items() if k not in ("hash", "sig")}
    return sha256(canon(b).encode("utf-8"))

def atomic_write(path, text, mode=0o644):
    d = os.path.dirname(path) or "."
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".tmp_")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text); f.flush(); os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)

# ══════════════════════════════════════════════════════════════════
# VERIFICACIÓN — pública, sin secretos, solo chain.jsonl
# ══════════════════════════════════════════════════════════════════

def verify_chain(chain, pubkey_hex=None):
    """Devuelve (errores, commits{hash:altura}, revelados{hash:altura})."""
    errors, seen, revealed = [], {}, {}
    if not chain: return ["cadena vacía"], seen, revealed
    pk_hex = chain[0].get("pubkey")
    if not pk_hex: return ["génesis sin pubkey"], seen, revealed
    if pubkey_hex and pubkey_hex != pk_hex:
        errors.append("pubkey.txt no coincide con la clave del génesis")
    pk = bytes.fromhex(pk_hex)
    prev_hash, prev_ts = GENESIS_PREV, ""
    for i, b in enumerate(chain):
        h = b.get("height")
        tag = f"#{h}"
        if h != i:                      errors.append(f"{tag}: altura fuera de secuencia (esperada {i})")
        if b.get("v") != VERSION:       errors.append(f"{tag}: versión desconocida")
        if b.get("prev") != prev_hash:  errors.append(f"{tag}: prev no enlaza con el bloque anterior")
        if b.get("ts", "") < prev_ts:   errors.append(f"{tag}: timestamp retrocede")
        if i > 0 and "pubkey" in b:     errors.append(f"{tag}: pubkey solo se permite en génesis")
        root = merkle_root(b["commits"] + [reveal_leaf(r) for r in b["reveals"]])
        if b.get("merkle_root") != root: errors.append(f"{tag}: merkle_root incorrecto")
        if block_hash(b) != b.get("hash"): errors.append(f"{tag}: hash incorrecto")
        try:
            sig_ok = ed25519_verify(bytes.fromhex(b["sig"]), bytes.fromhex(b["hash"]), pk)
        except Exception:
            sig_ok = False
        if not sig_ok:                  errors.append(f"{tag}: firma inválida")
        for c in b["commits"]:
            if c in seen:               errors.append(f"{tag}: commit duplicado {c[:12]}…")
            seen[c] = h
        for r in b["reveals"]:
            c = r.get("commit", "")
            if c not in seen:           errors.append(f"{tag}: reveal de commit inexistente {c[:12]}…")
            elif seen[c] >= i:          errors.append(f"{tag}: reveal antes o en el mismo bloque que el commit")
            elif r.get("height") != seen[c]: errors.append(f"{tag}: altura de commit incorrecta en reveal")
            if c in revealed:           errors.append(f"{tag}: doble reveal {c[:12]}…")
            revealed[c] = h
            try:
                if commit_hash(r["signal"], r["nonce"]) != c:
                    errors.append(f"{tag}: la señal revelada NO coincide con el commit {c[:12]}…")
            except Exception:
                errors.append(f"{tag}: reveal malformado")
        prev_hash, prev_ts = b.get("hash"), b.get("ts", "")
    return errors, seen, revealed

# (El resto del CLI — Ledger, init/commit/reveal/anchor/verify/export/show —
#  vive en el histórico del repo y en la implementación de producción en Rust
#  bajo ../chain, que reproduce estas mismas primitivas bit a bit.)

if __name__ == "__main__":
    ed25519_selftest()
    print("RAMI ledger — referencia canónica. Selftest Ed25519 OK.")
    print("Implementación de producción (nodo, minería, wallet): ../chain (Rust).")
