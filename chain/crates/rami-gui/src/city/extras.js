/*
 * Dubái RAMI — módulo «extras»: sonido, foto, tiempo, metro y barcos.
 *
 * Secciones 6 y 7 del plan del metaverso: sonido sintetizado, modo foto,
 * tormenta de arena, metro elevado y barcos.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('extras', function (ctx) {
    return { publico: { version: 0 } };
  });
})(typeof window !== 'undefined' ? window : this);
