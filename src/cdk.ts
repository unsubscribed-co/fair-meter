import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as glue from 'aws-cdk-lib/aws-glue';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { assertTierThresholds, type TierThresholds } from './budget';
import { usdToMicroUsd } from './cost';
import { EXPORT_COLUMNS, streamFilterPattern } from './export';
import type { FairMeterConfig } from './fair-meter';
import { assertAppId, DEFAULT_TABLE_KEYS, type TableKeys } from './keys';
import { loadPriceFiles } from './prices-cli';
import { LOW_BALANCE_USD_DEFAULT } from './reconcile';

// esbuild skips tsconfig files inside node_modules, so name ours or the handlers lose "use strict" in an app's bundle.
const BUNDLING = { minify: true, sourceMap: true, tsconfig: path.join(__dirname, '..', 'tsconfig.json') };

/** Every construct takes the table's key names when they aren't the defaults (keys.ts). */
interface TableKeysProps {
  /** e.g. `{ pk: 'pk', sk: 'sk' }`; omitted = PK / SK / USER#<sub>. Must match the app's `setTableKeys`. */
  tableKeys?: Partial<TableKeys>;
}

/** The module's own Lambdas read the key names from this env (keys.ts); nothing is added for the defaults. */
const tableKeysEnv = (k?: Partial<TableKeys>): Record<string, string> => (k ? { METERING_TABLE_KEYS: JSON.stringify(k) } : {});

export interface MeteringRetryProps extends TableKeysProps {
  table: dynamodb.ITable;
  /** Where alarms go (e.g. an SNS action); omitted, the alarms exist with no action. */
  alarmAction?: cloudwatch.IAlarmAction;
}

/**
 * Durable retry path for usage records: an SQS queue the apps' proxies send unrecorded usage to,
 * a small Lambda that records it (idempotently), a dead-letter queue that alarms, and a nightly
 * redrive that puts the DLQ's valid records back, at most 3 times per call (redrive-handler.ts).
 *
 * Why a queue and not just retrying inline: the SDK already retries inside the request; when
 * DynamoDB is still failing after that, waiting longer would hold the user's answer hostage and
 * still lose the record if the Lambda dies. SQS keeps it for days, retries every minute, and parks
 * it in the DLQ (alarm, console redrive) instead of dropping it.
 */
export class MeteringRetry extends Construct {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly fn: lambdaNode.NodejsFunction;
  readonly redrive: lambdaNode.NodejsFunction;

  constructor(scope: Construct, id: string, props: MeteringRetryProps) {
    super(scope, id);

    this.deadLetterQueue = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.queue = new sqs.Queue(this, 'Queue', {
      // >= 6x the consumer timeout, as Lambda recommends for SQS sources.
      visibilityTimeout: cdk.Duration.seconds(60),
      retentionPeriod: cdk.Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // ~10 minutes of retries before a record is parked.
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 10 },
    });

