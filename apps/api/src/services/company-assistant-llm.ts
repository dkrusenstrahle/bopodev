import { resolveDirectApiCredentials, type DirectApiProvider } from "bopodev-agent-sdk";

export type AssistantToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AssistantChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string };

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_OPENAI_MODEL = "gpt-4.1";

export function resolveAssistantProvider(): DirectApiProvider {
  const raw = process.env.BOPO_ASSISTANT_PROVIDER?.trim().toLowerCase();
  if (raw === "openai_api") {
    return "openai_api";
  }
  return "anthropic_api";
}

export function resolveAssistantModel(provider: DirectApiProvider): string {
  const override = process.env.BOPO_ASSISTANT_MODEL?.trim();
  if (override) {
    return override;
  }
  return provider === "openai_api" ? DEFAULT_OPENAI_MODEL : DEFAULT_ANTHROPIC_MODEL;
}

function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicContentBlock[] | string };

export async function runAssistantWithToolsAnthropic(input: {
  system: string;
  messages: AnthropicMessage[];
  tools: AssistantToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxToolRounds: number;
  timeoutMs: number;
}): Promise<{ text: string; toolRoundCount: number }> {
  const provider: DirectApiProvider = "anthropic_api";
  const { key, baseUrl } = resolveDirectApiCredentials(provider, undefined);
  if (!key) {
    throw new Error("Missing API key for anthropic_api (ANTHROPIC_API_KEY or BOPO_ANTHROPIC_API_KEY).");
  }
  const model = resolveAssistantModel(provider);
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/v1/messages`;
  let toolRoundCount = 0;
  const conversation: AnthropicMessage[] = [...input.messages];

  for (let round = 0; round < input.maxToolRounds + 1; round += 1) {
    const body = {
      model,
      max_tokens: 8192,
      system: input.system,
      tools: input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      })),
      messages: conversation
    };

    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify(body)
      },
      input.timeoutMs
    );

    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const err = typeof raw.error === "object" && raw.error && "message" in raw.error
        ? String((raw.error as { message?: string }).message)
        : JSON.stringify(raw);
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    const stopReason = String(raw.stop_reason ?? "");
    const contentBlocks = (Array.isArray(raw.content) ? raw.content : []) as AnthropicContentBlock[];

    conversation.push({ role: "assistant", content: contentBlocks });

    if (stopReason !== "tool_use") {
      const textParts = contentBlocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
      return { text: textParts.join("\n").trim() || "(No text response.)", toolRoundCount };
    }

    const toolUses = contentBlocks.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>;

    if (toolUses.length === 0) {
      const textParts = contentBlocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text);
      return { text: textParts.join("\n").trim() || "(No text response.)", toolRoundCount };
    }

    toolRoundCount += 1;
    if (toolRoundCount > input.maxToolRounds) {
      return {
        text: "I hit the tool-call limit for this question. Try a narrower question or break it into steps.",
        toolRoundCount
      };
    }

    const toolResultBlocks: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
    for (const tu of toolUses) {
      let output: string;
      try {
        output = await input.executeTool(tu.name, tu.input ?? {});
      } catch (e) {
        output = JSON.stringify({ error: String(e) });
      }
      toolResultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: output
      });
    }

    conversation.push({
      role: "user",
      content: toolResultBlocks as unknown as AnthropicContentBlock[]
    });
  }

  return { text: "Unable to complete the response.", toolRoundCount };
}

type OpenAIToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export async function runAssistantWithToolsOpenAI(input: {
  system: string;
  messages: Array<{ role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string }>;
  tools: AssistantToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxToolRounds: number;
  timeoutMs: number;
}): Promise<{ text: string; toolRoundCount: number }> {
  const provider: DirectApiProvider = "openai_api";
  const { key, baseUrl } = resolveDirectApiCredentials(provider, undefined);
  if (!key) {
    throw new Error("Missing API key for openai_api (OPENAI_API_KEY or BOPO_OPENAI_API_KEY).");
  }
  const model = resolveAssistantModel(provider);
  const endpoint = `${String(baseUrl).replace(/\/$/, "")}/v1/chat/completions`;
  let toolRoundCount = 0;
  const messages: Array<Record<string, unknown>> = [{ role: "system", content: input.system }, ...input.messages];

  const openaiTools = input.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema
    }
  }));

  for (let round = 0; round < input.maxToolRounds + 1; round += 1) {
    const response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`
        },
        body: JSON.stringify({
          model,
          messages,
          tools: openaiTools,
          tool_choice: "auto"
        })
      },
      input.timeoutMs
    );

    const raw = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const err =
        typeof raw.error === "object" && raw.error && "message" in (raw.error as object)
          ? String((raw.error as { message?: string }).message)
          : JSON.stringify(raw);
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const choice = (Array.isArray(raw.choices) ? raw.choices[0] : null) as Record<string, unknown> | null;
    const msg = choice?.message as Record<string, unknown> | undefined;
    const toolCalls = (msg?.tool_calls as OpenAIToolCall[] | undefined) ?? [];
    const content = typeof msg?.content === "string" ? msg.content : "";

    messages.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined
    });

    if (toolCalls.length === 0) {
      return { text: content.trim() || "(No text response.)", toolRoundCount };
    }

    toolRoundCount += 1;
    if (toolRoundCount > input.maxToolRounds) {
      return {
        text: "I hit the tool-call limit for this question. Try a narrower question or break it into steps.",
        toolRoundCount
      };
    }

    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        args = {};
      }
      let output: string;
      try {
        output = await input.executeTool(call.function.name, args);
      } catch (e) {
        output = JSON.stringify({ error: String(e) });
      }
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output
      });
    }
  }

  return { text: "Unable to complete the response.", toolRoundCount };
}

export async function runAssistantWithTools(input: {
  provider: DirectApiProvider;
  system: string;
  chatHistory: AssistantChatMessage[];
  tools: AssistantToolDefinition[];
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxToolRounds: number;
  timeoutMs: number;
}): Promise<{ text: string; toolRoundCount: number }> {
  if (input.provider === "openai_api") {
    const openaiMessages: Array<{ role: "user" | "assistant" | "tool"; content: string; tool_call_id?: string }> = [];
    for (const m of input.chatHistory) {
      if (m.role === "user") {
        openaiMessages.push({ role: "user", content: m.content });
      } else {
        openaiMessages.push({ role: "assistant", content: m.content });
      }
    }
    return runAssistantWithToolsOpenAI({
      system: input.system,
      messages: openaiMessages,
      tools: input.tools,
      executeTool: input.executeTool,
      maxToolRounds: input.maxToolRounds,
      timeoutMs: input.timeoutMs
    });
  }

  const anthropicMessages: AnthropicMessage[] = input.chatHistory.map((m) => ({
    role: m.role,
    content: m.content
  }));

  return runAssistantWithToolsAnthropic({
    system: input.system,
    messages: anthropicMessages,
    tools: input.tools,
    executeTool: input.executeTool,
    maxToolRounds: input.maxToolRounds,
    timeoutMs: input.timeoutMs
  });
}
