/**
 * Queue abstraction for RabbitMQ.
 * Handles queue operations with simplified JS/TS-friendly API.
 */
import amqp from 'amqplib';
import { createLogger } from './logger';
import { QueueSpec, PublishOptions, ConsumerCallback, ConsumerEvent, MessageMetadata, RawMessage, RawChannel } from './types';
import { MAX_DRAIN_PAUSE_MS } from '.';

/**
 * Represents a RabbitMQ queue with a simplified API.
 */
type ConsumeOptions = { noLocal?: boolean; exclusive?: boolean; prefetch?: number };

export class Queue {
  private channel: RawChannel;
  private name: string;
  private spec: QueueSpec;
  private consumerTags: Map<string, () => Promise<void>> = new Map();
  private registrations: Array<{ callback: ConsumerCallback; options: ConsumeOptions }> = [];
  private drainPromise: Promise<void> | null = null;
  private logger = createLogger();

  constructor(channel: RawChannel, name: string, spec: QueueSpec = {}) {
    this.channel = channel;
    this.name = name;
    this.spec = spec;
  }

  /**
   * Replaces the underlying channel (used after reconnection).
   * Clears stale consumer tags — call recoverConsumers() afterwards.
   */
  setChannel(channel: RawChannel): void {
    this.channel = channel;
    this.consumerTags.clear();
  }

  /**
   * Re-registers all consumers on the current channel.
   * Called after a channel replacement to restore consumer state.
   */
  async recoverConsumers(): Promise<void> {
    for (const { callback, options } of this.registrations) {
      await this.startConsuming(callback, options);
    }
  }

  /**
   * Gets the queue name.
   */
  getName(): string {
    return this.name;
  }

  /**
   * Gets the queue specification.
   */
  getSpec(): QueueSpec {
    return this.spec;
  }

  /**
   * Checks if the queue is configured as durable.
   *
   * @returns true if queue is durable, false otherwise
   */
  isDurable(): boolean {
    return this.spec.durable !== false;
  }

  /**
   * Checks if the queue is configured to auto-delete.
   *
   * @returns true if queue auto-deletes, false otherwise
   */
  autoDeletes(): boolean {
    return this.spec.autoDelete === true;
  }

  /**
   * Checks if the queue is exclusive to this connection.
   *
   * @returns true if queue is exclusive, false otherwise
   */
  isExclusive(): boolean {
    return this.spec.exclusive === true;
  }

  /**
   * Gets the routing keys this queue is bound to.
   * Note: This only tracks routing keys from the initial spec;
   * additional bindings made via bindToExchange() are not tracked.
   *
   * @returns Array of routing keys, or empty array if none specified
   */
  getBindingRoutingKeys(): string[] {
    const { routingKey } = this.spec;
    if (! routingKey) return [];
    return Array.isArray(routingKey) ? routingKey : [routingKey];
  }

  /**
   * Checks if queue has a message TTL configured.
   *
   * @returns Message TTL in milliseconds, or undefined if not set
   */
  getMessageTtl(): number | undefined {
    return this.spec.messageTtl;
  }

  /**
   * Checks if queue has an expiration configured.
   *
   * @returns Queue expiration in milliseconds, or undefined if not set
   */
  getExpiration(): number | undefined {
    return this.spec.expires;
  }

  /**
   * Gets the dead-letter exchange if configured.
   *
   * @returns Dead-letter exchange name, or undefined if not configured
   */
  getDeadLetterExchange(): string | undefined {
    return this.spec.deadLetterExchange;
  }

