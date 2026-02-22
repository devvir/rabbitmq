/**
 * Main Broker class for RabbitMQ connections.
 * Provides a high-level, declarative API for managing connections, exchanges, and queues.
 */

import { EventEmitter } from 'node:events';
import {
  ConnectionOptions,
  TopologySpec,
  PublishOptions,
  ConsumerCallback,
  PublishConfig,
  BrokerState,
  RawConnection,
  RawChannel,
} from './types';
import { connectWithRetries, createChannel, closeConnection, closeChannel } from './connection';
import { Exchange } from './exchange';
import { Queue } from './queue';
import { createLogger } from './logger';

const logger = createLogger();

/**
 * Main broker for managing RabbitMQ connections and topology.
 */
export class Broker extends EventEmitter {
  private url: string;
  private connectionOptions: ConnectionOptions;
  private connection: RawConnection | null = null;
  private channel: RawChannel | null = null;
  private state: BrokerState = 'disconnected';
  private exchanges: Map<string, Exchange> = new Map();
  private queues: Map<string, Queue> = new Map();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastError: Error | null = null;

  constructor(url: string, options: ConnectionOptions = {}) {
    super();
    this.url = url;
    this.connectionOptions = {
      retries: 5,
      retryDelay: 500,
      ...options,
    };
  }

  /**
   * Initiates a connection (non-blocking).
   * The connection is established asynchronously.
   *
   * @returns this for chaining
   */
  connect(): this {
    if (this.state !== 'disconnected') {
      return this;
    }

    this.state = 'connecting';
    this.attemptConnect();

    return this;
  }

  /**
   * Connects and waits for the connection to be established.
   *
   * @returns Promise resolving when connected
   */
  async ensureConnected(): Promise<void> {
    if (this.state === 'connected') {
      return;
    }

    if (this.state === 'disconnected' || this.state === 'closed') {
      this.connect();
    }

    return new Promise((resolve, reject) => {
      if (this.state === 'connected') {
        resolve();
        return;
      }

      const onConnect = () => {
        this.off('error', onError);
        this.off('abort', onAbort);
        resolve();
      };

      const onError = (err: Error) => {
        this.off('connect', onConnect);
        this.off('abort', onAbort);
        reject(err);
      };

      const onAbort = (err: Error) => {
        this.off('connect', onConnect);
        this.off('error', onError);
        reject(err);
      };

      this.once('connect', onConnect);
      this.once('error', onError);
      this.once('abort', onAbort);
    });
  }

  /**
   * Declares exchanges and queues according to topology.
   *
   * @param spec - Topology specification
   * @returns this for chaining
   */
  async declares(spec: TopologySpec): Promise<this> {
    await this.ensureConnected();

    // Declare exchanges
    if (spec.exchanges) {
      for (const [exchangeName, exchangeSpec] of Object.entries(spec.exchanges)) {
        const exchange = new Exchange(this.channel!, exchangeName, exchangeSpec);
        await exchange.assert();
        this.exchanges.set(exchangeName, exchange);

        // Declare queues bound to this exchange
        if (exchangeSpec.queues) {
          for (const [queueName, queueSpec] of Object.entries(exchangeSpec.queues)) {
            const queue = new Queue(this.channel!, queueName, queueSpec);
            await queue.assert();

            // Bind to exchange
            const routingKeys = queueSpec.routingKey
              ? Array.isArray(queueSpec.routingKey)
                ? queueSpec.routingKey
                : [queueSpec.routingKey]
              : [queueName];

            for (const key of routingKeys) {
              await queue.bindToExchange(exchangeName, key);
            }

            this.queues.set(queueName, queue);
          }
        }
      }
    }

    // Declare standalone queues
    if (spec.queues) {
      for (const [queueName, queueSpec] of Object.entries(spec.queues)) {
        const queue = new Queue(this.channel!, queueName, queueSpec);
        await queue.assert();
        this.queues.set(queueName, queue);
      }
    }

    return this;
  }

  /**
   * Gets an exchange by name, or the only exchange if name is not provided.
   *
   * @param name - Exchange name (optional, required if multiple exchanges exist)
   * @returns Exchange instance or undefined
   * @throws if name is not provided but multiple exchanges exist
   */
  getExchange(name?: string): Exchange | undefined {
    if (name === undefined) {
      if (this.exchanges.size === 0) return undefined;
      if (this.exchanges.size === 1) return Array.from(this.exchanges.values())[0];
      throw new Error(`Multiple exchanges exist, specify name: ${Array.from(this.exchanges.keys()).join(', ')}`);
    }
    return this.exchanges.get(name);
  }

  /**
   * Gets all exchanges.
   *
   * @returns Map of exchange names to Exchange instances
   */
  getExchanges(): Map<string, Exchange> {
    return new Map(this.exchanges);
  }

