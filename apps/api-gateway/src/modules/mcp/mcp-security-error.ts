/** Thrown when a custom MCP JSON config fails validation. */
export class McpSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSecurityError';
  }
}