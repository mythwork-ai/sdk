// The single home of every engine-wide tunable. No other file declares a cap
// literal. These are plain constants today; the plan of record is to swap the
// backing for dynamically managed config later, without touching a call site.
//
// THE RULE FOR THIS FILE: every value carries a comment, and every comment
// carries the same three things, so the eventual move to dynamic config is a
// transcription rather than an investigation.
//
//   1. SCOPE — the narrowest level this value could ever legitimately vary
//      by, once it is dynamically managed: global (one value everywhere), by
//      environment (local, staging, production), or by project (per customer
//      project, e.g. a plan that buys larger pages). Scope is what it COULD
//      vary by, not what it does today; today every value is global because
//      the file is constants.
//   2. WHETHER IT IS CONFIG IN PERPETUITY — some values are permanent policy
//      dials, some exist only until a specific piece of work lands and then
//      become fixed or disappear. Say which, and if it is temporary, say what
//      ends it.
//   3. THREE SENTENCES — what product use case the value serves, whether it
//      stays config, and what the current number actually means and why it
//      was chosen.
//
// AND THE MATCHING RULE EVERYWHERE ELSE: no other file states one of these
// numbers on its own. A comment that needs to mention a limit names the key
// and quotes today's value as a courtesy — "jsonMaxBytesDefault (currently:
// 64_000)" — so that when the backing goes dynamic, a stale number in a
// comment somewhere is never mistaken for the actual limit.

