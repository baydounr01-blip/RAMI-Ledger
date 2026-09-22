/*
 * Dubái RAMI — módulo «umbral»: el umbral y el apartamento.
 *
 * Entrega 5 del plan del metaverso (docs/METAVERSO.md): cruzar el portal de un
 * edificio sin pantalla de carga —zaguán, ascensor, apartamento amueblado— y ver
 * la ciudad de verdad por la ventana, porque es la de verdad.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('umbral', function (ctx) {
    return { publico: { version: 0 } };
  });
})(typeof window !== 'undefined' ? window : this);
