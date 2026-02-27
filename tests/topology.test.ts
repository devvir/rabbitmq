// Pending Review
/**
 * Tests for topology declaration and recovery.
 */

import { vi } from 'vitest';
import { declareTopology, recoverTopology, type ConsumerRegistration } from '../src/topology';
import { Exchange } from '../src/exchange';
import { Queue } from '../src/queue';
import type { TopologySpec } from '../src/types';

vi.mock('../src/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('topology', () => {
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockChannel = {
      assertExchange: vi.fn().mockResolvedValue(undefined),
      assertQueue: vi.fn().mockResolvedValue({ messageCount: 0, consumerCount: 0 }),
      bindQueue: vi.fn().mockResolvedValue(undefined),
      consume: vi.fn().mockResolvedValue({ consumerTag: 'tag-1' }),
      prefetch: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockReturnValue(true),
      on: vi.fn(),
      once: vi.fn(),
    };
  });

  describe('declareTopology', () => {
    it('should declare exchanges from spec', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.events': { type: 'topic', durable: true },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(mockChannel.assertExchange).toHaveBeenCalledWith(
        'ex.events',
        'topic',
        expect.objectContaining({ durable: true }),
      );
      expect(exchanges.has('ex.events')).toBe(true);
    });

    it('should declare exchanges with bound queues', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.events': {
            type: 'topic',
            durable: true,
            queues: {
              'q.events': { durable: true, routingKey: 'events.#' },
            },
          },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(mockChannel.assertExchange).toHaveBeenCalled();
      expect(mockChannel.assertQueue).toHaveBeenCalled();
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('q.events', 'ex.events', 'events.#');
      expect(queues.has('q.events')).toBe(true);
    });

    it('should bind with multiple routing keys', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.data': {
            type: 'topic',
            queues: {
              'q.multi': { routingKey: ['key.a', 'key.b'] },
            },
          },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('q.multi', 'ex.data', 'key.a');
      expect(mockChannel.bindQueue).toHaveBeenCalledWith('q.multi', 'ex.data', 'key.b');
    });

    it('should use queue name as routing key when not specified', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.data': {
            type: 'direct',
            queues: {
              'q.default': {},
            },
          },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(mockChannel.bindQueue).toHaveBeenCalledWith('q.default', 'ex.data', 'q.default');
    });

    it('should declare standalone queues', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        queues: {
          'q.standalone': { durable: true },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(mockChannel.assertQueue).toHaveBeenCalled();
      expect(queues.has('q.standalone')).toBe(true);
      expect(exchanges.size).toBe(0);
    });

    it('should declare both exchanges and standalone queues', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.events': { type: 'topic' },
        },
        queues: {
          'q.standalone': { durable: true },
        },
      };

      await declareTopology(mockChannel, spec, exchanges, queues);

      expect(exchanges.has('ex.events')).toBe(true);
      expect(queues.has('q.standalone')).toBe(true);
    });

    it('should handle empty spec', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();

      await declareTopology(mockChannel, {}, exchanges, queues);

      expect(exchanges.size).toBe(0);
      expect(queues.size).toBe(0);
    });
  });

  describe('recoverTopology', () => {
    it('should update channels on existing exchange/queue instances', async () => {
      const oldChannel = { ...mockChannel };
      const exchange = new Exchange(oldChannel, 'ex.test', { type: 'topic' });
      const queue = new Queue(oldChannel, 'q.test', {});

      const setExChannelSpy = vi.spyOn(exchange, 'setChannel');
      const setQChannelSpy = vi.spyOn(queue, 'setChannel');

      const exchanges = new Map([['ex.test', exchange]]);
      const queues = new Map([['q.test', queue]]);

      await recoverTopology(mockChannel, null, exchanges, queues, []);

      expect(setExChannelSpy).toHaveBeenCalledWith(mockChannel);
      expect(setQChannelSpy).toHaveBeenCalledWith(mockChannel);
    });

    it('should re-declare topology from stored spec', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();
      const spec: TopologySpec = {
        exchanges: {
          'ex.recover': { type: 'topic' },
        },
      };

      await recoverTopology(mockChannel, spec, exchanges, queues, []);

      expect(mockChannel.assertExchange).toHaveBeenCalled();
      expect(exchanges.has('ex.recover')).toBe(true);
    });

    it('should re-register consumers after recovery', async () => {
      const queue = new Queue(mockChannel, 'q.consume', {});
      const queues = new Map([['q.consume', queue]]);
      const exchanges = new Map<string, Exchange>();

      const callback = vi.fn();
      const registrations: ConsumerRegistration[] = [
        { queueName: 'q.consume', callback, options: { prefetch: 10 } },
      ];

      await recoverTopology(mockChannel, null, exchanges, queues, registrations);

      expect(mockChannel.consume).toHaveBeenCalled();
    });

    it('should skip consumer registration when queue not found', async () => {
      const exchanges = new Map<string, Exchange>();
      const queues = new Map<string, Queue>();

      const registrations: ConsumerRegistration[] = [
        { queueName: 'q.missing', callback: vi.fn(), options: {} },
      ];

      // Should not throw
      await recoverTopology(mockChannel, null, exchanges, queues, registrations);

      expect(mockChannel.consume).not.toHaveBeenCalled();
    });
  });
});
