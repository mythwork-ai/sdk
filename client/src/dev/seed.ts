// Generic seed fixtures for the SDK dev host.
//
// All data is authored directly as wire shapes (AppSummary, AppDetail,
// MakerSummary, etc.) — the SDK has no knowledge of any app-specific item
// type. Tags are varied across apps so tag-filter, sort, and search are
// fully demonstrable out of the box.

import type {
  AppDetail,
  AppSummary,
  CollectionInfo,
  CommentNode,
  MakerSummary,
  NotificationPrefs,
  SpotlightItem,
  TagCount,
} from '@mythwork/protocol'

// ── epoch helpers ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000

/** Epoch ms for "N days ago". */
function daysAgo(n: number): number {
  return Date.now() - n * DAY_MS
}

// ── makers ─────────────────────────────────────────────────────────────────

export const SEED_MAKERS: MakerSummary[] = [
  {
    handle: 'devuser',
    displayName: 'Dev User',
    appCount: 3,
    totalLaunches: 2_054_000,
    bio: 'Building small tools that grow your reputation while you sleep.',
    location: 'San Francisco, CA',
    link: 'devuser.example.com',
  },
  {
    handle: 'amara',
    displayName: 'Amara Okafor',
    appCount: 2,
    totalLaunches: 1_200_100,
    bio: 'Automation-first, always.',
    location: 'Lagos, NG',
  },
  {
    handle: 'priya',
    displayName: 'Priya Nair',
    appCount: 2,
    totalLaunches: 1_400_000,
    bio: 'I make systems that own you back.',
    location: 'Bangalore, IN',
    link: 'priya.dev',
  },
  {
    handle: 'leo',
    displayName: 'Leo Marsh',
    appCount: 2,
    totalLaunches: 882_000,
    bio: 'Forking should feel like a compliment.',
  },
  {
    handle: 'kai',
    displayName: 'Kai Mori',
    appCount: 1,
    totalLaunches: 88_000,
    bio: 'Sometimes the brief is "surprise me".',
    location: 'Tokyo, JP',
  },
]

// ── apps (AppSummary) ──────────────────────────────────────────────────────

