// Minimal OpenAI-compatible mock provider used for local dev + e2e testing.
//
// Endpoints:
//   GET  /v1/models             -> { object: "list", data: [{ id: "mock-gpt", ... }] }
//   POST /v1/chat/completions   -> echoes the last user message back as
//                                  `MOCK-ECHO:<text>`, streamed (SSE) or not
//                                  depending on the request's `stream` flag.
//
// The `MOCK-ECHO:` prefix is the e2e assertion contract shared with
// integrations/e2e — do not change it without updating that test.

interface ChatMessage {
  role?: string;
  content?: string | Array<{ text?: string }>;
}

interface ChatCompletionRequest {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
}

const MODEL_LIST_BODY = {
  object: "list",
  data: [{ id: "mock-gpt", object: "model", owned_by: "mock" }],
};

const USAGE = { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 };

function extractLastUserText(messages: ChatMessage[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const { content } = message;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textPart = content.find((part) => typeof part?.text === "string");
      if (textPart?.text) return textPart.text;
    }
    return "";
  }
  return "";
}

function splitIntoThirds(text: string): [string, string, string] {
  const len = text.length;
  const cut1 = Math.ceil(len / 3);
  const cut2 = Math.ceil((len * 2) / 3);
  return [text.slice(0, cut1), text.slice(cut1, cut2), text.slice(cut2)];
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseEvent(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function handleChatCompletions(body: ChatCompletionRequest): Response {
  const model = body.model ?? "mock-gpt";
  const echoed = `MOCK-ECHO:${extractLastUserText(body.messages)}`;
  const id = `chatcmpl-mock-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    return jsonResponse({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: echoed },
          finish_reason: "stop",
        },
      ],
      usage: USAGE,
    });
  }

  const [part1, part2, part3] = splitIntoThirds(echoed);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const baseChunk = { id, object: "chat.completion.chunk", created, model };

      controller.enqueue(
        encoder.encode(
          sseEvent({
            ...baseChunk,
            choices: [{ index: 0, delta: { role: "assistant", content: part1 }, finish_reason: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseEvent({
            ...baseChunk,
            choices: [{ index: 0, delta: { content: part2 }, finish_reason: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseEvent({
            ...baseChunk,
            choices: [{ index: 0, delta: { content: part3 }, finish_reason: null }],
          }),
        ),
      );
      controller.enqueue(
        encoder.encode(
          sseEvent({
            ...baseChunk,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: USAGE,
          }),
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function parsePort(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error(`${label} must be an integer 1–65535`);
  return Number(value);
}

export function serve(port?: number): Bun.Server<undefined> {
  const resolvedPort = port ?? parsePort(process.env.MOCK_PORT, "MOCK_PORT") ?? 9999;
  return Bun.serve({
    // Bun defaults to 0.0.0.0 (LAN-exposed, unauthenticated echo API) when
    // no hostname is set. Default to loopback-only for a bare host process
    // (dev, e2e). A container's own loopback is isolated from Docker's
    // port-publish forwarding (which targets the container's bridge IP,
    // not 127.0.0.1), so infra/docker-compose.yml opts back into 0.0.0.0
    // via MOCK_HOST — safe there because the host-side publish is itself
    // scoped to 127.0.0.1.
    hostname: process.env.MOCK_HOST ?? "127.0.0.1",
    port: resolvedPort,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return jsonResponse(MODEL_LIST_BODY);
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body: ChatCompletionRequest;
        try {
          body = (await req.json()) as ChatCompletionRequest;
        } catch {
          return jsonResponse({ error: { message: "bad request" } }, 400);
        }
        return handleChatCompletions(body);
      }

      return jsonResponse({ error: { message: "not found" } }, 404);
    },
  });
}

if (import.meta.main) {
  const server = serve();
  console.log(`mock-provider listening on http://localhost:${server.port}`);
}
