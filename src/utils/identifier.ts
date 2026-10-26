const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name);
}

export function assertSafeIdentifier(name: string): void {
  if (!isSafeIdentifier(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}
