import { createInterface } from 'node:readline';

/** BWALLETX_PASSPHRASE, else a hidden prompt on a TTY. Never logged or stored. */
export async function getPassphrase(prompt = 'Passphrase: '): Promise<string> {
  const env = process.env.BWALLETX_PASSPHRASE;
  if (env) return env;
  if (!process.stdin.isTTY) throw new Error('No passphrase: set BWALLETX_PASSPHRASE or run in a terminal');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let shown = false;
    out._writeToOutput = (s: string) => {
      if (!shown) {
        process.stderr.write(s);
        shown = true;
      }
    };
    rl.question(prompt, (a) => {
      rl.close();
      process.stderr.write('\n');
      resolve(a);
    });
  });
}

export async function confirm(q: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((r) => rl.question(`${q} [y/N] `, (a) => (rl.close(), r(/^y(es)?$/i.test(a.trim())))));
}
