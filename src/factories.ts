// Pending Review
/**
 * Convenience factory functions for creating pre-configured Broker instances.
 */

import type { ConnectionOptions } from './types';
import { Broker } from './broker';
import { createLogger } from './logger';

const logger = createLogger();

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
