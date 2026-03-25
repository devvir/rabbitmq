// Pending Review
/**
 * Main Broker class for RabbitMQ connections.
 *
 * Thin orchestrator that delegates to focused modules:
 *  - topology.ts  — declaring and recovering exchanges/queues/bindings
 *  - recovery.ts  — channel/connection recovery and reconnect scheduling
 *  - factories.ts — convenience constructors (connect, keepAlive, connectOrFail)
 */

import { EventEmitter } from 'node:events';
import type {
  ConnectionOptions,
  TopologySpec,
  PublishOptions,
  ConsumerCallback,
  PublishConfig,
  BrokerState,
  RawConnection,
  RawChannel,
} from './types';
import { closeConnection, closeChannel } from './connection';
import { Exchange } from './exchange';
import { Queue } from './queue';
import { declareTopology, recoverTopology } from './topology';
import {
  attemptConnect,
  recoverChannel,
  shouldRetry,
  scheduleReconnect,
  type RecoveryHooks,
} from './recovery';
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

  /** Stored topology so it can be re-declared after reconnection. */
  private topologySpec: TopologySpec | null = null;


  constructor(url: string, options: ConnectionOptions = {}) {
    super();
    this.url = url;
    this.connectionOptions = {
      retries: 5,
      retryDelay: 500,
      ...options,
    };
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  /**
   * Initiates a connection (non-blocking).
   *
   * @returns this for chaining
   */
  connect(): this {
    if (this.state !== 'disconnected') return this;

    this.state = 'connecting';
    this.doConnect();
    return this;
  }

  /**
   * Connects and waits until connected.
   */
  async ensureConnected(): Promise<void> {
    if (this.state === 'connected') return;

    if (this.state === 'disconnected' || this.state === 'closed') {
      this.connect();
    }

    return new Promise((resolve, reject) => {
      if (this.state === 'connected') return resolve();

      const cleanup = () => {
        this.off('connect', onConnect);
        this.off('error', onError);
        this.off('abort', onAbort);
      };

      const onConnect = () => { cleanup(); resolve(); };
      const onError = (err: Error) => { cleanup(); reject(err); };
      const onAbort = (err: Error) => { cleanup(); reject(err); };

      this.once('connect', onConnect);
      this.once('error', onError);
      this.once('abort', onAbort);
    });
  }

  /**
   * Reconnects to RabbitMQ forcefully.
   */
  async reconnect(options: ConnectionOptions = {}): Promise<void> {
    if (this.state === 'reconnecting' || this.state === 'connecting') {
      return this.ensureConnected();
    }

    this.state = 'reconnecting';
    await this.disconnect();
    this.connectionOptions = { ...this.connectionOptions, ...options };
    this.connect();
    await this.ensureConnected();
  }

  /**
   * Disconnects from RabbitMQ.
   */
  async disconnect(): Promise<void> {
    logger.debug('Disconnecting from RabbitMQ');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    for (const queue of this.queues.values()) {
      try { await queue.cancelAllConsumers(); } catch { /* already cancelled */ }
    }

    if (this.channel) {
      try { await closeChannel(this.channel); } catch { /* already closed */ }
      this.channel = null;
    }

    if (this.connection) {
      try { await closeConnection(this.connection); } catch { /* already closed */ }
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
   */
  async close(): Promise<void> {
    logger.info('Closing RabbitMQ broker');
    this.state = 'closed';
    await this.disconnect();
    this.emit('close');
    this.removeAllListeners();
  }

  /**
   * Enables unlimited reconnection retries.
   *
   * @param retries - Number of retries. Default: -1 (unlimited).
   * @returns this for chaining
   */
  keepAlive(retries = -1): this {
    this.connectionOptions = { ...this.connectionOptions, retries };
    return this;
  }

  // ── Topology ─────────────────────────────────────────────────────────────

  /**
   * Declares exchanges and queues according to topology.
   * The spec is stored so it can be re-declared after reconnection.
   */
  async declares(spec: TopologySpec): Promise<this> {
    this.topologySpec = spec;
    await this.ensureConnected();
    await declareTopology(this.channel!, spec, this.exchanges, this.queues);
    return this;
  }

  // ── Accessors ────────────────────────────────────────────────────────────

  getExchange(name?: string): Exchange | undefined {
    if (name === undefined) {
      if (this.exchanges.size === 0) return undefined;
      if (this.exchanges.size === 1) return Array.from(this.exchanges.values())[0];
      throw new Error(`Multiple exchanges exist, specify name: ${Array.from(this.exchanges.keys()).join(', ')}`);
    }
    return this.exchanges.get(name);
  }

  getExchanges(): Map<string, Exchange> { return new Map(this.exchanges); }

  getQueue(name?: string): Queue | undefined {
    if (name === undefined) {
      if (this.queues.size === 0) return undefined;
      if (this.queues.size === 1) return Array.from(this.queues.values())[0];
      throw new Error(`Multiple queues exist, specify name: ${Array.from(this.queues.keys()).join(', ')}`);
    }
    return this.queues.get(name);
  }

  getQueues(): Map<string, Queue> { return new Map(this.queues); }
  getState(): BrokerState { return this.state; }
  getConnection(): RawConnection | null { return this.connection; }
  getChannel(): RawChannel | null { return this.channel; }
  getLastError(): Error | null { return this.lastError; }

  // ── Publishing ───────────────────────────────────────────────────────────

  async publish(exchange: string, message: any, routingKey: string, options?: PublishOptions): Promise<void> {
    if (! this.channel) throw new Error('Not connected to RabbitMQ');

    const ex = this.exchanges.get(exchange);
    if (! ex) throw new Error(`Exchange '${exchange}' not declared`);
    return ex.publish(message, routingKey, options);
  }

  publishesOn(config: PublishConfig): (message: any, key?: string, options?: PublishOptions) => Promise<void> {
    const { exchange, key: defaultKey = '', ...publishOptions } = config;
    return (message: any, key = defaultKey, options = {}) =>
      this.publish(exchange, message, key, { ...publishOptions, ...options });
  }

  // ── Consuming ────────────────────────────────────────────────────────────

  async consume(
    queueName: string,
    callback: ConsumerCallback,
    options?: { prefetch?: number }
  ): Promise<() => Promise<void>>;

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

    let queueName: string;
    let callback: ConsumerCallback;
    let resolvedOptions: { prefetch?: number };

    if (typeof queueNameOrCallback === 'string') {
      queueName = queueNameOrCallback;
      callback = callbackOrOptions as ConsumerCallback;
      resolvedOptions = options;
    } else {
      callback = queueNameOrCallback;
      resolvedOptions = (callbackOrOptions as { prefetch?: number }) || {};

      if (this.queues.size !== 1) {
        throw new Error(
          `Expected exactly 1 queue declared, but found ${this.queues.size}. ` +
            `Use consume(queueName, callback) to consume from a specific queue.`
        );
      }

      queueName = Array.from(this.queues.keys())[0];
    }

    const queue = this.queues.get(queueName);
    if (! queue) throw new Error(`Queue '${queueName}' not declared`);

    return queue.consume(callback, resolvedOptions);
  }

  // ── Private: connection + recovery ───────────────────────────────────────

  private get recoveryHooks(): RecoveryHooks {
    return {
      onRecoverTopology: (channel) =>
        recoverTopology(channel, this.topologySpec, this.exchanges, this.queues),
      emit: (event, ...args) => this.emit(event, ...args),
      getReconnectTimer: () => this.reconnectTimer,
      setReconnectTimer: (t) => { this.reconnectTimer = t; },
    };
  }

  private get hasStoredState(): boolean {
    return this.topologySpec !== null;
  }

  private async doConnect(): Promise<void> {
    try {
      const result = await attemptConnect(
        this.url, this.connectionOptions, this.hasStoredState, this.recoveryHooks,
      );

      this.connection = result.connection;
      this.channel = result.channel;
      this.setupEventHandlers();

      this.state = 'connected';
      this.lastError = null;
      logger.info('Connected to RabbitMQ');
      this.emit('connect');
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error));

      if (this.connectionOptions.managed) {
        logger.debug('Failed to connect to RabbitMQ', { reason: this.lastError.message });
      } else {
        logger.error('Failed to connect to RabbitMQ', this.lastError);
      }

      this.handleConnectionFailed();
    }
  }

  private setupEventHandlers(): void {
    this.connection!.once('close', () => this.handleDisconnect('connection'));
    this.connection!.once('error', (err: Error) => this.handleError(err));
    this.channel!.once('close', () => this.handleDisconnect('channel'));
    this.channel!.once('error', (err: Error) => this.handleError(err));
  }

  private handleConnectionFailed(): void {
    // Only schedule reconnection for unlimited (-1) retry policies, and only if not managed.
    if (this.connectionOptions.retries === -1 && ! this.connectionOptions.managed) {
      logger.warn('Connection failed, scheduling reconnect');
      this.triggerReconnect();
    } else {
      if (! this.connectionOptions.managed) {
        logger.error('Connection failed, max retries exceeded', this.lastError || undefined);
      }

      this.state = 'disconnected';
      this.emit('abort', this.lastError);
    }
  }

  private handleDisconnect(source: 'channel' | 'connection'): void {
    if (this.state === 'closed' || this.state === 'reconnecting') return;

    logger.warn(`RabbitMQ ${source} disconnected`);
    this.channel = null;

    if (source === 'channel' && this.connection && ! this.connectionOptions.managed) {
      // Null out exchange channels so publish() suspends instead of throwing on
      // the stale closed channel while the new channel is being recovered.
      for (const exchange of this.exchanges.values()) exchange.setChannel(null);
      this.state = 'reconnecting';
      this.doRecoverChannel();
    } else {
      this.connection = null;
      this.state = 'disconnected';
      this.emit('disconnect');

      if (! this.connectionOptions.managed && shouldRetry(this.connectionOptions)) {
        this.triggerReconnect();
      }
    }
  }

  private handleError(err: Error): void {
    this.lastError = err;
    logger.error('RabbitMQ error', err);
  }

  private async doRecoverChannel(): Promise<void> {
    const newChannel = await recoverChannel(this.connection!, this.recoveryHooks);

    if (newChannel) {
      this.channel = newChannel;
      this.channel.once('close', () => this.handleDisconnect('channel'));
      this.channel.once('error', (err: Error) => this.handleError(err));
      this.state = 'connected';
      this.emit('connect');
    } else {
      this.connection = null;
      this.state = 'disconnected';
      this.emit('disconnect');
      if (shouldRetry(this.connectionOptions)) this.triggerReconnect();
    }
  }

  private triggerReconnect(): void {
    scheduleReconnect(
      this.connectionOptions,
      () => {
        if (this.state === 'disconnected' || this.state === 'connecting') {
          this.state = 'connecting';
          this.doConnect();
        }
      },
      this.recoveryHooks,
    );
  }
}