  /**
   * Gets a queue by name, or the only queue if name is not provided.
   *
   * @param name - Queue name (optional, required if multiple queues exist)
   * @returns Queue instance or undefined
   * @throws if name is not provided but multiple queues exist
   */
  getQueue(name?: string): Queue | undefined {
    if (name === undefined) {
      if (this.queues.size === 0) return undefined;
      if (this.queues.size === 1) return Array.from(this.queues.values())[0];
      throw new Error(`Multiple queues exist, specify name: ${Array.from(this.queues.keys()).join(', ')}`);
    }
    return this.queues.get(name);
  }

  /**
   * Gets all queues.
   *
   * @returns Map of queue names to Queue instances
   */
  getQueues(): Map<string, Queue> {
    return new Map(this.queues);
  }

  /**
   * Gets the connection state.
   *
   * @returns Current connection state
   */
  getState(): BrokerState {
    return this.state;
  }

  /**
   * Gets the underlying amqplib connection.
   *
   * @returns Connection or null if not connected
   */
  getConnection(): RawConnection | null {
    return this.connection;
  }

  /**
   * Gets the underlying amqplib channel.
   *
   * @returns Channel or null if not connected
   */
  getChannel(): RawChannel | null {
    return this.channel;
  }

  /**
   * Publishes a message to an exchange.
   *
   * @param exchange - Exchange name
   * @param message - Message to publish
   * @param routingKey - Routing key
   * @param options - Publishing options
   * @returns true if sent (buffer not full), false otherwise
   */
  publish(exchange: string, message: any, routingKey: string, options?: PublishOptions): boolean {
    if (! this.channel) {
      throw new Error('Not connected to RabbitMQ');
    }

    const ex = this.exchanges.get(exchange);
    if (! ex) {
      throw new Error(`Exchange '${exchange}' not declared`);
    }

    return ex.publish(message, routingKey, options);
  }

  /**
   * Creates a publisher function for a specific exchange.
   * Useful for closures and callback patterns.
   *
   * @param config - Publish configuration
   * @returns Function to publish messages
   */
  publishesOn(config: PublishConfig): (message: any, key?: string, options?: PublishOptions) => boolean {
    const { exchange, key: defaultKey = '', ...publishOptions } = config;

    return (message: any, key = defaultKey, options = {}) => {
      return this.publish(exchange, message, key, { ...publishOptions, ...options });
    };
  }

  /**
   * Consumes messages from a queue.
   *
   * @param queueName - Queue name
   * @param callback - Message callback
   * @param options - Consumer options
   * @returns Function to cancel the consumer
   */
  async consume(
    queueName: string,
    callback: ConsumerCallback,
    options?: { prefetch?: number }
  ): Promise<() => Promise<void>>;

  /**
   * Consumes messages from the single declared queue.
   * Throws if no queues or more than one queue are declared.
   *
   * @param callback - Message callback
   * @param options - Consumer options
   * @returns Function to cancel the consumer
   * @throws Error if queue count is not exactly 1
   */
  async consume(
    callback: ConsumerCallback,
    options?: { prefetch?: number }
  ): Promise<() => Promise<void>>;

  async consume(
    queueNameOrCallback: string | ConsumerCallback,
    callbackOrOptions: ConsumerCallback | { prefetch?: number } = {},
    options: { prefetch?: number } = {}
  ): Promise<() => Promise<void>> {
    await this.ensureConnected();

    // Overload resolution: if first arg is string, it's the named queue form
    if (typeof queueNameOrCallback === 'string') {
      const queueName = queueNameOrCallback;
      const callback = callbackOrOptions as ConsumerCallback;

      const queue = this.queues.get(queueName);
      if (! queue) {
        throw new Error(`Queue '${queueName}' not declared`);
      }

      return queue.consume(callback, options);
    }

    // Otherwise, it's the single queue form
    const callback = queueNameOrCallback as ConsumerCallback;
    const resolvedOptions = (callbackOrOptions as { prefetch?: number }) || {};

    if (this.queues.size !== 1) {
      throw new Error(
        `Expected exactly 1 queue declared, but found ${this.queues.size}. ` +
          `Use consume(queueName, callback) to consume from a specific queue.`
      );
    }

    const queue = Array.from(this.queues.values())[0];
    return queue.consume(callback, resolvedOptions);
  }

  /**
   * Reconnects to RabbitMQ forcefully.
   *
   * @returns Promise resolving when reconnected
   */
  async reconnect(options: ConnectionOptions = {}): Promise<void> {
    if (this.state === 'reconnecting' || this.state === 'connecting') {
      return this.ensureConnected();
    }

    this.state = 'reconnecting';
    await this.disconnect();

    const mergedOptions = {
      ...this.connectionOptions,
      ...options,
    };

    this.connectionOptions = mergedOptions;
    this.connect();
    await this.ensureConnected();
  }

  /**
   * Updates connection options to use unlimited reconnection retries.
   * Useful for converting a standard connection to always-on mode.
   *
   * @param retries - Number of retries. Default: -1 (unlimited).
   * @returns this for chaining
   */
  keepAlive(retries = -1): this {
    this.connectionOptions = {
      ...this.connectionOptions,
      retries,
    };
    return this;
  }

