/*
 * Dubái RAMI — módulo «espejismo»: el acabado de imagen.
 *
 * Entrega 7 del plan del metaverso (ESPEJISMO recortado). Aquí va el
 * posproceso: oclusión ambiental de pantalla, resplandor corto y curva de color.
 * Los interiores por paralaje van en el sombreador de edificios del núcleo
 * (BUILD_FS, `interiorSala`) y las cascadas de sombra en updateShadowFrame, porque
 * tocan materiales y luces que el núcleo crea antes que los módulos.
 *
 * Cómo se dibuja un cuadro (gancho `pintar`, fuera de VR):
 *
 *   1. La escena, a un destino intermedio del tamaño del lienzo con
 *      multimuestreo (WebGL2) y textura de profundidad.
 *   2. SSAO a media resolución (o entera en ultra) desde esa profundidad, con
 *      8–16 muestras en la semiesfera de la normal, y un desenfoque bilateral
 *      en dos pasadas que no cruza bordes de profundidad.
 *   3. Resplandor: umbral suave a media resolución y 3–4 niveles de reducción,
 *      vueltos a subir sumando cada nivel sobre el anterior.
 *   4. El pase final al lienzo: oclusión (que se apaga con la niebla),
 *      resplandor y la curva de color de cine.
 *
 * El problema serio, y cómo se resuelve. three r150, al dibujar a un destino que
 * no es el lienzo, compila los materiales con salida LINEAL (sin codificación
 * sRGB), y los materiales del visor mezclan la niebla DESPUÉS del tono y la
 * codificación, con un color de niebla ya pasado por esa curva (updateSun). Con
 * un destino normal la escena saldría oscura y con la niebla desplazada. En
 * r150 el tono ACES sí se aplica fuera del lienzo; lo que falta es la
 * codificación. La salida: el destino se marca como de XR (`isXRRenderTarget`)
 * con la textura en sRGB. Para ese caso three usa la codificación de la textura
 * del destino, así que cada material compila EXACTAMENTE el mismo programa que
 * para el lienzo —tono, sRGB y niebla después, en el mismo orden— y ni siquiera
 * se recompila nada al activar o quitar el posproceso. Para que el hardware no
 * codifique otra vez al escribir, el formato interno se fuerza a RGBA8 (con sRGB
 * three pediría SRGB8_ALPHA8): la textura guarda los bytes que habría recibido
 * el lienzo. El pase final los lee, trabaja en lineal y vuelve a sRGB. Con los
 * tres efectos a cero la imagen coincide con la directa: está medido en
 * notas/espejismo.md.
 *
 * La profundidad. El visor monta con búfer logarítmico salvo que se pida el
 * lineal (ctx.profundidad()). Con el logarítmico three escribe
 * gl_FragDepth = log2(1 + w) / log2(lejano + 1), con w la distancia a lo largo
 * de la vista; se invierte tal cual: w = 2^(d · log2(lejano + 1)) − 1. Con el
 * lineal es la perspectiva de siempre, con los planos del cuadro.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('espejismo', function (ctx) {
    var THREE = ctx.THREE, renderer = ctx.renderer, scene = ctx.scene, camera = ctx.camera, S = ctx.S;
    var gl2 = !!(renderer.capabilities && renderer.capabilities.isWebGL2);

    // Intensidades de cada efecto a 1. `ajuste` las multiplica (las pruebas las
    // ponen a 0 para el pase neutro).
    var FUERZA_AO = 0.9, RESPLANDOR = 0.55, UMBRAL = 0.70, RODILLA = 0.2;
    var P = ctx.Q().post || null;
    var ajuste = { activo: true, ao: 1, resplandor: 1, curva: 1, verAO: 0 };
    var T = null;                       // destinos del tamaño actual
    var cuenta = { llamadas: 0, triangulos: 0, cuadros: 0 };
    var _tam = new THREE.Vector2(), _niebla = new THREE.Color(), _fondo = new THREE.Color();

    // --- Un triángulo que cubre la pantalla ---------------------------------------
    var cuadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var cuadEsc = new THREE.Scene();
    var cuadGeo = new THREE.BufferGeometry();
    cuadGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    var cuad = new THREE.Mesh(cuadGeo, new THREE.MeshBasicMaterial());
    cuad.frustumCulled = false; cuadEsc.add(cuad);

    var VS = 'varying vec2 vUv;\nvoid main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    // Distancia a lo largo de la vista, en metros, desde el valor del búfer.
    var GLSL_PROF = [
      'uniform float uLog, uLogF, uNear, uFar;',
      'float distVista(float d){',
      '  if (uLog > 0.5) return exp2(d * uLogF) - 1.0;',
      '  return uNear * uFar / (uFar - d * (uFar - uNear));',
      '}'].join('\n');
    var GLSL_SRGB = [
      'vec3 aLin(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }',
      'vec3 aSrgb(vec3 c){ return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }'].join('\n');
    function unifProf() { return { uLog: { value: 1 }, uLogF: { value: 20 }, uNear: { value: 1 }, uFar: { value: 1000 } }; }
    function mat(frag, uniforms, defines, extra) {
      var m = new THREE.ShaderMaterial({ uniforms: uniforms, vertexShader: VS, fragmentShader: frag, defines: defines || {},
        depthTest: false, depthWrite: false, fog: false, lights: false, toneMapped: false });
      if (extra) for (var k in extra) m[k] = extra[k];
      return m;
    }

    // --- SSAO ---------------------------------------------------------------------
    // Núcleo fijo (no aleatorio: el mismo en todas las máquinas y en cada cuadro):
    // puntos en espiral de ángulo áureo sobre el disco, subidos a la semiesfera
    // —más densos hacia la normal— y más cerca del centro los primeros.
    function nucleo(n) {
      var out = [], i;
      for (i = 0; i < 16; i++) {
        var k = Math.min(i, n - 1), r = Math.sqrt((k + 0.5) / n), a = k * 2.399963, z = Math.max(Math.sqrt(1 - r * r), 0.15);
        var e = 0.15 + 0.85 * ((k + 1) / n) * ((k + 1) / n), l = Math.sqrt(r * r + z * z);
        out.push(new THREE.Vector3(r * Math.cos(a) / l * e, r * Math.sin(a) / l * e, z / l * e));
      }
      return out;
    }
    var AO_FS = [
      GLSL_PROF,
      'uniform sampler2D tProf; uniform vec2 uTexel; uniform vec4 uProy; uniform mat4 uProjM; uniform vec3 uNucleo[16]; uniform float uRadio;',
      'varying vec2 vUv;',
      'vec3 posVista(vec2 uv, float z){ vec2 ndc = uv * 2.0 - 1.0; return vec3((ndc.x + uProy.z) * z / uProy.x, (ndc.y + uProy.w) * z / uProy.y, -z); }',
      'vec3 posEn(vec2 uv){ return posVista(uv, distVista(texture2D(tProf, uv).r)); }',
      'void main(){',
      // El centro de un píxel de media resolución cae justo en la arista entre dos
      // texels de la profundidad entera, y la lectura sin filtro redondea a uno u
      // otro según la fila: en las filas donde el píxel y su vecino caían en el
      // mismo texel, la normal salía nula y el suelo liso se ocluía en una raya de
      // lado a lado (medido: 25 % más oscura, siempre en las mismas filas de
      // pantalla). Se lee siempre en el centro de un texel de la profundidad.
      '  vec2 uv0 = (floor(vUv / uTexel) + 0.5) * uTexel;',
      '  float d = texture2D(tProf, uv0).r;',
      '  if (d >= 0.99999) { gl_FragColor = vec4(1.0); return; }',
      '  float z = distVista(d);',
      '  vec3 p = posVista(uv0, z);',
      // La normal, de la profundidad: en cada eje, el vecino más parecido en z,
      // para que el borde de una torre contra el cielo no la tuerza.
      '  vec2 dx = vec2(uTexel.x, 0.0), dy = vec2(0.0, uTexel.y);',
      '  vec3 pr = posEn(uv0 + dx), pl = posEn(uv0 - dx), pu = posEn(uv0 + dy), pd = posEn(uv0 - dy);',
      '  vec3 ex = abs(pr.z - p.z) < abs(p.z - pl.z) ? pr - p : p - pl;',
      '  vec3 ey = abs(pu.z - p.z) < abs(p.z - pd.z) ? pu - p : p - pd;',
      '  vec3 n = normalize(cross(ex, ey));',
      '  if (dot(n, p) > 0.0) n = -n;',
      // Giro por píxel (ruido de gradiente entrelazado): el desenfoque lo borra.
      '  float ang = 6.2831853 * fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
      '  vec3 rv = vec3(cos(ang), sin(ang), 0.0);',
      '  vec3 t = normalize(rv - n * dot(rv, n)); vec3 b = cross(n, t);',
      // Radio en metros que crece con la distancia: 1,5 m en la acera (esquinas,
      // bajo las marquesinas), unos 16 m a un kilómetro (el pie de las torres).
      '  float R = clamp(1.5 + z * 0.015, 1.5, 30.0) * uRadio;',
      '  float occ = 0.0;',
      '  for (int i = 0; i < N_MUESTRAS; i++) {',
      '    vec3 k = uNucleo[i];',
      '    vec3 s = p + (t * k.x + b * k.y + n * k.z) * R;',
      '    vec4 c = uProjM * vec4(s, 1.0);',
      '    vec2 uv = c.xy / c.w * 0.5 + 0.5;',
      '    float zs = distVista(texture2D(tProf, uv).r);',
      // El margen crece con la distancia: a ras de suelo y de lejos la normal
      // sacada de la profundidad se tuerce y el suelo se ocluiría a sí mismo.
      '    float delante = step(zs, -s.z - R * 0.06 - z * 0.0015);',
      '    float rango = smoothstep(0.0, 1.0, R / max(abs(z - zs), 1e-3));',
      '    occ += delante * rango;',
      '  }',
      '  float ao = 1.0 - occ / float(N_MUESTRAS);',
      '  gl_FragColor = vec4(ao, ao, ao, 1.0);',
      '}'].join('\n');
    var BLUR_FS = [
      GLSL_PROF,
      'uniform sampler2D tAO, tProf; uniform vec2 uPaso;',
      'varying vec2 vUv;',
      'void main(){',
      '  float z0 = distVista(texture2D(tProf, vUv).r);',
      '  float suma = 0.0, peso = 0.0;',
      '  for (int i = -3; i <= 3; i++) {',
      '    vec2 uv = vUv + uPaso * float(i);',
      '    float z = distVista(texture2D(tProf, uv).r);',
      '    float w = (1.0 - abs(float(i)) * 0.22) * max(0.0, 1.0 - abs(z - z0) / (0.04 * z0 + 0.3));',
      '    suma += texture2D(tAO, uv).r * w; peso += w;',
      '  }',
      '  float ao = peso > 1e-4 ? suma / peso : texture2D(tAO, vUv).r;',
      '  gl_FragColor = vec4(ao, ao, ao, 1.0);',
      '}'].join('\n');

    // --- Resplandor ---------------------------------------------------------------
    // Umbral suave en lineal de pantalla (lo que ya salió del tono ACES): pasan
    // los brillos del sol en el vidrio, las ventanas encendidas y los rótulos.
    // El cielo no: con la calima de Dubái es casi blanco a mediodía y, si
    // entrara, todo el cuadro quedaría velado; se reconoce porque no escribe
    // profundidad. Cuatro lecturas bilineales cubren 4×4 píxeles: un píxel suelto
    // no parpadea de un cuadro a otro.
    var UMBRAL_FS = [
      GLSL_SRGB,
      'uniform sampler2D tColor, tProf; uniform vec2 uTexel; uniform float uUmbral, uRodilla;',
      'varying vec2 vUv;',
      'vec3 toma(vec2 uv){ return aLin(texture2D(tColor, uv).rgb) * step(texture2D(tProf, uv).r, 0.99999); }',
      'void main(){',
      '  vec3 c = toma(vUv + uTexel * vec2(-1.0, -1.0)) + toma(vUv + uTexel * vec2(1.0, -1.0))',
      '         + toma(vUv + uTexel * vec2(-1.0, 1.0)) + toma(vUv + uTexel * vec2(1.0, 1.0));',
      '  c *= 0.25;',
      '  float l = max(c.r, max(c.g, c.b));',
      '  float k = clamp(l - uUmbral + uRodilla, 0.0, 2.0 * uRodilla); k = k * k / (4.0 * uRodilla + 1e-4);',
      '  gl_FragColor = vec4(c * (max(k, l - uUmbral) / max(l, 1e-4)), 1.0);',
      '}'].join('\n');
    // Reducción y ampliación del «filtro dual»: cinco y ocho lecturas por píxel.
    var BAJA_FS = [
      'uniform sampler2D tFuente; uniform vec2 uTexel;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec3 s = texture2D(tFuente, vUv).rgb * 4.0;',
      '  s += texture2D(tFuente, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(1.0, -1.0)).rgb;',
      '  s += texture2D(tFuente, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(1.0, 1.0)).rgb;',
      '  gl_FragColor = vec4(s * 0.125, 1.0);',
      '}'].join('\n');
    var SUBE_FS = [
      'uniform sampler2D tFuente; uniform vec2 uTexel;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec3 s = texture2D(tFuente, vUv + uTexel * vec2(-2.0, 0.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(2.0, 0.0)).rgb;',
      '  s += texture2D(tFuente, vUv + uTexel * vec2(0.0, -2.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(0.0, 2.0)).rgb;',
      '  s += (texture2D(tFuente, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(1.0, -1.0)).rgb',
      '      + texture2D(tFuente, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tFuente, vUv + uTexel * vec2(1.0, 1.0)).rgb) * 2.0;',
      '  gl_FragColor = vec4(s / 12.0, 1.0);',
      '}'].join('\n');

    // --- Pase final ---------------------------------------------------------------
    // Curva de cine, suave y en el espacio de pantalla (sRGB): una S de contraste
    // al 22 %, un 10 % más de saturación, sombras hacia el azul y luces hacia el
    // ámbar, y un tramado de medio escalón que deshace las bandas del cielo. Con
    // los tres efectos a 0 el pase es la identidad (sRGB → lineal → sRGB).
    var FINAL_FS = [
      GLSL_PROF, GLSL_SRGB,
      'uniform sampler2D tColor, tAO, tBrillo, tProf;',
      'uniform float uAO, uResplandor, uCurva, uNieblaCerca, uNieblaLejos, uVerAO;',
      'varying vec2 vUv;',
      'void main(){',
      '  vec3 c = aLin(texture2D(tColor, vUv).rgb);',
      '  if (uAO > 0.0) {',
      '    float d = texture2D(tProf, vUv).r;',
      // La niebla ya está mezclada en el color: la oclusión se apaga con ella, o
      // oscurecería la calima del horizonte.
      '    float niebla = smoothstep(uNieblaCerca, uNieblaLejos, distVista(d));',
      '    c *= mix(1.0, texture2D(tAO, vUv).r, uAO * (1.0 - niebla) * step(d, 0.99999));',
      '  }',
      '  if (uResplandor > 0.0) c += texture2D(tBrillo, vUv).rgb * uResplandor;',
      '  vec3 p = aSrgb(clamp(c, 0.0, 1.0));',
      '  if (uCurva > 0.0) {',
      '    float l = dot(p, vec3(0.2126, 0.7152, 0.0722));',
      '    p = mix(p, p * p * (3.0 - 2.0 * p), 0.22 * uCurva);',
      '    float l2 = dot(p, vec3(0.2126, 0.7152, 0.0722));',
      '    p = mix(vec3(l2), p, 1.0 + 0.10 * uCurva);',
      '    p += uCurva * (vec3(-0.010, 0.002, 0.016) * (1.0 - smoothstep(0.0, 0.45, l)) + vec3(0.012, 0.004, -0.008) * smoothstep(0.55, 1.0, l));',
      '    p += uCurva * (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;',
      '  }',
      // Para las pruebas y las notas: la máscara de oclusión sola, en grises.
      '  if (uVerAO > 0.5) p = vec3(texture2D(tAO, vUv).r);',
      '  gl_FragColor = vec4(clamp(p, 0.0, 1.0), 1.0);',
      '}'].join('\n');

    var U = {
      ao: THREE.UniformsUtils.merge([unifProf(), { tProf: { value: null }, uTexel: { value: new THREE.Vector2() }, uProy: { value: new THREE.Vector4() },
        uProjM: { value: new THREE.Matrix4() }, uNucleo: { value: nucleo(12) }, uRadio: { value: 1 } }]),
      blur: THREE.UniformsUtils.merge([unifProf(), { tAO: { value: null }, tProf: { value: null }, uPaso: { value: new THREE.Vector2() } }]),
      umbral: { tColor: { value: null }, tProf: { value: null }, uTexel: { value: new THREE.Vector2() }, uUmbral: { value: UMBRAL }, uRodilla: { value: RODILLA } },
      baja: { tFuente: { value: null }, uTexel: { value: new THREE.Vector2() } },
      sube: { tFuente: { value: null }, uTexel: { value: new THREE.Vector2() } },
      fin: THREE.UniformsUtils.merge([unifProf(), { tColor: { value: null }, tAO: { value: null }, tBrillo: { value: null }, tProf: { value: null },
        uAO: { value: 0 }, uResplandor: { value: 0 }, uCurva: { value: 0 }, uNieblaCerca: { value: 1000 }, uNieblaLejos: { value: 100000 }, uVerAO: { value: 0 } }])
    };
    var M = {
      ao: null,
      blur: mat(BLUR_FS, U.blur),
      umbral: mat(UMBRAL_FS, U.umbral),
      baja: mat(BAJA_FS, U.baja),
      sube: mat(SUBE_FS, U.sube, null, { transparent: true, blending: THREE.AdditiveBlending }),
      fin: mat(FINAL_FS, U.fin)
    };
    // El número de muestras es una constante del sombreador (el bucle se desenrolla):
    // cambiarlo pide otro programa, así que el material se rehace solo al cambiar de calidad.
    function hazMatAO(n) {
      if (M.ao && M.ao.defines.N_MUESTRAS === n) return;
      if (M.ao) M.ao.dispose();
      U.ao.uNucleo.value = nucleo(n);
      M.ao = mat(AO_FS, U.ao, { N_MUESTRAS: n });
    }

    function suelta() {
      if (!T) return;
      T.escena.depthTexture.dispose(); T.escena.dispose();
      if (T.ao1) { T.ao1.dispose(); T.ao2.dispose(); }
      for (var i = 0; i < T.niveles.length; i++) T.niveles[i].dispose();
      T = null;
    }
    function destino(w, h) {
      return new THREE.WebGLRenderTarget(w, h, { depthBuffer: false, stencilBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    }
    /**
     * Los destinos del tamaño del lienzo y de la calidad. Los ganchos `tamano` y
     * `calidad` los sueltan y aquí se rehacen en el primer cuadro que los pide; la
     * comparación con el búfer de dibujo cubre además lo que cambia el tamaño sin
     * pasar por resize (la salida de las gafas devuelve el lienzo a su tamaño).
     */
    function asegura() {
      renderer.getDrawingBufferSize(_tam);
      var w = Math.max(1, _tam.x | 0), h = Math.max(1, _tam.y | 0);
      if (T && T.w === w && T.h === h) return;
      var nAO = P.ssao | 0, eAO = P.escalaAO || 0.5, nB = P.resplandor | 0, ms = gl2 ? (P.msaa | 0) : 0;
      suelta();
      var prof = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
      var esc = new THREE.WebGLRenderTarget(w, h, { samples: ms, depthTexture: prof, depthBuffer: true, stencilBuffer: false,
        minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, encoding: THREE.sRGBEncoding, internalFormat: 'RGBA8' });
      // Ver la cabecera: con esto los materiales compilan como para el lienzo
      // (tono, sRGB y niebla en ese orden) y el destino guarda los mismos bytes.
      esc.isXRRenderTarget = true;
      T = { w: w, h: h, escena: esc, ao1: null, ao2: null, niveles: [] };
      if (nAO > 0) {
        var wa = Math.max(1, Math.round(w * eAO)), ha = Math.max(1, Math.round(h * eAO));
        T.ao1 = destino(wa, ha); T.ao2 = destino(wa, ha); T.wa = wa; T.ha = ha;
        hazMatAO(nAO);
      }
      for (var i = 0; i < nB; i++) T.niveles.push(destino(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1))));
    }
    function pasa(m, dest) { cuad.material = m; renderer.setRenderTarget(dest); renderer.render(cuadEsc, cuadCam); }
    function unifProfDe(u) {
      u.uLog.value = ctx.profundidad() === 'lineal' ? 0 : 1;
      u.uLogF.value = Math.log(camera.far + 1) / Math.LN2;
      u.uNear.value = camera.near; u.uFar.value = camera.far;
    }
    function fuerzas() {
      return { ao: (P && P.ssao ? FUERZA_AO : 0) * ajuste.ao, resplandor: (P && P.resplandor ? RESPLANDOR : 0) * ajuste.resplandor, curva: (P && P.curva ? P.curva : 0) * ajuste.curva };
    }
    function activo() {
      return !!(P && ajuste.activo && gl2 && !S.xr);
    }

    /** El cuadro entero; devuelve false (y dibuja el núcleo) si no toca posproceso. */
    function pintar() {
      if (!activo()) return false;
      asegura();
      var info = renderer.info, autoInfo = info.autoReset, autoClear = renderer.autoClear, f = fuerzas(), i;
      // 1. La escena. El contador se reinicia dentro, tras la pasada de sombra,
      // como siempre: los triángulos y llamadas de la escena son comparables con
      // los de antes. Lo del posproceso se suma encima.
      // three convierte el color de la niebla y el de fondo de «espacio de
      // trabajo» a sRGB al subirlos SOLO cuando se dibuja al lienzo (con
      // ColorManagement activo, como lo deja el visor); a cualquier destino, no.
      // updateSun ya los da en sRGB de pantalla, así que en el lienzo acaban
      // codificados dos veces (más claros: 246 frente a 234 en la calima del
      // horizonte). Para que el posproceso sea exactamente la imagen de siempre,
      // se les aplica aquí esa misma conversión mientras se dibuja la escena.
      var niebla = scene.fog ? scene.fog.color : null, fondo = scene.background && scene.background.isColor ? scene.background : null;
      if (niebla) { _niebla.copy(niebla); niebla.convertLinearToSRGB(); }
      if (fondo && fondo !== niebla) { _fondo.copy(fondo); fondo.convertLinearToSRGB(); }
      renderer.setRenderTarget(T.escena);
      try { renderer.render(scene, camera); } finally {
        if (niebla) niebla.copy(_niebla);
        if (fondo && fondo !== niebla) fondo.copy(_fondo);
      }
      var c0 = info.render.calls, t0 = info.render.triangles;
      info.autoReset = false; renderer.autoClear = false;
      try {
        var prof = T.escena.depthTexture;
        // 2. Oclusión ambiental.
        if (T.ao1 && f.ao > 0) {
          var pe = camera.projectionMatrix.elements;
          unifProfDe(U.ao); U.ao.tProf.value = prof;
          U.ao.uTexel.value.set(1 / T.w, 1 / T.h); U.ao.uProy.value.set(pe[0], pe[5], pe[8], pe[9]); U.ao.uProjM.value.copy(camera.projectionMatrix);
          pasa(M.ao, T.ao1);
          unifProfDe(U.blur); U.blur.tProf.value = prof;
          U.blur.tAO.value = T.ao1.texture; U.blur.uPaso.value.set(1 / T.wa, 0); pasa(M.blur, T.ao2);
          U.blur.tAO.value = T.ao2.texture; U.blur.uPaso.value.set(0, 1 / T.ha); pasa(M.blur, T.ao1);
        }
        // 3. Resplandor.
        var nB = T.niveles.length;
        if (nB && f.resplandor > 0) {
          U.umbral.tColor.value = T.escena.texture; U.umbral.tProf.value = prof; U.umbral.uTexel.value.set(1 / T.w, 1 / T.h);
          pasa(M.umbral, T.niveles[0]);
          for (i = 1; i < nB; i++) {
            U.baja.tFuente.value = T.niveles[i - 1].texture; U.baja.uTexel.value.set(1 / T.niveles[i - 1].width, 1 / T.niveles[i - 1].height);
            pasa(M.baja, T.niveles[i]);
          }
          for (i = nB - 2; i >= 0; i--) {
            U.sube.tFuente.value = T.niveles[i + 1].texture; U.sube.uTexel.value.set(1 / T.niveles[i + 1].width, 1 / T.niveles[i + 1].height);
            pasa(M.sube, T.niveles[i]);
          }
        }
        // 4. Al lienzo.
        unifProfDe(U.fin);
        U.fin.tColor.value = T.escena.texture; U.fin.tProf.value = prof;
        U.fin.tAO.value = T.ao1 ? T.ao1.texture : null; U.fin.tBrillo.value = nB ? T.niveles[0].texture : null;
        U.fin.uAO.value = T.ao1 ? f.ao : 0;
        U.fin.uResplandor.value = nB ? f.resplandor / nB : 0;
        U.fin.uCurva.value = f.curva; U.fin.uVerAO.value = T.ao1 && ajuste.verAO ? 1 : 0;
        U.fin.uNieblaCerca.value = scene.fog ? scene.fog.near : 1e9; U.fin.uNieblaLejos.value = scene.fog ? scene.fog.far : 2e9;
        pasa(M.fin, null);
      } finally {
        info.autoReset = autoInfo; renderer.autoClear = autoClear;
        renderer.setRenderTarget(null);
      }
      cuenta.llamadas = info.render.calls - c0; cuenta.triangulos = info.render.triangles - t0; cuenta.cuadros++;
      return true;
    }
    function efectos() {
      if (!activo()) return [];
      var f = fuerzas(), l = [];
      if (f.curva > 0) l.push('curva de color');
      if (f.resplandor > 0) l.push('resplandor');
      if (f.ao > 0) l.push('oclusión ambiental');
      return l;
    }

    return {
      pintar: pintar,
      calidad: function (nombre, Q) { P = Q.post || null; suelta(); },
      // El lienzo cambió de tamaño: los destinos se rehacen en el próximo cuadro.
      tamano: function () { suelta(); },
      estadisticas: function (o) {
        o.espejismo = { activo: activo(), efectos: efectos(), llamadas: activo() ? cuenta.llamadas : 0, triangulos: activo() ? cuenta.triangulos : 0,
          ancho: T ? T.w : 0, alto: T ? T.h : 0, muestrasAO: P ? (P.ssao | 0) : 0, niveles: P ? (P.resplandor | 0) : 0, msaa: gl2 && P ? (P.msaa | 0) : 0 };
      },
      soltar: function () {
        suelta();
        for (var k in M) if (M[k]) M[k].dispose();
        cuadGeo.dispose();
      },
      publico: {
        version: 1,
        /** Pruebas: { activo, ao, resplandor, curva } multiplican lo de la calidad (lo que falta, a 1); `verAO: 1` pinta la máscara de oclusión; sin argumento, todo de vuelta. */
        ajusta: function (o) {
          ajuste = { activo: true, ao: 1, resplandor: 1, curva: 1, verAO: 0 };
          for (var k in (o || {})) if (Object.prototype.hasOwnProperty.call(ajuste, k)) ajuste[k] = k === 'activo' ? !!o[k] : Number(o[k]);
          return ajuste;
        },
        /** Pruebas: un cuadro por el camino del posproceso, sin avanzar la simulación. */
        pinta: function () { return pintar(); },
        estado: function () { return { activo: activo(), efectos: efectos(), post: P, ajuste: ajuste, llamadas: cuenta.llamadas, triangulos: cuenta.triangulos, destino: T ? [T.w, T.h] : null }; }
      }
    };
  });
})(typeof window !== 'undefined' ? window : this);
