# Backpressure

Backpressure lets a publisher or consumer pause automatically when downstream queues exceed a configured depth, preventing unbounded queue growth when consumers fall behind.

## How it works

When `waitIf` is passed to `publish()` or `consume()`, the library monitors the specified queues by polling the RabbitMQ management HTTP API. If any watched queue exceeds its threshold, publishing or message processing is paused until the queue drains back below 90% of the limit (the 10% hysteresis prevents flapping at the boundary). Polling runs in the background and does not block the hot publish path.

The guard is attached to the Exchange or Queue object on first use and reused on subsequent calls. It is stopped automatically when the broker disconnects.

## Configuration

```typescript
interface BackpressureOptions {
  waitIf?: Record<string, number>;  // queue name → max message count
  waitCheckInterval?: number;       // polling interval in seconds (default: 30)
}
```

`waitIf` is a map of queue names to maximum allowed ready + unacknowledged message counts. When any watched queue exceeds its limit, the operation blocks until all watched queues drop back below 90% of their respective limits.

`waitCheckInterval` controls how often queue depths are checked under normal conditions. When paused, the check interval drops to 3 seconds regardless of this setting.

## Usage

Pass `waitIf` as an option to any publish or consume call:

```typescript
// Pause publishing if the codec queue exceeds 100k messages
// or the journalist queue exceeds 10k messages
await exchange.publish(message, routingKey, {
  waitIf: {
    codec: 100_000,
    journalist: 10_000,
  },
});

// Same option works on broker.publish()
await broker.publish('my-exchange', message, routingKey, {
  waitIf: { codec: 100_000 },
});

// And on queue.consume() — pauses message processing
await queue.consume(async (msg, { ack }) => {
  await process(msg);
  ack();
}, {
  waitIf: { downstream: 50_000 },
});
```

The option works identically regardless of which publish or consume path you use.

## Management API requirement

Backpressure uses the RabbitMQ **management HTTP API** — not the AMQP connection — to check queue depths. The management plugin must be enabled on your RabbitMQ server.

The management URL is derived automatically from the AMQP connection URL:

| AMQP URL component | Management API |
|---|---|
| Hostname | Same hostname |
| Port | AMQP port + 10000 (e.g. `5672` → `15672`; no port → `15672`) |
| Scheme | `amqp:` → `http`; `amqps:` → `https` |
| Credentials | Username and password from the AMQP URL |

This means:
- `amqp://user:pass@rabbitmq:5672` → `http://rabbitmq:15672`
- `amqp://rabbitmq` → `http://rabbitmq:15672`
- `amqps://user:pass@rabbitmq:5671` → `https://rabbitmq:15671`

If your RabbitMQ management plugin runs on a non-standard port offset, you cannot use this feature directly — the URL derivation assumes the standard +10000 convention.

If the management API is unreachable (plugin disabled, wrong credentials, network error), the check fails, an error is logged, and the backpressure state is left unchanged — a failing check does not pause or resume publishing.

## Tuning

The default `waitCheckInterval` is 30 seconds. For high-throughput services publishing millions of messages, this means a queue could overfill significantly between checks. Lower it if you need tighter control:

```typescript
await exchange.publish(message, routingKey, {
  waitIf: { codec: 100_000 },
  waitCheckInterval: 5,  // check every 5 seconds
});
```

When paused, the interval is automatically reduced to 3 seconds to recover promptly.