  /**
   * Disconnects from RabbitMQ.
   *
   * @returns Promise resolving when disconnected
   */
  async disconnect(): Promise<void> {
    logger.debug('Disconnecting from RabbitMQ');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Cancel all consumers
    for (const queue of this.queues.values()) {
      try {
        await queue.cancelAllConsumers();
      } catch (error) {
        // Ignore errors
      }
    }

    // Close channel
    if (this.channel) {
      try {
        await closeChannel(this.channel);
      } catch (error) {
        // Already closed
      }
      this.channel = null;
    }

    // Close connection
    if (this.connection) {
      try {
        await closeConnection(this.connection);
      } catch (error) {
        // Already closed
      }
      this.connection = null;
    }

    if (this.state !== 'closed') {
      this.state = 'disconnected';
      logger.info('Disconnected from RabbitMQ');
      this.emit('disconnect');
    }
  }

  /**
   * Closes the broker permanently.
   *
   * @returns Promise resolving when closed
   */
  async close(): Promise<void> {
    logger.info('Closing RabbitMQ broker');
    await this.disconnect();
    this.state = 'closed';
    this.emit('close');
    this.removeAllListeners();
  }

  /**
   * Gets the last error that occurred.
   *
   * @returns Last error or null if none
   */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * Attempts to connect using configured retry logic.
   */
  private async attemptConnect(): Promise<void> {
    logger.debug('Attempting to connect', { url: this.url });
    try {
      this.connection = await connectWithRetries(this.url, this.connectionOptions);
      this.channel = await createChannel(this.connection);

      // Set up disconnect event handlers
      this.connection.once('close', () => this.handleDisconnect());
      this.connection.once('error', (err: Error) => this.handleError(err));
      this.channel.once('close', () => this.handleDisconnect());
      this.channel.once('error', (err: Error) => this.handleError(err));

      this.state = 'connected';
      this.lastError = null;
      logger.info('Connected to RabbitMQ');
      this.emit('connect');
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to connect to RabbitMQ', this.lastError);
      this.handleConnectionFailed();
    }
  }

  /**
   * Handles connection failures and decides whether to retry.
   */
  private handleConnectionFailed(): void {
    const maxRetries = this.connectionOptions.retries ?? 5;
    const canRetry = maxRetries === -1;

    if (canRetry) {
      logger.warn('Connection failed, scheduling reconnect', { retries: 'unlimited' });
      this.scheduleReconnect();
    } else {
      logger.error('Connection failed, max retries exceeded', this.lastError || undefined);
      this.state = 'disconnected';
      this.emit('abort', this.lastError);
    }
  }

  /**
   * Handles disconnection events.
   */
  private handleDisconnect(): void {
    if (this.state === 'closed') {
      return;
    }

    this.connection = null;
    this.channel = null;
    this.state = 'disconnected';
    logger.warn('Disconnected from RabbitMQ');
    this.emit('disconnect');

    // Try to reconnect if using unlimited retries
    if (this.connectionOptions.retries === -1 || this.connectionOptions.retries! > 0) {
      this.scheduleReconnect();
    }
  }

  /**
   * Handles connection errors.
   */
  private handleError(err: Error): void {
    this.lastError = err;
    logger.error('RabbitMQ connection error', err);
    this.emit('error', err);
  }

  /**
   * Schedules a reconnection attempt.
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    const delay = this.connectionOptions.retryDelay ?? 500;
    logger.debug('Reconnect scheduled', { delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.state === 'disconnected' || this.state === 'connecting') {
        this.state = 'connecting';
        logger.info('Attempting to reconnect to RabbitMQ');
        this.emit('reconnect');
        this.attemptConnect();
      }
    }, delay);
  }
}

/**
 * Creates a new broker and initiates connection.
 *
 * @param url - RabbitMQ connection URL
 * @param options - Connection options
 * @returns Broker instance (connection starts asynchronously)
 */
export const connect = (url: string, options: ConnectionOptions = {}): Broker => {
  logger.debug('Creating broker with limited retries', { retries: options.retries || 5 });
  const broker = new Broker(url, options);
  broker.connect();
  return broker;
};

/**
 * Creates a new broker with unlimited reconnection retries.
 * Ensures the broker stays connected indefinitely.
 *
 * @param url - RabbitMQ connection URL
 * @param options - Connection options
 * @returns Promise resolving to the broker (fully connected)
 */
export const keepAlive = async (url: string, options: ConnectionOptions = {}): Promise<Broker> => {
  logger.info('Creating broker with unlimited reconnection');
  const broker = new Broker(url, { retries: -1, ...options });
  broker.connect();
  await broker.ensureConnected();
  return broker;
};

/**
 * Creates a new broker and waits for connection.
 * Fails immediately if connection cannot be established.
 *
 * @param url - RabbitMQ connection URL
 * @returns Promise resolving to the broker (fully connected)
 * @throws Error if connection fails
 */
export const connectOrFail = async (url: string): Promise<Broker> => {
  logger.debug('Creating broker with no retries');
  const broker = new Broker(url, { retries: 0 });
  broker.connect();
  await broker.ensureConnected();
  return broker;
};
