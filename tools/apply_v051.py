#!/usr/bin/env python3
"""Aplica los cambios de v0.5.1 (bucle de eventos Cocoa en macOS) sobre el
código publicado, por anclas de texto exactas. Falla en alto si un ancla no
existe. Uso único desde CI; se borra tras aplicarse."""
import sys

def patch(path, pairs, must=True):
    s = open(path, encoding="utf-8").read()
    for old, new in pairs:
        if old not in s:
            print(f"ANCLA NO ENCONTRADA en {path}:\n{old[:120]}...", file=sys.stderr)
            sys.exit(1)
        s = s.replace(old, new, 1)
    open(path, "w", encoding="utf-8").write(s)
    print("ok", path)

# ---------------- chain/Cargo.toml: versión ----------------
patch("chain/Cargo.toml", [('version = "0.5.0"', 'version = "0.5.1"')])

# ---------------- rami-gui/src/main.rs ----------------
P = "chain/crates/rami-gui/src/main.rs"
s = open(P, encoding="utf-8").read()

# 1) Quitar el bloque de la lanzadera (desde su comentario hasta `let is_testnet`).
a = s.index("    // Modo LANZADERA en macOS")
b = s.index("    let is_testnet = arg(&args, \"--network\")")
s = s[:a] + '''    // macOS: la app corre como una app de verdad — con bucle de eventos Cocoa en
    // el hilo principal (ver `cocoa` y el final de main). Sin él, macOS mostraba
    // «La aplicación RAMI-Chain no responde» al hacer clic en el icono, aunque el
    // nodo funcionara. `--foreground` se acepta por compatibilidad (v0.4.2–0.5.0).

''' + s[b:]

# 2) Módulo cocoa antes de `fn esc(`.
ESC = '''fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}'''
assert ESC in s, "ancla fn esc"
COCOA = r'''/// macOS: bucle de eventos Cocoa mínimo para que la app se comporte como una
/// app de verdad. Sin él, macOS no recibe respuesta a sus eventos (el clic en
/// el icono, «reabrir») y muestra «La aplicación RAMI-Chain no responde»
/// aunque el nodo funcione. Se usa el runtime de Objective‑C por FFI, sin
/// dependencias: `[NSApplication sharedApplication]`, un delegado con
/// `applicationShouldHandleReopen:` que abre el panel en el navegador, y
/// `[NSApp run]` en el hilo principal (el servidor del panel va en otro hilo).
#[cfg(target_os = "macos")]
mod cocoa {
    use std::ffi::{c_char, c_void, CStr};
    use std::sync::OnceLock;

    type Id = *mut c_void;
    type Sel = *mut c_void;

    #[link(name = "objc", kind = "dylib")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_allocateClassPair(superclass: Id, name: *const c_char, extra: usize) -> Id;
        fn objc_registerClassPair(cls: Id);
        fn class_addMethod(cls: Id, name: Sel, imp: *const c_void, types: *const c_char) -> bool;
    }
    // Enlazar los frameworks hace que las clases (NSApplication…) existan.
    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "Foundation", kind = "framework")]
    extern "C" {}

    static PANEL_URL: OnceLock<String> = OnceLock::new();

    unsafe fn sel(s: &CStr) -> Sel {
        sel_registerName(s.as_ptr())
    }
    // objc_msgSend se llama SIEMPRE con la firma exacta del método: en arm64 de
    // Apple los argumentos variádicos van por la pila y romperían la llamada.
    unsafe fn msg0(receiver: Id, s: Sel) -> Id {
        let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        f(receiver, s)
    }
    unsafe fn msg1(receiver: Id, s: Sel, a: Id) -> Id {
        let f: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        f(receiver, s, a)
    }

    /// `- (BOOL)applicationShouldHandleReopen:(NSApplication*)app hasVisibleWindows:(BOOL)v`
    /// Clic en el icono con la app ya abierta => reabrir el panel en el navegador.
    extern "C" fn reopen(_this: Id, _sel: Sel, _app: Id, _visible: bool) -> bool {
        if let Some(u) = PANEL_URL.get() {
            super::dlog("reabrir: abriendo el panel en el navegador");
            super::open_browser(u);
        }
        false
    }

    /// No vuelve: ejecuta el bucle de eventos en el hilo actual (debe ser el principal).
    pub fn run_app_loop(url: String) {
        let _ = PANEL_URL.set(url);
        unsafe {
            let app = msg0(objc_getClass(c"NSApplication".as_ptr()), sel(c"sharedApplication"));
            if app.is_null() {
                super::dlog("cocoa: NSApplication no disponible; sigo sin bucle de eventos");
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(3600));
                }
            }
            let sup = objc_getClass(c"NSObject".as_ptr());
            let cls = objc_allocateClassPair(sup, c"RamiChainAppDelegate".as_ptr(), 0);
            if !cls.is_null() {
                class_addMethod(
                    cls,
                    sel(c"applicationShouldHandleReopen:hasVisibleWindows:"),
                    reopen as *const c_void,
                    c"B@:@B".as_ptr(),
                );
                objc_registerClassPair(cls);
                let delegate = msg0(msg0(cls, sel(c"alloc")), sel(c"init"));
                msg1(app, sel(c"setDelegate:"), delegate);
            }
            super::dlog("cocoa: bucle de eventos en marcha");
            msg0(app, sel(c"run"));
        }
    }
}

'''
s = s.replace(ESC, COCOA + ESC, 1)

