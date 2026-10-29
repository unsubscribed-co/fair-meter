import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { mockClient } from 'aws-sdk-client-mock';
import { CloudWatchLogsClient, GetQueryResultsCommand, StartQueryCommand } from '@aws-sdk/client-cloudwatch-logs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactGetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { FairMeter, type FairMeterConfig } from '../fair-meter';
import { measureCapacity } from '../measure';
import { measureApp, parseAppFile } from '../prices-cli';

const config: FairMeterConfig = {
  appId: 'stacksplit',
  env: 'dev',
  tableName: 't',
  retryQueueUrl: 'https://sqs/retry',
  dailyCapMicroUsd: 500_000,
  appDailyCapMicroUsd: 5_000_000,
  tableKeys: { pk: 'pk', sk: 'sk' },
  actions: { skus: ['stacksplit-new-expense'], perPersonPerMinute: 100, maxConcurrency: 10 },
  actionFloorMicroUsd: 30_000,
};

/** An app's own client whose HTTP answers are canned: what it sent, and DynamoDB's reply per call. */
function appClient(replies: Record<string, unknown>[]) {
  const sent: Record<string, any>[] = [];
  const client = new DynamoDBClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'x', secretAccessKey: 'y' },
    requestHandler: {
      handle: async (req: any) => {
        sent.push(JSON.parse(new TextDecoder().decode(req.body)));
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Buffer.from(JSON.stringify(replies.shift() ?? {})) } };
      },
    } as any,
  });
  return { ddb: DynamoDBDocumentClient.from(client), sent };
}

let lines: string[];
beforeEach(() => {
  lines = [];
  jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

const meter = () => new FairMeter(config, { ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})), sqs: new SQSClient({}) });
const act = (m: FairMeter) => m.action({ person: 'ana@x.co', sku: 'stacksplit-new-expense' });

describe('measure mode: the app wraps its own client, and each action line carries its units', () => {
  test('single commands: every command asks for TOTAL, and the next action line carries the tally once', async () => {
    const { ddb, sent } = appClient([
      { Item: { pk: { S: 'a' } }, ConsumedCapacity: { TableName: 'app', CapacityUnits: 0.5 } },
      { ConsumedCapacity: { TableName: 'app', CapacityUnits: 1 } },
    ]);
    measureCapacity(ddb);
    const m = meter();
    await ddb.send(new GetCommand({ TableName: 'app', Key: { pk: 'a' } }));
    await ddb.send(new PutCommand({ TableName: 'app', Item: { pk: 'a' } }));
    act(m);
    act(m);
    expect(sent.map((s) => s.ReturnConsumedCapacity)).toEqual(['TOTAL', 'TOTAL']);
    expect(lines).toEqual([
      '{"fairMeter":"action","appId":"stacksplit","env":"dev","person":"ana@x.co","sku":"stacksplit-new-expense","n":1,"rru":0.5,"wru":1}\n',
      '{"fairMeter":"action","appId":"stacksplit","env":"dev","person":"ana@x.co","sku":"stacksplit-new-expense","n":1}\n',
    ]);
  });

  test('transactions: every table in the reply counts, split into read and write units when DynamoDB splits them', async () => {
    const { ddb, sent } = appClient([
      { ConsumedCapacity: [{ TableName: 'app', CapacityUnits: 4, WriteCapacityUnits: 4 }, { TableName: 'other', CapacityUnits: 2, WriteCapacityUnits: 2 }] },
      { Responses: [], ConsumedCapacity: [{ TableName: 'app', CapacityUnits: 2, ReadCapacityUnits: 2 }] },
      { Responses: [], ConsumedCapacity: [{ TableName: 'app', CapacityUnits: 1 }] },
    ]);
    measureCapacity(ddb);
    await ddb.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: 'app', Item: { pk: 'a' } } }, { Put: { TableName: 'other', Item: { pk: 'b' } } }] }));
    await ddb.send(new TransactGetCommand({ TransactItems: [{ Get: { TableName: 'app', Key: { pk: 'a' } } }] }));
    await ddb.send(new TransactGetCommand({ TransactItems: [{ Get: { TableName: 'app', Key: { pk: 'a' } } }] }));
    act(meter());
    expect(sent.map((s) => s.ReturnConsumedCapacity)).toEqual(['TOTAL', 'TOTAL', 'TOTAL']);
    expect(JSON.parse(lines[0])).toMatchObject({ rru: 3, wru: 6 });
  });

  test('without the middleware the line is exactly the plain action line', async () => {
    const { ddb, sent } = appClient([{ ConsumedCapacity: { TableName: 'app', CapacityUnits: 1 } }]);
    await ddb.send(new PutCommand({ TableName: 'app', Item: { pk: 'a' }, ReturnConsumedCapacity: 'TOTAL' }));
    act(meter());
    expect(sent[0].ReturnConsumedCapacity).toBe('TOTAL');
    expect(lines).toEqual(['{"fairMeter":"action","appId":"stacksplit","env":"dev","person":"ana@x.co","sku":"stacksplit-new-expense","n":1}\n']);
  });
});

