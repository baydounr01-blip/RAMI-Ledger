//! Apertura automática del puerto P2P en el router de casa, como hace Bitcoin
//! Core con `-upnp` / `-natpmp`: sin esto, dos casas con router (NAT) no
//! pueden aceptar conexiones entrantes y sus nodos nunca se ven.
//!
//! Dos protocolos, sin dependencias:
//! - **NAT-PMP** (RFC 6886): un datagrama UDP al router (puerto 5351).
//! - **UPnP IGD**: descubrimiento SSDP por multicast, lectura del XML del
//!   router y una petición SOAP `AddPortMapping` (+ `GetExternalIPAddress`).
//!
//! Todo con timeouts cortos; si el router no lo soporta, el nodo sigue
//! funcionando (solo salientes) y el panel lo dice claramente. Nunca se
//! deshabilita nada del router ni se toca otra cosa que el mapeo del puerto
//! propio. Se puede desactivar con `--no-portmap`.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, ToSocketAddrs, UdpSocket};
use std::time::Duration;

use serde::Serialize;

/// Resultado del intento de mapeo (se muestra en la pestaña Red).
#[derive(Clone, Debug, Serialize, Default)]
pub struct MapResult {
    pub ok: bool,
    /// "natpmp", "upnp" o "" si ninguno funcionó.
    pub method: String,
    pub external_ip: Option<String>,
    pub detail: String,
}

/// IP local con la que salimos a internet (truco del socket UDP «conectado»:
/// no envía nada, solo elige la interfaz de la ruta por defecto).
pub fn lan_ip() -> Option<Ipv4Addr> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    sock.connect((Ipv4Addr::new(8, 8, 8, 8), 53)).ok()?;
    match sock.local_addr().ok()? {
        SocketAddr::V4(a) if !a.ip().is_loopback() && !a.ip().is_unspecified() => Some(*a.ip()),
        _ => None,
    }
}

/// Puerta de enlace por defecto: tabla de rutas del sistema si se puede leer
/// (Linux: /proc/net/route; macOS: `route -n get default`; Windows: `route
/// print`), y si no, la heurística x.y.z.1 de la IP local.
pub fn default_gateway() -> Option<Ipv4Addr> {
    if let Some(gw) = gateway_from_system() {
        return Some(gw);
    }
    let ip = lan_ip()?;
    let o = ip.octets();
    Some(Ipv4Addr::new(o[0], o[1], o[2], 1))
}

fn gateway_from_system() -> Option<Ipv4Addr> {
    #[cfg(target_os = "linux")]
    {
        let txt = std::fs::read_to_string("/proc/net/route").ok()?;
        for line in txt.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 3 && f[1] == "00000000" {
                let hex = u32::from_str_radix(f[2], 16).ok()?;
                // little-endian en /proc/net/route
                return Some(Ipv4Addr::from(hex.swap_bytes()));
            }
        }
        None
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("route").args(["-n", "get", "default"]).output().ok()?;
        let txt = String::from_utf8_lossy(&out.stdout);
        for line in txt.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("gateway:") {
                return rest.trim().parse().ok();
            }
        }
        None
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("route").args(["print", "0.0.0.0"]).output().ok()?;
        let txt = String::from_utf8_lossy(&out.stdout);
        for line in txt.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() >= 4 && f[0] == "0.0.0.0" && f[1] == "0.0.0.0" {
                return f[2].parse().ok();
            }
        }
        None
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

/// Intenta abrir `port` (TCP) hacia esta máquina: primero NAT-PMP, luego UPnP.
pub fn map_port(port: u16) -> MapResult {
    let Some(lan) = lan_ip() else {
        return MapResult { detail: "sin conexión de red".into(), ..Default::default() };
    };
    let mut notes = Vec::new();
    if let Some(gw) = default_gateway() {
        match natpmp_map(gw, port, 7200) {
            Ok(ext) => {
                return MapResult {
                    ok: true,
                    method: "natpmp".into(),
                    external_ip: Some(ext.to_string()),
                    detail: format!("NAT-PMP en {gw}: puerto {port} abierto"),
                }
            }
            Err(e) => notes.push(format!("NAT-PMP: {e}")),
        }
    } else {
        notes.push("sin puerta de enlace".into());
    }
    match upnp_map(lan, port) {
        Ok(ext) => MapResult {
            ok: true,
            method: "upnp".into(),
            external_ip: ext,
            detail: format!("UPnP: puerto {port} abierto hacia {lan}"),
        },
        Err(e) => {
            notes.push(format!("UPnP: {e}"));
            MapResult { ok: false, method: String::new(), external_ip: None, detail: notes.join(" · ") }
        }
    }
}

