const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /apikey[=:]\s*["']?[A-Za-z0-9\-._~+/]+["']?/gi,
  /password[=:]\s*["']?[^\s"',}]+["']?/gi,
  /secret[=:]\s*["']?[^\s"',}]+["']?/gi,
  /token[=:]\s*["']?[A-Za-z0-9\-._~+/]+["']?/gi,
  /eyJ[A-Za-z0-9\-_]+\.eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_.+/=]*/g,
];

export function sanitizeErrorMessage(error: unknown): string {
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    message = 'An internal error occurred';
  }

  for (const pattern of SENSITIVE_PATTERNS) {
    message = message.replace(pattern, '[REDACTED]');
  }

  if (message.length > 200) {
    message = message.slice(0, 200) + '...';
  }

  return message;
}

export function safeErrorJson(error: unknown): { error: string } {
  return { error: sanitizeErrorMessage(error) };
}