describe('prices-cli measure: one query over dev logs, averages per action SKU into prices/apps/<app>.json', () => {
  const logsMock = mockClient(CloudWatchLogsClient);
  const NOW = new Date('2026-11-03T15:00:00Z');
  const R1 = '0f0e8a52-1a2b-4c3d-8e9f-000000000001';
  const R2 = '0f0e8a52-1a2b-4c3d-8e9f-000000000002';
  const R3 = '0f0e8a52-1a2b-4c3d-8e9f-000000000003';
  const R4 = '0f0e8a52-1a2b-4c3d-8e9f-000000000004';
  const actionLine = (sku: string, n: number, rru: number, wru: number) => JSON.stringify({ fairMeter: 'action', appId: 'demo', env: 'dev', person: 'ana@x.co', sku, n, rru, wru });
  const bytes = (...lines: string[]) => lines.reduce((sum, l) => sum + Buffer.byteLength(l), 0);
  const rows = (stream: string, lines: string[]) => lines.map((message) => [{ field: '@logStream', value: stream }, { field: '@message', value: message }, { field: '@ptr', value: 'p' }]);
  const dir = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'measure-'));
    mkdirSync(path.join(d, 'apps'));
    return d;
  };
  const appFile = (d: string) => parseAppFile('demo', readFileSync(path.join(d, 'apps', 'demo.json'), 'utf8'));
  const run = (d: string) => measureApp(new CloudWatchLogsClient({ region: 'us-east-1' }), 'demo', { logGroup: '/aws/lambda/demo-dev-api', start: new Date('2026-11-03T14:00:00Z'), end: new Date('2026-11-03T14:30:00Z') }, NOW, d);
  beforeEach(() => {
    logsMock.reset();
    logsMock.on(StartQueryCommand).resolves({ queryId: 'q1' });
  });

  // Lambda's text format: raw stdout lines (the action line) carry no request id, so they belong to
  // the request open in their log stream; console lines and START/END/REPORT name theirs.
  const r1 = [
    `START RequestId: ${R1} Version: $LATEST`,
    `2026-11-03T14:01:00.100Z\t${R1}\tINFO\tsaving expense`,
    actionLine('demo-add', 1, 1.5, 2),
    `END RequestId: ${R1}`,
    `REPORT RequestId: ${R1}\tDuration: 41.20 ms\tBilled Duration: 42 ms\tMemory Size: 256 MB\tMax Memory Used: 90 MB\t`,
  ];
  const r2 = [
    `START RequestId: ${R2} Version: $LATEST`,
    actionLine('demo-add', 1, 0.5, 2),
    `END RequestId: ${R2}`,
    `REPORT RequestId: ${R2}\tDuration: 57.01 ms\tBilled Duration: 58 ms\tMemory Size: 256 MB\tMax Memory Used: 91 MB\tInit Duration: 300.10 ms\t`,
  ];
  // A read with no action line, and a request the window cut before its report: neither counts.
  const r3 = [`START RequestId: ${R3} Version: $LATEST`, `END RequestId: ${R3}`, `REPORT RequestId: ${R3}\tDuration: 3.00 ms\tBilled Duration: 3 ms\tMemory Size: 256 MB\tMax Memory Used: 80 MB\t`];
  const r4 = [`START RequestId: ${R4} Version: $LATEST`, actionLine('demo-add', 1, 9, 9)];
  const textRows = [...rows('s1', [...r1, ...r2]), ...rows('s2', [...r3, ...r4])];

  test('text log format: per action, the units from its line, the report and the bytes of its request', async () => {
    logsMock.on(GetQueryResultsCommand).resolves({ status: 'Complete', results: textRows });
    const d = dir();
    const lines = await run(d);
    expect(logsMock.commandCalls(StartQueryCommand)[0].args[0].input).toMatchObject({
      logGroupName: '/aws/lambda/demo-dev-api', startTime: 1793714400, endTime: 1793716200, limit: 10_000,
    });
    expect(appFile(d)).toEqual({
      region: 'us-east-1',
      actions: {
        'demo-add': {
          rru: 1, wru: 2, apiRequests: 1, lambdaRequests: 1, billedMs: 50, memoryMb: 256,
          logBytes: (bytes(...r1) + bytes(...r2)) / 2, samples: 2, measuredAt: '2026-11-03T15:00:00Z',
        },
      },
      profiles: { light: { actions: {}, ai: {} }, regular: { actions: {}, ai: {} }, heavy: { actions: {}, ai: {} } },
    });
    expect(lines).toEqual(['demo-add: 2 samples', 'prices/apps/demo.json written']);
  });

  test('JSON log format; a bulk action shares its request over its n; the profiles and other SKUs are kept', async () => {
    const r = [
      JSON.stringify({ time: '2026-11-03T14:02:00.000Z', type: 'platform.start', record: { requestId: R1, version: '$LATEST' } }),
      JSON.stringify({ timestamp: '2026-11-03T14:02:00.010Z', level: 'INFO', requestId: R1, message: 'importing' }),
      actionLine('demo-add', 3, 1.5, 6),
      JSON.stringify({ time: '2026-11-03T14:02:00.090Z', type: 'platform.report', record: { requestId: R1, metrics: { durationMs: 79.5, billedDurationMs: 80, memorySizeMB: 512, maxMemoryUsedMB: 99 }, status: 'success' } }),
    ];
    logsMock.on(GetQueryResultsCommand).resolvesOnce({ status: 'Running', results: [] }).resolves({ status: 'Complete', results: rows('s1', r) });
    const d = dir();
    const old = { rru: 2, wru: 1, apiRequests: 1, lambdaRequests: 1, billedMs: 30, memoryMb: 256, logBytes: 700, samples: 9, measuredAt: '2026-10-01T00:00:00Z' };
    const profiles = { light: { actions: { 'demo-add': 5 }, ai: {} }, regular: { actions: { 'demo-add': 20, 'demo-old': 1 }, ai: {} }, heavy: { actions: { 'demo-add': 80 }, ai: {} } };
    writeFileSync(path.join(d, 'apps', 'demo.json'), JSON.stringify({ region: 'eu-west-1', actions: { 'demo-add': old, 'demo-old': old }, profiles }));
    await run(d);
    expect(appFile(d)).toEqual({
      region: 'eu-west-1',
      actions: {
        'demo-add': {
          rru: 0.5, wru: 2, apiRequests: 0.334, lambdaRequests: 0.334, billedMs: 26.667, memoryMb: 512,
          logBytes: Math.ceil(bytes(...r) / 3 * 1000) / 1000, samples: 1, measuredAt: '2026-11-03T15:00:00Z',
        },
        'demo-old': old,
      },
      profiles,
    });
    expect(logsMock.commandCalls(GetQueryResultsCommand)).toHaveLength(2);
  }, 10_000);

  test.each([
    ['action lines without units (the client is not wrapped)', rows('s1', [r1[0], JSON.stringify({ fairMeter: 'action', sku: 'demo-add', n: 1 }), r1[4]]), /demo-add: no rru or wru/],
    ['no action line with a report', rows('s2', [...r3, ...r4]), /no action lines/],
    ['10,000 lines, the query limit', Array.from({ length: 10_000 }, () => textRows[0]), /narrow --start and --end/],
  ])('refused, nothing written: %s', async (_, results, why) => {
    logsMock.on(GetQueryResultsCommand).resolves({ status: 'Complete', results });
    const d = dir();
    await expect(run(d)).rejects.toThrow(why);
    expect(existsSync(path.join(d, 'apps', 'demo.json'))).toBe(false);
  });

  test('refused, nothing written: a failed query', async () => {
    logsMock.on(GetQueryResultsCommand).resolves({ status: 'Failed' });
    const d = dir();
    await expect(run(d)).rejects.toThrow(/query Failed/);
    expect(existsSync(path.join(d, 'apps', 'demo.json'))).toBe(false);
  });
});
