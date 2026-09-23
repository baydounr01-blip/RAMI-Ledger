/*
 * Dubái RAMI — módulo «vida»: la vida de la calle.
 *
 * Entrega 6 del plan del metaverso: coches por carriles con cesión de paso y
 * peatones cuyo destino sale de la economía, como función del tiempo.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('vida', function (ctx) {
    return { publico: { version: 0 } };
  });
})(typeof window !== 'undefined' ? window : this);
