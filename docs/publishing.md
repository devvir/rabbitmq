# Publishing Messages

Send typed messages to exchanges and queues with automatic serialization.

## Basic Publishing

### To an Exchange

```typescript
type TradeMessage = {
  symbol: string;
  price: number;
  size: number;
  timestamp: string;
};

const message: TradeMessage = {
  symbol: 'XBTUSD',
  price: 42500,
  size: 1000,
  timestamp: new Date().toISOString(),
};

await broker.publish<TradeMessage>(
  'trades',           // Exchange name
  'trade.btc',        // Routing key
  message             // Message body
);
```

The message is automatically serialized to JSON and sent.

### To a Queue

Avoid exchanges for direct queue insertion:

```typescript
const queue = broker.queue('task-queue');
await queue.publish(message);
```

## Publishing Options

Control message behavior with options:

```typescript
await broker.publish<TradeMessage>(
  'trades',
  'trade.btc',
  message,
  {
    persistent: true,      // Survive broker restart
    contentType: 'application/json',
    contentEncoding: 'utf-8',
    expiration: '60000',   // Expire after 60 seconds
    priority: 5,           // 0-10, higher = more urgent
    correlationId: 'msg-123',
    replyTo: 'response-queue',
  }
);
```

### Common Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `persistent` | boolean | `true` | Message survives broker restart |
| `contentType` | string | `'application/json'` | MIME type |
| `contentEncoding` | string | `'utf-8'` | Encoding |
| `priority` | number | - | 0-10, higher first |
| `expiration` | string | - | Milliseconds as string |
| `correlationId` | string | - | Link request/response |
| `replyTo` | string | - | Queue for response |
| `messageId` | string | - | Unique message ID |
| `timestamp` | number | - | Unix timestamp |

## Request/Response Pattern

Implement RPC-style request-response:

```typescript
type UserCreateRequest = { name: string; email: string };
type UserCreateResponse = { userId: string; success: boolean };

// Requester
const correlationId = crypto.randomUUID();
const queue = broker.queue('user-create-response');

await broker.publish<UserCreateRequest>(
  'commands',
  'user.create',
  { name: 'Alice', email: 'alice@example.com' },
  {
    replyTo: 'user-create-response',
    correlationId: correlationId,
    expiration: '30000',  // Timeout after 30 seconds
  }
);

// Wait for response
await queue.consume(async (response: UserCreateResponse) => {
  if (response.correlationId === correlationId) {
    console.log('User created:', response.userId);
  }
});

// Responder
const commandQueue = broker.queue('user-create-commands');
await commandQueue.consume(async (request: UserCreateRequest) => {
  const userId = await createUser(request);

  const responseQueue = broker.queue(request.replyTo!);
  await responseQueue.publish(
    { userId, success: true },
    { correlationId: request.correlationId }
  );
});
```

## Batch Publishing

Publish multiple messages efficiently:

```typescript
const messages: TradeMessage[] = [
  { symbol: 'XBTUSD', price: 42500, size: 100, timestamp: new Date().toISOString() },
  { symbol: 'ETHUSD', price: 2200, size: 50, timestamp: new Date().toISOString() },
  { symbol: 'LINKUSD', price: 28.5, size: 1000, timestamp: new Date().toISOString() },
];

// Parallel publishing
await Promise.all(
  messages.map(msg =>
    broker.publish('trades', `trade.${msg.symbol.toLowerCase()}`, msg)
  )
);
```

For guaranteed order, publish sequentially:

```typescript
for (const message of messages) {
  await broker.publish('trades', `trade.${message.symbol}`, message);
}
```

## Error Handling

Publishing can fail if not connected or if RabbitMQ rejects the message:

```typescript
try {
  await broker.publish('trades', 'trade.btc', message);
} catch (error) {
  logger.error('Failed to publish message:', error);

  // Retry with backoff
  await retry(() => broker.publish('trades', 'trade.btc', message), {
    maxRetries: 3,
    delayMs: 1000,
  });
}
```

### Connection Not Ready

Ensure connection before publishing:

```typescript
await broker.ensureConnected();
await broker.publish('trades', 'trade.btc', message);
```

### Message Too Large

RabbitMQ has a default message size limit (128MB). For large messages, consider:

1. **Compress**: Gzip the payload
2. **Reference**: Store in S3/database, publish reference
3. **Split**: Break into smaller chunks

```typescript
import zlib from 'node:zlib';

const compressed = zlib.gzipSync(JSON.stringify(largeMessage));
await broker.publish('trades', 'trade.large', { compressed }, {
  contentEncoding: 'gzip',
});
```

## Monitoring Publishing

Track publishing metrics:

```typescript
const stats = broker.getStats();
console.log(`Published ${stats.messagesPublished} messages`);

// Use in health checks
app.get('/health', (req, res) => {
  const { messagesPublished } = broker.getStats();
  res.json({ messagesPublished });
});
```

## Type Safety

Leverage TypeScript for type-safe publishing:

```typescript
type TradeMessage = {
  symbol: string;
  price: number;
};

type QuoteMessage = {
  bid: number;
  ask: number;
};

// TypeScript ensures correct message type per topic
await broker.publish<TradeMessage>('trades', 'trade.btc', { symbol: 'XBTUSD', price: 42500 });
await broker.publish<QuoteMessage>('quotes', 'quote.btc', { bid: 42500, ask: 42501 });
```

## Real-world Example: Order Processing

Complete example of publishing orders through a pipeline:

```typescript
type NewOrder = { orderId: string; symbol: string; quantity: number; price: number };
type OrderValidated = { orderId: string; valid: boolean; reason?: string };
type OrderFilled = { orderId: string; executedPrice: number; executedSize: number };

// Send order for validation
const orderId = crypto.randomUUID();
await broker.publish<NewOrder>(
  'orders',
  'order.new',
  {
    orderId,
    symbol: 'XBTUSD',
    quantity: 10,
    price: 42500,
  },
  {
    persistent: true,
    priority: 8,  // High priority
    correlationId: orderId,
  }
);

// Validation service listens
const validationQueue = broker.queue('order-validation');
await validationQueue.consume(async (order: NewOrder) => {
  const valid = order.quantity > 0 && order.price > 0;

  await broker.publish<OrderValidated>(
    'orders',
    'order.validated',
    {
      orderId: order.orderId,
      valid,
      reason: valid ? undefined : 'Invalid order parameters',
    },
    { correlationId: order.orderId }
  );
});

// Execution service listens
const executionQueue = broker.queue('order-execution');
await executionQueue.consume(async (validatedOrder: OrderValidated) => {
  if (validatedOrder.valid) {
    const executedPrice = 42505;
    const executedSize = 10;

    await broker.publish<OrderFilled>(
      'orders',
      'order.filled',
      {
        orderId: validatedOrder.orderId,
        executedPrice,
        executedSize,
      },
      { correlationId: validatedOrder.orderId }
    );
  }
});
```
