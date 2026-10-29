import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { MeteringRetry } from '../cdk';

// The named tsconfig (cdk.ts BUNDLING) must resolve and keep the bundle strict. This repo isn't under node_modules, so the
// node_modules case itself (esbuild skips unnamed tsconfigs there) is proven only by an app's synth, not here.
test('a construct-bundled handler starts with "use strict"', () => {
  const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'fair-meter-bundle-'));
  const app = new cdk.App({ outdir });
  const s = new cdk.Stack(app, 'S');
  const table = new dynamodb.Table(s, 'T', { partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING } });
  const alarmAction = { bind: () => ({ alarmActionArn: 'arn:aws:sns:us-east-2:111111111111:a' }) } as cloudwatch.IAlarmAction;
  new MeteringRetry(s, 'Retry', { table, alarmAction });
  app.synth();
  const bundles = fs.readdirSync(outdir).filter((d) => d.startsWith('asset.')).map((d) => path.join(outdir, d, 'index.js'));
  // The retry Lambda and the redrive.
  expect(bundles).toHaveLength(2);
  for (const b of bundles) expect(fs.readFileSync(b, 'utf8').startsWith('"use strict";')).toBe(true);
}, 60_000);
