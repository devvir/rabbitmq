# Consuming Messages

Set up message handlers with automatic deserialization, error handling, and acknowledgment.

## Basic Consuming

### Consume from a Queue

```typescript
type TradeMessage = {
  symbol: string;
  price: number;
  size: number;
  timestamp: string;
};

const queue = broker.queue('trade-archive');

await queue.consume(async (message: TradeMessage) => {
  console.log(`Trade: ${message.symbol} @ ${message.price}`);
});
```

The message is automatically deserialized from JSON. The consumer acknowledges (acks) the message after the handler completes.

### Stop Consuming

The `consume()` method returns a cancellation function:

```typescript
const cancel = await queue.consume(async (message: TradeMessage) => {
  console.log('Processing:', message);
});

// Later, stop consuming
await cancel();
```

## Prefetch and Flow Control

Control how many messages are processed concurrently:

```typescript
const queue = broker.queue('trades');

// Only process 10 messages at a time
await queue.consume(
  async (message: TradeMessage) => {
    await heavyProcessing(message);
  },
  { prefetch: 10 }
);
```

Lower prefetch = fewer messages in flight = less memory usage.
Higher prefetch = better throughput but more requirements.

Default is `1` (process one at a time).

## Error Handling

Messages are automatically requeued if the handler throws:

```typescript
const queue = broker.queue('orders');

await queue.consume(async (message: OrderMessage) => {
  try {
    await processOrder(message);
  } catch (error) {
    console.error('Order processing failed:', error);
    // Message is automatically requeued
    throw error;
  }
});
```

### Rejecting vs Requeuing

- **Throw error**: Message is requeued (goes back to queue)
- **Return/complete normally**: Message is acknowledged (removed)

Use this to implement dead-letter handling:

```typescript
const queue = broker.queue('tasks');
const dlx = broker.queue('dead-letters');

await queue.consume(async (message: TaskMessage) => {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      await processTask(message);
      return;  // Success, ack the message
    } catch (error) {
      attempts++;
      if (attempts >= maxAttempts) {
        // Send to dead-letter exchange
        await dlx.publish(message);
        return;  // Ack the original message
      }

      // Retry
      await delay(1000 * Math.pow(2, attempts));
      throw error;  // Requeue
    }
  }
});
```

## Type-safe Consuming

Use TypeScript generics for type-safe handlers:

```typescript
type TradeMessage = { symbol: string; price: number };
type QuoteMessage = { bid: number; ask: number };

const tradeQueue = broker.queue('trades');
const quoteQueue = broker.queue('quotes');

// Handler receives correct type
await tradeQueue.consume(async (trade: TradeMessage) => {
  console.log(trade.symbol, trade.price);  // Type-safe
});

await quoteQueue.consume(async (quote: QuoteMessage) => {
  console.log(quote.bid, quote.ask);  // Type-safe
});
```

## Processing Guarantees

### At-Least-Once Delivery

Default behavior: messages are requeued on failure, ensuring processing:

```typescript
await queue.consume(async (message) => {
  // If this fails, message goes back to queue
  await database.insert(message);
});
```

### At-Most-Once Delivery

Acknowledge immediately, fail silently:

```typescript
await queue.consume(async (message) => {
  // Message already acked, no requeue on failure
  try {
    await database.insert(message);
  } catch (error) {
    logger.error('Insert failed (message lost):', error);
  }
});
```

This is risky—messages that fail processing are lost.

## Monitoring and Logging

Track consumption metrics:

```typescript
const stats = broker.getStats();
console.log(`Processed ${stats.messagesProcessed} messages`);
console.log(`Last processed: ${stats.lastProcessedTime}`);

app.get('/health', (req, res) => {
  const { messagesProcessed, lastProcessedTime } = broker.getStats();
  res.json({
    messagesProcessed,
    lastProcessedTime,
    lag: Date.now() - lastProcessedTime,
  });
});
```

Log structured messages for debugging:

