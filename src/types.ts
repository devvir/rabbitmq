/**
 * Type definitions for RabbitMQ utilities.
 * Provides a clean, TypeScript-first abstraction over amqplib.
 */

import amqp from 'amqplib';

/**
 * Supported RabbitMQ exchange types.
 */
export type ExchangeType = 'direct' | 'topic' | 'fanout' | 'headers';

/**
 * Options for connecting to RabbitMQ with retry logic.
 */
export interface ConnectionOptions {
  /** Number of connection retries. Default: 5. Use -1 for unlimited retries. */
  retries?: number;
  /** Delay between retry attempts in milliseconds. Default: 500ms. */
  retryDelay?: number;
  /**
   * When true, disables all internal auto-recovery (channel recovery and reconnect scheduling).
   * Use this when an external system (e.g. service-kit) manages the connection lifecycle.
   */
  managed?: boolean;
}

/**
 * Queue configuration for assertion.
 */
export interface QueueSpec {
  /** Queue name. If empty string or omitted, RabbitMQ generates an exclusive queue. */
  name?: string;
  /** Routing key(s) to bind this queue to the exchange. */
  routingKey?: string | string[];
  /** Whether queue should survive broker restart. Default: true. */
  durable?: boolean;
  /** Whether queue should be deleted when no longer in use. Default: false. */
  autoDelete?: boolean;
  /** Whether queue is exclusive to this connection. Default: false. */
  exclusive?: boolean;
  /** Maximum message priority. Default: undefined (no priorities). */
  maxPriority?: number;
  /** Time in milliseconds before queue is deleted. Default: undefined. */
  messageTtl?: number;
  /** Queue expiration time in milliseconds. Default: undefined. */
  expires?: number;
  /** Dead-letter exchange. Default: undefined. */
  deadLetterExchange?: string;
  /** Dead-letter routing key. Default: undefined. */
  deadLetterRoutingKey?: string;
  /** Additional queue arguments. */
  arguments?: Record<string, any>;
}

/**
 * Exchange configuration for assertion.
 */
export interface ExchangeSpec {
  /** Exchange name. */
  name?: string;
  /** Type of exchange. Default: 'direct'. */
  type?: ExchangeType;
  /** Whether exchange should survive broker restart. Default: true. */
  durable?: boolean;
  /** Whether exchange should be deleted when no longer in use. Default: false. */
  autoDelete?: boolean;
  /** Alternate exchange for unrouteable messages. Default: undefined. */
  alternateExchange?: string;
  /** Additional exchange arguments. */
  arguments?: Record<string, any>;
}

/**
 * An exchange-to-exchange binding.
 */
export interface ExchangeBinding {
  /** Source exchange — messages flow out of this exchange. */
  source: string;
  /** Destination exchange — messages are forwarded into this exchange. */
  destination: string;
  /** Binding key (used for topic/direct sources; ignored by fanout). Default: '' */
  routingKey?: string;
}

/**
 * Full topology specification for exchanges and queues.
 */
export interface TopologySpec {
  /** Exchange configuration and its queues. */
  exchanges?: {
    [exchangeName: string]: ExchangeSpec & {
      queues?: {
        [queueName: string]: QueueSpec;
      };
    };
  };
  /** Standalone queue configuration. */
  queues?: {
    [queueName: string]: QueueSpec;
  };
  /** Exchange-to-exchange bindings declared after exchanges are asserted. */
  exchangeBindings?: ExchangeBinding[];
}

/**
 * Options for publishing messages.
 */
export interface PublishOptions {
  /** Routing key for topic/headers exchanges. */
  key?: string;
  /** Headers for headers exchange or additional headers. */
  headers?: Record<string, any>;
  /** Message priority (requires queue maxPriority to be set). */
  priority?: number;
  /** Time to live for this message in milliseconds. */
  expiration?: number | string;
  /** Whether message should be persisted. Default: true. */
  persistent?: boolean;
  /** Message type/content-type hint. */
  contentType?: string;
  /** Message encoding. Default: 'utf-8'. */
  contentEncoding?: string;
  /** Timestamp for the message. */
  timestamp?: number;
  /** Application-specific message ID. */
  messageId?: string;
  /** Correlation ID for request/reply patterns. */
  correlationId?: string;
  /** Reply-to queue name for RPC patterns. */
  replyTo?: string;
  /** User ID. */
  userId?: string;
  /** Application ID. */
  appId?: string;
}

/**
 * Consumer event object passed to callback.
 */
export interface ConsumerEvent {
  /** Parsed message content. */
  metadata: MessageMetadata;
  /** Function to acknowledge the message. */
  ack: () => void;
  /** Function to negative acknowledge the message. */
  nack: (requeue?: boolean) => void;
  /** Original amqplib message object. */
  original: RawMessage;
}

/**
 * Consumer callback function.
 * Message content is automatically parsed from JSON.
 */
export type ConsumerCallback = (message: unknown, event: ConsumerEvent) => Promise<void> | void;

/**
 * Metadata associated with a consumed message.
 */
export interface MessageMetadata {
  /** Original amqplib message object for advanced use cases. */
  raw: amqp.ConsumeMessage;
  /** Delivery tag for acknowledgment. */
  deliveryTag: number;
  /** Whether message was redelivered. */
  redelivered: boolean;
  /** Exchange the message came from. */
  exchange: string;
  /** Routing key used. */
  routingKey: string;
  /** Message headers. */
  headers?: Record<string, any>;
  /** Message properties from amqplib. */
  properties: amqp.MessageProperties;
}

/**
 * Broker connection state.
 */
export type BrokerState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

/**
 * Configuration for shorthand connection methods.
 */
export interface ConnectConfig {
  /** Exchange configuration (shorthand). */
  exchange?: string | ExchangeSpec;
  /** Queue configuration (shorthand). */
  queue?: string | QueueSpec;
  /** Exchange type for shorthand mode. */
  type?: ExchangeType;
  /** Routing key for shorthand mode. */
  key?: string;
  /** Headers for shorthand mode. */
  headers?: Record<string, any>;
}

/**
 * Configuration for publishing on an exchange.
 */
export interface PublishConfig {
  /** Exchange name. */
  exchange: string;
  /** Exchange type. Default: 'direct'. */
  type?: ExchangeType;
  /** Default routing key. */
  key?: string;
  /** Default headers. */
  headers?: Record<string, any>;
}

/**
 * Options for republishing an existing message.
 * All properties default to the original message's values.
 * Only specify fields you want to override.
 */
export interface RepublishOptions {
  /** Override the routing key. */
  routingKey?: string;
  /** Override or merge headers. */
  headers?: Record<string, any>;
  /** Override persistence. */
  persistent?: boolean;
  /** Override content type. */
  contentType?: string;
  /** Override content encoding. */
  contentEncoding?: string;
  /** Override expiration. */
  expiration?: number | string;
  /** Override priority. */
  priority?: number;
  /** Override message ID. */
  messageId?: string;
  /** Override correlation ID. */
  correlationId?: string;
  /** Override reply-to. */
  replyTo?: string;
  /** Override timestamp. */
  timestamp?: number;
  /** Override user ID. */
  userId?: string;
  /** Override app ID. */
  appId?: string;
}

/**
 * Raw message from amqplib (for reference).
 */
export type RawMessage = amqp.ConsumeMessage;

/**
 * Raw connection from amqplib (for reference).
 */
export type RawConnection = Awaited<ReturnType<typeof amqp.connect>>;

/**
 * Raw channel from amqplib (for reference).
 */
export type RawChannel = amqp.Channel;
