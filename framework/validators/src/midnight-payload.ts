import type { Hex } from 'viem'

import { midnightAbi, Offer, Payload } from '@morpho-org/midnight-sdk'
import { gunzipSync, type ZlibOptions } from 'node:zlib'
import { bytesToHex, decodeAbiParameters, encodeAbiParameters, hexToBytes } from 'viem'

const HEADER_BYTES = 5

/** Node returns the bytes consumed when asked for `info`, which its typings do not model. */
const gunzipWhole = (compressed: Uint8Array) =>
  gunzipSync(compressed, {
    info: true,
    maxOutputLength: Payload.MAX_DECOMPRESSED_ITEMS_BYTES
  } as ZlibOptions) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }

const offerComponents = (() => {
  const take = midnightAbi.find(item => item.type === 'function' && item.name === 'take')
  const offer =
    take?.type === 'function' ? take.inputs.find(input => input.name === 'offer') : undefined
  if (!offer || !('components' in offer)) throw new Error('midnightAbi has no take(offer) input')
  return offer.components
})()

const itemsAbi = [
  {
    name: 'items',
    type: 'tuple[]',
    components: [
      { name: 'offer', type: 'tuple', components: offerComponents },
      { name: 'ratifierData', type: 'bytes' }
    ]
  }
] as const

export type PayloadItem = { offer: Offer; ratifierData: Hex }

/**
 * {@link Payload.decode}, synchronously, as the kernel's reducer needs, and stricter: no bytes may
 * follow the items (the SDK tolerates an attribution suffix, which could carry another signature),
 * and the items must re-encode to exactly the decompressed bytes. Returns a refusal reason otherwise.
 */
export const decodePayload = (data: Hex): readonly PayloadItem[] | string => {
  const bytes = hexToBytes(data)
  if (bytes.length > Payload.MAX_PAYLOAD_BYTES) return 'payload exceeds the wire limit'
  if (bytes.length < HEADER_BYTES) return 'payload too short for its header'
  if (bytes[0] !== Payload.CURRENT_VERSION) return 'unknown payload version'
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1)
  if (bytes.length !== HEADER_BYTES + length) return 'payload carries bytes after its items'
  if (length === 0 || length > Payload.MAX_COMPRESSED_ITEMS_BYTES)
    return 'compressed items out of bounds'
  let decompressed: Hex
  try {
    const { buffer, engine } = gunzipWhole(bytes.subarray(HEADER_BYTES))
    if (engine.bytesWritten !== length) return 'gzip stream does not fill its declared length'
    decompressed = bytesToHex(buffer)
  } catch {
    return 'payload does not decompress'
  }
  try {
    const [items] = decodeAbiParameters(itemsAbi, decompressed)
    if (items.length === 0) return 'payload has no items'
    if (encodeAbiParameters(itemsAbi, [items]) !== decompressed)
      return 'payload items are not canonical'
    return items.map(item => ({ offer: Offer.from(item.offer), ratifierData: item.ratifierData }))
  } catch {
    return 'payload items do not decode'
  }
}
