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