# 3) Final de main: bucle Cocoa en el hilo principal cuando no hay terminal.
TAIL_OLD = '''    if !has(&args, "--no-open") {
        open_browser(&url);
    }
    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}'''
assert TAIL_OLD in s, "ancla final de main"
TAIL_NEW = '''    if !has(&args, "--no-open") {
        open_browser(&url);
    }

    // macOS lanzada desde el Finder (sin terminal): el panel se sirve en un
    // hilo y el hilo principal ejecuta el bucle de eventos Cocoa, para que
    // macOS nunca marque la app como «no responde» y el clic en el icono
    // reabra el panel. Desde una terminal (stdin es TTY) se sirve en primer
    // plano, como siempre.
    #[cfg(target_os = "macos")]
    {
        use std::io::IsTerminal;
        if !std::io::stdin().is_terminal() {
            let gui2 = gui.clone();
            std::thread::spawn(move || http::serve(listener, move |req| route(&gui2, req)));
            cocoa::run_app_loop(url.clone());
            return ExitCode::SUCCESS;
        }
    }
    http::serve(listener, move |req| route(&gui, req));
    ExitCode::SUCCESS
}'''
s = s.replace(TAIL_OLD, TAIL_NEW, 1)
open(P, "w", encoding="utf-8").write(s)
print("ok", P)

# ---------------- LÉEME de macOS ----------------
patch("packaging/macos/COMO-ABRIR.txt", [(
'''¿LA APP «NO RESPONDE» AL VOLVER A ABRIRLA?
El monedero vive en tu navegador (panel local). Si cierras la pestaña, la app
sigue corriendo en segundo plano y macOS no la relanza al hacer clic de nuevo.
  • Para volver al panel: abre http://127.0.0.1:8645 en tu navegador.
  • Para cerrarla del todo: usa el botón «⏻ Salir» del panel (arriba a la
    derecha). Después, el icono vuelve a abrirla con normalidad.''',
'''CÓMO SE USA LA APP
El monedero vive en tu navegador (panel local en http://127.0.0.1:8645).
  • Doble clic en la app: arranca el nodo y abre el panel.
  • Si el panel ya está abierto y vuelves a hacer clic en el icono, se vuelve
    a abrir el panel en el navegador (desde v0.5.1; antes macOS podía decir
    «no responde» — el nodo funcionaba, pero la app no atendía al clic).
  • Para cerrarla del todo: botón «⏻ Salir» del panel (arriba a la derecha).
  • Si algún día ves «no responde»: abre http://127.0.0.1:8645 — el nodo sigue
    funcionando — y actualiza a la última versión desde la pestaña Actualizar.''')])

# ---------------- README ----------------
patch("README.md", [(
"- **v0.5.x (siguiente):** instantáneas de cadena re-verificables para el explorador",
'''- **v0.5.1 (esto): macOS — la app deja de «no responder».** macOS mostraba
  «La aplicación RAMI-Chain no responde» al hacer clic en el icono con la app
  ya abierta: el proceso (un binario de consola) nunca atendía los eventos del
  sistema, aunque el nodo funcionara. Ahora, lanzada desde el Finder, la app
  corre un **bucle de eventos Cocoa real** en el hilo principal (runtime de
  Objective‑C vía FFI, sin dependencias) con un delegado que, al reabrir la
  app (clic en el icono), **abre el panel en el navegador**. El servidor del
  panel pasa a un hilo. Desde una terminal se comporta como siempre. Se retira
  la lanzadera de v0.4.2 (ya innecesaria).
- **v0.5.x (siguiente):** instantáneas de cadena re-verificables para el explorador''')])
print("TODO APLICADO")
