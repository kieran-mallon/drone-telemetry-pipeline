#!/bin/bash
# ---------------------------------------------------------------------------
# Provisions the local AWS resources inside LocalStack.
#
# This mirrors what infra/index.ts defines in Pulumi for real AWS. Two
# definitions of the same topology is a genuine duplication and a real cost: it
# can drift. It is here on purpose, because the alternative (running the Pulumi
# program against LocalStack) would force every reviewer to install Pulumi and
# create a stack before they could run `docker compose up`. The README documents
# the Pulumi-against-LocalStack route for anyone who wants a single source of
# truth; this script is the zero-install path.
# ---------------------------------------------------------------------------
set -euo pipefail

REGION="eu-west-1"
ACCOUNT="000000000000"
BUCKET="drone-telemetry-raw"
QUEUE="drone-telemetry-ingest"
DLQ="drone-telemetry-dlq"

echo "[init] creating bucket ${BUCKET}"
awslocal s3api create-bucket \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null

echo "[init] creating dead-letter queue ${DLQ}"
awslocal sqs create-queue --queue-name "${DLQ}" --region "${REGION}" >/dev/null

DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${DLQ}"

# maxReceiveCount 3: a message that fails three times is not going to succeed on
# the fourth, and holding it on the main queue starves everything behind it.
echo "[init] creating ingest queue ${QUEUE} with redrive to ${DLQ}"
awslocal sqs create-queue \
  --queue-name "${QUEUE}" \
  --region "${REGION}" \
  --attributes "{
    \"VisibilityTimeout\": \"60\",
    \"MessageRetentionPeriod\": \"345600\",
    \"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"
  }" >/dev/null

QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:${QUEUE}"
QUEUE_URL="http://localhost:4566/${ACCOUNT}/${QUEUE}"

# S3 will refuse to create the notification unless the queue policy already
# allows it to publish. The aws:SourceArn condition is what stops any other
# bucket in the account from writing to this queue.
echo "[init] allowing s3 to publish to ${QUEUE}"
awslocal sqs set-queue-attributes \
  --queue-url "${QUEUE_URL}" \
  --region "${REGION}" \
  --attributes "{
    \"Policy\": \"{\\\"Version\\\":\\\"2012-10-17\\\",\\\"Statement\\\":[{\\\"Effect\\\":\\\"Allow\\\",\\\"Principal\\\":{\\\"Service\\\":\\\"s3.amazonaws.com\\\"},\\\"Action\\\":\\\"sqs:SendMessage\\\",\\\"Resource\\\":\\\"${QUEUE_ARN}\\\",\\\"Condition\\\":{\\\"ArnLike\\\":{\\\"aws:SourceArn\\\":\\\"arn:aws:s3:::${BUCKET}\\\"}}}]}\"
  }" >/dev/null

echo "[init] wiring ${BUCKET} ObjectCreated -> ${QUEUE}"
awslocal s3api put-bucket-notification-configuration \
  --bucket "${BUCKET}" \
  --region "${REGION}" \
  --notification-configuration "{
    \"QueueConfigurations\": [{
      \"QueueArn\": \"${QUEUE_ARN}\",
      \"Events\": [\"s3:ObjectCreated:*\"]
    }]
  }"

echo "[init] done. bucket=${BUCKET} queue=${QUEUE} dlq=${DLQ}"
