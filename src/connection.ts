/**
 * Connection management with retry logic.
 * Handles establishing and maintaining RabbitMQ connections.
 */

import amqp from 'amqplib';
import { ConnectionOptions, RawConnection, RawChannel } from './types';

/**
 * Attempts to establish a connection with retry logic.
 *
 * @param url - RabbitMQ connection URL
 * @param options - Connection options including retry configuration
 * @returns Promise resolving to the connection
 * @throws Error if all retry attempts fail
 */
export const connectWithRetries = async (
  url: string,
  options: ConnectionOptions = {}
): Promise<RawConnection> => {
  const { retries = 5, retryDelay = 500 } = options;

  let lastError: Error | null = null;
  const maxAttempts = retries === -1 ? Infinity : retries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const connection = await amqp.connect(url);
      return connection;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxAttempts) {
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw new Error(`Failed to connect to RabbitMQ after ${maxAttempts} attempts: ${lastError?.message}`);
};

/**
 * Attempts a single connection without retries.
 *
 * @param url - RabbitMQ connection URL
 * @returns Promise resolving to the connection
 * @throws Error if connection fails
 */
export const connectOnce = async (url: string): Promise<RawConnection> => {
  return connectWithRetries(url, { retries: 0 });
};

/**
 * Sets up a connection with automatic reconnection logic.
 *
 * @param url - RabbitMQ connection URL
 * @param options - Connection options
 * @param onDisconnect - Callback invoked when connection is lost
 * @returns Promise resolving to the connection
 */
export const connectWithReconnect = async (
  url: string,
  options: ConnectionOptions = {},
  onDisconnect?: () => void
): Promise<RawConnection> => {
  const connection = await connectWithRetries(url, options);

  // Set up reconnection on connection loss
  connection.once('close', () => {
    onDisconnect?.();
  });

  connection.once('error', () => {
    onDisconnect?.();
  });

  return connection;
};

/**
 * Creates a channel from a connection.
 *
 * @param connection - RabbitMQ connection
 * @returns Promise resolving to the channel
 */
export const createChannel = async (connection: RawConnection): Promise<RawChannel> => {
  const channel = await connection.createChannel();
  channel.setMaxListeners(100);
  return channel;
};

/**
 * Gracefully closes a connection.
 *
 * @param connection - RabbitMQ connection to close
 */
export const closeConnection = async (connection: RawConnection): Promise<void> => {
  try {
    await connection.close();
  } catch (error) {
    // Connection may already be closed
  }
};

/**
 * Gracefully closes a channel.
 *
 * @param channel - RabbitMQ channel to close
 */
export const closeChannel = async (channel: RawChannel): Promise<void> => {
  try {
    await channel.close();
  } catch (error) {
    // Channel may already be closed
  }
};
