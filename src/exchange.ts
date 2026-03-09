/**
 * Exchange abstraction for RabbitMQ.
 * Handles exchange operations with a simplified API.
 */

import amqp from 'amqplib';
import { ExchangeSpec, PublishOptions, RawChannel, RawMessage, RepublishOptions } from './types';
import { Queue } from './queue';
import { createLogger } from './logger';
import { MAX_DRAIN_PAUSE_MS } from '.';

/**
 * Represents a RabbitMQ exchange with a simplified API.
 */
export class Exchange {
  private channel: RawChannel;
  private name: string;
  private spec: ExchangeSpec;
  private queues: Map<string, Queue> = new Map();
  private drainPromise: Promise<void> | null = null;
  private backpressureHandler: ((paused: boolean) => void) | null = null;
  private logger = createLogger();

  constructor(channel: RawChannel, name: string, spec: ExchangeSpec = {}) {
    this.channel = channel;
    this.name = name;
    this.spec = spec;
  }

  /**
   * Registers a handler to be notified when publish backpressure starts or ends.
   * Called with true when the channel write buffer fills (drain pending),
   * and false when it drains. Use this to pause/resume the upstream data source.
   */
  setBackpressureHandler(handler: (paused: boolean) => void): void {
    this.backpressureHandler = handler;
  }

  /**
   * Replaces the underlying channel (used after reconnection).
   */
  setChannel(channel: RawChannel): void {
    this.channel = channel;
  }

  /**
   * Gets the exchange name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Gets the exchange specification.
   */
  getSpec(): ExchangeSpec {
    return this.spec;
  }

  /**
   * Checks if the exchange is configured as durable.
   *
   * @returns true if exchange is durable, false otherwise
   */
  isDurable(): boolean {
    return this.spec.durable !== false;
  }

  /**
   * Checks if the exchange is configured to auto-delete.
   *
   * @returns true if exchange auto-deletes, false otherwise
   */
  autoDeletes(): boolean {
    return this.spec.autoDelete === true;
  }

  /**
   * Gets the exchange type.
   *
   * @returns Exchange type: 'direct', 'topic', 'fanout', or 'headers'
   */
  getType(): string {
    return this.spec.type || 'direct';
  }

  /**
   * Checks if this is a topic exchange.
   *
   * @returns true if exchange type is 'topic'
   */
  isTopicExchange(): boolean {
    return this.getType() === 'topic';
  }

  /**
   * Checks if this is a direct exchange.
   *
   * @returns true if exchange type is 'direct'
   */
  isDirectExchange(): boolean {
    return this.getType() === 'direct';
  }

  /**
   * Checks if this is a fanout exchange.
   *
   * @returns true if exchange type is 'fanout'
   */
  isFanoutExchange(): boolean {
    return this.getType() === 'fanout';
  }

  /**
   * Checks if this is a headers exchange.
   *
   * @returns true if exchange type is 'headers'
   */
  isHeadersExchange(): boolean {
    return this.getType() === 'headers';
  }

  /**
   * Gets the alternate exchange if configured.
   *
   * @returns Alternate exchange name, or undefined if not configured
   */
  getAlternateExchange(): string | undefined {
    return this.spec.alternateExchange;
  }

  /**
   * Asserts the exchange exists with the configured specification.
   * Creates it if it doesn't exist.
   *
   * @returns Promise resolving when exchange is asserted
   */
  async assert(): Promise<void> {
    const {
      type = 'direct',
      durable = true,
      autoDelete = false,
      alternateExchange,
      arguments: args = {},
    } = this.spec;

    const exchangeArgs: Record<string, any> = { ...args };

    if (alternateExchange !== undefined) {
      exchangeArgs['alternate-exchange'] = alternateExchange;
    }

    await this.channel.assertExchange(this.name, type, {
      durable,
      autoDelete,
      arguments: exchangeArgs,
    });
  }

  /**
   * Publishes a message to the exchange.
   * If message is a Buffer, sends it as-is; otherwise auto-serializes to JSON.
   * Automatically handles RabbitMQ backpressure by waiting for drain if needed.
   *
   * @param message - Buffer (for binary) or any serializable JavaScript value
   * @param routingKey - Routing key for the message
   * @param options - Publishing options
   */
  async publish(message: any, routingKey: string, options: PublishOptions = {}): Promise<void> {
    const { persistent = true, contentType = 'application/json', ...otherOptions } = options;

    // If message is already a Buffer, use it directly (don't JSON.stringify)
    const buffer = Buffer.isBuffer(message)
      ? message
      : Buffer.from(JSON.stringify(message), 'utf-8');

    const published = this.channel.publish(this.name, routingKey, buffer, {
      persistent,
      contentType,
      contentEncoding: 'utf-8',
      ...otherOptions,
    });

    if (! published) await this.waitForDrain();
  }