export const SEED_APPS: AppSummary[] = [
  {
    projectId: 'app_dev_001',
    alias: 'app_dev_001',
    name: 'Carpool Autopilot',
    tagline: 'The carpool that just… runs itself.',
    maker: { handle: 'devuser', displayName: 'Dev User' },
    tags: ['Automation', 'Family'],
    launches: 5_400_000,
    publishedAt: daysAgo(2),
    theme: 'coral',
    editorsChoice: true,
    rating: { average: 4.8, count: 12_400 },
    trendPct: 32,
  },
  {
    projectId: 'app_dev_002',
    alias: 'app_dev_002',
    name: 'Duct Tape Killer',
    tagline: 'Stop being the glue between four tools.',
    maker: { handle: 'amara', displayName: 'Amara Okafor' },
    tags: ['Productivity', 'Workflow'],
    launches: 1_400_000,
    publishedAt: daysAgo(5),
    theme: 'meadow',
    editorsChoice: false,
    rating: { average: 4.6, count: 8_900 },
    trendPct: 18,
  },
  {
    projectId: 'app_dev_003',
    alias: 'app_dev_003',
    name: 'Remix Forge',
    tagline: 'Tools that grow your name while you sleep.',
    maker: { handle: 'devuser', displayName: 'Dev User' },
    tags: ['Creator', 'Social'],
    launches: 482_300,
    publishedAt: daysAgo(1),
    theme: 'violet',
    badge: 'new',
    editorsChoice: false,
    rating: { average: 4.9, count: 1_240 },
    trendPct: 140,
  },
  {
    projectId: 'app_dev_004',
    alias: 'app_dev_004',
    name: 'Shipped This Week',
    tagline: 'What did I even ship this week?',
    maker: { handle: 'priya', displayName: 'Priya Nair' },
    tags: ['Dashboard', 'Productivity'],
    launches: 309_000,
    publishedAt: daysAgo(9),
    theme: 'ocean',
    editorsChoice: false,
    rating: { average: 4.5, count: 3_400 },
    trendPct: 12,
  },
  {
    projectId: 'app_dev_005',
    alias: 'app_dev_005',
    name: 'Follow-up Fairy',
    tagline: 'The follow-ups you keep dropping, caught.',
    maker: { handle: 'amara', displayName: 'Amara Okafor' },
    tags: ['Automation', 'Productivity'],
    launches: 223_800,
    publishedAt: daysAgo(12),
    theme: 'sunset',
    editorsChoice: false,
    rating: { average: 4.7, count: 5_600 },
    trendPct: 8,
  },
  {
    projectId: 'app_dev_006',
    alias: 'app_dev_006',
    name: 'Legend Engine',
    tagline: 'Become the one others remix.',
    maker: { handle: 'leo', displayName: 'Leo Marsh' },
    tags: ['Creator', 'Social'],
    launches: 9_000_000,
    publishedAt: daysAgo(4),
    theme: 'legend',
    badge: 'legend',
    editorsChoice: true,
    rating: { average: 5.0, count: 41_000 },
    trendPct: 24,
  },
  {
    projectId: 'app_dev_007',
    alias: 'app_dev_007',
    name: 'Spreadsheet Rescue',
    tagline: 'The spreadsheet held together with hope — fixed.',
    maker: { handle: 'priya', displayName: 'Priya Nair' },
    tags: ['Productivity', 'Data'],
    launches: 181_200,
    publishedAt: daysAgo(7),
    theme: 'meadow',
    editorsChoice: false,
    rating: { average: 4.4, count: 2_100 },
    trendPct: 6,
  },
  {
    projectId: 'app_dev_008',
    alias: 'app_dev_008',
    name: 'Tonight Builder',
    tagline: 'It built itself tonight. You woke up to less.',
    maker: { handle: 'devuser', displayName: 'Dev User' },
    tags: ['Automation', 'Workflow'],
    launches: 600_100,
    publishedAt: daysAgo(3),
    theme: 'coral',
    editorsChoice: false,
    rating: { average: 4.8, count: 9_800 },
    trendPct: 51,
  },
  {
    projectId: 'app_dev_009',
    alias: 'app_dev_009',
    name: 'Remix Gallery',
    tagline: 'Fork anything. Make it yours.',
    maker: { handle: 'leo', displayName: 'Leo Marsh' },
    tags: ['Creator', 'Social'],
    launches: 441_500,
    publishedAt: daysAgo(6),
    theme: 'violet',
    editorsChoice: false,
    rating: { average: 4.6, count: 3_900 },
    trendPct: 22,
  },
  {
    projectId: 'app_dev_010',
    alias: 'app_dev_010',
    name: 'Surprise Me',
    tagline: "Bold. Let's see what you make.",
    maker: { handle: 'kai', displayName: 'Kai Mori' },
    tags: ['Creator', 'Data'],
    launches: 88_000,
    publishedAt: daysAgo(0),
    theme: 'sunset',
    badge: 'new',
    editorsChoice: false,
    rating: { average: 4.3, count: 410 },
    trendPct: 88,
  },
]

// ── app details (AppSummary + makersNote + remixCount) ─────────────────────

