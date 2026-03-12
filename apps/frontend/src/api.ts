import {
  CurrentUserResponseSchema,
  MessageListResponseSchema,
  SessionListResponseSchema,
  type Citation,
  type CurrentUserResponse,
  type MessageRecord,
  type StreamEvent,
} from "@alphabook/shared";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api";

export interface ChatStreamHandlers {
  onEvent: (event: StreamEvent) => void;
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response;
}

export async function fetchSessions(userId?: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions${userId ? `?userId=${encodeURIComponent(userId)}` : ""}`, {
      credentials: "include",
    }),
  );
  return SessionListResponseSchema.parse(await response.json()).sessions;
}

export async function fetchMessages(sessionId: string) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/messages`, {
      credentials: "include",
    }),
  );
  return MessageListResponseSchema.parse(await response.json()).messages.map(hydrateMessage);
}

export async function fetchCurrentUser(): Promise<CurrentUserResponse> {
  const response = await ensureOk(
    await fetch(`${API_BASE}/me`, {
      credentials: "include",
    }),
  );
  return CurrentUserResponseSchema.parse(await response.json());
}

export function buildSignInUrl(returnTo: string) {
  return `${API_BASE}/auth/sign-in?returnTo=${encodeURIComponent(returnTo)}`;
}

export function buildSignOutUrl(returnTo: string) {
  return `${API_BASE}/auth/sign-out?returnTo=${encodeURIComponent(returnTo)}`;
}

function hydrateMessage(message: MessageRecord) {
  return {
    ...message,
    citations: Array.isArray(message.metadata.citations) ? (message.metadata.citations as Citation[]) : [],
    researchLog: Array.isArray(message.metadata.researchLog)
      ? (message.metadata.researchLog as Array<Record<string, unknown>>)
      : [],
  };
}

export async function streamChat(
  payload: {
    userId?: string;
    sessionId?: string;
    message: string;
  },
  handlers: ChatStreamHandlers,
) {
  const response = await ensureOk(
    await fetch(`${API_BASE}/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify(payload),
    }),
  );

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Response stream was not available.");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const eventName = rawEvent
        .split("\n")
        .find((line) => line.startsWith("event:"))
        ?.replace("event:", "")
        .trim();
      const dataLine = rawEvent
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.replace("data:", "")
        .trim();

      if (!eventName || !dataLine) {
        continue;
      }

      handlers.onEvent({
        event: eventName,
        data: JSON.parse(dataLine) as Record<string, unknown>,
      });
    }
  }
}
