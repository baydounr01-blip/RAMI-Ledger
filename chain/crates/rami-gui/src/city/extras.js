/*
 * Dubái RAMI — módulo «extras»: sonido, foto, tiempo, metro y barcos.
 *
 * Secciones 6 y 7 del plan del metaverso (docs/METAVERSO.md): el sonido
 * sintetizado, el modo foto, la tormenta de arena, el metro elevado y los
 * barcos. Nada de lo que hay aquí se descarga: la geometría se fabrica con las
 * piezas del núcleo y el sonido sale de osciladores y de ruido.
 *
 * Genotipo y fenotipo (§1): todo lo que tiene que coincidir entre dos máquinas
 * —por dónde va el metro, dónde paran los trenes, qué tren pasa por dónde a
 * qué hora, por dónde navega cada barco y qué días hay tormenta— sale de datos
 * que ya son de todos (el trazado de las vías del mapa, las rutas fijas de este
 * fichero, el reloj) y de semillas enteras. Nada sale de Math.random ni del
 * orden de carga.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;

  // ---------------------------------------------------------------------------
  // Datos fijos
  // ---------------------------------------------------------------------------

  // Rutas de los barcos, en [lat, lon]. Se sacaron del propio relieve del
  // repositorio (dubai.hgt.png) con una búsqueda A* sobre el agua VISIBLE —el
  // máximo entre el campo de alturas y la malla fina de 138 m, que es lo que se
  // dibuja— exigiendo una distancia mínima a la orilla, y se comprobaron cada 5 m
  // con esa misma holgura. El cliente vuelve a comprobarlas al cargar
  // (`validaRuta`): una ruta que toque tierra no se usa y se cuenta en las
  // estadísticas. Cada ruta es la línea central; el barco va por un carril a su
  // derecha (o metros), da la vuelta en un semicírculo y vuelve por el otro.
  var RUTAS = [
    // Dubai Marina: del paso al mar del sur hasta antes del codo, donde la malla
    // fina del terreno cierra el canal (el canal estampado mide 150 m y la
    // malla muestrea cada 138).
    { id: 'marina', tipo: 'yate', o: 10, c: 10, v: 4.5, n: 5, pts: [[25.07252, 55.13297], [25.07291, 55.13338], [25.0732, 55.13353], [25.07373, 55.13403], [25.07567, 55.13607], [25.07719, 55.13744], [25.07909, 55.13938], [25.07971, 55.13983], [25.08362, 55.1433], [25.08566, 55.14472], [25.08634, 55.14532], [25.08669, 55.14555], [25.08708, 55.14571], [25.08752, 55.1458], [25.08888, 55.14582], [25.09031, 55.14567]] },
    // El Creek de punta a punta: los dhows de crucero.
    { id: 'creek', tipo: 'dhow', o: 35, c: 20, v: 3.2, n: 6, pts: [[25.21282, 55.3316], [25.22607, 55.33089], [25.22868, 55.33058], [25.2306, 55.33021], [25.23396, 55.32918], [25.23674, 55.32872], [25.23985, 55.32766], [25.24187, 55.32686], [25.24376, 55.32585], [25.24553, 55.32464], [25.24717, 55.32323], [25.24986, 55.32041], [25.2507, 55.3196], [25.2512, 55.3192], [25.25137, 55.3192], [25.25364, 55.31692], [25.25849, 55.31161], [25.26277, 55.30632], [25.26429, 55.30408], [25.26749, 55.29869], [25.27009, 55.29481], [25.27111, 55.29248], [25.27174, 55.2903], [25.27216, 55.28927], [25.27391, 55.28583], [25.27405, 55.28523], [25.27405, 55.28399]] },
    // La costa de Jumeirah, entre la orilla y The World, a más de 250 m de
    // cualquier tierra: un dhow de carga a vela.
    { id: 'costa', tipo: 'dhow', o: 40, c: 200, v: 3.8, n: 3, pts: [[25.2641, 55.25334], [25.25163, 55.23955], [25.24742, 55.23538], [25.244, 55.23256], [25.24137, 55.23108], [25.23695, 55.2306], [25.22497, 55.22814], [25.22027, 55.22651], [25.21559, 55.22431], [25.21092, 55.22154], [25.20626, 55.21819], [25.20204, 55.21487], [25.19826, 55.21159], [25.1949, 55.20833], [25.19199, 55.20511], [25.18938, 55.20269], [25.18708, 55.20108], [25.18508, 55.20027], [25.18087, 55.20027]] },
    // Las abras cruzan el Creek de orilla a orilla, a 45 m de cada muelle.
    { id: 'abra1', tipo: 'abra', o: 8, c: 10, v: 2.8, n: 2, pts: [[25.26569, 55.29973], [25.26753, 55.30106]] },
    { id: 'abra2', tipo: 'abra', o: 8, c: 10, v: 2.8, n: 2, pts: [[25.25487, 55.31296], [25.25621, 55.31554]] },
    { id: 'abra3', tipo: 'abra', o: 8, c: 10, v: 2.8, n: 2, pts: [[25.2497, 55.31808], [25.25144, 55.32072]] },
    { id: 'abra4', tipo: 'abra', o: 8, c: 10, v: 2.8, n: 2, pts: [[25.2413, 55.32546], [25.2424, 55.32817]] }
  ];

  // Metro. Medidas del de Dubái: pilares cada 30 m, estaciones cada 1,5 km, tren
  // de cinco coches de 17 m, 80 km/h de crucero, aceleración de 1 m/s².
  var METRO = {
    PASO: 30, ESTACION: 1500, CLARO: 10.5, VMAX: 22.2, ACEL: 1.0, PARADA: 30, TERMINAL: 180,
    INTERVALO: 360, COCHES: 5, COCHE: 17, PASO_COCHE: 17.6, VIA: 2.2, ANDEN: 110, RADIO: 600
  };
  // Perfil barrido del viaducto: artesa de hormigón con dos petos, en (u, v)
  // respecto al eje y a la cota del piso de vía. Cerrado: el último lado es la
  // cara de abajo.
  var PERFIL = [[-4.7, -1.9], [-4.7, 1.15], [-4.35, 1.15], [-4.35, 0], [4.35, 0], [4.35, 1.15], [4.7, 1.15], [4.7, -1.9]];
  var HORMIGON = [0.80, 0.78, 0.74], BALASTO = [0.40, 0.38, 0.36], CARRIL = [0.62, 0.62, 0.64];

  // Tormenta: 1 de cada 17 días de Dubái, por la tarde (ver `tormentaDelDia`).
  var TORMENTA = { CADA: 17, CANAL: 41, SAL: 0x7a11, VIS: 380, RAMPA: 1800 };
  var CALIDAD = {
    baja: { mover: false, arena: 300 },
    media: { mover: true, arena: 900 },
    alta: { mover: true, arena: 1500 },
    ultra: { mover: true, arena: 2000 }
  };

  global.RamiCity3D.extend('extras', function (ctx) {
    var THREE = ctx.THREE, S = ctx.S, U = ctx.util, M = ctx.mundo, G = ctx.geom, t = ctx.t;
    var scene = ctx.scene, camera = ctx.camera, canvas = ctx.canvas, container = ctx.container, walk = ctx.walk, cam = ctx.cam;
    var doc = global.document;
    var desfase = 0, fijo = null;              // solo para pruebas (publico.reloj)
    function ahora() { return fijo !== null ? fijo : (Date.now() + desfase) / 1000; }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function lsLee(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
    function lsPon(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } }
    function Q() { return CALIDAD[ctx.calidad()] || CALIDAD.media; }
    function copia(a, b) { var o = {}, k; for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k]; for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k]; return o; }

    var _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _cp = new THREE.Vector3();
    var _frustum = new THREE.Frustum(), _pm = new THREE.Matrix4(), _esf = new THREE.Sphere();
    var dummy = new THREE.Object3D();
    /** Pirámide de visión del cuadro que se va a dibujar (con la cámara al día). */
    function actualizaFrustum() {
      camera.updateWorldMatrix(true, false);
      _pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      _frustum.setFromProjectionMatrix(_pm);
      _cp.setFromMatrixPosition(camera.matrixWorld);
    }
    function seVe(x, y, z, r, lejos) {
      var dx = x - _cp.x, dy = y - _cp.y, dz = z - _cp.z;
      if (dx * dx + dy * dy + dz * dz > (lejos + r) * (lejos + r)) return false;
      _esf.center.set(x, y, z); _esf.radius = r;
      return _frustum.intersectsSphere(_esf);
    }

    // =========================================================================
    // Interfaz: una barra pequeña flotante dentro del contenedor del visor
    // =========================================================================
    var ui = { barra: null, foto: null, css: null, botones: {} };
    function creaInterfaz() {
      if (!container || !doc) return;
      if (!doc.getElementById('rx-extras-css')) {
        var st = doc.createElement('style'); st.id = 'rx-extras-css';
        st.textContent = [
          '.rx-barra{position:absolute;right:10px;bottom:10px;z-index:4;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100% - 20px);font:12.5px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
          '.rx-barra button{background:rgba(11,14,23,.78);color:#e8eaf2;border:1px solid #1e2740;border-radius:9px;padding:5px 9px;font:inherit;cursor:pointer;line-height:1.2}',
          '.rx-barra button:hover{background:rgba(30,39,64,.9)}',
          '.rx-barra button.on{outline:2px solid #7ef0c0;outline-offset:1px}',
          '.rx-barra input[type=range]{width:90px;accent-color:#7ef0c0;margin:0}',
          '.rx-barra .rx-et{color:#e8eaf2;background:rgba(11,14,23,.78);border:1px solid #1e2740;border-radius:9px;padding:4px 8px;display:flex;gap:6px;align-items:center;white-space:nowrap}',
          '.rx-oculto{display:none!important}'
        ].join('\n');
        doc.head.appendChild(st); ui.css = st;
      }
      var b = doc.createElement('div'); b.className = 'rx-barra'; b.setAttribute('data-rx', 'barra');
      function boton(id, texto, titulo, fn) {
        var e = doc.createElement('button'); e.type = 'button'; e.textContent = texto; e.title = titulo; e.setAttribute('aria-label', titulo);
        e.addEventListener('click', function (ev) { ev.stopPropagation(); fn(); });
        ui.botones[id] = e; return e;
      }
      var vol = doc.createElement('label'); vol.className = 'rx-et rx-oculto'; vol.title = t('Volumen');
      var volR = doc.createElement('input'); volR.type = 'range'; volR.min = '0'; volR.max = '100'; volR.value = String(Math.round(snd.volumen * 100));
      volR.setAttribute('aria-label', t('Volumen'));
      volR.addEventListener('input', function () { snd.volumen = Number(volR.value) / 100; lsPon('rami.sonido.volumen', String(snd.volumen)); aplicaVolumen(); });
      vol.appendChild(doc.createTextNode('🔈')); vol.appendChild(volR); ui.vol = vol;
      b.appendChild(vol);
      b.appendChild(boton('sonido', '🔇', t('Sonido de la ciudad (sintetizado): viento, tráfico, pasos y noche'), function () { alternaSonido(); }));
      b.appendChild(boton('foto', '📷', t('Modo foto: sin interfaz, focal ajustable y descarga en PNG'), function () { entraFoto(); }));
      b.appendChild(boton('tormenta', '🌪', t('Tormenta de arena'), function () { tormenta.forzada = tormenta.forzada === true ? null : true; pintaBotones(); }));
      container.appendChild(b); ui.barra = b;

      // Barra del modo foto
      var f = doc.createElement('div'); f.className = 'rx-barra rx-oculto'; f.setAttribute('data-rx', 'foto');
      var foc = doc.createElement('label'); foc.className = 'rx-et'; foc.title = t('Distancia focal (equivalente a 35 mm)');
      var focR = doc.createElement('input'); focR.type = 'range'; focR.min = '0'; focR.max = '1000'; focR.setAttribute('aria-label', t('Distancia focal (equivalente a 35 mm)'));
      var focT = doc.createElement('span'); focT.textContent = '26 mm';
      focR.addEventListener('input', function () { foto.focal = focalDeRango(Number(focR.value)); focT.textContent = Math.round(foto.focal) + ' mm'; });
      foc.appendChild(focR); foc.appendChild(focT); ui.focR = focR; ui.focT = focT;
      f.appendChild(foc);
      f.appendChild(boton('libre', '🕊', t('Cámara libre: vuela con WASD, Q y E y arrastra para mirar'), function () { camaraLibre(); }));
      f.appendChild(boton('nivel', '⊟', t('Horizonte nivelado: la cámara no se inclina y el encuadre se desplaza'), function () { foto.nivel = !foto.nivel; if (!foto.nivel) camera.clearViewOffset(); pintaBotones(); }));
      f.appendChild(boton('travelling', '🎞', t('Travelling lento'), function () { foto.travelling = !foto.travelling; pintaBotones(); }));
      f.appendChild(boton('guardar', '💾 ' + t('Guardar'), t('Guardar el cuadro como PNG'), function () { foto.pendiente = true; }));
      f.appendChild(boton('salir', '✕ ' + t('Salir'), t('Salir del modo foto'), function () { saleFoto(); }));
      container.appendChild(f); ui.foto = f;
      pintaBotones();
    }
    function pintaBotones() {
      var B = ui.botones; if (!B.sonido) return;
      B.sonido.textContent = snd.activo ? '🔊' : '🔇';
      B.sonido.classList.toggle('on', !!snd.activo);
      if (ui.vol) ui.vol.classList.toggle('rx-oculto', !snd.activo);
      B.tormenta.classList.toggle('on', tormenta.forzada === true);
      var p = proximasTormentas(1)[0];
      B.tormenta.title = t('Tormenta de arena') + (tormenta.forzada === true ? ' · ' + t('activada a mano') : '') +
        (p ? ' · ' + t('próxima en Dubái') + ': ' + fechaDubai(p.ini) + '–' + horaDubai(p.fin) : '');
      if (B.nivel) { B.nivel.classList.toggle('on', foto.nivel); B.travelling.classList.toggle('on', foto.travelling); B.libre.classList.toggle('on', S.mode === 'walk' && walk.fly >= 2); }
    }

    // =========================================================================
    // 1. Sonido sintetizado
    // =========================================================================
    // Ni un fichero de audio: el viento es ruido blanco por un filtro de banda
    // que un oscilador lento mueve (las rachas); el tráfico, dos dientes de
    // sierra por un paso bajo cuyo tono sigue la velocidad media de los coches
    // cercanos, más el rodar del neumático (ruido grave); los pasos, un golpe de
    // ruido filtrado y un seno grave que cae; la noche, un seno agudo cortado a
    // 24 Hz (grillos) muy bajo. El AudioContext se crea en el clic del botón (los
    // navegadores lo exigen) o en el primer gesto sobre la página si la
    // preferencia guardada dice que estaba encendido.
    var snd = { ac: null, activo: false, volumen: 0.6, n: {}, nodos: 0, ultimoCuadro: 0, pasoAcum: 0, pasoPrev: null, pasoN: 0, reloj: 0, ruido: null, sonando: {} };
    (function () { var v = Number(lsLee('rami.sonido.volumen')); if (lsLee('rami.sonido.volumen') !== null && isFinite(v)) snd.volumen = clamp(v, 0, 1); })();
    function nodo(n) { snd.nodos++; return n; }
    function creaAudio() {
      if (snd.ac) return true;
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return false;
      var ac = new AC(); snd.ac = ac;
      var n = snd.n;
      n.master = nodo(ac.createGain()); n.master.gain.value = 0;
      n.comp = nodo(ac.createDynamicsCompressor());
      n.master.connect(n.comp); n.comp.connect(ac.destination);
      // Dos segundos de ruido blanco, con el generador del genotipo: el mismo
      // búfer en todas las máquinas, y sin Math.random.
      var len = ac.sampleRate * 2, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0), r = U.lcg(20260922), i;
      for (i = 0; i < len; i++) d[i] = r() * 2 - 1;
      snd.ruido = buf;
      function bucle() { var s = nodo(ac.createBufferSource()); s.buffer = buf; s.loop = true; return s; }
      function filtro(tipo, f, q) { var x = nodo(ac.createBiquadFilter()); x.type = tipo; x.frequency.value = f; x.Q.value = q || 0.7; return x; }
      function ganancia(v) { var g = nodo(ac.createGain()); g.gain.value = v; return g; }
      function osc(tipo, f) { var o = nodo(ac.createOscillator()); o.type = tipo; o.frequency.value = f; return o; }
      // Viento
      n.vientoSrc = bucle(); n.vientoF = filtro('bandpass', 380, 0.8); n.viento = ganancia(0);
      n.vientoSrc.connect(n.vientoF); n.vientoF.connect(n.viento); n.viento.connect(n.master);
      n.rachas = osc('sine', 0.11); n.rachasG = ganancia(160); n.rachas.connect(n.rachasG); n.rachasG.connect(n.vientoF.frequency);
      // Tráfico: motores y rodadura
      n.motorA = osc('sawtooth', 55); n.motorB = osc('sawtooth', 83); n.motorF = filtro('lowpass', 320, 0.9); n.motor = ganancia(0);
      n.motorA.connect(n.motorF); n.motorB.connect(n.motorF); n.motorF.connect(n.motor); n.motor.connect(n.master);
      n.rodSrc = bucle(); n.rodF = filtro('lowpass', 600, 0.5); n.rod = ganancia(0);
      n.rodSrc.connect(n.rodF); n.rodF.connect(n.rod); n.rod.connect(n.master);
      // Metro: un retumbo grave que crece al acercarse un tren
      n.metroSrc = bucle(); n.metroF = filtro('lowpass', 170, 0.8); n.metro = ganancia(0);
      n.metroSrc.connect(n.metroF); n.metroF.connect(n.metro); n.metro.connect(n.master);
      // Noche: grillos (seno agudo modulado a 24 Hz)
      n.grillo = osc('sine', 4300); n.grilloAM = ganancia(0); n.am = osc('square', 24); n.amG = ganancia(0.5);
      n.am.connect(n.amG); n.amG.connect(n.grilloAM.gain); n.grillo.connect(n.grilloAM);
      n.noche = ganancia(0); n.grilloAM.connect(n.noche); n.noche.connect(n.master);
      var arranca = [n.vientoSrc, n.rachas, n.motorA, n.motorB, n.rodSrc, n.metroSrc, n.grillo, n.am];
      for (i = 0; i < arranca.length; i++) arranca[i].start();
      return true;
    }
    function objetivo(param, v, tau) {
      if (!param || !snd.ac) return;
      try { param.setTargetAtTime(v, snd.ac.currentTime, tau || 0.25); } catch (e) { param.value = v; }
    }
    function aplicaVolumen() { if (snd.ac) objetivo(snd.n.master.gain, snd.activo ? snd.volumen : 0, 0.15); }
    function alternaSonido() {
      if (!snd.activo) {
        if (!creaAudio()) return;
        snd.activo = true;
        if (snd.ac.state !== 'running') { try { snd.ac.resume(); } catch (e) { /* lo reanuda el siguiente gesto */ } }
      } else {
        snd.activo = false;
      }
      lsPon('rami.sonido', snd.activo ? '1' : '0');
      aplicaVolumen();
      if (!snd.activo && snd.ac) { var ac = snd.ac; global.setTimeout(function () { if (!snd.activo && ac.state === 'running') { try { ac.suspend(); } catch (e) { /* nada */ } } }, 400); }
      pintaBotones();
    }
    // Preferencia guardada: el contexto nace en el primer gesto sobre la página.
    function primerGesto() {
      doc.removeEventListener('pointerdown', primerGesto, true); doc.removeEventListener('keydown', primerGesto, true);
      if (lsLee('rami.sonido') === '1' && !snd.activo) alternaSonido();
    }
    if (doc && lsLee('rami.sonido') === '1') { doc.addEventListener('pointerdown', primerGesto, true); doc.addEventListener('keydown', primerGesto, true); }
    function visibilidad() {
      if (!snd.ac) return;
      try { if (doc.hidden) snd.ac.suspend(); else if (snd.activo) snd.ac.resume(); } catch (e) { /* nada */ }
    }
    if (doc) doc.addEventListener('visibilitychange', visibilidad);
    // Si el visor deja de dibujar (vista 2D, pestaña de otra sección), el sonido
    // se apaga solo: sin cuadros no hay de dónde sacar el viento ni el tráfico.
    var vigia = global.setInterval(function () {
      if (!snd.ac || !snd.activo) return;
      if (performance.now() - snd.ultimoCuadro > 1500) objetivo(snd.n.master.gain, 0, 0.2);
    }, 1000);

    /** Un sonido corto del catálogo. Devuelve false si el sonido está apagado. */
    function suena(nombre) {
      if (!snd.ac || !snd.activo || snd.ac.state !== 'running') return false;
      var ac = snd.ac, n = snd.n, t0 = ac.currentTime + 0.01, g, o, s, f;
      function env(gn, pico, ataque, caida) {
        gn.gain.setValueAtTime(0.0001, t0); gn.gain.exponentialRampToValueAtTime(pico, t0 + ataque); gn.gain.exponentialRampToValueAtTime(0.0001, t0 + ataque + caida);
      }
      function tono(frec, tipo, pico, ataque, caida, retraso) {
        var gg = ac.createGain(), oo = ac.createOscillator(); oo.type = tipo; oo.frequency.value = frec;
        var tt = t0 + (retraso || 0);
        gg.gain.setValueAtTime(0.0001, tt); gg.gain.exponentialRampToValueAtTime(pico, tt + ataque); gg.gain.exponentialRampToValueAtTime(0.0001, tt + ataque + caida);
        oo.connect(gg); gg.connect(n.master); oo.start(tt); oo.stop(tt + ataque + caida + 0.05);
        return oo;
      }
      function rafaga(tipoF, f0, f1, q, pico, dur, retraso) {
        var ss = ac.createBufferSource(), ff = ac.createBiquadFilter(), gg = ac.createGain(), tt = t0 + (retraso || 0);
        ss.buffer = snd.ruido; ff.type = tipoF; ff.Q.value = q; ff.frequency.setValueAtTime(f0, tt); ff.frequency.exponentialRampToValueAtTime(f1, tt + dur);
        gg.gain.setValueAtTime(0.0001, tt); gg.gain.exponentialRampToValueAtTime(pico, tt + dur * 0.2); gg.gain.exponentialRampToValueAtTime(0.0001, tt + dur);
        ss.connect(ff); ff.connect(gg); gg.connect(n.master);
        ss.start(tt, (snd.pasoN * 0.137) % 1.5); ss.stop(tt + dur + 0.05);
      }
      switch (nombre) {
        case 'timbre':     // el «ding» del ascensor: mi6 y do6 con su armónico
          tono(1318.5, 'sine', 0.22, 0.005, 1.3); tono(2637, 'sine', 0.04, 0.005, 0.5);
          tono(1046.5, 'sine', 0.20, 0.005, 1.6, 0.32); tono(2093, 'sine', 0.035, 0.005, 0.6, 0.32);
          break;
        case 'puerta':     // puerta corredera: soplido que sube y golpe de tope
          rafaga('bandpass', 300, 1400, 0.9, 0.18, 0.55, 0);
          tono(70, 'sine', 0.35, 0.004, 0.18, 0.55); rafaga('lowpass', 400, 200, 0.7, 0.12, 0.12, 0.55);
          break;
        case 'clic':       // interruptor o botón
          tono(2100, 'square', 0.06, 0.001, 0.018); tono(900, 'sine', 0.05, 0.001, 0.03);
          break;
        case 'paso':
          snd.pasoN++;
          var r = U.real01(U.semillaMorfologia(snd.pasoN, 7, 43));
          rafaga('bandpass', 700 + 500 * r, 500, 1.2, 0.10, 0.09, 0);
          tono(85 + 25 * r, 'sine', 0.16, 0.003, 0.07);
          break;
        default: return false;
      }
      return true;
    }
    function actualizaSonido(dt) {
      snd.ultimoCuadro = performance.now();
      if (!snd.ac || !snd.activo || snd.ac.state !== 'running') return;
      var n = snd.n;
      aplicaVolumen();
      camera.getWorldPosition(_v);
      var suelo = M.groundH(_v.x, _v.z), altura = Math.max(0, _v.y - suelo), k = tormenta.k, noche = S.night || 0;
      // Viento: más fuerte con la altura y en la tormenta.
      objetivo(n.viento.gain, 0.035 + 0.20 * clamp(altura / 400, 0, 1) + 0.42 * k, 0.6);
      objetivo(n.vientoF.frequency, 330 + 220 * clamp(altura / 400, 0, 1) + 520 * k, 0.8);
      // Tráfico: los coches a menos de 120 m, cada uno con peso 1/(1+(d/12)²).
      var tr = S.traffic, suma = 0, sumaV = 0, i;
      if (tr && tr.cars) for (i = 0; i < tr.cars.length; i++) {
        var c = tr.cars[i]; if (c.x === undefined) continue;
        var dx = c.x - _v.x, dz = c.z - _v.z, d2 = dx * dx + dz * dz + (_v.y - suelo) * (_v.y - suelo);
        if (d2 > 14400) continue;
        var w = 1 / (1 + d2 / 144); suma += w; sumaV += w * (c.vel || 0);
      }
      var vm = suma > 0 ? sumaV / suma : 0, f = 38 + 1.9 * vm;
      objetivo(n.motorA.frequency, f, 0.3); objetivo(n.motorB.frequency, f * 1.5 + 3, 0.3);
      objetivo(n.motor.gain, clamp(suma * 0.45, 0, 0.30), 0.3);
      objetivo(n.rod.gain, clamp(suma * 0.25, 0, 0.22), 0.3);
      // Metro: el coche más cercano.
      objetivo(n.metro.gain, metro.cercano < 1e8 ? 0.45 / (1 + metro.cercano * metro.cercano / 1600) : 0, 0.3);
      // Noche: grillos que respiran, y callan en la tormenta y en lo alto.
      snd.reloj += dt;
      objetivo(n.noche.gain, 0.014 * noche * (1 - k) * (0.6 + 0.4 * Math.sin(snd.reloj * 1.7)) / (1 + altura / 40), 0.4);
      // Pasos: uno cada 0,75 m andando (1,6 m corriendo con mayúsculas).
      if (S.mode === 'walk' && walk.fly < 2 && !S.xr) {
        if (snd.pasoPrev) {
          var mx = walk.pos.x - snd.pasoPrev.x, mz = walk.pos.z - snd.pasoPrev.z, dd = Math.sqrt(mx * mx + mz * mz);
          if (dd < 20) {
            var vel = dt > 0 ? dd / dt : 0, zancada = vel > 12 ? 1.6 : 0.75;
            snd.pasoAcum += dd;
            if (vel > 0.4 && snd.pasoAcum >= zancada) { snd.pasoAcum = 0; suena('paso'); }
          } else snd.pasoAcum = 0;
        }
        snd.pasoPrev = { x: walk.pos.x, z: walk.pos.z };
      } else snd.pasoPrev = null;
    }
    ctx.servicios.sonido = {
      /** Reproduce 'timbre', 'puerta', 'clic' o 'paso'; false (sin lanzar) si el sonido está apagado. */
      play: function (nombre) { try { return suena(String(nombre)); } catch (e) { return false; } },
      activo: function () { return !!(snd.ac && snd.activo && snd.ac.state === 'running'); }
    };

    // =========================================================================
    // 2. Modo foto
    // =========================================================================
    // Una película es encuadre, distancia focal, un travelling lento y la hora
    // correcta. La focal va en milímetros de formato 35 mm (fov vertical =
    // 2·atan(12/f)); el horizonte nivelado quita la inclinación de la cámara y
    // conserva el encuadre desplazando la ventana de proyección (lo que hace un
    // objetivo descentrable: las verticales de los rascacielos quedan
    // verticales); el travelling gira la órbita 1,2°/s o desplaza la cámara a pie
    // 1,2 m/s de lado. «Guardar» copia el lienzo en el gancho trasPintar, justo
    // después de dibujar —el lienzo no tiene preserveDrawingBuffer y un cuadro
    // más tarde ya estaría vacío—, le pone el pie de «red de pruebas» y lo
    // descarga en PNG.
    var foto = { activo: false, focal: 26, nivel: false, travelling: false, pendiente: false, capturas: 0, ultima: null, guardado: null, ocultas: [], objetos: [] };
    function fovDeFocal(f) { return 2 * Math.atan(12 / f) * 180 / Math.PI; }
    function focalDeFov(fov) { return 12 / Math.tan(fov * Math.PI / 360); }
    // El deslizador va de 14 a 200 mm en escala logarítmica.
    function focalDeRango(v) { return 14 * Math.pow(200 / 14, v / 1000); }
    function rangoDeFocal(f) { return Math.round(1000 * Math.log(f / 14) / Math.log(200 / 14)); }
    function esEtiqueta(o) { return o.material && o.material.uniforms && o.material.uniforms.uViewport && o.material.uniforms.uMap && o.renderOrder === 50; }
    function ocultaEtiquetas() {
      scene.traverse(function (o) {
        if (esEtiqueta(o) && o.material.visible) { o.material.visible = false; foto.ocultas.push(o.material); }
      });
      var C = ctx.C, lista = [C.hover, C.selFill, C.selLoop], i;
      for (i = 0; i < lista.length; i++) if (lista[i] && lista[i].visible) { lista[i].visible = false; foto.objetos.push(lista[i]); }
    }
    function entraFoto() {
      if (foto.activo || !S.ready || S.xr) return;
      foto.activo = true;
      foto.guardado = { fov: camera.fov, mode: S.mode, fly: walk.fly, pantalla: [] };
      foto.focal = clamp(focalDeFov(camera.fov), 14, 200);
      if (ui.focR) { ui.focR.value = String(rangoDeFocal(foto.focal)); ui.focT.textContent = Math.round(foto.focal) + ' mm'; }
      // Fuera la interfaz: todo lo que cuelga del contenedor salvo el lienzo y
      // la barra del modo foto (las pistas, los avisos y las barras de otros
      // módulos vuelven como estaban al salir).
      var hijos = container.children, i;
      for (i = 0; i < hijos.length; i++) {
        var h = hijos[i]; if (h === canvas || h === ui.foto) continue;
        foto.guardado.pantalla.push({ el: h, display: h.style.display }); h.style.display = 'none';
      }
      if (ui.foto) ui.foto.classList.remove('rx-oculto');
      ocultaEtiquetas();
      pintaBotones();
    }
    function saleFoto() {
      if (!foto.activo) return;
      foto.activo = false; foto.pendiente = false;
      var g = foto.guardado, i;
      camera.fov = g.fov; camera.clearViewOffset(); camera.updateProjectionMatrix();
      for (i = 0; i < g.pantalla.length; i++) g.pantalla[i].el.style.display = g.pantalla[i].display;
      for (i = 0; i < foto.ocultas.length; i++) foto.ocultas[i].visible = true;
      for (i = 0; i < foto.objetos.length; i++) foto.objetos[i].visible = true;
      foto.ocultas = []; foto.objetos = [];
      if (ui.foto) ui.foto.classList.add('rx-oculto');
      pintaBotones();
    }
    function camaraLibre() {
      if (S.mode !== 'walk') ctx.setMode('walk');
      walk.fly = walk.fly >= 2 ? 0 : Math.max(walk.fly, 40);
      pintaBotones();
    }
    function cuadroFoto(dt) {
      if (!foto.activo) return;
      // Las etiquetas que aparezcan mientras tanto (un avatar que llega, una
      // selección) se ocultan también.
      if ((S.frame & 15) === 0) ocultaEtiquetas();
      var i, lista = foto.objetos;
      for (i = 0; i < lista.length; i++) lista[i].visible = false;
      if (foto.travelling) {
        if (S.mode === 'walk') {
          var r = 1.2 * dt;
          walk.pos.x += Math.cos(walk.yaw) * r; walk.pos.z -= Math.sin(walk.yaw) * r;
          if (walk.fly < 2) ctx.catastro.empujarFuera(walk.pos, 0.42);
        } else { cam.goal.theta += 0.021 * dt; cam.cur.theta += 0.021 * dt; }
      }
      camera.fov = fovDeFocal(foto.focal);
      if (foto.nivel) {
        // Inclinación que tenía la cámara: se quita y se compensa con el
        // desplazamiento de la ventana (hasta media altura de encuadre).
        camera.updateWorldMatrix(true, false);
        camera.getWorldDirection(_v);
        var pitch = Math.asin(clamp(_v.y, -1, 1));
        camera.getWorldPosition(_v2);
        camera.lookAt(_v2.x + _v.x, _v2.y, _v2.z + _v.z);
        var W = canvas.clientWidth || canvas.width || 1, H = canvas.clientHeight || canvas.height || 1;
        var yt = Math.tan(pitch) / Math.tan(camera.fov * Math.PI / 360);
        var off = clamp(-yt, -1, 1) * H / 2;
        camera.setViewOffset(W, H, 0, off, W, H);
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
    }
    function fechaArchivo() {
      var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    }
    function capturaFoto() {
      foto.pendiente = false;
      var w = canvas.width, h = canvas.height;
      var c2 = doc.createElement('canvas'); c2.width = w; c2.height = h;
      var g = c2.getContext('2d');
      g.drawImage(canvas, 0, 0);                 // ahora: el búfer sigue siendo este cuadro
      var fs = Math.max(12, Math.round(h * 0.018)), txt = t('Dubái RAMI · red de pruebas, sin valor monetario');
      g.font = fs + 'px -apple-system, "Segoe UI", Roboto, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom';
      g.lineWidth = Math.max(2, fs / 5); g.strokeStyle = 'rgba(10,16,24,0.75)'; g.strokeText(txt, w - fs, h - fs * 0.6);
      g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillText(txt, w - fs, h - fs * 0.6);
      var nombre = 'dubai-rami-' + fechaArchivo() + '.png';
      c2.toBlob(function (blob) {
        if (!blob) return;
        foto.capturas++; foto.ultima = { nombre: nombre, bytes: blob.size, ancho: w, alto: h };
        var url = URL.createObjectURL(blob), a = doc.createElement('a');
        a.href = url; a.download = nombre; a.style.display = 'none';
        doc.body.appendChild(a); a.click();
        global.setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 4000);
      }, 'image/png');
    }

    // =========================================================================
    // 3. Tormenta de arena
    // =========================================================================
    // El calendario es el mismo para todos: el día de Dubái (UTC+4) es un
    // entero, su semilla es semillaMorfologia(día, 0x7a11, 41), y hay tormenta
    // cuando esa semilla es múltiplo de 17 (1 de cada 17 días, un 5,9 %). Ese día
    // empieza a las 14, 15 o 16 h (bits 8–9 de la semilla, módulo 3) y dura 2, 3
    // o 4 horas (bits 12–13), con media hora de subida y media de bajada. El
    // viento sopla hacia el rumbo de los bits 16–24. Todo son enteros y reloj: dos
    // máquinas con la hora en punto ven la misma tormenta a la misma hora.
    //
    // Con la visibilidad a 380 m se puede dejar de dibujar lo que queda detrás de
    // la niebla: camera.far se recorta al final de la niebla (a pie, 420 m) y las
    // teselas de más allá no se envían. El fondo se pinta del color de la arena,
    // así que lo recortado no se nota.
    var tormenta = { forzada: null, k: 0, kMano: 0, base: null, fondo: null, arena: null, cielo: null, visibilidad: 0, far: 0, viento: 0, dia: -1, hoy: null, aplicada: false };
    function diaDubai(tsec) { return Math.floor((tsec + 4 * 3600) / 86400); }
    function tormentaDelDia(d) {
      var h = U.semillaMorfologia(d | 0, TORMENTA.SAL, TORMENTA.CANAL) >>> 0;
      if (h % TORMENTA.CADA !== 0) return null;
      var inicioH = 14 + ((h >>> 8) & 3) % 3, horas = 2 + ((h >>> 12) & 3) % 3;
      var cero = d * 86400 - 4 * 3600;         // medianoche de Dubái, en segundos UTC
      return { dia: d, ini: cero + inicioH * 3600, fin: cero + (inicioH + horas) * 3600, rumbo: ((h >>> 16) & 511) % 360 };
    }
    function proximasTormentas(n, desde) {
      var out = [], d = diaDubai(desde === undefined ? ahora() : desde), lim = d + 800, x, tnow = desde === undefined ? ahora() : desde;
      for (; d < lim && out.length < n; d++) { x = tormentaDelDia(d); if (x && x.fin > tnow) out.push(x); }
      return out;
    }
    function intensidadCalendario(tsec) {
      var d = diaDubai(tsec);
      if (d !== tormenta.dia) { tormenta.dia = d; tormenta.hoy = tormentaDelDia(d); }
      var x = tormenta.hoy; if (!x) return 0;
      return clamp((tsec - x.ini) / TORMENTA.RAMPA, 0, 1) * clamp((x.fin - tsec) / TORMENTA.RAMPA, 0, 1);
    }
    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function fechaDubai(tsec) { var d = new Date((tsec + 4 * 3600) * 1000); return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }
    function horaDubai(tsec) { var d = new Date((tsec + 4 * 3600) * 1000); return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()); }

    // Partículas: una caja de 90 m alrededor de la cámara; cada grano se mueve
    // con el viento en el sombreador y se envuelve con mod(), así que la CPU no
    // toca un solo vértice por cuadro.
    var ARENA_VS = [
      '#include <common>',
      '#include <logdepthbuf_pars_vertex>',
      'uniform float uTime, uSize, uR; uniform vec3 uCam, uWind; attribute float aFase; varying float vA;',
      'void main(){',
      '  vec3 p = position + uWind * uTime + vec3(sin(uTime * 1.3 + aFase * 6.3) * 1.5, sin(uTime * 0.7 + aFase * 11.0) * 0.8, cos(uTime * 1.1 + aFase * 4.1) * 1.5);',
      '  p = mod(p - uCam + uR, 2.0 * uR) - uR;',
      '  vA = 1.0 - smoothstep(0.55, 1.0, length(p) / uR);',
      '  vec4 mv = viewMatrix * vec4(p + uCam, 1.0);',
      '  gl_Position = projectionMatrix * mv;',
      '  gl_PointSize = uSize / max(-mv.z, 0.5);',
      '  #include <logdepthbuf_vertex>',
      '}'].join('\n');
    var ARENA_FS = [
      '#include <common>',
      '#include <logdepthbuf_pars_fragment>',
      'uniform vec3 uColor; uniform float uK; varying float vA;',
      'void main(){',
      '  #include <logdepthbuf_fragment>',
      '  vec2 c = gl_PointCoord - 0.5; float r = dot(c, c) * 4.0; if (r > 1.0) discard;',
      '  gl_FragColor = vec4(uColor, (1.0 - r) * vA * uK * 0.8);',
      '}'].join('\n');
    function creaArena(n) {
      if (tormenta.arena) { scene.remove(tormenta.arena); tormenta.arena.geometry.dispose(); }
      var R = 45, pos = new Float32Array(n * 3), fase = new Float32Array(n), r = U.lcg(4101), i;
      for (i = 0; i < n; i++) { pos[i * 3] = (r() * 2 - 1) * R; pos[i * 3 + 1] = (r() * 2 - 1) * R; pos[i * 3 + 2] = (r() * 2 - 1) * R; fase[i] = r(); }
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aFase', new THREE.BufferAttribute(fase, 1));
      var m = tormenta.arenaMat || (tormenta.arenaMat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uSize: { value: 60 }, uR: { value: R }, uCam: { value: new THREE.Vector3() }, uWind: { value: new THREE.Vector3(8, 0, 0) }, uColor: { value: new THREE.Color(0.78, 0.62, 0.42) }, uK: { value: 0 } },
        vertexShader: ARENA_VS, fragmentShader: ARENA_FS, transparent: true, depthWrite: false
      }));
      var p = new THREE.Points(g, m); p.frustumCulled = false; p.visible = false; p.renderOrder = 40; p.name = 'extras: arena';
      scene.add(p); tormenta.arena = p;
    }
    var ARENA_SRGB = [0.80, 0.64, 0.44];
    /** El sol: guarda los valores recién calculados por el visor (sin atenuar). */
    function guardaBaseSol(info) {
      var b = tormenta.base || (tormenta.base = { sol: new THREE.Color(), cielo: new THREE.Color(), suelo: new THREE.Color(), luz: new THREE.Color(), hemiC: new THREE.Color(), hemiS: new THREE.Color(), niebla: null });
      b.sol.copy(ctx.shared.uSunColor.value); b.cielo.copy(ctx.shared.uSkyColor.value); b.suelo.copy(ctx.shared.uGroundColor.value);
      b.luz.copy(ctx.sun.color); b.hemiC.copy(ctx.hemi.color); b.hemiS.copy(ctx.hemi.groundColor);
      b.niebla = (info && info.niebla) || b.niebla || scene.fog.color.clone();
    }
    function cuadroTormenta(dt, now) {
      var tsec = ahora(), kc = intensidadCalendario(tsec);
      // La activada a mano sube y baja en tres segundos.
      tormenta.kMano = clamp(tormenta.kMano + (tormenta.forzada === true ? 1 : -1) * dt / 3, 0, 1);
      var k = tormenta.forzada === false ? 0 : Math.max(kc, tormenta.kMano);
      tormenta.k = k;
      var hoy = tormenta.hoy, rumbo = (hoy ? hoy.rumbo : ((U.semillaMorfologia(diaDubai(tsec), TORMENTA.SAL, 42) >>> 7) % 360)) * Math.PI / 180;
      if (k <= 0.001) { if (tormenta.aplicada) restauraTormenta(); return; }
      if (!tormenta.base) guardaBaseSol(null);
      tormenta.aplicada = true;
      var b = tormenta.base, noche = S.night || 0, luz = 0.22 + 0.78 * (1 - noche);
      // Luz: el sol cae a una quinta parte y el cielo se tiñe de arena.
      var sh = ctx.shared;
      sh.uSunColor.value.copy(b.sol).multiplyScalar(1 - 0.8 * k);
      ctx.sun.color.copy(b.luz).multiplyScalar(1 - 0.8 * k);
      var al = U.lin3(ARENA_SRGB);
      _col.setRGB(al[0], al[1], al[2]).multiplyScalar(0.34 * luz);
      sh.uSkyColor.value.copy(b.cielo).lerp(_col, 0.65 * k); ctx.hemi.color.copy(sh.uSkyColor.value);
      _col.setRGB(al[0], al[1], al[2]).multiplyScalar(0.26 * luz);
      sh.uGroundColor.value.copy(b.suelo).lerp(_col, 0.5 * k); ctx.hemi.groundColor.copy(sh.uGroundColor.value);
      // Niebla (después de la del visor) y fondo del color de la arena.
      var fog = scene.fog, f0n = fog.near, f0f = fog.far;
      var d0 = S.mode === 'walk' ? 0 : camera.position.distanceTo(cam.cur.target);
      var farS = d0 + TORMENTA.VIS + (S.mode === 'walk' ? walk.fly * 0.5 : 0), nearS = d0 * 0.35 + 8;
      fog.near = f0n + (nearS - f0n) * k;
      fog.far = Math.exp(Math.log(Math.max(f0f, farS + 1)) * (1 - k) + Math.log(farS) * k);
      if (!tormenta.fondo) tormenta.fondo = new THREE.Color();
      tormenta.fondo.setRGB(ARENA_SRGB[0] * luz, ARENA_SRGB[1] * luz, ARENA_SRGB[2] * luz, THREE.NoColorSpace || undefined);
      fog.color.copy(b.niebla).lerp(tormenta.fondo, k);
      scene.background = fog.color;
      tormenta.visibilidad = fog.far;
      if (S.sky) S.sky.visible = k < 0.5;
      if (S.stars) S.stars.visible = k < 0.3;
      // Lo que queda detrás de la niebla no se dibuja.
      if (!S.xr) {
        var far = Math.max(fog.far * 1.03, camera.near * 10);
        if (far < camera.far) { camera.far = far; camera.updateProjectionMatrix(); }
        recorteTerreno(camera.far);
      }
      tormenta.far = camera.far;
      // Granos de arena alrededor de la cámara.
      var P = tormenta.arena;
      if (P) {
        P.visible = true;
        var u = P.material.uniforms;
        camera.getWorldPosition(u.uCam.value);
        u.uTime.value = (now / 1000) % 1000;
        var vv = 7 + 5 * k; u.uWind.value.set(Math.sin(rumbo) * vv, 0.4, -Math.cos(rumbo) * vv);
        u.uK.value = k; u.uColor.value.setRGB(0.62 * luz, 0.46 * luz, 0.29 * luz);
        u.uSize.value = 0.16 * (renderer().domElement.height || 600) / Math.tan(camera.fov * Math.PI / 360) * 0.5;
      }
    }
    var _col = new THREE.Color();
    function renderer() { return ctx.renderer; }
    // El terreno es UNA malla de toda la ciudad (la fina: 512 × 501 casillas,
    // 513.024 triángulos) sin descarte posible, y es la mitad de lo que se envía
    // en cualquier encuadre. Su índice va por filas de norte a sur, así que en la
    // tormenta basta un drawRange con las filas que caen dentro de camera.far:
    // una franja de lado a lado del mapa y 2·far de alto. Se deshace al acabar.
    function recorteTerreno(far) {
      var lista = [S.fine, S.coarse], i;
      camera.getWorldPosition(_v2);
      for (i = 0; i < lista.length; i++) {
        var T = lista[i]; if (!T || !T.mesh) continue;
        var g = T.mesh.geometry;
        if (far === null) { g.setDrawRange(0, Infinity); continue; }
        var j0 = clamp(Math.floor((_v2.z - far) / T.dz), 0, T.sz), j1 = clamp(Math.ceil((_v2.z + far) / T.dz), 0, T.sz);
        g.setDrawRange(j0 * T.sx * 6, Math.max(0, j1 - j0) * T.sx * 6);
      }
      tormenta.filasTerreno = far === null ? 0 : Math.ceil(2 * far / (S.fine ? S.fine.dz : 1));
    }
    function restauraTormenta() {
      tormenta.aplicada = false; tormenta.visibilidad = 0; tormenta.far = 0;
      var b = tormenta.base;
      if (b) {
        ctx.shared.uSunColor.value.copy(b.sol); ctx.shared.uSkyColor.value.copy(b.cielo); ctx.shared.uGroundColor.value.copy(b.suelo);
        ctx.sun.color.copy(b.luz); ctx.hemi.color.copy(b.hemiC); ctx.hemi.groundColor.copy(b.hemiS);
        if (b.niebla) { scene.fog.color.copy(b.niebla); scene.background = b.niebla; }
      }
      if (S.sky) S.sky.visible = true;
      if (S.stars) S.stars.visible = true;
      if (tormenta.arena) tormenta.arena.visible = false;
      recorteTerreno(null);
    }

    // =========================================================================
    // 4a. Metro elevado
    // =========================================================================
    // El viaducto va sobre la troncal que pasa más cerca del Burj Khalifa entre
    // las de más de 40 km dentro del mapa —la Sheikh Zayed Road trazada a mano
    // en el mapa, 50,4 km—, que es por donde va la línea roja de verdad. Si el
    // mapa trae una vía con nombre «Sheikh Zayed» y clase troncal (la mitad de
    // OpenStreetMap, cuando alguien la aporte), manda esa.
    //
    // Es el perfil de PERFIL barrido cada 30 m por el eje (con las esquinas del
    // trazado redondeadas por curvas de 600 m), un pilar con cabezal en cada
    // muestra y una estación con bóveda dorada cada ~1,5 km. Todo por teselas de
    // TESELA_VIA con su esfera envolvente.
    //
    // Los trenes son función del reloj: el horario sale del propio trazado
    // (tramo a tramo, trapecio de velocidad de 80 km/h y 1 m/s², 30 s de parada y
    // 3 min en las terminales), el ciclo se divide en un número entero de trenes
    // con un intervalo cercano a 6 min, y el tren k está en τ = (t − k·intervalo)
    // mod ciclo. Todo el que mire ve el mismo tren en el mismo sitio.
    var metro = { listo: false, eje: null, grupo: null, trenes: null, info: null, cercano: 1e9, dibujados: 0, triCoche: 0, teselas: [] };
    function troncal() {
      var meta = S.meta || {}, vias = meta.vias || [], i, j, geo = S.geo;
      function mundo(line) {
        var out = [];
        for (j = 0; j < line.length; j++) {
          var w = geo.toWorld(line[j][1], line[j][0]);
          if (M.insideMap(w.x, w.z)) out.push({ x: w.x, z: w.z });
        }
        return out;
      }
      function largo(p) { var L = 0; for (var k = 0; k + 1 < p.length; k++) L += Math.sqrt(Math.pow(p[k + 1].x - p[k].x, 2) + Math.pow(p[k + 1].z - p[k].z, 2)); return L; }
      for (i = 0; i < vias.length; i++) {
        if (vias[i] && vias[i].clase === 'troncal' && /zayed/i.test(vias[i].nombre || '') && vias[i].pts && vias[i].pts.length > 1) {
          var pv = mundo(vias[i].pts); if (pv.length > 1) return { pts: pv, indice: -1, largo: largo(pv), regla: 'via' };
        }
      }
      var roads = meta.roads || [], cand = [], burj = (S.lmIndex && S.lmIndex.burj_khalifa) || null;
      if (!burj) for (i = 0; i < S.landmarks.length; i++) if (!burj || S.landmarks[i].h > burj.h) burj = S.landmarks[i];
      for (i = 0; i < roads.length; i++) {
        if (!roads[i] || roads[i].length < 2) continue;
        var p = mundo(roads[i]); if (p.length < 2) continue;
        var L = largo(p), dmin = 1e18;
        if (burj) for (j = 0; j + 1 < p.length; j++) dmin = Math.min(dmin, distSeg(burj.x, burj.z, p[j], p[j + 1]));
        cand.push({ pts: p, indice: i, largo: L, dist: dmin });
      }
      var troncales = cand.filter(function (c) { return c.largo >= 40000; });
      if (troncales.length) {
        troncales.sort(function (a, b) { return a.dist - b.dist || b.largo - a.largo || a.indice - b.indice; });
        troncales[0].regla = 'burj'; return troncales[0];
      }
      cand.sort(function (a, b) { return b.largo - a.largo || a.indice - b.indice; });
      if (cand[0]) cand[0].regla = 'largo';
      return cand[0] || null;
    }
    function distSeg(x, z, a, b) {
      var dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1, u = clamp(((x - a.x) * dx + (z - a.z) * dz) / L2, 0, 1);
      var ex = a.x + dx * u - x, ez = a.z + dz * u - z; return Math.sqrt(ex * ex + ez * ez);
    }
    /** Esquinas redondeadas: una curva de Bézier cuadrática de tangente R·tan(θ/2) en cada vértice. */
    function redondea(p, R) {
      var out = [p[0]], i, k;
      for (i = 1; i + 1 < p.length; i++) {
        var a = p[i - 1], b = p[i], c = p[i + 1];
        var d1x = b.x - a.x, d1z = b.z - a.z, l1 = Math.sqrt(d1x * d1x + d1z * d1z), d2x = c.x - b.x, d2z = c.z - b.z, l2 = Math.sqrt(d2x * d2x + d2z * d2z);
        if (l1 < 1 || l2 < 1) continue;
        d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
        var th = Math.acos(clamp(d1x * d2x + d1z * d2z, -1, 1));
        if (th < 1e-3) { out.push(b); continue; }
        var Lt = Math.min(R * Math.tan(th / 2), 0.45 * l1, 0.45 * l2);
        var p1 = { x: b.x - d1x * Lt, z: b.z - d1z * Lt }, p2 = { x: b.x + d2x * Lt, z: b.z + d2z * Lt };
        for (k = 0; k <= 12; k++) {
          var u = k / 12, a1 = (1 - u) * (1 - u), a2 = 2 * u * (1 - u), a3 = u * u;
          out.push({ x: a1 * p1.x + a2 * b.x + a3 * p2.x, z: a1 * p1.z + a2 * b.z + a3 * p2.z });
        }
      }
      out.push(p[p.length - 1]);
      return out;
    }
    /** Remuestreo uniforme por longitud de arco: n tramos iguales. */
    function uniforme(p, paso) {
      var cum = [0], i;
      for (i = 1; i < p.length; i++) cum.push(cum[i - 1] + Math.sqrt(Math.pow(p[i].x - p[i - 1].x, 2) + Math.pow(p[i].z - p[i - 1].z, 2)));
      var L = cum[cum.length - 1], n = Math.max(2, Math.round(L / paso)), ds = L / n, X = new Float64Array(n + 1), Z = new Float64Array(n + 1), j = 0;
      for (i = 0; i <= n; i++) {
        var s = i * ds;
        while (j + 1 < cum.length - 1 && cum[j + 1] < s) j++;
        var seg = cum[j + 1] - cum[j] || 1, f = clamp((s - cum[j]) / seg, 0, 1);
        X[i] = p[j].x + (p[j + 1].x - p[j].x) * f; Z[i] = p[j].z + (p[j + 1].z - p[j].z) * f;
      }
      return { X: X, Z: Z, n: n, ds: ds, L: L };
    }
    /** Punto del eje a la distancia s: posición, cota del piso y tangente. */
    function ejePunto(s, out) {
      var e = metro.eje, f = clamp(s / e.ds, 0, e.n - 1e-6), i = Math.floor(f), u = f - i;
      out.x = e.X[i] + (e.X[i + 1] - e.X[i]) * u; out.z = e.Z[i] + (e.Z[i + 1] - e.Z[i]) * u; out.y = e.H[i] + (e.H[i + 1] - e.H[i]) * u;
      out.tx = e.TX[i]; out.tz = e.TZ[i];
      return out;
    }
    function construyeMetro() {
      var tr = troncal(); if (!tr) return;
      var p = redondea(tr.pts, METRO.RADIO), e = uniforme(p, METRO.PASO), n = e.n, i, j;
      e.TX = new Float64Array(n + 1); e.TZ = new Float64Array(n + 1);
      for (i = 0; i <= n; i++) {
        var a = Math.max(0, i - 1), b = Math.min(n, i + 1), dx = e.X[b] - e.X[a], dz = e.Z[b] - e.Z[a], l = Math.sqrt(dx * dx + dz * dz) || 1;
        e.TX[i] = dx / l; e.TZ[i] = dz / l;
      }
      // Cota: el suelo más alto a ±12 m del eje en una ventana de ±90 m, más el
      // gálibo; suavizada dos veces en ±120 m y nunca a menos de 8,5 m del suelo.
      var gnd = new Float64Array(n + 1), H = new Float64Array(n + 1), H2 = new Float64Array(n + 1);
      for (i = 0; i <= n; i++) {
        var rx = -e.TZ[i], rz = e.TX[i], g = -1e9;
        for (j = -12; j <= 12; j += 12) g = Math.max(g, M.groundH(e.X[i] + rx * j, e.Z[i] + rz * j));
        gnd[i] = g;
      }
      for (i = 0; i <= n; i++) { var m = -1e9; for (j = Math.max(0, i - 3); j <= Math.min(n, i + 3); j++) m = Math.max(m, gnd[j]); H[i] = m + METRO.CLARO; }
      for (var pasada = 0; pasada < 2; pasada++) {
        for (i = 0; i <= n; i++) { var sm = 0, c = 0; for (j = Math.max(0, i - 4); j <= Math.min(n, i + 4); j++) { sm += H[j]; c++; } H2[i] = sm / c; }
        for (i = 0; i <= n; i++) H[i] = Math.max(H2[i], gnd[i] + 8.5);
      }
      e.H = H; e.gnd = gnd; metro.eje = e;
      // Estaciones: n+1 paradas repartidas por igual, las terminales metidas 70 m.
      var ne = Math.max(2, Math.round(e.L / METRO.ESTACION)), paradas = [];
      for (i = 0; i <= ne; i++) paradas.push(clamp(i * e.L / ne, 70, e.L - 70));
      metro.paradas = paradas;
      // --- Geometría por teselas -------------------------------------------
      var teselas = {}, choques = 0, choqueIds = [], pilares = 0, TES = M.TESELA_VIA, lh = U.lin3(HORMIGON), lb = U.lin3(BALASTO), lc = U.lin3(CARRIL);
      function tes(x, z) { var k = Math.floor(x / TES) + ':' + Math.floor(z / TES); return teselas[k] || (teselas[k] = G.newAcc()); }
      function tri(acc, A, B, C, nx, ny, nz, col) {
        // Devanado según la normal: la cara mira hacia donde apunta (nx,ny,nz).
        var ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        var cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
        if (cx * nx + cy * ny + cz * nz < 0) { var T = B; B = C; C = T; }
        acc.pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
        for (var q = 0; q < 3; q++) { acc.nor.push(nx, ny, nz); acc.col.push(col[0], col[1], col[2]); }
      }
      function quad(acc, A, B, C, D, nx, ny, nz, col) { tri(acc, A, B, C, nx, ny, nz, col); tri(acc, A, C, D, nx, ny, nz, col); }
      function sec(i2, u, v) { var rx = -e.TZ[i2], rz = e.TX[i2]; return [e.X[i2] + rx * u, e.H[i2] + v, e.Z[i2] + rz * u]; }
      var cu = 0, cv = -0.4;       // centro del perfil, para orientar las normales hacia fuera
      for (i = 0; i < n; i++) {
        var acc = tes(e.X[i], e.Z[i]);
        for (j = 0; j < PERFIL.length; j++) {
          var p0 = PERFIL[j], p1 = PERFIL[(j + 1) % PERFIL.length];
          var A = sec(i, p0[0], p0[1]), B = sec(i, p1[0], p1[1]), C = sec(i + 1, p1[0], p1[1]), D = sec(i + 1, p0[0], p0[1]);
          // Normal: la del lado del perfil, llevada al mundo con el lateral del tramo.
          var eu = p1[0] - p0[0], ev = p1[1] - p0[1], nu = ev, nv = -eu, mu = (p0[0] + p1[0]) / 2 - cu, mv = (p0[1] + p1[1]) / 2 - cv;
          if (nu * mu + nv * mv < 0) { nu = -nu; nv = -nv; }
          var ln = Math.sqrt(nu * nu + nv * nv) || 1; nu /= ln; nv /= ln;
          var rx = -e.TZ[i], rz = e.TX[i];
          quad(acc, A, B, C, D, rx * nu, nv, rz * nu, j === 3 ? lb : lh);
        }
        // Cuatro carriles (solo la cara de arriba).
        for (j = -1; j <= 1; j += 2) for (var k2 = -1; k2 <= 1; k2 += 2) {
          var uc = j * METRO.VIA + k2 * 0.75;
          quad(acc, sec(i, uc - 0.06, 0.18), sec(i, uc + 0.06, 0.18), sec(i + 1, uc + 0.06, 0.18), sec(i + 1, uc - 0.06, 0.18), 0, 1, 0, lc);
        }
      }
      // Pilares con cabezal, uno por muestra, salvo donde hay un sólido debajo.
      var par = new THREE.Matrix4(), q = new THREE.Quaternion(), yv = new THREE.Vector3(0, 1, 0), pv = new THREE.Vector3(), sv = new THREE.Vector3(1, 1, 1);
      for (i = 0; i <= n; i++) {
        var so = ctx.catastro.bajo(e.X[i], e.Z[i]);
        if (so) { if (so.y0 + so.h > e.H[i] - 2) { choques++; if (choqueIds.indexOf(so.id) < 0) choqueIds.push(so.id); } continue; }
        var base = Math.min(M.groundH(e.X[i], e.Z[i]), S.field ? S.field.atWorld(e.X[i], e.Z[i]) : 0) - 1.5, alto = e.H[i] - 1.9 - base;
        if (alto < 1) continue;
        q.setFromAxisAngle(yv, Math.atan2(-e.TZ[i], e.TX[i])); pv.set(e.X[i], base, e.Z[i]); par.compose(pv, q, sv);
        var acP = tes(e.X[i], e.Z[i]);
        G.pushParts(acP, [
          { sx: 1.8, sy: alto - 1.2, sz: 1.8, c: HORMIGON },
          { sx: 2.2, sy: 1.2, sz: 7.4, y: alto - 1.2, c: HORMIGON }
        ], par);
        pilares++;
      }
      // Estaciones: andenes, bóveda dorada, mamparas de vidrio y torre de acceso.
      for (i = 0; i < paradas.length; i++) {
        var P = ejePunto(paradas[i], {}), yaw = Math.atan2(-P.tz, P.tx), g0 = M.groundH(P.x, P.z);
        q.setFromAxisAngle(yv, yaw); pv.set(P.x, P.y, P.z); par.compose(pv, q, sv);
        var L2 = METRO.ANDEN, dh = P.y - g0;
        G.pushParts(tes(P.x, P.z), [
          { sx: L2, sy: 2.9, sz: 3.2, y: -1.9, z: 6.3, c: HORMIGON }, { sx: L2, sy: 2.9, sz: 3.2, y: -1.9, z: -6.3, c: HORMIGON },
          { g: 'halfcyl', a: 20, sx: 11, sy: L2 + 6, sz: 18.5, x: (L2 + 6) / 2, y: 5.2, rz: Math.PI / 2, c: [0.86, 0.72, 0.46] },
          { sx: L2, sy: 4.2, sz: 0.3, y: 1, z: 8.2, c: [0.34, 0.50, 0.60] }, { sx: L2, sy: 4.2, sz: 0.3, y: 1, z: -8.2, c: [0.34, 0.50, 0.60] },
          { sx: 9, sy: dh + 5.5, sz: 7, x: L2 * 0.3, y: -dh, z: 13.5, c: [0.86, 0.84, 0.80] },
          { sx: 9, sy: 1.4, sz: 7, x: L2 * 0.3, y: 5.5, z: 13.5, c: [0.86, 0.72, 0.46] },
          { sx: 4, sy: 3.5, sz: 2.4, x: L2 * 0.3, y: 1, z: 9.1, c: [0.86, 0.84, 0.80] }
        ], par);
      }
      // Una malla por tesela, con su esfera envolvente.
      var grupo = new THREE.Group(); grupo.name = 'extras: metro';
      var mat = ctx.plainMat, clave, tri0 = 0;
      for (clave in teselas) {
        if (!Object.prototype.hasOwnProperty.call(teselas, clave)) continue;
        var geo = G.accGeometry(teselas[clave]);
        geo.boundingSphere.radius += 20;
        var mesh = new THREE.Mesh(geo, mat); mesh.name = 'metro ' + clave; mesh.castShadow = true; mesh.receiveShadow = true;
        grupo.add(mesh); metro.teselas.push(mesh); tri0 += geo.attributes.position.count / 3;
      }
      scene.add(grupo); metro.grupo = grupo;
      // --- Horario ----------------------------------------------------------
      var tramos = [], tt = 0, dir;
      function dwell(s, d) { tramos.push({ t0: tt, dur: d, s0: s, s1: s, mueve: false }); tt += d; }
      function tramo(s0, s1) { var D = Math.abs(s1 - s0), T = tiempoTramo(D); tramos.push({ t0: tt, dur: T, s0: s0, s1: s1, mueve: true, D: D }); tt += T; }
      for (dir = 0; dir < 2; dir++) {
        var ida = dir === 0;
        dwell(ida ? paradas[0] : paradas[ne], METRO.TERMINAL);
        for (i = 0; i < ne; i++) {
          var a0 = ida ? paradas[i] : paradas[ne - i], a1 = ida ? paradas[i + 1] : paradas[ne - i - 1];
          tramo(a0, a1);
          if (i + 1 < ne) dwell(a1, METRO.PARADA);
        }
        if (dir === 0) metro.mitad = tt;
      }
      metro.ciclo = tt; metro.tramos = tramos;
      metro.nTrenes = Math.max(1, Math.round(tt / METRO.INTERVALO)); metro.intervalo = tt / metro.nTrenes;
      // Tren: cinco coches instanciados.
      var coche = G.newAcc();
      G.pushParts(coche, [
        { sx: 15, sy: 0.9, sz: 2.4, y: 0.05, c: [0.16, 0.16, 0.17] },
        { sx: METRO.COCHE, sy: 2.95, sz: 2.95, y: 0.9, c: [0.88, 0.89, 0.90] },
        { sx: METRO.COCHE + 0.04, sy: 0.18, sz: 2.99, y: 1.3, c: [0.74, 0.13, 0.13] },
        { sx: METRO.COCHE - 0.8, sy: 0.95, sz: 3.0, y: 2.05, c: [0.12, 0.16, 0.22] },
        { sx: METRO.COCHE - 1, sy: 0.25, sz: 2.6, y: 3.85, c: [0.70, 0.71, 0.72] }
      ]);
      // Las cajas del catálogo van centradas en x y z: el coche lleva el origen
      // en el centro de su planta, a la altura del carril.
      var gc = G.accGeometry(coche);
      metro.triCoche = gc.attributes.position.count / 3;
      var nC = metro.nTrenes * METRO.COCHES;
      var im = new THREE.InstancedMesh(gc, ctx.plainMat, nC); im.frustumCulled = false; im.name = 'extras: trenes'; im.count = 0; im.visible = false; im.castShadow = true;
      var colT = new THREE.Color(1, 1, 1); for (i = 0; i < nC; i++) im.setColorAt(i, colT);
      im.instanceColor.needsUpdate = true;
      scene.add(im); metro.trenes = im;
      metro.info = { km: Math.round(e.L / 100) / 10, indiceVia: tr.indice, regla: tr.regla, muestras: n + 1, pilares: pilares, choques: choques, choqueIds: choqueIds.slice(0, 12), estaciones: paradas.length,
        triangulosViaducto: tri0, teselas: metro.teselas.length, trenes: metro.nTrenes, intervalo: Math.round(metro.intervalo), ciclo: Math.round(metro.ciclo) };
      metro.listo = true;
    }
    function tiempoTramo(D) {
      var v = METRO.VMAX, a = METRO.ACEL;
      return D >= v * v / a ? D / v + v / a : 2 * Math.sqrt(D / a);
    }
    function avanceTramo(D, T, tau) {
      var v = METRO.VMAX, a = METRO.ACEL;
      if (D >= v * v / a) {
        var ta = v / a, da = 0.5 * a * ta * ta;
        if (tau < ta) return 0.5 * a * tau * tau;
        if (tau < T - ta) return da + v * (tau - ta);
        return D - 0.5 * a * (T - tau) * (T - tau);
      }
      return tau < T / 2 ? 0.5 * a * tau * tau : D - 0.5 * a * (T - tau) * (T - tau);
    }
    /** Dónde está el tren k en el instante tsec: { s, dir, parado }. */
    function posTren(k, tsec) {
      var C = metro.ciclo, tau = tsec - k * metro.intervalo;
      tau = ((tau % C) + C) % C;
      var tr = metro.tramos, lo = 0, hi = tr.length - 1;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (tr[mid].t0 <= tau) lo = mid; else hi = mid - 1; }
      var x = tr[lo], dir = tau < metro.mitad ? 1 : -1;
      if (!x.mueve) return { s: x.s0, dir: dir, parado: true };
      var d = avanceTramo(x.D, x.dur, tau - x.t0);
      return { s: x.s0 + (x.s1 > x.s0 ? d : -d), dir: dir, parado: false };
    }
    var _pe = {};
    function cuadroMetro(tsec) {
      var im = metro.trenes; metro.cercano = 1e9; metro.dibujados = 0;
      if (!im) return;
      if (!Q().mover) { im.visible = false; im.count = 0; return; }
      var n = 0, k, j, lejos = Math.min(camera.far, 12000);
      for (k = 0; k < metro.nTrenes; k++) {
        var p = posTren(k, tsec);
        ejePunto(p.s, _pe);
        var dxc = _pe.x - _cp.x, dzc = _pe.z - _cp.z, dc = Math.sqrt(dxc * dxc + dzc * dzc);
        if (dc < metro.cercano) metro.cercano = Math.max(0, dc - 45);
        if (!seVe(_pe.x, _pe.y + 2, _pe.z, 50, lejos)) continue;
        for (j = 0; j < METRO.COCHES; j++) {
          var s = p.s + (j - (METRO.COCHES - 1) / 2) * METRO.PASO_COCHE;
          ejePunto(s, _pe);
          var u = METRO.VIA * p.dir, rx = -_pe.tz, rz = _pe.tx;
          dummy.position.set(_pe.x + rx * u, _pe.y + 0.25, _pe.z + rz * u);
          dummy.rotation.set(0, Math.atan2(-_pe.tz, _pe.tx) + (p.dir < 0 ? Math.PI : 0), 0);
          dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          im.setMatrixAt(n++, dummy.matrix);
        }
      }
      im.count = n; im.visible = n > 0; metro.dibujados = n;
      if (n) im.instanceMatrix.needsUpdate = true;
    }

    // =========================================================================
    // 4b. Barcos
    // =========================================================================
    // Un barco es un coche sobre agua: una posición en un lazo cerrado que
    // avanza con el reloj, s = (v·t + i·L/n) mod L. Abras que cruzan el Creek,
    // dhows que lo recorren y uno de carga por la costa de Jumeirah, y yates en
    // la Marina. Tres mallas instanciadas (una por tipo) con el descarte por
    // pirámide de visión hecho a mano: solo se escriben los que se ven.
    var barcos = { rutas: [], tipos: {}, info: null, dibujados: 0, total: 0 };
    function lazo(pts, o) {
      var n = pts.length, R = [], Lf = [], i;
      function tang(i2) { var a = pts[Math.max(0, i2 - 1)], b = pts[Math.min(n - 1, i2 + 1)], dx = b.x - a.x, dz = b.z - a.z, l = Math.sqrt(dx * dx + dz * dz) || 1; return { x: dx / l, z: dz / l }; }
      for (i = 0; i < n; i++) { var tg = tang(i); R.push({ x: pts[i].x - tg.z * o, z: pts[i].z + tg.x * o }); }
      for (i = n - 1; i >= 0; i--) { var tg2 = tang(i); Lf.push({ x: pts[i].x + tg2.z * o, z: pts[i].z - tg2.x * o }); }
      function arco(p, c) {
        var a0 = Math.atan2(p.z - c.z, p.x - c.x), out = [], k;
        for (k = 1; k < 10; k++) { var an = a0 - Math.PI * k / 10; out.push({ x: c.x + o * Math.cos(an), z: c.z + o * Math.sin(an) }); }
        return out;
      }
      var loop = R.concat(arco(R[R.length - 1], pts[n - 1]), Lf, arco(Lf[Lf.length - 1], pts[0]));
      loop.push({ x: R[0].x, z: R[0].z });
      var cum = [0];
      for (i = 1; i < loop.length; i++) cum.push(cum[i - 1] + Math.sqrt(Math.pow(loop[i].x - loop[i - 1].x, 2) + Math.pow(loop[i].z - loop[i - 1].z, 2)));
      return { pts: loop, cum: cum, L: cum[cum.length - 1] };
    }
    /** Agua visible: el máximo entre el campo de alturas y la malla que se dibuja. */
    function alturaVisible(x, z) { return Math.max(S.field ? S.field.atWorld(x, z) : 0, M.surfaceH(x, z)); }
    /** Cuenta las muestras (cada 5 m) del lazo que no tienen agua con holgura c alrededor. */
    function validaRuta(lz, c) {
      var malas = 0, total = 0, i, k, a;
      for (i = 0; i + 1 < lz.pts.length; i++) {
        var A = lz.pts[i], B = lz.pts[i + 1], L = lz.cum[i + 1] - lz.cum[i], ns = Math.max(1, Math.ceil(L / 5));
        for (k = 0; k < ns; k++) {
          var x = A.x + (B.x - A.x) * k / ns, z = A.z + (B.z - A.z) * k / ns, h = alturaVisible(x, z);
          for (a = 0; a < 8; a++) h = Math.max(h, alturaVisible(x + Math.cos(a * Math.PI / 4) * c, z + Math.sin(a * Math.PI / 4) * c));
          total++; if (h > -0.3) malas++;
        }
      }
      return { malas: malas, total: total };
    }
    function geoBarco(tipo) {
      var acc = G.newAcc(), MADERA = [0.52, 0.34, 0.19], OSCURA = [0.36, 0.22, 0.12], BLANCO = [0.94, 0.94, 0.93], VIDRIO = [0.10, 0.14, 0.20], LONA = [0.92, 0.88, 0.78];
      if (tipo === 'abra') {
        G.pushParts(acc, [
          { sx: 9, sy: 1.3, sz: 2.6, y: -0.6, c: MADERA },
          { g: 'prism3', sx: 3.0, sy: 1.3, sz: 2.2, x: 5.05, y: -0.6, ry: Math.PI / 2, c: MADERA },
          { sx: 6.6, sy: 0.4, sz: 0.9, y: 0.7, c: OSCURA },
          { sx: 7, sy: 0.14, sz: 2.8, y: 2.3, c: LONA },
          { sx: 0.12, sy: 1.6, sz: 0.12, x: -3.2, y: 0.7, z: 1.2, c: OSCURA }, { sx: 0.12, sy: 1.6, sz: 0.12, x: -3.2, y: 0.7, z: -1.2, c: OSCURA },
          { sx: 0.12, sy: 1.6, sz: 0.12, x: 3.2, y: 0.7, z: 1.2, c: OSCURA }, { sx: 0.12, sy: 1.6, sz: 0.12, x: 3.2, y: 0.7, z: -1.2, c: OSCURA }
        ]);
      } else if (tipo === 'yate') {
        G.pushParts(acc, [
          { sx: 22, sy: 2.6, sz: 6.2, x: -3, y: -0.9, c: BLANCO },
          { g: 'prism3', sx: 7.16, sy: 2.6, sz: 8, x: 10, y: -0.9, ry: Math.PI / 2, c: BLANCO },
          { sx: 13, sy: 2.2, sz: 5.0, x: -4, y: 1.7, c: BLANCO },
          { sx: 13.1, sy: 0.8, sz: 5.1, x: -4, y: 2.4, c: VIDRIO },
          { sx: 7, sy: 1.6, sz: 4.2, x: -5, y: 3.9, c: BLANCO },
          { sx: 7.1, sy: 0.55, sz: 4.3, x: -5, y: 4.4, c: VIDRIO },
          { sx: 0.3, sy: 2.2, sz: 0.3, x: -4, y: 5.5, c: [0.8, 0.8, 0.82] }
        ]);
      } else {
        G.pushParts(acc, [
          { sx: 17, sy: 2.3, sz: 5.2, x: -2, y: -0.8, c: OSCURA },
          { g: 'prism3', sx: 6.0, sy: 2.3, sz: 6, x: 8, y: -0.8, ry: Math.PI / 2, c: OSCURA },
          { sx: 4, sy: 1.5, sz: 5.2, x: -8.5, y: 1.5, c: MADERA },
          { sx: 11, sy: 0.18, sz: 5.4, x: -1.5, y: 3.4, c: LONA },
          { sx: 0.15, sy: 1.9, sz: 0.15, x: 3.5, y: 1.5, z: 2.4, c: MADERA }, { sx: 0.15, sy: 1.9, sz: 0.15, x: 3.5, y: 1.5, z: -2.4, c: MADERA },
          { sx: 0.15, sy: 1.9, sz: 0.15, x: -6, y: 1.5, z: 2.4, c: MADERA }, { sx: 0.15, sy: 1.9, sz: 0.15, x: -6, y: 1.5, z: -2.4, c: MADERA },
          { g: 'cyl', a: 8, sx: 0.4, sy: 13, sz: 0.4, x: 4.5, y: 1.5, rz: -0.12, c: MADERA }
        ]);
      }
      return G.accGeometry(acc);
    }
    function construyeBarcos() {
      var i, j, tot = 0, descartadas = 0, malas = 0, muestras = 0, porTipo = {};
      for (i = 0; i < RUTAS.length; i++) {
        var r = RUTAS[i], pts = [];
        for (j = 0; j < r.pts.length; j++) { var w = S.geo.toWorld(r.pts[j][0], r.pts[j][1]); pts.push({ x: w.x, z: w.z }); }
        var lz = lazo(pts, r.o), v = validaRuta(lz, r.c);
        muestras += v.total; malas += v.malas;
        if (v.malas > 0) { descartadas++; continue; }
        var ruta = { id: r.id, tipo: r.tipo, v: r.v, n: r.n, lz: lz, desfase: U.real01(U.semillaMorfologia(i, 97, 44)) };
        barcos.rutas.push(ruta); tot += r.n; porTipo[r.tipo] = (porTipo[r.tipo] || 0) + r.n;
      }
      var tipo;
      for (tipo in porTipo) {
        if (!Object.prototype.hasOwnProperty.call(porTipo, tipo)) continue;
        var g = geoBarco(tipo), im = new THREE.InstancedMesh(g, ctx.plainMat, porTipo[tipo]);
        im.frustumCulled = false; im.count = 0; im.visible = false; im.name = 'extras: ' + tipo; im.castShadow = true;
        var col = new THREE.Color(1, 1, 1); for (j = 0; j < porTipo[tipo]; j++) im.setColorAt(j, col);
        im.instanceColor.needsUpdate = true;
        scene.add(im);
        barcos.tipos[tipo] = { mesh: im, tri: g.attributes.position.count / 3, n: 0 };
      }
      barcos.total = tot;
      barcos.info = { rutas: barcos.rutas.length, descartadas: descartadas, barcos: tot, muestras: muestras, muestrasEnTierra: malas };
    }
    /** Posición del barco i de una ruta en el instante tsec. */
    function posBarco(ruta, i, tsec, out) {
      var lz = ruta.lz, L = lz.L, s = (ruta.v * tsec + (i / ruta.n + ruta.desfase) * L) % L;
      if (s < 0) s += L;
      var cum = lz.cum, lo = 0, hi = cum.length - 2;
      while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid - 1; }
      var A = lz.pts[lo], B = lz.pts[lo + 1], seg = cum[lo + 1] - cum[lo] || 1, u = (s - cum[lo]) / seg;
      out.x = A.x + (B.x - A.x) * u; out.z = A.z + (B.z - A.z) * u;
      var dx = B.x - A.x, dz = B.z - A.z, l = Math.sqrt(dx * dx + dz * dz) || 1;
      out.tx = dx / l; out.tz = dz / l;
      return out;
    }
    var _pb = {};
    function cuadroBarcos(tsec) {
      var tipo, T, i, j;
      for (tipo in barcos.tipos) if (Object.prototype.hasOwnProperty.call(barcos.tipos, tipo)) barcos.tipos[tipo].n = 0;
      barcos.dibujados = 0;
      if (!Q().mover) { for (tipo in barcos.tipos) if (Object.prototype.hasOwnProperty.call(barcos.tipos, tipo)) { barcos.tipos[tipo].mesh.visible = false; barcos.tipos[tipo].mesh.count = 0; } return; }
      var lejos = Math.min(camera.far, 6000);
      for (i = 0; i < barcos.rutas.length; i++) {
        var r = barcos.rutas[i]; T = barcos.tipos[r.tipo];
        for (j = 0; j < r.n; j++) {
          posBarco(r, j, tsec, _pb);
          if (!seVe(_pb.x, 2, _pb.z, 30, lejos)) continue;
          var fase = tsec * 1.3 + i * 1.7 + j * 2.3;
          dummy.position.set(_pb.x, 0.08 + 0.12 * Math.sin(fase), _pb.z);
          dummy.rotation.set(0.03 * Math.sin(fase * 0.8), Math.atan2(-_pb.tz, _pb.tx), 0.02 * Math.cos(fase));
          dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          T.mesh.setMatrixAt(T.n++, dummy.matrix);
        }
      }
      for (tipo in barcos.tipos) {
        if (!Object.prototype.hasOwnProperty.call(barcos.tipos, tipo)) continue;
        T = barcos.tipos[tipo]; T.mesh.count = T.n; T.mesh.visible = T.n > 0; barcos.dibujados += T.n;
        if (T.n) T.mesh.instanceMatrix.needsUpdate = true;
      }
    }

    // =========================================================================
    // Presupuesto: lo que el módulo envió en el último cuadro
    // =========================================================================
    var gasto = { triangulos: 0, llamadas: 0 };
    function mideGasto() {
      var tri = 0, ll = 0, i, tipo;
      for (i = 0; i < metro.teselas.length; i++) {
        var m = metro.teselas[i], gs = m.geometry.boundingSphere;
        if (!m.visible || !metro.grupo.visible) continue;
        if (!seVe(gs.center.x, gs.center.y, gs.center.z, gs.radius, camera.far)) continue;
        tri += m.geometry.attributes.position.count / 3; ll++;
      }
      if (metro.trenes && metro.trenes.visible && metro.trenes.count) { tri += metro.trenes.count * metro.triCoche; ll++; }
      for (tipo in barcos.tipos) if (Object.prototype.hasOwnProperty.call(barcos.tipos, tipo)) { var T = barcos.tipos[tipo]; if (T.mesh.visible && T.n) { tri += T.n * T.tri; ll++; } }
      if (tormenta.arena && tormenta.arena.visible) ll++;
      gasto.triangulos = tri; gasto.llamadas = ll;
    }

    // =========================================================================
    // Ganchos
    // =========================================================================
    creaInterfaz();
    return {
      listo: function () {
        construyeMetro();
        construyeBarcos();
        creaArena(Q().arena);
      },
      cuadro: function (dt, now) {
        if (!S.ready) return;
        var tsec = ahora();
        cuadroTormenta(dt, now);          // después de la niebla del visor
        cuadroFoto(dt);
        actualizaFrustum();
        cuadroMetro(tsec);
        cuadroBarcos(tsec);
        actualizaSonido(dt);
        if ((S.frame & 31) === 0) pintaBotones();
      },
      trasPintar: function () {
        mideGasto();
        if (foto.activo && foto.pendiente) capturaFoto();
      },
      tecla: function (k, e, abajo) {
        if (abajo && foto.activo && k === 'escape') { saleFoto(); return true; }
        return false;
      },
      sol: function (info) { guardaBaseSol(info); },
      calidad: function () { creaArena(Q().arena); },
      modo: function () { pintaBotones(); },
      vr: function (activo) { if (activo && foto.activo) saleFoto(); },
      estadisticas: function (o) {
        var p = proximasTormentas(1)[0];
        o.extras = {
          metro: metro.info ? copia(metro.info, { cochesDibujados: metro.dibujados }) : null,
          barcos: barcos.info ? copia(barcos.info, { dibujados: barcos.dibujados }) : null,
          tormenta: { intensidad: Math.round(tormenta.k * 100) / 100, forzada: tormenta.forzada, visibilidad: Math.round(tormenta.visibilidad), far: Math.round(tormenta.far), filasTerreno: tormenta.filasTerreno || 0, proxima: p ? fechaDubai(p.ini) + '–' + horaDubai(p.fin) : null },
          foto: { activo: foto.activo, focal: Math.round(foto.focal), fov: Math.round(camera.fov * 10) / 10, nivel: foto.nivel, travelling: foto.travelling, capturas: foto.capturas },
          sonido: { activo: !!snd.activo, estado: snd.ac ? snd.ac.state : 'sin crear', nodos: snd.nodos },
          triangulos: gasto.triangulos, llamadas: gasto.llamadas
        };
      },
      soltar: function () {
        global.clearInterval(vigia);
        if (doc) { doc.removeEventListener('visibilitychange', visibilidad); doc.removeEventListener('pointerdown', primerGesto, true); doc.removeEventListener('keydown', primerGesto, true); }
        if (snd.ac) { try { snd.ac.close(); } catch (e) { /* nada */ } snd.ac = null; }
        if (ui.barra && ui.barra.parentNode) ui.barra.parentNode.removeChild(ui.barra);
        if (ui.foto && ui.foto.parentNode) ui.foto.parentNode.removeChild(ui.foto);
        if (ctx.servicios.sonido && ctx.servicios.sonido.play) ctx.servicios.sonido = null;
      },
      publico: {
        version: 1,
        /** Desplaza el reloj del módulo (ms; null = reloj real). Solo para pruebas. */
        reloj: function (ms, congelado) {
          fijo = null; desfase = ms === null || ms === undefined ? 0 : Number(ms) - Date.now();
          if (congelado && ms !== null && ms !== undefined) fijo = Number(ms) / 1000;
          return ahora();
        },
        /** true = tormenta a mano, false = sin tormenta aunque toque, null = calendario. */
        tormenta: function (v) { if (v !== undefined) { tormenta.forzada = v; if (v === true) tormenta.kMano = 1; if (v !== true) tormenta.kMano = 0; pintaBotones(); } return tormenta.k; },
        calendario: function (n, desdeSeg) { return proximasTormentas(n || 5, desdeSeg).map(function (x) { return { dia: x.dia, inicio: fechaDubai(x.ini), fin: horaDubai(x.fin), rumbo: x.rumbo }; }); },
        tormentaDelDia: tormentaDelDia,
        metro: function () { return metro.info; },
        tren: function (k, tsec) { if (!metro.listo) return null; var p = posTren(k, tsec === undefined ? ahora() : tsec), e = ejePunto(p.s, {}); return { s: p.s, dir: p.dir, parado: p.parado, x: e.x, y: e.y, z: e.z, tx: e.tx, tz: e.tz }; },
        estacion: function (i) { if (!metro.listo) return null; var e = ejePunto(metro.paradas[i], {}); return { s: metro.paradas[i], x: e.x, y: e.y, z: e.z, tx: e.tx, tz: e.tz, suelo: M.groundH(e.x, e.z) }; },
        barcos: function (tsec) {
          var out = [], i, j, tt = tsec === undefined ? ahora() : tsec;
          for (i = 0; i < barcos.rutas.length; i++) for (j = 0; j < barcos.rutas[i].n; j++) {
            var p = posBarco(barcos.rutas[i], j, tt, {});
            out.push({ ruta: barcos.rutas[i].id, tipo: barcos.rutas[i].tipo, i: j, x: p.x, z: p.z, tx: p.tx, tz: p.tz, h: alturaVisible(p.x, p.z), suelo: M.groundH(p.x, p.z) });
          }
          return out;
        },
        rutas: function () { return barcos.info; },
        foto: { entra: function () { entraFoto(); return foto.activo; }, sale: function () { saleFoto(); return !foto.activo; }, focal: function (mm) { if (mm) foto.focal = clamp(mm, 14, 200); return foto.focal; }, nivel: function (v) { foto.nivel = !!v; if (!v) camera.clearViewOffset(); return foto.nivel; }, travelling: function (v) { foto.travelling = !!v; return v; }, guardar: function () { foto.pendiente = true; return true; }, estado: function () { return { activo: foto.activo, capturas: foto.capturas, ultima: foto.ultima }; } },
        sonido: function () { return { activo: !!snd.activo, estado: snd.ac ? snd.ac.state : null, nodos: snd.nodos, volumen: snd.volumen, pasos: snd.pasoN }; },
        gasto: function () { return { triangulos: gasto.triangulos, llamadas: gasto.llamadas }; }
      }
    };
  });
})(typeof window !== 'undefined' ? window : this);
