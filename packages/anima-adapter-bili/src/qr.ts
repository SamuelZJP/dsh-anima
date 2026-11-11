/**
 * A small QR code encoder (byte mode, error correction level L, versions
 * 1–40, mask picked by the standard penalty rules), so the QR login needs no
 * dependency. Follows the structure of Project Nayuki's reference encoder.
 * @module @anima/adapter-bili/qr
 */

import { AnimaError } from '@anima/core'

/** ECC codewords per block at level L, by version (index 0 unused). */
const ECC_PER_BLOCK_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
/** Error-correction blocks at level L, by version. */
const BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25]
/** Format bits of level L. */
const FORMAT_L = 1

/** A QR code: `modules[y][x]` true = dark. */
export interface QrCode {
  readonly version: number
  readonly size: number
  readonly mask: number
  readonly modules: readonly (readonly boolean[])[]
}

/** Raw data modules of a version (everything but function patterns). */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

/** Data codewords of a version at level L. */
export function dataCodewords(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_L[version]! * BLOCKS_L[version]!
}

/** GF(256) multiply with the QR polynomial 0x11D. */
export function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

/** Reed–Solomon generator polynomial of a degree (leading 1 omitted). */
export function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMul(root, 0x02)
  }
  return result
}

/** Reed–Solomon remainder (the ECC codewords) of data. */
export function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coef, i) => { result[i]! ^= gfMul(coef, factor) })
  }
  return result
}

/** Alignment pattern centre coordinates of a version. */
export function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = version * 4 + 17 - 7; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

/** 15 format bits (level L, mask), masked with 0x5412. */
export function formatBits(mask: number): number {
  const data = (FORMAT_L << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | rem) ^ 0x5412
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

/** Data and ECC codewords, split into blocks and interleaved. */
export function codewords(data: readonly number[], version: number): number[] {
  const blocks = BLOCKS_L[version]!
  const eccLen = ECC_PER_BLOCK_L[version]!
  const raw = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (raw % blocks)
  const shortLen = Math.floor(raw / blocks)
  const divisor = rsDivisor(eccLen)
  const all: number[][] = []
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLen - eccLen + (i < shortBlocks ? 0 : 1))
    k += block.length
    const ecc = rsRemainder(block, divisor)
    if (i < shortBlocks) block.push(0)
    all.push([...block, ...ecc])
  }
  const result: number[] = []
  for (let i = 0; i < all[0]!.length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortBlocks) result.push(block[i]!)
    })
  }
  return result
}

/** Payload bytes as padded data codewords of a version (byte mode). */
export function dataBytes(payload: Uint8Array, version: number): number[] {
  const bits: number[] = []
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1) }
  push(0b0100, 4)
  push(payload.length, version <= 9 ? 8 : 16)
  for (const byte of payload) push(byte, 8)
  const capacity = dataCodewords(version) * 8
  push(0, Math.min(4, capacity - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8)
  const bytes: number[] = []
  for (let i = 0; i < bits.length; i += 8) bytes.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))
  return bytes
}

/** Whether mask `mask` inverts module (x, y). */
export function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
  }
}

/** The order data modules are filled: zigzag column pairs from the bottom right. */
export function dataPositions(size: number, isFunction: readonly (readonly boolean[])[]): [number, number][] {
  const order: [number, number][] = []
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!isFunction[y]![x]!) order.push([x, y])
      }
    }
  }
  return order
}

class Matrix {
  readonly modules: boolean[][]
  readonly isFunction: boolean[][]
  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
    this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark
    this.isFunction[y]![x] = true
  }

  finder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const dist = Math.max(Math.abs(dx), Math.abs(dy))
        this.set(x, y, dist !== 2 && dist !== 4)
      }
    }
  }

  alignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
  }

  format(mask: number): void {
    const bits = formatBits(mask)
    const s = this.size
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(s - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, s - 15 + i, bit(bits, i))
    this.set(8, s - 8, true)
  }

  version(version: number): void {
    if (version < 7) return
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.set(a, b, dark)
      this.set(b, a, dark)
    }
  }
}

/** Standard penalty score of a matrix (lower reads better). */
export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length
  let score = 0
  const line = (get: (i: number, j: number) => boolean) => {
    for (let i = 0; i < size; i++) {
      let run = 1
      for (let j = 1; j <= size; j++) {
        if (j < size && get(i, j) === get(i, j - 1)) run++
        else {
          if (run >= 5) score += run - 2
          run = 1
        }
      }
      // Finder-like 1:1:3:1:1 runs with light space on one side.
      for (let j = 0; j + 10 < size; j++) {
        const p = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0].every((v, k) => get(i, j + k) === (v === 1))
        const q = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1].every((v, k) => get(i, j + k) === (v === 1))
        if (p || q) score += 40
      }
    }
  }
  line((i, j) => modules[i]![j]!)
  line((i, j) => modules[j]![i]!)
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y]![x]
      if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3
    }
  }
  const dark = modules.reduce((sum, row) => sum + row.filter(Boolean).length, 0)
  const total = size * size
  score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10
  return score
}

/**
 * Encode text (UTF-8) as a QR code at level L, smallest version that fits.
 * @param text - the payload, e.g. a URL.
 */
export function encodeQr(text: string): QrCode {
  const payload = new TextEncoder().encode(text)
  let version = 1
  while (version <= 40 && 4 + (version <= 9 ? 8 : 16) + payload.length * 8 > dataCodewords(version) * 8) version++
  if (version > 40) throw new AnimaError('anima/qr-too-long', `${payload.length} bytes do not fit in a QR code.`)
  const size = version * 4 + 17
  const base = new Matrix(size)
  for (let i = 0; i < size; i++) {
    base.set(6, i, i % 2 === 0)
    base.set(i, 6, i % 2 === 0)
  }
  base.finder(3, 3)
  base.finder(size - 4, 3)
  base.finder(3, size - 4)
  const align = alignmentPositions(version)
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
      base.alignment(align[i]!, align[j]!)
    }
  }
  base.format(0)
  base.version(version)
  const words = codewords(dataBytes(payload, version), version)
  const order = dataPositions(size, base.isFunction)
  let best: QrCode | undefined
  let bestScore = Infinity
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(size)
    for (let y = 0; y < size; y++) {
      m.modules[y] = [...base.modules[y]!]
      m.isFunction[y] = [...base.isFunction[y]!]
    }
    order.forEach(([x, y], i) => {
      const dark = i < words.length * 8 && bit(words[i >>> 3]!, 7 - (i & 7))
      m.modules[y]![x] = dark !== maskHit(mask, x, y)
    })
    m.format(mask)
    const score = penalty(m.modules)
    if (score < bestScore) {
      bestScore = score
      best = { version, size, mask, modules: m.modules }
    }
  }
  return best!
}

/**
 * Render a QR code as text with half-block characters (two rows per line),
 * with a quiet zone, dark modules drawn dark on a light terminal or page.
 * @param qr - the code.
 * @param quiet - quiet-zone width in modules.
 */
export function renderQr(qr: QrCode, quiet = 2): string {
  const size = qr.size + quiet * 2
  const dark = (x: number, y: number) => {
    const qx = x - quiet
    const qy = y - quiet
    return qx >= 0 && qy >= 0 && qx < qr.size && qy < qr.size && qr.modules[qy]![qx]!
  }
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x++) {
      const top = dark(x, y)
      const bottom = y + 1 < size && dark(x, y + 1)
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' '
    }
    lines.push(line)
  }
  return lines.join('\n')
}
