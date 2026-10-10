export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
export type Message = { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; status: MessageStatus; createdAt: string; error?: { code: string; message: string } };
export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt: string };
export type Conversation = ConversationSummary & { messages: Message[] };
export type StoredData = { version: 1; conversations: Conversation[] };
export type GenerationInput = { userMessageId: string; assistantMessageId: string; content: string; retry: boolean };
export type GenerationEvent = { type: 'delta'; assistantMessageId: string; content: string } | { type: 'done'; assistantMessageId: string } | { type: 'error'; assistantMessageId: string; code: string; message: string };
