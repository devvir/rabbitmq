/**
 * Tests for RabbitMQ Queue abstraction.
 */

import { vi } from 'vitest';
import { Queue } from '../src/queue';
import { QueueSpec } from '../src/types';
import amqp from 'amqplib';

describe('Queue', () => {
  let mockChannel: ReturnType<typeof vi.mocked<amqp.Channel>>;
  let queue: Queue;

  beforeEach(() => {
    mockChannel = {
      assertQueue: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      unbindQueue: vi.fn().mockResolvedValue(undefined),
      sendToQueue: vi.fn().mockReturnValue(true),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'test-tag' }),
      ack: vi.fn(),
      nack: vi.fn(),
      reject: vi.fn(),
      purgeQueue: vi.fn().mockResolvedValue({ messageCount: 5 }),
      deleteQueue: vi.fn().mockResolvedValue(undefined),
      checkQueue: vi.fn().mockResolvedValue({ messageCount: 10, consumerCount: 2 }),
      prefetch: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as any;

    queue = new Queue(mockChannel, 'test-queue', {
      durable: true,
      autoDelete: false,
    });
  });

  describe('constructor and getters', () => {
    it('should initialize with correct name and spec', () => {
      expect(queue.getName()).toBe('test-queue');
      expect(queue.getSpec()).toEqual({
        durable: true,
        autoDelete: false,
      });
    });
  });

  describe('assert', () => {
    it('should assert queue with default options', async () => {
      await queue.assert();

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue', {
        durable: true,
        autoDelete: false,
        exclusive: false,
        arguments: {},
      });
    });

    it('should pass through all queue options', async () => {
      const queueWithOptions = new Queue(mockChannel, 'test-queue', {
        durable: false,
        autoDelete: true,
        exclusive: true,
        maxPriority: 10,
        messageTtl: 5000,
        expires: 10000,
        deadLetterExchange: 'dlx',
        deadLetterRoutingKey: 'dead',
      });

      await queueWithOptions.assert();

      expect(mockChannel.assertQueue).toHaveBeenCalledWith('test-queue', {
        durable: false,
        autoDelete: true,
        exclusive: true,
        arguments: {
          'x-max-priority': 10,
          'x-message-ttl': 5000,
          'x-expires': 10000,
          'x-dead-letter-exchange': 'dlx',
          'x-dead-letter-routing-key': 'dead',
        },
      });
    });
  });

  describe('bindToExchange', () => {
    it('should bind queue to exchange with routing key', async () => {
      await queue.bindToExchange('my-exchange', 'routing.key');

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('test-queue', 'my-exchange', 'routing.key');
    });
  });

  describe('unbindFromExchange', () => {
    it('should unbind queue from exchange', async () => {
      await queue.unbindFromExchange('my-exchange', 'routing.key');

      expect(mockChannel.unbindQueue).toHaveBeenCalledWith('test-queue', 'my-exchange', 'routing.key');
    });
  });

  describe('publish', () => {
    it('should publish a message to the queue', () => {
      const message = { test: 'data', number: 42 };
      const result = queue.publish(message);

      expect(result).toBe(true);
      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'test-queue',
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
      queue.publish(message, {
        persistent: false,
        priority: 5,
        expiration: 10000,
      });

      expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
        'test-queue',
        Buffer.from(JSON.stringify(message), 'utf-8'),
        expect.objectContaining({
          persistent: false,
          priority: 5,
          expiration: 10000,
        })
      );
    });

    it('should handle channel buffer full (returns false)', () => {
      mockChannel.sendToQueue.mockReturnValue(false);

      const result = queue.publish({ test: 'data' });

      expect(result).toBe(false);
    });
  });

  describe('consume', () => {
    it('should consume messages from queue', async () => {
      const callback = vi.fn();
      const message = {
        content: Buffer.from(JSON.stringify({ hello: 'world' })),
        fields: {
          deliveryTag: 1,
          redelivered: false,
          exchange: 'test-exchange',
          routingKey: 'test.key',
        },
        properties: {
          headers: {},
          contentType: 'application/json',
        },
      } as any;

      mockChannel.consume.mockImplementation(async (queue, handler) => {
        handler?.(message);
        return { consumerTag: 'tag' };
      });

      const cancel = await queue.consume(callback);

      expect(typeof cancel).toBe('function');
      expect(callback).toHaveBeenCalledWith(
        { hello: 'world' },
        expect.objectContaining({
          metadata: expect.objectContaining({
            deliveryTag: 1,
            redelivered: false,
          }),
          ack: expect.any(Function),
          nack: expect.any(Function),
          original: message,
        })
      );
    });

    it('should handle prefetch option', async () => {
      const callback = vi.fn();
      await queue.consume(callback, { prefetch: 10 });

      expect(mockChannel.prefetch).toHaveBeenCalledWith(10);
    });

    it('should nack message on consumer error', async () => {
      const error = new Error('Processing failed');
      const callback = vi.fn().mockRejectedValue(error);

      const message = {
        content: Buffer.from(JSON.stringify({ test: 'data' })),
        fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: '' },
        properties: {},
      } as any;

      mockChannel.consume.mockImplementation(async (q, handler) => {
        handler?.(message);
        return { consumerTag: 'tag' };
      });

      await queue.consume(callback);

      // Give the promise chain time to execute
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, true);
    });

    it('should return cancel function', async () => {
      mockChannel.consume.mockResolvedValue({ consumerTag: 'test-tag' });

      const cancel = await queue.consume(vi.fn());

      await cancel();

      expect(mockChannel.cancel).toHaveBeenCalledWith(expect.any(String));
    });
  });

  describe('ack, nack, reject', () => {
    it('should acknowledge message', () => {
      const message = { fields: { deliveryTag: 1 } } as any;
      queue.ack(message);

      expect(mockChannel.ack).toHaveBeenCalledWith(message);
    });

    it('should nack message with requeue', () => {
      const message = { fields: { deliveryTag: 1 } } as any;
      queue.nack(message, true);

      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, true);
    });

    it('should nack message without requeue', () => {
      const message = { fields: { deliveryTag: 1 } } as any;
      queue.nack(message, false);

      expect(mockChannel.nack).toHaveBeenCalledWith(message, false, false);
    });

    it('should reject message with requeue', () => {
      const message = { fields: { deliveryTag: 1 } } as any;
      queue.reject(message, true);

      expect(mockChannel.reject).toHaveBeenCalledWith(message, true);
    });
  });

  describe('purge', () => {
    it('should purge queue and return message count', async () => {
      mockChannel.purgeQueue.mockResolvedValue({ messageCount: 42 });

      const count = await queue.purge();

      expect(count).toBe(42);
      expect(mockChannel.purgeQueue).toHaveBeenCalledWith('test-queue');
    });
  });

  describe('delete', () => {
    it('should delete queue', async () => {
      await queue.delete();

      expect(mockChannel.deleteQueue).toHaveBeenCalledWith('test-queue', {});
    });

    it('should pass deletion options', async () => {
      await queue.delete({ ifUnused: true, ifEmpty: false });

      expect(mockChannel.deleteQueue).toHaveBeenCalledWith('test-queue', {
        ifUnused: true,
        ifEmpty: false,
      });
    });
  });

  describe('getMessageCount', () => {
    it('should get current message count', async () => {
      mockChannel.checkQueue.mockResolvedValue({ messageCount: 25, consumerCount: 2 });

      const count = await queue.getMessageCount();

      expect(count).toBe(25);
    });
  });

  describe('getConsumerCount', () => {
    it('should get current consumer count', async () => {
      mockChannel.checkQueue.mockResolvedValue({ messageCount: 10, consumerCount: 3 });

      const count = await queue.getConsumerCount();

      expect(count).toBe(3);
    });
  });

  describe('getChannel', () => {
    it('should return the underlying channel', () => {
      const channel = queue.getChannel();

      expect(channel).toBe(mockChannel);
    });
  });

  describe('message parsing', () => {
    it('should parse JSON messages', async () => {
      const callback = vi.fn();
      const message = {
        content: Buffer.from(JSON.stringify({ event: 'test', data: [1, 2, 3] })),
        fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: '' },
        properties: {},
      } as any;

      mockChannel.consume.mockImplementation(async (q, handler) => {
        handler?.(message);
        return { consumerTag: 'tag' };
      });

      await queue.consume(callback);

      expect(callback).toHaveBeenCalledWith(
        { event: 'test', data: [1, 2, 3] },
        expect.any(Object)
      );
    });

    it('should return raw string if JSON parsing fails', async () => {
      const callback = vi.fn();
      const message = {
        content: Buffer.from('not valid json'),
        fields: { deliveryTag: 1, redelivered: false, exchange: '', routingKey: '' },
        properties: {},
      } as any;

      mockChannel.consume.mockImplementation(async (q, handler) => {
        handler?.(message);
        return { consumerTag: 'tag' };
      });

      await queue.consume(callback);

      expect(callback).toHaveBeenCalledWith('not valid json', expect.any(Object));
    });
  });
});
