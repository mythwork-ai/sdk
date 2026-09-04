// @mythwork/protocol — the spec-first TypeScript definition of the postMessage
// protocol between the Mythwork host frame and inner hosted apps.
//
// Runtime code from THIS entry point is constants plus the pure outbound-host
// classifier; everything else is types. Zero dependencies, fully self-contained.
//
// The collab join-token reconnect contract is deliberately NOT re-exported here.
// It owns timers and mutates a live provider, and this package is published to
// npm — shipping stateful, timer-owning code from the default entry changes what
// consumers get merely by importing a type. It stays on its own subpath,
// `@mythwork/protocol/collab-auth`, which is what all six call sites import.

export * from './envelope'
export * from './handshake'
export * from './data'
export * from './methods'
export * from './events'
export * from './descriptors'
export * from './outbound-hosts'
