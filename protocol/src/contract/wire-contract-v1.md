# The Client-Facing Wire Contract, Version 1

This document describes the HTTP surface of a project's database — every
route a client may call, what it answers, and the behaviour a client has to
know to talk to it correctly. It is written for someone implementing a
driver from scratch, in any language, with no knowledge of how the server
is built.

A "project's database" here means one relational database that belongs to
one project built on this platform. Each project gets its own, holding only
that project's own tables. A client reaches it over ordinary HTTP with JSON
bodies. There is no other protocol, no socket, and no direct database
connection.

## The hard rule: this contract only ever adds

From this point onward, the surface described below may only GROW. A route,
a parameter name, a field name in a request or a response, an operator, an
error code, or a status code that appears here will never be renamed and
will never change meaning. New routes, new parameters, new operators, and
new error codes may be added.

The reason is that an application published against this version keeps
running unchanged. Nobody rebuilds every published application when the
platform moves forward, so a client written today has to keep working
against a server shipped much later.

That rule binds the surface as this document describes it. It does not
claim that everything below has always been stable — it says that from
here on, changing any of it in a way that breaks a reader of this
document is not a thing this system does.

## Every route the surface admits today

All paths begin with the project's own id, which the platform hands the
client. Where a path shows `{projectId}`, substitute that id. Where it
shows `{entity}`, substitute an entity's name. Where it shows `{id}`,
substitute a row's id.

Every response body is JSON, except where a route is listed as answering no
body at all.

A project has two databases behind this surface: the published
application's, and the application still being built. A `dev` segment right
after the project id, on any route below, addresses the second one instead
of the first — `GET /projects/{projectId}/dev/entities/{entity}` reads the
building application's own rows, exactly as `GET /projects/{projectId}/entities/{entity}`
reads the published one's. Every one of the six data verbs exists in both
forms, with the same body shapes and the same success codes on either; the
schema resource does not split so evenly, and the section below says where
it differs. Which credential may use the `dev` form, and what else differs
about the two databases, is the subject of the sections on credentials and
admission further down.

### The six data verbs

| Verb | Method and path | Success | Body it answers |
| --- | --- | --- | --- |
| list | `GET /projects/{projectId}/entities/{entity}` | 200 | one page of rows |
| create | `POST /projects/{projectId}/entities/{entity}` | 201 | the full stored row |
| count | `GET /projects/{projectId}/entities/{entity}/count` | 200 | `{ "count": <number> }` |
| get | `GET /projects/{projectId}/entities/{entity}/{id}` | 200 | the full stored row |
| update | `PATCH /projects/{projectId}/entities/{entity}/{id}` | 200 | the full stored row |
| delete | `DELETE /projects/{projectId}/entities/{entity}/{id}` | 204 | no body |

A page of rows looks like this, and nothing else:

```json
{ "rows": [ { }, { } ], "next": "<opaque page token>" }
```

`next` is either an opaque string that resumes the walk, or `null`, which
means there are no further rows to fetch.

The create body is a single JSON object of field names to values. So is the
update body, except that an update names only the fields it changes.

There are exactly six data verbs. There is no bulk create, no bulk update,
no upsert, and no aggregate beyond `count`.

### The schema resource

| Method and path | Success | Body it answers |
| --- | --- | --- |
| `GET /projects/{projectId}/schema` | 200 | the published schema |
| `PUT /projects/{projectId}/schema` | 200 | what the publish applied |
| `GET /projects/{projectId}/dev/schema` | 200 | the building application's own schema |
| `PUT /projects/{projectId}/dev/schema` | 200 | what the write applied |
| `PUT /projects/{projectId}/dev/schema/entities/{entity}` | 200 | what the write applied |
| `DELETE /projects/{projectId}/dev/schema/entities/{entity}` | 204 | no body |

A GET answers that database's own registry version and stored entities:

```json
{ "version": 3, "entities": { "task": { } } }
```

`version` counts writes to that database's registry. It is 0 where nothing
has been written yet, and afterwards it is the version the most recent write
produced. It is not a format version.

Each entry under `entities` carries the entity's physical id, its
description, its declared fields (each with a physical field id and its
full published definition), and its access rules. The exact shape, and a
careful statement of what this body does and does not tell a client, is in
`schema-response.v1.ts` beside this file.

The whole-document PUT — on either path — replaces the whole schema. Its
semantics are literally those of PUT: an entity or a field that is currently
stored and absent from the document is a deletion. The by-entity PUT exists
only on the `dev` path; it declares one entity and is additive only — it may
create an entity or add fields, and anything else it would imply is refused.

Both PUTs answer the same body on success:

```json
{ "version": 4, "applied": { "entities": 1, "fields": 6 } }
```

`version` is the new registry version. The two counters say how many
entity-level and field-level operations the write carried out.

**The plain path's PUT is the publish, and publish authority is the project
owner's** — that is the engine's decision: a caller who is not the owner gets
`PUBLISH_FORBIDDEN`, and so does an anonymous caller. **The `dev` path's PUT
asks no such question**: the building application's database assesses no
access rules at all, so any caller admitted to that path may write its whole
schema, exactly as they may write any row there. Which credentials reach
each path at all is a separate question, answered by the section on
credentials and admission below — and reaching a path is not, by itself,
authority over what it does once reached.

The `dev` path's DELETE drops one entity — its table and every row in it —
reusing the same apply a schema write uses, so the stored schema record, the
entity registry and the physical table all move together. It answers 204 on
success. An entity name that database does not declare is answered 404 with
`UNKNOWN_ENTITY`, the same not-found shape any other entity miss on this
resource gets.

The published application's database answers no by-entity PUT and no
DELETE at all. A request that somehow reached one there is answered 404 with
`UNKNOWN_PROJECT`, indistinguishable from a project that does not exist, and
nothing on that database is touched.

### Retired: the dev-instance wipe

`DELETE /projects/{projectId}/dev-instance` is no longer part of this
surface (ruling d-38). It had no external caller — the per-entity delete
above is the one deletion route a client ever needed, and it replaces the
one thing the wipe existed for.

