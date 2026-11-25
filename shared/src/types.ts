export type ProjectStatus = 'chatting' | 'building' | 'ready' | 'error';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface AgentToolStep {
  id: string;
  toolName: string;
  argsSummary?: string;
  status: 'running' | 'done' | 'error';
  output?: string;
}

export interface MessageMetadata {
  mode?: 'chat' | 'build';
  thinking?: string;
  steps?: AgentToolStep[];
  previewUrl?: string;
  aborted?: boolean;
  error?: string;
}

export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  hasSkill: boolean;
  mcpServerName?: string;
}

export interface AgentPresetSummary {
  id: string;
  name: string;
  description: string;
  templateId: string;
  plugins: PluginSummary[];
}

export interface TableColumnDTO {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: string | null;
}

export interface TableInfoDTO {
  logicalName: string;
  physicalName: string;
  rowCount: number;
  columns: TableColumnDTO[];
  sql: string;
}

export interface ProjectDTO {
  id: string;
  owner: string;
  title: string;
  presetId: string;
  tablePrefix: string;
  status: ProjectStatus;
  hasWorkspace: boolean;
  previewUrl: string | null;
  previewRunning: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDTO {
  id: string;
  projectId: string;
  role: MessageRole;
  content: string;
  metadata?: MessageMetadata;
  createdAt: number;
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileTreeNode[];
}

export type SSEEvent =
  | { type: 'connected'; projectId: string; isBuilding: boolean }
  | { type: 'project_updated'; project: ProjectDTO }
  | { type: 'message_created'; message: MessageDTO }
  | { type: 'chat_start'; messageId: string }
  | { type: 'chat_delta'; messageId: string; delta: string }
  | { type: 'chat_done'; message: MessageDTO; suggestBuild?: boolean }
  | { type: 'agent_start'; runId: string; messageId: string }
  | { type: 'agent_thinking_delta'; messageId: string; delta: string }
  | { type: 'agent_text_delta'; messageId: string; delta: string }
  | { type: 'agent_tool_start'; messageId: string; step: AgentToolStep }
  | { type: 'agent_tool_update'; messageId: string; stepId: string; outputDelta: string }
  | { type: 'agent_tool_end'; messageId: string; stepId: string; status: 'done' | 'error'; output?: string }
  | { type: 'agent_status'; messageId: string; statusText: string }
  | { type: 'preview_ready'; projectId: string; previewUrl: string }
  | { type: 'agent_done'; runId: string; message: MessageDTO; status: 'succeeded' | 'aborted' | 'failed'; error?: string }
  | { type: 'error'; message: string };
