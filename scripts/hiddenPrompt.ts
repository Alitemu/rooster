/**
 * Asking for a new password on the server's terminal without showing it
 * (scripts/reset-password.ts, scripts/create-account.ts). With no terminal
 * it reads NIEUW_WACHTWOORD from the environment instead - never a
 * command-line argument, which every process on the host could read.
 */

/** Reads one line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (char: string) => {
      for (const c of char) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (c === '\u0003') {
          // Ctrl+C
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') input = input.slice(0, -1);
        else input += c;
      }
    };
    stdin.on('data', onData);
  });
}

export async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const fromEnv = process.env.NIEUW_WACHTWOORD;
    if (!fromEnv) {
      console.error('Geen terminal: zet het nieuwe wachtwoord in NIEUW_WACHTWOORD.');
      process.exit(1);
    }
    return fromEnv;
  }
  const first = await askHidden('Nieuw wachtwoord: ');
  const second = await askHidden('Nog een keer: ');
  if (first !== second) {
    console.error('De twee wachtwoorden zijn niet gelijk. Er is niets veranderd.');
    process.exit(1);
  }
  return first;
}

