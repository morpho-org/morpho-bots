export function publicationEpochs({
  now,
  ttlSeconds,
  leadSeconds
}: {
  now: bigint
  ttlSeconds: number
  leadSeconds: number
}) {
  const ttl = BigInt(ttlSeconds)
  const current = (now / ttl) * ttl
  const epochs = [current]
  if (now >= current + ttl - BigInt(leadSeconds)) epochs.push(current + ttl)
  return epochs
}