### What answers before a request reaches the database

Three refusals happen in the platform layer in front of the database, and a
client sees them as ordinary responses on the routes above.

A request whose declared content length exceeds the body ceiling is refused
at 413 with `REQUEST_TOO_LARGE`, without the body being read.

A project id that fails its integrity check is answered at 404 with
`UNKNOWN_PROJECT`. So is a project with no database provisioned. A client
cannot tell those two apart, on purpose.

A request carrying a credential that does not verify is answered at 401
with `UNAUTHORIZED`. A request carrying no credential at all is anonymous,
which is a legitimate posture rather than an error — whether an anonymous
caller may do anything is decided by the entity's access rules. Which
credential counts as one this surface will even look at is the next
section.

Errors raised in that front layer carry an empty `message` string. Errors
raised by the database itself carry a full plain-English explanation. Both
carry the same body shape, described further down.

### What credential this surface accepts, and which database it reaches

The ROUTE decides which of a project's two databases a request addresses —
the `dev` segment reaches the building application's database, and its
absence reaches the published one. What a credential decides is narrower:
whether it may use the path it asked for at all, and, for a schema-level act
(a schema write or the per-entity delete), whether it carries the scope
value that database's own writes demand.

**A token minted by the platform for a build service is the only credential
that reaches the `dev` path, and it is admitted there on any route and by
any method.** It carries a `scope` claim naming the build operations it was
minted for. A schema-level act on the `dev` path needs the value
`schema:edit` in that claim; every other verb there asks the claim nothing
at all — reaching the `dev` path is itself the authorization for a data verb
or a schema read.

**That same credential also reaches the plain path**, admitted there
exactly as a sign-in session or anonymous traffic is. Its scope claim is
read only for the one schema-level act the plain path serves, the
whole-document publish, which needs `schema:publish`. A credential whose
scope names neither value still reaches every data verb and every schema
read on either path.

**The browser sign-in session that authenticates the rest of this platform
is accepted only at the plain path.** It is the same Bearer the browser
already sends this platform's other routes, verified the same way, and it
is refused the `dev` path outright, on any method or resource. What it may
do at the plain path with a row is decided per row by the entity's access
rules, exactly as for any other identified caller — except the publish,
which it is refused there too: a session never publishes.

**Presenting nothing is still legitimate, and only at the plain path.** A
request with no credential is anonymous. That is the posture the users of a
published application call under, and whether an anonymous caller may do
anything is decided per row by the entity's access rules, as the rest of
this document describes. Anonymous traffic is refused the `dev` path
outright, the same as a session.

**Publishing is not a fourth posture.** The publish is the plain path's one
schema-level act, admitted on the credentials above under the
`schema:publish` scope. Publish authority itself is decided inside the
database, against the owner id recorded when the database was created, so
being admitted at the publish route settles nothing about whether the
publish applies.

### What the project id in the path proves, and what it does not

The project a request is for is read straight out of the path — the segment
after `/projects/`. Nothing else names it: there is no project header, no
project field in a body, and no way for a caller to mean one project while
addressing another.

That path segment is put through one check before anything else happens to
the request. A project id minted by the platform carries an integrity code
computed under a key only the platform holds, and the check recomputes it.
An id that fails is answered at 404 with `UNKNOWN_PROJECT`, with no storage
touched. So a client cannot invent, guess, or tamper with a project id and
have it accepted.

What that check proves is narrow, and the limit matters: it proves the id
is well-formed and was minted by the platform. It proves nothing at all
about the caller. It is computed from the id string alone — the caller's
credential is not part of it, and no record of who may touch the project is
consulted.

The rest of this platform's project-scoped routes ask more. Their shared
check is three steps: the same integrity check on the id, then a
REQUIREMENT that the caller is signed in, then an authoritative look-up of
that caller's role on that project in the platform's membership records. A
signed-in caller who holds no role there is refused.

This surface runs the first of those three steps and stops. It does work
out who is calling — a minted token that verifies names its subject, no
credential means an anonymous caller, and a credential that does not
verify is a 401 — but it never asks whether that caller is a member of the
project. Note that the second of the three steps is not merely skipped
here; it could not be run as written, because "signed in" on the rest of
the platform means holding the browser session that this surface does not
accept at all.

Two things follow from stopping there, and they are not equally settled.

Authorizing the DATA is settled, and the reason is who the callers are.
The people using a published application are not members of the project
that built it; they are members of nothing. Asking for a project role would
refuse every one of them. Authorization over rows is decided per row
instead, inside the database, by the access rules the entity declares, and
that language is closed by default: a verb with no rule granting it is
denied to everyone, the project's own owner included. Reaching the
project's database therefore grants nothing by itself.

Whether anything should stand in FRONT of this surface, deciding who may
reach a project's database at all, is NOT settled, and no such gate is
built. The server says so about itself in two places. The route layer's
own header comment records that end-user admission — it names the servable
predicate, per-IP throttles, and the app-canonical id — is not part of that
layer, and that callers pass through with verification only. The database
instance's header comment says the same about the instance: admission does
not exist on this surface, and verified callers pass straight through. So
caller identity on this surface is a verified passthrough of whatever
credential the door accepts, and nothing anywhere decides who may reach a
project's database at all.

Publishing is the one exception, and it is decided in the same place rather
than in front of it. `PUT /projects/{projectId}/schema` is the project
owner's act alone: the database holds the owner's id, recorded when the
database was created, and compares the caller against it. That comparison
is made inside the database, against its own record — not against the
platform's membership records. It is the route and the operation being
asked for that send a request down that path, and nothing else about the
caller. Which credentials reach it at all is the credential section's
question, and its answer does not change this one: being admitted at the
door is not publish authority.

### The admission outcomes

The sections above say which credential this surface accepts, and which
database the route it used addresses. This one says what a caller is
answered, credential by credential, by the door standing in front of the
database. Every outcome below is wire-visible: a status, one of the codes in
the vocabulary further down, and the front-layer body shape — the same four
members, with `message` an empty string. None of these outcomes introduces a
code or a status of its own.

