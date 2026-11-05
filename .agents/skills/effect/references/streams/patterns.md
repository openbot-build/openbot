# Resource-safe sources

## Resource-safe sources and callbacks

A stream that owns a resource should acquire it *inside* the stream so the
resource is released on every exit path.

```ts import.meta.vitest name="references/streams/patterns.md#1"
import { Effect, Fiber, Queue, Stream } from "effect"

interface Socket {
  onMessage(cb: (message: string) => void): () => void
}

// `Stream.callback` hands you a Queue; offer into it from the foreign callback.
// The effect's Scope closes when the stream ends or is interrupted, so the
// finalizer in acquireRelease unregisters the listener on every exit path.
const messages = (socket: Socket) =>
  Stream.callback<string>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => socket.onMessage((message) => Queue.offerUnsafe(queue, message))),
      (unsubscribe) => Effect.sync(unsubscribe)
    ), { bufferSize: 64, strategy: "dropping" })
// bufferSize + strategy decide what happens when the consumer is slower than the
// socket: "suspend" would block a callback that cannot block, so choose
// "dropping" or "sliding" for lossy feeds and size the buffer on purpose.

// A real in-memory socket: listeners in a Set, and a way to push messages in.
const listeners = new Set<(message: string) => void>()
const socket: Socket = {
  onMessage: (cb) => {
    listeners.add(cb)
    return () => void listeners.delete(cb)
  }
}
const emit = (message: string) => listeners.forEach((cb) => cb(message))

const received = await Effect.runPromise(Effect.gen(function*() {
  const fiber = yield* messages(socket).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
  // Wait until the stream has subscribed, then push two messages.
  while (listeners.size === 0) yield* Effect.sleep("1 millis")
  emit("a")
  emit("b")
  return yield* Fiber.join(fiber)
}))
received // => ["a", "b"]

// take(2) ended the stream, the Scope closed, and the finalizer unsubscribed.
listeners.size // => 0
```
