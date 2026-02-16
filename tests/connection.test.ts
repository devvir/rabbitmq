/**
 * Tests for RabbitMQ connection module.
 */

import { vi } from 'vitest';
import * as connection from '../src/connection';
import amqp from 'amqplib';

// Mock amqplib
vi.mock('amqplib');
vi.mock('../src/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('Connection Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('connectWithRetries', () => {
    it('should connect successfully on first attempt', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };
      (amqp.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockConnection);

      const result = await connection.connectWithRetries('amqp://localhost', { retries: 2 });

      expect(result).toBe(mockConnection);
      expect(amqp.connect).toHaveBeenCalledTimes(1);
    });

    it('should retry on connection failure', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };
      (amqp.connect as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValueOnce(mockConnection);

      const result = await connection.connectWithRetries('amqp://localhost', {
        retries: 2,
        retryDelay: 10,
      });

      expect(result).toBe(mockConnection);
      expect(amqp.connect).toHaveBeenCalledTimes(2);
    });

    it('should fail after exhausting retries', async () => {
      (amqp.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection failed'));

      try {
        await connection.connectWithRetries('amqp://localhost', {
          retries: 2,
          retryDelay: 10,
        });
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Failed to connect');
        expect(amqp.connect).toHaveBeenCalledTimes(3); // Initial + 2 retries
      }
    });

    it('should support unlimited retries with -1', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };
      (amqp.connect as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Attempt 1'))
        .mockRejectedValueOnce(new Error('Attempt 2'))
        .mockResolvedValueOnce(mockConnection);

      const result = await connection.connectWithRetries('amqp://localhost', {
        retries: -1,
        retryDelay: 10,
      });

      expect(result).toBe(mockConnection);
    });

    it('should use default retry configuration', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };
      (amqp.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockConnection);

      const result = await connection.connectWithRetries('amqp://localhost');

      expect(result).toBe(mockConnection);
      expect(amqp.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('connectOnce', () => {
    it('should attempt connection without retries', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };
      (amqp.connect as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockConnection);

      const result = await connection.connectOnce('amqp://localhost');

      expect(result).toBe(mockConnection);
      expect(amqp.connect).toHaveBeenCalledTimes(1);
    });

    it('should fail immediately on error', async () => {
      (amqp.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Connection failed'));

      try {
        await connection.connectOnce('amqp://localhost');
        fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('createChannel', () => {
    it('should create a channel from connection', async () => {
      const mockChannel = { setMaxListeners: vi.fn() };
      const mockConnection = { createChannel: vi.fn().mockResolvedValue(mockChannel) };

      const result = await connection.createChannel(mockConnection as any);

      expect(result).toBe(mockChannel);
      expect(mockConnection.createChannel).toHaveBeenCalledTimes(1);
      expect(mockChannel.setMaxListeners).toHaveBeenCalledWith(100);
    });
  });

  describe('closeConnection', () => {
    it('should close the connection', async () => {
      const mockConnection = { close: vi.fn().mockResolvedValue(undefined) };

      await connection.closeConnection(mockConnection as any);

      expect(mockConnection.close).toHaveBeenCalledTimes(1);
    });

    it('should handle already-closed connection', async () => {
      const mockConnection = {
        close: vi.fn().mockRejectedValue(new Error('Already closed')),
      };

      // Should not throw
      await connection.closeConnection(mockConnection as any);
      expect(mockConnection.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('closeChannel', () => {
    it('should close the channel', async () => {
      const mockChannel = { close: vi.fn().mockResolvedValue(undefined) };

      await connection.closeChannel(mockChannel as any);

      expect(mockChannel.close).toHaveBeenCalledTimes(1);
    });

    it('should handle already-closed channel', async () => {
      const mockChannel = { close: vi.fn().mockRejectedValue(new Error('Already closed')) };

      // Should not throw
      await connection.closeChannel(mockChannel as any);
      expect(mockChannel.close).toHaveBeenCalledTimes(1);
    });
  });
});
