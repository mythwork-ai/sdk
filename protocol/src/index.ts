// @mythwork/protocol — the spec-first TypeScript definition of the postMessage
// protocol between the Mythwork host frame and inner hosted apps.
//
// Runtime code is constants plus the pure outbound-host classifier;
// everything else is types. Zero dependencies, fully self-contained.

export * from './envelope'
export * from './handshake'
export * from './data'
export * from './methods'
export * from './events'
export * from './descriptors'
export * from './outbound-hosts'
