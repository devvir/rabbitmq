# @devvir/rabbitmq

A high-level TypeScript-first wrapper around [amqplib](https://github.com/squaremo/amqp.node) that makes RabbitMQ feel natural in Node.js applications.

## Purpose

This library abstracts away AMQP protocol complexity while maintaining flexibility for advanced use cases. It provides:

- **Developer Experience**: Intuitive, declarative API that feels natural in JavaScript/TypeScript
- **Type Safety**: Full TypeScript support with comprehensive type definitions  
- **Reliability**: Automatic connection management with configurable retry strategies
- **Simplicity**: Work with JS values (JSON serialization automatic)
- **Async-first**: All operations return Promises; connections block startup by default

## Philosophy

The library follows these core principles:

1. **JS values, not buffers** - Messages automatically serialize to/from JSON
2. **Connections are blocking** - Applications don't start until RabbitMQ is ready
3. **Topology is declarative** - Define your exchanges and queues upfront as a data structure
4. **Control is yours** - Access underlying amqplib APIs when you need them
5. **Events matter** - Connection lifecycle events for monitoring and error recovery

## Installation

```bash
npm install @devvir/rabbitmq
```

## Quick Start

### Connect with Automatic Retries

```typescript
import { keepAlive } from '@devvir/rabbitmq';

const broker = await keepAlive('amqp://guest:guest@rabbitmq:5672');
// Connected! Broker retried until successful
```

### Declare Topology and Publish

```typescript
// Define your message structure
type TradeEvent = {
  symbol: string;
  price: number;
  timestamp: string;
};

// Declare exchanges and queues
await broker.declares({
  exchanges: {
    'trades': {
      type: 'topic',
      durable: true,
      queues: {
        'trades-queue': {
          routingKey: 'trades.*',
          durable: true,
        },
      },
    },
  },
});

// Publish messages
const event: TradeEvent = {
  symbol: 'XBTUSD',
  price: 42500,
  timestamp: new Date().toISOString(),
};

await broker.publish('trades', 'trades.btc', event);
```

### Consume Messages

```typescript
const queue = broker.queue('trades-queue');

await queue.consume(async (message: TradeEvent) => {
  console.log(`${message.symbol} @ ${message.price}`);
});
```

## Key Concepts

**Broker** - Main entry point managing connection, channel, exchanges, and queues

**Topology** - Declaration of exchanges and queues (all at once before using)

**Publishing** - Send typed messages to exchanges with routing keys

**Consuming** - Listen to queues with automatic deserialization and error handling

## Documentation

- [Connection Management](./docs/connection.md) - Understanding broker lifecycle, retries, and state
- [Topology & Declarations](./docs/topology.md) - Defining exchanges, queues, bindings
- [Publishing Messages](./docs/publishing.md) - Sending typed messages with routing
- [Consuming Messages](./docs/consuming.md) - Setting up message handlers, error handling
- [API Reference](./docs/api.md) - Complete TypeScript interface documentation
- [Real-world Examples](./docs/examples.md) - Event streaming, RPC patterns, service integration

## Architecture

The library is organized as modular components:

- `connection.ts` - Low-level connection with retry logic
- `exchange.ts` - Exchange abstraction and publishing
- `queue.ts` - Queue abstraction and consuming  
- `broker.ts` - Main orchestrator coordinating all components
- `types.ts` - TypeScript type definitions
