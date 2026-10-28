/**
 * Typing a prepared command into a shell that has just started.
 *
 * A shell is not ready the moment its process is: zsh's line editor comes up
 * after the rc files, and a startup prompt that reads a SINGLE key — the one
 * oh-my-zsh shows periodically, "Would you like to update? [Y/n]" — consumes
 * the first keystroke outright. A fixed delay cannot see either, which is how
 * `tsh login` once arrived as `sh login` and ran /usr/bin/login.
 *
 * So this waits for the shell to stop printing, sends a throwaway ^U ahead of
 * the line, and presses Enter only once the terminal shows the line intact.
 * ^U does two jobs: it clears whatever the line editor already holds, and it
 * is what a one-key prompt eats instead of the command's first letter — while
 * answering "yes" to nothing.
 */
export type AutotypeIO = {
  /** Milliseconds since the shell last printed, or null if it never has. */
  idleMs: () => number | null;
  nap: (ms: number) => Promise<void>;
  send: (data: string) => void;
  /** What the terminal currently shows on the cursor's row. */
  lineText: () => string;
  /** Tell the user, in the terminal, that nothing was run. */
  note: (msg: string) => void;
  /** False once the session is gone; nothing may be sent after that. */
  alive: () => boolean;
};

/** How quiet the shell has to be before it counts as ready, in ms. */
export const AUTOTYPE_QUIET = 400;
/** Give up waiting for quiet after this long and type anyway, in ms. */
export const AUTOTYPE_WAIT = 10_000;
/** How long to let the typed line echo back before reading it, in ms. */
export const AUTOTYPE_ECHO = 150;

export type AutotypeResult = "ran" | "held" | "aborted";

export async function autotypeLine(
  line: string,
  io: AutotypeIO,
): Promise<AutotypeResult> {
  const until = AUTOTYPE_WAIT;
  let waited = 0;
  for (;;) {
    await io.nap(100);
    waited += 100;
    if (!io.alive()) return "aborted";
    const idle = io.idleMs();
    if (idle != null && idle >= AUTOTYPE_QUIET) break;
    if (waited >= until) break;
  }
  io.send("\u0015" + line);
  await io.nap(AUTOTYPE_ECHO);
  if (!io.alive()) return "aborted";
  if (io.lineText().trimEnd().endsWith(line)) {
    io.send("\r");
    return "ran";
  }
  io.note(
    "The shell was busy, so this line did not arrive intact and was not run. " +
      "Press Enter to run it as shown, or clear it and try again.",
  );
  return "held";
}