  /**
   * Republishes an existing message to this exchange, preserving all original
   * properties (headers, content type, encoding, persistence, etc.).
   * Only the routing key and explicitly overridden properties change.
   * Automatically handles RabbitMQ backpressure by waiting for drain if needed.
   *
   * @param original - The raw consumed message (from consumer callback)
   * @param overrides - Optional property overrides (routingKey, headers, etc.)
   */
  async republish(original: RawMessage, overrides: RepublishOptions = {}): Promise<void> {
    const { routingKey = original.fields.routingKey, ...optionsOverrides } = overrides;

    return this.publish(original.content, routingKey, {
      ...original.properties,
      ...optionsOverrides,
    });
  }

  /**
   * Waits for the channel to drain with a safety timeout.
   * Shares a single listener across all concurrent callers to avoid
   * EventEmitter listener leaks. If drain doesn't fire within 5 s,
   * resolves anyway to prevent a deadlock where all prefetch slots
   * are blocked waiting indefinitely.
   */
  private waitForDrain(): Promise<void> {
    return this.drainPromise ??= new Promise<void>(resolve => {
      this.backpressureHandler?.(true);

      const done = (timedOut: boolean) => {
        this.drainPromise = null;
        this.backpressureHandler?.(false);
        if (timedOut) this.logger.warn('Exchange drain timeout — resolving to prevent deadlock', { exchange: this.name });
        resolve();
      };

      const timeout = setTimeout(() => {
        this.channel.removeListener('drain', onDrain);
        done(true);
      }, MAX_DRAIN_PAUSE_MS);
      timeout.unref();

      const onDrain = () => { clearTimeout(timeout); done(false); };

      this.channel.once('drain', onDrain);
    });
  }

  /**
   * Creates or gets a queue associated with this exchange.
   *
   * @param queueName - Name of the queue
   * @param routingKey - Routing key(s) to bind to
   * @param spec - Queue specification
   * @returns Queue instance
   */
  async createQueue(queueName: string, routingKey: string | string[], spec = {}): Promise<Queue> {
    const queue = new Queue(this.channel, queueName, spec);
    await queue.assert();

    // Bind to exchange with routing key(s)
    const keys = Array.isArray(routingKey) ? routingKey : [routingKey];
    for (const key of keys) {
      await queue.bindToExchange(this.name, key);
    }

    this.queues.set(queueName, queue);
    return queue;
  }

  /**
   * Gets a queue by name, or the only queue if name is not provided.
   *
   * @param queueName - Name of the queue (optional, required if multiple queues exist)
   * @returns Queue instance or undefined
   * @throws if queueName is not provided but multiple queues exist
   */
  getQueue(queueName?: string): Queue | undefined {
    if (queueName === undefined) {
      if (this.queues.size === 0) return undefined;
      if (this.queues.size === 1) return Array.from(this.queues.values())[0];
      throw new Error(`Multiple queues exist in exchange, specify name: ${Array.from(this.queues.keys()).join(', ')}`);
    }
    return this.queues.get(queueName);
  }

  /**
   * Gets all associated queues.
   *
   * @returns Map of queue names to Queue instances
   */
  getQueues(): Map<string, Queue> {
    return new Map(this.queues);
  }

  /**
   * Removes a queue from tracking (doesn't delete it from broker).
   *
   * @param queueName - Name of the queue
   */
  removeQueue(queueName: string): void {
    this.queues.delete(queueName);
  }

  /**
   * Deletes the exchange.
   * WARNING: This is permanent.
   *
   * @param options - Deletion options
   * @returns Promise resolving when exchange is deleted
   */
  async delete(options: { ifUnused?: boolean } = {}): Promise<void> {
    await this.channel.deleteExchange(this.name, options);
  }

  /**
   * Gets underlying amqplib channel for advanced operations.
   */
  getChannel(): amqp.Channel {
    return this.channel;
  }

  /**
   * Returns all queues for cleanup.
   */
  getAllQueues(): Queue[] {
    return Array.from(this.queues.values());
  }
}
