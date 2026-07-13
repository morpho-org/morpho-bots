// The signer's client AND its wire protocol live together deliberately: the protocol is shared
// bidirectional wire code with exactly two speakers, so the server-side framing helpers
// (parseRequestLine, serializeResponse, …) ship from here too rather than from a third package.
export * from './client'
export * from './protocol'
