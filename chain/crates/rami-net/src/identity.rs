//! Identidad de nodo del Túnel RAMI: una clave Ed25519 que CUESTA trabajo
//! crear.
//!
//! Cada nodo tiene una clave de firma Ed25519 persistente (`node.key`). Su
//! clave pública debe venir acompañada de un `pow_nonce` tal que
//! `SHA-256d(pubkey || pow_nonce_le)` empiece por `IDENTITY_POW_BITS` bits a
//! cero: la MISMA prueba de trabajo del minado (`rami_core::pow::pow_hash`),
//! así que una identidad no se fabrica gratis (≈ 2^20 hashes, alrededor de un
//! segundo en un portátil). Eso encarece inundar la red de identidades
//! falsas (Sybil) sin necesitar ningún registro central.
//!
//! De la clave pública se derivan:
//! - `node_id`: los 8 primeros bytes (LE) de `SHA-256d(pubkey)`, el
//!   identificador que usan la tabla de pares y el descubrimiento LAN;
//! - la **huella** (`fingerprint`): 16 hex de `SHA-256d(pubkey)` agrupados
//!   `xxxx-xxxx-xxxx-xxxx`, para comprobarla con la otra persona por otro
//!   canal, como se hace con una clave SSH.

use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use rami_core::hashing::sha256d;
use rami_core::pow::pow_hash;

/// Bits a cero exigidos en `SHA-256d(pubkey || pow_nonce)`: 20 ≈ 1 M hashes,
/// del orden de un segundo en una CPU de portátil al crear la identidad.
pub const IDENTITY_POW_BITS: u32 = 20;

/// Identidad de este nodo: clave de firma Ed25519 más su prueba de trabajo.
#[derive(Clone)]
pub struct NodeIdentity {
    signing: SigningKey,
    /// Clave pública Ed25519 (32 bytes).
    pub pubkey: [u8; 32],
    /// Nonce que hace válida la prueba de trabajo de la identidad.
    pub pow_nonce: u64,
}

impl std::fmt::Debug for NodeIdentity {
    // Nunca se imprime la semilla.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("fingerprint", &self.fingerprint())
            .field("pow_nonce", &self.pow_nonce)
            .finish()
    }
}

/// Formato en disco de `node.key`.
#[derive(Serialize, Deserialize)]
struct IdentityFile {
    seed: String,
    pow_nonce: u64,
}

impl NodeIdentity {
    /// Genera una identidad nueva (semilla aleatoria del sistema) y busca su
    /// prueba de trabajo.
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self::from_seed_search(seed)
    }

    /// Reconstruye una identidad desde su semilla y un nonce YA conocido (no
    /// se comprueba aquí; ver `identity_pow_ok`).
    pub fn from_seed(seed: [u8; 32], pow_nonce: u64) -> Self {
        let signing = SigningKey::from_bytes(&seed);
        let pubkey = signing.verifying_key().to_bytes();
        NodeIdentity { signing, pubkey, pow_nonce }
    }

    /// Reconstruye desde la semilla y busca el nonce de la prueba de trabajo.
    pub fn from_seed_search(seed: [u8; 32]) -> Self {
        let mut id = Self::from_seed(seed, 0);
        id.pow_nonce = find_pow_nonce(&id.pubkey, IDENTITY_POW_BITS);
        id
    }

    /// Semilla privada (32 bytes). Solo para persistirla.
    pub fn seed(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// Identificador de nodo derivado de la clave pública.
    pub fn node_id(&self) -> u64 {
        node_id(&self.pubkey)
    }

    /// Huella legible de la clave pública.
    pub fn fingerprint(&self) -> String {
        fingerprint(&self.pubkey)
    }

    /// Firma Ed25519 de `msg` con la clave del nodo.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }

    /// ¿La prueba de trabajo de esta identidad es válida?
    pub fn pow_ok(&self) -> bool {
        identity_pow_ok(&self.pubkey, self.pow_nonce)
    }
}

/// Hash de la prueba de trabajo de identidad: `SHA-256d(pubkey || nonce_le)`.
pub fn identity_pow_hash(pubkey: &[u8; 32], nonce: u64) -> [u8; 32] {
    let mut buf = [0u8; 40];
    buf[..32].copy_from_slice(pubkey);
    buf[32..].copy_from_slice(&nonce.to_le_bytes());
    pow_hash(&buf)
}

