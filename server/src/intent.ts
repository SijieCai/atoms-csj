import type { AgentPresetSummary, MessageDTO } from '@atoms/shared';
import { config } from './config.js';
import { DEFAULT_AGENT_ID, pluginRegistry } from './plugin-registry.js';

export interface IntentDecision {
  intent: 'chat' | 'run_agent';
  targetAgentId?: string;
  title?: string;
  reason?: string;
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function buildIntentSystemPrompt(agents: AgentPresetSummary[]): string {
  const agentCatalog = agents
    .map((a) => {
      const kw = a.intent?.keywords?.length ? `Keywords: ${a.intent.keywords.join(', ')}` : '';
      const ex = a.intent?.examples?.length ? `Examples: ${a.intent.examples.join(' | ')}` : '';
      return `- "${a.id}" (${a.name}): ${a.intent?.description || a.description}\n  ${kw}\n  ${ex}`.trim();
    })
    .join('\n');

  return `You are the multi-agent intent router for Atoms, an extensible AI Agent workspace platform.
Available specialized Agents:
${agentCatalog}

Decide whether the user's latest message should:
1. Stay in "chat" mode (greeting, asking capabilities, light brainstorming, conceptual Q&A without requesting an agent run), OR
2. Trigger "run_agent" and route to the single best "targetAgentId" from the list above.

Rules:
- Return ONLY a JSON object with keys:
  - "intent": "chat" | "run_agent"
  - "targetAgentId": one of [${agents.map((a) => `"${a.id}"`).join(', ')}] (required when intent="run_agent")
  - "title": concise 2-14 char Chinese/English title summarizing the topic
  - "reason": short explanation
- Choose "deep-research" when the user asks to deeply research a topic, compare competitors/technologies, collect web evidence, fact-check, do literature/industry research, or produce a cited research report — EVEN IF the current thread already has a coding workspace (the platform will automatically fork a clean research thread!).
- Choose "fullstack-coder" when the user asks to build/create/develop/generate a website, app, page, dashboard, tool, OR confirms a build plan ("开始吧", "开始构建", "就按这个做"), OR asks to turn a research report into an interactive web app, OR when currentAgentId="fullstack-coder" with hasWorkspace=true and the user asks to modify UI/code/features/fix bugs.
- When currentAgentId="deep-research" with hasWorkspace=true and the user asks to expand sections, add sources, check a new angle, or update the research report, choose "deep-research".
- Choose "chat" when the user is just saying hello, asking what you can do, or having an open-ended discussion without asking to run research or build an app yet.`;
}

const CHAT_SYSTEM_PROMPT = `你是 Atoms AI 多 Agent 协作助手，目前内置两类专业 Agent 能力：
1. **🔬 Deep Research Agent（深度研究）**：可联网多源检索、抓取网页正文、交叉核验观点，并输出带完整引用溯源的交互式研究报告（适合技术选型、竞品分析、行业调研、事实核查）。
2. **💻 Fullstack Coder Agent（全栈建站）**：可自动编写 React + Tailwind + Express + 用户隔离 SQLite 全栈应用，并立即生成可交互的在线预览链接（适合工具站、看板、记账本、数据展示应用）。

工作方式：
- 用简洁、友好、专业的中文（或跟随用户语言）交流。
- 如果用户只是打招呼或问你能做什么，请简明介绍上述两种 Agent，并各给 1–2 个可直接上手的示例（明确提醒用户可以直接发起 Deep Research 深度研究，也可以直接构建全栈应用）。
- 如果用户处于讨论/构思阶段，先帮他梳理清晰目标或方案，并在结尾提示：可以直接说「开始深度研究」或「开始构建」，也可以通过输入框下方模式切换一键触发对应 Agent。
- 不要在聊天里凭空编造未核实的外网引用，也不要输出冗长整段代码；实际调研和编码都由对应隔离工作区的专业 Agent 完成。`;

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

function heuristicIntent(
  latestMessage: string,
  hasWorkspace: boolean,
  currentAgentId?: string | null,
): IntentDecision {
  const text = latestMessage.trim();
  const lower = text.toLowerCase();

  const researchPatterns = [
    /(深度研究|深度调研|深入调研|深入研究|研究报告|调研报告|竞品分析|竞品调研|行业调研|市场调研|技术调研|文献综述|事实核查)/,
    /(调研一下|研究一下|查一下资料|搜集资料|收集资料|对比分析一下)/,
    /\b(deep\s*research|research\s+report|literature\s+review|competitive\s+analysis|investigate|fact[\s-]?check|market\s+analysis)\b/i,
  ];

  const buildPatterns = [
    /帮我(做|建|写|开发|生成|创建|搭建|实现)/,
    /(制作|开发|生成|搭建|创建|构建)一个.*(网站|应用|网页|系统|看板|工具|页面|app|web|site)/i,
    /(基于|根据).*(报告|调研|结果).*(做|建|开发|生成|构建).*(网站|应用|网页|页面|看板|可视化)/,
    /开始(构建|开发|制作|生成|写代码|干活)/,
    /(就按这个|可以，开始|动手吧|直接做|开始吧)/,
    /\b(build|create|generate|make|implement|scaffold)\b.*(app|site|web|page|dashboard|todo|blog|tool)/i,
  ];

  const modifyCodePatterns = [
    /(改|修|加|增加|新增|删除|调整|优化|换|修复|bug|报错|样式|颜色|字段|按钮|页面|接口|数据库)/,
    /\b(fix|add|update|change|remove|edit|style|refactor)\b/i,
  ];

  const modifyResearchPatterns = [
    /(补充|更新|追加|细化|核实|核查|加一节|增加.*维度|更新报告|补充来源|补充引用)/,
    /\b(expand|update\s+report|add\s+sources|verify\s+claim|more\s+details)\b/i,
  ];

  const isBuildHit = buildPatterns.some((re) => re.test(text) || re.test(lower));
  const isResearchHit = researchPatterns.some((re) => re.test(text) || re.test(lower));

  // If explicitly asking to turn a report into a website, prioritize fullstack-coder
  if (/(基于|根据).*(报告|调研).*(做|建|开发|生成|构建)/.test(text)) {
    return {
      intent: 'run_agent',
      targetAgentId: 'fullstack-coder',
      reason: 'heuristic_report_to_app',
    };
  }

  if (isResearchHit && pluginRegistry.hasAgent('deep-research')) {
    return {
      intent: 'run_agent',
      targetAgentId: 'deep-research',
      reason: 'heuristic_research_keyword',
    };
  }

  if (isBuildHit) {
    return {
      intent: 'run_agent',
      targetAgentId: DEFAULT_AGENT_ID,
      reason: 'heuristic_build_keyword',
    };
  }

  if (hasWorkspace) {
    const canonicalCurrent = pluginRegistry.canonicalAgentId(currentAgentId);
    if (canonicalCurrent === 'deep-research' && modifyResearchPatterns.some((re) => re.test(text))) {
      return {
        intent: 'run_agent',
        targetAgentId: 'deep-research',
        reason: 'heuristic_research_iterate',
      };
    }
    if (canonicalCurrent === 'fullstack-coder' && modifyCodePatterns.some((re) => re.test(text))) {
      return {
        intent: 'run_agent',
        targetAgentId: 'fullstack-coder',
        reason: 'heuristic_workspace_modify',
      };
    }
  }

  return { intent: 'chat', reason: 'heuristic_default_chat' };
}

export function deriveFallbackTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '新对话';
  return cleaned.length > 20 ? `${cleaned.slice(0, 20)}...` : cleaned;
}

