/*
 * Genera un VCD de ejemplo con reloj, reset, contador, UART, SPI, bus triestado,
 * PWM, una ráfaga de glitches y una señal analógica (real).
 */
(function (global) {
  'use strict';

  function generateDemoVCD() {
    const T = 40000; // ns
    const ev = new Map();
    const add = (t, s) => {
      let a = ev.get(t);
      if (!a) ev.set(t, (a = []));
      a.push(s);
    };
    const bin = (v, w) => 'b' + (v >>> 0).toString(2).padStart(w, '0');

    // Reloj de 10 MHz (id !)
    for (let k = 0; k * 50 <= T; k++) add(k * 50, (k % 2 ? '1' : '0') + '!');

    // Reset activo en bajo (id ")
    add(0, '0"');
    add(300, '1"');

    // Contador de 8 bits que avanza en cada flanco de subida tras el reset (id #)
    add(0, 'bx #');
    add(300, bin(0, 8) + ' #');
    let cnt = 0;
    for (let t = 350; t <= T; t += 100) add(t, bin(++cnt & 0xff, 8) + ' #');

    // Máquina de estados (id %)
    add(0, 'bxxx %');
    [[300, 0], [2000, 1], [22000, 2], [24000, 3], [27500, 4], [30000, 0]]
      .forEach(([t, s]) => add(t, bin(s, 3) + ' %'));

    // UART TX a 2 Mbaud, 8N1, enviando "Hola" (id &)
    add(0, '1&');
    let t = 2000;
    for (const ch of 'Hola') {
      const byte = ch.charCodeAt(0);
      const bits = [0];
      for (let i = 0; i < 8; i++) bits.push((byte >> i) & 1);
      bits.push(1);
      for (const b of bits) { add(t, b + '&'); t += 500; }
    }

    // SPI modo 0, MSB primero: cs_n ('), sclk ((), mosi ()), miso (*)
    add(0, "1'"); add(0, '0('); add(0, '0)'); add(0, 'z*');
    const spiStart = 24000;
    add(spiStart, "0'");
    const mosi = [0xA5, 0x3C], miso = [0x5A, 0xC3];
    for (let i = 0; i < 16; i++) {
      const byteIdx = i >> 3, bit = 7 - (i & 7);
      const ts = spiStart + 100 + i * 200;
      add(ts, ((mosi[byteIdx] >> bit) & 1) + ')');
      add(ts, ((miso[byteIdx] >> bit) & 1) + '*');
      add(ts + 100, '1(');
      add(ts + 200, '0(');
    }
    add(spiStart + 100 + 16 * 200 + 100, "1'");
    add(spiStart + 100 + 16 * 200 + 100, 'z*');

    // Bus de datos triestado de 16 bits (id +)
    add(0, 'bzzzzzzzzzzzzzzzz +');
    let seed = 0x1234;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xffff;
    for (let tb = 5000; tb < 15000; tb += 800) add(tb, bin(rnd(), 16) + ' +');
    add(15000, 'bzzzzzzzzzzzzzzzz +');
    add(32000, 'b0000xxxx0000xxxx +');
    add(33000, bin(0xBEEF, 16) + ' +');
    add(36000, 'bzzzzzzzzzzzzzzzz +');

    // PWM de 500 kHz con ciclo útil creciente (id ,)
    for (let tp = 0, i = 0; tp < T; tp += 2000, i++) {
      const duty = 0.1 + 0.8 * (i / (T / 2000 - 1));
      add(tp, '1,');
      add(tp + Math.round(2000 * duty), '0,');
    }

    // Señal analógica (real) muestreada cada 250 ns (id -)
    for (let ta = 0; ta <= T; ta += 250) {
      const v = 1.65 + 1.2 * Math.sin((2 * Math.PI * ta) / 16000) + 0.25 * Math.sin((2 * Math.PI * ta) / 1700);
      add(ta, 'r' + v.toFixed(4) + ' -');
    }

    // IRQ con ráfaga de glitches muy densa (id .)
    add(0, '0.');
    for (let i = 0; i < 300; i++) add(34000 + i * 10, (i % 2 ? '0' : '1') + '.');
    add(38000, '1.');
    add(38400, '0.');

    const header = [
      '$date', '  ' + new Date().toUTCString(), '$end',
      '$version', '  PulseWeb demo generator', '$end',
      '$comment', '  Señales de ejemplo para PulseWeb', '$end',
      '$timescale 1ns $end',
      '$scope module top $end',
      '$var wire 1 ! clk $end',
      '$var wire 1 " rst_n $end',
      '$var reg 8 # counter [7:0] $end',
      '$var reg 3 % state [2:0] $end',
      '$var wire 16 + data_bus [15:0] $end',
      '$var wire 1 , pwm $end',
      '$var wire 1 . irq $end',
      '$var real 64 - adc_voltage $end',
      '$scope module uart $end',
      '$var wire 1 & tx $end',
      '$upscope $end',
      '$scope module spi $end',
      "$var wire 1 ' cs_n $end",
      '$var wire 1 ( sclk $end',
      '$var wire 1 ) mosi $end',
      '$var wire 1 * miso $end',
      '$upscope $end',
      '$upscope $end',
      '$enddefinitions $end',
    ];

    const out = header.slice();
    const times = [...ev.keys()].sort((a, b) => a - b);
    for (const tt of times) {
      out.push('#' + tt);
      if (tt === 0) out.push('$dumpvars');
      out.push(...ev.get(tt));
      if (tt === 0) out.push('$end');
    }
    out.push('#' + T);
    return out.join('\n') + '\n';
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { generateDemoVCD };
  global.generateDemoVCD = generateDemoVCD;
})(typeof window !== 'undefined' ? window : globalThis);
