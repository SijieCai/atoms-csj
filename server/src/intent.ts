import type { MessageDTO } from '@atoms/shared';
import { config } from './config.js';

export interface IntentDecision {
  intent: 'chat' | 'build';
  title?: string;
  reason?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const INTENT_SYSTEM_PROMPT = `You are the intent router for Atoms, an AI full-stack web app builder (React + Node.js + SQLite).
Decide whether the user's latest message should stay in "chat" mode (greeting, brainstorming, asking questions, clarifying requirements) or trigger "build" mode (creating, coding, generating, modifying, fixing, or implementing a website/app).

Rules:
- Return ONLY a JSON object with keys: "intent" ("chat" or "build"), "title" (concise 2-12 char Chinese/English project title summarizing the topic), "reason" (short explanation).
- Choose "build" when the user explicitly asks to build/create/develop/generate a website, app, page, tool, dashboard, blog, etc., OR confirms a proposed plan ("开始吧", "好的开始构建", "就按这个做", "build it"), OR when hasWorkspace=true and the user asks to change UI, add features, fix bugs, or update data models.
- Choose "chat" when the user is just saying hello, asking what you can do, discussing ideas without asking to generate code yet, or asking a purely conceptual question.`;

const CHAT_SYSTEM_PROMPT = `你是 Atoms AI 产品与全栈架构助手，帮助用户把想法快速变成真实可运行的网站与全栈应用（前端 React + Tailwind，后端 Express + 真实 SQLite 数据持久化，构建完成后可直接在线预览和分享）。

工作方式：
1. 用简洁、友好、专业的中文（或跟随用户语言）交流。
2. 如果用户只是打招呼或问你能做什么，简明介绍你的能力，并给出 2-3 个可直接上手的全栈应用示例（如待办看板、记账本、团队知识库、投票收集器）。
3. 如果用户描述了初步想法但还在讨论阶段，帮他快速梳理核心页面、交互功能与 SQLite 数据表设计，并在结尾明确提示：“如果这个方案没问题，回复‘开始构建’或点击下方按钮，我会立刻为你启动云端开发。”
4. 不要输出冗长的整段代码；真正写代码会交给隔离的 Coding Agent 执行。`;

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function heuristicIntent(latestMessage: string, hasWorkspace: boolean): IntentDecision {
  const text = latestMessage.trim().toLowerCase();
  const buildPatterns = [
    /帮我(做|建|写|开发|生成|创建|搭建)/,
    /(制作|开发|生成|搭建|创建|构建)一个/,
    /开始(构建|开发|制作|生成|写代码|干活)/,
    /(就按这个|可以，开始|动手吧|直接做|开始吧)/,
    /\b(build|create|generate|make|implement|scaffold)\b.*(app|site|web|page|dashboard|todo|blog|tool)/i,
  ];
  const modifyPatterns = [
    /(改|修|加|增加|新增|删除|调整|优化|换|修复|bug|报错|样式|颜色|字段|按钮|页面|接口|数据库)/,
    /\b(fix|add|update|change|remove|edit|style|refactor)\b/i,
  ];

  if (buildPatterns.some((re) => re.test(text))) {
    return { intent: 'build', reason: 'heuristic_build_keyword' };
  }
  if (hasWorkspace && modifyPatterns.some((re) => re.test(text))) {
    return { intent: 'build', reason: 'heuristic_workspace_modify' };
  }
  return { intent: 'chat', reason: 'heuristic_default_chat' };
}

export function deriveFallbackTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新项目';
  return cleaned.length > 20 ? `${cleaned.slice(0, 20)}...` : cleaned;
}

export async function classifyIntent(
  history: MessageDTO[],
  latestMessage: string,
  hasWorkspace: boolean,
): Promise<IntentDecision> {
  if (!config.glmApiKey) {
    return heuristicIntent(latestMessage, hasWorkspace);
  }

  const recent = history.slice(-6).map((m) => `${m.role}: ${m.content.slice(0, 300)}`).join('\n');
  const userPrompt = `hasWorkspace=${hasWorkspace}\n\nRecent conversation:\n${recent || '(empty)'}\n\nLatest user message:\n${latestMessage}`;

  try {
    const resp = await fetch(`${config.glmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.glmApiKey}`,
      },
      body: JSON.stringify({
        model: config.glmChatModel,
        temperature: 0.1,
        max_tokens: 220,
        messages: [
          { role: 'system', content: INTENT_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!resp.ok) {
      return heuristicIntent(latestMessage, hasWorkspace);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);
    if (parsed && (parsed.intent === 'chat' || parsed.intent === 'build')) {
      return {
        intent: parsed.intent,
        title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 32) : undefined,
        reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      };
    }
    return heuristicIntent(latestMessage, hasWorkspace);
  } catch {
    return heuristicIntent(latestMessage, hasWorkspace);
  }
}

export async function streamChatReply(
  history: MessageDTO[],
  latestMessage: string,
  onDelta: (delta: string) => void,
): Promise<{ text: string; suggestBuild: boolean }> {
  if (!config.glmApiKey) {
    const fallback =
      '当前服务端尚未配置 `GLM_API_KEY`，请在 `.env` 中填入你的智谱 GLM API Key 后重启服务即可体验完整对话与自动建站能力。';
    onDelta(fallback);
    return { text: fallback, suggestBuild: false };
  }

  const messages: OpenAIMessage[] = [
    { role: 'system', content: CHAT_SYSTEM_PROMPT },
    ...history.slice(-12).map((m) => ({
      role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
      content: m.content.slice(0, 3000),
    })),
    { role: 'user', content: latestMessage },
  ];

  const resp = await fetch(`${config.glmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.glmApiKey}`,
    },
    body: JSON.stringify({
      model: config.glmChatModel,
      temperature: 0.7,
      stream: true,
      messages,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!resp.ok || !resp.body) {
    const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
    throw new Error(`GLM API error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nlIdx = buffer.indexOf('\n');
    while (nlIdx !== -1) {
      const line = buffer.slice(0, nlIdx).replace(/\r$/, '').trim();
      buffer = buffer.slice(nlIdx + 1);
      nlIdx = buffer.indexOf('\n');

      if (!line.startsWith('data:')) continue;
      const dataStr = line.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;

      try {
        const chunk = JSON.parse(dataStr) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onDelta(delta);
        }
      } catch {
        // ignore malformed SSE chunk
      }
    }
  }

  const suggestBuild = /开始构建|立即构建|点击下方|开始开发|SQLite|页面|功能/.test(fullText);
  return { text: fullText || '收到，请告诉我你想构建什么样的网站？', suggestBuild };
}
