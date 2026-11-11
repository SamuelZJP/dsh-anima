/**
 * WBI request signing, as the Bilibili web player does it: a mixin key from
 * the two key images in `nav`, then `w_rid = md5(sorted query + mixin)`.
 * @module @anima/adapter-bili/wbi
 */

import { createHash } from 'node:crypto'

/** Fixed character permutation of the mixin key. */
const MIXIN_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

/** File stem of a key image URL (`…/7cd084941338484aae1ad9425b84077c.png` → the hex). */
function stem(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('.')[0] ?? ''
}

/**
 * Mixin key from `nav.data.wbi_img`.
 * @param imgUrl - `wbi_img.img_url`.
 * @param subUrl - `wbi_img.sub_url`.
 */
export function mixinKey(imgUrl: string, subUrl: string): string {
  const raw = stem(imgUrl) + stem(subUrl)
  return MIXIN_ORDER.map(index => raw[index] ?? '').join('').slice(0, 32)
}

/**
 * Signed query string: params plus `wts`, sorted, with `!'()*` removed from
 * values, then `w_rid`.
 * @param params - query parameters.
 * @param mixin - mixin key.
 * @param wts - Unix seconds (now by default).
 */
export function signQuery(params: Readonly<Record<string, string | number>>, mixin: string, wts = Math.floor(Date.now() / 1000)): string {
  const all: Record<string, string | number> = { ...params, wts }
  const query = Object.keys(all).sort()
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(all[key]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  return `${query}&w_rid=${createHash('md5').update(query + mixin).digest('hex')}`
}
