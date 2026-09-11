// Entity file types — the AGENT-EDITABLE plane (entities/*.jsonc).
//
// TWO different things in this system are called "id", and neither is ever
// written in an entity file:
//
//   - The ENTITY id and FIELD ids: minted integers that name physical
//     storage (table e<entityId>, column f<fieldId>). The engine mints them
//     at first publish and they live only in the prod schema record. Storage
//     named by id rather than by name is what makes a rename a metadata
//     write instead of a data migration.
//
//   - The row `id` column: one of the FOUR SERVER-MANAGED FIELDS that exist
//     on every entity — id, created_at, updated_at, created_by. The engine
//     creates all four as physical columns and stamps them on writes; no
//     entity file declares them, and no client may send them. They are
//     defined together in the server-managed registry beside this file.

export type EntityName = string // ^[A-Z][A-Za-z0-9]*$, unique per project
export type FieldName = string // ^[a-z][a-z0-9_]*$; may not be any of the
// four server-managed names (id, created_at, updated_at, created_by), which
// every entity already has automatically — see the note above

export type EntityFile = {
  v: 1 // the version of the ENTITY-FILE DSL itself — never of this schema.
  // Every DSL in the project carries its format version so serialized
  // files route to the engine version that speaks them.
  name: EntityName // a label, freely renameable in place; the FILE PATH is
  // what identifies the entity across renames
  last_named?: EntityName // rename breadcrumb — the agent WRITES this one.
  // To rename an entity: set `name` to the new name, and set `last_named` to
  // the name this entity currently carries IN PROD. Renames do not stack: if
  // the agent renames twice before publishing, last_named still holds the
  // published name rather than the intermediate one, because the published
  // name is the only thing the engine can match a claim against. Absent on
  // an entity that has never been published, and consumed at publish.
  description: string // REQUIRED. The design intention behind this entity,
  // written for whoever opens this project in a LATER session with none of
  // the current context — usually another agent. Say what one row represents
  // in the real world, why this entity exists separately from its neighbours,
  // who is meant to create rows and who is meant to read them, and any choice
  // that would look arbitrary from the outside (a value copied from another
  // entity on purpose, a key the app composes to make a uniqueness rule work,
  // a status other logic branches on). Never locked and never an approval
  // trigger, so a wrong description can always be corrected. Flows to the
  // prod schema, the generated client's doc comments, and approval cards.
  fields: Record<FieldName, FieldDef>
  row_level_access: AccessRules // who may read, create, update, and delete
  // this entity's rows. Each of the four verbs holds at most one scope, and a
  // verb with NO entry is denied to everyone — the project owner included.
  // There is no implicit allow anywhere in the system. The available scopes,
  // and how each verb evaluates the one it holds, are defined with
  // AccessRules further down this file.
}

// Attributes every field has regardless of type.
export type FieldBase = {
  required?: boolean // default false. true = every row must hold a value.
  // When an app's own code calls create() through the generated client and
  // omits this field, the engine REJECTS that create — unless the field also
  // declares a `default`, in which case the engine fills the default in and
  // the create succeeds. Enforced by the ENGINE'S WRITE PATH against the
  // active schema record — never by physical column constraints.
  // Setting required: true on a PUBLISHED entity needs approval AND a
  // `default`, because rows already exist without a value — the default is
  // what those rows receive (the backfill); the approval card states it.
  last_named?: FieldName // rename breadcrumb — the agent WRITES this one,
  // the same way it does at the entity level. Fields are keyed by name, so
  // renaming one means moving it to the new key and setting `last_named` to
  // the key it currently carries IN PROD. Renames do not stack: last_named
  // always names the published field, never an intermediate name. The engine
  // honours the claim only when that published name exists, is absent from
  // this file, has exactly one claimant, and the type matches — a rename
  // never re-types. Publish then updates the name in the active schema
  // record. There are no runtime aliases: an already-running published bundle
  // may break when the schema moves under it, and new requests always resolve
  // against the latest schema. Absent on a field that has never been
  // published. A published name that disappears with NO breadcrumb claiming
  // it is a DELETE, and raises an approval card.
  description: string // REQUIRED. What this field means and why it exists,
  // written for a later session with none of the current context. Say what
  // the value represents, and its units or format wherever that is not
  // self-evident (cents rather than dollars, a calendar-day key rather than
  // an instant, an id pointing at some other entity — name which one). Say
  // who sets it and when, and state any rule the type cannot express, such as
  // a key the app composes to buy a uniqueness guarantee. Never locked and
  // never an approval trigger. Flows to the prod schema, the generated
  // client's doc comments, and approval cards.
}

