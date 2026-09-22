/*
 * Dubái RAMI — módulo «memoria»: la ciudad que recuerda, encargos y el día uno.
 *
 * Secciones 6 a 8 del plan del metaverso: la placa y la pátina de cada
 * edificio (la cadena como memoria), los encargos que la economía ya genera,
 * el día uno de un jugador nuevo y el aviso de NOTICE.md siempre a la vista.
 *
 * Se registra con RamiCity3D.extend antes de montar el visor; el contrato de
 * los ganchos y del contexto está en docs/EXTENSIONES-3D.md.
 */
(function (global) {
  'use strict';
  if (!global.RamiCity3D || typeof global.RamiCity3D.extend !== 'function') return;
  global.RamiCity3D.extend('memoria', function (ctx) {
    return { publico: { version: 0 } };
  });
})(typeof window !== 'undefined' ? window : this);
