import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider } from "@langfuse/tracing";

/**
 * Sends each reply's trace to Langfuse when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 * are set; otherwise tracing calls are no-ops. Uses its own tracer provider so it
 * stays separate from Spectrum's OpenTelemetry setup.
 */
let provider: NodeTracerProvider | undefined;

export function startTracing(): void {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.log("[langfuse] keys not set, tracing off");
    return;
  }

  // Nesting (Claude calls and tools under one reply) needs an async context manager.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  provider = new NodeTracerProvider({
    spanProcessors: [new LangfuseSpanProcessor({ environment: process.env.LANGFUSE_ENV ?? "production" })],
  });
  setLangfuseTracerProvider(provider);

  // Spectrum exits shortly after SIGTERM; push out whatever is still buffered.
  process.once("SIGTERM", () => void flushTracing());
  console.log("[langfuse] tracing on");
}

export async function flushTracing(): Promise<void> {
  await provider?.forceFlush().catch(() => {});
}
