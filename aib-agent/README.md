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
- `policies.administrator` — whether Cardea administers a health plan, or someone else does.

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

The Cardea lines sit inside this rather than beside it. A group health plan administered by the
carrier or by the client is a TPA opportunity; a plan with no overseas network attached is a member
experience gap; a corporate account with local health only and no USD international plan is the
structure most employers that size end up at. Where Cardea administers the plan, AIB can see the
claims — and everything else in the benefits column gets easier.

---

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
| `npm test` | 52 tests over the engine, the loader and the tools. |

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
| `PORT` | `4000` | |

---

## Where this goes next

Roughly in order of value per unit of work.

**Feed it renewals automatically.** A scheduled run each morning that briefs each account executive
on their own accounts renewing in the next 60 days turns this from a tool someone remembers to open
into something that arrives. This is a small amount of work and probably the single highest-return
addition.

**Wire it to Cardea's adjudication feed.** Right now claims are read from a periodic export. A
declined dental claim is a cross-sell signal that decays — it is worth most in the week it happens,
when the member is still annoyed about it. Cardea already has that data at the moment of
adjudication, and AIB owns Cardea. Very few brokers anywhere have that loop available to them.

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

**A member-facing assistant for Cardea.** The FAQ page in this repository is a static answer to
questions members ask constantly about pre-certification, exclusions and dependant eligibility.
Those answers are already written, and the same grounding discipline used here applies directly.

---

## Layout

```
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
