import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import type { ReactNode } from "react";

import { Thread } from "./assistant-ui/thread";
import type { RunArtifactRecord } from "../api";
import type { Citation, MessageRecord } from "@alphabook/shared";

type ToolTraceEntry = {
  id: string;
  toolName: string;
  label: string;
  rationale?: string;
  progress: string[];
  progressDetails?: Array<Record<string, unknown>>;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  isError?: boolean;
  state: "running" | "completed" | "error";
};

export type UiMessage = MessageRecord & {
  citations: Citation[];
  toolCalls: ToolTraceEntry[];
};

type ThreadSuggestion = {
  icon?: "search" | "heart";
  title: string;
  description?: string;
  prompt: string;
};

type AssistantEffortLevel = "semantic" | "comprehensive" | "hermes";

export type AssistantSurfaceProps = {
  messages: UiMessage[];
  isSending: boolean;
  streamingAssistantId: string | null;
  artifacts: RunArtifactRecord[];
  showArtifacts?: boolean;
  showWelcome?: boolean;
  effortLevel: AssistantEffortLevel;
  onEffortLevelChange: (value: AssistantEffortLevel) => void;
  onPrompt: (prompt: string) => Promise<void>;
  onCancel: () => Promise<void>;
  convertMessage: (message: UiMessage, streamingAssistantId: string | null, isSending: boolean) => unknown;
  extractPromptText: (message: { content?: unknown }) => string;
  suggestions?: ThreadSuggestion[];
  composerDisabled?: boolean;
  composerDisabledNotice?: ReactNode;
};

export default function AssistantSurface({
  messages,
  isSending,
  streamingAssistantId,
  artifacts,
  showArtifacts = true,
  showWelcome = true,
  effortLevel,
  onEffortLevelChange,
  onPrompt,
  onCancel,
  convertMessage,
  extractPromptText,
  suggestions,
  composerDisabled = false,
  composerDisabledNotice,
}: AssistantSurfaceProps) {
  const runtime = useExternalStoreRuntime({
    isRunning: isSending,
    messages: messages.filter((message) => message.role === "user" || message.role === "assistant"),
    convertMessage: (message: UiMessage) => convertMessage(message, streamingAssistantId, isSending) as never,
    onNew: async (message: { content?: unknown }) => {
      if (composerDisabled) {
        return;
      }
      const prompt = extractPromptText(message);
      if (!prompt) {
        return;
      }
      await onPrompt(prompt);
    },
    onCancel,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        isRunning={isSending}
        artifacts={artifacts}
        showArtifacts={showArtifacts}
        showWelcome={showWelcome}
        suggestions={suggestions}
        effortLevel={effortLevel}
        onEffortLevelChange={onEffortLevelChange}
        composerDisabled={composerDisabled}
        composerDisabledNotice={composerDisabledNotice}
        onCancel={() => {
          void onCancel();
        }}
      />
    </AssistantRuntimeProvider>
  );
}
