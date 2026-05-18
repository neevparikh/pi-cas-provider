/**
 * The provider-managed system-prompt block. Appended to pi's `context.systemPrompt`
 * before the prompt is handed to the Agent SDK.
 *
 * Documents tool-behavior deltas from Claude Code defaults that the shim does NOT
 * paper over (because they can't be losslessly translated). Captured from empirical
 * tool-schema diffs between Claude Code v2.1.143 and pi v0.74.0.
 */

export const PROVIDER_SHIM_NOTES = `<pi-environment-override>
*** TOOL CALLING OVERRIDE — SUPERSEDES THE SYSTEM PROMPT ABOVE ***

The system prompt above describes pi's tools with lowercase names (read, write,
edit, bash, grep, find). Those names refer to the SAME tools you have, but in
this environment you MUST call them using their Claude Code names (PascalCase)
with Claude Code argument schemas. A shim translates names and arguments to pi
automatically. Do not call pi's lowercase names — the lowercase names are not
registered tools here and will fail.

Use exactly these tool names:

- Read(file_path: absolute path, offset?, limit?)
    Same as pi's read. Pass paths as file_path, not path.
    Note: PDFs via pages are not supported.

- Write(file_path: absolute path, content)
    Same as pi's write. No prior Read required (unlike standard Claude Code).
    Pi creates parent directories automatically.

- Edit(file_path: absolute path, old_string, new_string)
    Performs a single exact-string replacement. NOTE: replace_all is silently
    ignored — to replace multiple occurrences, call Edit more than once with
    progressively more specific old_string values. No prior Read required.

- Bash(command, timeout?)
    NOTE: timeout is in SECONDS not milliseconds (e.g. timeout: 30 = 30s).
    run_in_background, description, dangerouslyDisableSandbox are dropped.
    BashOutput / KillShell tools do not exist here. Bash is always synchronous.
    Output truncated to ~2000 lines / 50KB; full output saved to a temp file.

- Grep(pattern, path?, glob?, -i?, context?, head_limit?)
    output_mode, -A, -B, -o, type, multiline, offset are NOT supported.
    Output is always matching lines with file paths and line numbers.
    Use -i: true for case-insensitive. Use context: N for symmetric context
    (no asymmetric -A/-B). head_limit defaults to 100.

- Glob(pattern, path?)
    Standard glob matching. Pi's backend caps results at 1000 by default.

The following Claude Code tools are NOT available and will fail:
Agent, AskUserQuestion, NotebookEdit, WebFetch, WebSearch, EnterPlanMode,
ExitPlanMode, Skill, EnterWorktree, ExitWorktree, Monitor, PushNotification,
ScheduleWakeup, CronCreate, CronDelete, CronList, TaskCreate, TaskGet, TaskList,
TaskUpdate, TaskOutput, TaskStop.

When pi's instructions mention a custom tool by name (e.g. subagent, or any
domain-specific tool registered via pi.registerTool), call it by that exact
name — those go through MCP unchanged.
</pi-environment-override>`;

/**
 * Compose the final system prompt: pi's prompt followed by the shim notes.
 * If pi did not provide a system prompt, only the notes are sent.
 */
export function composeSystemPrompt(piSystemPrompt: string | undefined): string {
  const parts: string[] = [];
  if (piSystemPrompt && piSystemPrompt.trim().length > 0) {
    parts.push(piSystemPrompt.trim());
  }
  parts.push(PROVIDER_SHIM_NOTES);
  return parts.join("\n\n");
}