export async function classifyIntent(
  history: MessageDTO[],
  latestMessage: string,
  hasWorkspace: boolean,
  currentAgentId?: string | null,
): Promise<IntentDecision> {
  if (!config.glmApiKey) {
    return heuristicIntent(latestMessage, hasWorkspace, currentAgentId);
  }

  const agents = pluginRegistry.listPresets();
  const canonicalCurrent = hasWorkspace ? pluginRegistry.canonicalAgentId(currentAgentId) : 'none';
  const recent = history
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
    .join('\n');
  const userPrompt = `hasWorkspace=${hasWorkspace}\ncurrentAgentId=${canonicalCurrent}\n\nRecent conversation:\n${recent || '(empty)'}\n\nLatest user message:\n${latestMessage}`;

  const isGlm53 = /^glm-5\.3/i.test(config.glmChatModel);

  try {
    const resp = await fetch(`${config.glmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.glmApiKey}`,
      },
      body: JSON.stringify({
        model: config.glmChatModel,
        temperature: isGlm53 ? 1.0 : 0.1,
        ...(isGlm53
          ? {
              thinking: { type: 'enabled', clear_thinking: false },
              reasoning_effort: 'low',
              max_tokens: 1024,
            }
          : { max_tokens: 260 }),
        messages: [
          { role: 'system', content: buildIntentSystemPrompt(agents) },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!resp.ok) {
      return heuristicIntent(latestMessage, hasWorkspace, currentAgentId);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content || '';
    const parsed = extractJsonObject(content);
    if (parsed) {
      const title =
        typeof parsed.title === 'string' && parsed.title.trim()
          ? parsed.title.trim().slice(0, 32)
          : undefined;
      const reason = typeof parsed.reason === 'string' ? parsed.reason : undefined;

      if (parsed.intent === 'chat') {
        return { intent: 'chat', title, reason };
      }

      if (parsed.intent === 'run_agent' || parsed.intent === 'build') {
        const rawTarget = typeof parsed.targetAgentId === 'string' ? parsed.targetAgentId.trim() : '';
        const targetAgentId = pluginRegistry.hasAgent(rawTarget)
          ? pluginRegistry.canonicalAgentId(rawTarget)
          : DEFAULT_AGENT_ID;
        return {
          intent: 'run_agent',
          targetAgentId,
          title,
          reason,
        };
      }
    }
    return heuristicIntent(latestMessage, hasWorkspace, currentAgentId);
  } catch {
    return heuristicIntent(latestMessage, hasWorkspace, currentAgentId);
  }
}

export async function streamChatReply(
  history: MessageDTO[],
  latestMessage: string,
  onDelta: (delta: string) => void,
): Promise<{ text: string; suggestBuild: boolean }> {
  if (!config.glmApiKey) {
    const fallback =
      '当前服务端尚未配置 `GLM_API_KEY`，请在 `.env` 中填入你的智谱 GLM API Key 后重启服务即可体验完整对话、Deep Research 深度研究与全栈建站能力。';
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

  const isGlm53 = /^glm-5\.3/i.test(config.glmChatModel);

  const resp = await fetch(`${config.glmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.glmApiKey}`,
    },
    body: JSON.stringify({
      model: config.glmChatModel,
      temperature: isGlm53 ? 1.0 : 0.7,
      ...(isGlm53
        ? {
            top_p: 0.95,
            thinking: { type: 'enabled', clear_thinking: false },
            reasoning_effort: 'low',
          }
        : {}),
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

  const suggestBuild = /开始构建|立即构建|点击下方|开始开发|SQLite|页面|功能|深度研究/.test(fullText);
  return { text: fullText || '收到，你可以让我开展 Deep Research 深度研究，或直接构建全栈网站！', suggestBuild };
}
