# AIB Brokerage Analyst

An AI analyst that reads Agostini Insurance Brokers' book of business, finds where clients are
under-covered or under-served, and prepares the account executive for the conversation.

It answers the question a broker asks every morning — *who should I call, and what do I say?* — with
findings tied to actual policy and claims records rather than to a general sense of what clients
usually need.

```
npm install
npm run generate:sample      # synthetic book, no real client data
npm run opportunities        # ranked findings — no API key needed
npm run serve                # broker console at localhost:4000
```

---

## How it works

There are two layers, and keeping them separate is the most important design decision here.

**The rules engine** reads the book and produces candidate findings. It is ordinary code: a
property policy whose sum insured has not been revised since 2019, a health plan with fourteen
declined dental claims, a client whose peers all carry cyber cover and who does not. Every finding
carries the record identifiers that justify it. This layer is deterministic, testable, and can be
argued with by the broking team without anyone mentioning artificial intelligence.

**The analyst** is Claude, with read-only tools over the same book. It takes the candidates, goes
and checks them, forms a view about which are worth acting on, discards the ones that do not hold
up, raises things the rules missed, and writes it up for a specific account executive preparing for
a specific meeting.

The model never originates a coverage fact. It cannot tell you a client has no flood cover unless a
policy record says so. That constraint is what makes the output usable in a regulated brokerage:
every recommendation traces back to a record, and the broker can go and look.

```
policy admin system ──▶ adapter ──▶ Book ──┬──▶ rules engine ──▶ candidates ──┐
                                            │                                  ├──▶ analyst ──▶ brief
                                            └──▶ read-only tools ──────────────┘
```

---

## Connecting the real book

Everything reads from one shape, defined in [`src/data/schema.js`](src/data/schema.js): clients,
policies, members, claims. Three adapters ship:

| `BOOK_SOURCE` | What it reads |
|---|---|
| `sample` | The bundled synthetic book. Default. |
| `json` | A single JSON file at `BOOK_PATH` matching the schema. |
| `csv` | A directory at `BOOK_PATH` holding `clients.csv`, `policies.csv`, `members.csv`, `claims.csv`. |
| `ibr` | AIB's IBR transaction register, exported to CSV at `BOOK_PATH`. |

```
BOOK_SOURCE=ibr BOOK_PATH=./ibr.csv npm run opportunities
```

The register is billing data, not a policy master: one row per invoice line, several per policy,
plus taxes, fees and reversals. The adapter filters to premium-bearing transaction codes, drops
reversals, collapses transactions into policy terms and terms into policies, and learns AIB's own
92 line codes rather than expecting the ones invented here. On the live register it turns 61,605
rows into 10,728 clients and 14,924 policies.

Pointing this at the live book is the whole integration. Export the four tables, match the column
names in the schema, and everything downstream works unchanged. `validateBook()` runs on load and
reports orphaned references, duplicate keys and missing dates before the analyst sees anything —
run it against a real export early, because the answers it gives about data quality are useful in
their own right.

The fields that do the most work, in rough order:

- `policies.renewalDate` — drives every timing decision. Without it nothing is prioritised well.
- `claims.status` and `claims.declineReason` — the strongest cross-sell signal in the book. A
  declined dental claim is a client telling you what they need.
- `policies.sumInsuredSetAt` — when the sum insured was last revised, which is how under-insurance
  gets found. If this is not held anywhere, `inceptionDate` is a weak substitute.
- `policies.administrator` — who administers a health plan. Match the value to `AIB_TPA_NAME`
  so the administration rules can tell your TPA apart from a carrier or a self-administered plan.

Personal-lines-only or benefits-only books work fine; rules that have nothing to read return
nothing.

---

## What it looks for

Twenty-two rules across four families. All of them live in
[`src/engine/rules.js`](src/engine/rules.js) and are meant to be edited by whoever knows the
Trinidad and Tobago market best.

**Adequacy** — cover that exists but has fallen behind: sums insured last revised years ago and now
short of replacement cost, business interruption indemnity periods too short for the rebuild,
declared fleet counts that have not moved while the client has grown.

**Coverage gaps** — property in a flood-prone parish with no flood extension, no earthquake cover in
a seismic zone, material damage without business interruption, plant-heavy manufacturers without
machinery breakdown, contractors with no contract works cover placed through AIB, and the liability
lines a business of that industry and size would normally carry.

