# Real-world Examples

Complete, working examples for common patterns.

## Example 1: Event Streaming System

A multi-stage event processing pipeline:

```typescript
import { keepAlive } from '@devvir/rabbitmq';

type TradeEvent = {
  symbol: string;
  price: number;
  size: number;
  timestamp: string;
};

type PriceAlert = {
  symbol: string;
  price: number;
  threshold: number;
};

// Connect with retries
const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

// Declare topology
await broker.declares({
  exchanges: {
    'market-data': {
      type: 'topic',
      durable: true,
      queues: {
        'trade-archive': {
          routingKey: 'trade.*',
          durable: true,
          arguments: { 'x-queue-mode': 'lazy' },
        },
        'price-processor': {
          routingKey: 'trade.#',
          durable: true,
        },
      },
    },
  },
});

// Source: Publish market data
setInterval(async () => {
  const event: TradeEvent = {
    symbol: 'XBTUSD',
    price: 42000 + Math.random() * 1000,
    size: Math.floor(Math.random() * 100),
    timestamp: new Date().toISOString(),
  };

  await broker.publish('market-data', `trade.${event.symbol.toLowerCase()}`, event);
}, 1000);

// Stage 1: Archive all trades
broker.queue('trade-archive').consume(async (trade: TradeEvent) => {
  console.log(`📊 Archiving: ${trade.symbol} @ ${trade.price.toFixed(2)}`);
  // await database.insert(trade);
});

// Stage 2: Detect price alerts
broker.queue('price-processor').consume(async (trade: TradeEvent) => {
  const threshold = 42500;

  if (trade.price > threshold) {
    const alert: PriceAlert = {
      symbol: trade.symbol,
      price: trade.price,
      threshold,
    };

    await broker.publish('market-data', 'alert.price', alert);
  }
});

// Monitor
setInterval(() => {
  const { messagesPublished, messagesProcessed } = broker.getStats();
  console.log(`
    Published: ${messagesPublished}
    Processed: ${messagesProcessed}
  `);
}, 5000);
```

## Example 2: RPC Request/Response

Synchronous-style request-response pattern:

```typescript
import { keepAlive } from '@devvir/rabbitmq';
import { randomUUID } from 'node:crypto';

type UserCreateRequest = { name: string; email: string };
type UserCreateResponse = { userId: string; success: boolean };

const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

await broker.declares({
  queues: {
    'rpc.user-service.requests': { durable: true },
    'rpc.user-service.responses': { durable: true },
  },
});

// Client side: Call a remote service
async function createUserRPC(name: string, email: string): Promise<string> {
  const correlationId = randomUUID();
  const responseQueue = broker.queue('rpc.user-service.responses');

  // Send request
  await broker.publish<UserCreateRequest>(
    'rpc.user-service.requests',
    'create',
    { name, email },
    {
      replyTo: 'rpc.user-service.responses',
      correlationId,
      expiration: '30000',  // 30 second timeout
    }
  );

  // Wait for response
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('RPC timeout after 30 seconds'));
    }, 30000);

    let listener: ((msg: UserCreateResponse) => void) | null = null;

    listener = async (response: UserCreateResponse) => {
      if (response.correlationId === correlationId) {
        clearTimeout(timeout);
        resolve(response.userId);
      }
    };

    // Very basic - in reality use a proper request/response helper
    responseQueue.consume(listener);
  });
}

// Server side: Handle requests
broker.queue('rpc.user-service.requests').consume(async (request: UserCreateRequest) => {
  try {
    const userId = randomUUID();
    console.log(`Creating user: ${request.name} (${request.email})`);

    // Simulate user creation
    await new Promise(resolve => setTimeout(resolve, 100));

    const response: UserCreateResponse = {
      userId,
      success: true,
    };

    const responseQueue = broker.queue(request.replyTo!);
    await responseQueue.publish(response, {
      correlationId: request.correlationId,
    });
  } catch (error) {
    const responseQueue = broker.queue(request.replyTo!);
    await responseQueue.publish<UserCreateResponse>(
      { userId: '', success: false },
      { correlationId: request.correlationId }
    );
  }
});

// Test the RPC
console.log('User ID:', await createUserRPC('Alice', 'alice@example.com'));
```

## Example 3: Service Integration

Multiple microservices communicating via RabbitMQ:

```typescript
// === Order Service ===
const orderBroker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

await orderBroker.declares({
  exchanges: {
    'orders': {
      type: 'direct',
      queues: {
        'payment-processor': {
          routingKey: 'order.created',
          durable: true,
        },
      },
    },
  },
});

type OrderCreatedEvent = { orderId: string; amount: number; customerId: string };

// Publish new orders
async function createOrder(customerId: string, amount: number) {
  const orderId = randomUUID();

  await orderBroker.publish<OrderCreatedEvent>(
    'orders',
    'order.created',
    { orderId, customerId, amount }
  );

  return orderId;
}

// === Payment Service ===
const paymentBroker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

await paymentBroker.declares({
  exchanges: {
    'orders': {
      type: 'direct',
      queues: {
        'process-payments': {
          routingKey: 'order.created',
          durable: true,
        },
      },
    },
    'payments': {
      type: 'direct',
      queues: {
        'notification-service': {
          routingKey: 'payment.completed',
          durable: true,
        },
      },
    },
  },
});

type PaymentCompletedEvent = { orderId: string; customerId: string; status: 'success' | 'failed' };

paymentBroker.queue('process-payments').consume(async (event: OrderCreatedEvent) => {
  console.log(`Processing payment for order ${event.orderId} ($${event.amount})`);

  // Simulate payment processing
  await new Promise(resolve => setTimeout(resolve, 500));

  const status: 'success' | 'failed' = Math.random() > 0.1 ? 'success' : 'failed';

  await paymentBroker.publish<PaymentCompletedEvent>(
    'payments',
    'payment.completed',
    { orderId: event.orderId, customerId: event.customerId, status }
  );
});

// === Notification Service ===
const notificationBroker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

await notificationBroker.declares({
  exchanges: {
    'payments': {
      type: 'direct',
      queues: {
        'send-emails': {
          routingKey: 'payment.completed',
          durable: false,  // Notifications are ephemeral
        },
      },
    },
  },
});

notificationBroker.queue('send-emails').consume(async (event: PaymentCompletedEvent) => {
  const message = event.status === 'success'
    ? '✅ Your payment was processed successfully'
    : '❌ Your payment failed. Please try again.';

  console.log(`📧 Email to customer ${event.customerId}: ${message}`);
});

// Test the system
const orderId = await createOrder('CUST-123', 99.99);
console.log('Created order:', orderId);
```

## Example 4: Fan-out Broadcasting

Send one message to multiple consumers:

```typescript
type SystemAlert = {
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: string;
};

const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

await broker.declares({
  exchanges: {
    'system-alerts': {
      type: 'fanout',
      durable: true,
      queues: {
        'email-alerts': { routingKey: '' },
        'slack-alerts': { routingKey: '' },
        'sms-alerts': { routingKey: '' },
        'logs': { routingKey: '' },
      },
    },
  },
});

// Publish to all consumers at once
async function broadcastAlert(level: string, message: string) {
  await broker.publish<SystemAlert>(
    'system-alerts',
    '',  // Ignored in fanout
    { level, message, timestamp: new Date().toISOString() }
  );
}

// Email handler
broker.queue('email-alerts').consume(async (alert: SystemAlert) => {
  console.log(`📧 Email alert [${alert.level}]: ${alert.message}`);
});

// Slack handler
broker.queue('slack-alerts').consume(async (alert: SystemAlert) => {
  console.log(`💬 Slack alert [${alert.level}]: ${alert.message}`);
});

// SMS handler (only for errors)
broker.queue('sms-alerts').consume(async (alert: SystemAlert) => {
  if (alert.level === 'error') {
    console.log(`📱 SMS alert [${alert.level}]: ${alert.message}`);
  }
});

// Test
await broadcastAlert('info', 'System maintenance scheduled for 2am');
await broadcastAlert('error', 'Database connection lost');
```

## Example 5: Graceful Shutdown

Proper cleanup and shutdown handling:

```typescript
import { keepAlive } from '@devvir/rabbitmq';

const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

// Track all consumers
const consumers: Array<() => Promise<void>> = [];

await broker.declares({
  queues: {
    'task-queue': { durable: true },
  },
});

// Set up handler
const cancel = await broker.queue('task-queue').consume(async (message) => {
  console.log('Processing:', message);
  await new Promise(resolve => setTimeout(resolve, 1000));
});

consumers.push(cancel);

// Listen for shutdown signals
async function shutdown() {
  console.log('\n🛑 Shutting down gracefully...');

  // Stop accepting new messages
  console.log('Stopping consumers...');
  await Promise.all(consumers.map(cancel => cancel()));
  console.log('Consumers stopped');

  // Close broker
  console.log('Closing broker...');
  await broker.close();
  console.log('Broker closed');

  console.log('✅ Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log('Running... Press Ctrl+C to shutdown');
```

## Example 6: Batch Messages with Periodic Flush

Process messages in batches for efficiency:

```typescript
const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');

type LogEntry = { timestamp: string; level: string; message: string };

const batch: LogEntry[] = [];
const batchSize = 100;
const flushInterval = 5000;  // 5 seconds

await broker.declares({
  queues: {
    'log-queue': { durable: true },
  },
});

async function flushLogs() {
  if (batch.length === 0) return;

  console.log(`💾 Flushing ${batch.length} logs to database`);
  // await database.insertMany(batch);

  batch.length = 0;
}

// Consume logs
broker.queue('log-queue').consume(async (log: LogEntry) => {
  batch.push(log);

  // Flush when batch is full
  if (batch.length >= batchSize) {
    await flushLogs();
  }
});

// Periodic flush
setInterval(flushLogs, flushInterval);

// Test
setInterval(() => {
  const log: LogEntry = {
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'Application running normally',
  };

  broker.publish('log-queue', '', log);
}, 100);
```
