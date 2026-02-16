# API Reference

Complete TypeScript interface documentation for @devvir/rabbitmq.

## Module: `@devvir/rabbitmq`

### Connection Functions

#### `keepAlive(url: string): Promise<Broker>`

Create a broker with unlimited automatic retries.

**Parameters:**
- `url` - RabbitMQ connection URL (e.g., `amqp://guest:guest@localhost:5672`)

**Returns:** Connected `Broker` instance

**Throws:** Never (retries indefinitely)

**Example:**
```typescript
const broker = await keepAlive('amqp://localhost');
```

#### `connectOrFail(url: string): Promise<Broker>`

Create a broker with a single connection attempt.

**Parameters:**
- `url` - RabbitMQ connection URL

**Returns:** Connected `Broker` instance

**Throws:** Error if connection fails

**Example:**
```typescript
try {
  const broker = await connectOrFail('amqp://localhost');
} catch (error) {
  console.error('Failed to connect:', error);
}
```

#### `connect(url: string, options?: ConnectOptions): Broker`

Create a broker with custom retry configuration.

**Parameters:**
- `url` - RabbitMQ connection URL
- `options` - Optional connection options

**Returns:** `Broker` instance (connection starts asynchronously)

**Options:**
```typescript
interface ConnectOptions {
  maxRetries?: number;          // Maximum retry attempts (default: Infinity)
  initialDelay?: number;        // Initial delay in ms (default: 1000)
  maxDelay?: number;            // Maximum delay in ms (default: 30000)
  backoffMultiplier?: number;   // Multiply delay by this (default: 2)
}
```

**Example:**
```typescript
const broker = connect('amqp://localhost', {
  maxRetries: 5,
  initialDelay: 500,
});

await broker.ensureConnected();
```

---

## Broker Interface

Main entry point for RabbitMQ operations.

### Methods

#### `async ensureConnected(): Promise<void>`

Wait for connection to establish.

**Throws:** Error if connection fails and retries exhausted

**Example:**
```typescript
const broker = connect('amqp://localhost');
await broker.ensureConnected();
```

#### `async declares(topology: TopologyDeclaration): Promise<void>`

Declare exchanges and queues.

**Parameters:**
- `topology` - Exchanges and queues to declare (see topology docs)

**Returns:** Resolves when topology is declared

**Idempotent:** Safe to call multiple times

**Example:**
```typescript
await broker.declares({
  exchanges: {
    'trades': { type: 'topic', durable: true }
  }
});
```

#### `async publish<T>(exchange: string, routingKey: string, message: T, options?: PublishOptions): Promise<void>`

Publish a message to an exchange.

**Parameters:**
- `exchange` - Exchange name
- `routingKey` - Message routing key
- `message` - Message body (must be JSON serializable)
- `options` - Optional publish options

**Type Parameters:**
- `T` - Message type (automatically serialized/deserialized)

**Returns:** Resolves when message is sent

**Throws:** Error if not connected or publishing fails

**Example:**
```typescript
type Trade = { symbol: string; price: number };

await broker.publish<Trade>(
  'trades',
  'trade.btc',
  { symbol: 'XBTUSD', price: 42500 }
);
```

#### `queue(name: string): Queue`

Get or create a queue reference.

**Parameters:**
- `name` - Queue name

**Returns:** `Queue` instance

**Does not**: Declare the queue (must use `declares()` first)

**Example:**
```typescript
const queue = broker.queue('trades');
```

#### `exchange(name: string): Exchange`

Get or create an exchange reference.

**Parameters:**
- `name` - Exchange name

**Returns:** `Exchange` instance

**Does not**: Declare the exchange (must use `declares()` first)

**Example:**
```typescript
const exchange = broker.exchange('trades');
```

#### `getState(): BrokerState`

Get current connection state.

**Returns:** One of: `'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'`

**Example:**
```typescript
if (broker.getState() === 'connected') {
  await broker.publish('trades', 'trade.btc', data);
}
```

#### `getStats(): BrokerStats`

Get message statistics.

**Returns:**
```typescript
interface BrokerStats {
  messagesPublished: number;    // Total messages published
  messagesProcessed: number;    // Total messages processed
  lastProcessedTime: number | null;  // Timestamp of last processed message
}
```

**Example:**
```typescript
const { messagesPublished, messagesProcessed } = broker.getStats();
console.log(`${messagesProcessed}/${messagesPublished} messages processed`);
```

#### `async close(): Promise<void>`

Close the connection permanently.

**Returns:** Resolves when closed

**Note:** Broker cannot be reconnected after closing

**Example:**
```typescript
await broker.close();
```

### Events

#### `on(event: string, handler: Function): void`

Listen to broker events.

**Events:**
- `'connect'` - Connected to RabbitMQ
- `'disconnect'` - Disconnected unexpectedly
- `'reconnect'` - Retrying connection
- `'error'` - Error occurred
- `'closed'` - Permanently closed

**Example:**
```typescript
broker.on('connect', () => console.log('Connected!'));
broker.on('error', (err) => console.error('Error:', err));
```

#### `once(event: string, handler: Function): void`

Listen to broker event once.

**Example:**
```typescript
broker.once('connect', () => console.log('Connected for first time'));
```

---

## Queue Interface

Represents a RabbitMQ queue.

### Methods

#### `async consume<T>(handler: (message: T) => Promise<void>, options?: ConsumeOptions): Promise<() => Promise<void>>`

Start consuming messages from the queue.

**Parameters:**
- `handler` - Async function handling each message
- `options` - Optional consume options

