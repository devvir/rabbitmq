/**
 * Logger for RabbitMQ connection lifecycle events.
 * Provides a simple, framework-agnostic interface for logging.
 */

export interface Logger {
  info(msg: string, data?: Record<string, any>): void;
  warn(msg: string, data?: Record<string, any>): void;
  error(msg: string, err?: Error | Record<string, any>): void;
  debug(msg: string, data?: Record<string, any>): void;
}

/**
 * Creates a logger that uses console for output.
 * Respects DEBUG environment variable for verbose output.
 *
 * @returns Logger instance
 */
export const createLogger = (): Logger => ({
  info: (msg: string, data?: Record<string, any>) => {
    console.log(`[RabbitMQ] ${msg}`, data ? JSON.stringify(data) : '');
  },
  warn: (msg: string, data?: Record<string, any>) => {
    console.warn(`[RabbitMQ] ${msg}`, data ? JSON.stringify(data) : '');
  },
  error: (msg: string, err?: Error | Record<string, any>) => {
    if (err instanceof Error) {
      console.error(`[RabbitMQ] ${msg}:`, err.message);
    } else {
      console.error(`[RabbitMQ] ${msg}`, err ? JSON.stringify(err) : '');
    }
  },
  debug: (msg: string, data?: Record<string, any>) => {
    if (process.env.DEBUG?.includes('rabbitmq')) {
      console.debug(`[RabbitMQ] ${msg}`, data ? JSON.stringify(data) : '');
    }
  },
});