export const config = {
  // SCOPE: global. PERPETUITY: permanent, and pinned to platform reality
  // rather than to our preference.
  // Protects every project's database from a single write large enough to
  // destabilize the row storage underneath it, which is the failure mode a
  // caller cannot recover from on their own. This stays config forever
  // because the underlying storage ceiling belongs to the platform and can
  // move without us. Two million bytes is that platform row ceiling, used
  // here as the gate on a whole request body, so a request is refused from
  // its byte length alone before anything parses it.
  maxRowBytes: 2_000_000,

  // SCOPE: global. PERPETUITY: permanent policy dial.
  // Gives every declared text field a sane ceiling when the modelling agent
  // does not state one, so an app cannot accidentally accept unbounded input
  // into a field meant to hold a name or a title. It stays config because the
  // right default is a product judgement that will move as we watch what real
  // apps store. A thousand and twenty-four characters comfortably holds
  // titles, names, and short notes, and anything longer is a deliberate
  // choice the agent should have to write down as a maxLength.
  stringMaxLengthDefault: 1024,

  // SCOPE: global. PERPETUITY: permanent, and bounded by the row ceiling
  // above.
  // Bounds how far a modelling agent may raise a single text field's limit,
  // so one long-text field cannot consume the entire row budget and leave no
  // room for the rest of the entity. It stays config because it must move in
  // step with the row ceiling. One million bytes sits an order of magnitude
  // under that ceiling, which leaves headroom for every other column plus the
  // server stamps on the same row.
  stringMaxLengthCap: 1_000_000,

  // SCOPE: global. PERPETUITY: permanent policy dial.
  // Caps the json field kind, which is the one place an app can put a shape
  // the engine does not otherwise constrain, so a single document cannot grow
  // until reads and writes on that entity become slow for everyone using the
  // project. It stays config for the same reason as the string default: the
  // right number is a product judgement. Sixty-four thousand bytes holds the
  // realistic uses — a list of participant ids, a settings blob — while
  // staying far below the row ceiling.
  jsonMaxBytesDefault: 64_000,

  // SCOPE: global. PERPETUITY: permanent policy dial.
  // Bounds how many options one enum field may declare, which keeps a
  // generated literal union readable in an app's own editor and keeps an
  // approval card able to show what actually changed when options move. It
  // stays config because the right ceiling is a modelling judgement we will
  // revisit as real apps arrive. Sixty-four options is far more than any
  // status or category list needs, so reaching it is a sign the values
  // wanted to be rows in their own entity rather than a fixed set.
  enumMaxValues: 64,

  // SCOPE: global. PERPETUITY: permanent guard rail.
  // Stops deeply nested json from reaching storage, both because validating
  // and serializing it costs time on every write and because deep nesting is
  // a sign the data wanted to be its own entity. It stays config so the
  // number can relax if real apps prove a legitimate need. Sixteen levels is
  // far past anything a well-modelled app produces, so hitting it is a
  // modelling signal rather than a limit a normal app brushes against.
  jsonMaxDepth: 16,

  // SCOPE: global; plausibly by project later, since a heavier plan could
  // justify a longer list. PERPETUITY: permanent policy dial.
  // Bounds a single one-of filter, which is the only query shape whose cost
  // grows with what the caller sends, so one request cannot make the database
  // scan an unbounded set of values. It stays config because the ceiling is a
  // performance judgement that depends on how the storage behaves under real
  // load. A hundred values covers the honest uses, such as fetching the rows
  // belonging to a page of ids the client already holds.
  inListMax: 100,

  // SCOPE: global. PERPETUITY: permanent guard rail, and its floor is
  // pinned to platform reality.
  // Bounds how many CONDITIONS one filter may carry. Every non-list
  // condition is one bind variable in the page statement, and the runtime
  // caps a statement at 100 bind variables (measured at the skeleton
  // increment's spike; workerd's own source sets the limit) — so an
  // unbounded filter could compose an unrunnable statement. Thirty-two
  // conditions is far past any honest screen's filter while keeping the
  // whole statement's bind count comfortably under the runtime cap.
  filterMaxConditions: 32,

  // SCOPE: global. PERPETUITY: permanent guard rail, floor pinned to
  // platform reality.
  // The runtime's per-table column ceiling, measured at the skeleton
  // increment's spike (the 101st column is refused; workerd's own source
  // sets SQLITE_LIMIT_COLUMN to exactly this). Never enforced directly —
  // the per-entity declared-fields cap is DERIVED from it by subtracting
  // the server-managed column count, so the two always sum back to this
  // number and the enforcing site knows every count involved.
  runtimeMaxColumns: 100,

  // SCOPE: global. PERPETUITY: permanent language rule.
  // Caps how many rules one verb's any-of list may carry. The list is the
  // access language's only combinator, and an unbounded one turns a
  // declaration into a rule program — four branches covers every honest
  // policy we have modelled while keeping "is this change wider?" readable
  // on an approval card.
  accessRuleListMax: 4,

  // SCOPE: global; plausibly by project later. PERPETUITY: permanent product
  // default.
  // Decides how many rows a list call returns when the app does not ask for a
  // number, which is most calls an agent writes, so it silently sets the
  // shape of nearly every screen in every generated app. It stays config
  // because it is a product default we will tune as we see real usage. Fifty
  // rows fills a typical list view with room to spare while keeping the
  // response small enough to feel instant.
  pageLimitDefault: 50,

  // SCOPE: global; plausibly by project later. PERPETUITY: permanent policy
  // dial.
  // Bounds what an app may ask for in one page, so a generated app cannot
  // paper over missing pagination by requesting everything at once and
  // stalling itself. It stays config because it trades response size against
  // round trips, which will shift as apps get heavier. Two hundred is four
  // times the default, which is enough for a deliberate bulk view while still
  // forcing genuinely large reads through pagination.
  pageLimitMax: 200,

  // SCOPE: by environment, and the clearest candidate for it in this file —
  // a local stack wants minutes where production wants days. PERPETUITY:
  // permanent, but the value is a guess until we watch real building
  // sessions.
  // Bounds how long a project's dev database survives without use before the
  // idle alarm deletes it, and it arms only on the dev behavior, since a prod
  // instance carries no alarm at all. The instance's ordinary lifetime is
  // pinned to the mythwork job that owns it, one to two days, so this window
  // only exists to catch the case where that job's own deletion never
  // arrives. Seven days in milliseconds sits comfortably past the longest job
  // without keeping an abandoned project's data alive indefinitely.
  devIdleLifetimeMs: 604_800_000,
} as const