  /**
   * Asserts the queue exists with the configured specification.
   * Creates it if it doesn't exist.
   *
   * @returns Promise resolving when queue is asserted
   */
  async assert(): Promise<void> {
    const {
      durable = true,
      autoDelete = false,
      exclusive = false,
      maxPriority,
      messageTtl,
      expires,
      deadLetterExchange,
      deadLetterRoutingKey,
      arguments: args = {},
    } = this.spec;

    const queueArgs: Record<string, any> = { ...args };

    if (maxPriority !== undefined) {
      queueArgs['x-max-priority'] = maxPriority;
    }
    if (messageTtl !== undefined) {
      queueArgs['x-message-ttl'] = messageTtl;
    }
    if (expires !== undefined) {
      queueArgs['x-expires'] = expires;
    }
    if (deadLetterExchange !== undefined) {
      queueArgs['x-dead-letter-exchange'] = deadLetterExchange;
    }
    if (deadLetterRoutingKey !== undefined) {
      queueArgs['x-dead-letter-routing-key'] = deadLetterRoutingKey;
    }

    await this.channel.assertQueue(this.name, {
      durable,
      autoDelete,
      exclusive,
      arguments: queueArgs,
    });
  }

  /**
   * Binds the queue to an exchange with a routing key.
   *
   * @param exchange - Exchange name
   * @param routingKey - Routing key to bind to
   * @returns Promise resolving when queue is bound
   */
  async bindToExchange(exchange: string, routingKey: string): Promise<void> {
    await this.channel.bindQueue(this.name, exchange, routingKey);
  }

  /**
   * Unbinds the queue from an exchange.
   *
   * @param exchange - Exchange name
   * @param routingKey - Routing key to unbind from
   * @returns Promise resolving when queue is unbound
   */
  async unbindFromExchange(exchange: string, routingKey: string): Promise<void> {
    await this.channel.unbindQueue(this.name, exchange, routingKey);
  }

