/**
 * Unit coverage for typing a prepared command into a freshly started shell
 * (src/autotype.ts). The bug this guards: oh-my-zsh's periodic update prompt
 * reads a single key, so `tsh login` typed into it became `sh login` and ran
 * /usr/bin/login. Nothing mangled may ever reach Enter.
 * Run: node scripts/smoke-autotype.mjs
 */
import {
  autotypeLine,
  AUTOTYPE_QUIET,
} from "../src/autotype.ts";

let failed = 0;
const ok = (name, cond, detail = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failed++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/** A shell that echoes what it is sent, with a scriptable prompt in the way. */
function fakeShell({ idle, line, alive = () => true }) {
  const sent = [];
  const notes = [];
  let clock = 0;
  return {
    sent,
    notes,
    get clock() {
      return clock;
    },
    io: {
      idleMs: () => idle(clock),
      nap: async (ms) => {
        clock += ms;
      },
      send: (d) => sent.push(d),
      lineText: () => line(sent),
      note: (m) => notes.push(m),
      alive,
    },
  };
}

console.log("autotype");

// 1. A shell that is already quiet: type the line, then Enter.
{
  const sh = fakeShell({
    idle: () => AUTOTYPE_QUIET + 10,
    line: (sent) => "~ ❯ " + sent.join("").replace("\u0015", ""),
  });
  const r = await autotypeLine("tsh login", sh.io);
  ok("quiet shell runs the line", r === "ran", r);
  ok(
    "clears the line editor first",
    sh.sent[0] === "\u0015tsh login",
    JSON.stringify(sh.sent[0]),
  );
  ok("presses Enter last", sh.sent.at(-1) === "\r", JSON.stringify(sh.sent));
}

// 2. A shell still printing its rc output: wait, do not type into it.
{
  // Quiet only after 1.2s of output.
  const sh = fakeShell({
    idle: (clock) => (clock < 1200 ? 0 : AUTOTYPE_QUIET + 10),
    line: (sent) => sent.join("").replace("\u0015", ""),
  });
  const r = await autotypeLine("tsh login", sh.io);
  ok("busy shell is waited out", r === "ran", r);
  ok(
    "nothing typed before it fell quiet",
    sh.clock >= 1200,
    `typed at ${sh.clock}ms`,
  );
}

// 3. The regression: a one-key prompt eats the ^U, the line lands whole.
{
  const sh = fakeShell({
    idle: () => AUTOTYPE_QUIET + 10,
    // The prompt swallows exactly one character — the ^U, not the `t`.
    line: (sent) => "~ ❯ " + sent.join("").slice(1),
  });
  const r = await autotypeLine("tsh login", sh.io);
  ok("a one-key prompt eats the ^U, not the command", r === "ran", r);
  ok("so Enter is still pressed", sh.sent.at(-1) === "\r");
}

// 4. The harm: a mangled line must never be run.
{
  const sh = fakeShell({
    idle: () => AUTOTYPE_QUIET + 10,
    // The ^U got through but the `t` was eaten: `sh login`.
    line: () => "~ ❯ sh login",
  });
  const r = await autotypeLine("tsh login", sh.io);
  ok("a mangled line is held, not run", r === "held", r);
  ok("no Enter was sent", !sh.sent.includes("\r"), JSON.stringify(sh.sent));
  ok("the user is told", sh.notes.length === 1 && /not run/.test(sh.notes[0]));
}

// 5. A closed session sends nothing further.
{
  const sh = fakeShell({
    idle: () => AUTOTYPE_QUIET + 10,
    line: () => "",
    alive: () => false,
  });
  const r = await autotypeLine("tsh login", sh.io);
  ok("a closed session aborts", r === "aborted", r);
  ok("and types nothing", sh.sent.length === 0, JSON.stringify(sh.sent));
}

// 6. A shell that never prints at all still gets its line, eventually.
{
  const sh = fakeShell({
    idle: () => null,
    line: (sent) => sent.join("").replace("\u0015", ""),
  });
  const r = await autotypeLine("kubectl get po", sh.io);
  ok("a silent shell is not waited on forever", r === "ran", r);
  ok("but it is given time", sh.clock >= 10_000, `${sh.clock}ms`);
}

// 7. A line with a trailing-space echo still matches.
{
  const sh = fakeShell({
    idle: () => AUTOTYPE_QUIET + 10,
    line: (sent) => "~ ❯ " + sent.join("").replace("\u0015", "") + "   ",
  });
  ok("trailing echo padding is tolerated", (await autotypeLine("ls -al", sh.io)) === "ran");
}

console.log(failed ? `\nFAILED (${failed})` : "\nPASS");
process.exit(failed ? 1 : 0);
