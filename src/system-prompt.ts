/**
 * Provider-managed system-prompt block appended to pi's `context.systemPrompt`
 * before handing off to the Agent SDK.
 *
 * # What this clarifies for the model
 *
 * Pi's own system prompt typically refers to tools by pi's lowercase names
 * (`bash`, `read`, `edit`, ...).  In the pi-cas-via-SDK setup, the actual
 * tool definitions in the API request come from the Agent SDK and use
 * Claude Code's PascalCase names (`Bash`, `Read`, `Edit`, ...).  The model
 * is heavily trained on Claude Code's names and schemas, so it tends to
 * pick the PascalCase tools from the API anyway, but we add a short note
 * so it never gets stuck wondering why pi's instructions reference names
 * that don't appear in its toolset.
 *
 * # What this does NOT do
 *
 * In a previous architecture (the pre-Option-A revision) pi-cas executed
 * tools itself with its own arg shapes, and the system prompt warned the
 * model about CC \u2192 pi schema deltas ("timeout in SECONDS not ms",
 * "replace_all is silently ignored", etc.).  That layer is gone.  The
 * Agent SDK runs CC tools with their NATIVE schemas; pi-cas's job is
 * purely to cache results and surface them to pi via stub tools.  So we
 * removed all the schema-translation notes; the model just uses CC tools
 * as designed.
 */

export const PROVIDER_SHIM_NOTES = `<pi-environment-note>
In this environment your tools come from Claude Code: \`Bash\`, \`Read\`, \`Write\`,
\`Edit\`, \`Grep\`, \`Glob\`.  Use them as you normally would.

If pi's instructions above mention tools using lowercase names like \`bash\`,
\`read\`, \`edit\`, \`write\`, \`grep\`, \`find\`, those refer to the same underlying
operations \u2014 just call the PascalCase Claude Code tools instead.  No other
Claude Code tools are available in this environment (no \`WebFetch\`, \`Agent\`,
\`NotebookEdit\`, etc.).
</pi-environment-note>`;

/**
 * Compose the final system prompt: pi's prompt followed by the environment
 * note.  If pi did not provide a system prompt, only the note is sent.
 */
export function composeSystemPrompt(piSystemPrompt: string | undefined): string {
  const parts: string[] = [];
  if (piSystemPrompt && piSystemPrompt.trim().length > 0) {
    parts.push(piSystemPrompt.trim());
  }
  parts.push(PROVIDER_SHIM_NOTES);
  return parts.join("\n\n");
}
