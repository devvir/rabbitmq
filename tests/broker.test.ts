/**
 * Tests for RabbitMQ Broker class.
 */

import { vi } from 'vitest';
import { Broker, connect, keepAlive, connectOrFail } from '../src/broker';
import * as connection from '../src/connection';
import amqp from 'amqplib';

vi.mock('../src/connection');
vi.mock('amqplib');
vi.mock('../src/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('Broker', () => {
  let mockConnection: ReturnType<typeof vi.mocked<any>>;
  let mockChannel: ReturnType<typeof vi.mocked<any>>;
  let broker: Broker;

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockReturnValue(true),
      sendToQueue: vi.fn().mockReturnValue(true),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'tag' }),
      prefetch: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      setMaxListeners: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };

    mockConnection = {
      createChannel: vi.fn().mockResolvedValue(mockChannel),
      on: vi.fn(),
      once: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };

    (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);
    (connection.createChannel as ReturnType<typeof vi.fn>).mockResolvedValue(mockChannel);
    (connection.closeConnection as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (connection.closeChannel as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    broker = new Broker('amqp://localhost', { retries: 2, retryDelay: 10 });
  });

  describe('constructor and initialization', () => {
    it('should initialize with URL and options', () => {
      const testBroker = new Broker('amqp://test', { retries: 3 });

      expect(testBroker.getState()).toBe('disconnected');
      expect(testBroker.getConnection()).toBeNull();
      expect(testBroker.getChannel()).toBeNull();
    });

    it('should use default connection options', () => {
      const testBroker = new Broker('amqp://test');

      expect(testBroker.getState()).toBe('disconnected');
    });
  });

  describe('connect', () => {
    it('should initiate connection asynchronously', () => {
      broker.connect();

      expect(broker.getState()).toBe('connecting');
    });

    it('should not re-connect if already connecting', async () => {
      broker.connect();
      await new Promise(resolve => setImmediate(resolve));

      broker.connect();

      expect(connection.connectWithRetries).toHaveBeenCalledTimes(1);
    });

    it('should return itself for chaining', () => {
      const result = broker.connect();

      expect(result).toBe(broker);
    });
  });

  describe('ensureConnected', () => {
    it('should wait for connection if not connected', async () => {
      broker.connect();

      await new Promise(resolve => setImmediate(resolve));

      await broker.ensureConnected();

      expect(broker.getState()).toBe('connected');
      expect(broker.getConnection()).toBe(mockConnection);
      expect(broker.getChannel()).toBe(mockChannel);
    });

    it('should resolve immediately if already connected', async () => {
      broker.connect();
      await broker.ensureConnected();

      const startTime = Date.now();
      await broker.ensureConnected();
      const elapsed = Date.now() - startTime;

      // Should resolve very quickly
      expect(elapsed).toBeLessThan(100);
    });

    it('should reject when connection fails', async () => {
      (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed')
      );

      broker.connect();

      try {
        await broker.ensureConnected();
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('declares', () => {
    it('should declare exchanges and queues from topology', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': {
            type: 'topic',
            queues: {
              'my-queue': { routingKey: 'events.*' },
            },
          },
        },
      });

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'my-exchange',
        'topic',
        expect.any(Object)
      );
      expect(mockChannel.assertQueue).toHaveBeenCalledWith('my-queue', expect.any(Object));
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'my-exchange', 'events.*');
    });

    it('should declare standalone queues', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        queues: {
          'standalone-queue': { durable: true },
        },
      });

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('standalone-queue', expect.any(Object));
    });

    it('should bind queue with multiple routing keys', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': {
            type: 'topic',
            queues: {
              'my-queue': { routingKey: ['key1', 'key2'] },
            },
          },
        },
      });

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'my-exchange', 'key1');
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'my-exchange', 'key2');
    });

    it('should return broker for chaining', async () => {
      broker.connect();
      await broker.ensureConnected();

      const result = await broker.declares({});

      expect(result).toBe(broker);
    });
  });

  describe('getExchange', () => {
    it('should return declared exchange', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': { type: 'direct' },
        },
      });

      const exchange = broker.getExchange('my-exchange');

      expect(exchange).toBeDefined();
      expect(exchange?.getName()).toBe('my-exchange');
    });

    it('should return undefined for non-existent exchange', () => {
      const exchange = broker.getExchange('non-existent');

      expect(exchange).toBeUndefined();
    });
  });

  describe('getQueue', () => {
    it('should return declared queue', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        queues: {
          'my-queue': {},
        },
      });

      const queue = broker.getQueue('my-queue');

      expect(queue).toBeDefined();
      expect(queue?.getName()).toBe('my-queue');
    });

    it('should return undefined for non-existent queue', () => {
      const queue = broker.getQueue('non-existent');

      expect(queue).toBeUndefined();
    });
  });

  describe('getState', () => {
    it('should return current connection state', () => {
      expect(broker.getState()).toBe('disconnected');

      broker.connect();

      expect(broker.getState()).toBe('connecting');
    });
  });

  describe('getConnection and getChannel', () => {
    it('should return connection and channel when connected', async () => {
      broker.connect();
      await broker.ensureConnected();

      expect(broker.getConnection()).toBe(mockConnection);
      expect(broker.getChannel()).toBe(mockChannel);
    });

    it('should return null when not connected', () => {
      expect(broker.getConnection()).toBeNull();
      expect(broker.getChannel()).toBeNull();
    });
  });

  describe('publish', () => {
    it('should publish message to exchange', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': { type: 'direct' },
        },
      });

      const result = broker.publish('my-exchange', { test: 'data' }, 'routing.key');

      expect(result).toBe(true);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'my-exchange',
        'routing.key',
        Buffer.from(JSON.stringify({ test: 'data' }), 'utf-8'),
        expect.any(Object)
      );
    });

    it('should throw if not connected', () => {
      expect(() => broker.publish('exchange', {}, '')).toThrow('Not connected');
    });

    it('should throw if exchange not declared', async () => {
      broker.connect();
      await broker.ensureConnected();

      expect(() => broker.publish('unknown-exchange', {}, '')).toThrow("Exchange 'unknown-exchange' not declared");
    });
  });

  describe('publishesOn', () => {
    it('should create publisher function', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': { type: 'direct' },
        },
      });

      const publish = broker.publishesOn({ exchange: 'my-exchange', key: 'default.key' });

      const result = publish({ test: 'data' });

      expect(result).toBe(true);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'my-exchange',
        'default.key',
        expect.any(Buffer),
        expect.any(Object)
      );
    });

    it('should allow overriding routing key', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        exchanges: {
          'my-exchange': { type: 'direct' },
        },
      });

      const publish = broker.publishesOn({ exchange: 'my-exchange' });

      publish({ test: 'data' }, 'override.key');

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'my-exchange',
        'override.key',
        expect.any(Buffer),
        expect.any(Object)
      );
    });
  });

  describe('consume', () => {
    it('should consume from declared queue', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        queues: {
          'my-queue': {},
        },
      });

      const callback = vi.fn();
      const cancel = await broker.consume('my-queue', callback);

      expect(typeof cancel).toBe('function');
    });

    it('should throw if queue not declared', async () => {
      broker.connect();
      await broker.ensureConnected();

      const callback = vi.fn();

      try {
        await broker.consume('unknown-queue', callback);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain("Queue 'unknown-queue' not declared");
      }
    });

    it('should ensure connected before consuming', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.declares({
        queues: {
          'my-queue': {},
        },
      });

      const promise = broker.consume('my-queue', vi.fn());

      // Should eventually connect
      await new Promise(resolve => setImmediate(resolve));
    });
  });

  describe('disconnect', () => {
    it('should disconnect from RabbitMQ', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.disconnect();

      expect(connection.closeChannel).toHaveBeenCalledWith(mockChannel);
      expect(connection.closeConnection).toHaveBeenCalledWith(mockConnection);
      expect(broker.getState()).toBe('disconnected');
    });

    it('should emit disconnect event', async () => {
      broker.connect();
      await broker.ensureConnected();

      const listener = vi.fn();
      broker.on('disconnect', listener);

      await broker.disconnect();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('should close broker permanently', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.close();

      expect(broker.getState()).toBe('closed');
      expect(connection.closeChannel).toHaveBeenCalled();
      expect(connection.closeConnection).toHaveBeenCalled();
    });

    it('should emit close event', async () => {
      broker.connect();
      await broker.ensureConnected();

      const listener = vi.fn();
      broker.on('close', listener);

      await broker.close();

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('reconnect', () => {
    it('should reconnect with new options', async () => {
      broker.connect();
      await broker.ensureConnected();

      await broker.reconnect({ retries: 1 });

      expect(broker.getState()).toBe('connected');
    });
  });

  describe('keepAlive', () => {
    it('should enable unlimited reconnection retries', async () => {
      broker.connect();
      await broker.ensureConnected();

      broker.keepAlive();

      const result = broker.keepAlive();

      expect(result).toBe(broker);
    });
  });

  describe('events', () => {
    it('should emit connect event', async () => {
      const listener = vi.fn();
      broker.on('connect', listener);

      broker.connect();
      await broker.ensureConnected();

      expect(listener).toHaveBeenCalled();
    });

    it('should emit error event', async () => {
      (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Test error'));

      const errorListener = vi.fn();
      broker.on('error', errorListener);

      broker.connect();
      await new Promise(resolve => setImmediate(resolve));

      // Error should be emitted
    });
  });

  describe('getLastError', () => {
    it('should return last error or null', () => {
      expect(broker.getLastError()).toBeNull();
    });
  });
});

describe('Factory functions', () => {
  let mockConnection: ReturnType<typeof vi.mocked<any>>;
  let mockChannel: ReturnType<typeof vi.mocked<any>>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      setMaxListeners: vi.fn(),
      on: vi.fn(),
      once: vi.fn(),
    };

    mockConnection = {
      createChannel: vi.fn().mockResolvedValue(mockChannel),
      on: vi.fn(),
      once: vi.fn(),
    };

    (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);
    (connection.createChannel as ReturnType<typeof vi.fn>).mockResolvedValue(mockChannel);
  });

  describe('connect', () => {
    it('should create broker and initiate connection', async () => {
      const broker = connect('amqp://localhost', { retries: 2 });

      expect(broker).toBeInstanceOf(Broker);
      expect(broker.getState()).toBe('connecting');

      await broker.ensureConnected();

      expect(broker.getState()).toBe('connected');
    });
  });

  describe('keepAlive', () => {
    it('should create broker with unlimited retries', async () => {
      const broker = await keepAlive('amqp://localhost');

      expect(broker.getState()).toBe('connected');
      expect(connection.connectWithRetries).toHaveBeenCalledWith(
        'amqp://localhost',
        expect.objectContaining({ retries: -1 })
      );
    });
  });

  describe('connectOrFail', () => {
    it('should create broker with no retries', async () => {
      const broker = await connectOrFail('amqp://localhost');

      expect(broker.getState()).toBe('connected');
      expect(connection.connectWithRetries).toHaveBeenCalledWith(
        'amqp://localhost',
        expect.objectContaining({ retries: 0 })
      );
    });

    it('should fail if connection cannot be established', async () => {
      (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed')
      );

      try {
        await connectOrFail('amqp://localhost');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });
});
