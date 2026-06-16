// @mythwork/sdk/react — React bindings over the @mythwork/sdk client.
//
// Base layer (every app): <MythworkProvider> + useMythwork() → { sdk, user,
// authStatus, signIn, signOut }. Project layer (editor apps): <MythworkProjectProvider>
// + useProject(), plus the project-scoped hooks (useCollabRoom, …).
//
// React, yjs, y-protocols and y-websocket are PEER dependencies of this subpath
// — the core `@mythwork/sdk` entry stays dependency-free.

export {
  type AuthStatus,
  type MythworkContextValue,
  MythworkProvider,
  type MythworkProviderProps,
  useMythwork,
} from './platform'
export {
  MythworkProjectProvider,
  type MythworkProjectProviderProps,
  type MythworkProjectValue,
  useProject,
} from './project'
export {
  type CollabConnectionStatus,
  type CollaboratorInfo,
  type CollabRoomHandle,
  _resetCollabForTests,
  _setProviderFactoryForTests,
  devCollabRelayFactory,
  installDevCollabRelay,
  type RoomScope,
  useCollabRoom,
  type UseCollabRoomOpts,
} from './use-collab-room'
export { type FileChangeEvent, type FilesHandle, useFiles } from './use-files'
export { type GitHandle, useGit } from './use-git'
export { type UseUserResult, useUser } from './use-user'
