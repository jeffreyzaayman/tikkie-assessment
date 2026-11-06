# Person Service

A serverless microservice on AWS that stores persons and publishes a `PersonCreated` event to the rest of the microservice landscape for every new person. Built with AWS CDK (TypeScript) and Lambdas on Node.js 24.

- `POST /person` creates a person (first name, last name, phone number, address) in DynamoDB.
- Each new person fires a versioned `PersonCreated` event on an SNS topic.
- `GET /person` (paginated) and `GET /person/{id}` read persons back.
- The same code deploys to a `dev` and a `prod` stage, each in its own AWS account.
- A separate **Welcome Service** shows how another team would consume the event.

## Architecture

```mermaid
flowchart LR
  client([API client]) -- "SigV4 (IAM)" --> apigw[API Gateway<br/>REST API]

  subgraph person["Person Service stack"]
    apigw --> create[CreatePerson λ]
    apigw --> get[GetPerson λ]
    apigw --> list[ListPersons λ]
    create -- "TransactWriteItems" --> persons[(persons)]
    create --> phones[(phoneNumbers)]
    get --> persons
    list --> persons
    persons -- "stream (INSERT)" --> pipe[EventBridge Pipe]
    pipe <--> enrich[Enrichment λ]
    pipe --> topic{{SNS person-created}}
    pipe -. failures .-> pipeDlq[[Pipe DLQ]]
    topic -. ARN .-> ssm[/SSM parameter/]
  end

  subgraph welcome["Welcome Service stack"]
    queue[[SQS queue]] --> welcomeFn[Welcome λ]
    welcomeFn --> processed[(processedEvents)]
    queue -. after 5 tries .-> dlq[[DLQ]]
  end

  topic -- "raw delivery" --> queue
  ssm -. looked up at deploy .-> welcome
```

### How a person is created

1. API Gateway checks the caller's IAM signature and throttles the stage (1000 rps, burst 2000).
2. `CreatePerson` validates and trims the body, and normalises the phone number to E.164 (`06 12345678` → `+31612345678`; numbers without a country code are read as Dutch).
3. In one DynamoDB transaction it writes the person to `persons` and claims the phone number in `phoneNumbers`. If the number is already taken, the transaction fails and the API returns `409`, so no race can create a duplicate. If DynamoDB throttles, or a concurrent request wrote the same item, nothing is stored and the API returns `503` with `Retry-After`.
4. The `persons` table stream feeds an EventBridge Pipe. The Pipe keeps only `INSERT`s, turns each one into a `PersonCreated` event (enrichment Lambda) and publishes it to SNS.

The event comes from the table stream, not from the API Lambda (the outbox pattern). An event exists only if the write committed, and a failed publish can't leave a person without an event.

### The microservice landscape

The Person Service doesn't know who consumes its events. It publishes the topic ARN to the SSM parameter `/person-service/<stage>/person-created-topic-arn`. That parameter name and the event schema are its only public contracts. The Welcome Service reads the parameter at deploy time and owns its own subscription, queue, dead-letter queues and alarms. No CloudFormation exports link the two stacks, so each one can be deployed alone. In a real landscape the Welcome Service would live in its own repository and account.

## API

