// Pending Review
/**
 * Tests for recovery module (attemptConnect, recoverChannel, shouldRetry, scheduleReconnect).
 */

import { vi } from 'vitest';
import { attemptConnect, recoverChannel, shouldRetry, scheduleReconnect, type RecoveryHooks } from '../src/recovery';
import * as connection from '../src/connection';

vi.mock('../src/connection');
vi.mock('../src/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const createMockHooks = (): RecoveryHooks => ({
  onRecoverTopology: vi.fn().mockResolvedValue(undefined),
  emit: vi.fn(),
  getReconnectTimer: vi.fn().mockReturnValue(null),
  setReconnectTimer: vi.fn(),
});

describe('recovery', () => {
  let mockConnection: any;
  let mockChannel: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    mockChannel = {
      assertExchange: vi.fn(),
      assertQueue: vi.fn(),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('attemptConnect', () => {
    it('should connect and create channel', async () => {
      const hooks = createMockHooks();

      const result = await attemptConnect('amqp://localhost', {}, false, hooks);

      expect(connection.connectWithRetries).toHaveBeenCalledWith('amqp://localhost', {});
      expect(connection.createChannel).toHaveBeenCalledWith(mockConnection);
      expect(result.connection).toBe(mockConnection);
      expect(result.channel).toBe(mockChannel);
    });

    it('should recover topology when stored state exists', async () => {
      const hooks = createMockHooks();

      await attemptConnect('amqp://localhost', {}, true, hooks);

      expect(hooks.onRecoverTopology).toHaveBeenCalled();
    });

    it('should skip topology recovery when no stored state', async () => {
      const hooks = createMockHooks();

      await attemptConnect('amqp://localhost', {}, false, hooks);

      expect(hooks.onRecoverTopology).not.toHaveBeenCalled();
    });

    it('should propagate connection errors', async () => {
      const hooks = createMockHooks();
      (connection.connectWithRetries as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network unreachable'),
      );

      await expect(attemptConnect('amqp://localhost', {}, false, hooks)).rejects.toThrow(
        'Network unreachable',
      );
    });

    it('should propagate channel creation errors', async () => {
      const hooks = createMockHooks();
      (connection.createChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Channel creation failed'),
      );

      await expect(attemptConnect('amqp://localhost', {}, false, hooks)).rejects.toThrow(
        'Channel creation failed',
      );
    });
  });

  describe('recoverChannel', () => {
    it('should create channel and recover topology', async () => {
      const hooks = createMockHooks();

      const channel = await recoverChannel(mockConnection, hooks);

      expect(connection.createChannel).toHaveBeenCalledWith(mockConnection);
      expect(hooks.onRecoverTopology).toHaveBeenCalled();
      expect(channel).toBe(mockChannel);
    });

    it('should return null when channel creation fails', async () => {
      const hooks = createMockHooks();
      (connection.createChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection dead'),
      );

      const channel = await recoverChannel(mockConnection, hooks);

      expect(channel).toBeNull();
    });

    it('should return null when topology recovery fails', async () => {
      const hooks = createMockHooks();
      (hooks.onRecoverTopology as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Topology recovery failed'),
      );

      const channel = await recoverChannel(mockConnection, hooks);

      expect(channel).toBeNull();
    });
  });

  describe('shouldRetry', () => {
    it('should return true for unlimited retries', () => {
      expect(shouldRetry({ retries: -1 })).toBe(true);
    });

    it('should return true for positive retries', () => {
      expect(shouldRetry({ retries: 3 })).toBe(true);
    });

    it('should return false for zero retries', () => {
      expect(shouldRetry({ retries: 0 })).toBe(false);
    });

    it('should default to retries=5 when not specified', () => {
      expect(shouldRetry({})).toBe(true);
    });
  });

  describe('scheduleReconnect', () => {
    it('should schedule reconnect after delay', async () => {
      const hooks = createMockHooks();
      const onReconnect = vi.fn();

      scheduleReconnect({ retryDelay: 100 }, onReconnect, hooks);

      expect(hooks.setReconnectTimer).toHaveBeenCalled();
      expect(onReconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(100);

      expect(onReconnect).toHaveBeenCalled();
      expect(hooks.emit).toHaveBeenCalledWith('reconnect');
    });

    it('should use default delay when not specified', async () => {
      const hooks = createMockHooks();
      const onReconnect = vi.fn();

      scheduleReconnect({}, onReconnect, hooks);

      await vi.advanceTimersByTimeAsync(499);
      expect(onReconnect).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(onReconnect).toHaveBeenCalled();
    });

    it('should not schedule if timer already exists', () => {
      const hooks = createMockHooks();
      (hooks.getReconnectTimer as ReturnType<typeof vi.fn>).mockReturnValue(
        setTimeout(() => {}, 1000),
      );
      const onReconnect = vi.fn();

      scheduleReconnect({ retryDelay: 100 }, onReconnect, hooks);

      expect(hooks.setReconnectTimer).not.toHaveBeenCalled();
    });

    it('should clear timer ref after fire', async () => {
      const hooks = createMockHooks();
      const onReconnect = vi.fn();

      scheduleReconnect({ retryDelay: 50 }, onReconnect, hooks);

      await vi.advanceTimersByTimeAsync(50);

      // setReconnectTimer called twice: once to set, once to clear (null)
      expect(hooks.setReconnectTimer).toHaveBeenCalledWith(null);
    });
  });
});
