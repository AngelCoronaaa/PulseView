# PulseWeb

Visor web de formas de onda para archivos **VCD** (Value Change Dump), inspirado en [PulseView](https://sigrok.org/wiki/PulseView).
Todo se ejecuta en el navegador: los archivos no se suben a ningún servidor.

## Uso

No necesita instalación ni compilación. Abre `index.html` en el navegador, o sírvelo con cualquier servidor estático:

```sh
python3 -m http.server 8000
# luego abre http://localhost:8000
```

- **Abrir .vcd** o arrastra el archivo sobre la ventana.
- **Demo** carga señales de ejemplo (reloj, UART, SPI, bus triestado, PWM, señal analógica…).
  También puedes abrir `index.html?demo` o cargar `examples/demo.vcd`.

## Funciones

- Señales de 1 bit, buses (HEX / DEC / ±DEC / BIN / ASCII) y señales `real` dibujadas como curva analógica.
- Estados `X` (rojo) y `Z` (línea discontinua amarilla).
- Zoom desde nanosegundos hasta la captura completa; las zonas con muchas transiciones por píxel se agrupan, por lo que archivos con millones de cambios siguen siendo fluidos.
- Cursores A/B con Δt y 1/Δt, y ajuste automático al flanco más cercano.
- Tooltip con ancho de pulso, periodo, frecuencia y ciclo útil.
- Árbol de jerarquía (`$scope`) con búsqueda; reordenar señales arrastrando, cambiar color y base.

## Controles

| Acción | Control |
| --- | --- |
| Zoom | Rueda del ratón, `+` / `-`, pellizco en trackpad |
| Desplazar | Arrastrar, Shift + rueda, `←` / `→` |
| Ajustar todo | `F` |
| Cursor A / B | Clic / Shift + clic o clic derecho |
| Zoom entre cursores | `Z` |
| Quitar cursores | `Esc` |
| Abrir archivo | `Ctrl/⌘ + O` |

## Estructura

```
index.html      interfaz
css/style.css   estilos
js/vcd.js       parser VCD y formateo de valores/tiempos
js/demo.js      generador del VCD de ejemplo
js/app.js       render en canvas, zoom, cursores e interacción
examples/       archivos .vcd de ejemplo
```
