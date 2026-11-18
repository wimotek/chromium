// Pure-JS ISO/IEC 18004 QR Code (Byte mode, Versions 1..20, ECC M/L) -> Crisp SVG renderer
// Zero external dependencies; works offline in all browsers and Docker builds.

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
;(function initGalois() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) {
    EXP[i] = EXP[i - 255]
  }
})()

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

function rsGeneratorPoly(deg) {
  let poly = [1]
  for (let i = 0; i < deg; i++) {
    const next = new Array(poly.length + 1).fill(0)
    const factor = EXP[i]
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], factor)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen)
  const buf = new Uint8Array(data.length + ecLen)
  buf.set(data)
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i]
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], coef)
      }
    }
  }
  return buf.slice(data.length)
}

// [ecCodewordsPerBlock, g1Blocks, g1DataCw, g2Blocks, g2DataCw]
// Level M (ecc=0) & Level L (ecc=1) for Versions 1..20
const RS_BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
  16: [28, 7, 45, 3, 46],
  17: [28, 10, 46, 1, 47],
  18: [26, 9, 43, 4, 44],
  19: [26, 3, 44, 11, 45],
  20: [26, 3, 41, 13, 42],
}

const RS_BLOCKS_L = {
  1: [7, 1, 19, 0, 0],
  2: [10, 1, 34, 0, 0],
  3: [15, 1, 55, 0, 0],
  4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0],
  6: [18, 2, 68, 0, 0],
  7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0],
  10: [18, 2, 68, 2, 69],
  11: [20, 4, 81, 0, 0],
  12: [24, 2, 92, 2, 93],
  13: [26, 4, 107, 0, 0],
  14: [30, 3, 115, 1, 116],
  15: [22, 5, 87, 1, 88],
  16: [24, 5, 98, 1, 99],
  17: [28, 1, 107, 5, 108],
  18: [30, 5, 120, 1, 121],
  19: [28, 3, 113, 4, 114],
  20: [28, 3, 107, 5, 108],
}

const ALIGNMENT_POS = {
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
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
}

function bchDigit(data) {
  let d = 0
  while (data !== 0) {
    d++
    data >>>= 1
  }
  return d
}

function getBCHTypeInfo(data) {
  let d = data << 10
  while (bchDigit(d) - bchDigit(0x537) >= 0) {
    d ^= 0x537 << (bchDigit(d) - bchDigit(0x537))
  }
  return ((data << 10) | d) ^ 0x5412
}

function getBCHVersionInfo(ver) {
  let d = ver << 12
  while (bchDigit(d) - bchDigit(0x1f25) >= 0) {
    d ^= 0x1f25 << (bchDigit(d) - bchDigit(0x1f25))
  }
  return (ver << 12) | d
}

function pickVersionAndLevel(byteLen) {
  for (let v = 1; v <= 20; v++) {
    const spec = RS_BLOCKS_M[v]
    const totalDataBytes = spec[1] * spec[2] + spec[3] * spec[4]
    const headerBits = 4 + (v < 10 ? 8 : 16)
    const capBytes = Math.floor((totalDataBytes * 8 - headerBits) / 8)
    if (byteLen <= capBytes) {
      return { version: v, level: 'M', eccIndicator: 0, spec }
    }
  }
  for (let v = 14; v <= 20; v++) {
    const spec = RS_BLOCKS_L[v]
    const totalDataBytes = spec[1] * spec[2] + spec[3] * spec[4]
    const headerBits = 4 + (v < 10 ? 8 : 16)
    const capBytes = Math.floor((totalDataBytes * 8 - headerBits) / 8)
    if (byteLen <= capBytes) {
      return { version: v, level: 'L', eccIndicator: 1, spec }
    }
  }
  return null
}

function encodeCodewords(bytes, version, spec) {
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = spec
  const totalDataBytes = g1Blocks * g1Data + g2Blocks * g2Data
  const bits = []
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1)
    }
  }

  pushBits(0b0100, 4) // Byte mode
  pushBits(bytes.length, version < 10 ? 8 : 16)
  for (let i = 0; i < bytes.length; i++) {
    pushBits(bytes[i], 8)
  }

  const maxBits = totalDataBytes * 8
  const term = Math.min(4, maxBits - bits.length)
  for (let i = 0; i < term; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const dataCw = new Uint8Array(totalDataBytes)
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]
    dataCw[i >>> 3] = b
  }
  let idx = bits.length >>> 3
  let padToggle = 0
  while (idx < totalDataBytes) {
    dataCw[idx++] = padToggle === 0 ? 0xec : 0x11
    padToggle ^= 1
  }

  const blocks = []
  const ecBlocks = []
  let offset = 0
  const maxDataLen = Math.max(g1Data, g2Data)
  for (let b = 0; b < g1Blocks; b++) {
    const slice = dataCw.slice(offset, offset + g1Data)
    offset += g1Data
    blocks.push(slice)
    ecBlocks.push(rsRemainder(slice, ecPerBlock))
  }
  for (let b = 0; b < g2Blocks; b++) {
    const slice = dataCw.slice(offset, offset + g2Data)
    offset += g2Data
    blocks.push(slice)
    ecBlocks.push(rsRemainder(slice, ecPerBlock))
  }

  const out = []
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < blocks[b].length) out.push(blocks[b][i])
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < ecBlocks.length; b++) {
      out.push(ecBlocks[b][i])
    }
  }
  return out
}

