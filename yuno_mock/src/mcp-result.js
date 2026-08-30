// Shared helpers to build the CallToolResult the MCP protocol expects.
// Factored out so every tool file can reuse it instead of duplicating it.

export function ok(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function fail(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}