**Returns:** Cancellation function to stop consuming

**Type Parameters:**
- `T` - Message type

**Options:**
```typescript
interface ConsumeOptions {
  prefetch?: number;  // Max messages in flight (default: 1)
}
```

**Message Acking:**
- If handler completes: message is acknowledged (removed)
- If handler throws: message is requeued

**Example:**
```typescript
type Trade = { symbol: string; price: number };

const cancel = await queue.consume<Trade>(async (trade) => {
  console.log('Trade:', trade.symbol);
});

// Later:
await cancel();
```

#### `async publish<T>(message: T, options?: PublishOptions): Promise<void>`

Publish message directly to queue (no exchange).

**Parameters:**
- `message` - Message body
- `options` - Optional publish options

**Returns:** Resolves when message is sent

**Example:**
```typescript
await queue.publish({ symbol: 'XBTUSD', price: 42500 });
```

#### `async bind(exchange: string, routingKey: string): Promise<void>`

Manually bind queue to exchange (called automatically during `declares()`).

**Parameters:**
- `exchange` - Exchange name
- `routingKey` - Routing pattern

**Example:**
```typescript
await queue.bind('trades', 'trade.*');
```

---

## Exchange Interface

Represents a RabbitMQ exchange.

### Methods

#### `async publish<T>(routingKey: string, message: T, options?: PublishOptions): Promise<void>`

Publish message to exchange with routing key.

**Parameters:**
- `routingKey` - Message routing key
- `message` - Message body
- `options` - Optional publish options

**Returns:** Resolves when message is sent

**Example:**
```typescript
await exchange.publish('trade.btc', { price: 42500 });
```

---

## publish Options

Message publishing options (used in `publish()` calls):

```typescript
interface PublishOptions {
  persistent?: boolean;        // Survive broker restart (default: true)
  contentType?: string;        // MIME type (default: 'application/json')
  contentEncoding?: string;    // Encoding (default: 'utf-8')
  expiration?: string;         // TTL in ms (as string)
  priority?: number;           // 0-10, higher = more urgent
  correlationId?: string;      // Link request/response
  replyTo?: string;            // Queue for responses
  messageId?: string;          // Unique ID
  timestamp?: number;          // Unix timestamp
}
```

---

## Topology Declaration

Declare exchanges and queues upfront.

```typescript
interface TopologyDeclaration {
  exchanges?: {
    [exchangeName: string]: ExchangeDeclaration;
  };
  queues?: {
    [queueName: string]: QueueDeclaration;
  };
}

interface ExchangeDeclaration {
  type: 'direct' | 'topic' | 'fanout' | 'headers';
  durable?: boolean;           // Survive broker restart
  autoDelete?: boolean;        // Delete when no queues bound
  queues?: {
    [queueName: string]: QueueBinding;
  };
}

interface QueueDeclaration {
  durable?: boolean;           // Survive broker restart
  exclusive?: boolean;         // Only for this connection
  autoDelete?: boolean;        // Delete when consumer leaves
  arguments?: Record<string, any>;  // x-* AMQP arguments
}

interface QueueBinding {
  routingKey?: string;          // Binding key/pattern
  durable?: boolean;
  exclusive?: boolean;
  autoDelete?: boolean;
  arguments?: Record<string, any>;
}
```

---

## Type Definitions

### BrokerState

```typescript
type BrokerState =
  | 'disconnected'   // Initial state or after disconnect
  | 'connecting'     // Connection in progress
  | 'connected'      // Successfully connected
  | 'reconnecting'   // Retrying after failure
  | 'closed';        // Permanently closed
```

### BrokerStats

```typescript
interface BrokerStats {
  messagesPublished: number;    // Total published since start
  messagesProcessed: number;    // Total processed since start
  lastProcessedTime: number | null;  // Timestamp of last processed
}
```

---

## Error Types

### Connection Errors

- `Error: Connection refused` - RabbitMQ not reachable
- `Error: Invalid credentials` - Wrong username/password
- `Error: Max retries exceeded` - Connection failed after all retries

### Runtime Errors

- `Error: Channel closed` - Channel unexpectedly closed
- `Error: Not connected` - Tried to use before connected
- `Error: Exchange not declared` - Publishing to undeclared exchange
- `Error: Queue not declared` - Consuming from undeclared queue

---

## Importing from Submodules

Advanced usage - import specific modules:

```typescript
// Main exports
import { keepAlive, connect, connectOrFail } from '@devvir/rabbitmq';

// Types
import type { BrokerState, BrokerStats } from '@devvir/rabbitmq';

// Individual components (rare)
import { Broker } from '@devvir/rabbitmq/broker';
import { Queue } from '@devvir/rabbitmq/queue';
```

---

## Testing & Mocking

Mock broker for unit tests:

```typescript
import { vi } from 'vitest';

const mockBroker = {
  getState: () => 'connected',
  getStats: () => ({
    messagesPublished: 0,
    messagesProcessed: 0,
    lastProcessedTime: null,
  }),
  publish: vi.fn().mockResolvedValue(undefined),
  queue: vi.fn().mockReturnValue({
    consume: vi.fn().mockResolvedValue(() => Promise.resolve()),
    publish: vi.fn().mockResolvedValue(undefined),
    bind: vi.fn().mockResolvedValue(undefined),
  }),
  exchange: vi.fn().mockReturnValue({
    publish: vi.fn().mockResolvedValue(undefined),
  }),
  declares: vi.fn().mockResolvedValue(undefined),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  once: vi.fn(),
};
```