// THE canonical field-kind strings — one defining place, same contract as
// SCOPE_KINDS below: every use site references these by name, the FieldDef
// union derives its discriminants from them, and quoted literals exist
// only in the pin test that trips if a value ever changes.
export const FIELD_KINDS = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  enum: 'enum',
  datetime: 'datetime',
  json: 'json',
} as const
export type FieldKind = (typeof FIELD_KINDS)[keyof typeof FIELD_KINDS]

// The one dynamic default the system has. Defined here because it is part
// of the ENTITY-FILE language; the token registry keys its resolver off
// this same constant.
export const NOW_DEFAULT = '$now' as const

// ============================================================
// THE FIELD KINDS — the agent's whole vocabulary for data. Six closed
// variants; nothing else exists. Every variant maps to ONE plain, nullable
// column, because the only physical schema changes this system ever makes
// are creating a table, creating a column, and creating or dropping a
// unique index. Everything else a field declares — required, checks, enum
// membership, length and byte caps — is validated on the write path against
// the active schema record. That split exists because SQLite cannot alter a
// column's constraints without rebuilding the whole table, which would turn
// every otherwise-free widening into an expensive physical operation.
//
// What is deliberately absent, and why:
//
//   - No separate `text` kind. An earlier draft split string from text so
//     that filterability followed the type. The two were merged into one
//     string: SQLite stores all text identically, so the split bought
//     nothing physically, and a length limit is write-path validation
//     rather than schema. One string kind with a maxLength — capped to stay
//     under maxRowBytes — covers both a title and a long note.
//   - No separate `integer` kind. Merged into one number with float64
//     semantics end to end, because the client is JavaScript: integers are
//     exact to ±2^53 and the column carries NUMERIC affinity. Where a value
//     must be whole, `check: { $integer: true }` says so.
//   - No `ref` kind, and therefore no foreign keys, no onDelete, and no
//     cascade machinery. A relation is a plain string field holding another
//     row's id, named *_id, whose description says what it points at. When
//     a project deletes something, that project's own code decides what
//     happens to rows pointing at it — orphans are an application concern
//     here, knowingly.
//   - No `file` kind. Uploads go through the platform's upload path, which
//     hands back a URL; that URL lives in an ordinary string field.
//   - No `list` kind. A dedicated container was carried for a while,
//     because membership scopes need one, and then folded into json rather
//     than kept as a second array type. JsonField below defines the one
//     array shape the server itself understands.
// ============================================================
export type FieldDef =
  | StringField
  | NumberField
  | BooleanField
  | EnumField
  | DatetimeField
  | JsonField

export type StringField = FieldBase & {
  type: typeof FIELD_KINDS.string // all text, short or long — one type (SQLite stores all
  // text identically; length limits are write-path validation, not DDL)
  maxLength?: number // absent means stringMaxLengthDefault (currently:
  // 1024). May be raised up to stringMaxLengthCap (currently: 1_000_000),
  // which sits under maxRowBytes (currently: 2_000_000) with room for the
  // rest of the row; total row size is checked at write.
  default?: string
  unique?: boolean // a UNIQUE index — the one constraint that IS physical
  // (an index is a separate object, created and dropped without a rebuild).
  // Adding unique to a PUBLISHED field is a narrowing (approval trigger),
  // and existing duplicates would make the apply fail — the impact preview
  // counts duplicates before the approval card is shown.
}

export type NumberField = FieldBase & {
  type: typeof FIELD_KINDS.number // one number type, float64 semantics end to end: the
  // client is JavaScript, so integers are EXACT to ±2^53 and fractions are
  // IEEE doubles. Stored with NUMERIC affinity (integral values kept as
  // exact integers). Negative values are fine.
  //
  // MONEY IS WHOLE CENTS, never a fractional amount of currency. $462.00 is
  // declared as a number with `check: { $integer: true }` and the value 46200
  // is what sits in the column; $0.00 is the value 0; 99 cents is 99. The app
  // divides by 100 at the moment it renders and multiplies by 100 when it
  // reads an amount in, so no fraction of a dollar is ever stored. This is
  // not a style preference: 4.62 has no exact float64 representation, so
  // storing dollars directly means sums drift by a cent as rows accumulate,
  // and no amount of rounding at display time gets that cent back.
  check?: NumericCheck // the value rules the engine enforces on every write:
  // bounds and, separately, whole-number-ness. Declaring a check does NOT
  // put a constraint on the column — it is checked on the write path against
  // the active schema record, which is what lets a published field loosen
  // its bounds later without rebuilding the table. Tightening a bound on a
  // published field is a narrowing, so it needs approval.
  default?: number
  unique?: boolean
}

