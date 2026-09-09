/**
 * The AWS deployment, as code.
 *
 * Pulumi in TypeScript, because it is what ScreenCloud uses and because it
 * keeps the infrastructure in the same language and the same review process as
 * the application. The alternative worth naming is the Serverless Framework,
 * which would express the Lambda and its event source in fewer lines but has
 * much less to say about the bucket policy, the queue redrive policy and the
 * IAM boundaries, which is where the interesting decisions in this stack live.
 *
 * Verified with `pulumi preview`. See the README for how to run this against
 * LocalStack, and for what has and has not been deployed to real AWS.
 */
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const prefix = `drone-telemetry-${stack}`;

/** Set false to skip RDS and supply DATABASE_URL yourself (much faster to preview). */
const deployDatabase = config.getBoolean('deployDatabase') ?? true;

const tags = {
  Project: 'drone-telemetry-pipeline',
  Stack: stack,
  ManagedBy: 'pulumi',
};

// ---------------------------------------------------------------------------
// Raw telemetry bucket
//
// The landing zone for batch files, and the durable archive of everything ever
// received. Keeping the raw objects is deliberate: if a transform bug is found
// six months from now, the fix is to replay this bucket rather than to ask the
// fleet to resend data it no longer has.
// ---------------------------------------------------------------------------

const rawBucket = new aws.s3.BucketV2(`${prefix}-raw`, { tags });

// No object in this bucket should ever be publicly readable. Set explicitly
// rather than relying on the account default, so the guarantee is visible in
// the code and cannot be weakened by a later account-level change.
new aws.s3.BucketPublicAccessBlock(`${prefix}-raw-no-public`, {
  bucket: rawBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
});

new aws.s3.BucketServerSideEncryptionConfigurationV2(`${prefix}-raw-encryption`, {
  bucket: rawBucket.id,
  rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: 'AES256' } }],
});

// Versioning protects against an accidental overwrite of a batch file that has
// not been processed yet.
new aws.s3.BucketVersioningV2(`${prefix}-raw-versioning`, {
  bucket: rawBucket.id,
  versioningConfiguration: { status: 'Enabled' },
});

// Telemetry is queried from Postgres, not from S3, so raw objects only need to
// be quickly reachable while a replay is plausible. Ageing them into colder
// storage is most of the cost of this pipeline at fleet scale.
new aws.s3.BucketLifecycleConfigurationV2(`${prefix}-raw-lifecycle`, {
  bucket: rawBucket.id,
  rules: [
    {
      id: 'archive-raw-telemetry',
      status: 'Enabled',
      filter: {},
      transitions: [
        { days: 30, storageClass: 'STANDARD_IA' },
        { days: 90, storageClass: 'GLACIER_IR' },
      ],
      noncurrentVersionExpiration: { noncurrentDays: 30 },
      abortIncompleteMultipartUpload: { daysAfterInitiation: 7 },
    },
  ],
});

// ---------------------------------------------------------------------------
// Queues
//
// The dead-letter queue is created first, because the ingest queue's redrive
// policy has to reference it.
// ---------------------------------------------------------------------------

const deadLetterQueue = new aws.sqs.Queue(`${prefix}-dlq`, {
  // 14 days, the maximum. A DLQ message is a bug report, and bug reports should
  // outlive a long weekend and a holiday.
  messageRetentionSeconds: 14 * 24 * 60 * 60,
  sqsManagedSseEnabled: true,
  tags,
});

const ingestQueue = new aws.sqs.Queue(`${prefix}-ingest`, {
  /**
   * Must comfortably exceed the Lambda timeout, or SQS makes a message visible
   * again while the function is still working on it and a second invocation
   * picks it up. Idempotency makes that survivable rather than corrupting, but
   * it is still duplicated work and it inflates the receive count towards the
   * DLQ. 6x the function timeout is the conventional margin.
   */
  visibilityTimeoutSeconds: 180,

  messageRetentionSeconds: 4 * 24 * 60 * 60,
  sqsManagedSseEnabled: true,

  redrivePolicy: pulumi.jsonStringify({
    deadLetterTargetArn: deadLetterQueue.arn,
    /**
     * Three attempts. A message that has failed three times is not going to
     * succeed on the fourth, and leaving it on the queue starves everything
     * behind it. Note this only ever applies to infrastructure failures: bad
     * data is quarantined in Postgres and acknowledged, so it never reaches
     * here. That separation is what keeps this queue meaningful as an alarm.
     */
    maxReceiveCount: 3,
  }),

  tags,
});