function buildMatrix(version) {
  const size = version * 4 + 17
  const grid = Array.from({ length: size }, () => new Int8Array(size).fill(-1))
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size))

  const placeFinder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r
        const cc = col + c
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        const inOuter = r >= 0 && r <= 6 && (c === 0 || c === 6)
        const inHoriz = c >= 0 && c <= 6 && (r === 0 || r === 6)
        const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4
        grid[rr][cc] = inOuter || inHoriz || inInner ? 1 : 0
        isFunc[rr][cc] = 1
      }
    }
  }

  placeFinder(0, 0)
  placeFinder(size - 7, 0)
  placeFinder(0, size - 7)

  const align = ALIGNMENT_POS[version] || []
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const r = align[i]
      const c = align[j]
      if (grid[r][c] !== -1) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const val = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0) ? 1 : 0
          grid[r + dr][c + dc] = val
          isFunc[r + dr][c + dc] = 1
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0
    if (!isFunc[6][i]) {
      grid[6][i] = bit
      isFunc[6][i] = 1
    }
    if (!isFunc[i][6]) {
      grid[i][6] = bit
      isFunc[i][6] = 1
    }
  }

  grid[size - 8][8] = 1
  isFunc[size - 8][8] = 1

  // Reserve format info cells
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      isFunc[8][i] = 1
      isFunc[i][8] = 1
    }
  }
  for (let i = size - 8; i < size; i++) {
    isFunc[8][i] = 1
    isFunc[i][8] = 1
  }

  // Reserve and write version info for v >= 7
  if (version >= 7) {
    const verBits = getBCHVersionInfo(version)
    for (let i = 0; i < 18; i++) {
      const bit = (verBits >>> i) & 1
      const r = Math.floor(i / 3)
      const c = (i % 3) + size - 11
      grid[r][c] = bit
      isFunc[r][c] = 1
      grid[c][r] = bit
      isFunc[c][r] = 1
    }
  }

  return { size, grid, isFunc }
}

function maskCondition(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return false
  }
}

function writeFormatInfo(grid, size, eccIndicator, mask) {
  const fmt = getBCHTypeInfo((eccIndicator << 3) | mask)
  for (let i = 0; i < 15; i++) {
    const bit = (fmt >>> i) & 1
    if (i < 6) grid[i][8] = bit
    else if (i < 8) grid[i + 1][8] = bit
    else grid[size - 15 + i][8] = bit

    if (i < 8) grid[8][size - i - 1] = bit
    else if (i < 9) grid[8][15 - i] = bit
    else grid[8][15 - i - 1] = bit
  }
  grid[size - 8][8] = 1
}

function placeDataAndSelectMask(size, grid, isFunc, codewords, eccIndicator) {
  const bitStream = []
  for (let i = 0; i < codewords.length; i++) {
    for (let b = 7; b >= 0; b--) {
      bitStream.push((codewords[i] >>> b) & 1)
    }
  }

  let bestMask = 0
  let bestPenalty = Infinity
  let bestGrid = null

  for (let mask = 0; mask < 8; mask++) {
    const cand = grid.map((row) => Int8Array.from(row))
    let bitIdx = 0
    let up = true
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--
      for (let i = 0; i < size; i++) {
        const r = up ? size - 1 - i : i
        for (let dx = 0; dx < 2; dx++) {
          const c = col - dx
          if (!isFunc[r][c]) {
            let bit = bitIdx < bitStream.length ? bitStream[bitIdx++] : 0
            if (maskCondition(mask, r, c)) bit ^= 1
            cand[r][c] = bit
          }
        }
      }
      up = !up
    }
    writeFormatInfo(cand, size, eccIndicator, mask)
    const penalty = evaluatePenalty(cand, size)
    if (penalty < bestPenalty) {
      bestPenalty = penalty
      bestMask = mask
      bestGrid = cand
    }
  }
  return { grid: bestGrid, mask: bestMask }
}

function evaluatePenalty(grid, size) {
  let penalty = 0
  // N1: 5+ consecutive same color modules in row/col
  for (let r = 0; r < size; r++) {
    let runColor = grid[r][0]
    let runLen = 1
    for (let c = 1; c < size; c++) {
      if (grid[r][c] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = grid[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }
  for (let c = 0; c < size; c++) {
    let runColor = grid[0][c]
    let runLen = 1
    for (let r = 1; r < size; r++) {
      if (grid[r][c] === runColor) {
        runLen++
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = grid[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }
  // N2: 2x2 blocks
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c]
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        penalty += 3
      }
    }
  }
  // N4: dark ratio deviation from 50%
  let dark = 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (grid[r][c] === 1) dark++
    }
  }
  const pct = (dark * 100) / (size * size)
  const k = Math.floor(Math.abs(pct - 50) / 5)
  penalty += k * 10
  return penalty
}

export function renderQrSvg(text, options = {}) {
  const payload = String(text || '').trim()
  if (!payload) return ''
  const bytes = new TextEncoder().encode(payload)
  const picked = pickVersionAndLevel(bytes.length)
  if (!picked) return ''

  const { version, eccIndicator, spec } = picked
  const codewords = encodeCodewords(bytes, version, spec)
  const { size, grid, isFunc } = buildMatrix(version)
  const { grid: finalGrid } = placeDataAndSelectMask(size, grid, isFunc, codewords, eccIndicator)

  const quiet = options.quietZone ?? 3
  const boxSize = options.size ?? 200
  const fg = options.fgColor || '#0f172a'
  const bg = options.bgColor || '#ffffff'
  const total = size + quiet * 2

  let d = ''
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (finalGrid[r][c] === 1) {
        d += `M${c + quiet},${r + quiet}h1v1h-1z`
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${boxSize}" height="${boxSize}" shape-rendering="crispEdges" role="img" aria-label="支付二维码"><rect width="${total}" height="${total}" fill="${bg}"/><path d="${d}" fill="${fg}"/></svg>`
}
