// Pending Review
/**
 * Connection/channel recovery and reconnection scheduling.
 *
 * Encapsulates the logic that decides _how_ to recover after a channel or
 * connection loss, and when to schedule retry attempts.
 */

import type { ConnectionOptions, RawConnection, RawChannel } from './types';
import { connectWithRetries, createChannel } from './connection';
import { createLogger } from './logger';

const logger = createLogger();

/** Callbacks the recovery module invokes on the broker. */
export type RecoveryHooks = {
  /** Called after a new channel is obtained to restore topology + consumers. */
  onRecoverTopology: () => Promise<void>;
  /** Emit a broker event. */
  emit: (event: string, ...args: any[]) => void;
  /** Get the current reconnect timer (to avoid duplicate scheduling). */
  getReconnectTimer: () => NodeJS.Timeout | null;
  /** Store the reconnect timer. */
  setReconnectTimer: (timer: NodeJS.Timeout | null) => void;
};

/**
 * Attempt a full connection + channel establishment.
 * On success, calls `onRecoverTopology` if there is stored state to restore.
 */
export const attemptConnect = async (
  url: string,
  options: ConnectionOptions,
  hasStoredState: boolean,
  hooks: RecoveryHooks,
): Promise<{ connection: RawConnection; channel: RawChannel }> => {
  logger.debug('Attempting to connect', { url });

  const connection = await connectWithRetries(url, options);
  const channel = await createChannel(connection);

  if (hasStoredState) {
    await hooks.onRecoverTopology();
  }

  return { connection, channel };
};

/**
 * Try to create a new channel on an existing connection (channel-only recovery).
 * Returns the new channel on success, or null if the connection is also dead.
 */
export const recoverChannel = async (
  connection: RawConnection,
  hooks: RecoveryHooks,
): Promise<RawChannel | null> => {
  try {
    const channel = await createChannel(connection);
    await hooks.onRecoverTopology();
    logger.info('Channel recovered on existing connection');
    return channel;
  } catch {
    logger.warn('Channel recovery failed, falling back to full reconnect');
    return null;
  }
};

/**
 * Decide whether to retry based on the configured retry policy.
 */
export const shouldRetry = (options: ConnectionOptions): boolean => {
  const retries = options.retries ?? 5;
  return retries === -1 || retries > 0;
};

/**
 * Schedule a reconnection attempt after `retryDelay` ms.
 * No-ops if one is already scheduled.
 */
export const scheduleReconnect = (
  options: ConnectionOptions,
  onReconnect: () => void,
  hooks: RecoveryHooks,
): void => {
  if (hooks.getReconnectTimer()) return;

  const delay = options.retryDelay ?? 500;
  logger.debug('Reconnect scheduled', { delay });

  hooks.setReconnectTimer(
    setTimeout(() => {
      hooks.setReconnectTimer(null);
      logger.info('Attempting to reconnect to RabbitMQ');
      hooks.emit('reconnect');
      onReconnect();
    }, delay),
  );
};
