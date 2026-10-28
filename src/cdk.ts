import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import * as athena from 'aws-cdk-lib/aws-athena';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
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
import { EXPORT_COLUMNS, streamFilterPattern } from './export';
import { DEFAULT_TABLE_KEYS, type TableKeys } from './keys';
import { LOW_BALANCE_USD_DEFAULT } from './reconcile';

/** Every construct takes the table's key names when they aren't the defaults (keys.ts). */
interface TableKeysProps {
  /** e.g. `{ pk: 'pk', sk: 'sk' }`; omitted = PK / SK / USER#<sub>. Must match the app's `setTableKeys`. */
  tableKeys?: Partial<TableKeys>;
}

/** The module's own Lambdas read the key names from this env (keys.ts); nothing is added for the defaults. */
const tableKeysEnv = (k?: Partial<TableKeys>): Record<string, string> => (k ? { METERING_TABLE_KEYS: JSON.stringify(k) } : {});

export interface MeteringRetryProps extends TableKeysProps {
  table: dynamodb.ITable;
  /** Where alarms go (e.g. an SNS action). */
  alarmAction: cloudwatch.IAlarmAction;
}

/**
 * Durable retry path for usage records: an SQS queue the apps' proxies send unrecorded usage to,
 * a small Lambda that records it (idempotently), and a dead-letter queue that alarms.
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
      environment: { TABLE_NAME: props.table.tableName, ...tableKeysEnv(props.tableKeys), NODE_OPTIONS: '--enable-source-maps' },
      logGroup: new logs.LogGroup(this, 'Logs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      loggingFormat: lambda.LoggingFormat.JSON,
      bundling: { minify: true, sourceMap: true },
    });
    // The usage transaction: one conditional Put plus Updates.
    props.table.grant(this.fn, 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    this.fn.addEventSource(new SqsEventSource(this.queue, { batchSize: 10, reportBatchItemFailures: true }));

    const parked = new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmDescription: 'Usage records could not be recorded after retries: check the metering DLQ, fix, then redrive',
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    parked.addAlarmAction(props.alarmAction);
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
      bundling: { minify: true, sourceMap: true },
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
      bundling: { minify: true, sourceMap: true },
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
      bundling: { minify: true, sourceMap: true },
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
