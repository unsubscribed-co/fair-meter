/*
 * The wallet's rows that fair-meter reads or writes under `billing: { walletTable }`: their one
 * home (the wallet imports these types and keys). The wallet table is the wallet's own, keyed PK/SK.
 * Money is integer micro-USD; every debit is guarded by `availableMicroUsd` alone (wallet ADR 0002).
 */

/** `WALLET#<account>` / `BALANCE`: the only mutable wallet row, moved by conditional ADDs. */
export interface WalletBalance {
  /** What apps may spend now: the guard of every debit. */
  availableMicroUsd: number;
  creditedMicroUsd?: number;
  spentMicroUsd?: number;
  heldMicroUsd?: number;
  refundingMicroUsd?: number;
  refundedMicroUsd?: number;
  absorbedMicroUsd?: number;
  /** Labels, set at the first link: never keys. */
  email?: string;
  lang?: string;
  grantedAt?: string;
  /** `<app>#<person>` of every link to this account. */
  links?: Set<string>;
  movedTo?: string;
}

/** `LINK#<app>#<person>` / `LINK`: which account pays for an app's person. Only a move or support changes it. */
export interface WalletLink {
  account: string;
}

/** `WALLET#<account>` / `SPEND#<yyyy-mm>`: one attribute per app id, the month's charged micro-USD. */
export type WalletSpend = Record<string, number>;

/** `PASS#<random>` / `PASS`: a single-use ticket to the embedded view, written by an app's backend. */
export interface WalletPass {
  account: string;
  /** Epoch seconds (the table's TTL attribute). The wallet refuses a pass past it, whatever TTL has deleted. */
  expiresAt: number;
}

export const PASS_TTL_SECONDS = 120;

/** Where a person tops up: the hint on `balance_too_low`. */
export const TOP_UP_URL = 'https://pay.unsubscribed.dev';

export const walletKeys = {
  balance: (account: string) => ({ PK: `WALLET#${account}`, SK: 'BALANCE' }),
  spend: (account: string, month: string) => ({ PK: `WALLET#${account}`, SK: `SPEND#${month}` }),
  link: (appId: string, person: string) => ({ PK: `LINK#${appId}#${person}`, SK: 'LINK' }),
  pass: (random: string) => ({ PK: `PASS#${random}`, SK: 'PASS' }),
};

/** The fee on an amount, rounded up (feeBps from prices/fee.json, never above 10000). */
export const feeOf = (microUsd: number, feeBps: number) => Math.ceil((microUsd * feeBps) / 10_000);