**A malformed or unverifiable credential is 401 with `UNAUTHORIZED`.** That
covers a Bearer header carrying something that is not a token this platform
minted, a token whose signature does not check out, one that has expired, and
one minted for a different issuer or audience. A client cannot tell those
apart on the wire. None of them is quietly downgraded to the anonymous
posture, so a 401 here means obtain a fresh token and retry — not drop the
header and call anonymously.

**No credential at all is anonymous, and anonymous is refused the `dev`
path outright, reaching the published database only.** Presenting nothing
stays legitimate, as the credential section above says, and it is the one
thing this door defaults on the plain path. No request a client can write
makes an anonymous call reach the `dev` path's database. What an anonymous
caller may then do with a row on the plain path is the entity's own access
rules, decided inside the database.

**A verified token used outside what its route or its scope covers is 403
with `SCOPE_DENIED`.** Four shapes reach that answer:

- a token minted for one project, presented on a path naming a different one;
- a platform sign-in session, or no credential at all, presented on the
  `dev` path — that path is reachable only by a token this platform minted
  for a build service;
- a schema-level act — a schema write or the per-entity delete — missing the
  scope value its path demands (`schema:edit` on `dev`, `schema:publish` on
  the plain path's publish); the by-entity write and the delete are refused
  on the plain path the same way, for every credential, whether or not it
  verifies — the plain path serves no schema-level act but the
  whole-document publish, so those two shapes never reach a credential check
  at all;
- a data verb or a schema read asks none of this: reaching a database at all,
  on either path, is itself the authorization for those — the `dev`
  database assesses no row access rules, so admitting a caller to it is the
  whole of what decides what they may do with a row there.

`SCOPE_DENIED` is a code both this door and the database itself can answer;
the door's are the ones whose `message` is empty.

**The platform's browser sign-in session is admitted at the plain path,
never at `dev`.** It is the same session the browser already sends every
other route on this platform, verified the same way, and it is accepted on
every route and method the plain path serves. Being admitted grants nothing
by itself: the identity the session names is passed to the database, and
what that identity may do with a row is the entity's own access rules,
assessed there — except the publish, which a session is refused at the
door, on either of the schema resource's shapes.

**The checks above are the whole list, and a caller's standing on the
project is not among them.** Once a token verifies and, for a schema-level
act, its scope is in order, the caller is admitted. The door does not ask
the platform's membership records for the caller's role on the project the
path names, and it does not ask whether the caller may access that project at
all — it never consults those records. What a caller may do with a row is the
entity's own access rules, assessed inside the database: the published
application's database enforces them, and the `dev` database assesses none,
so being admitted to that one is itself the authorization. The question of
who may hold a token for a project is settled where the token is minted, not
here.

**A forged project id is answered 404, and is answered first.** The integrity
check on the path segment runs before any credential work, so an invented id
never reaches these credential checks. It gets the same status, the same
`UNKNOWN_PROJECT` code, and the same empty body as a project with no
database. One consequence is worth stating plainly, because it is the single
place these outcomes are not uniform: a caller who holds a real token for a
project of their own and probes a different real project id is answered 403
rather than 404, which tells them that id was minted by this platform. It
applies only to ids the caller already holds, since a guessed id fails its
integrity check and 404s before anything else, and the 403 body carries
nothing further — not which project, not whose, not why. The asymmetry is
deliberate: a build service presenting the wrong token has to see a
permission error it can act on rather than a project that appears not to
exist.

**The order these run in is part of what a client sees.** Declared body
length first, then the project id's integrity check, then the route's own
shape (a schema-level act the plain path does not serve is refused before a
credential is even looked at), then the credential's verification, then the
scope check for a schema-level act. That is the end of the order — nothing
after it looks the caller up anywhere.

**What this door never does.** Nothing in the order above looks the caller
up in the platform's membership records, and no outcome above depends on such
a look-up: the door works out who is calling and stops there, exactly as the
section on the project id describes. A caller admitted here holds no standing
beyond their identity — what they may do with a row is the entity's access
rules inside the database, and whether a publish applies is the owner
comparison the database makes against its own record. Nor does anything
decide who may reach a project's database at all: end-user admission — the
servable predicate, per-IP throttles, the app-canonical id — is not built,
and whether it should stand in front of this surface is the open question
described further up. What this door settles is narrower than that
question: the answer is not a membership look-up here.

## The list and query shape

The list route takes four query-string parameters. They are the only four
it takes, and these are their names exactly:

| Parameter | What it carries |
| --- | --- |
| `where` | the filter, JSON-encoded |
| `sort` | one field to order by, optionally prefixed |
| `starting_after` | a page token from a previous page |
| `limit` | how many rows this page may hold |

All four are optional. A request with none of them is a legal first page.

The typed form of all four, for a TypeScript client, is `ListQuery` in
`list-query.v1.ts` beside this file. The parameter names themselves live
there too, as `LIST_QUERY_PARAMS`.

### The filter

The `where` parameter carries a JSON object. Its keys are field names. Each
value is either a bare scalar, which means exact equality, or an object of
operators.

```
where={"status":"todo"}
where={"priority":{"$gte":3,"$lte":5}}
where={"status":{"$in":["doing","done"]}}
```

The whole vocabulary of operators is five names. This table says which
field kinds each one may be used on.

| Operator | Value it takes | Field kinds it may be used on |
| --- | --- | --- |
| (bare scalar) | one scalar | string, number, boolean, enum, datetime |
| `$in` | a non-empty list of scalars | string, number, boolean, enum, datetime |
| `$gte` | one number or one instant | number, datetime |
| `$gt` | one number or one instant | number, datetime |
| `$lte` | one number or one instant | number, datetime |
| `$lt` | one number or one instant | number, datetime |

The four range operators are restricted to numbers and instants because
those are the only two kinds with a defined ordering. Using one on a
string, a boolean, or an enum answers `INVALID_OPERATOR`.

There is no not-equal operator, no text-search operator, no starts-with,
and no or-combinator. The set is deliberately narrower than comparable
products and is expected to widen as real applications justify it. Widening
it is an addition, which the hard rule allows.

The filter may also name the fields the server itself manages. Those are
described further down, in the section on facts a driver will otherwise get
wrong.

Two caps apply to a filter, and each has a name in the platform's
configuration file, `config.ts` beside this document. The names are what to
quote when talking about them, because the numbers may move.

`inListMax` caps how many values one `$in` list may hold. Today it is 100.
A list that is empty, or longer than the cap, answers `INVALID_OPERATOR`.

`filterMaxConditions` caps how many conditions one whole filter may
produce. Today it is 32. Note that it counts conditions rather than fields,
so a field carrying a lower and an upper bound spends two of them. Going
over answers `FILTER_TOO_COMPLEX`.

### The sort

The `sort` parameter names exactly one field, optionally prefixed with a
character that picks the direction.

```
sort=-due_at     descending
sort=%2Bdue_at   ascending, written with an explicit plus
sort=due_at      ascending, the same as the plus form
```

Remember that a plus sign in a query string has to be percent-encoded as
`%2B`, or it will be read as a space.

Omitting `sort` entirely means newest first, which is the row id
descending. That default is deterministic even while other clients are
writing, because a newly inserted row always takes a higher id than every
row already there.

Which fields may be sorted by:

Any declared field of any kind except json may be sorted by.

Of the four fields the server manages on every row, three may be sorted by
— `id`, `created_at`, and `updated_at`. The fourth, `created_by`, may NOT
be sorted by. It holds a user id as text, and only the ordered kinds are
sortable.

A json field may never be sorted by. Neither may a name that does not exist
in the currently published schema. Both answer `UNKNOWN_FIELD`.

A sort on a field that has no index behind it makes the server scan and
sort the table for each page. Per-project tables are small and a page is
capped, so this is accepted today rather than hidden — but it is worth
knowing before sorting a large table by an arbitrary field.

### The limit

`limit` is a whole number. Its floor is 1 and its ceiling is the
configuration value `pageLimitMax`, today 200. Omitting it means the
configuration value `pageLimitDefault`, today 50.

A value outside that range is refused with `INVALID_LIMIT`. It is never
quietly clamped to the nearest legal value, because a clamp would teach a
client a page size the server does not actually honour. A value that is not
a whole number — a fraction, or text that is not a number at all — is
refused the same way.

### Paging

`starting_after` carries a page token. A page token is an opaque string.
The only legal way to obtain one is to read the `next` member of a page the
server already answered, and to send it back unchanged. A client never
builds one, never parses one, and never modifies one.

A token is bound to the sort it was minted under. It seals both the field
that was being sorted on and the direction. Sending a token from a
descending walk into an ascending request, or into a request sorted by a
different field, is refused with `INVALID_STARTING_AFTER`. That refusal
exists because resuming under a different ordering would silently repeat
some rows and skip others.

A damaged token, a token from a format this server no longer reads, and a
made-up string all land on the same `INVALID_STARTING_AFTER`. The remedy in
every case is the same: start again from page one by omitting the
parameter.

`next` being `null` means the walk is finished. There are no further rows.
A client should walk by following `next` until it is null, and should not
try to predict the number of pages from a count.

One page is one consistent snapshot, because it is one query. ACROSS pages
there is no snapshot. Rows written while a walk is in progress may appear
or not appear depending on where they land in the ordering, but a page
already walked never shifts under the client — the resume point is a
remembered position in the ordering rather than a row offset.

A schema rename between two pages of one walk invalidates any outstanding
token, because a token names the sort field by its schema name. The client
restarts from page one. This is by design rather than an accident.

Page tokens are checked for shape and for sort agreement. They are NOT
cryptographically signed. A client should not treat one as a capability or
as a secret, and a tampered token cannot widen what a caller may see,
because the caller's read permissions are applied to the query
independently of the resume point.

## The behavioural facts a driver will otherwise get wrong

These are the places where a reasonable guess about how the surface behaves
is wrong. Each one has bitten someone.

**There is no way to query for an absent value.** Putting `null` in a
filter is always an error. The server type-checks a filter value against
the field's declared kind before doing anything else, and `null` fails that
check on every kind. On a string, number, boolean, or datetime field the
answer is `TYPE_MISMATCH`. On an ENUM field the answer is `ENUM_INVALID`
instead, because an enum's check is membership in its declared value list
and `null` is not a member. Both are 400 responses in the invalid-request
family, but a client keying behaviour on the code needs to expect both. A
future operator meaning "has no value" would be an addition, which the hard
rule allows, and none exists today.

**A json field is neither filterable nor sortable.** Naming one in a filter
or in `sort` answers `UNKNOWN_FIELD` — the same code an entirely unknown
name answers. Nothing inside a json value can be queried at all. An
application that needs to select on something filters the page it pulled,
or promotes that something to its own scalar field.

**Instants have exactly one form on the wire.** A datetime value, whether
sent in a filter or in a write, must be a strict ISO-8601 UTC string:
a four-digit year, a two-digit month, a two-digit day, the letter `T`,
two-digit hours, minutes and seconds, optionally a dot followed by EXACTLY
three digits of fraction, and a literal `Z`.

```
2026-03-01T09:00:00Z
2026-03-01T09:00:00.000Z
```

A numeric offset such as `+01:00` is refused. So is a fraction with one,
two, or six digits. So is a calendar date that does not exist, such as the
thirtieth of February — the server checks that the instant prints back as
itself rather than quietly rolling over into the following month.

On the way OUT, every instant is printed with all three fraction digits,
always. So a value sent as `2026-03-01T09:00:00Z` reads back as
`2026-03-01T09:00:00.000Z`. A client comparing what it sent against what it
got must compare instants rather than strings.

**Booleans are booleans on the wire.** A boolean field is sent as JSON
`true` or `false`, and it reads back as JSON `true` or `false`. Underneath,
the storage engine holds them as 1 and 0, which is why an implementation
that talked to the storage directly would see numbers — but nothing on this
wire ever does. Sending 1 or the string `"true"` for a boolean field is a
`TYPE_MISMATCH`.

**Several operators on one field combine with AND.** Writing
`{"priority":{"$gte":3,"$lte":5}}` means both bounds must hold. So does
naming several fields. Every condition in a filter is AND-ed with every
other one.

**There is no or-combinator.** No `$or`, no `$not`, no nesting of any kind.
A client that needs alternatives issues more than one request. The one
shape that resembles alternatives is `$in`, which is a membership test on a
single field.

**A column with no value is omitted from a returned row entirely.** It is
not sent as `null`. If a row's optional `meta` field was never set, the
response object simply has no `meta` key. A driver must treat an absent key
as "this row has no value here" rather than as an error or as a missing
field in the schema. This is also true of `created_by`, which is absent on
any row created by an anonymous caller.

**A filter that is not valid JSON is still refused loudly.** The `where`
parameter is parsed as JSON, and a value that fails to parse is passed
through to the filter reader as raw text, which refuses it with
`INVALID_OPERATOR` because a filter must be an object. A client never gets
a silent empty filter out of a malformed `where`.

**An unmatched method is a 404, not a 405.** The surface admits exactly the
methods listed in the route tables. A method that is not on the list for a
path — a PUT to a row, say — answers 404 with `UNKNOWN_ENTITY`, which is
byte-identical to what an unknown entity name answers. That is deliberate:
probing the surface must not reveal what exists.

**A read miss is a bare 404, and it covers three different situations.**
Fetching a single row answers 404 with `TARGET_MISSING` when no such row
exists, when the row exists but the caller's read rule hides it, and when
the id in the path is not a legal row id. All three are identical on the
wire, so a probing client cannot use the surface to discover whether a
particular row exists. Updates and deletes aimed at an unreachable row
answer the same status and the same code — but not the same body. The two
bodies are set out in the verb sections below and flagged under "Open,
unruled" at the end.

**Rows a caller may not read are silently absent from a list.** They are
not an error and they are not a partial result. A caller permitted to see
nothing at all gets an empty page with a null `next`, which is
indistinguishable from an empty table. The matching case on the count route
is a plain zero.

**Server-managed fields may be read and filtered but never written.** Every
row of every entity carries four fields the server owns: `id`,
`created_at`, `updated_at`, and `created_by`. They appear in no schema
declaration and therefore in no schema response, but they are present on
every row a read returns. Naming one in a create or update body is refused
with `PROHIBITED_FIELD`, which is deliberately a different code from
`UNKNOWN_FIELD` — the field exists, it simply is not the client's to set.
The `users` entity that every project has carries one more, `mythwork_id`,
under the same rules.

**Row ids are integers.** They start at 1 in a freshly provisioned database
and rise. They are assigned by the server at insert and never change.

**An update clears an optional field by sending null for it.** Omitting a
field from an update body leaves it alone, and sending `null` for it clears
it. Sending `null` for a REQUIRED field is refused with
`REQUIRED_MISSING`, because a required field can be changed to another
valid value but never emptied.

**A create answers with the row as a later read would return it.** The 201
body is the full stored row, including the server-managed fields with the
values the server actually stamped. A client does not need to follow a
create with a read.

## Reading one row

```
GET /projects/{projectId}/entities/{entity}/{id}
```

The `{id}` segment is a row id: a whole number of 1 or more, assigned by
the server when the row was created. A client never chooses one and never
constructs one — it reads ids off the rows it has been given.

A hit answers 200 and the whole row. There is no projection on this route:
no field list, no include, no exclude. A row is always answered whole, in
the same form list answers it, so the two can be handled by one piece of
client code. The fields with no value are simply absent from the object.

A miss answers 404 with the code `TARGET_MISSING`, and it covers three
different situations that a client cannot tell apart:

- no row with that id has ever existed, or it has been deleted
- a row with that id exists, but the caller's read rule hides it
- the `{id}` segment is not a legal row id at all — a word, a negative
  number, a fraction

All three produce the same status and the same body, deliberately, so that
a client cannot use this route to discover whether a particular row exists.
There is no separate "malformed id" error, and asking for a row by a
nonsense id is not treated as a bad request.

The body of that miss is worth stating exactly, because it is NOT the same
body an update or a delete answers for the same unreachable row:

```json
{
  "error": {
    "type": "resource_missing",
    "code": "TARGET_MISSING",
    "message": "",
    "details": { "entity": "task" }
  }
}
```

`message` is the empty string here, and `details` carries the entity name
and nothing else. Compare that with the update and delete sections below.
The divergence is real, it is pinned by fixtures on both sides, and it is
listed under "Open, unruled" at the end of this document.

The typed form of what this route answers is `SchemaRow`, re-exported from
`get-row.v1.ts` beside this document.

## Creating a row

```
POST /projects/{projectId}/entities/{entity}
```

The body is a single JSON object of field names to values, carrying
DECLARED fields only. Success is 201, and the body is the full stored row:
the values as stored, plus the server-managed members with the values the
server actually stamped. A client never has to follow a create with a read
to learn the new row's id or its timestamps.

The typed form of the body is `CreateBody` in `create-body.v1.ts` beside
this document.

What the server does with the body, in the order it does it, because the
order decides which error a body with more than one problem gets:

1. The whole body is measured. Past the ceiling it is `REQUEST_TOO_LARGE`,
   before anything in it is looked at.
2. Any server-managed name in the body is `PROHIBITED_FIELD`.
3. Any remaining name the entity does not declare is `UNKNOWN_FIELD`.
4. Each field is checked against its own declaration — kind, enum
   membership, declared checks, size caps — and a missing required field
   with no declared default is `REQUIRED_MISSING`. Declared defaults are
   filled in at this point, and this is the only verb that fills them.
5. The entity's create rule is applied to the row about to be written. A
   refusal is `SCOPE_DENIED` at 403.

An omitted optional field is not an error. Its column simply holds nothing,
and the row that comes back has no key for it.

**Nothing is stamped in on the client's behalf.** When an entity's create
rule says that a DECLARED field must hold the caller's own id, the client
sends that field itself, with the id it got from the platform's auth
surface. Leaving it out does not make the server fill it in. Instead the
create is refused with `SCOPE_DENIED`, whose `details` names the field and
whose message says which field to send. The reason for refusing rather than
filling is that a rule of that shape is normally paired with a read rule of
the same shape, so a row created without the field would be invisible to
everyone the moment it was written — a ghost nobody can read, update, or
delete. One qualification: if the field the rule names is itself declared
required, the ordinary required-field check above runs first, so the answer
is `REQUIRED_MISSING` rather than `SCOPE_DENIED`.

**An anonymous create is legitimate.** If the entity's create rule admits
an anonymous caller, a request carrying no credential creates the row
normally. The row's `created_by` is then not set, which on the wire means
the key is absent from the row rather than present as null.

**An empty body is a legal request, and on some entities it is a legal
create.** A body of `{}` — and a request with no body at all, which is read
the same way — passes every check above on an entity that declares no
required field without a default. The row it makes carries the four
server-managed members and no declared field whatsoever. Whether that is
intended is listed under "Open, unruled" at the end of this document; it is
documented and pinned here as what the server actually does.

The pinned success cases for this verb are the seeded rows described under
"Seeding rows" below. A seed is an ordinary create, so the fixture set does
not carry a second set of create cases beside them.

## Updating a row

```
PATCH /projects/{projectId}/entities/{entity}/{id}
```

The body is a partial patch: only the fields it means to change. Success is
200 and the body is the full updated row — every field, not just the
changed ones — in exactly the form a later read of that row returns.

The typed form of the body is `PatchBody` in `update-patch.v1.ts` beside
this document.

The rules for what a patch means, member by member:

- A field the body does not name is left exactly as it was.
- A field the body names is REPLACED WHOLE with the value sent. That
  includes json fields: sending an object for a json field replaces the
  stored value entirely. Nothing is merged, at any depth.
- A field sent as `null` is CLEARED, if it is optional. After that the
  field is absent from the row rather than present as null.
- A REQUIRED field sent as `null` is refused with `REQUIRED_MISSING`. A
  required field can be changed to another valid value but never emptied.
- `updated_at` is restamped by the server on every accepted patch.
  `created_at` and `created_by` are never touched by an update.

The same body checks a create runs apply here in the same order — the size
ceiling, then server-managed names as `PROHIBITED_FIELD`, then unknown
names as `UNKNOWN_FIELD`, then each named field against its declaration.
Declared defaults do NOT run on an update: a default is a create-time
thing, so patching a field to nothing does not silently restore its
default.

Two separate permissions have to be satisfied, and they are checked in this
order. First the row has to be REACHABLE: the target is fetched under the
caller's read rule, and a row that is missing, hidden, or named by an
illegal id answers `TARGET_MISSING`. Then the entity's UPDATE rule is
applied, and a refusal is `SCOPE_DENIED` at 403.

The update rule is applied to the row AS IT CURRENTLY IS, never to the row
the patch would produce. Two consequences follow, and both are deliberate:

- A patch may change the very field the rule reads. If the rule says a row
  belongs to whoever the `owner_id` field names, its owner may hand the row
  to somebody else by patching `owner_id`. Handoff is a feature of this
  design, not an oversight.
- The same move is a one-way door. The moment that patch lands, the caller
  no longer satisfies the rule, so they cannot patch the row back. A client
  that offers this to a person should say so before doing it.

Where an entity's rule is of the kind that asks the caller to prove they
know a value, the value counts as proven when the patch itself carries it.
One correct value in the patch body serves both checks — it makes the row
visible to the fetch, and it satisfies the update gate.

A patch whose new value collides with a field the schema declares unique is
`UNIQUE_VIOLATION` at 409, naming the field — the same answer a create
gives for the same collision.

The update miss body differs from the read miss body shown further up:

```json
{
  "error": {
    "type": "resource_missing",
    "code": "TARGET_MISSING",
    "message": "No row this update can act on exists at this id …",
    "details": { "entity": "task", "verb": "update" }
  }
}
```

Same status, same code, a `verb` member the read miss does not carry, and a
full message where the read miss has an empty string. A client that branches
on `details.verb` will find it absent on a read miss. See "Open, unruled".

**An empty patch is accepted.** A body of `{}` — and a request with no body
at all, which is read the same way — answers 200 with the whole row, having
changed no declared field, and `updated_at` moves to the instant of the
request. So a patch that changes nothing is still a write: it takes the
update rule's permission check, it moves the timestamp, and any client
watching that timestamp will see the row as freshly touched. Whether that
should be a legal touch or a refusal is listed under "Open, unruled".

## Deleting a row

```
DELETE /projects/{projectId}/entities/{entity}/{id}
```

Success is 204 with no body at all. There is nothing to answer with: the
row is gone.

The delete is HARD. There is no soft-delete flag, no tombstone, no
archive, and no undo verb anywhere on this surface. A client that needs
removal to be recoverable models that itself, with a field of its own and a
filter that hides the rows it marks. Recovery below the application is the
platform's point-in-time recovery of the whole database, which is not a
row-level operation and not something a client can reach.

The same two permissions a patch needs are needed here, in the same order:
the row has to be reachable under the caller's read rule, and then the
entity's DELETE rule has to admit it. An unreachable row answers
`TARGET_MISSING`, in the same body shape the update miss uses, with `verb`
reading `delete`.

**Deleting the same id twice answers `TARGET_MISSING` the second time.** It
is not treated as already-done and it is not a silent success. That is the
same rule the whole surface follows: a write never quietly does nothing. A
client that wants delete to be idempotent treats that particular 404 as
success itself — it knows which id it asked for, and the server does not.

One row is deleted, and nothing else is touched. There is no cascade of any
kind: a row in another entity that carries this row's id in one of its
fields keeps carrying it, and that value now names a row that no longer
exists. Maintaining that is the application's job.

## The count route shares the filter half of list

`GET /projects/{projectId}/entities/{entity}/count` takes the `where`
parameter and nothing else. No sort, no paging, no limit. It answers a
plain body:

```json
{ "count": 12 }
```

It reads the `where` parameter with the same filter grammar the list route
uses, through the same one piece of server code, so a filter that works on
one works identically on the other and the two can never drift apart in
what they accept.

Count tallies only the rows the caller could actually have listed, so it
can never reveal more than paging through the list route would. A caller
permitted to see nothing gets zero.

Count is the whole of aggregation on this surface, permanently. There is no
sum, no average, no distinct count, and no grouping. A narrower tally is
expressed by narrowing the filter.

A filter this route refuses is refused in exactly the words the list route
uses for the same filter, and with the same code — an unknown field name,
a json field, an operator that does not exist, a null value. There is
nothing count-specific to get wrong, and nothing count-specific that can
drift.

The typed form of the answer is `CountResult` in `count-result.v1.ts`
beside this document. The request half is not written down twice: it is the
same `EntityFilter` the list route takes, in `list-query.v1.ts`.

## The error body

Every error, from every route, carries the same body:

```json
{
  "error": {
    "type": "invalid_request",
    "code": "INVALID_LIMIT",
    "message": "The limit parameter must be a whole number between 1 and 200; …",
    "details": { "limit": 201, "min": 1, "max": 200 }
  }
}
```

`type` is one of five broad families: `invalid_request`,
`authentication_error`, `permission_error`, `resource_missing`, and
`conflict`. A client that only wants to know how to react in general can
branch on this.

`code` is the precise machine-readable reason. A client that repairs
specific problems branches on this. Every code the surface can answer is
listed below, and the list is closed for this version — new codes may be
added, and no existing code will be renamed or repurposed.

`message` is plain English explaining what happened, why, and what the
caller should do about it. Its wording is not a stable interface and a
client must never parse it, but it is worth surfacing to a developer or
logging verbatim, because it is written to teach the repair.

`details` is a JSON object carrying the machine-readable specifics of this
particular failure, such as which field was at fault or which cap was hit.
Its members vary by code. A client should read a member it knows and ignore
the rest.

Errors raised in the platform layer in front of the database carry the same
four members, but with `message` as an empty string.

### The full code vocabulary, with the status each carries

| Code | Status | Family | What it means |
| --- | --- | --- | --- |
| `UNKNOWN_PROJECT` | 404 | `resource_missing` | The address names no reachable project. Covers a malformed id, an id failing its integrity check, and a project with no database — one code so probing cannot tell them apart. |
| `UNKNOWN_ENTITY` | 404 | `resource_missing` | No such entity in the published schema. Also the answer to a method the surface does not admit on that path. |
| `UNKNOWN_FIELD` | 400 | `invalid_request` | A filter, a sort, or a write body named a field that is not in the published schema — or named a json field where json is not allowed. |
| `TYPE_MISMATCH` | 400 | `invalid_request` | A value is not of the field's declared kind. |
| `INVALID_OPERATOR` | 400 | `invalid_request` | The filter is not an object, or names an operator that does not exist, or uses an operator on a field kind that does not admit it, or gives `$in` an empty or over-long list. |
| `INVALID_LIMIT` | 400 | `invalid_request` | `limit` is not a whole number inside its range. |
| `FILTER_TOO_COMPLEX` | 400 | `invalid_request` | The filter carries more conditions than `filterMaxConditions` allows. |
| `MALFORMED_BODY` | 400 | `invalid_request` | The request body is not parseable JSON, or parses to something other than a JSON object. |
| `INVALID_STARTING_AFTER` | 400 | `invalid_request` | The page token is damaged, from an older format, or was minted under a different sort than this request asks for. |
| `REQUIRED_MISSING` | 400 | `invalid_request` | A create omitted a required field that declares no default, or an update tried to clear a required field. |
| `CHECK_FAILED` | 400 | `invalid_request` | A number failed a check the schema declares on that field, such as a bound or whole-number-ness. |
| `ENUM_INVALID` | 400 | `invalid_request` | A value is not one of an enum field's declared options. |
| `VALUE_TOO_LARGE` | 400 | `invalid_request` | One value exceeds its own field's size cap. |
| `VALUE_TOO_DEEP` | 400 | `invalid_request` | A json value nests deeper than the depth cap. |
| `REQUEST_TOO_LARGE` | 413 | `invalid_request` | The whole request body exceeds the per-row ceiling, `maxRowBytes`. |
| `PROHIBITED_FIELD` | 400 | `invalid_request` | A write body named a server-managed field. The field exists; it is not the client's to set. |
| `TARGET_MISSING` | 404 | `resource_missing` | A single-row read or write names a row the caller cannot reach. Covers no such row, a row hidden by the read rule, and a malformed id — identically. |
| `UNAUTHORIZED` | 401 | `authentication_error` | A credential was presented and did not verify. Presenting none is anonymous, not this. |
| `SCOPE_DENIED` | 403 | `permission_error` | The caller is not permitted to perform this write on this row. |
| `UNIQUE_VIOLATION` | 409 | `conflict` | A row already holds this value for a field the schema declares unique. `details` names the field. |
| `PUBLISH_FORBIDDEN` | 403 | `permission_error` | The caller may not publish this project's schema. Publishing is the owner's act. |
| `PUBLISH_BLOCKED` | 400 | `invalid_request` | The declaration is refused outright. `details.violations` lists every problem found, each teaching its own repair. No approval can unblock it and nothing was applied. |
| `PENDING_APPROVAL` | 409 | `conflict` | The publish plans a change that destroys or restricts, and needs the owner's answer. `details.cards` describes each one. Nothing was applied. The retry is the same publish carrying the approved ids. |
| `PUBLISH_CONFLICT` | 409 | `conflict` | Another publish landed while this one was being prepared, so this plan no longer describes the current schema. Nothing was applied. Fetch the schema and retry. |

The codes themselves are defined once, in `wire-errors.v1.ts` beside this
document. The status and family each one carries are decided once, in
`engine/errors.ts`.

## Seeding rows: the interim contract

Seeding means loading a set of starting rows into a project's database —
the rows a freshly built application opens with.

The contract for it today is simply the create verb, used repeatedly. To
seed N rows, a client makes N separate requests:

```
POST /projects/{projectId}/entities/{entity}
```

One row per request. Each one answers 201 with that row's full stored form,
including its assigned id and the server-managed fields. Each one is
independent: there is no shared transaction across the set, and a failure
part-way through leaves the rows already created in place.

**There is no bulk create verb, and whether there should be one is an open
question that has not been ruled on.** It is not merely unimplemented — the
decision itself has not been made. Nothing in this contract, in the types
beside it, or in the pinned fixtures implies that such a verb exists or is
coming. A client that needs to seed rows today issues one request per row.

## Where the pinned fixtures live

The exact requests and the exact responses described above are frozen as
plain JSON, beside the suite that runs them:

```
workers/api/src/projectdb/host/wire-contract-fixtures/
```

That directory has its own README explaining the case file layout and the
one placeholder a fixture may contain. The suite that runs every case
against the real Durable Object is
`workers/api/src/projectdb/host/wire-contract.workerd.test.ts`.

Those files are this repository's drift guard, not a shared artifact: they
exist so nothing described above can change without a test here failing.
A client written elsewhere codifies the contract from this document and
pins it with its own fixtures in its own tree. There is no shared fixture
location between repositories and no vendored copy of this directory. The
TypeScript types beside this document ARE exported, however: they ship in
the published `@mythwork/protocol` package under its `./contract/*` export
paths, so a TypeScript client imports them instead of re-declaring them.
This document itself is excluded from that package's published files.

## Open, unruled

These are things this document deliberately does not settle. Each one is
open rather than merely undocumented, and none of them should be decided by
reading between the lines here.

**A bulk seed verb.** Whether the surface should grow a verb that creates
many rows in one request has not been ruled on. See the seeding section
above.

**A version marker on this wire.** The responses described here carry no
format-version marker of any kind. That is a knowing gap rather than an
oversight, and the reason is a collision between two rules the project
already holds. The versioning policy says that everything serialized
carries a small `v` naming its own format version, and every serialized
thing in the system does — the entity file, the stored schema record, the
page token. But the same policy also holds that a wire version marker for
the whole data plane belongs to the surface as a whole rather than to one
response at a time, and no such surface-wide marker has been decided.
Putting a marker on a single response body now could collide with whatever
that surface-wide marker turns out to be, so it is absent and flagged here
rather than guessed at.

**The split between a short message and a teaching hint.** The `message`
member of an error body today carries the full teaching explanation
verbatim. Whether it should eventually be split into a short summary plus a
separate longer hint is settled with the client SDK, not here. A client
should treat `message` as human-facing prose either way and never parse it.

**Whether the operator set widens, and how.** The five operators above are
deliberately fewer than comparable products offer, and the set is expected
to grow as real applications justify particular additions. Which additions,
and in what order, is not decided. An operator meaning "has no value" is
the most obviously missing one, given that `null` in a filter is always an
error today.

**Naming grammar for entities and fields, as documented versus as
enforced.** What the server enforces is lowercase snake_case, at most 64
characters, beginning with a letter. The type file that describes entity
names carries an older comment sketching a capitalised grammar that nothing
uses. The enforced grammar is the one above; reconciling the stale comment
is somebody's cleanup, not a contract change.

**One unreachable row, two different error bodies.** All three
row-addressed verbs answer 404 with the code `TARGET_MISSING` when the row
cannot be reached, but the body is not the same one. A read miss carries
`details` of `{ "entity": "<name>" }` and an EMPTY `message`. An update or
delete miss carries `details` of `{ "entity": "<name>", "verb": "update" }`
or `"delete"`, and a full plain-English message. The two are produced by
two different pieces of the server, and no reason for the difference is
written down anywhere. It matters to a client twice over: a driver that
branches on `details.verb` finds it absent on a read miss, and the empty
message is the only error the database itself raises that does not carry
the explanation every other one carries. Both shapes are pinned by fixtures
exactly as they are. Unifying them would change bytes a client may already
be reading, which is a decision this document does not make.

**Whether an empty patch should be a legal touch.** A PATCH carrying `{}`,
or no body at all, is accepted today: it answers 200 with the whole row, it
changes no declared field, and it moves `updated_at` to the instant of the
request. There is an argument for it — it is a deliberate "mark this row as
touched" with no field to change — and an argument against it, that a
client which sends an accidental empty body silently ages a row that any
sync or cache keyed on `updated_at` will then re-fetch. Which of those the
surface means has not been ruled on. The behaviour is pinned as it stands.

**What credential a publisher must carry.** Publishing is decided by the
operation and against the owner id the database recorded at birth, and
that much is settled. The credential a publisher presents to get that far
is not: it has to be a minted one, since this surface takes nothing else,
but which mint, carrying what, has not been ruled on. Until it is, the
publish routes in this document are not callable over the wire, and the
machinery behind them is exercised below the wire instead. A client should
treat the three publish routes as described-but-not-yet-open.

**Whether the owner a database remembers can fall out of step with the
platform's own record.** A database records the id of the project's owner
once, when the database is created, and never changes it. Publishing is
decided against that recorded id. The platform separately records who owns
a project, in its membership table, and that is what every other
project-scoped route reads. Today the two cannot disagree: the membership
row is written once, when the project is created, and no route changes a
member's role or moves a project to a different owner — a remix makes a new
project with a new database of its own. So the risk is latent rather than
live. But nothing re-reads the platform's record after a database is born,
and nothing detects a disagreement, so if the platform ever grows a way to
transfer a project, the database would go on answering to the original
owner with no sign that anything was wrong. What should happen in that case
has not been ruled on.

**Whether an empty create body should make a row.** On an entity that
declares no required field without a default, a POST carrying `{}`, or no
body at all, creates a row. That row has the four server-managed members
and no declared field at all, so on the wire it reads as an object of `id`,
`created_at`, `updated_at`, and `created_by` and nothing else. Whether a
row with no content of its own is a thing an application should be able to
make by accident has not been ruled on. It is pinned as it stands.