/**
 * S3 refuses to create a notification configuration unless the target queue
 * already allows it to publish.
 *
 * The `aws:SourceArn` condition is the part that matters. Without it, any S3
 * bucket in any account could send messages to this queue, since the principal
 * is the S3 service itself rather than a specific bucket. This is the standard
 * confused-deputy protection and it is easy to leave out, because the wiring
 * works perfectly well without it.
 */
new aws.sqs.QueuePolicy(`${prefix}-ingest-policy`, {
  queueUrl: ingestQueue.id,
  policy: pulumi.jsonStringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 's3.amazonaws.com' },
        Action: 'sqs:SendMessage',
        Resource: ingestQueue.arn,
        Condition: { ArnLike: { 'aws:SourceArn': rawBucket.arn } },
      },
    ],
  }),
});

/**
 * The event trigger. A file landing in the bucket is the only thing that starts
 * work: nothing polls, nothing runs on a schedule.
 *
 * Suffix filters would be the obvious refinement, but they are left off
 * deliberately. An operator who uploads `batch.CSV` or `batch.txt` should get a
 * clear quarantine row explaining what was wrong with it, not silence.
 */
new aws.s3.BucketNotification(`${prefix}-raw-notification`, {
  bucket: rawBucket.id,
  queues: [{ queueArn: ingestQueue.arn, events: ['s3:ObjectCreated:*'] }],
});

// ---------------------------------------------------------------------------
// Networking and database
//
// The default VPC is used to keep this program readable. A production stack
// would define its own VPC with private subnets and no internet gateway on the
// data tier; that is a large amount of plumbing that would obscure the parts of
// this file worth reviewing. The security group boundaries below are the same
// either way.
// ---------------------------------------------------------------------------

const defaultVpc = aws.ec2.getVpcOutput({ default: true });
const defaultSubnets = aws.ec2.getSubnetsOutput({
  filters: [{ name: 'vpc-id', values: [defaultVpc.id] }],
});

const lambdaSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-lambda-sg`, {
  vpcId: defaultVpc.id,
  description: 'Telemetry processor Lambda',
  // Outbound only. The function initiates connections to Postgres, S3 and SQS;
  // nothing ever needs to connect to it.
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags,
});

const databaseSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-db-sg`, {
  vpcId: defaultVpc.id,
  description: 'Telemetry Postgres',
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      // Scoped to the Lambda's security group, not to a CIDR block. Nothing
      // else in the VPC can open a connection to this database.
      securityGroups: [lambdaSecurityGroup.id],
      description: 'Postgres from the telemetry processor only',
    },
  ],
  tags,
});

const databasePassword = new aws.secretsmanager.Secret(`${prefix}-db-credentials`, {
  description: 'Connection string for the telemetry Postgres instance',
  // Short window so a mistaken delete can be undone, without leaving orphaned
  // secrets around for a month in a stack that is torn down often.
  recoveryWindowInDays: 7,
  tags,
});

let databaseEndpoint: pulumi.Output<string> | undefined;

if (deployDatabase) {
  const subnetGroup = new aws.rds.SubnetGroup(`${prefix}-db-subnets`, {
    subnetIds: defaultSubnets.ids,
    tags,
  });

  const password = new aws.secretsmanager.Secret(`${prefix}-db-password`, {
    recoveryWindowInDays: 7,
    tags,
  });

  const generated = new aws.secretsmanager.SecretVersion(`${prefix}-db-password-value`, {
    secretId: password.id,
    // Generated outside version control. In a real stack this would come from
    // `manageMasterUserPassword`, which lets RDS own rotation entirely.
    secretString: pulumi.secret(config.require('dbPassword')),
  });

  const database = new aws.rds.Instance(`${prefix}-db`, {
    engine: 'postgres',
    engineVersion: '17',
    instanceClass: 'db.t4g.micro',
    allocatedStorage: 20,
    maxAllocatedStorage: 100,

    dbName: 'telemetry',
    username: 'telemetry',
    password: generated.secretString,

    dbSubnetGroupName: subnetGroup.name,
    vpcSecurityGroupIds: [databaseSecurityGroup.id],
    // Reachable only from inside the VPC.
    publiclyAccessible: false,
    storageEncrypted: true,

    backupRetentionPeriod: 7,
    deletionProtection: false,
    skipFinalSnapshot: true,

    // Time-series inserts are append-heavy; these surface a saturating instance
    // before it starts rejecting connections.
    performanceInsightsEnabled: true,
    enabledCloudwatchLogsExports: ['postgresql'],

    tags,
  });

  databaseEndpoint = database.endpoint;

  new aws.secretsmanager.SecretVersion(`${prefix}-db-credentials-value`, {
    secretId: databasePassword.id,
    secretString: pulumi
      .all([database.endpoint, generated.secretString])
      .apply(([endpoint, secret]) => `postgres://telemetry:${secret}@${endpoint}/telemetry`),
  });
}

