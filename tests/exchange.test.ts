/**
 * Tests for RabbitMQ Exchange abstraction.
 */

import { vi } from 'vitest';
import { Exchange } from '../src/exchange';
import { ExchangeSpec } from '../src/types';
import amqp from 'amqplib';

describe('Exchange', () => {
  let mockChannel: ReturnType<typeof vi.mocked<amqp.Channel>>;
  let exchange: Exchange;

  beforeEach(() => {
    mockChannel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockReturnValue(true),
      deleteExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
    } as any;

    exchange = new Exchange(mockChannel, 'test-exchange', {
      type: 'topic',
      durable: true,
    });
  });

  describe('constructor and getters', () => {
    it('should initialize with correct name and spec', () => {
      expect(exchange.getName()).toBe('test-exchange');
      expect(exchange.getSpec()).toEqual({
        type: 'topic',
        durable: true,
      });
    });
  });

  describe('assert', () => {
    it('should assert exchange with default options', async () => {
      await exchange.assert();

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'topic', {
        durable: true,
        autoDelete: false,
        arguments: {},
      });
    });

    it('should assert with custom options', async () => {
      const customExchange = new Exchange(mockChannel, 'test-exchange', {
        type: 'direct',
        durable: false,
        autoDelete: true,
        alternateExchange: 'alt-exchange',
      });

      await customExchange.assert();

      expect(mockChannel.assertExchange).toHaveBeenCalledWith('test-exchange', 'direct', {
        durable: false,
        autoDelete: true,
        arguments: {
          'alternate-exchange': 'alt-exchange',
        },
      });
    });

    it('should use direct as default exchange type', async () => {
      const directExchange = new Exchange(mockChannel, 'test-exchange', {});

      await directExchange.assert();

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'test-exchange',
        'direct',
        expect.any(Object)
      );
    });
  });

  describe('publish', () => {
    it('should publish a message to the exchange', () => {
      const message = { test: 'data', number: 42 };
      const result = exchange.publish(message, 'routing.key');

      expect(result).toBe(true);
      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'routing.key',
        Buffer.from(JSON.stringify(message), 'utf-8'),
        {
          persistent: true,
          contentType: 'application/json',
          contentEncoding: 'utf-8',
        }
      );
    });

    it('should respect publish options', () => {
      const message = { test: 'data' };
      exchange.publish(message, 'routing.key', {
        persistent: false,
        priority: 5,
        headers: { 'custom-header': 'value' },
      });

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'routing.key',
        Buffer.from(JSON.stringify(message), 'utf-8'),
        expect.objectContaining({
          persistent: false,
          priority: 5,
          headers: { 'custom-header': 'value' },
          contentType: 'application/json',
        })
      );
    });

    it('should handle channel buffer full (returns false)', () => {
      mockChannel.publish.mockReturnValue(false);

      const result = exchange.publish({ test: 'data' }, 'routing.key');

      expect(result).toBe(false);
    });
  });

  describe('createQueue', () => {
    it('should create and bind a queue to exchange', async () => {
      const queue = await exchange.createQueue('my-queue', 'routing.key');

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('my-queue', expect.any(Object));
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'test-exchange', 'routing.key');
      expect(queue.getName()).toBe('my-queue');
    });

    it('should bind queue with multiple routing keys', async () => {
      const queue = await exchange.createQueue('my-queue', ['key1', 'key2', 'key3']);

      expect(mockChannel.bindQueue).toHaveBeenCalledTimes(3);
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'test-exchange', 'key1');
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'test-exchange', 'key2');
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('my-queue', 'test-exchange', 'key3');
    });

    it('should persist queue in internal map', async () => {
      const queue = await exchange.createQueue('my-queue', 'routing.key');

      expect(exchange.getQueue('my-queue')).toBe(queue);
    });

    it('should pass queue spec to Queue constructor', async () => {
      const spec = { durable: false, autoDelete: true };
      const queue = await exchange.createQueue('my-queue', 'key', spec);

      expect(queue.getSpec()).toMatchObject(spec);
    });
  });

  describe('getQueue', () => {
    it('should retrieve a queue by name', async () => {
      const queue = await exchange.createQueue('my-queue', 'routing.key');

      expect(exchange.getQueue('my-queue')).toBe(queue);
    });

    it('should return undefined for non-existent queue', () => {
      expect(exchange.getQueue('non-existent')).toBeUndefined();
    });
  });

  describe('getQueues', () => {
    it('should return all associated queues', async () => {
      await exchange.createQueue('queue1', 'key1');
      await exchange.createQueue('queue2', 'key2');

      const queues = exchange.getQueues();

      expect(queues.size).toBe(2);
      expect(queues.has('queue1')).toBe(true);
      expect(queues.has('queue2')).toBe(true);
    });

    it('should return a copy of the queues map', async () => {
      await exchange.createQueue('queue1', 'key1');

      const queues1 = exchange.getQueues();
      const queues2 = exchange.getQueues();

      expect(queues1).not.toBe(queues2);
      expect(queues1.size).toBe(queues2.size);
    });
  });

  describe('removeQueue', () => {
    it('should remove queue from internal map', async () => {
      await exchange.createQueue('my-queue', 'routing.key');

      exchange.removeQueue('my-queue');

      expect(exchange.getQueue('my-queue')).toBeUndefined();
    });

    it('should not throw when removing non-existent queue', () => {
      exchange.removeQueue('non-existent');
      // Should not throw
    });
  });

  describe('delete', () => {
    it('should delete the exchange', async () => {
      await exchange.delete();

      expect(mockChannel.deleteExchange).toHaveBeenCalledWith('test-exchange', {});
    });

    it('should pass deletion options', async () => {
      await exchange.delete({ ifUnused: true });

      expect(mockChannel.deleteExchange).toHaveBeenCalledWith('test-exchange', {
        ifUnused: true,
      });
    });
  });

  describe('getChannel', () => {
    it('should return the underlying channel', () => {
      const channel = exchange.getChannel();

      expect(channel).toBe(mockChannel);
    });
  });

  describe('getAllQueues', () => {
    it('should return array of all queues', async () => {
      await exchange.createQueue('queue1', 'key1');
      await exchange.createQueue('queue2', 'key2');

      const queues = exchange.getAllQueues();

      expect(Array.isArray(queues)).toBe(true);
      expect(queues).toHaveLength(2);
    });
  });

  describe('message serialization', () => {
    it('should serialize complex objects', () => {
      const message = {
        event: 'trade',
        data: {
          symbol: 'XBTUSD',
          price: 43000,
          quantity: 1.5,
        },
        timestamp: Date.now(),
        nested: {
          array: [1, 2, 3],
        },
      };

      exchange.publish(message, 'events.trade');

      expect(mockChannel.publish).toHaveBeenCalledWith(
        'test-exchange',
        'events.trade',
        Buffer.from(JSON.stringify(message), 'utf-8'),
        expect.any(Object)
      );
    });
  });
});
