/**
 * RabbitMQ utilities for TradeBot services.
 *
 * Provides a high-level, TypeScript-first API for managing RabbitMQ connections,
 * exchanges, queues, and messaging.
 *
 * @example
 * ```typescript
 * import { connect, keepAlive } from '@devvir/rabbitmq';
 *
 * // Create a broker with automatic reconnection
 * const broker = keepAlive('amqp://guest:guest@localhost:5672');
 *
 * // Declare topology
 * await broker.declares({
 *   exchanges: {
 *     myExchange: {
 *       type: 'topic',
 *       queues: {
 *         myQueue: { routingKey: 'events.*' },
 *       },
 *     },
 *   },
 * });
 *
 * // Consume messages (with queue name)
 * const cancel = await broker.consume('myQueue', (msg, event) => {
 *   console.log(msg);
 *   event.ack();
 * });
 *
 * // Or consume from single queue without naming it
 * const cancel = await broker.consume((msg, { ack, metadata }) => {
 *   console.log(msg);
 *   ack();
 * });
 *
 * // Publish messages
 * const exchange = broker.getExchange('myExchange')!;
 * exchange.publish({ event: 'test' }, 'events.fired');
 * ```
 */

// Core exports
export { Broker, connect, keepAlive, connectOrFail } from './broker';
export { Exchange } from './exchange';
export { Queue } from './queue';

// Connection utilities
export {
  connectWithRetries,
  connectOnce,
  connectWithReconnect,
  createChannel,
  closeConnection,
  closeChannel,
} from './connection';

// Types
export type {
  ConnectionOptions,
  ExchangeType,
  ExchangeSpec,
  QueueSpec,
  TopologySpec,
  PublishOptions,
  PublishConfig,
  ConsumerCallback,
  ConsumerEvent,
  MessageMetadata,
  BrokerState,
  ConnectConfig,
  RawMessage,
  RawConnection,
  RawChannel,
} from './types';
