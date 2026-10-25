// Copyright (c) 2026 Stubaggs
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

'use strict';

/**
 * The join and playlist QR codes, as SVG: dark modules on white, one module of
 * margin, error correction M (a code still scans with some of it hidden or
 * glared). qrcode-generator does the encoding; the drawing is here, one path
 * of horizontal runs, so the image stays small.
 */

const qrcode = require('qrcode-generator');

// Addresses are ASCII, but a host name needn't be: encode as UTF-8, not Latin-1.
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

function svg(text, { dark = '#160E24', light = '#FFFFFF', margin = 1 } = {}) {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const size = count + margin * 2;
  let d = '';
  for (let row = 0; row < count; row += 1) {
    let x = 0;
    let first = true;
    for (let col = 0; col < count; ) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      let end = col;
      while (end < count && qr.isDark(row, end)) end += 1;
      d += first ? `M${col + margin} ${row + margin + 0.5}h${end - col}` : `m${col - x} 0h${end - col}`;
      first = false;
      x = end;
      col = end;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<path fill="${light}" d="M0 0h${size}v${size}H0z"/><path stroke="${dark}" d="${d}"/></svg>\n`
  );
}

module.exports = { svg };