// ------------------------------- NAT-PMP -------------------------------

/// Petición de mapeo NAT-PMP (opcode 2 = TCP). Bytes: ver=0, op, reservado
/// u16, puerto privado, puerto público sugerido, vida en segundos.
pub fn natpmp_request(port: u16, lifetime: u32) -> [u8; 12] {
    let mut b = [0u8; 12];
    b[1] = 2;
    b[4..6].copy_from_slice(&port.to_be_bytes());
    b[6..8].copy_from_slice(&port.to_be_bytes());
    b[8..12].copy_from_slice(&lifetime.to_be_bytes());
    b
}

/// Respuesta de mapeo: ver, op=130, código u16, época u32, privado u16,
/// público u16, vida u32. Devuelve el puerto público concedido.
pub fn natpmp_parse_map(resp: &[u8]) -> Result<u16, String> {
    if resp.len() < 16 || resp[1] != 130 {
        return Err("respuesta inesperada".into());
    }
    let code = u16::from_be_bytes([resp[2], resp[3]]);
    if code != 0 {
        return Err(format!("el router respondió con error {code}"));
    }
    Ok(u16::from_be_bytes([resp[10], resp[11]]))
}

/// Respuesta a la petición de IP externa (op 128): ver, op, código, época, IP.
pub fn natpmp_parse_ext(resp: &[u8]) -> Result<Ipv4Addr, String> {
    if resp.len() < 12 || resp[1] != 128 {
        return Err("respuesta inesperada".into());
    }
    if u16::from_be_bytes([resp[2], resp[3]]) != 0 {
        return Err("sin IP externa".into());
    }
    Ok(Ipv4Addr::new(resp[8], resp[9], resp[10], resp[11]))
}

fn natpmp_exchange(gw: Ipv4Addr, req: &[u8]) -> Result<Vec<u8>, String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    let target = SocketAddrV4::new(gw, 5351);
    // RFC 6886: 250 ms y se dobla; aquí 3 intentos (≈1,75 s en total).
    let mut wait = Duration::from_millis(250);
    let mut buf = [0u8; 64];
    for _ in 0..3 {
        sock.send_to(req, target).map_err(|e| e.to_string())?;
        let _ = sock.set_read_timeout(Some(wait));
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if from.ip() == std::net::IpAddr::V4(gw) && n >= 4 {
                return Ok(buf[..n].to_vec());
            }
        }
        wait *= 2;
    }
    Err("el router no responde a NAT-PMP".into())
}

fn natpmp_map(gw: Ipv4Addr, port: u16, lifetime: u32) -> Result<Ipv4Addr, String> {
    let ext = natpmp_parse_ext(&natpmp_exchange(gw, &[0u8, 0u8])?)?;
    let got = natpmp_parse_map(&natpmp_exchange(gw, &natpmp_request(port, lifetime))?)?;
    if got != port {
        return Err(format!("el router concedió el puerto {got}, no {port}"));
    }
    Ok(ext)
}

// -------------------------------- UPnP ---------------------------------

/// Extrae el contenido de la primera etiqueta `<tag>…</tag>` (sin namespaces).
pub fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let i = xml.find(&open)? + open.len();
    let j = xml[i..].find(&close)? + i;
    Some(xml[i..j].trim())
}

/// Del XML del router: URL de control del servicio WAN(IP|PPP)Connection.
pub fn upnp_control_url(desc_xml: &str, base: &str) -> Option<(String, String)> {
    for svc in ["WANIPConnection:1", "WANIPConnection:2", "WANPPPConnection:1"] {
        let st = format!("urn:schemas-upnp-org:service:{svc}");
        // Busca el bloque <service> que contiene ese serviceType.
        let mut from = 0;
        while let Some(i) = desc_xml[from..].find("<service>") {
            let start = from + i;
            let end = match desc_xml[start..].find("</service>") {
                Some(e) => start + e,
                None => break,
            };
            let block = &desc_xml[start..end];
            if block.contains(&st) {
                if let Some(url) = xml_tag(block, "controlURL") {
                    let full = if url.starts_with("http") { url.to_string() } else { format!("{base}{url}") };
                    return Some((full, st));
                }
            }
            from = end + 10;
        }
    }
    None
}