  /**
   * Publishes a message to this queue.
   * If message is a Buffer, sends it as-is.
   * Otherwise, automatically serializes to JSON.
   *
   * @param message - Buffer (for binary) or any serializable JavaScript value
   * @param options - Publishing options
   */
  async publish(message: any, options: PublishOptions = {}): Promise<void> {
    const { persistent = true, contentType = 'application/json', ...otherOptions } = options;

    // If message is already a Buffer, use it directly (don't JSON.stringify)
    const buffer = Buffer.isBuffer(message)
      ? message
      : Buffer.from(JSON.stringify(message), 'utf-8');

    const published = this.channel.sendToQueue(this.name, buffer, {
      persistent,
      contentType,
      contentEncoding: 'utf-8',
      ...otherOptions,
    });

    if (! published) await this.waitForDrain();
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
      const timeout = setTimeout(() => {
        this.channel.removeListener('drain', onDrain);
        this.drainPromise = null;
        this.logger.warn('Queue drain timeout — resolving to prevent deadlock', { queue: this.name });
        resolve();
      }, MAX_DRAIN_PAUSE_MS);
      timeout.unref();

      const onDrain = () => {
        clearTimeout(timeout);
        this.drainPromise = null;
        resolve();
      };

      this.channel.once('drain', onDrain);
    });
  }

  /**
   * Consumes messages from the queue.
   * Callback receives message and event object with metadata, ack, nack, and original message.
   * Registration is tracked internally so the consumer is automatically restored after
   * a channel drop — no special handling needed at the call site.
   *
   * @param callback - Function to call for each message
   * @param options - Consumer options (prefetch)
   * @returns Function to cancel the consumer
   */
  async consume(
    callback: ConsumerCallback,
    options: ConsumeOptions = {}
  ): Promise<() => Promise<void>> {
    this.registrations.push({ callback, options });
    return this.startConsuming(callback, options);
  }

  private async startConsuming(
    callback: ConsumerCallback,
    options: ConsumeOptions = {}
  ): Promise<() => Promise<void>> {
    const { noLocal = false, exclusive = false, prefetch = 0 } = options;

    if (prefetch > 0) {
      await this.channel.prefetch(prefetch);
    }

    const { consumerTag } = await this.channel.consume(
      this.name,
      (msg) => {
        if (! msg) {
          return;
        }

        const metadata = this.parseMessageMetadata(msg);
        const ack = () => this.channel.ack(msg);
        const nack = (requeue = true) => this.channel.nack(msg, false, requeue);

        const event: ConsumerEvent = {
          metadata,
          ack,
          nack,
          original: msg,
        };

        Promise.resolve()
          .then(() => callback(this.parseMessageContent(msg.content), event))
          .catch(() => {
            // If callback throws, nack with requeue
            nack(true);
          });
      },
      { noAck: false, noLocal, exclusive }
    );

    const cancelFn = async () => {
      try {
        await this.channel.cancel(consumerTag);
      } catch {
        // May already be cancelled
      }
    };

    this.consumerTags.set(consumerTag, cancelFn);

    return cancelFn;
  }

  /**
   * Acknowledges a message.
   *
   * @param message - Raw amqplib message
   */
  ack(message: RawMessage): void {
    this.channel.ack(message);
  }

  /**
   * Negative acknowledges a message,
   * optionally requeuing it for reprocessing.
   *
   * @param message - Raw amqplib message
   * @param requeue - Whether to requeue the message. Default: true.
   */
  nack(message: RawMessage, requeue = true): void {
    this.channel.nack(message, false, requeue);
  }

  /**
   * Rejects a message,
   * optionally requeuing it.
   *
   * @param message - Raw amqplib message
   * @param requeue - Whether to requeue the message. Default: true.
   */
  reject(message: RawMessage, requeue = true): void {
    this.channel.reject(message, requeue);
  }

  /**
   * Purges the queue of all messages.
   * WARNING: This deletes all messages in the queue.
   *
   * @returns Promise resolving with the number of messages purged
   */
  async purge(): Promise<number> {
    const ok = await this.channel.purgeQueue(this.name);
    return ok.messageCount;
  }

  /**
   * Gets the current queue length/message count.
   *
   * @returns Promise resolving with the current message count
   */
  async getMessageCount(): Promise<number> {
    const ok = await this.channel.checkQueue(this.name);
    return ok.messageCount;
  }

  /**
   * Gets the current consumer count for this queue.
   *
   * @returns Promise resolving with the current consumer count
   */
  async getConsumerCount(): Promise<number> {
    const ok = await this.channel.checkQueue(this.name);
    return ok.consumerCount;
  }

  /**
   * Deletes the queue.
   * WARNING: This is permanent.
   *
   * @param options - Deletion options
   * @returns Promise resolving when queue is deleted
   */
  async delete(options: { ifUnused?: boolean; ifEmpty?: boolean } = {}): Promise<void> {
    await this.channel.deleteQueue(this.name, options);
  }

  /**
   * Gets underlying amqplib channel for advanced operations.
   */
  getChannel(): RawChannel {
    return this.channel;
  }

  /**
   * Parses amqplib message content from buffer to JS value.
   */
  private parseMessageContent(content: Buffer): unknown {
    const text = content.toString('utf-8');

    try {
      return JSON.parse(text, this.bufferReviver);
    } catch (error) {
      this.logger.warn('Failed to parse message content as JSON, returning raw text', {
        error: (error as Error).message,
        content: text
      });

      return text;
    }
  }

  /**
   * Reviver function for JSON.parse to recover Buffer objects.
   */
  private bufferReviver(_: string, value: unknown): unknown {
    const isObject = value && typeof value === 'object';
    const isBuffer = isObject && (value as any).type === 'Buffer' && Array.isArray((value as any).data);

    return isBuffer ? Buffer.from((value as any).data) : value;
  }

  /**
   * Creates metadata from amqplib message.
   */
  private parseMessageMetadata(msg: amqp.ConsumeMessage): MessageMetadata {
    return {
      raw: msg,
      deliveryTag: msg.fields.deliveryTag,
      redelivered: msg.fields.redelivered,
      exchange: msg.fields.exchange,
      routingKey: msg.fields.routingKey,
      headers: msg.properties.headers,
      properties: msg.properties,
    };
  }

  /**
   * Cancels all active consumers on this queue.
   */
  async cancelAllConsumers(): Promise<void> {
    const promises = Array.from(this.consumerTags.values()).map((cancel) => cancel());
    await Promise.all(promises);
    this.consumerTags.clear();
  }
}