/** Makers' notes keyed by projectId. */
const MAKERS_NOTES: Record<string, string> = {
  app_dev_001:
    'Three families, one group chat, and a spreadsheet nobody trusted. Carpool Autopilot watches calendars and just decides who drives — then tells everyone.',
  app_dev_002:
    'I was the integration between four tools that refused to talk. This is the glue, automated — so you can stop being the human API.',
  app_dev_003:
    'Every good idea deserves ten variations. Remix Forge spins a single build into a family of remixable starts, so your best work keeps shipping itself.',
  app_dev_004:
    "I kept ending Fridays unsure what I'd actually done. This pulls your week into one honest screen.",
  app_dev_005: 'The deals I lost were never the pitch — they were the follow-up I forgot.',
  app_dev_006:
    'I wanted to build a reputation, not just a backlog. Legend Engine turns the things you make into compounding building blocks others remix.',
  app_dev_007:
    "There's always one spreadsheet holding the business together with hope and merged cells.",
  app_dev_008:
    'Describe it before bed; wake up to a working draft. Tonight Builder does the unglamorous overnight assembly.',
  app_dev_009:
    'Forking should feel like a compliment, not theft. Remix Gallery makes every app a starting point.',
  app_dev_010: 'Sometimes the brief is "I don\'t know, surprise me." So I built exactly that.',
}

export function appSummaryToDetail(summary: AppSummary): AppDetail {
  return {
    ...summary,
    makersNote: MAKERS_NOTES[summary.projectId],
    remixCount: Math.max(1, Math.round(summary.rating.count / 3)),
  }
}

// ── tags ───────────────────────────────────────────────────────────────────

/** All tags, ordered by app count (most common first). */
export const SEED_TAG_COUNTS: TagCount[] = (() => {
  const counts = new Map<string, number>()
  for (const app of SEED_APPS) {
    for (const tag of app.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }))
})()

// ── spotlight ──────────────────────────────────────────────────────────────

export const SEED_SPOTLIGHT: SpotlightItem = {
  projectId: 'app_dev_006',
  kicker: 'App of the day',
  headline: 'The tool that makes other makers jealous',
  blurb:
    'Legend Engine turns one good idea into a body of work — remixable building blocks that compound your reputation while you sleep.',
}

// ── collections ────────────────────────────────────────────────────────────

export const SEED_COLLECTIONS: CollectionInfo[] = [
  {
    id: 'automate-week',
    title: 'Automate your week',
    blurb: 'Set-and-forget tools that quietly do the boring parts.',
    tags: ['Automation', 'Workflow'],
    theme: 'coral',
  },
  {
    id: 'creator-toolkit',
    title: 'Creator toolkit',
    blurb: 'Grow your name and remix what already works.',
    tags: ['Creator', 'Social'],
    theme: 'violet',
  },
  {
    id: 'get-it-together',
    title: 'Get it together',
    blurb: 'Dashboards and systems for the perpetually scattered.',
    tags: ['Productivity', 'Dashboard'],
    theme: 'ocean',
  },
]

// ── popular searches ───────────────────────────────────────────────────────

export const SEED_POPULAR_SEARCHES: string[] = [
  'automation',
  'remix',
  'dashboard',
  '#Productivity',
  'follow-up',
  '@devuser',
  'spreadsheet',
]

// ── seed comments ──────────────────────────────────────────────────────────

/** Pre-seeded comments for a couple of apps (keyed by projectId). */
export const SEED_COMMENTS: Record<string, CommentNode[]> = {
  app_dev_001: [
    {
      id: 'sc-c1',
      author: { handle: 'amara', displayName: 'Amara Okafor' },
      body: 'The calendar-watching part is witchcraft. We dropped our carpool spreadsheet entirely.',
      createdAt: daysAgo(0) - 6 * 3_600_000,
      replies: [],
    },
    {
      id: 'sc-c2',
      author: { handle: 'priya', displayName: 'Priya Nair' },
      body: 'Would love a way to handle last-minute swaps — otherwise flawless.',
      createdAt: daysAgo(3),
      replies: [
        {
          id: 'sc-c2r1',
          author: { handle: 'devuser', displayName: 'Dev User' },
          body: 'On the roadmap! Shipping a one-tap swap request next week.',
          createdAt: daysAgo(2),
        },
      ],
    },
  ],
  app_dev_006: [
    {
      id: 'sc-c3',
      author: { handle: 'amara', displayName: 'Amara Okafor' },
      body: 'Remixed this into a changelog generator in an afternoon. The building-block structure is genuinely smart.',
      createdAt: daysAgo(1),
      replies: [
        {
          id: 'sc-c3r1',
          author: { handle: 'leo', displayName: 'Leo Marsh' },
          body: "Love that — drop a link, I'll feature it in the remix gallery.",
          createdAt: daysAgo(0) - 2 * 3_600_000,
        },
      ],
    },
    {
      id: 'sc-c4',
      author: { handle: 'kai', displayName: 'Kai Mori' },
      body: 'Okay the 5.0 rating is not a fluke. Opened it expecting hype, stayed for the remix tree.',
      createdAt: daysAgo(4),
      replies: [],
    },
  ],
}

