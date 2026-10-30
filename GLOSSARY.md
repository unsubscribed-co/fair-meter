# fair-meter

Per-person, per-app spend metering for apps hosted at cost: every paid thing a person does is priced at a published list price and written to an append-only ledger, with caps that stop spend before it happens.

## Money path (AI and other provider calls)

**Attempt**:
One call to a paid provider. Every retry, hedge and fallback is its own attempt with its own `callId`.
_Avoid_: request, call (alone)

**Hold**:
The most an attempt can cost, reserved against the person's day before the provider is called (a `PENDING` row plus `committedMicroUsd`).
_Avoid_: reservation (in prose), lock

**Settle**:
Turning a hold into an EVENT at the attempt's cost, exactly once.
_Avoid_: commit, finalize

**Release**:
Settling a hold at nothing: the provider never billed the attempt. No EVENT is written.
_Avoid_: cancel, refund

**Sweep**:
The scheduled settle of a hold nobody settled within 30 minutes, at the hold's amount (`estimated: 'swept'`).

**True-up**:
An ADJUST written when real usage arrives after a sweep.

**Absorbed**:
The part of an EVENT's cost the operator pays instead of the person (an attempt that didn't serve the person). Recorded at list price and counted toward caps; the person's spend excludes it.
_Avoid_: written off, free

## Actions

**Action**:
One thing a person does in an app that costs AWS money but no provider call (for example StackSplit's "new expense"). Priced per 1,000 at a fixed list price; reported as one log line, never a write.
_Avoid_: operation (in code), event

**Rollup**:
The scheduled job that counts action lines per person, SKU and 15-minute window and settles each count as one EVENT.

**Write check**:
The cheap read before a write (`canWrite`) that refuses a person whose room is below the floor, so they get read-only access.
_Avoid_: balance check, gate

**Floor**:
The most one person can spend on actions within one rollup lag (45 minutes: an action is in committed at most that long after it happens). It is kept free of AI holds, so actions never overshoot the cap.
_Avoid_: buffer, reserve

## Limits

**Committed**:
A person's settled cost today plus their open holds (`committedMicroUsd`): what the daily cap is checked against.

**Room**:
The daily cap minus committed: what the person may still spend today.
_Avoid_: balance, remaining credit

**Daily cap**:
The hard per-person limit per UTC day, enforced atomically.

**App day cap**:
The soft breaker for everyone in one app per UTC day; it bounds the cost of farmed free accounts.

## Prices

**SKU**:
What a price is keyed by (`claude-haiku-5-5`, `stacksplit-new-expense`), never a provider's model name.

**Price version**:
One immutable set of rates for a SKU, valid from `validFrom` until the next version starts.

**List price**:
The provider's or AWS's published price, used even when a free tier or a credit pays.

**Component**:
One part of an action's list price: database, API, compute, logs or other.

**RRU, WRU** (`rru`, `wru`):
Read and write request units: the DynamoDB capacity a write consumed, measured per action in measure mode and priced as the action's database component.

**Fee**:
The declared share added on top of list price for the project; it has one home (`prices/fee.json`) and is zero when billing is `none`.
_Avoid_: markup, margin

## Hosted billing

**Wallet**:
A person's prepaid USD balance, shared by every hosted app, in the wallet's own table. Under `billing: { walletTable }` every charge moves it in the ledger's own transaction. Its words (available, account, link, pass) are defined in the wallet's glossary.

**Charged amount**:
What the wallet pays for an EVENT: cost minus absorbed plus the fee on it, never more than the hold. A capped charge splits into cost and fee at the fee's rate, so absorbed is always a part of cost, never fee. Cost and fee are recorded apart (`costMicroUsd`, `feeMicroUsd`).
_Avoid_: price

**Ledger table**:
The DynamoDB table the `Metering` construct owns: prices, counters, holds and the ledger, nothing of the app's.
