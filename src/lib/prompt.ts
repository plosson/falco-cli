import { createInterface } from "node:readline";

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

export async function promptHidden(question: string): Promise<string> {
  process.stdout.write(question);
  // Put stdin in raw mode to capture keystrokes without echo.
  const stdin = process.stdin;
  const wasRaw = stdin.isTTY && stdin.isRaw === true;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();

  let chars = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (buf: Buffer) => {
        for (const byte of buf) {
          // Enter -> done
          if (byte === 0x0a || byte === 0x0d) {
            process.stdout.write("\n");
            stdin.off("data", onData);
            resolve();
            return;
          }
          // Ctrl-C -> cancel
          if (byte === 0x03) {
            stdin.off("data", onData);
            reject(new Error("cancelled"));
            return;
          }
          // Backspace / Delete
          if (byte === 0x7f || byte === 0x08) {
            chars = chars.slice(0, -1);
            continue;
          }
          chars += String.fromCharCode(byte);
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    if (stdin.isTTY) stdin.setRawMode(wasRaw);
    stdin.pause();
  }
  return chars;
}

export async function promptChoice<T>(
  question: string,
  items: T[],
  label: (item: T) => string,
): Promise<T> {
  if (items.length === 0) throw new Error("No choices");
  if (items.length === 1) return items[0]!;

  process.stdout.write(question + "\n");
  for (let i = 0; i < items.length; i++) {
    process.stdout.write(`  [${i + 1}] ${label(items[i]!)}\n`);
  }
  while (true) {
    const answer = (await prompt(`Choose 1-${items.length}: `)).trim();
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!;
    process.stdout.write("  Invalid choice.\n");
  }
}
