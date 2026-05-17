import { RawChannel } from './types';

/**
 * Concurrent publish() callers that all hit backpressure on the same channel
 * join one shared wait — one drain listener, one onDraining notification pair —
 * instead of each registering their own.
 */
const sharedDrainWait = new WeakMap<RawChannel, Promise<void>>();

/**
 * Publishes a message and handles RabbitMQ backpressure.
 *
 * If publish() returns false, awaits the channel's next 'drain' before
 * returning. The drain listener is attached BEFORE publish() runs so a
 * drain emitted synchronously after publish() returns false isn't lost.
 *
 * Concurrent callers share one wait per channel. onDraining fires once when
 * the wait begins and once when it ends, regardless of how many callers join.
 */
export async function publishWithDrainControl(
  channel: RawChannel,
  publish: () => boolean,
  onDraining?: (draining: boolean) => void
): Promise<void> {
  const drainCapture = captureNextDrain(channel);

  if (publish()) {
    drainCapture.discard();
    return;
  }

  await joinSharedDrainWait(channel, drainCapture, onDraining);
}

/**
 * Pre-attaches a one-shot 'drain' listener so a drain emitted synchronously
 * during publish() is observed. The caller must either await `.promise` or
 * call `.discard()` to clean up.
 */
function captureNextDrain(channel: RawChannel): DrainCapture {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  channel.once('drain', resolve);

  return {
    promise,
    discard: () => channel.removeListener('drain', resolve),
  };
}

/**
 * Routes the caller into the channel's in-flight drain wait, or starts one if
 * absent. The first caller's capture powers the shared wait; later callers
 * discard their own and await the existing one.
 */
function joinSharedDrainWait(
  channel: RawChannel,
  capture: DrainCapture,
  onDraining?: (draining: boolean) => void
): Promise<void> {
  const existing = sharedDrainWait.get(channel);

  if (existing) {
    capture.discard();
    return existing;
  }

  onDraining?.(true);

  const wait = capture.promise.finally(() => {
    sharedDrainWait.delete(channel);
    onDraining?.(false);
  });

  sharedDrainWait.set(channel, wait);
  return wait;
}

interface DrainCapture {
  promise: Promise<void>;
  discard: () => void;
}