```typescript
await queue.consume(async (message: TradeMessage) => {
  const startTime = Date.now();

  try {
    await processMessage(message);

    logger.info('Message processed', {
      symbol: message.symbol,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    logger.error('Message processing failed', {
      symbol: message.symbol,
      error: error.message,
      duration: Date.now() - startTime,
    });
    throw error;
  }
});
```

## Request/Response Pattern

Handle RPC-style responses:

```typescript
type CreateUserRequest = { name: string; email: string };
type CreateUserResponse = { userId: string; success: boolean };

// Respond to create-user requests
const requestQueue = broker.queue('create-user-requests');

await requestQueue.consume(async (request: CreateUserRequest) => {
  try {
    const userId = await createUser(request);

    // Send response to reply-to queue
    const responseQueue = broker.queue(request.replyTo!);
    await responseQueue.publish<CreateUserResponse>(
      { userId, success: true },
      { correlationId: request.correlationId }
    );
  } catch (error) {
    const responseQueue = broker.queue(request.replyTo!);
    await responseQueue.publish<CreateUserResponse>(
      { userId: '', success: false },
      { correlationId: request.correlationId }
    );
  }
});
```

## Batch Processing

Process messages in batches for efficiency:

```typescript
const batch: TradeMessage[] = [];
const batchSize = 100;

const queue = broker.queue('trades');

await queue.consume(async (message: TradeMessage) => {
  batch.push(message);

  if (batch.length >= batchSize) {
    await flushBatch(batch);
    batch.length = 0;
  }
});

// Periodically flush remaining items
setInterval(async () => {
  if (batch.length > 0) {
    await flushBatch(batch);
    batch.length = 0;
  }
}, 5000);
```

## Filtered Consuming

Process only certain message types:

```typescript
type MessageEvent =
  | { type: 'trade'; symbol: string; price: number }
  | { type: 'quote'; bid: number; ask: number }
  | { type: 'order'; orderId: string };

const queue = broker.queue('events');

await queue.consume(async (event: MessageEvent) => {
  switch (event.type) {
    case 'trade':
      await processTrade(event);
      break;
    case 'quote':
      await processQuote(event);
      break;
    case 'order':
      await processOrder(event);
      break;
  }
});
```

## Graceful Shutdown

Stop consuming and close properly:

```typescript
const handlers: Array<() => Promise<void>> = [];

// List all consumers
const tradeCancel = await tradeQueue.consume(handler);
handlers.push(tradeCancel);

const quoteCancel = await quoteQueue.consume(handler);
handlers.push(quoteCancel);

// On shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');

  // Stop all consumers
  await Promise.all(handlers.map(cancel => cancel()));

  // Close broker
  await broker.close();

  console.log('Shutdown complete');
  process.exit(0);
});
```

## Real-world Example: Order Processing Pipeline

Complete example with multiple stages:

```typescript
type OrderRequest = { orderId: string; symbol: string; quantity: number; price: number };
type OrderValidated = { orderId: string; valid: boolean };
type OrderFilled = { orderId: string; executedPrice: number };

// Stage 1: Validate orders
const validateQueue = broker.queue('orders-to-validate');
await validateQueue.consume(async (order: OrderRequest) => {
  const valid = order.quantity > 0 && order.price > 0;

  await broker.publish<OrderValidated>(
    'order-events',
    valid ? 'order.valid' : 'order.invalid',
    { orderId: order.orderId, valid }
  );
});

// Stage 2: Execute valid orders
const executeQueue = broker.queue('orders-to-execute');
await executeQueue.consume(
  async (validation: OrderValidated) => {
    if (validation.valid) {
      const executedPrice = await getMarketPrice();

      await broker.publish<OrderFilled>(
        'order-events',
        'order.filled',
        { orderId: validation.orderId, executedPrice }
      );
    }
  },
  { prefetch: 5 }  // Process 5 at a time
);

// Stage 3: Archive filled orders
const archiveQueue = broker.queue('orders-to-archive');
await archiveQueue.consume(async (filled: OrderFilled) => {
  await database.archive(filled);
});
```