// ---------------------------------------------------------------------------
// IAM
//
// The brief asks that permissions be considered. The rule applied throughout:
// every statement names a specific resource ARN. There is not a single '*' on a
// Resource in this stack, which is the difference between a compromised
// function reading one bucket and a compromised function reading the account.
// ---------------------------------------------------------------------------

const lambdaRole = new aws.iam.Role(`${prefix}-processor-role`, {
  assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: 'lambda.amazonaws.com' }),
  tags,
});

// AWS-managed policy for the ENI lifecycle a VPC-attached Lambda needs. Those
// EC2 actions genuinely cannot be scoped to a resource, which is exactly why
// this one is a managed policy rather than something hand-written above.
new aws.iam.RolePolicyAttachment(`${prefix}-processor-vpc-access`, {
  role: lambdaRole.name,
  policyArn: aws.iam.ManagedPolicy.AWSLambdaVPCAccessExecutionRole,
});

const logGroup = new aws.cloudwatch.LogGroup(`${prefix}-processor-logs`, {
  name: `/aws/lambda/${prefix}-processor`,
  // Logs are not the system of record; the database is. Thirty days is enough
  // to debug an incident, and indefinite retention is a slow, invisible cost.
  retentionInDays: 30,
  tags,
});

new aws.iam.RolePolicy(`${prefix}-processor-policy`, {
  role: lambdaRole.id,
  policy: pulumi
    .all([ingestQueue.arn, rawBucket.arn, databasePassword.arn, logGroup.arn])
    .apply(([queueArn, bucketArn, secretArn, logGroupArn]) =>
      JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'ConsumeIngestQueue',
            Effect: 'Allow',
            Action: [
              'sqs:ReceiveMessage',
              'sqs:DeleteMessage',
              'sqs:GetQueueAttributes',
              'sqs:ChangeMessageVisibility',
            ],
            // This queue only. Notably absent: sqs:SendMessage. The processor
            // consumes; it has no reason to be able to publish.
            Resource: queueArn,
          },
          {
            Sid: 'ReadRawTelemetry',
            Effect: 'Allow',
            // Read only. The processor never writes to or deletes from the raw
            // bucket, so a bug or a compromise cannot destroy the archive that
            // makes replay possible.
            Action: ['s3:GetObject', 's3:GetObjectVersion'],
            Resource: `${bucketArn}/*`,
          },
          {
            Sid: 'ListRawBucket',
            Effect: 'Allow',
            Action: ['s3:ListBucket'],
            // Scoped to the bucket itself, which is what turns a missing object
            // into a clean NoSuchKey rather than an AccessDenied.
            Resource: bucketArn,
          },
          {
            Sid: 'ReadDatabaseCredentials',
            Effect: 'Allow',
            Action: ['secretsmanager:GetSecretValue'],
            Resource: secretArn,
          },
          {
            Sid: 'WriteOwnLogs',
            Effect: 'Allow',
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            // Its own log group, not every log group in the account.
            Resource: `${logGroupArn}:*`,
          },
        ],
      }),
    ),
});

// ---------------------------------------------------------------------------
// The processor
// ---------------------------------------------------------------------------

