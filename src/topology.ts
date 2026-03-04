// Pending Review
/**
 * Topology declaration and recovery for RabbitMQ.
 *
 * Responsible for asserting exchanges, queues, and bindings from a declarative
 * spec, and for restoring them (plus consumer registrations) after reconnection.
 */

import type { TopologySpec, QueueSpec, RawChannel } from './types';
import { Exchange } from './exchange';
import { Queue } from './queue';
import { createLogger } from './logger';

const logger = createLogger();

/** Reuse an existing Queue instance (preserving its consumer registrations) or create a new one. */
const reuseOrCreate = (
  queues: Map<string, Queue>,
  channel: RawChannel,
  name: string,
  spec: QueueSpec,
): Queue => {
  const existing = queues.get(name);
  if (existing) {
    existing.setChannel(channel);
    return existing;
  }
  return new Queue(channel, name, spec);
};

/**
 * Apply a topology spec to a channel, populating the given exchange/queue maps.
 * Existing map entries are overwritten (used on both first declaration and recovery).
 */
export const declareTopology = async (
  channel: RawChannel,
  spec: TopologySpec,
  exchanges: Map<string, Exchange>,
  queues: Map<string, Queue>,
): Promise<void> => {
  if (spec.exchanges) {
    for (const [exchangeName, exchangeSpec] of Object.entries(spec.exchanges)) {
      const exchange = new Exchange(channel, exchangeName, exchangeSpec);
      await exchange.assert();
      exchanges.set(exchangeName, exchange);

      if (exchangeSpec.queues) {
        for (const [queueName, queueSpec] of Object.entries(exchangeSpec.queues)) {
          const queue = reuseOrCreate(queues, channel, queueName, queueSpec);
          await queue.assert();

          const routingKeys = queueSpec.routingKey
            ? Array.isArray(queueSpec.routingKey)
              ? queueSpec.routingKey
              : [queueSpec.routingKey]
            : [queueName];

          for (const key of routingKeys) {
            await queue.bindToExchange(exchangeName, key);
          }

          queues.set(queueName, queue);
        }
      }
    }
  }

  if (spec.queues) {
    for (const [queueName, queueSpec] of Object.entries(spec.queues)) {
      const queue = reuseOrCreate(queues, channel, queueName, queueSpec);
      await queue.assert();
      queues.set(queueName, queue);
    }
  }

  if (spec.exchangeBindings) {
    for (const { source, destination, routingKey = '' } of spec.exchangeBindings) {
      await channel.bindExchange(destination, source, routingKey);
    }
  }
};

/**
 * After obtaining a new channel, update all Exchange/Queue instances,
 * re-declare topology, and re-register consumers.
 */
export const recoverTopology = async (
  channel: RawChannel,
  topologySpec: TopologySpec | null,
  exchanges: Map<string, Exchange>,
  queues: Map<string, Queue>,
): Promise<void> => {
  for (const exchange of exchanges.values()) exchange.setChannel(channel);

  // declareTopology reuses existing Queue instances (preserving their consumer registrations)
  if (topologySpec) {
    await declareTopology(channel, topologySpec, exchanges, queues);
  } else {
    for (const queue of queues.values()) queue.setChannel(channel);
  }

  for (const queue of queues.values()) {
    await queue.recoverConsumers();
    logger.info('Consumers recovered after channel drop', { queue: queue.getName() });
  }
};
