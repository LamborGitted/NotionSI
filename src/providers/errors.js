// Only sanitized, user-facing messages belong in this error type.
export class ProviderError extends Error {
  constructor(message, { status, code } = {}) {
    super(message); this.name = 'ProviderError'; this.status = status; this.code = code;
  }
}