export type BooleanField = FieldBase & {
  type: typeof FIELD_KINDS.boolean
  default?: boolean
}

export type EnumField = FieldBase & {
  type: typeof FIELD_KINDS.enum
  values: [string, ...string[]] // non-empty; at most enumMaxValues
  // (currently: 64) options; renders to a TS
  // literal union in the client. Adding a value = widening (free);
  // removing = narrowing (approval); renaming a value = remove + add.
  default?: string // must be a member of values
}

export type DatetimeField = FieldBase & {
  type: typeof FIELD_KINDS.datetime // stored epoch-ms; Date on the client
  default?: typeof NOW_DEFAULT // the ONLY dynamic default in the system
}

export type JsonField = FieldBase & {
  type: typeof FIELD_KINDS.json // any JSON value, of any shape. The server never filters or
  // sorts on it — apps filter the pages they pull — so nothing inside a json
  // value can be queried. Whole-value replace through the ordinary update
  // verb is how it is edited; per-element edits are deferred, with their
  // wire shape reserved. The write path checks that the value is valid JSON,
  // that it fits its maxBytes, and that it does not nest deeper than
  // jsonMaxDepth (currently: 16).
  //
  // THE ONE SHAPE THE SERVER ITSELF UNDERSTANDS is a top-level array of
  // strings, and it exists for exactly one purpose: the access rules'
  // contains comparison reads it. A `field` rule comparing a json field to
  // $caller means "the user ids in this list may act on this row", and the
  // same list shape is what a lookup rule tests when a group row names its
  // members, or connects through when a row carries a list of codes. Any
  // other shape — an object, an array of objects, a nested array — simply
  // never matches, so a rule pointed at one denies everybody rather than
  // failing loudly. Two consequences worth knowing before modelling with it:
  // a rule's list field must actually hold plain strings, and seeded rows
  // have to demonstrate a satisfied membership, because a rule that can
  // never match is caught before publish rather than at runtime.
  //
  // WHICH MEMBERSHIP SHAPE TO REACH FOR: a json array of user ids fits
  // participant-scale membership — a handful of people named on one row,
  // with nothing recorded about each of them. Membership that carries a role
  // per person, or that grows without a natural bound, belongs instead in a
  // join entity pointing at the users table, which is the only join pattern
  // this system teaches.
  maxBytes?: number // absent means jsonMaxBytesDefault (currently: 64_000)
}

// Enforced by the engine's write path on every create and update — never as
// a column constraint. On a PUBLISHED field, bounds may only LOOSEN ($gte
// and $gt move down, $lte and $lt move up); tightening one is a narrowing,
// and needs approval.
//
// A check carries AT MOST ONE lower bound and AT MOST ONE upper bound.
// $gte and $gt are two ways of saying the same thing, so declaring both is a
// contradiction rather than a rule, and the type refuses it instead of
// leaving the engine to resolve it at runtime. Both ends together are how a
// range is written: { $gte: 0, $lte: 100 } for a percentage.
export type NumericCheck = LowerBound &
  UpperBound & {
    $integer?: boolean // the value must be whole — counts, quantities, and
    // money in cents. Independent of the bounds: a check may set this alone.
  }

type LowerBound = { $gte?: number; $gt?: never } | { $gt: number; $gte?: never }

type UpperBound = { $lte?: number; $lt?: never } | { $lt: number; $lte?: never }