**Claims signals** — repeated declines in an excluded category, overseas pre-certification volume on
a plan with no network access, in-patient episodes that make the critical-illness case concrete.

**Lifecycle and portfolio** — dependants reaching the age ceiling within six months, single-line
clients with nothing holding the relationship, and gaps measured against what comparable clients on
AIB's own book actually carry.

The health administration lines sit inside this rather than beside it. A group health plan
administered by the carrier or by the client is an administration opportunity; a plan with no
overseas network attached is a member experience gap; a corporate account with local health only and
no USD international plan is the structure most employers that size end up at. Where the TPA
administers the plan, AIB can see the claims — and everything else in the benefits column gets
easier.

**These lines depend on a fact the book cannot tell you**: how AIB stands in relation to the
administrator. Set `AIB_TPA_RELATIONSHIP` before trusting anything the system says about them.

| Setting | Effect |
|---|---|
| `none` | Administration lines are removed from the catalogue and the rules that propose them never fire. |
| `partner` *(default)* | A separate company. AIB books only its own share of the fee — `AIB_TPA_REVENUE_SHARE`, defaulting to a placeholder 15%. |
| `subsidiary` | The TPA belongs to AIB itself, so the whole fee is AIB's. |

Corporate structure is a **separate question** from that commercial setting, and `AIB_GROUP_NAME`
answers it. As shipped, AIB and Cardea are configured as sister companies under the **AIBHL**
umbrella: separate companies that invoice each other, which is why the relationship is `partner`
rather than `subsidiary` — but still inside one group, which is an argument an account executive can
legitimately make. With a group name set, the analyst is told to describe the administrator as a
sister company within the group, *never as part of AIB and never as an unrelated third party*, and
the administration rule adds the in-group point to its rationale. Set `AIB_GROUP_NAME=""` if there
is no common parent.

`AIB_TPA_NAME` renames the administrator throughout. See [`src/config.js`](src/config.js).

**The 15% revenue share is a placeholder nobody at AIB supplied.** Set `AIB_TPA_REVENUE_SHARE` to
the real inter-company figure before the pipeline totals are shown to anyone who might act on
them.

---

## Rules go dormant rather than guess

Different exports carry different things. A rule that needs a sum insured must not run against an
export that has none — firing on absent data reports a gap in the book when the gap is in the
export, which is the most expensive mistake this system can make.

So every rule declares what it needs, `bookCapabilities()` reports what the book actually carries,
and the engine skips the rest and says which. On AIB's IBR register that leaves **6 of 29 rules
active**, producing 370 findings across 284 clients:

| Rule | Findings |
|---|---|
| Corporate client with no benefits business | 136 |
| Health written outside the administrator | 75 |
| Group health with no group life | 72 |
| Single-line client worth rounding out | 58 |
| Benefits client with no general lines | 29 |

The other 23 are waiting on sums insured, policy extensions, claims and member census — none of
which the register carries. `dormantRules()` names each one and what it is missing.

**Floors matter more than rules.** Without a premium floor the round-out rule fires on 8,442 of
10,728 accounts, which is a spreadsheet nobody opens. At TT$50k it is 58 accounts and a fortnight
of work. `AIB_ROUNDOUT_FLOOR_TTD` and `AIB_WHITESPACE_FLOOR_TTD` are the dials.

## Ranking

Each finding scores on four factors, weighted in [`src/engine/score.js`](src/engine/score.js):
what it is worth (34%), how well the data supports it (28%), how close the renewal is (24%), and
how much work it is to place (14%). Urgency peaks between three weeks and four months out — a
renewal tomorrow is too late to work properly, and one a year away is not yet a conversation.

The weights are a starting position, not a finding. They should be refitted against actual
conversion once there are a few months of outcomes to fit against.

Premium and revenue figures throughout are indicative estimates for sizing and ranking. **They are
not quotes and must never be presented as such.** Rates live in
[`src/engine/catalogue.js`](src/engine/catalogue.js).

---

## Commands

| Command | What it does |
|---|---|
| `npm run opportunities` | Ranked findings from the rules engine. No API key required. |
| `npm run brief -- --client CL-1004` | Full analyst brief on one client. |
| `npm run sweep` | Portfolio triage: where to spend the next fortnight. |
| `npm run ask -- "which clients are most exposed to flooding?"` | Plain-language question against the book. |
| `npm run serve` | Broker console. |
| `npm test` | 67 tests over the engine, the loader, the tools and the agent loop. |