Every method requires IAM authentication (AWS Signature V4). The caller needs `execute-api:Invoke` on the API. A plain `curl` gets `403`; use [awscurl](https://github.com/okigan/awscurl), Postman's "AWS Signature" auth or an AWS SDK.

The full contract is in [`api/openapi.yaml`](api/openapi.yaml) (OpenAPI 3.0). To browse it, open it in [Swagger Editor](https://editor.swagger.io) or run `npx @redocly/cli preview-docs api/openapi.yaml`. The file is generated from [`lib/openapi.ts`](lib/openapi.ts) with `npm run openapi`; don't edit it by hand. A test fails when it is out of date.

### `POST /person`

```bash
awscurl --service execute-api --region eu-west-1 -X POST \
  -H 'Content-Type: application/json' \
  -d '{"firstName":"Ada","lastName":"Lovelace","phoneNumber":"06 12345678","address":"Dam 1, 1012 JS Amsterdam"}' \
  "${API_URL}person"
```

All four fields are required, must be non-empty strings of at most 200 characters, and no other fields are allowed. API Gateway checks this shape before the Lambda runs, with a JSON Schema model defined once in [`lib/api-schemas.ts`](lib/api-schemas.ts); the OpenAPI document uses the same schema. The Lambda then validates everything again, normalises the phone number and checks for duplicates.

| Status            | When                                                          | Body                                                  |
| ----------------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| `201 Created`     | Person stored                                                 | The person; `Location: /person/{id}` header           |
| `400 Bad Request` | Invalid JSON, missing or unknown fields, invalid phone number | `{ "message": "Validation failed", "errors": [...] }` |
| `409 Conflict`    | A person with this phone number already exists                | `{ "message": "..." }`                                |
| `500`             | Unexpected error (logged without personal data)               | `{ "message": "Internal server error" }`              |

```json
{
  "id": "1249302d-9c20-4a1f-8cf5-afdd0173f2a9",
  "firstName": "Ada",
  "lastName": "Lovelace",
  "phoneNumber": "+31612345678",
  "address": "Dam 1, 1012 JS Amsterdam",
  "createdAt": "2026-11-04T14:12:09.077Z"
}
```

### `GET /person/{id}`

Returns `200` with the person, `404` if there is none, or `400` if the id isn't a UUID. The read is strongly consistent, so following the `Location` header right after a `POST` always finds the person.

### `GET /person?limit=20&cursor=...`

Returns one page: `{ "items": [...], "nextCursor": "..." }`. `limit` is 1–100 (default 20). Pass `nextCursor` back as `cursor` for the next page, and stop when it is absent. The order is not defined, and a page may be empty while `nextCursor` is still present.

## The `PersonCreated` event

Published on SNS topic `person-service-<stage>-person-created`:

```json
{
  "eventType": "PersonCreated",
  "version": 1,
  "eventId": "c4ca4238a0b923820dcc509a6f75849b",
  "occurredAt": "2026-11-04T14:12:09.077Z",
  "data": {
    "id": "1249302d-9c20-4a1f-8cf5-afdd0173f2a9",
    "firstName": "Ada",
    "lastName": "Lovelace",
    "phoneNumber": "+31612345678",
    "address": "Dam 1, 1012 JS Amsterdam",
    "createdAt": "2026-11-04T14:12:09.077Z"
  }
}
```

- **Contract:** defined in [`src/events.ts`](src/events.ts). Additive changes keep `version: 1`; breaking changes need a new version. The fields in `data` are picked one by one, so a new table attribute never leaks into the event.
- **Delivery is at least once.** `eventId` is the stream record's id: unique per person and the same on every redelivery, so consumers deduplicate on it. The Welcome Service claims each `eventId` with a conditional write before it acts.
- **Failures:** the Pipe retries 10 times, splits failing batches in half, then sends the record to a dead-letter queue. That message holds the stream position, not the person, so it must be reprocessed within the stream's 24-hour retention. An alarm fires on the first message.

## Deploying

### Prerequisites

- Node.js 24 and npm. The [dev container](.devcontainer/) has the toolchain ready, including the AWS CLI and the CDK CLI.
- AWS credentials for the target account in the environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`).
- Each stage is bound to an account in [`cdk.json`](cdk.json) (`stageAccounts`). CDK refuses to deploy when the credentials belong to another account, so dev keys can never change prod. To deploy into your own accounts, change these ids.

### Commands

```bash
npm ci
npx cdk bootstrap -c stage=dev               # once per account and region
npx cdk deploy --all -c stage=dev            # Person Service, then Welcome Service
npx cdk deploy --all -c stage=prod           # with prod credentials
npx cdk deploy --all -c stage=dev -c alarmEmail=you@example.com   # optional alarm emails
```

The stack outputs `ApiUrl` (ends in `/<stage>/`) and `PersonCreatedTopicArn`.

### From GitHub Actions

- **CI** ([`ci.yml`](.github/workflows/ci.yml)) runs on every pull request and push to `main`: format check, lint, typecheck, tests (including the CDK snapshots and the OpenAPI drift check) and `cdk synth` of both stages. It needs no AWS credentials.
- **Deploy** ([`deploy.yml`](.github/workflows/deploy.yml)) runs only by hand (Actions → Deploy → Run workflow, then pick a stage). It runs CI first, checks that the credentials still work, then runs `cdk deploy --all` with the stage and alarm email. `prod` can only be deployed from `main`, and only when you type `prod` in the confirm field. That stands in for required reviewers, which GitHub doesn't offer for private repositories on the Free plan.

The AWS credentials are short-lived, which is why the deploy isn't triggered by a push. Before each run, paste fresh keys into the GitHub environment of the stage (Settings → Environments):

| Name                    | Kind                | Value                                       |
| ----------------------- | ------------------- | ------------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | Secret              | Temporary access key of the stage's account |
| `AWS_SECRET_ACCESS_KEY` | Secret              | Temporary secret key                        |
| `AWS_SESSION_TOKEN`     | Secret              | Session token                               |
| `ALARM_EMAIL`           | Variable (optional) | Address subscribed to the alarm topics      |

Create one environment per stage, named `dev` and `prod`. If the repository is public (or on a paid plan), also add yourself as a required reviewer on `prod` and limit its deployment branches to `main`. The keys must stay valid for the whole deploy (usually a few minutes): if they expire while CDK waits for CloudFormation, the run fails, although CloudFormation finishes the update.

### Differences between stages

|                                           | dev         | prod         |
| ----------------------------------------- | ----------- | ------------ |
| Account                                   | dev sandbox | prod sandbox |
| Tables, topic, log groups on stack delete | Deleted     | Retained     |
| DynamoDB deletion protection              | Off         | On           |
| Point-in-time recovery                    | On          | On           |

Resource names carry the stage (`person-service-dev`, `PersonService-prod`, ...), and every resource is tagged with `Service` and `Stage`.

## Operations

- **Scaling:** Lambda, API Gateway, on-demand DynamoDB, Pipes, SNS and SQS all scale with traffic and cost close to nothing when idle. There are no servers to manage.
- **Bursts:** sized for bursts of 1000 new persons per second:
  - API Gateway throttles the stage at 1000 rps, bursts up to 2000.
  - `CreatePerson` has 1024 MB (more CPU, so fewer instances are needed), and in prod 500 reserved concurrency, which is also its maximum.
  - On-demand tables take 4,000 writes/s from the start. A create costs 2 write units per table (transactions cost double), so a burst of 2000 creates/s still fits.
  - The Pipe reads batches of 100 records, 10 batches per stream shard in parallel.
  - The Welcome consumer runs at most 50 Lambdas; the queue absorbs the rest of a burst.

  Before relying on this, check the Lambda concurrency quota of each account (`aws lambda get-account-settings`): prod needs at least 600 for the reservation (AWS keeps 100 unreserved), and new accounts often start much lower. Then load-test dev with SigV4-signed requests.

- **Alarms:** each service has its own alarm topic. Alarms fire on Lambda errors and throttles, API 5XX responses, API traffic above 80% of the rate limit, DynamoDB write throttling, Pipe throttling, any message in a dead-letter queue, and a Welcome queue backlog older than 5 minutes.
- **Logs:** structured JSON, kept for one month. Handlers log ids and error names only, never names, phone numbers or addresses. The Pipe logs errors only, without the record contents.
- **Security:** IAM auth on every method, least-privilege grants (for example, `CreatePerson` may only `PutItem`), TLS enforced on topics and queues, SQS encrypted at rest.

## Development

```bash
npm test             # Vitest: handlers (AWS SDK mocked), event mapping, CDK assertions and snapshots
npm run test:update  # update CDK snapshots after an intended infrastructure change
npm run openapi      # regenerate api/openapi.yaml after changing lib/openapi.ts or lib/api-schemas.ts
npm run typecheck
npm run lint
npm run format:check
npx cdk synth -c stage=dev
```

```
bin/        CDK app: one Person Service and one Welcome Service stack per stage
api/        Generated OpenAPI document
lib/        CDK constructs (storage, API, events, alarms), OpenAPI source
lib/stacks/ The Person Service and Welcome Service stacks that compose the constructs
scripts/    Code generation (api/openapi.yaml)
src/        Lambda handlers and the domain code they share (validation, event mapping)
test/       Unit tests and CDK template tests
```

## Design decisions

| Decision                                      | Why                                                                                                                            | Trade-off                                                                            |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| AWS CDK in TypeScript                         | Same language as the Lambdas, typed, `grant*` helpers for least privilege                                                      | Synthesised CloudFormation is less direct to read than SAM's YAML                    |
| REST API with IAM auth                        | Uses existing AWS identities; leaves room for WAF, request validation and usage plans                                          | Costs more per request than an HTTP API                                              |
| DynamoDB, two tables                          | A transaction over `persons` and `phoneNumbers` rejects duplicate phone numbers atomically; only person items reach the stream | Two tables instead of one single-table design                                        |
| Phone number as the duplicate key             | A clear, normalisable identity for a person                                                                                    | People who share a phone number can't both register                                  |
| Address as a single string                    | Keeps the API simple and works for any country                                                                                 | No validation of postcode or country; structured fields are an easy, additive change |
| Stream → Pipe → SNS (outbox pattern)          | No dual write; Pipes provides retries, filtering and a DLQ without code                                                        | Pipes is newer and harder to debug than a small Lambda                               |
| SNS fan-out, consumers own their SQS queues   | New consumers subscribe without changes to the Person Service                                                                  | No replay or schema registry, unlike an EventBridge bus                              |
| Topic ARN in SSM, not a CloudFormation export | Stacks deploy independently; an export would block changes to the topic                                                        | No deploy-time check that the consumer's subscription still exists                   |
| arm64 Lambdas on Node.js 24                   | About 20% cheaper; the current LTS runtime                                                                                     | Native dependencies would need arm64 builds (none are used)                          |
| ESM throughout, including the Lambda bundles  | One module format from source to runtime; allows top-level `await` and `import.meta` in handlers                               | A `require()` shim in each bundle for CommonJS dependencies                          |

## Known limitations and next steps

- **Personal data in the event.** The topic is not encrypted yet, and every subscriber receives the name, phone number and address. Next: a customer-managed KMS key for the topic, and an event that carries only the id plus what consumers really need.
- **Short-lived keys pasted into GitHub.** CI runs on every push, but deploys need fresh keys in the environment's secrets each time. Next: an OIDC role per account, so GitHub gets its own short-lived credentials and deploys can run on every merge to `main` (prod after approval).
- **Two validation layers.** API Gateway checks the body's shape and the Lambda checks it again by hand. Next: Zod in the handler, generated from or checked against the same schema. Query and path parameters are checked only in the Lambdas: API Gateway can only check that they exist.
- **Observability.** No tracing or correlation id from the API request to the consumer yet. Next: Powertools for AWS Lambda (Logger, Tracer, Metrics) and X-Ray.
- **Welcome Service crash window.** If the Lambda crashes or times out between claiming an `eventId` and finishing the welcome, retries skip that event. A claim with a "pending" state and an expiry would fix this.
- **No event filtering.** The Pipe sets no SNS message attributes, so subscribers can't use filter policies yet.
