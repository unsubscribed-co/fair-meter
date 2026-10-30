# fair-meter

A metering library that apps embed (public, AGPL-3.0). Apps call `FairMeter.authorize()` before each paid provider attempt and `record()` after it; the CDK constructs are in `src/cdk.ts`, the price CLI in `src/prices-cli.ts`, prices in `prices/`. TypeScript source, no build step. Start with `README.md` and `GLOSSARY.md`.

## Commands

- `npx tsc --noEmit`, then `npm test`.
- The integration tests (`src/test/integration.test.ts`) need DynamoDB Local and are skipped without it: `docker run -p 8000:8000 amazon/dynamodb-local:3.3.1`, then `DYNAMODB_ENDPOINT=http://localhost:8000 npm test`. CI always runs them.

## Rules

- Money is integer micro-USD, rounded up. Money records (EVENT, ADJUST) are never deleted or rewritten; a correction is a new ADJUST.
- `env` is a first-class field on every record. `billing: 'none'` is the default and must not change (its template is pinned); hosted billing is `{ walletTable }`.
- Zero behaviour change for existing callers unless a spec lists the change. The old `Meter` surface is Nieto's: its golden tests must stay green.
- Public repo: no AWS bill figures, profit, account ids or personal data, in code, tests, docs or commit messages.
- The smallest complete design; no speculative options.
- Never use the middle dot character in any file.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<feature>/` (gitignored). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
