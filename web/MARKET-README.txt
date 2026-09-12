web/market.json — lista de nodos públicos de mercado (rami-node market).

La página «Cotización» de quantbot.army lee este archivo y consulta
<endpoint>/api/v1/index del primero que responda. Cada entrada de
"endpoints" es una URL base https (p. ej. "https://mercado.quantbot.army").
Sin nodos, la página dice «sin datos». Un nodo de mercado es un rami-node
completo de solo lectura: no tiene monedero, no acepta órdenes y publica
hechos de la cadena en RAMI de prueba (docs/COTIZACION.md).
