/**
 * Pure TypeScript ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level M, Versions 1–10).
 * Zero external dependencies — produces 100% standard scannable QR codes compatible with
 * Google Authenticator, Microsoft Authenticator, 1Password, Authy, and Apple Passwords.
 */

type VersionSpec = [number, number, number, number, number, number];

const VERSION_M_SPECS: Record<number, VersionSpec> = {
  1: [26, 10, 1, 16, 0, 0],
  2: [44, 16, 1, 28, 0, 0],
  3: [70, 26, 1, 44, 0, 0],
  4: [100, 18, 2, 32, 0, 0],
  5: [134, 24, 2, 43, 0, 0],
  6: [172, 16, 4, 27, 0, 0],
  7: [196, 18, 4, 31, 0, 0],
  8: [242, 22, 2, 38, 2, 39],
  9: [292, 22, 3, 36, 2, 37],
  10: [346, 26, 4, 43, 1, 44],
};

const ALIGNMENT_CENTERS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    for (let j = 0; j < ecCount - 1; j++) {
      rem[j] = rem[j + 1];
    }
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

class BitBuffer {
  bits: number[] = [];

  append(val: number, len: number) {
    for (let i = len - 1; i >= 0; i--) {
      this.bits.push((val >>> i) & 1);
    }
  }
}

function selectVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    const [, , g1b, g1d, g2b, g2d] = VERSION_M_SPECS[v];
    const totalDataBytes = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const capacityBits = totalDataBytes * 8;
    const requiredBits = 4 + countBits + byteLen * 8;
    if (requiredBits <= capacityBits) {
      return v;
    }
  }
  throw new Error(`QR payload too long (${byteLen} bytes, max 213 bytes for Version 10-M)`);
}

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const [totalCW, ecPerBlock, g1Blocks, g1DataCW, g2Blocks, g2DataCW] = VERSION_M_SPECS[version];
  const totalDataCW = g1Blocks * g1DataCW + g2Blocks * g2DataCW;

  const bb = new BitBuffer();
  bb.append(0b0100, 4);
  bb.append(bytes.length, version <= 9 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) {
    bb.append(bytes[i], 8);
  }
  const capBits = totalDataCW * 8;
  const terminatorLen = Math.min(4, capBits - bb.bits.length);
  bb.append(0, terminatorLen);
  while (bb.bits.length % 8 !== 0) {
    bb.bits.push(0);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (bb.bits.length < capBits) {
    bb.append(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  const dataCW = new Uint8Array(totalDataCW);
  for (let i = 0; i < totalDataCW; i++) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bb.bits[i * 8 + b];
    }
    dataCW[i] = val;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < g1Blocks; b++) {
    const slice = dataCW.subarray(offset, offset + g1DataCW);
    dataBlocks.push(slice);
    ecBlocks.push(rsComputeEcc(slice, ecPerBlock));
    offset += g1DataCW;
  }
  for (let b = 0; b < g2Blocks; b++) {
    const slice = dataCW.subarray(offset, offset + g2DataCW);
    dataBlocks.push(slice);
    ecBlocks.push(rsComputeEcc(slice, ecPerBlock));
    offset += g2DataCW;
  }

  const out = new Uint8Array(totalCW);
  let outIdx = 0;
  const maxDataLen = Math.max(g1DataCW, g2DataCW);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < dataBlocks.length; b++) {
      if (i < dataBlocks[b].length) {
        out[outIdx++] = dataBlocks[b][i];
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      out[outIdx++] = ecBlocks[b][i];
    }
  }
  return out;
}

function drawFinderPattern(
  modules: boolean[][],
  isFunction: boolean[][],
  top: number,
  left: number,
  size: number
) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = top + r;
      const cc = left + c;
      if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
      const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const border = inside && (r === 0 || r === 6 || c === 0 || c === 6);
      const center = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      modules[rr][cc] = border || center;
      isFunction[rr][cc] = true;
    }
  }
}

function drawAlignmentPattern(
  modules: boolean[][],
  isFunction: boolean[][],
  centerR: number,
  centerC: number
) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      modules[centerR + dr][centerC + dc] = dist !== 1;
      isFunction[centerR + dr][centerC + dc] = true;
    }
  }
}

function computeFormatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let rem = data << 10;
  const poly = 0x537;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeVersionBits(version: number): number {
  let rem = version << 12;
  const poly = 0x1f25;
  for (let i = 17; i >= 12; i--) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - 12);
    }
  }
  return (version << 12) | rem;
}

