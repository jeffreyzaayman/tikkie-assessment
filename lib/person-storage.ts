import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, Billing, StreamViewType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import type { Stage } from './stage';

export interface PersonStorageProps {
  readonly stage: Stage;
}

/**
 * DynamoDB tables for the person service.
 *
 * - `persons`: one item per person, keyed by `id`. Its stream feeds the person-created event.
 * - `phoneNumbers`: one item per E.164 phone number, written in the same transaction as the
 *   person with `attribute_not_exists`, so duplicates are rejected atomically.
 */
export class PersonStorage extends Construct {
  public readonly persons: TableV2;
  public readonly phoneNumbers: TableV2;

  constructor(scope: Construct, id: string, props: PersonStorageProps) {
    super(scope, id);

    const isProd = props.stage === 'prod';
    const common = {
      billing: Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: isProd,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    };

    this.persons = new TableV2(this, 'Persons', {
      ...common,
      partitionKey: { name: 'id', type: AttributeType.STRING },
      dynamoStream: StreamViewType.NEW_IMAGE,
    });

    this.phoneNumbers = new TableV2(this, 'PhoneNumbers', {
      ...common,
      partitionKey: { name: 'phoneNumber', type: AttributeType.STRING },
    });
  }
}
