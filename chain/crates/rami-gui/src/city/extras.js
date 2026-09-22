/*
 * Dubái RAMI — módulo «extras»: sonido, foto, tiempo y memoria.
 *
 * Secciones 6 a 8 del plan del metaverso: sonido sintetizado, modo foto,
 * tormenta de arena, metro y barcos, la ciudad que recuerda, encargos de la
 * economía y el día uno de un jugador nuevo.
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
