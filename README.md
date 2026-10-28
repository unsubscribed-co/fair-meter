# fair-meter

Metering for apps hosted at cost ([Unsubscribed!](https://unsubscribed.dev)): every paid call is priced at the provider's list price and written to an append-only ledger in the app's own DynamoDB table, with caps and a per-minute brake before the call. Self-hosted copies run it with `billing: 'none'`: the ledger and caps stay on, nobody is charged.

**v0.1.0 is a pure move** of Nieto's metering module (`unsubscribed-co/nieto`, `backend/lambda/metering/` at commit `b3790cf`), unchanged. The text below is that module's README; paths like `lambda/proxy/handler.ts` are Nieto's.

## Install

TypeScript source, no build step: your bundler (esbuild via CDK's `NodejsFunction`) compiles it with your code.

```
npm install github:unsubscribed-co/fair-meter#v0.1.0
```

- `fair-meter` exports everything; `fair-meter/cdk` has the constructs (`MeteringRetry`, `DeepSeekReconciliation`, `MeteringExport`, `FreeTierWatch`); `fair-meter/<file>` reaches one file.
- Peer dependencies: `aws-cdk-lib`, `constructs`, the AWS SDK v3 clients listed in `package.json`, `@types/aws-lambda`.
- Jest must transform it: `transformIgnorePatterns: ['/node_modules/(?!fair-meter/)']`.

**Start with these three:** `new Meter(config, clients)`; `authorize(sub, at)` before the paid call; build a record with `tokenRecord()`, `charRecord()`, `requestRecord()` or `unitRecord()` and write it with `record()`. The rest is exported for admin tools and may change.

License: AGPL-3.0.

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
  SQS retry queue (`retry-handler.ts`, `cdk.ts`) with a dead-letter queue that alarms.
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