Add `--json` to any command for machine-readable output. `--family`, `--kind`, `--limit` and
`--min-score` filter.

---

## What it deliberately does not do

Every tool the analyst has is read-only. It cannot bind cover, send an email, quote a premium, or
write to any system. That is a boundary rather than an omission: an agent that can only read can be
wrong, but it cannot do damage, and that is the right shape for the first AI system to touch a live
book of business.

Everything it produces is internal preparation material for a licensed broker. Talk tracks are
notes for the account executive, not client-ready copy. Nothing reaches a client without a person
who is authorised to give that advice having read it and taken ownership of it.

The system also does not tell you a client should switch, cancel or reduce cover. It tells you what
is worth discussing.

---

## Configuration

Copy `.env.example` to `.env`.

| Variable | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required for the analyst. The rules engine runs without it. |
| `BOOK_SOURCE` | `sample` | `sample`, `json` or `csv`. |
| `BOOK_PATH` | — | File or directory for the non-sample sources. |
| `AIB_MODEL` | `claude-opus-5` | |
| `AIB_EFFORT` | `high` | `low` through `max`. Worth sweeping against your own results. |
| `AIB_FX_TTD_PER_USD` | `6.8` | Normalises the USD international plan. |
| `AIB_TPA_RELATIONSHIP` | `partner` | `none`, `partner` or `subsidiary`. Governs the administration lines — see above. |
| `AIB_TPA_NAME` | `Cardea` | Name of the health administrator, and the value expected in `policies.administrator`. |
| `AIB_GROUP_NAME` | `AIBHL` | Holding company AIB and the administrator share. Empty string if none. |
| `AIB_TPA_REVENUE_SHARE` | `0.15` | AIB's share of an administration fee. **Placeholder — replace it.** |
| `PORT` | `4000` | |

---

## Where this goes next

Roughly in order of value per unit of work.

**Feed it renewals automatically.** A scheduled run each morning that briefs each account executive
on their own accounts renewing in the next 60 days turns this from a tool someone remembers to open
into something that arrives. This is a small amount of work and probably the single highest-return
addition.

**Get claims closer to real time.** Right now claims are read from a periodic export. A declined
dental claim is a cross-sell signal that decays — it is worth most in the week it happens, when the
member is still annoyed about it. Whoever adjudicates the claim has that signal at the moment it is
made. How much of it AIB can get at, and how quickly, depends entirely on the administration
relationship; where AIB has one, this is the highest-value data connection available to it.

**Read the schedules.** If policy detail lives in PDF schedules rather than structured fields —
sums insured, extensions, indemnity periods, exclusions — then document extraction to populate the
book is the largest single unlock here, because it turns the thinnest fields in the schema into the
richest. It is also the piece most likely to reveal that the book knows less than anyone thought.

**Close the loop on outcomes.** Log what was raised, what converted and what did not. That data
refits the scoring weights and, more importantly, tells you which rules earn their place. Without
it the ranking stays an assumption.

**Wording comparison at remarketing.** Given two carrier schedules, set out where cover genuinely
differs rather than where the premium does. Brokers do this by hand and it is slow and easy to get
wrong.

**Retention risk, not just revenue.** The same data supports a view on which accounts are at risk —
single-line, poor loss ratio, long gaps in contact, recent service complaints. Defending revenue is
usually cheaper than winning it.

**A member-facing benefits assistant.** The FAQ page in this repository is a static answer to
questions members ask constantly about pre-certification, exclusions and dependant eligibility.
Those answers are already written, and the same grounding discipline used here applies directly.

---

## Layout

```
src/config.js            facts about AIB the book cannot supply (the TPA relationship)
src/data/schema.js       the contract — what AIB has to export
src/data/book.js         loading, indexing, queries, benchmarks
src/engine/catalogue.js  what AIB places and what it earns
src/engine/rules.js      the 22 rules
src/engine/score.js      ranking
src/agent/prompt.js      the analyst's instructions
src/agent/tools.js       its read-only view of the book
src/agent/analyst.js     the agentic loop and structured synthesis
src/cli.js               command line
src/server.js            broker console API
web/index.html           broker console
scripts/                 synthetic book generator
test/                    engine, loader and tool tests
```