// ============================================================
// row_level_access — four rule kinds per verb, CLOSED BY DEFAULT.
//
// Three audience words decide by WHO IS CALLING alone. The fourth kind is
// THE comparison rule: a field is compared to a value, and everything an
// app can express about row access is one instance of it. Two independent
// choices define an instance:
//
//   - WHERE the value comes from: a literal written in this file, a
//     one-of list of literals, or one of three $-sentinels for values
//     that exist only at request time (the caller's id, a field of the
//     caller's own users row, or the value the request itself presents).
//   - WHERE the tested field sits: on this entity's row, or on a row of
//     ANOTHER entity reached through one lookup hop.
//
// Deliberately not a rule language: the only combinator is a flat any-of
// list per verb (below), there is no negation and no nesting, and which
// comparison runs is inferred from the declared field kinds rather than
// spelled as syntax. "Is this change wider?" stays a table lookup over
// kind, value source, and list length, keeping the access-expansion
// approval trigger simple.
// ============================================================
export type AccessRules = Partial<Record<AccessVerb, AccessScope | AccessScope[]>>
// A verb may hold ONE rule or a flat LIST of rules: any rule admitting
// admits the caller. The list is the language's only combinator — or,
// never and, never nested — and publish caps its length (4) and treats a
// grown list as widened access. A verb with NO entry is denied to
// everyone, the project owner included; there is no implicit allow
// anywhere in the system.
export type AccessVerb = 'read' | 'create' | 'update' | 'delete'

// THE canonical strings of the access-rule language. This block is their
// ONE defining place: the constant objects below are the source, every
// runtime use site references them by name (never a quoted literal), the
// type union underneath derives its members from them, and the arrays at
// the end exist for parsers and writers that need to enumerate the
// vocabulary. These exact strings are written into entity files and
// travel over the wire; a test pins their values so no rename can slip
// through silently.
export const SCOPE_KINDS = {
  public: 'public',
  authenticated: 'authenticated',
  ownerOnly: 'ownerOnly',
  // the comparison rule — a field, compared to a value
  field: 'field',
} as const
export type AccessScopeKind = (typeof SCOPE_KINDS)[keyof typeof SCOPE_KINDS]

// The dynamic value sources a `field` rule may name in `matches`. Same
// precedent as NOW_DEFAULT above: a $-word stands where a value would go,
// meaning the value arrives at request time. The reservation is
// rule-side only — stored DATA never collides with these strings,
// because a rule compares a presented value against stored values; the
// one cost is that no rule can mean "equals the literal text $caller".
export const SENTINELS = {
  // the verified user id of the person making this request, attached by
  // the platform identity layer — never taken from the request body.
  // Anonymous requests never match a $caller rule (fail closed).
  caller: '$caller',
  // the value presented WITH the request: for reads, exactly one bare
  // equality condition on this field in the query's filter (no condition
  // means nothing is admitted — one guess per request); for updates, the
  // field sent in the row, which must equal the stored value. Access by
  // knowledge — identity is not consulted, so anonymous holders of a
  // link qualify. Publish allows this sentinel on read and update only.
  provided: '$provided',
  // '$caller.<usersField>' names a field of the caller's own users row,
  // resolved against the declared users fields; an absent row or value
  // never matches. Allowed on this-entity fields only.
  callerUsersFieldPrefix: '$caller.',
} as const

export type MatchValue = string | number | boolean
export type Matches = MatchValue | [MatchValue, ...MatchValue[]]
// One literal, a non-empty one-of list of literals, or a sentinel string
// from SENTINELS above. Sentinels are strings, so the type absorbs them;
// classifyMatches below is THE one classifier every consumer uses to
// tell the cases apart — sentinels never appear inside one-of lists.

// Which comparison a `field` rule runs is INFERRED from declared field
// kinds: two scalars compare as equality; a json string-list on the FIELD
// side contains the value. `comparison` may be written explicitly as
// documentation — it must AGREE with what the kinds infer (a mismatch
// fails closed at evaluation and loudly at publish). Explicit never
// overrides inference; it pins it, like a type annotation. This enum is
// the extension point if the language ever needs ordering or ranges —
// new words here, never new syntax.
export const COMPARISONS = {
  equals: 'equals',
  contains: 'contains',
} as const
export type Comparison = (typeof COMPARISONS)[keyof typeof COMPARISONS]

export const ACCESS_VERBS = {
  read: 'read',
  create: 'create',
  update: 'update',
  delete: 'delete',
} as const

export const ACCESS_SCOPE_KINDS: readonly AccessScopeKind[] = Object.values(SCOPE_KINDS)
export const ACCESS_COMPARISONS: readonly Comparison[] = Object.values(COMPARISONS)

