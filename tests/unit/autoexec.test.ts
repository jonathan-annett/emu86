/**
 * AutoexecRunner unit tests (Phase 14 — boot scripts).
 *
 * Pure text-in/keystrokes-out: feed simulated guest TX, assert what the
 * runner sends and when. The prompt strings mirror real ELKS serial
 * output (getty's `login: `, sh's `# `).
 */

import { describe, it, expect } from 'vitest';
import { AutoexecRunner } from '../../web/autoexec.js';

function makeRunner(script: string): { runner: AutoexecRunner; sent: string[] } {
  const sent: string[] = [];
  const runner = new AutoexecRunner({ script, send: (t) => sent.push(t) });
  return { runner, sent };
}

describe('AutoexecRunner', () => {
  it('types the login/network flow at the right prompts', () => {
    const { runner, sent } = makeRunner('root\nnet start ne0\n');

    runner.feed('ELKS 0.8.0\r\nelks16 login: ');
    expect(sent).toEqual(['root\n']);

    // Guest echoes the login and eventually shows the shell prompt.
    runner.feed('root\r\n');
    expect(sent).toHaveLength(1); // echo alone must not release line 2
    runner.feed('# ');
    expect(sent).toEqual(['root\n', 'net start ne0\n']);
    expect(runner.active).toBe(false);
  });

  it('does not re-fire on the prompt that triggered the previous line', () => {
    const { runner, sent } = makeRunner('echo one\necho two\n');
    runner.feed('# ');
    expect(sent).toEqual(['echo one\n']);
    // No further output: line two must wait for a FRESH prompt.
    runner.feed('');
    expect(sent).toHaveLength(1);
    runner.feed('one\r\n# ');
    expect(sent).toEqual(['echo one\n', 'echo two\n']);
  });

  it('matches a prompt split across two TX chunks', () => {
    const { runner, sent } = makeRunner('root\n');
    runner.feed('elks16 logi');
    expect(sent).toHaveLength(0);
    runner.feed('n: ');
    expect(sent).toEqual(['root\n']);
  });

  it('supports Password: and $ prompts', () => {
    const { runner, sent } = makeRunner('user\nhunter2\nls\n');
    runner.feed('login: ');
    runner.feed('Password: ');
    runner.feed('$ ');
    expect(sent).toEqual(['user\n', 'hunter2\n', 'ls\n']);
  });

  it('@expect makes the next line wait for arbitrary output, not a prompt', () => {
    const { runner, sent } = makeRunner(
      'root\nnet start ne0\n@expect ktcp: ip 10.0.2.\ntelnet 10.0.2.16\n',
    );
    runner.feed('login: ');
    runner.feed('# ');
    expect(sent).toEqual(['root\n', 'net start ne0\n']);
    // A shell prompt alone must NOT release the telnet line...
    runner.feed('Starting daemons\r\n# ');
    expect(sent).toHaveLength(2);
    // ...only the expected ktcp line does.
    runner.feed('ktcp: ip 10.0.2.15, gateway 10.0.2.2\r\n');
    expect(sent).toEqual(['root\n', 'net start ne0\n', 'telnet 10.0.2.16\n']);
  });

  it('skips blank lines, keeps # lines (shell comments type harmlessly)', () => {
    const { runner, sent } = makeRunner('\n\n# join the LAN\n\nnet start ne0\n');
    runner.feed('# ');
    runner.feed('# ');
    expect(sent).toEqual(['# join the LAN\n', 'net start ne0\n']);
  });

  it('goes inert after the last line and ignores further output', () => {
    const { runner, sent } = makeRunner('root\n');
    runner.feed('login: ');
    expect(runner.active).toBe(false);
    runner.feed('login: ');
    runner.feed('# ');
    expect(sent).toEqual(['root\n']);
    expect(runner.sent).toBe(1);
  });

  it('an empty script is inert from the start', () => {
    const { runner, sent } = makeRunner('');
    expect(runner.active).toBe(false);
    runner.feed('login: ');
    expect(sent).toHaveLength(0);
  });

  it('handles CRLF scripts (edited on another platform)', () => {
    const { runner, sent } = makeRunner('root\r\nnet start ne0\r\n');
    runner.feed('login: ');
    runner.feed('# ');
    expect(sent).toEqual(['root\n', 'net start ne0\n']);
  });
});

