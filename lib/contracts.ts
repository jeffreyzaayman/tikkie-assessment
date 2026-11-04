import type { Stage } from './stage';

/**
 * Where the Person Service publishes its person-created topic ARN. This SSM parameter name is
 * the only thing consumers need to know (no CloudFormation exports), so treat it as a public
 * contract: renaming it breaks every subscriber.
 */
export function personCreatedTopicArnParameterName(stage: Stage): string {
  return `/person-service/${stage}/person-created-topic-arn`;
}