const processor = new aws.lambda.Function(`${prefix}-processor`, {
  name: `${prefix}-processor`,
  role: lambdaRole.arn,
  runtime: aws.lambda.Runtime.NodeJS22dX,
  handler: 'index.handler',

  /**
   * Built by `npm run package:lambda`, which esbuild-bundles the handler and
   * its dependencies into a single file. Shipping node_modules instead would
   * mean a ~40MB archive against roughly 2MB bundled, and Lambda cold start
   * scales with archive size.
   */
  code: new pulumi.asset.FileArchive('../dist-lambda'),

  // Generous enough for a large batch file, and 1/6 of the queue's visibility
  // timeout so a slow invocation never races its own redelivery.
  timeout: 30,

  /**
   * Lambda allocates CPU in proportion to memory, so this is a throughput dial
   * as much as a memory one. 512MB is a starting point to be tuned against real
   * batch sizes, not a considered final answer.
   */
  memorySize: 512,

  // Required to reach a Postgres instance that is not publicly accessible.
  vpcConfig: {
    subnetIds: defaultSubnets.ids,
    securityGroupIds: [lambdaSecurityGroup.id],
  },

  environment: {
    variables: {
      RAW_BUCKET: rawBucket.bucket,
      DB_SECRET_ARN: databasePassword.arn,
      LOG_LEVEL: 'info',
      NODE_OPTIONS: '--enable-source-maps',
    },
  },

  tags,
}, { dependsOn: [logGroup] });

new aws.lambda.EventSourceMapping(`${prefix}-processor-trigger`, {
  eventSourceArn: ingestQueue.arn,
  functionName: processor.arn,

  // Up to 10 messages per invocation, but do not wait more than 5 seconds to
  // fill a batch. Larger batches are cheaper per record; the window is what
  // stops a quiet period from delaying the first message behind it.
  batchSize: 10,
  maximumBatchingWindowInSeconds: 5,

  /**
   * The counterpart to the `batchItemFailures` the handler returns. Without
   * this declared, SQS ignores the partial response and redelivers the entire
   * batch when any single message fails, so nine healthy messages get
   * reprocessed because of one bad neighbour and their receive counts march
   * towards the DLQ.
   */
  functionResponseTypes: ['ReportBatchItemFailures'],

  scalingConfig: {
    /**
     * The backpressure valve, and the reason this number is small.
     *
     * Each concurrent invocation opens its own Postgres connections, so
     * unbounded Lambda scaling against a t4g.micro is a self-inflicted denial
     * of service: the queue absorbs a spike safely, then the function turns
     * that spike into hundreds of simultaneous connections and takes the
     * database down. Capping concurrency here means a backlog drains a little
     * slower and nothing falls over. RDS Proxy is the alternative; see README.
     */
    maximumConcurrency: 10,
  },
});

// ---------------------------------------------------------------------------
// Alarms
//
// Two alarms, chosen because they answer different questions. Anything in the
// DLQ means messages are being lost after exhausting their retries. Sustained
// function errors mean the pipeline is degraded but still trying.
// ---------------------------------------------------------------------------

new aws.cloudwatch.MetricAlarm(`${prefix}-dlq-not-empty`, {
  alarmDescription: 'Telemetry messages have exhausted their retries and been dead-lettered',
  namespace: 'AWS/SQS',
  metricName: 'ApproximateNumberOfMessagesVisible',
  dimensions: { QueueName: deadLetterQueue.name },
  statistic: 'Maximum',
  period: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: 'GreaterThanThreshold',
  // A DLQ that reports no data is a healthy DLQ, not a broken alarm.
  treatMissingData: 'notBreaching',
  tags,
});

new aws.cloudwatch.MetricAlarm(`${prefix}-processor-errors`, {
  alarmDescription: 'The telemetry processor is failing invocations',
  namespace: 'AWS/Lambda',
  metricName: 'Errors',
  dimensions: { FunctionName: processor.name },
  statistic: 'Sum',
  period: 300,
  // Two consecutive periods, so a single transient failure does not page anyone.
  evaluationPeriods: 2,
  threshold: 5,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
  tags,
});

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export const rawBucketName = rawBucket.bucket;
export const ingestQueueUrl = ingestQueue.url;
export const deadLetterQueueUrl = deadLetterQueue.url;
export const processorFunctionName = processor.name;
export const databaseSecretArn = databasePassword.arn;
export const databaseHost = databaseEndpoint ?? pulumi.output('not deployed (deployDatabase=false)');
