export type MessageStatus = 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
export type SubmissionPhase = 'submitting' | 'awaiting';
/** A locally previewed submission the server has not confirmed yet. */
export type SubmissionPreview = { conversationId?: string; title: string; phase: SubmissionPhase; messages: Message[] };
export type Message = { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; status: MessageStatus; createdAt: string; error?: { code: string; message: string }; modelId?: string; generationId?: string; reasoning?: Reasoning; phase?: SubmissionPhase };
export type ConversationSummary = { id: string; title: string; createdAt: string; updatedAt: string };
export type Conversation = ConversationSummary & { messages: Message[] };
export type StoredData = { version: 1; conversations: Conversation[] };
export type GenerationInput = { userMessageId: string; assistantMessageId: string; content: string; retry: boolean; generationId?: string; modelId?: string; reasoning?: Reasoning };
export type GenerationEvent = { type: 'delta'; assistantMessageId: string; content: string } | { type: 'done'; assistantMessageId: string } | { type: 'error'; assistantMessageId: string; code: string; message: string };
export type User = { id: string; username: string };
export type Protocol = 'openai-chat' | 'openai-responses' | 'gemini' | 'anthropic';
export type Adapter = 'standard' | 'openrouter' | 'siliconflow' | 'deepseek' | 'qwen' | 'kimi' | 'glm';
export type ProviderTemplate = { id: string; name: string; protocol: Protocol; adapter: Adapter; baseUrl: string };
export type Provider = ProviderTemplate & { templateId: string; enabled: boolean; hasKey: boolean; updatedAt?: string };
export type ProviderInput = Omit<Provider, 'id' | 'hasKey' | 'updatedAt'> & { apiKey?: string };
export type Reasoning = { enabled?: boolean; effort?: string; budgetTokens?: number };
export type ModelCapabilities = { family: string; efforts: string[]; supportsToggle: boolean; mandatory: boolean; budgetMin: number; budgetMax: number; budgetSupported: boolean; outputMax: number; sources: string[]; known: boolean; reasoningSupported?: boolean; outputSource?: 'upstream' | 'catalog' | 'conservative'; contextWindow?: number; budgetWithinOutput?: boolean; dynamicBudget?: boolean; zeroBudgetDisables?: boolean; effortBudgetCompatible?: boolean; effortWhileDisabled?: boolean; manualBudget?: boolean; disabledEffortLimited?: boolean };
export type Model = { id: string; providerId: string; modelId: string; name: string; enabled: boolean; maxOutputTokens: number; defaultReasoning: Reasoning; capabilities: ModelCapabilities };
export type ModelInput = Omit<Model, 'id' | 'capabilities'>;
export type Preferences = { defaultModelId: string | null };
/** One built-in or upstream model candidate with its verified capabilities and safe defaults. */
export type CatalogEntry = { id: string; name: string; capabilities: ModelCapabilities; recommendedDefaults: { maxOutputTokens: number; defaultReasoning: Reasoning }; verifiedDate: string; notes?: string };
/** Versioned built-in catalog for one provider adapter/protocol combination. */
export type ModelCatalog = { catalogVersion: string; adapter: string; protocol: string; models: CatalogEntry[] };
/** Candidate response: upstream when the provider answered, catalog as the built-in fallback. */
export type ModelCandidates = { source: 'upstream' | 'catalog'; catalogVersion: string; warning: string; models: CatalogEntry[] };
export type ModelBatchEntry = { modelId: string; name?: string; maxOutputTokens?: number; enabled?: boolean };
export type ModelBatchResult = { modelId: string; id?: string; status: 'added' | 'exists' | 'failed'; error?: string };
export type ModelBatchResponse = { results: ModelBatchResult[] };
