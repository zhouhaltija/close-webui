export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重试。';