/// Bits a cero por la izquierda de un hash (big-endian por bytes).
pub fn leading_zero_bits(h: &[u8; 32]) -> u32 {
    let mut n = 0u32;
    for &b in h {
        if b == 0 {
            n += 8;
        } else {
            n += b.leading_zeros();
            break;
        }
    }
    n
}

/// ¿`SHA-256d(pubkey || nonce)` tiene al menos `bits` bits a cero?
pub fn identity_pow_ok_bits(pubkey: &[u8; 32], nonce: u64, bits: u32) -> bool {
    leading_zero_bits(&identity_pow_hash(pubkey, nonce)) >= bits
}

/// ¿La prueba de trabajo de la identidad es válida (IDENTITY_POW_BITS)?
pub fn identity_pow_ok(pubkey: &[u8; 32], nonce: u64) -> bool {
    identity_pow_ok_bits(pubkey, nonce, IDENTITY_POW_BITS)
}

/// Busca (desde 0) el primer nonce que cumple `bits` bits a cero.
pub fn find_pow_nonce(pubkey: &[u8; 32], bits: u32) -> u64 {
    let mut nonce = 0u64;
    loop {
        if identity_pow_ok_bits(pubkey, nonce, bits) {
            return nonce;
        }
        nonce = nonce.wrapping_add(1);
    }
}

/// Identificador de nodo: 8 primeros bytes (LE) de `SHA-256d(pubkey)`.
pub fn node_id(pubkey: &[u8; 32]) -> u64 {
    let h = sha256d(pubkey);
    let mut b = [0u8; 8];
    b.copy_from_slice(&h[..8]);
    u64::from_le_bytes(b)
}

/// Huella: 16 primeros hex de `SHA-256d(pubkey)` como `xxxx-xxxx-xxxx-xxxx`.
pub fn fingerprint(pubkey: &[u8; 32]) -> String {
    let h = hex::encode(sha256d(pubkey));
    format!("{}-{}-{}-{}", &h[0..4], &h[4..8], &h[8..12], &h[12..16])
}

/// Carga la identidad de `path` (JSON `{"seed":hex32,"pow_nonce":u64}`) o, si
/// el archivo no existe, crea una nueva (buscando su prueba de trabajo) y la
/// guarda con permisos 0600 en Unix. Un archivo existente pero ilegible es un
/// ERROR (nunca se sobrescribe una clave que quizá el usuario quiera rescatar).
/// Si el nonce guardado ya no cumple (p. ej. subió IDENTITY_POW_BITS), se
/// recalcula y se reescribe conservando la clave.
pub fn load_or_create(path: &Path) -> Result<NodeIdentity, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let f: IdentityFile = serde_json::from_str(&text)
                .map_err(|e| format!("identidad de nodo {} ilegible: {e}", path.display()))?;
            let seed_v = hex::decode(f.seed.trim())
                .map_err(|e| format!("identidad de nodo {}: semilla no es hex: {e}", path.display()))?;
            let seed: [u8; 32] = seed_v
                .try_into()
                .map_err(|_| format!("identidad de nodo {}: la semilla debe tener 32 bytes", path.display()))?;
            let mut id = NodeIdentity::from_seed(seed, f.pow_nonce);
            if !id.pow_ok() {
                eprintln!("[net] la prueba de trabajo de la identidad no cumple; se recalcula (misma clave)");
                id.pow_nonce = find_pow_nonce(&id.pubkey, IDENTITY_POW_BITS);
                save(path, &id)?;
            }
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let id = NodeIdentity::generate();
            save(path, &id)?;
            Ok(id)
        }
        Err(e) => Err(format!("no se pudo leer la identidad de nodo {}: {e}", path.display())),
    }
}