// ── default notification prefs ─────────────────────────────────────────────

export const DEFAULT_NOTIF_PREFS: NotificationPrefs = {
  comments: true,
  remixes: true,
  followers: true,
  weeklyDigest: false,
}

// ── search helpers ─────────────────────────────────────────────────────────

/**
 * Fuzzy-match `query` against `text` as an ordered subsequence. Returns a
 * relevance score (higher is better) or `null` when no match. Ported from the
 * explore app's proven implementation.
 */
function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 0

  let from = 0
  let score = 0
  let streak = 0

  for (const ch of q) {
    const at = t.indexOf(ch, from)
    if (at === -1) return null
    streak = at === from ? streak + 1 : 0
    let points = 1 + streak
    const prev = t[at - 1]
    if (at === 0 || prev === ' ' || prev === '-' || prev === '_') points += 4
    score += points - (at - from) * 0.2
    from = at + 1
  }
  return score + q.length / t.length
}

function bestFieldScore(fields: string[], token: string): number | null {
  let best: number | null = null
  for (const field of fields) {
    const s = fuzzyScore(field, token)
    if (s !== null && (best === null || s > best)) best = s
  }
  return best
}

/**
 * Score an AppSummary against a free-form query. Tokens are AND-ed; `@handle`
 * targets maker, `#tag` targets tags, bare tokens match any field. Returns the
 * summed score or `null` if the app doesn't match. Empty query → score 0.
 */
export function appSearchScore(app: AppSummary, query: string): number | null {
  const q = query.trim()
  if (!q) return 0
  let total = 0
  for (const token of q.split(/\s+/)) {
    let term = token
    let fields: string[]
    if (token.startsWith('@')) {
      term = token.slice(1)
      fields = [app.maker.handle, app.maker.displayName]
    } else if (token.startsWith('#')) {
      term = token.slice(1)
      fields = app.tags
    } else {
      fields = [app.name, app.tagline, app.maker.handle, app.maker.displayName, ...app.tags]
    }
    if (!term) continue
    const score = bestFieldScore(fields, term)
    if (score === null) return null
    total += score
  }
  return total
}

/**
 * Score a MakerSummary against a query (name + handle). Returns summed score
 * or `null`. Empty query → score 0.
 */
export function makerSearchScore(maker: MakerSummary, query: string): number | null {
  const q = query.trim()
  if (!q) return 0
  let total = 0
  for (const token of q.split(/\s+/)) {
    const term = token.startsWith('@') ? token.slice(1) : token
    if (!term) continue
    const score = bestFieldScore([maker.displayName, maker.handle], term)
    if (score === null) return null
    total += score
  }
  return total
}

/** Apps related to the given projectId: share a tag, different app, by launches desc. */
export function relatedApps(projectId: string, limit = 3): AppSummary[] {
  const source = SEED_APPS.find(a => a.projectId === projectId)
  if (!source) return []
  return SEED_APPS.filter(
    a => a.projectId !== projectId && a.tags.some(t => source.tags.includes(t)),
  )
    .sort((a, b) => b.launches - a.launches)
    .slice(0, limit)
}

/** The top-N trending apps by trendPct descending. */
export const SEED_TRENDING: AppSummary[] = [...SEED_APPS]
  .sort((a, b) => (b.trendPct ?? 0) - (a.trendPct ?? 0))
  .slice(0, 6)
