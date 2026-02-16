/**
 * Queue abstraction for RabbitMQ.
 * Handles queue operations with simplified JS/TS-friendly API.
 */

import amqp from 'amqplib';
import { QueueSpec, PublishOptions, ConsumerCallback, ConsumerEvent, MessageMetadata, RawMessage, RawChannel } from './types';

/**
 * Represents a RabbitMQ queue with a simplified API.
 */
export class Queue {
  private channel: RawChannel;
  private name: string;
  private spec: QueueSpec;
  private consumerTags: Map<string, () => void> = new Map();

  constructor(channel: RawChannel, name: string, spec: QueueSpec = {}) {
    this.channel = channel;
    this.name = name;
    this.spec = spec;
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
   * Message is automatically serialized to JSON.
   *
   * @param message - Any serializable JavaScript value
   * @param options - Publishing options
   * @returns true if message was sent (channel buffer not full), false otherwise
   */
  publish(message: any, options: PublishOptions = {}): boolean {
    const { persistent = true, contentType = 'application/json', ...otherOptions } = options;

    const buffer = Buffer.from(JSON.stringify(message), 'utf-8');

    return this.channel.sendToQueue(this.name, buffer, {
      persistent,
      contentType,
      contentEncoding: 'utf-8',
      ...otherOptions,
    });
  }

  /**
   * Consumes messages from the queue.
   * Callback receives message and event object with metadata, ack, nack, and original message.
   *
   * @param callback - Function to call for each message
   * @param options - Consumer options (prefetch)
   * @returns Function to cancel the consumer
   */
  async consume(
    callback: ConsumerCallback,
    options: { noLocal?: boolean; exclusive?: boolean; prefetch?: number } = {}
  ): Promise<() => Promise<void>> {
    const { noLocal = false, exclusive = false, prefetch = 1 } = options;

    // Set prefetch to limit messages in flight
    if (prefetch > 0) {
      await this.channel.prefetch(prefetch);
    }

    const consumerTag = `consumer-${Date.now()}-${Math.random()}`;

    await this.channel.consume(
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
      } catch (error) {
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
    try {
      const text = content.toString('utf-8');
      return JSON.parse(text);
    } catch (error) {
      // Return raw string if JSON parsing fails
      return content.toString('utf-8');
    }
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
