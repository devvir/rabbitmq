# Connection Management

The broker handles all RabbitMQ connection logic including retry strategies, state tracking, and lifecycle events.

## Connection States

The broker transitions through these states:

```
disconnected → connecting → connected ⟷ reconnecting → closed
```

Get the current state anytime:

```typescript
console.log(broker.getState());
// Returns: 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed'
```

## Creating a Connection

### With Unlimited Retries (Recommended for Services)

Automatically retry forever until RabbitMQ is available:

```typescript
import { keepAlive } from '@devvir/rabbitmq';

const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');
// Application won't start until RabbitMQ is reachable
```

### One-time Connection (Fails Immediately)

Connect once and fail if unsuccessful:

```typescript
import { connectOrFail } from '@devvir/rabbitmq';

try {
  const broker = await connectOrFail('amqp://guest:guest@rabbitmq:5672');
} catch (error) {
  console.error('Failed to connect to RabbitMQ:', error);
}
```

### Manual Connection with Custom Retries

Fine-grained control over retry behavior:

```typescript
import { connect } from '@devvir/rabbitmq';

const broker = connect('amqp://localhost', {
  maxRetries: 5,        // Stop after 5 attempts
  initialDelay: 1000,   // Wait 1 second before first retry
  maxDelay: 30000,      // Cap delay at 30 seconds
  backoffMultiplier: 2, // Double the delay each retry
});

// Wait for connection to establish
await broker.ensureConnected();
```

#### Retry Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `maxRetries` | number | `Infinity` | Maximum retry attempts |
| `initialDelay` | number | `1000` | Milliseconds before first retry |
| `maxDelay` | number | `30000` | Maximum milliseconds between retries |
| `backoffMultiplier` | number | `2` | Multiply delay by this after each retry |

**Example backoff sequence** (1s initial, 2x multiplier, 30s max):
- Attempt 1: immediate
- Attempt 2: 1s delay
- Attempt 3: 2s delay
- Attempt 4: 4s delay
- Attempt 5: 8s delay
- Attempt 6: 16s delay
- Attempt 7+: 30s delay (capped)

## Listening to Connection Events

Monitor broker lifecycle with events:

```typescript
const broker = keepAlive('amqp://localhost');

broker.on('connect', () => {
  console.log('RabbitMQ connected');
});

broker.on('disconnect', () => {
  console.log('RabbitMQ disconnected');
});

broker.on('reconnect', () => {
  console.log('Attempting to reconnect...');
});

broker.on('error', (error) => {
  console.error('Connection error:', error.message);
});

broker.on('closed', () => {
  console.log('Connection permanently closed');
});
```

### Event Timing

- **connect**: Connection to RabbitMQ established
- **disconnect**: Connection lost unexpectedly
- **reconnect**: Attempting to reconnect after disconnection
- **error**: Error occurred (connection issue, amqplib error, etc.)
- **closed**: `broker.close()` called or max retries exceeded

## Ensuring Connection Before Use

Always ensure the broker is connected before declaring topology or using queues:

```typescript
const broker = connect('amqp://localhost');

// Wait for connection
await broker.ensureConnected();

// Now safe to use
await broker.declares({ /* ... */ });
```

If connection fails and retries are exhausted, `ensureConnected()` rejects with an error.

## Closing the Connection

Explicitly close the broker when shutting down:

```typescript
await broker.close();
// broker.getState() === 'closed'
```

After closing, the broker cannot be reconnected. Create a new instance if needed.

## Connection URL Format

Standard AMQP URL format:

```
amqp://[username[:password]@]host[:port][/vhost]
```

### Examples

```typescript
// Local development (default credentials)
await keepAlive('amqp://guest:guest@localhost:5672/');

// With custom vhost
await keepAlive('amqp://myapp:secret@rabbitmq.example.com:5672/production');

// TLS/SSL
await keepAlive('amqps://myapp:secret@rabbitmq.example.com:5671/');
```

## Health Checking

The broker tracks message statistics for monitoring:

```typescript
const stats = broker.getStats();
console.log({
  messagesPublished: stats.messagesPublished,
  messagesProcessed: stats.messagesProcessed,
  lastProcessedTime: stats.lastProcessedTime,
});
```

Use these in health check endpoints:

```typescript
app.get('/health', (req, res) => {
  const isHealthy = broker.getState() === 'connected';
  const stats = broker.getStats();

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'ok' : 'degraded',
    ...stats,
  });
});
```

## Handling Disconnections

When RabbitMQ goes down, the broker automatically attempts to reconnect. In the meantime:

- Publishing attempts will queue and fail if connection not restored
- Consuming continues (messages are requeued)
- New declarations fail until reconnected

Monitor events and handle gracefully:

```typescript
broker.on('disconnect', () => {
  logger.warn('Lost RabbitMQ connection, retrying...');
});

broker.on('reconnect', () => {
  logger.info('Reconnected to RabbitMQ');
  // Optionally re-declare topology or notify services
});
```

## Testing

Mock the broker for unit tests:

```typescript
const mockBroker = {
  getState: () => 'connected',
  getStats: () => ({
    messagesPublished: 0,
    messagesProcessed: 0,
    lastProcessedTime: null,
  }),
  publish: vi.fn().mockResolvedValue(undefined),
  queue: vi.fn().mockReturnValue({
    consume: vi.fn(),
    bind: vi.fn(),
  }),
  declares: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
};
```