export type AccessScope =
  // 1. truly public: everyone, including anonymous visitors
  | { scope: typeof SCOPE_KINDS.public }
  // 2. any logged-in user of THIS project
  | { scope: typeof SCOPE_KINDS.authenticated }
  // 3. only the project's owner (the instance knows its owner's user id)
  | { scope: typeof SCOPE_KINDS.ownerOnly }
  // 4a. the comparison rule, direct form: a field on this entity's row is
  //     compared to `matches`. Reads as a sentence — "rows where
  //     created_by matches $caller", "rows where status matches
  //     'published'", "rows where registry_code matches $provided".
  | {
      scope: typeof SCOPE_KINDS.field
      field: FieldName // on this entity — the entity this rule is written on
      lookup?: never
      matches: Matches
      comparison?: Comparison
    }
  // 4b. the comparison rule with a lookup hop: this row's `field` selects
  //     rows of another entity, and the test runs THERE. The rule judges
  //     rows of the entity it is written on; `lookup` names the entity
  //     consulted to decide; the connector `field` is the only member
  //     bridging them and belongs to the judged side. Everything inside
  //     `lookup` belongs to the looked-up entity. Reads as — "this row's
  //     team_id looks up its Team; that Team's member_ids contains
  //     $caller". One hop only: publish rejects a rule that looks up an
  //     entity whose own rules look up onward, and the engine never
  //     recurses. Publish also creates an index on every matchedBy field
  //     a rule names, so evaluation is an indexed probe, never a scan.
  | {
      scope: typeof SCOPE_KINDS.field
      field: FieldName // on this entity — the connector
      lookup: {
        entity: EntityName // the entity consulted to decide
        matchedBy?: FieldName // its field the connector must equal;
        // absent means 'id' — the plain "this row stores their id" case
        field: FieldName // its field tested against `matches`
      }
      matches: Matches
      comparison?: Comparison // for the final test; the connector's
      // comparison is inferred, and a json list on the looked-up side of
      // the connection is refused (it could never use an index)
    }
// NAMING CONVENTION, whole-language: a bare `field` always belongs to the
// entity its enclosing object is about — this entity at the top level,
// the looked-up entity inside `lookup`. No other way to reference a
// field exists.
//
// CRUD-SCOPED (canonical): the four slots are INDEPENDENT policies and
// every engine check is named for the exact verb executing — no "write"
// bucket exists. Evaluation differs per verb: read COMPILES into the
// WHERE clause of the read verbs (a filter — invisible rows are silently
// absent, never an error); update/delete GATE against the EXISTING target
// row; create GATES against the INCOMING row. A write whose target the
// caller's read rule hides fails exactly like a missing row, so every
// update is already "read rule AND update rule" — a state lock needs no
// combinator: read holds the membership half, update holds the state
// half. Widening any slot on a published entity is an approval trigger.

// THE one classifier of a `matches` value — every consumer (the engine's
// evaluators now, publish validation later) tells the cases apart through
// this function and nowhere else, so the sentinel strings are interpreted
// in exactly one place.
export type MatchesClass =
  | { kind: 'callerId' }
  | { kind: 'provided' }
  | { kind: 'callerUsersField'; usersField: FieldName }
  | { kind: 'literal'; value: MatchValue }
  | { kind: 'oneOf'; values: MatchValue[] }
export function classifyMatches(matches: Matches): MatchesClass {
  if (Array.isArray(matches)) return { kind: 'oneOf', values: matches }
  if (matches === SENTINELS.caller) return { kind: 'callerId' }
  if (matches === SENTINELS.provided) return { kind: 'provided' }
  if (typeof matches === 'string' && matches.startsWith(SENTINELS.callerUsersFieldPrefix)) {
    return {
      kind: 'callerUsersField',
      usersField: matches.slice(SENTINELS.callerUsersFieldPrefix.length),
    }
  }
  return { kind: 'literal', value: matches }
}

// ============================================================
// Enforcement split (authoritative statement)
// ============================================================
// DB ENGINE (physical DDL) enforces only what SQLite can attach and detach
// without rebuilding the table:
//   - the primary key
//   - UNIQUE indexes (an index is a separate object: created/dropped freely)
//   - nothing else. Columns are plain and nullable. No NOT NULL, no CHECK,
//     no enum CHECK in the DDL — ever.
// API LAYER (the engine's write path) enforces everything declarative, by
// validating every create/update against the ACTIVE SCHEMA RECORD:
//   required, check bounds, enum membership, maxLength/maxBytes,
//   type conformance. One implementation, shared by every write path.
//
// Physical rendering: every field is one plain column in table e<entityId>,
// column f<fieldId> — named by id, never by name; renames are metadata.
// Relations are plain id strings by convention (description says what an
// id field points to); no foreign keys, no cascade machinery.
