export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message); this.name = "ApiError"; this.status = status; this.code = code;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/v1${path}`, {
      ...options,
      cache: "no-store",
      credentials: "same-origin",
      signal: options.signal || controller.signal,
      headers: {
        "Accept": "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const text = await response.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      const payload = data as { error?: { message?: string; code?: string } | string; message?: string; code?: string } | null;
      const detail = typeof payload?.error === "object" ? payload.error.message : typeof payload?.error === "string" ? payload.error : payload?.message;
      const code = typeof payload?.error === "object" ? payload.error.code : payload?.code;
      throw new ApiError(detail || `The API could not complete this request (HTTP ${response.status}).`, response.status, code);
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new ApiError("The API took too long to respond. Check its connection and retry.", 0, "TIMEOUT");
    throw new ApiError("Cannot reach the HumanDock API. Start the backend and try again.", 0, "NETWORK_ERROR");
  } finally {
    clearTimeout(timeout);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mutationOptions(csrfToken: string | null | undefined, body: unknown, idempotencyKey?: string): RequestInit {
  if (!csrfToken) throw new ApiError("Your session has expired. Choose a local demo role to sign in again.", 401, "NO_SESSION");
  return { method: "POST", headers: { "X-CSRF-Token": csrfToken, "Idempotency-Key": idempotencyKey || crypto.randomUUID() }, body: JSON.stringify(body) };
}
