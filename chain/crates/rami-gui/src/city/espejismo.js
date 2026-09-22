/*
 * Dubái RAMI — módulo «espejismo»: el acabado de imagen.
 *
 * Entrega 7 del plan del metaverso (ESPEJISMO recortado): interiores por
 * paralaje, oclusión ambiental, resplandor, curva de color y cascadas de sombra.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('espejismo', function (ctx) {
    return { publico: { version: 0 } };
  });
})(typeof window !== 'undefined' ? window : this);