    this.fn = new lambdaNode.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'retry-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: { TABLE_NAME: props.table.tableName, DLQ_URL: this.deadLetterQueue.queueUrl, ...tableKeysEnv(props.tableKeys), NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    // The usage transaction: one conditional Put plus Updates.
    props.table.grant(this.fn, 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    this.fn.addEventSource(new SqsEventSource(this.queue, { batchSize: 10, reportBatchItemFailures: true }));
    // A message that can never be recorded is parked at once.
    this.deadLetterQueue.grantSendMessages(this.fn);

    this.redrive = new lambdaNode.NodejsFunction(this, 'Redrive', {
      entry: path.join(__dirname, 'redrive-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      // Below the redrive's receive visibility (6 minutes), so no message is seen twice in one run.
      timeout: cdk.Duration.minutes(5),
      environment: {
        TABLE_NAME: props.table.tableName, QUEUE_URL: this.queue.queueUrl, DLQ_URL: this.deadLetterQueue.queueUrl,
        ...tableKeysEnv(props.tableKeys), NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'RedriveLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    // The redrive count (REDRIVE#<app> / CALL#<callId>).
    props.table.grant(this.redrive, 'dynamodb:UpdateItem');
    this.deadLetterQueue.grantConsumeMessages(this.redrive);
    this.queue.grantSendMessages(this.redrive);
    new events.Rule(this, 'RedriveSchedule', {
      description: 'Put valid usage records parked in the metering DLQ back on the retry queue',
      schedule: events.Schedule.cron({ minute: '0', hour: '4' }),
      targets: [new eventsTargets.LambdaFunction(this.redrive, { retryAttempts: 2 })],
    });

    const parked = new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmDescription: 'Usage records could not be recorded after retries: check the metering DLQ, fix, then redrive',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (props.alarmAction) parked.addAlarmAction(props.alarmAction);
    // The DLQ drops a message 14 days after its first enqueue: this leaves a week to redrive it (M3).
    const ageing = new cloudwatch.Alarm(this, 'DlqAgeAlarm', {
      alarmDescription: 'A usage record has waited 7 days in the metering DLQ; it is dropped at 14: fix, then redrive',
      metric: this.deadLetterQueue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.hours(1), statistic: 'Maximum' }),
      threshold: cdk.Duration.days(7).toSeconds(),
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    if (props.alarmAction) ageing.addAlarmAction(props.alarmAction);
  }

  /** Lets an app's proxy defer records to the queue. Returns the env var value it needs. */
  grantSend(grantee: lambda.IFunction): string {
    this.queue.grantSendMessages(grantee);
    return this.queue.queueUrl;
  }
}

export interface MeteringExportProps extends TableKeysProps {
  /** The metering table; it must have a stream with NEW_IMAGE (or NEW_AND_OLD_IMAGES). */
  table: dynamodb.ITable;
  /** Where alarms go (e.g. an SNS action). */
  alarmAction: cloudwatch.IAlarmAction;
  /** Apps sharing the table: the `app` partition values Athena may query. */
  appIds: string[];
  /** App that pre-appId items belong to. */
  legacyAppId: string;
  /** First `dt` partition (YYYY-MM-DD, UTC) Athena projects. */
  firstDay: string;
  /** Glue database, table and Athena workgroup names (one per account and region). */
  databaseName?: string;
  tableName?: string;
  workGroupName?: string;
}

/**
 * Analytics pipeline for the cost ledger: table stream -> small consumer Lambda -> NDJSON in S3 ->
 * Glue table with partition projection -> Athena workgroup. Statements and dashboards can query
 * this instead of scanning the table. Rows: see export.ts.
 */
export class MeteringExport extends Construct {
  readonly bucket: s3.Bucket;
  readonly resultsBucket: s3.Bucket;
  readonly failureQueue: sqs.Queue;
  readonly fn: lambdaNode.NodejsFunction;
  readonly databaseName: string;
  readonly tableName: string;
  readonly workGroupName: string;
  readonly workGroup: athena.CfnWorkGroup;

  constructor(scope: Construct, id: string, props: MeteringExportProps) {
    super(scope, id);
    this.databaseName = props.databaseName ?? 'metering';
    this.tableName = props.tableName ?? 'ledger';
    this.workGroupName = props.workGroupName ?? 'metering';

    // The exported ledger is billing history: private, encrypted, versioned, kept on stack deletion.
    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          // S3 skips objects under 128 KB by default (IA would bill them as 128 KB anyway).
          transitions: [{ storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(90) }],
          // Overwritten backfill objects: old versions stay long enough to notice a bad re-run.
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
    });

    // Query results are disposable.
    this.resultsBucket = new s3.Bucket(this, 'ResultsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    // Lambda sends a failed batch's stream coordinates here once its retries are exhausted.
    this.failureQueue = new sqs.Queue(this, 'FailureQueue', {
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });

    this.fn = new lambdaNode.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'export-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: { BUCKET_NAME: this.bucket.bucketName, LEGACY_APP_ID: props.legacyAppId, ...tableKeysEnv(props.tableKeys), NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    this.bucket.grantPut(this.fn);
    this.fn.addEventSource(
      new DynamoEventSource(props.table, {
        // The stream keeps 24 h; start at its oldest record so nothing written since enabling it is skipped.
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 100,
        // Fewer, larger objects; nobody reads the export in real time.
        maxBatchingWindow: cdk.Duration.seconds(60),
        retryAttempts: 10,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(this.failureQueue),
        filters: [lambda.FilterCriteria.filter(streamFilterPattern(props.tableKeys?.sk ?? DEFAULT_TABLE_KEYS.sk))],
      }),
    );

    // Same shape as the retry DLQ alarm.
    const failed = new cloudwatch.Alarm(this, 'FailureAlarm', {
      alarmDescription: 'Ledger export to S3 gave up on a stream batch: check the export Lambda logs, then run export-backfill',
      metric: this.failureQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failed.addAlarmAction(props.alarmAction);

    const database = new glue.CfnDatabase(this, 'Database', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseInput: { name: this.databaseName, description: 'Metering cost ledger (EVENT and ADJUST items)' },
    });
    const location = `s3://${this.bucket.bucketName}/`;
    const table = new glue.CfnTable(this, 'Table', {
      catalogId: cdk.Aws.ACCOUNT_ID,
      databaseName: this.databaseName,
      tableInput: {
        name: this.tableName,
        tableType: 'EXTERNAL_TABLE',
        partitionKeys: [
          { name: 'app', type: 'string' },
          { name: 'dt', type: 'string' },
        ],
        // Partition projection: Athena derives partitions from these rules; no crawler, no MSCK REPAIR.
        parameters: {
          classification: 'json',
          'projection.enabled': 'true',
          'projection.app.type': 'enum',
          'projection.app.values': props.appIds.join(','),
          'projection.dt.type': 'date',
          'projection.dt.format': 'yyyy-MM-dd',
          'projection.dt.range': `${props.firstDay},NOW`,
          'projection.dt.interval': '1',
          'projection.dt.interval.unit': 'DAYS',
          'storage.location.template': `${location}app=\${app}/dt=\${dt}/`,
        },
        storageDescriptor: {
          location,
          columns: EXPORT_COLUMNS,
          inputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
          outputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
          serdeInfo: { serializationLibrary: 'org.openx.data.jsonserde.JsonSerDe' },
        },
      },
    });
    table.addResourceDependency(database);

    this.workGroup = new athena.CfnWorkGroup(this, 'WorkGroup', {
      name: this.workGroupName,
      description: 'Metering ledger queries',
      // Deleting the stack drops saved queries and history only; both buckets are retained.
      recursiveDeleteOption: true,
      workGroupConfiguration: {
        enforceWorkGroupConfiguration: true,
        // A mistaken full scan stops at 1 GB (about half a cent).
        bytesScannedCutoffPerQuery: 1_000_000_000,
        publishCloudWatchMetricsEnabled: true,
        resultConfiguration: {
          outputLocation: `s3://${this.resultsBucket.bucketName}/`,
          encryptionConfiguration: { encryptionOption: 'SSE_S3' },
        },
      },
    });
  }
}

export interface DeepSeekReconciliationProps extends TableKeysProps {
  /** The metering table (snapshots and PROVIDER#deepseek day counters live there). */
  table: dynamodb.ITable;
  /** Where alarms go (e.g. an SNS action). */
  alarmAction: cloudwatch.IAlarmAction;
  /** The SecureString with the DeepSeek API key: the same parameter the proxy reads. */
  apiKeyParam: ssm.IParameter;
  /** e.g. https://api.deepseek.com/user/balance */
  balanceUrl: string;
  /** CloudWatch namespace for the DeepSeekDrift* metrics. */
  metricNamespace: string;
  /** Email when the DeepSeek balance falls below this many USD (default 1). */
  lowBalanceUsd?: number;
}

/**
 * Daily DeepSeek balance reconciliation (see reconcile.ts): an EventBridge rule at 00:00 UTC runs a
 * small Lambda that snapshots the balance and compares the day window with our metered base cost.
 * Alarms when the window drifts (DeepSeekDriftBreached) and when the run itself fails.
 *
 * Least privilege: the key parameter, Query/PutItem on PROVIDER# partitions only (snapshots and
 * provider counters; no user data), and PutMetricData in its own namespace.
 */
export class DeepSeekReconciliation extends Construct {
  readonly fn: lambdaNode.NodejsFunction;
  readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: DeepSeekReconciliationProps) {
    super(scope, id);

    this.fn = new lambdaNode.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'reconcile-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        TABLE_NAME: props.table.tableName,
        BALANCE_URL: props.balanceUrl,
        API_KEY_PARAM: props.apiKeyParam.parameterName,
        METRIC_NAMESPACE: props.metricNamespace,
        ...tableKeysEnv(props.tableKeys),
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    props.apiKeyParam.grantRead(this.fn);
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:PutItem'],
        resources: [props.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROVIDER#*'] } },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        // PutMetricData has no resource-level permissions; the namespace condition scopes it.
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': props.metricNamespace } },
      }),
    );

    // 00:00 UTC: windows are whole UTC days, matching the PROVIDER# DAILY# counters.
    this.rule = new events.Rule(this, 'Schedule', {
      description: 'Daily DeepSeek balance snapshot and reconciliation',
      schedule: events.Schedule.cron({ minute: '0', hour: '0' }),
      targets: [new eventsTargets.LambdaFunction(this.fn, { retryAttempts: 2, maxEventAge: cdk.Duration.minutes(10) })],
    });
    // A failed run is retried by Lambda (async invoke). Kept inside ALIGN_TOLERANCE_MS (15 min) so a
    // retried run still closes the day window; a later one would only be a mid-day snapshot.
    this.fn.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: cdk.Duration.minutes(10) });

