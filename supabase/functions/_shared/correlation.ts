export function getCorrelationId(req: Request): string {
  return req.headers.get('x-correlation-id') || crypto.randomUUID();
}

export function withCorrelationHeaders(
  headers: Record<string, string>,
  correlationId: string,
): Record<string, string> {
  return { ...headers, 'x-correlation-id': correlationId };
}