/// Escribe `node.key` (0600 en Unix). Crea el directorio si hace falta.
fn save(path: &Path, id: &NodeIdentity) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            std::fs::create_dir_all(dir).map_err(|e| format!("no se pudo crear {}: {e}", dir.display()))?;
        }
    }
    let f = IdentityFile { seed: hex::encode(id.seed()), pow_nonce: id.pow_nonce };
    let json = serde_json::to_string_pretty(&f).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    let mut file = opts.open(path).map_err(|e| format!("no se pudo escribir {}: {e}", path.display()))?;
    file.write_all(json.as_bytes()).map_err(|e| format!("no se pudo escribir {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        // Por si el archivo ya existía con otros permisos.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("rami-id-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn leading_zero_bits_counts() {
        assert_eq!(leading_zero_bits(&[0u8; 32]), 256);
        let mut h = [0u8; 32];
        h[0] = 0x80;
        assert_eq!(leading_zero_bits(&h), 0);
        h[0] = 0x01;
        assert_eq!(leading_zero_bits(&h), 7);
        h[0] = 0;
        h[2] = 0x10;
        assert_eq!(leading_zero_bits(&h), 16 + 3);
    }

    #[test]
    fn pow_ok_and_not_ok() {
        // Con pocos bits la búsqueda es instantánea y el resultado verificable.
        let pk = [3u8; 32];
        let n = find_pow_nonce(&pk, 8);
        assert!(identity_pow_ok_bits(&pk, n, 8));
        let h = identity_pow_hash(&pk, n);
        assert_eq!(h[0], 0);
        // Un nonce cualquiera casi nunca cumple 20 bits; buscamos uno que NO cumpla.
        let mut bad = 0u64;
        while identity_pow_ok(&pk, bad) {
            bad += 1;
        }
        assert!(!identity_pow_ok(&pk, bad));
        // Cambiar la clave invalida el nonce (con 20 bits, prácticamente seguro).
        let id = NodeIdentity::from_seed_search([9u8; 32]);
        assert!(id.pow_ok());
        let mut other = id.pubkey;
        other[0] ^= 1;
        let mut ok_after_change = identity_pow_ok(&other, id.pow_nonce);
        if ok_after_change {
            // colisión de 1 entre 2^20: prueba otro bit
            other[1] ^= 1;
            ok_after_change = identity_pow_ok(&other, id.pow_nonce);
        }
        assert!(!ok_after_change);
    }

    #[test]
    fn node_id_and_fingerprint_derive_from_sha256d() {
        let pk = [7u8; 32];
        let h = sha256d(&pk);
        let mut b = [0u8; 8];
        b.copy_from_slice(&h[..8]);
        assert_eq!(node_id(&pk), u64::from_le_bytes(b));
        let fp = fingerprint(&pk);
        assert_eq!(fp.len(), 19);
        let hx = hex::encode(h);
        assert_eq!(fp, format!("{}-{}-{}-{}", &hx[0..4], &hx[4..8], &hx[8..12], &hx[12..16]));
        assert!(fp.split('-').all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_hexdigit())));
        // Determinista y distinta para otra clave.
        assert_eq!(fingerprint(&pk), fp);
        assert_ne!(fingerprint(&[8u8; 32]), fp);
        assert_ne!(node_id(&[8u8; 32]), node_id(&pk));
    }

    #[test]
    fn file_roundtrip_and_creation_time() {
        let dir = tmp("rt");
        let path = dir.join("node.key");
        let t0 = Instant::now();
        let a = load_or_create(&path).expect("crear");
        let dt = t0.elapsed();
        eprintln!("[identidad] creación de node.key con {IDENTITY_POW_BITS} bits: {dt:?}");
        assert!(a.pow_ok());
        assert!(dt.as_secs() < 20, "la creación tardó demasiado: {dt:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        // Segunda carga: misma clave, mismo nonce, sin recalcular.
        let t1 = Instant::now();
        let b = load_or_create(&path).expect("cargar");
        assert!(t1.elapsed().as_millis() < 500);
        assert_eq!(a.pubkey, b.pubkey);
        assert_eq!(a.pow_nonce, b.pow_nonce);
        assert_eq!(a.seed(), b.seed());
        assert_eq!(a.fingerprint(), b.fingerprint());
        // Archivo corrupto: error, nunca se sobrescribe.
        std::fs::write(&path, "basura").unwrap();
        assert!(load_or_create(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "basura");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn signature_verifies_with_core() {
        let id = NodeIdentity::from_seed([1u8; 32], 0);
        let sig = id.sign(b"hola");
        assert!(rami_core::crypto::verify(&id.pubkey, b"hola", &sig));
        assert!(!rami_core::crypto::verify(&id.pubkey, b"adios", &sig));
    }
}