    const drift = new cloudwatch.Alarm(this, 'DriftAlarm', {
      alarmDescription: 'DeepSeek spend and our metered base cost differ by >15% and >$0.05 for a day window: run `npm run admin -- reconcile`',
      metric: new cloudwatch.Metric({
        namespace: props.metricNamespace,
        metricName: 'DeepSeekDriftBreached',
        statistic: 'Maximum',
        period: cdk.Duration.hours(6),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const failed = new cloudwatch.Alarm(this, 'FailureAlarm', {
      alarmDescription: 'DeepSeek balance reconciliation failed (key, DeepSeek API or table): check its Lambda logs',
      metric: this.fn.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    // Daily snapshots: over a day, the lowest balance seen. Missing data (no run) is the failure alarm's job.
    const lowBalance = new cloudwatch.Alarm(this, 'LowBalanceAlarm', {
      alarmDescription: `DeepSeek balance below $${props.lowBalanceUsd ?? LOW_BALANCE_USD_DEFAULT}: top up at platform.deepseek.com (Gemini answers meanwhile)`,
      metric: new cloudwatch.Metric({ namespace: props.metricNamespace, metricName: 'DeepSeekBalanceUsd', statistic: 'Minimum', period: cdk.Duration.days(1) }),
      threshold: props.lowBalanceUsd ?? LOW_BALANCE_USD_DEFAULT,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const unavailable = new cloudwatch.Alarm(this, 'UnavailableAlarm', {
      alarmDescription: 'DeepSeek reports the account unavailable (no balance left?): Gemini is answering every call',
      metric: new cloudwatch.Metric({ namespace: props.metricNamespace, metricName: 'DeepSeekUnavailable', statistic: 'Maximum', period: cdk.Duration.days(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [drift, failed, lowBalance, unavailable]) alarm.addAlarmAction(props.alarmAction);
  }
}

export interface FreeTierWatchProps extends TableKeysProps {
  /** The metering table (PROVIDER#<provider> / MONTH#<YYYY-MM> counters live there). */
  table: dynamodb.ITable;
  /** Where alarms go (e.g. an SNS action). */
  alarmAction: cloudwatch.IAlarmAction;
  /** e.g. "gcp-tts". */
  provider: string;
  /** The attribute on the month item, e.g. "premiumChars". */
  counter: string;
  /** The cap the app routes by (e.g. 900,000 of Google's 1,000,000 free characters). */
  limit: number;
  /** Email once the month's counter reaches this percent of `limit` (e.g. 70). */
  alarmPct: number;
  /** CloudWatch namespace and metric prefix: publishes <prefix>Used and <prefix>Pct. */
  metricNamespace: string;
  metricPrefix: string;
  /** What the alarm email says, e.g. what steps down when the cap is reached. */
  description: string;
  /** Optional second alarm at 100 % of `limit` (once a month too), with this email text. */
  fullDescription?: string;
  /**
   * Optional: once a month, copy the size of last month's string set `fromSet` onto this month's item
   * as `to` (e.g. voiceHouseholds -> shareHouseholds: the divisor of a fairly shared pool).
   */
  shareCount?: { fromSet: string; to: string };
}

/**
 * Hourly check of one account-wide free-tier counter (free-tier.ts): a small Lambda reads this UTC
 * month's PROVIDER# MONTH# item and publishes it as a metric; an alarm emails once the month passes
 * `alarmPct` of the cap and clears when the next month starts. A metric rather than a log line, so
 * the alarm fires once per month, not once per call.
 *
 * Least privilege: GetItem on PROVIDER# partitions only, PutMetricData in its own namespace.
 */
export class FreeTierWatch extends Construct {
  readonly fn: lambdaNode.NodejsFunction;
  readonly alarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: FreeTierWatchProps) {
    super(scope, id);
    if (!Number.isInteger(props.limit) || props.limit <= 0) throw new Error('FreeTierWatch limit must be a positive integer');
    if (!Number.isInteger(props.alarmPct) || props.alarmPct <= 0 || props.alarmPct > 100) throw new Error('FreeTierWatch alarmPct must be 1..100');

    this.fn = new lambdaNode.NodejsFunction(this, 'Fn', {
      entry: path.join(__dirname, 'free-tier-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 128,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: props.table.tableName,
        PROVIDER: props.provider,
        COUNTER: props.counter,
        LIMIT: String(props.limit),
        METRIC_NAMESPACE: props.metricNamespace,
        METRIC_PREFIX: props.metricPrefix,
        ...(props.shareCount ? { SHARE_FROM_SET: props.shareCount.fromSet, SHARE_TO: props.shareCount.to } : {}),
        ...tableKeysEnv(props.tableKeys),
        NODE_OPTIONS: '--enable-source-maps',
      },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        // UpdateItem only to copy the share count onto this month's item.
        actions: props.shareCount ? ['dynamodb:GetItem', 'dynamodb:UpdateItem'] : ['dynamodb:GetItem'],
        resources: [props.table.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROVIDER#*'] } },
      }),
    );
    this.fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cloudwatch:PutMetricData'],
        // PutMetricData has no resource-level permissions; the namespace condition scopes it.
        resources: ['*'],
        conditions: { StringEquals: { 'cloudwatch:namespace': props.metricNamespace } },
      }),
    );

    new events.Rule(this, 'Schedule', {
      description: `Hourly ${props.provider} ${props.counter} free-tier check`,
      schedule: events.Schedule.cron({ minute: '5' }),
      targets: [new eventsTargets.LambdaFunction(this.fn, { retryAttempts: 2, maxEventAge: cdk.Duration.minutes(30) })],
    });

    this.alarm = new cloudwatch.Alarm(this, 'Alarm', {
      alarmDescription: props.description,
      metric: new cloudwatch.Metric({
        namespace: props.metricNamespace,
        metricName: `${props.metricPrefix}Pct`,
        statistic: 'Maximum',
        period: cdk.Duration.hours(1),
      }),
      threshold: props.alarmPct,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      // A missed run keeps the state: one email when the month crosses, OK again with the next month.
      treatMissingData: cloudwatch.TreatMissingData.IGNORE,
    });
    // At 100 %: a second email, once a month like the first.
    const full = props.fullDescription
      ? [new cloudwatch.Alarm(this, 'FullAlarm', {
          alarmDescription: props.fullDescription,
          metric: new cloudwatch.Metric({
            namespace: props.metricNamespace,
            metricName: `${props.metricPrefix}Pct`,
            statistic: 'Maximum',
            period: cdk.Duration.hours(1),
          }),
          threshold: 100,
          evaluationPeriods: 1,
          comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.IGNORE,
        })]
      : [];
    const failed = new cloudwatch.Alarm(this, 'FailureAlarm', {
      alarmDescription: `${props.provider} free-tier check failed (table or metrics): check its Lambda logs`,
      metric: this.fn.metricErrors({ period: cdk.Duration.hours(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    for (const alarm of [this.alarm, ...full, failed]) alarm.addAlarmAction(props.alarmAction);
  }
}

export interface MeteringProps {
  /** Which app ("stacksplit"); prefixes its counters, events and pending rows. */
  appId: string;
  /** Which deployment ("prod" | "dev"), written on every EVENT. */
  env: string;
  /** Where alarms go (e.g. an SNS action); omitted, the alarms exist with no action. */
  alarmAction?: cloudwatch.IAlarmAction;
  /** Per person per UTC day, decimal USD ("0.50"), parsed exactly at synth. Reserved atomically. */
  dailyCapUsd: string;
  /** Everyone in this app per UTC day, decimal USD: a soft breaker. */
  appDailyCapUsd: string;
  /** Every app in the table per UTC day, decimal USD: a soft breaker. */
  allAppsDailyCapUsd?: string;
  /** Calls per person per UTC minute (a brake against loops). */
  maxCallsPerMinute?: number;
  tiers?: TierThresholds;
  /** 'hosted' needs the wallet, which doesn't exist yet: refused at synth. */
  billing?: 'none' | 'hosted';
  /** The app's actions (`action`, `canWrite`); the floor is computed from these at synth. Omitted: no actions. */
  actions?: {
    /** Action SKUs, each a `unit: "units"` price file in this package's prices/. */
    skus: string[];
    /** Per person, per function instance, per UTC minute (default 20). */
    perPersonPerMinute?: number;
    /** The most instances of the granted functions that can run at once (default 10). */
    maxConcurrency?: number;
    /**
     * true (prod): every function given to `grant` must set reserved concurrency, at most
     * maxConcurrency in total, checked at synth. Omitted (dev): the account's concurrency limit
     * must be at most maxConcurrency, since it is then the bound.
     */
    reserveConcurrency?: boolean;
  };
}

/** Log terms that mean money may be wrong or calls are refused; each alarms within 5 minutes. */
const METERING_ERRORS = ['METER_UNAVAILABLE', 'PRICE_MISSING', 'SERVICE_PAUSED', 'CALL_EXCEEDS_CAP', 'CALL_ID_REUSED', 'USAGE_MISSING', 'RECORD_CONFLICT', 'USAGE_RECORD_FAILED', 'RESERVATION_EXCEEDED', 'USAGE_RECORD_PARKED', 'ACTION_UNKNOWN',
  'ACTION_UNPRICED', 'ROLLUP_TRUNCATED', 'ROLLUP_FAILED', 'ROLLUP_LATE'];

/**
 * FairMeter's infrastructure, from one config: the retry queue (MeteringRetry), the sweeper that
 * settles holds nobody settled, with `actions` the rollup that charges them, and their alarms, all
 * writing to the ledger table it owns. `grant(fn)` lets an app function use `new FairMeter()`: IAM on
 * the ledger table and queue, the FAIR_METER env, an alarm on its metering error lines, and its log
 * group in the rollup's query.
 */
export class Metering extends Construct {
  /** The ledger table: prices, counters, holds and the ledger, nothing of the app's. */
  readonly table: dynamodb.Table;
  readonly retry: MeteringRetry;
  readonly sweeper: lambdaNode.NodejsFunction;
  /** With `actions`: the rollup (rollup-handler.ts) that charges the granted functions' action lines. */
  readonly rollup?: lambdaNode.NodejsFunction;
  /** FairMeterConfig as the app reads it (table name and queue URL are CloudFormation tokens). */
  readonly config: FairMeterConfig;
  private readonly errors: cloudwatch.Metric;
  private grants = 0;
  /** With `actions.reserveConcurrency`: the most the granted functions may reserve, and what they reserve so far. */
  private readonly concurrency?: { max: number; reserved: number };
  /** The granted functions' log group names, which the rollup queries. */
  private readonly logGroups: string[] = [];

  constructor(scope: Construct, id: string, props: MeteringProps) {
    super(scope, id);
    // Untyped callers still passing v0.2.0's prop would otherwise write to a table nobody reads.
    if ((props as { table?: unknown }).table) throw new Error('Metering: v0.3.0 owns its ledger table: see Upgrading in the README');
    assertAppId(props.appId);
    if (props.billing === 'hosted') throw new Error("Metering: billing 'hosted' needs the wallet, which v0.2.0 doesn't have");
    const cap = (name: string, usd: string) => {
      const micro = usdToMicroUsd(usd);
      if (micro <= 0) throw new Error(`Metering: ${name} must be above 0`);
      return micro;
    };
    const dailyCapMicroUsd = cap('dailyCapUsd', props.dailyCapUsd);
    const appDailyCapMicroUsd = cap('appDailyCapUsd', props.appDailyCapUsd);
    if (dailyCapMicroUsd > appDailyCapMicroUsd) throw new Error('Metering: dailyCapUsd is above appDailyCapUsd');
    if (props.maxCallsPerMinute !== undefined && !(Number.isSafeInteger(props.maxCallsPerMinute) && props.maxCallsPerMinute > 0)) {
      throw new Error('Metering: maxCallsPerMinute must be a positive integer');
    }
    if (props.tiers) assertTierThresholds(props.tiers);
    const actions = props.actions && {
      skus: props.actions.skus,
      perPersonPerMinute: props.actions.perPersonPerMinute ?? 20,
      maxConcurrency: props.actions.maxConcurrency ?? 10,
    };
    const actionFloorMicroUsd = actions && floorMicroUsd(actions);
    if (actionFloorMicroUsd !== undefined && actionFloorMicroUsd >= dailyCapMicroUsd) {
      throw new Error(`Metering: the action floor (${actionFloorMicroUsd} micro-USD) must be below dailyCapUsd; lower perPersonPerMinute or maxConcurrency`);
    }
    if (actions && props.actions!.reserveConcurrency) this.concurrency = { max: actions.maxConcurrency, reserved: 0 };
    // Money records live here: never deleted with the stack, restorable to any second of the last 35 days.
    this.table = new dynamodb.Table(this, 'Ledger', {
      partitionKey: { name: DEFAULT_TABLE_KEYS.pk, type: dynamodb.AttributeType.STRING },
      sortKey: { name: DEFAULT_TABLE_KEYS.sk, type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    new cdk.CfnOutput(this, 'LedgerTableName', { value: this.table.tableName, description: `${props.appId} ${props.env} metering ledger table (prices-cli sync --table)` });

    this.retry = new MeteringRetry(this, 'Retry', { table: this.table, alarmAction: props.alarmAction });
    // FairMeter records: a refused settle reads the EVENT, and a settle deletes the PENDING row.
    this.table.grant(this.retry.fn, 'dynamodb:GetItem', 'dynamodb:DeleteItem');
    this.config = {
      appId: props.appId,
      env: props.env,
      tableName: this.table.tableName,
      retryQueueUrl: this.retry.queue.queueUrl,
      dailyCapMicroUsd,
      appDailyCapMicroUsd,
      ...(props.allAppsDailyCapUsd !== undefined ? { allAppsDailyCapMicroUsd: cap('allAppsDailyCapUsd', props.allAppsDailyCapUsd) } : {}),
      ...(props.maxCallsPerMinute !== undefined ? { maxCallsPerMinute: props.maxCallsPerMinute } : {}),
      ...(props.tiers ? { tiers: props.tiers } : {}),
      ...(actions ? { actions, actionFloorMicroUsd } : {}),
    };

    const sweeperLogs = new logs.LogGroup(this, 'SweeperLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY });
    this.sweeper = new lambdaNode.NodejsFunction(this, 'Sweeper', {
      entry: path.join(__dirname, 'sweep-handler.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      environment: { FAIR_METER: cdk.Stack.of(this).toJsonString(this.config), NODE_OPTIONS: '--enable-source-maps' },
      logGroup: sweeperLogs,
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: BUNDLING,
    });
    this.table.grant(this.sweeper, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
    new events.Rule(this, 'SweeperSchedule', {
      description: `Settle ${props.appId} reservations left open for 30 minutes`,
      schedule: events.Schedule.rate(cdk.Duration.minutes(10)),
      targets: [new eventsTargets.LambdaFunction(this.sweeper, { retryAttempts: 2 })],
    });

    const namespace = 'FairMeter';
    const swept = new logs.MetricFilter(this, 'SweptFilter', {
      logGroup: sweeperLogs,
      filterPattern: logs.FilterPattern.anyTerm('SETTLED_BY_SWEEPER'),
      metricNamespace: namespace,
      metricName: `${props.appId}-${props.env}-SettledBySweeper`,
      metricValue: '1',
    });
    this.errors = new cloudwatch.Metric({ namespace, metricName: `${props.appId}-${props.env}-MeteringErrors`, statistic: 'Sum', period: cdk.Duration.minutes(5) });
    const alarm = (alarmId: string, alarmDescription: string, metric: cloudwatch.IMetric) => {
      const a = new cloudwatch.Alarm(this, alarmId, {
        alarmDescription,
        metric,
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      if (props.alarmAction) a.addAlarmAction(props.alarmAction);
    };
    const where = `${props.appId} ${props.env}`;
    alarm('SweptAlarm', `${where}: the sweeper settled a call at its reservation (a crash or a missing record): check SETTLED_BY_SWEEPER in its logs`,
      swept.metric({ statistic: 'Sum', period: cdk.Duration.minutes(10) }));
    alarm('SweeperFailureAlarm', `${where}: the metering sweeper failed; open reservations stay held until it runs: check its logs`,
      this.sweeper.metricErrors({ period: cdk.Duration.minutes(10) }));
    // A record retried from the queue can still turn out a conflict: its Lambda's logs feed the same alarm.
    this.watchErrors(this.retry.fn);
    this.watchErrors(this.retry.redrive);
    let errors: cloudwatch.IMetric = this.errors;
    if (actions) {
      const rollup = new lambdaNode.NodejsFunction(this, 'Rollup', {
        entry: path.join(__dirname, 'rollup-handler.ts'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        // Up to 8 windows, one Logs Insights query each; well inside the 15 minutes between runs.
        timeout: cdk.Duration.minutes(5),
        environment: {
          FAIR_METER: cdk.Stack.of(this).toJsonString(this.config),
          LOG_GROUPS: cdk.Lazy.string({ produce: () => cdk.Fn.join(',', this.logGroups) }),
          NODE_OPTIONS: '--enable-source-maps',
        },
        logGroup: new logs.LogGroup(this, 'RollupLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
        loggingFormat: lambda.LoggingFormat.JSON,
        bundling: BUNDLING,
      });
      // Prices, the cursor and the usage transaction. StartQuery is granted per log group in grant().
      this.table.grant(rollup, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem');
      rollup.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:GetQueryResults'], resources: ['*'] }));
      // On the quarter hours: rate() can start anywhere in a window, so a window could wait 45 minutes, past the floor's 30.
      new events.Rule(this, 'RollupSchedule', {
        description: `Charge ${props.appId} action lines per person, SKU and 15-minute window`,
        schedule: events.Schedule.cron({ minute: '0/15' }),
        targets: [new eventsTargets.LambdaFunction(rollup, { retryAttempts: 2 })],
      });
      // A late window logs ROLLUP_LATE; a run that crashes or times out before logging anything counts as a metering error too.
      errors = new cloudwatch.MathExpression({
        expression: 'FILL(errors, 0) + FILL(rollupFailures, 0)',
        usingMetrics: { errors: this.errors, rollupFailures: rollup.metricErrors({ period: cdk.Duration.minutes(5) }) },
        period: cdk.Duration.minutes(5),
      });
      this.watchErrors(rollup);
      this.rollup = rollup;
    }
    alarm('ErrorsAlarm', `${where}: a metering error (${METERING_ERRORS.join(', ')})${actions ? ' or a failed rollup run' : ''}: check the app function's logs`, errors);
  }

  /**
   * Lets `fn` run `new FairMeter()`. Give `fn` its own `logGroup`: reading `fn.logGroup` otherwise
   * makes CDK add its log-retention custom resource.
   */
  grant(fn: lambda.Function): void {
    if (this.concurrency) {
      // The floor's proof: at most maxConcurrency instances can serve one person at once.
      const reserved = (fn.node.defaultChild as lambda.CfnFunction).reservedConcurrentExecutions;
      if (typeof reserved !== 'number') throw new Error(`Metering: ${fn.node.path} has no reserved concurrency (actions.reserveConcurrency)`);
      this.concurrency.reserved += reserved;
      if (this.concurrency.reserved > this.concurrency.max) {
        throw new Error(`Metering: the granted functions reserve ${this.concurrency.reserved} concurrency, above actions.maxConcurrency ${this.concurrency.max}`);
      }
    }
    this.table.grant(fn, 'dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem');
    this.retry.queue.grantSendMessages(fn);
    fn.addEnvironment('FAIR_METER', cdk.Stack.of(this).toJsonString(this.config));
    this.watchErrors(fn);
    if (this.rollup) {
      this.logGroups.push(fn.logGroup.logGroupName);
      this.rollup.addToRolePolicy(new iam.PolicyStatement({ actions: ['logs:StartQuery'], resources: [fn.logGroup.logGroupArn] }));
    }
  }

  /** Counts `fn`'s metering error lines into the ErrorsAlarm metric. */
  private watchErrors(fn: lambda.Function) {
    new logs.MetricFilter(this, `Errors${this.grants++}`, {
      logGroup: fn.logGroup,
      filterPattern: logs.FilterPattern.anyTerm(...METERING_ERRORS),
      metricNamespace: this.errors.namespace,
      metricName: this.errors.metricName,
      metricValue: '1',
    });
  }
}

/**
 * The most one person can spend on actions within one rollup lag (30 minutes): perPersonPerMinute
 * x 30 x maxConcurrency x the highest per-action price (rounded up) of any version of any action SKU.
 * Rounding each action up also covers the rollup's rounding up per window.
 */
function floorMicroUsd(a: { skus: string[]; perPersonPerMinute: number; maxConcurrency: number }): number {
  for (const [name, v] of Object.entries({ perPersonPerMinute: a.perPersonPerMinute, maxConcurrency: a.maxConcurrency })) {
    if (!(Number.isSafeInteger(v) && v > 0)) throw new Error(`Metering: actions.${name} must be a positive integer`);
  }
  if (!Array.isArray(a.skus) || !a.skus.length) throw new Error('Metering: actions.skus must list at least one action SKU');
  const files = loadPriceFiles();
  const perAction = Math.max(...a.skus.map((sku) => {
    const f = files.find((p) => p.sku === sku);
    if (!f) throw new Error(`Metering: action SKU ${sku} has no price file in prices/`);
    if (f.unit !== 'units') throw new Error(`Metering: ${sku} is priced in ${f.unit}, not per action (units)`);
    return Math.max(...f.versions.map((v) => Math.ceil(Number(v.microUsdPerKUnits) / 1000)));
  }));
  return a.perPersonPerMinute * 30 * a.maxConcurrency * perAction;
}
