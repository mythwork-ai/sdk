// The error vocabulary of the wire — the canonical strings a client will
// read off error bodies and key its repair catalog on. Contract-plane on
// purpose: these strings travel server → client, so the client package
// must carry them and both sides refer to THIS file. What stays
// engine-side: which HTTP status and family each code carries (policy),
// and the error machinery itself. A code's `details` shape belongs here
// too when more than one verb produces it — TargetMissingDetails at the
// bottom of this file is the one such shape today.

import type { AccessVerb } from './entity.types.v1'

export const ERROR_TYPES = {
  invalid_request: 'invalid_request',
  authentication_error: 'authentication_error',
  permission_error: 'permission_error',
  resource_missing: 'resource_missing',
  conflict: 'conflict',
} as const
export type ErrorType = (typeof ERROR_TYPES)[keyof typeof ERROR_TYPES]

export const ERROR_CODES = {
  // The address names no reachable project: the id is malformed, fails
  // its integrity check, or no provisioned instance exists — one code,
  // so probing cannot tell those apart.
  UNKNOWN_PROJECT: 'UNKNOWN_PROJECT',
  UNKNOWN_ENTITY: 'UNKNOWN_ENTITY',
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  INVALID_OPERATOR: 'INVALID_OPERATOR',
  INVALID_LIMIT: 'INVALID_LIMIT',
  FILTER_TOO_COMPLEX: 'FILTER_TOO_COMPLEX',
  MALFORMED_BODY: 'MALFORMED_BODY',
  INVALID_STARTING_AFTER: 'INVALID_STARTING_AFTER',
  REQUIRED_MISSING: 'REQUIRED_MISSING',
  CHECK_FAILED: 'CHECK_FAILED',
  ENUM_INVALID: 'ENUM_INVALID',
  // Two sizes of too-large and one too-deep, deliberately distinct codes:
  // a single value past its own field's cap, a whole request past the row
  // ceiling, and a json value nested past the depth cap.
  VALUE_TOO_LARGE: 'VALUE_TOO_LARGE',
  VALUE_TOO_DEEP: 'VALUE_TOO_DEEP',
  REQUEST_TOO_LARGE: 'REQUEST_TOO_LARGE',
  PROHIBITED_FIELD: 'PROHIBITED_FIELD',
  // One code for a write aimed at a row the caller cannot reach — update
  // and delete alike. Deliberately covers three indistinguishable cases
  // (no such row, a row hidden by the read rule, a malformed id) so a
  // probing write can never become an existence oracle.
  TARGET_MISSING: 'TARGET_MISSING',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SCOPE_DENIED: 'SCOPE_DENIED',
  UNIQUE_VIOLATION: 'UNIQUE_VIOLATION',
  // The publish surface's three answers beyond success. FORBIDDEN: the
  // caller may not publish (owner-only today, behind the authority seam).
  // BLOCKED: the declaration is refused outright — details carry the full
  // violations list, each teaching its repair; no approval can unblock it.
  // PENDING_APPROVAL: the plan needs the owner's answer — details carry
  // the approval cards, and the retry is the same PUT plus their ids.
  PUBLISH_FORBIDDEN: 'PUBLISH_FORBIDDEN',
  PUBLISH_BLOCKED: 'PUBLISH_BLOCKED',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  // A publish raced another publish on the same instance and lost: its plan
  // was computed against a schema version that moved before the apply ran.
  // Nothing was applied; the retry is the same publish, re-planned.
  PUBLISH_CONFLICT: 'PUBLISH_CONFLICT',
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** THE `details` object of a TARGET_MISSING error, in BOTH the shapes the
 * surface actually produces. It lives beside the code rather than in a
 * verb file because all THREE row-addressed verbs answer it — get, update
 * and delete — so no one verb has a better claim to it than the code
 * itself does.
 *
 * All three answer 404 with TARGET_MISSING when the row is not reachable,
 * and all three fold three different situations into that one answer — no
 * such row, a row the caller's read rule hides, and a path segment that is
 * not a legal id. That folding is deliberate: a probing client must not be
 * able to use the surface as an existence oracle.
 *
 * WHAT IS NOT DELIBERATE, and is FLAGGED rather than fixed here: the two
 * variants below are the same wire code carrying two different bodies.
 * A get miss is built by the instance's transport layer and carries
 * `entity` alone, with an EMPTY `message`. An update or delete miss is
 * raised by the engine and carries `entity` AND `verb`, with the full
 * teaching message. A driver that keys on details.verb therefore breaks on
 * get. Both shapes are pinned by fixtures and written up in the "Open,
 * unruled" section of contract/wire-contract-v1.md; unifying them would be
 * a wire change, which this increment does not make. */
export type TargetMissingDetails =
  | { entity: string; verb?: never }
  | { entity: string; verb: AccessVerb }
