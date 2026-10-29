/*
 * Actions' timing, shared by the floor (computed at synth in cdk.ts) and the rollup that charges
 * them (rollup-handler.ts). No AWS SDK here: cdk.ts loads it at synth.
 */

/**
 * The rollup lag: an action is in committed at most this long after it happens. A window is due
 * 30 minutes after its start (it closes, then Lambda lines arrive up to 10 minutes late); the rest
 * covers EventBridge's delay, the run's own time and Logs Insights polling. The floor covers this
 * many minutes of actions, and a window not settled within it is ROLLUP_LATE.
 */
export const ACTION_LAG_MS = 45 * 60_000;
