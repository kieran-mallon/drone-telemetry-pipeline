# Infrastructure

The AWS deployment, defined in Pulumi (TypeScript). One file, `index.ts`, in
the order the resources depend on each other: bucket, queues, networking and
database, IAM, the function, alarms.

## What it creates

| Resource | Why |
|---|---|
| S3 bucket (`*-raw`) | Landing zone for batch files, and the durable archive that makes replay possible. Encrypted, versioned, no public access, lifecycle to Glacier. |
| SQS queue (`*-ingest`) | Buffers ingestion, gives per-message retry, decouples the drone fleet's rate from the database's. |
| SQS queue (`*-dlq`) | Messages that failed 3 times. 14 day retention, because a dead letter is a bug report. |
| Queue policy | Allows S3 to publish, scoped with `aws:SourceArn` so no other bucket can. |
| Bucket notification | `s3:ObjectCreated:*` to the ingest queue. The only trigger in the system. |
| RDS Postgres | Private, encrypted, reachable only from the Lambda's security group. Optional via `deployDatabase`. |
| Secrets Manager secret | The connection string. Never in an environment variable, never in the repo. |
| IAM role and policy | Least privilege. See below. |
| Lambda function | The processor. Bundled by `npm run package:lambda`. |
| Event source mapping | `ReportBatchItemFailures`, batch size 10, concurrency capped at 10. |
| CloudWatch log group | 30 day retention. |
| 2 CloudWatch alarms | Anything in the DLQ; sustained function errors. |

## Permissions

Every statement in the processor's policy names a specific resource ARN. There
is no `"Resource": "*"` anywhere in this stack.

- **SQS**: receive, delete, change visibility, get attributes, on the ingest
  queue only. Notably **not** `sqs:SendMessage`: the processor consumes, and has
  no reason to be able to publish.
- **S3**: `GetObject` and `ListBucket` on the raw bucket only. **Read only**, so
  a bug or a compromise cannot destroy the archive that makes replay possible.
- **Secrets Manager**: `GetSecretValue` on the one database secret.
- **CloudWatch Logs**: write to its own log group, not to every log group in the
  account.
- **VPC**: the AWS-managed `AWSLambdaVPCAccessExecutionRole`, for the network
  interface lifecycle. Those EC2 actions genuinely cannot be scoped to a
  resource, which is why this one is managed rather than hand-written.

S3 publishes to the queue through a resource policy on the queue, not through
the Lambda's role, so the bucket never assumes an identity of its own.

## Running it

```bash
cd infra
npm install
pulumi stack init dev
pulumi preview
```

`pulumi preview` is what has been run against this program. It has **not** been
deployed to a real AWS account; see the honesty note in the root README.

### Against LocalStack

`pulumilocal` wraps Pulumi with LocalStack's endpoints, which lets the same
program provision the local stack instead of `scripts/localstack-init.sh`:

```bash
pip install pulumi-local
cd infra
pulumilocal stack init localstack
pulumilocal up
```

That is the version with a single source of truth for the topology. The shell
script is kept as the zero-install path so a reviewer can run
`docker compose up` without installing Pulumi first.
