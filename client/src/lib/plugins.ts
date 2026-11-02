// Telling commands apart from chat (docs/plugins.md): plugins run as the
// server's built-in bot and the bot answers its own "/" commands, so an AI's
// runner leaves those messages alone. Pure, unit-tested (plugins.test.ts).

/**
 * Is this message a plugin command (so the AI shouldn't answer it too)?
 * Like NoneBot: a command prefix, then the command; whatever follows is its
 * argument. @-mentions at the start are skipped (NoneBot drops the @ of the bot).
 */
export function isPluginCommand(text: string, starts: string[], commands: string[]): boolean {
  const t = text.replace(/^(\s*@\S+)+\s*/, '').trimStart();
  if (!t || !commands.length) return false;
  for (const st of starts.length ? starts : ['/']) {
    if (!t.startsWith(st)) continue;
    const rest = t.slice(st.length);
    if (commands.some((c) => c && rest.startsWith(c))) return true;
  }
  return false;
}
