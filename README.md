# fair-meter

Metering for apps hosted at cost ([Unsubscribed!](https://unsubscribed.dev)): every paid call is priced at the provider's list price and written to an append-only ledger in the app's own DynamoDB table, with caps and a per-minute brake before the call. Self-hosted copies run it with `billing: 'none'`: the ledger and caps stay on, nobody is charged.

**v0.2.0 adds the money path** for apps: `FairMeter` (below). The older surface (`Meter`, the record builders, households and plans) is Nieto's, unchanged, until Nieto moves to `FairMeter` in v0.3.0; its README follows "Start here".

## Install

TypeScript source, no build step: your bundler (esbuild via CDK's `NodejsFunction`) compiles it with your code.

```
npm install github:unsubscribed-co/fair-meter#v0.2.0
```

- `fair-meter` exports everything; `fair-meter/cdk` has the constructs (`Metering`, `MeteringRetry`, `DeepSeekReconciliation`, `MeteringExport`, `FreeTierWatch`); `fair-meter/<file>` reaches one file.
- Peer dependencies: `aws-cdk-lib`, `constructs`, the AWS SDK v3 clients listed in `package.json`, `@types/aws-lambda`.
- Jest must transform it: `transformIgnorePatterns: ['/node_modules/(?!fair-meter/)']`.

License: AGPL-3.0.

## Start here

Two calls around every paid provider attempt, one construct, one folder of prices. Every retry, hedge and fallback is its own attempt.

```ts
import { FairMeter } from 'fair-meter';
const meter = new FairMeter(); // config from the FAIR_METER env, written by the Metering construct

const call = await meter.authorize({ person, sku: 'claude-haiku-5-5', paidBy: 'credit', max: { inputTokens: utf8Bytes, outputTokens: maxTokens } });
if (!call.ok) return reply(call.status, call.body, call.headers); // ready HTTP answer: 429 or 503
let spent: object | undefined | 'unknown' | 'not_billed' = 'unknown';
try {
  const res = await callProvider({ max_tokens: maxTokens });
  spent = res.ok ? res.body.usage : 'not_billed';
} finally {
  await meter.record(call, spent); // never throws
}
```

**`authorize({ person, sku, max, paidBy? })`**, before the attempt:
- reads the SKU's price version valid now, the person's day, and the app and all-apps breakers;
- reserves the most this attempt can cost against the person's daily cap, in one transaction (a `PENDING#<app>` row plus a conditional add on the day's `committedMicroUsd`), so parallel calls can't overshoot the cap;
- `max` must bound the real usage: the cap is only as good as it. Tokens: `inputTokens` = the UTF-8 bytes of everything sent (text tokens are never fewer than bytes), `outputTokens` = the `max_tokens` sent. **The bytes bound fails for images and files sent by URL or file id** (a 100-byte URL can cost thousands of tokens): add the provider's token count for each such part. `{ chars }`, `{ units }` or `{ requests }` for other prices;
- a malformed request (from untyped JavaScript) is refused with 500 `metering_unavailable` and alarms; `authorize` never throws;
- returns `{ ok: true, tier, callId, hold }` (one fresh `callId` per attempt), or `{ ok: false, status, body, headers }`: `daily_limit_reached` (429, `resetsAt`), `too_many_requests` (429, `Retry-After`), `service_paused`, `pricing_not_configured`, `metering_unavailable` (503).
- logs one info line per call, refusals included: `AUTHORIZE_TIMING` `{ appId, sku, outcome, readsMs, reserveMs, totalMs, attempts }` (`outcome` is `ok` or the refusal code; `readsMs` the parallel reads, `reserveMs` the reserve transaction with its resends, `attempts` how many times it was sent, 0 when refused before it).

Each `FairMeter` caches a SKU's price versions for 5 minutes and picks the one valid at the call's time from them, so a warm instance doesn't query prices on every call. A SKU with no version isn't cached: one synced later is found on the next call.

**`record(call, usage)`**, after the attempt, whatever happened. Settles the reservation exactly once:

| `usage` | When | Settled at | Who pays |
|---|---|---|---|
| the provider's usage block | it answered | the actual cost (the price's provider picks the adapter) | the person |
| `{ estimate: <usage block> }` | the app aborted it but can guess (a hedge loser's input tokens) | that estimate, `estimated: 'aborted'`, no alarm | the operator (absorbed) |
| `'unknown'` | aborted or lost with no guess (timeout, network error after sending) | the reservation, `estimated: 'aborted'`, no alarm | the operator (absorbed) |
| `'not_billed'` | an error status the provider doesn't bill (4xx, 5xx, 429) | nothing: the hold is released, no EVENT | nobody |
| `undefined` or malformed | a 200 without usable usage | the reservation, `estimated: 'no_usage'`, USAGE_MISSING alarms | the person (they were served) |

An absorbed attempt keeps its list-price cost and counts toward the cap, but the EVENT and the person's day and month rows carry `absorbedMicroUsd`: the person is charged `costMicroUsd − absorbedMicroUsd`. The sweeper's settles are absorbed too. A late true-up of a swept attempt moves it: real usage charges the person its real cost, a late `'not_billed'` leaves them at $0.

Outcomes: `recorded`, `duplicate`, `trued_up` (real usage after the sweeper's estimate, written as an ADJUST), `conflict` (another payload for a settled call: refused, RECORD_CONFLICT alarms), `deferred` (queued), `failed` (queue down too: USAGE_RECORD_FAILED; the sweeper still settles the hold). A cost above the reservation is recorded as it is and logs RESERVATION_EXCEEDED, which alarms: it is the only sign that `max` didn't bound the call and the cap was overshot.

If the reserve write fails ambiguously (a timeout or 5xx: it may have committed), `authorize` resends the identical write (same idempotency token) to learn the outcome. If it still can't tell, it refuses, releases any hold now, and queues a second release a minute later, so the sweeper never charges for a call that wasn't made.

**`usage(person)`**, to show a person their own spend in real time. One strongly consistent `BatchGetItem` of their day row (today, UTC) and month row (this month, UTC):

```ts
const { day, month, tier } = await meter.usage(person);
// day:   { spentMicroUsd, heldMicroUsd, capMicroUsd, roomMicroUsd, resetsAt }
// month: { spentMicroUsd, resetsAt }
```

- `spentMicroUsd` is what the person paid: `costMicroUsd − absorbedMicroUsd`;
- `heldMicroUsd` is the open holds of calls in flight: `committedMicroUsd − costMicroUsd`, at least 0 (an ADJUST doesn't move `committedMicroUsd`, so after a correction it is approximate);
- `roomMicroUsd` is what is left under the daily cap: `capMicroUsd − committedMicroUsd`, at least 0;
- `resetsAt` (ISO, UTC) is the next UTC midnight for the day and the first of next month for the month; `tier` is the one `authorize` would report.

A person with no rows gets zeros and the whole cap as room. It moves no money, so unlike `authorize` it rejects on a read error. `Metering.grant(fn)` allows the read.

**`Metering`** (`fair-meter/cdk`), once per app and stage:

```ts
const metering = new Metering(this, 'Metering', {
  appId: 'stacksplit', env: stage,
  dailyCapUsd: '0.50', appDailyCapUsd: '5', // decimal USD, parsed exactly at synth
});
metering.grant(fn); // IAM on the ledger table, the FAIR_METER env, an alarm on fn's metering error lines
```

It creates the ledger table, `metering.table` and a stack output: on-demand, `PK`/`SK`, TTL on `expiresAt`, point-in-time recovery, deletion protected and retained when the stack is deleted. Prices, counters, holds and the ledger live there, nothing of your app's; your `authorize` and `record` code needs no table settings. It also creates the retry queue and its Lambda (`MeteringRetry`, DLQ alarms on depth and on a 7-day-old message) and the sweeper: every 10 minutes it settles holds left open for 30 minutes (a crash between authorize and the settle) at their reservation, `estimated: 'swept'`, and alarms. Give `fn` its own `logGroup`. Optional: `alarmAction` (without it the alarms exist with no action, fine for dev), `allAppsDailyCapUsd`, `maxCallsPerMinute`, `tiers`. `billing: 'hosted'` is refused until the wallet exists.

**The retry queue** (`MeteringRetry`, also under `Metering`): a record the app couldn't write waits on the queue and is retried every minute; one that still fails after 10 receives is parked in the DLQ. A message that can never be recorded (not JSON, no `appId`/`sub`/`requestId`/`requestTime`, or no transaction can be built from it) is parked at once, logged `USAGE_RECORD_PARKED` (an error that alarms under `Metering`). Every night at 04:00 UTC a redrive Lambda drains the DLQ: each valid record goes back on the retry queue, at most 3 times per call, counted on `REDRIVE#<app>` / `CALL#<callId>` (kept 30 days); recording is idempotent, so a record already in the ledger ends `duplicate`. Invalid records stay, and so does a call at its third redrive (logged `REDRIVE_LIMIT`), so the DLQ alarms stay on. The manual step when that happens: read the message in the SQS console, fix the cause (bad data, a missing price, a table permission), then redrive it from the console (not counted) or delete it if it must never be recorded; the DLQ drops it 14 days after its first enqueue.

**Prices** live in this repo, `prices/<sku>.json`, one file per SKU: `provider`, `unit` (`tokens`, `chars`, `units`, `requests`) and immutable `versions`, each with `validFrom`, the rates in PRICING item fields (integer micro-USD) and the provider's pricing page as `source`. To put them in the ledger table (its name is the stack output):

```
npx tsx node_modules/fair-meter/src/prices-cli.ts sync --table <ledger table> [--dry-run]
npx tsx node_modules/fair-meter/src/prices-cli.ts price-history <sku> --table <name> [--keys pk,sk]
```

`sync` adds each version the table lacks, closing the previous version's range in the same transaction. A stored version with other values, or a new version older than one already stored, is refused and nothing is written: a price change is a new version with a new `validFrom`. A new version must start at least 10 minutes after `sync` runs (twice the 5-minute price cache, so no warm instance prices a call at the old version after the change); a SKU with no stored version may start at once. Seeded: `claude-haiku-5-5`, `deepseek-v4-flash` (DeepSeek's peak band can't skip Chinese public holidays, so those weekdays are reserved and charged at peak).

**Action SKUs** are ordinary price files, `prices/<app>-<action>.json`, with `provider: "aws"` and `unit: "units"` (one unit is one action). Each version has `microUsdPerKUnits` and `components: { database, api, compute, logs, other }`, integer micro-USD per 1,000 actions; the parser requires exactly those five and their sum equal to `microUsdPerKUnits`, and `source` is the AWS Price List URL. They sync and price like any `units` SKU, and `price-history` shows the components. None is seeded yet: the first ones come from a measurement.

**The fee** has one home, `prices/fee.json`: `{ "versions": [{ "validFrom", "feeBps" }] }`, in basis points of cost, versioned like a price (today 10000, 100% of cost, from 2026-10-29). `billing: 'none'` means no fee: v0.3.0 never applies it, and `'hosted'` (which will) is refused until the wallet exists. `sync` skips `fee.json` and `prices/apps/`.

**Reproducing an app's price list.** An app's measurement lives in `prices/apps/<app>.json`: its `region`, per action SKU the measured averages per action (`rru`, `wru`, `apiRequests`, `lambdaRequests`, `billedMs`, `memoryMb`, `logBytes`, from `samples` requests at `measuredAt`), and three profiles, `light`, `regular` and `heavy`, each with actions a day per SKU and AI calls a day per SKU with the average meters of one call:

```json
{
  "region": "us-east-1",
  "actions": {
    "myapp-add": { "rru": 2, "wru": 3, "apiRequests": 1, "lambdaRequests": 1, "billedMs": 40, "memoryMb": 1024, "logBytes": 2048, "samples": 50, "measuredAt": "2026-11-01T00:00:00Z" }
  },
  "profiles": {
    "light": { "actions": { "myapp-add": 10 }, "ai": { "claude-haiku-5-5": { "callsPerDay": 1, "meters": { "inputTokens": 2000, "outputTokens": 400 } } } },
    "regular": { "actions": { "myapp-add": 50 }, "ai": { "claude-haiku-5-5": { "callsPerDay": 5, "meters": { "inputTokens": 2000, "outputTokens": 400 } } } },
    "heavy": { "actions": { "myapp-add": 200 }, "ai": { "claude-haiku-5-5": { "callsPerDay": 20, "meters": { "inputTokens": 2000, "outputTokens": 400 } } } }
  }
}
```

The profiles every app uses: light is 1 AI call and 10 actions a day, regular 5 and 50, heavy 20 and 200. Then, with no AWS credentials:

```sh
npx tsx node_modules/fair-meter/src/prices-cli.ts list <app> [--write --valid-from <iso>]
```

`list` downloads the region's public Price List offer files (DynamoDB, Lambda, API Gateway, CloudWatch) and takes each first-tier on-demand list rate, no free tier; a rate it can't find stops the run, naming it. Per action, each component per 1,000 actions, rounded up: database = `rru` plus the write check's half read unit at the read request rate, plus `wru` at the write request rate; API = `apiRequests` at the HTTP API rate; compute = `lambdaRequests` at the Arm request rate plus `billedMs` x `memoryMb` as Arm GB-seconds; logs = `logBytes` ingested plus the same bytes scanned once by the rollup (GB = 2^30 bytes); other = 0. It prints each line (components, cost, fee from `prices/fee.json`, price) and per profile the monthly cost (30 days), the price with the fee and how many days $2 lasts; AI calls are priced at their SKU's current version. `--write` appends a version starting at `--valid-from` to each `prices/<sku>.json` whose rates differ from its latest version (creating the file for a new SKU; a version is never edited), refuses a `validFrom` less than 10 minutes ahead, and writes the published list, `prices/apps/<app>.list.json`. Then `sync`.

### Known limits (v0.2.0)

- **True-ups don't move `committedMicroUsd`.** After the sweeper's estimate, a late real usage (or a late `not_billed`) corrects the cost with an ADJUST, but that day's cap stays held at the reservation. Conservative: the cap is tighter, never overshot.
- **Request-priced counters count calls.** `{ requests: 3 }` costs 3 requests, but the counters add `requests` 1 (one call). The money is right.
- **Late-usage ADJUSTs export only their cost.** Their meters and band stay on the ADJUST item, not in the export columns, and their `createdAt` is the call's time (so retries are identical), not when the correction was written.
- **IAM is ledger-table-wide.** `grant(fn)` allows Query, Get, BatchGet, Put, Update and Delete on the whole ledger table, including `PRICING#*`; it could be narrowed by leading key. It never reaches the app's own tables.
- **One hot partition per app.** Every attempt writes and deletes a `PENDING#<app>` row: about 500 attempts a second per app before DynamoDB's per-partition limit. Shard the key if an app gets there.
- **`sync` only adds.** A version in the table that no file has (e.g. from the old admin CLI) is kept, and closed by the next file version. Nothing is overwritten, but the files are not yet the only home.
- **The sweeper is serial, 60 s per run.** After an outage with thousands of open holds it takes several runs, each timing out (SweeperFailureAlarm). It converges, because settled rows disappear.

What lands in the ledger table: `USER#<person>` / `EVENT#<at>#<app>#<callId>` per settled attempt (with `env`, `paidBy`, `reservedMicroUsd`, `estimated` when it is), the usual day, month, app, all-apps and provider counters, and `PENDING#<app>` / `CALL#<callId>` while an attempt is open. All money is integer micro-USD, rounded up.

## Upgrading from v0.2.0

v0.3.0 owns its ledger table: drop `table` and `tableKeys` from `Metering` (passing `table` fails at synth). `authorize` and `record` don't change. Deploy, then sync prices to the ledger table (`prices-cli sync --table <ledger table>`).

## The old surface (Nieto's, until v0.3.0)

Nieto's metering module (`unsubscribed-co/nieto`, `backend/lambda/metering/` at commit `b3790cf`), moved unchanged in v0.1.0; paths like `lambda/proxy/handler.ts` are Nieto's. Start with `new Meter(config, clients)`; `authorize(sub, at)` before the paid call; build a record with `tokenRecord()`, `charRecord()`, `requestRecord()` or `unitRecord()` and write it with `record()`. The rest is exported for admin tools and may change.

## The module (from Nieto)

Per-user, per-app spend tracking and limits for AI apps that proxy LLM/TTS calls through a
Lambda. Self-contained: nothing in here imports app code. Nieto (`lambda/proxy/handler.ts`)
is the first user.

What it does:

- **Limits before the call** (`Meter.authorize`): registered user, household, then circuit
  breakers (per app, optional all-apps ceiling), subscription status, monthly allowance (plan
  households) or credit (legacy prepaid), per-user daily cap. UTC days and months.
- **Billing mode** (`limits.billing`): `hosted` (default in code; Nieto) charges: subscription status,
  monthly allowance, legacy prepaid credit, markup. `none` (self-hosting; the stack's default when
  cdk.json has no `billing`) skips all four (no credit required or deducted, `markupBps` treated as
  0, tiers from the daily cap only) and keeps the protection: breakers, daily cap, brake, the ledger.
- **Per-minute brake** (`limits.maxCallsPerMinute`, optional): one conditional `ADD` on
  `USER#<sub>` / `RATE#<app>#<YYYY-MM-DDTHH:MM>` per metered call (any kind), sent alongside the limit
  reads. Over it: `too_many_requests` (429) with `retryAfterSeconds` to the next UTC minute. Spend
  limits answer first. The item carries a numeric `expiresAt`, so the table needs TTL on `expiresAt`.
- **Budget tiers** (`budget.ts`, `limits.tiers`, default 75/90): the higher of the user's day / daily cap
  and (plan households) the household's month / allowance -> `normal`, `saving`, `essential`, `limit`.
  `authorize` returns it (also on limit errors once the counters were read); the app decides what each
  tier refuses. `Meter.usage(sub, at)` gives the same as percentages (day, household month, month-end
  forecast at this month's average daily rate) with four point reads, never money.
- **Prices** (`pricing.ts`): immutable versions per billing SKU with `[validFrom, validTo)`
  ranges, time-of-day bands, context tiers, cache-write and reasoning rates. Integer micro-USD,
  BigInt math, rounded up. Shared by all apps.
- **Usage adapters** (`usage.ts`): DeepSeek, OpenAI-compatible, Anthropic, Gemini
  OpenAI-compat → canonical meters `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`,
  `outputTokens`, `reasoningTokens` (non-overlapping).
- **Exactly-once recording** (`ledger.ts`): event + all counters in one DynamoDB transaction,
  conditional on a deterministic event key, plus an idempotency token. Failed writes go to an
  SQS retry queue (`retry-handler.ts`, `cdk.ts`) with a dead-letter queue that alarms and a
  nightly redrive (`redrive-handler.ts`).
- **Reports** (`report.ts`): flag parsing, plan updates and spend aggregation for an admin CLI.
- **Adjustments** (`adjust.ts`): the correcting half of the cost ledger. EVENT items (charges)
  never change; a correction is an immutable `ADJUST#<event-time>#<app>#<id>` item with a signed
  delta, written with the original event's user month/day and household month counters (and, for
  legacy prepaid households, the credit balance) in one transaction. The id is a hash of
  (reason, event SK): re-applying a correction is refused, never double-counted.
- **Re-pricing** (`reprice.ts`): recomputes an event's cost from its stored meters with the price
  version valid at its time (same `cost.ts`/`pricing.ts` math), against the event's cost after
  any earlier adjustments. Missing meters or prices = unrepriceable, never guessed.
- **Statements** (`statement.ts`): one household, app and calendar month in any IANA zone
  (default America/Bogota), charges + adjustments by member and by kind/model. Adjustments count
  in the month of the event they correct.
- **Analytics export** (`export.ts`, `export-handler.ts`, `MeteringExport` in `cdk.ts`): table
  stream (NEW_IMAGE) → consumer Lambda (filtered to INSERTs of EVENT#/ADJUST#) → NDJSON in S3 at
  `app=<app>/dt=<UTC day of the event>/<batch>.json` → Glue table with partition projection →
  Athena workgroup (1 GB scan cutoff, results kept 30 days).
- **Provider reconciliation** (`reconcile.ts`, `reconcile-handler.ts`, `DeepSeekReconciliation`
  in `cdk.ts`): daily DeepSeek balance snapshots compared with our metered base cost per UTC day;
  alarms on drift.
- **Platform cost allocation** (`platform.ts`): the month's AWS cost (Cost Explorer) split across
  users by the time their calls kept the proxy busy.
- **Provider free tiers** (`free-tier.ts`, `FreeTierWatch` in `cdk.ts`): account-wide counters per
  provider and UTC month (`PROVIDER#<prov>` / `MONTH#<YYYY-MM>`, e.g. Nieto's `gcp-tts` `premiumChars`
  against Google's free Chirp 3 HD characters). A record's optional `providerMonth` adds counters (with
  `requests`) and string-set members (`sets`, e.g. `voiceHouseholds`: who used the provider this month;
  adding a member twice is a no-op) in the usage transaction; `Meter.providerMonthItem` reads it before
  a call; `FreeTierWatch` publishes it hourly, alarms at a percent of the cap and optionally at 100 %, and
  optionally copies the size of last month's set onto this month's item once (`shareCount`, e.g.
  `shareHouseholds`, set only if absent), so a pool can be shared per household with one read and no scan.
- **Per-household feature state**: `authorize` returns the household's month counter item as read
  (`householdMonth`, plus `householdMonthPct` against its allowance), so an app can step a feature down
  per household without another read. A record's `householdMonthMarks` sets one-way marks on that item
  (`if_not_exists`, same transaction as the event), e.g. Nieto's `premiumEndedAt` (docs/voice-tiers.md).
- **Plan definitions** (`Meter.planDefItem`, keys `PLANDEF#<app>#<plan>` / `<validFrom>`): what a plan
  includes, as immutable versions with `[validFrom, validTo)` ranges exactly like prices (the admin's
  `plan-define` closes the previous version in the same transaction). The metering module stores and
  finds the version valid at a time (`<plan>@<validFrom>`); the app owns the `grid`'s shape and its
  validation (Nieto: `lambda/proxy/plan-def.ts`).

Keys and data shapes: see the comment at the top of `keys.ts`.

## Plugging in another app

What an app configures (defaults are Nieto's, so Nieto sets none of the first three):

| Setting | Where | Default |
|---|---|---|
| Table key attribute names | `setTableKeys({ pk, sk })` once at startup + `tableKeys` prop on every construct | `PK`, `SK` |
| User partition | `setTableKeys({ userPrefix })`: partition = prefix + the `sub` you pass (normalize it yourself, e.g. lowercase an email) | `USER#` |
| Metric namespace | `metricNamespace` prop (`DeepSeekReconciliation`, `FreeTierWatch`) | none (required) |
| Apps in the Athena export | `MeteringExport` `appIds` (+ `legacyAppId`) | none (required) |
| appId | `MeteringConfig.appId` (lowercase, from config, not code) | none (required) |
| Billing | `limits.billing`: `hosted` or `none` (see "Billing mode" above) | `hosted` |

1. **Pick an appId**: lowercase, e.g. `recetas`. Put it in the app's config, not in code.
2. **The table**: string partition and sort keys, on-demand, TTL on `expiresAt`. Shared tables: users,
   households and prices are shared; counters, plans, limits and events are per app. Your own table
   with other key names (e.g. StackSplit's `pk`/`sk`, people as `PERSON#<email>`):
   `setTableKeys({ pk: 'pk', sk: 'sk', userPrefix: 'PERSON#' })` before the first call, and pass the
   same `tableKeys` to every construct below (it reaches the module's own Lambdas as
   `METERING_TABLE_KEYS`; omitted = the defaults, no env added). Each user needs a `PROFILE` item
   (`householdId`) and each household a `META` item, as in `keys.ts`.
3. **Infra** (CDK): `new MeteringRetry(stack, 'MeteringRetry', { table, alarmAction })` once per
   table, then `retryQueueUrl = meteringRetry.grantSend(proxyFn)`. Grant the proxy
   `dynamodb:GetItem`, `Query`, `PutItem`, `UpdateItem` on the table. For analytics, give the
   table `stream: NEW_IMAGE` and add `new MeteringExport(stack, 'MeteringExport', { table,
   alarmAction, appIds, legacyAppId, firstDay })` once per table; add the new app to `appIds`
   (the Athena `app` partition enum). Per DeepSeek account (not per app): `new
   DeepSeekReconciliation(stack, 'DeepSeekReconciliation', { table, alarmAction, apiKeyParam,
   balanceUrl, metricNamespace })`; per provider free tier, `FreeTierWatch` (also `metricNamespace`).
4. **Runtime**:

   ```ts
   const meter = new Meter(
     {
       tableName, appId: 'recetas', markupBps: 0, retryQueueUrl,
       skuAliases: { 'served-name': 'billing-sku' },
       limits: { billing: 'none', defaultDailyCapMicroUsd: 500_000, appDailyCapMicroUsd: 2_000_000, allAppsDailyCapMicroUsd: 5_000_000 },
     },
     { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) },
   );

   const at = requestTime;                          // when the request reached you
   const auth = await meter.authorize(sub, at);     // before the upstream call
   if (!auth.ok) return json(auth.status, auth.body);
   const pricing = await meter.tokenPricing(model, at);
   if (!pricing) return json(503, { error: 'pricing_not_configured' });
   // ... call the provider ...
   const record = await meter.tokenRecord({ caller: auth.caller, requestId, at, kind: 'chat',
     provider: 'openai', requestedModel: model, requestedPricing: pricing,
     servedModel: response.model, usage: response.usage, details: { durationMs, upstreamMs } });
   if (record) await meter.record(record);          // never throws
   ```

   `requestId` must be unique per incoming call (API Gateway's request id works).
5. **Data**: a price for every SKU (`price-set`). With `billing: 'hosted'`, each household using the
   app also needs a plan: `household-plan <id> test --app recetas --monthly-usd 3` (no plan = legacy
   prepaid credit). With `none`, a plan is optional (only its `dailyCapMicroUsd` override applies).

Error bodies from `authorize`: `not_registered` (403, includes `sub`), `household_not_found`
(403), `service_paused` (503), `subscription_inactive` (402), `insufficient_credit` (402),
`monthly_allowance_reached` (402, `resetsAt`), `daily_limit_reached` (429, `resetsAt`),
`too_many_requests` (429, `retryAfterSeconds`; only with `maxCallsPerMinute`).

Nieto's proxy turns the tier into the `x-nieto-budget` header (`limit` is sent as `essential`) and
refuses image requests from `essential` (409 `budget_essential`) before any upstream call. Which voice a
tier may use is the household's plan definition (docs/voice-tiers.md): today's plans answer 409
`budget_saving` (the phone's voice) in `essential`, before any upstream call, so nothing is charged.

## Corrections, statements, export (admin CLI)

```
npm run admin -- reprice --from 2026-09-01 --to 2026-10-01 [--app nieto] [--sku S] [--reason id] [--apply]
npm run admin -- statement <householdId> --month 2026-09 [--app nieto] [--tz America/Bogota] [--json]
npm run admin -- export-backfill [--before <iso>] [--apply]
```

- `reprice` is a dry run unless `--apply`: per-household and per-user old/new/delta, and how many
  events changed, were unchanged or could not be repriced. Use one `--reason` per correction
  (default `reprice`); a later, different correction of the same events needs a new reason.
- `export-backfill` writes items from before the stream existed (default cutoff: the stream's
  creation time) as `app=<app>/dt=<day>/backfill.json`; re-running overwrites, never duplicates.
  Rows are unique by `(sub, sk)`; only a manual repair after an export failure alarm could
  duplicate one, which `ROW_NUMBER() OVER (PARTITION BY sub, sk)` removes.

## Athena (workgroup `metering`, table `metering.ledger`)

Columns are the lowercase item attributes (`recordtype`, `appid`, `householdid`, `eventtime`,
`sku`, meters, `amountmicrousd` = charge or adjustment delta, ...); partitions `app`, `dt` (UTC
day of the event). Always filter on `dt` to keep scans small.

Spend per household per Bogota month (adjustments in the month of their event):

```sql
SELECT householdid,
       date_format(at_timezone(from_iso8601_timestamp(eventtime), 'America/Bogota'), '%Y-%m') AS month,
       sum(amountmicrousd) / 1e6 AS usd,
       count_if(recordtype = 'event') AS requests
FROM metering.ledger
WHERE app = 'nieto' AND dt BETWEEN '2026-09-01' AND '2026-10-01'
GROUP BY 1, 2
ORDER BY 1, 2;
```

Spend per model per day (UTC):

```sql
SELECT dt, kind, sku, servedmodel, count(*) AS requests,
       sum(inputtokens) AS input, sum(cachereadtokens) AS cache_read, sum(outputtokens) AS output,
       sum(amountmicrousd) / 1e6 AS usd
FROM metering.ledger
WHERE app = 'nieto' AND recordtype = 'event' AND dt >= '2026-09-01'
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3;
```

Adjustments by reason and household:

```sql
SELECT reason, householdid, count(*) AS events,
       sum(oldcostmicrousd) / 1e6 AS old_usd, sum(newcostmicrousd) / 1e6 AS new_usd,
       sum(deltamicrousd) / 1e6 AS delta_usd
FROM metering.ledger
WHERE app = 'nieto' AND recordtype = 'adjustment' AND dt >= '2026-09-01'
GROUP BY 1, 2
ORDER BY 1, 2;
```

## Provider reconciliation (DeepSeek)

Does what DeepSeek took from the account match what we metered? DeepSeek only exposes a balance
(`GET /user/balance`), so:

- **Our side**: every usage transaction for a record with `details.provider` (all chat calls) also
  adds to `PROVIDER#<provider>` / `DAILY#<YYYY-MM-DD>`: `requests`, the token meters and
  `baseCostMicroUsd` (before markup: the provider never sees our markup), across all apps. One more
  item in the existing transaction (at most 9 of DynamoDB's 100, with a free-tier month counter). Chosen over scanning EVENT items
  because a window then costs a few small reads, and the reconcile Lambda can be limited to
  `PROVIDER#` partitions (no user data). Like the circuit breakers it records what we believed at
  call time: adjustments (re-prices) don't move it. TTS records carry no provider and are skipped
  (Google TTS has no balance API).
- **Their side**: an EventBridge rule at **00:00 UTC** runs a small Lambda that reads the same SSM
  key the proxy uses, fetches the balance and stores an immutable `PROVIDER#deepseek` /
  `BALANCE#<iso>` snapshot (USD only; other currencies are listed in `otherCurrencies`).
- **Windows**: from one day-aligned snapshot (taken within 15 minutes after 00:00 UTC) to the
  next one on a later day, so windows are whole UTC days and match the counters exactly. Daily, not
  every 6 hours: day counters can't split a day, and at our volume a 6-hour window is cents of
  noise. A missed run makes a two-day window. Mid-day snapshots (the admin's `--snapshot`, a late
  retry) never split a window; they only help detect top-ups. Calls in flight at midnight land on
  either side (a fraction of a cent).
- **Math**: provider spend = start balance − end balance; drift = (provider − metered) / provider
  (positive: DeepSeek took more than we metered). If the balance went up anywhere in the window a
  top-up happened and the spend is unknown: the window is reported as **not reconcilable**, never
  guessed.
- **Alarm**: the Lambda publishes `DeepSeekDriftPct`, `DeepSeekDriftMicroUsd` and
  `DeepSeekDriftBreached` (the construct's `metricNamespace`; Nieto: `Nieto`) and logs `PROVIDER_DRIFT`; the alarm fires when
  |drift| > 15% **and** |provider − metered| > $0.05 (`driftBreached`, tested in one place). Failed
  runs (key, API, table) alarm through the function's error metric.
- **Blind spots**: a top-up smaller than the window's spend looks like less spend (only a
  snapshot between the two shows it); expiring granted balance looks like spend; DeepSeek may post
  charges with a delay we haven't measured. A real drift alarm usually means a price list that no
  longer matches DeepSeek's (check `price-history`, then `reprice`), an unmetered call path, or
  usage from the same key outside the proxy (the eval's `NIETO_EVAL_DIRECT`, scripts).

```
npm run admin -- reconcile [--days 14]          # snapshots, windows, provider vs metered, drift
npm run admin -- reconcile --snapshot           # read the balance now (one DeepSeek GET); prints it
npm run admin -- reconcile --snapshot --apply   # ...and store it
```

## Platform cost allocation

AWS platform cost (Lambda, API Gateway, DynamoDB, CloudWatch, S3, SQS, SNS, Glue, Athena,
EventBridge, ...) is overhead, never priced per request. Once a month it is split across users in
proportion to their summed `durationMs` (the whole proxy call) for the UTC month:

```
npm run admin -- platform-costs --month 2026-10 [--app nieto] [--json]
```

- One Cost Explorer `GetCostAndUsage` call per run ($0.01): UNBLENDED, grouped by SERVICE, for
  `[1st, min(next 1st, tomorrow))`. Services in `PLATFORM_SERVICES` count; anything else is listed
  as excluded so a renamed service shows up instead of vanishing. Cost Explorer is account-wide:
  this assumes the account runs only this stack. Unblended cost is net of any credits.
- Cost Explorer lags ~24 h, and a running month is partial (the output says so).
- Allocation is across every app's users (other apps' share is shown, not hidden), with integer
  micro-USD and the largest-remainder method so the parts sum exactly to the total. Users with no
  duration (events from before `durationMs` existed) get none; with no durations at all the total
  stays unallocated.
- Output per user and per household: requests, duration, metered spend (charges + adjustments),
  overhead, total.
- Scale path: the month is read with a paginated table Scan (fine for hundreds of events); later,
  `SELECT appid, sub, householdid, sum(durationms) FROM metering.ledger WHERE recordtype = 'event'
  AND dt BETWEEN '2026-10-01' AND '2026-10-31' GROUP BY 1, 2, 3`.

## Notes

- Enforcement uses UTC months; statements use America/Bogota months (a reporting choice: the
  enforcement reset happens at 19:00 Bogota on the last day of the month).
- Plans replace top-ups: future subscription plans use `plan` + `subscriptionStatus` +
  allowance. `creditBalanceMicroUsd` stays for legacy prepaid households only.
- Log lines that alarm (error level): `SERVICE_PAUSED`, `USAGE_RECORD_FAILED`,
  `SERVED_MODEL_UNPRICED`, `PRICE_VERSION_GAP`, `PLAN_DEF_VERSION_GAP`, `PLAN_WITHOUT_ALLOWANCE`, and Nieto's
  `PLAN_DEF_SAFETY_NET`. `PROVIDER_DRIFT` (the
  reconcile Lambda) is logged at error level too; its alarm is the `DeepSeekDriftBreached` metric.