describe('AutoexecRunner — showcase directives (2026-07-15)', () => {
  interface TypedRig {
    runner: AutoexecRunner;
    sent: string[];
    keys: string[];
    speeds: string[];
    /** Run queued type-timers to completion. */
    drain: () => void;
  }

  function makeTypedRunner(script: string): TypedRig {
    const sent: string[] = [];
    const keys: string[] = [];
    const speeds: string[] = [];
    const queue: Array<() => void> = [];
    const runner = new AutoexecRunner({
      script,
      send: (t) => sent.push(t),
      onKeystroke: (c) => keys.push(c),
      setSpeed: (m) => speeds.push(m),
      schedule: (_ms, fn) => queue.push(fn),
      typeDelayMs: () => 1,
    });
    return {
      runner, sent, keys, speeds,
      drain: () => { while (queue.length > 0) queue.shift()!(); },
    };
  }

  it('@type sends character by character with a keystroke per key', () => {
    const rig = makeTypedRunner('@type\nls -l\n');
    rig.runner.feed('# ');
    rig.drain();
    expect(rig.sent.join('')).toBe('ls -l\n');
    expect(rig.sent.length).toBe(6); // 5 chars + newline, one send each
    expect(rig.keys.join('')).toBe('ls -l'); // newline is not a clack
  });

  it('the guest echo of our own keystrokes never satisfies the next step', () => {
    const rig = makeTypedRunner('@type\necho hi\necho bye\n');
    rig.runner.feed('# ');
    // The guest echoes each character back as we type it. That echo is
    // dropped when the newline commits the command (see #typeOut), so
    // only what the command SAYS can release the next line.
    rig.runner.feed('echo hi');
    rig.drain();
    expect(rig.sent.join('')).toBe('echo hi\n'); // line 2 still waiting
    rig.runner.feed('hi\r\n# ');                  // the command replies
    rig.drain();
    expect(rig.sent.join('')).toBe('echo hi\necho bye\n');
  });

  it('@here block lines flow without prompt waits (the heredoc shape)', () => {
    const rig = makeTypedRunner([
      "cat > h.c << 'EOF'",
      '@here',
      'int main(void)',
      '',
      'EOF',
      '@end',
      'cc h.c',
      '',
    ].join('\n'));
    rig.runner.feed('# ');
    rig.drain();
    // cat line + all three block lines (blank kept) sent with no
    // further prompts; the compile line still waits for a fresh #.
    expect(rig.sent.join('')).toBe("cat > h.c << 'EOF'\nint main(void)\n\nEOF\n");
    rig.runner.feed('# ');
    rig.drain();
    expect(rig.sent.join('')).toContain('cc h.c\n');
  });

  it('@turbo/@authentic fire in script order around the sends', () => {
    const rig = makeTypedRunner('@turbo\nmake\n@authentic\n./hello\n');
    rig.runner.feed('# ');
    rig.drain();
    expect(rig.speeds).toEqual(['turbo']);
    expect(rig.sent.join('')).toBe('make\n');
    rig.runner.feed('# ');
    rig.drain();
    expect(rig.speeds).toEqual(['turbo', 'authentic']);
    expect(rig.sent.join('')).toBe('make\n./hello\n');
  });

  it('@instant returns to whole-line sends', () => {
    const rig = makeTypedRunner('@type\nls\n@instant\npwd\n');
    rig.runner.feed('# ');
    rig.drain();
    rig.runner.feed('# ');
    rig.drain();
    expect(rig.sent).toContain('pwd\n'); // one send, whole line
    expect(rig.keys.join('')).toBe('ls'); // no clacks for instant lines
  });
});

describe('AutoexecRunner — the lost-prompt race (found by the demo probe)', () => {
  it('a prompt arriving DURING the final keystroke delay is not discarded', () => {
    const sent: string[] = [];
    const queue: Array<() => void> = [];
    const runner = new AutoexecRunner({
      script: '@type\necho hi\necho bye\n',
      send: (t) => sent.push(t),
      schedule: (_ms, fn) => queue.push(fn),
      typeDelayMs: () => 1,
    });
    runner.feed('# ');

    // 'echo hi\n' is 8 characters: typeAt(0) ran synchronously, so 7
    // more ticks send the rest — leaving ONLY the completion tick
    // queued. The newline is already out, so the guest runs the
    // command and its whole reply lands inside that final delay.
    for (let i = 0; i < 7; i++) queue.shift()!();
    expect(sent.join('')).toBe('echo hi\n');
    runner.feed('hi\r\n# ');

    // Completion tick fires. Old behavior cleared the buffer here and
    // the script hung forever waiting for a prompt that had already
    // come and gone. Line 2 must now go out.
    queue.shift()!();
    while (queue.length > 0) queue.shift()!();
    expect(sent.join('')).toBe('echo hi\necho bye\n');
  });
});

describe('AutoexecRunner — shell continuation (field lockup, 2026-07-15)', () => {
  it('a backslash-continued command flows through the `> ` prompt', () => {
    const { runner, sent } = makeRunner('c86 -O \\\n    hello.i hello.as\nas hello.as\n');
    runner.feed('# ');
    expect(sent).toEqual(['c86 -O \\\n']);
    // The shell answers a trailing backslash with its continuation
    // prompt — this used to match nothing and lock the script up.
    runner.feed('> ');
    expect(sent).toEqual(['c86 -O \\\n', '    hello.i hello.as\n']);
    runner.feed('# ');
    expect(sent).toHaveLength(3);
  });
});

describe('AutoexecRunner — onDone (field bug: demo never self-retired)', () => {
  it('fires once when a script ENDING IN A TYPED LINE finishes on a timer', () => {
    const queue: Array<() => void> = [];
    let done = 0;
    const runner = new AutoexecRunner({
      script: '@type\n./hello\n',
      send: () => {},
      onDone: () => { done++; },
      schedule: (_ms, fn) => queue.push(fn),
      typeDelayMs: () => 1,
    });
    runner.feed('# ');
    expect(done).toBe(0); // typing in flight — not done yet
    // Completion lands on the final keystroke TIMER, with no feed()
    // ever arriving afterwards — the exact field case.
    while (queue.length > 0) queue.shift()!();
    expect(done).toBe(1);
    expect(runner.active).toBe(false);
    // Later output must not re-fire it.
    runner.feed('hello human\r\n# ');
    expect(done).toBe(1);
  });

  it('fires once for an instant-mode script completing inside feed()', () => {
    let done = 0;
    const runner = new AutoexecRunner({
      script: 'root\n',
      send: () => {},
      onDone: () => { done++; },
    });
    runner.feed('login: ');
    expect(done).toBe(1);
    runner.feed('# ');
    expect(done).toBe(1);
  });
});
