# Topology & Declarations

Topology is the configuration of exchanges and queues. Declare it once after connecting, then use it throughout your application.

## The Declares Pattern

All exchanges and queues must be declared upfront using `broker.declares()`:

```typescript
await broker.declares({
  exchanges: {
    'events': {
      type: 'topic',
      durable: true,
      queues: {
        'events-queue': {
          routingKey: 'events.*',
          durable: true,
        },
      },
    },
  },
  queues: {
    'standalone-queue': {
      durable: true,
    },
  },
});
```

This is idempotent—declaring the same topology multiple times is safe.

## Exchanges

### Exchange Types

| Type | Purpose | Example |
|------|---------|---------|
| **direct** | Route by exact key | Commands, RPC requests |
| **topic** | Route by pattern | Events with wildcards |
| **fanout** | Broadcast to all | Notifications |
| **headers** | Route by message headers | Advanced routing |

### Direct Exchange (Point-to-Point)

Exact key matching. Each queue binds to one routing key:

```typescript
await broker.declares({
  exchanges: {
    'commands': {
      type: 'direct',
      durable: true,
      queues: {
        'execute-queue': {
          routingKey: 'execute.user.create',
        },
        'delete-queue': {
          routingKey: 'execute.user.delete',
        },
      },
    },
  },
});

// Publish to exact routing key
await broker.publish('commands', 'execute.user.create', { userId: 123 });
```

### Topic Exchange (Pattern Matching)

Wildcard routing with `*` (one level) and `#` (multiple levels):

```typescript
await broker.declares({
  exchanges: {
    'events': {
      type: 'topic',
      durable: true,
      queues: {
        'trades-all': {
          routingKey: 'trade.*',      // Matches: trade.btc, trade.eth, etc.
        },
        'prices-global': {
          routingKey: '*.price.#',    // Matches: btc.price.usd, eth.price.gbp, etc.
        },
        'all-events': {
          routingKey: '#',            // Matches everything
        },
      },
    },
  },
});

// Publish with routing keys
await broker.publish('events', 'trade.btc', { price: 42500 });
await broker.publish('events', 'trade.eth', { price: 2200 });
```

### Fanout Exchange (Broadcast)

Routes to all bound queues regardless of routing key:

```typescript
await broker.declares({
  exchanges: {
    'notifications': {
      type: 'fanout',
      durable: false,  // Often non-durable for notifications
      queues: {
        'email-queue': { routingKey: '' },
        'slack-queue': { routingKey: '' },
        'sms-queue': { routingKey: '' },
      },
    },
  },
});

// All three queues receive this message
await broker.publish('notifications', 'any.key', { alert: 'System maintenance' });
```

## Queues

### Queue Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `routingKey` | string | - | Key for binding to exchange |
| `durable` | boolean | `false` | Survives broker restart |
| `exclusive` | boolean | `false` | Only accessible to connection |
| `autoDelete` | boolean | `false` | Delete when last consumer disconnects |
| `arguments` | object | - | Advanced queue settings (TTL, DLX, etc.) |

### Durable vs Non-durable

**Durable queues** persist after broker restart:

```typescript
await broker.declares({
  exchanges: {
    'trades': {
      type: 'topic',
      durable: true,
      queues: {
        'archive-queue': {
          routingKey: 'trade.*',
          durable: true,              // Messages persist
        },
      },
    },
  },
});
```

**Non-durable queues** exist only while the broker is running:

```typescript
{
  'ephemeral-queue': {
    routingKey: '#',
    durable: false,                   // Lost on restart
  }
}
```

### Standalone Queues

Queues not bound to exchanges:

```typescript
await broker.declares({
  queues: {
    'direct-insert': {
      durable: true,
    },
    'task-queue': {
      durable: true,
    },
  },
});

// Access via broker.queue()
const queue = broker.queue('direct-insert');
```

## Dead Letter Exchanges

Configure a Dead Letter Exchange (DLX) to handle rejected messages:

```typescript
await broker.declares({
  exchanges: {
    'dlx': {
      type: 'direct',
      queues: {
        'dead-letters': {
          routingKey: 'dead',
        },
      },
    },
    'main': {
      type: 'topic',
      durable: true,
      queues: {
        'process-queue': {
          routingKey: 'events.*',
          durable: true,
          arguments: {
            'x-dead-letter-exchange': 'dlx',
            'x-dead-letter-routing-key': 'dead',
          },
        },
      },
    },
  },
});
```

When messages are rejected in consumers, they go to the DLX instead of being requeued.

## Message TTL (Time to Live)

Expire messages after a duration:

```typescript
{
  'ephemeral-queue': {
    routingKey: 'temp.*',
    durable: true,
    arguments: {
      'x-message-ttl': 60000,  // Expire after 60 seconds
    },
  }
}
```

## Maximum Length

Limit queue size:

```typescript
{
  'bounded-queue': {
    routingKey: 'events.*',
    arguments: {
      'x-max-length': 100000,  // Drop oldest when exceeds 100k
    },
  }
}
```

## Lazy Queues

Optimize for large queues by paging messages to disk:

```typescript
{
  'large-queue': {
    routingKey: 'events.*',
    durable: true,
    arguments: {
      'x-queue-mode': 'lazy',  // Pages to disk
    },
  }
}
```

## Practical Example: Event Streaming

Complete topology for an event-driven system:

```typescript
type TradeEvent = { symbol: string; price: number; timestamp: string };
type PriceAlert = { symbol: string; threshold: number };

await broker.declares({
  exchanges: {
    // Primary event stream
    'bitmex-feed': {
      type: 'topic',
      durable: true,
      queues: {
        // Archive all trades
        'trade-archive': {
          routingKey: 'trade.*',
          durable: true,
          arguments: { 'x-queue-mode': 'lazy' },
        },
        // Real-time processing
        'trade-processor': {
          routingKey: 'trade.#',
          durable: true,
          arguments: { 'x-message-ttl': 300000 },  // 5 min TTL
        },
        // Alerts only
        'price-alerts': {
          routingKey: 'trade.*.alert',
          durable: false,
        },
      },
    },
    // Dead letter handling
    'dlx': {
      type: 'direct',
      queues: {
        'dead-letters': {
          routingKey: 'dead',
          durable: true,
        },
      },
    },
  },
});

// Publish
await broker.publish<TradeEvent>(
  'bitmex-feed',
  'trade.btc',
  { symbol: 'XBTUSD', price: 42500, timestamp: new Date().toISOString() }
);
```

## Re-declaring Topology

Safe to call multiple times:

```typescript
// Call this on startup, in migrations, or when topology changes
await broker.declares(topology);

// Idempotent - doesn't error if already declared
// Can be called multiple times without issues
await broker.declares(topology); // Safe!
```

## Accessing Declared Exchanges and Queues

After declaring, access them by name:

```typescript
// Get queue reference
const queue = broker.queue('trade-archive');

// Get exchange reference
const exchange = broker.exchange('bitmex-feed');

// Publish to exchange
await exchange.publish('trade.btc', data);

// Consume from queue
await queue.consume(async (message) => {
  console.log('Received:', message);
});
```
