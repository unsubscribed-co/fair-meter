import type { MiddlewareStack } from '@smithy/types';

/*
 * Measure mode, for the price list: the app wraps its own DynamoDB client in dev only, and each
 * action line then carries the read and write units its request used (see `prices-cli measure`).
 */

/** The commands whose input takes ReturnConsumedCapacity; reads are the ones counted as read units. */
const DATA_COMMAND = /^(GetItem|BatchGetItem|Query|Scan|TransactGetItems|PutItem|UpdateItem|DeleteItem|BatchWriteItem|TransactWriteItems|ExecuteStatement|BatchExecuteStatement|ExecuteTransaction)Command$/;
// shortcut: a PartiQL SELECT that DynamoDB answers with CapacityUnits only counts as writes, add the statement check when an app reads through PartiQL.
const READ_COMMAND = /^(GetItem|BatchGetItem|Query|Scan|TransactGetItems)Command$/;

/** Units consumed since the last action line, in this process (one invocation at a time). */
let tally = { rru: 0, wru: 0 };

/**
 * Wraps the app's DynamoDB client (a DynamoDBClient or the DynamoDBDocumentClient over it): every
 * command asks for ReturnConsumedCapacity TOTAL, and the units it used are tallied until the next
 * `action()` line. Dev only: in prod nothing should wrap the client.
 */
export function measureCapacity(client: { middlewareStack: MiddlewareStack<any, any> }): void {
  client.middlewareStack.add((next, context) => async (args: any) => {
    if (!DATA_COMMAND.test(context.commandName ?? '')) return next(args);
    const result: any = await next({ ...args, input: { ...args.input, ReturnConsumedCapacity: 'TOTAL' } });
    const read = READ_COMMAND.test(context.commandName!);
    for (const c of [result.output?.ConsumedCapacity ?? []].flat()) {
      // DynamoDB may split the total into read and write units; when it doesn't, the command says which.
      const split = c.ReadCapacityUnits !== undefined || c.WriteCapacityUnits !== undefined;
      tally.rru += split ? c.ReadCapacityUnits ?? 0 : read ? c.CapacityUnits ?? 0 : 0;
      tally.wru += split ? c.WriteCapacityUnits ?? 0 : read ? 0 : c.CapacityUnits ?? 0;
    }
    return result;
  }, { step: 'initialize', name: 'fairMeterMeasureCapacity', override: true });
}

/** The units tallied since the last call, then zero; undefined when none were. */
export function takeCapacity(): { rru: number; wru: number } | undefined {
  if (!tally.rru && !tally.wru) return undefined;
  const taken = tally;
  tally = { rru: 0, wru: 0 };
  return taken;
}