function drawFormatBits(modules: boolean[][], isFunction: boolean[][], mask: number) {
  const size = modules.length;
  const bits = computeFormatBits(mask);

  for (let i = 0; i <= 5; i++) {
    modules[i][8] = ((bits >>> i) & 1) !== 0;
    isFunction[i][8] = true;
  }
  modules[7][8] = ((bits >>> 6) & 1) !== 0;
  isFunction[7][8] = true;
  modules[8][8] = ((bits >>> 7) & 1) !== 0;
  isFunction[8][8] = true;
  modules[8][7] = ((bits >>> 8) & 1) !== 0;
  isFunction[8][7] = true;
  for (let i = 9; i < 15; i++) {
    modules[8][14 - i] = ((bits >>> i) & 1) !== 0;
    isFunction[8][14 - i] = true;
  }

  for (let i = 0; i < 8; i++) {
    modules[8][size - 1 - i] = ((bits >>> i) & 1) !== 0;
    isFunction[8][size - 1 - i] = true;
  }
  for (let i = 8; i < 15; i++) {
    modules[size - 15 + i][8] = ((bits >>> i) & 1) !== 0;
    isFunction[size - 15 + i][8] = true;
  }
  modules[size - 8][8] = true;
  isFunction[size - 8][8] = true;
}

function drawVersionBits(modules: boolean[][], isFunction: boolean[][], version: number) {
  if (version < 7) return;
  const size = modules.length;
  const bits = computeVersionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[a][b] = bit;
    isFunction[a][b] = true;
    modules[b][a] = bit;
    isFunction[b][a] = true;
  }
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return false;
  }
}

function computePenalty(modules: boolean[][]): number {
  const size = modules.length;
  let penalty = 0;

  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }
  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const color = modules[r][c];
      if (color === modules[r][c + 1] && color === modules[r + 1][c] && color === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  const matchPattern = (arr: boolean[], idx: number): boolean => {
    const p1 = [true, false, true, true, true, false, true, false, false, false, false];
    const p2 = [false, false, false, false, true, false, true, true, true, false, true];
    let m1 = true;
    let m2 = true;
    for (let k = 0; k < 11; k++) {
      if (arr[idx + k] !== p1[k]) m1 = false;
      if (arr[idx + k] !== p2[k]) m2 = false;
    }
    return m1 || m2;
  };
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      if (matchPattern(modules[r], c)) penalty += 40;
    }
  }
  for (let c = 0; c < size; c++) {
    const col: boolean[] = [];
    for (let r = 0; r < size; r++) col.push(modules[r][c]);
    for (let r = 0; r <= size - 11; r++) {
      if (matchPattern(col, r)) penalty += 40;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) dark++;
    }
  }
  const total = size * size;
  const k = Math.floor(Math.abs((dark * 100) / total - 50) / 5);
  penalty += k * 10;

  return penalty;
}

export function encodeQrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = selectVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version);

  const baseModules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false));

  for (let i = 0; i < size; i++) {
    baseModules[6][i] = i % 2 === 0;
    isFunction[6][i] = true;
    baseModules[i][6] = i % 2 === 0;
    isFunction[i][6] = true;
  }

  drawFinderPattern(baseModules, isFunction, 0, 0, size);
  drawFinderPattern(baseModules, isFunction, 0, size - 7, size);
  drawFinderPattern(baseModules, isFunction, size - 7, 0, size);

  const centers = ALIGNMENT_CENTERS[version];
  for (const r of centers) {
    for (const c of centers) {
      if (isFunction[r][c]) continue;
      drawAlignmentPattern(baseModules, isFunction, r, c);
    }
  }

  drawFormatBits(baseModules, isFunction, 0);
  drawVersionBits(baseModules, isFunction, version);

  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const upward = ((right + 1) & 2) === 0;
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx++;
          }
          baseModules[r][c] = dark;
        }
      }
    }
  }

  let bestMatrix = baseModules;
  let bestPenalty = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = baseModules.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunction[r][c] && maskCondition(mask, r, c)) {
          candidate[r][c] = !candidate[r][c];
        }
      }
    }
    drawFormatBits(candidate, isFunction, mask);
    const penalty = computePenalty(candidate);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMatrix = candidate;
    }
  }

  return bestMatrix;
}

export function buildQrSvgData(text: string, quietZone = 4): {
  viewBoxSize: number;
  moduleCount: number;
  pathD: string;
} {
  const matrix = encodeQrMatrix(text);
  const n = matrix.length;
  const viewBoxSize = n + quietZone * 2;
  const parts: string[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) {
        parts.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }
  return { viewBoxSize, moduleCount: n, pathD: parts.join('') };
}