fn ssdp_discover() -> Result<String, String> {
    let sock = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| e.to_string())?;
    let _ = sock.set_read_timeout(Some(Duration::from_millis(1500)));
    let msg = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n";
    let target = SocketAddrV4::new(Ipv4Addr::new(239, 255, 255, 250), 1900);
    for _ in 0..2 {
        sock.send_to(msg.as_bytes(), target).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 2048];
        while let Ok((n, _)) = sock.recv_from(&mut buf) {
            let txt = String::from_utf8_lossy(&buf[..n]);
            for line in txt.lines() {
                let l = line.trim();
                if l.len() > 9 && l[..9].eq_ignore_ascii_case("location:") {
                    return Ok(l[9..].trim().to_string());
                }
            }
        }
    }
    Err("ningún router UPnP respondió".into())
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout(Duration::from_secs(5))
        .build()
}

fn soap(control: &str, service: &str, action: &str, body_args: &str) -> Result<String, String> {
    let body = format!(
        "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
         s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>\
         <u:{action} xmlns:u=\"{service}\">{body_args}</u:{action}></s:Body></s:Envelope>"
    );
    let resp = http_agent()
        .post(control)
        .set("Content-Type", "text/xml; charset=\"utf-8\"")
        .set("SOAPAction", &format!("\"{service}#{action}\""))
        .send_string(&body);
    match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string()),
        Err(ureq::Error::Status(code, r)) => {
            let t = r.into_string().unwrap_or_default();
            let err = xml_tag(&t, "errorDescription").unwrap_or("").to_string();
            Err(format!("HTTP {code} {err}").trim().to_string())
        }
        Err(e) => Err(e.to_string()),
    }
}

fn upnp_map(lan: Ipv4Addr, port: u16) -> Result<Option<String>, String> {
    let location = ssdp_discover()?;
    let base = {
        // http://host:port/ruta -> http://host:port
        let after = location.find("://").map(|i| i + 3).unwrap_or(0);
        match location[after..].find('/') {
            Some(i) => location[..after + i].to_string(),
            None => location.clone(),
        }
    };
    let desc = http_agent().get(&location).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
    let (control, service) = upnp_control_url(&desc, &base).ok_or("el router no expone WANIPConnection")?;
    let args = format!(
        "<NewRemoteHost></NewRemoteHost><NewExternalPort>{port}</NewExternalPort><NewProtocol>TCP</NewProtocol>\
         <NewInternalPort>{port}</NewInternalPort><NewInternalClient>{lan}</NewInternalClient><NewEnabled>1</NewEnabled>\
         <NewPortMappingDescription>RAMI-Chain</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>"
    );
    soap(&control, &service, "AddPortMapping", &args)?;
    let ext = soap(&control, &service, "GetExternalIPAddress", "")
        .ok()
        .and_then(|x| xml_tag(&x, "NewExternalIPAddress").map(|s| s.to_string()))
        .filter(|s| !s.is_empty() && s != "0.0.0.0");
    Ok(ext)
}

/// Resuelve `host:puerto` (para comprobar que un código de conexión es válido).
pub fn resolvable(addr: &str) -> bool {
    addr.to_socket_addrs().map(|mut it| it.next().is_some()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn natpmp_packets() {
        let r = natpmp_request(30301, 7200);
        assert_eq!(&r[..4], &[0, 2, 0, 0]);
        assert_eq!(u16::from_be_bytes([r[4], r[5]]), 30301);
        assert_eq!(u32::from_be_bytes([r[8], r[9], r[10], r[11]]), 7200);
        let mut resp = vec![0u8, 130, 0, 0, 0, 0, 0, 1];
        resp.extend_from_slice(&30301u16.to_be_bytes());
        resp.extend_from_slice(&30301u16.to_be_bytes());
        resp.extend_from_slice(&7200u32.to_be_bytes());
        assert_eq!(natpmp_parse_map(&resp), Ok(30301));
        resp[3] = 3;
        assert!(natpmp_parse_map(&resp).is_err());
        let ext = [0u8, 128, 0, 0, 0, 0, 0, 1, 83, 45, 1, 2];
        assert_eq!(natpmp_parse_ext(&ext), Ok(Ipv4Addr::new(83, 45, 1, 2)));
    }

    #[test]
    fn upnp_xml_parsing() {
        let xml = "<root><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service></serviceList>\
                   <deviceList><device><serviceList><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service></serviceList></device></deviceList></device></root>";
        let (url, st) = upnp_control_url(xml, "http://192.168.1.1:5000").unwrap();
        assert_eq!(url, "http://192.168.1.1:5000/ctl/IPConn");
        assert!(st.ends_with("WANIPConnection:1"));
        assert_eq!(xml_tag("<a><NewExternalIPAddress>1.2.3.4</NewExternalIPAddress></a>", "NewExternalIPAddress"), Some("1.2.3.4"));
        assert!(upnp_control_url("<root/>", "http://x").is_none());
    }
}
