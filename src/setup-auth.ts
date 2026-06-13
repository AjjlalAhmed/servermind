// Interactive enrollment for ServerMind 2FA.
//   bun run setup-auth
// Sets an admin password (argon2id) and a TOTP secret, shows a QR to scan into
// an authenticator app, verifies a live code, then writes both to .env.

import { createInterface } from "node:readline";
import QRCode from "qrcode";
import { generateSecret, otpauthURL, verifyTotp } from "./auth/totp.ts";

const ENV_PATH = new URL("../.env", import.meta.url).pathname;

function ask(query: string, hidden = false): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (hidden) {
      // Print the prompt ourselves, THEN swallow all echo so keystrokes stay
      // hidden. (Overriding _writeToOutput before question() would also eat the
      // prompt text — which is the bug this replaces.)
      process.stdout.write(query);
      (rl as any)._writeToOutput = () => {};
      rl.question("", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
    } else {
      rl.question(query, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function upsertEnv(updates: Record<string, string>) {
  let content = "";
  try {
    content = await Bun.file(ENV_PATH).text();
  } catch {
    /* new file */
  }
  const lines = content.length ? content.split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  await Bun.write(ENV_PATH, lines.join("\n").replace(/\n*$/, "\n"));
  // tighten perms — secrets live here
  await Bun.spawn(["chmod", "600", ENV_PATH]).exited;
}

async function main() {
  console.log("\n  ServerMind — 2FA setup\n  ──────────────────────\n");

  // 1) password
  let password = "";
  for (;;) {
    password = await ask("  Choose an admin password: ", true);
    if (password.length < 8) {
      console.log("  ✗ Too short — use at least 8 characters.\n");
      continue;
    }
    const confirm = await ask("  Confirm password:         ", true);
    if (password !== confirm) {
      console.log("  ✗ Passwords didn't match, try again.\n");
      continue;
    }
    break;
  }
  const passwordHash = await Bun.password.hash(password, "argon2id");

  // 2) TOTP secret + QR
  const secret = generateSecret();
  const label = (await ask("  Account label for the app [admin@servermind]: ")) || "admin@servermind";
  const url = otpauthURL(secret, label);

  console.log("\n  Scan this QR with Google Authenticator / Authy / 1Password:\n");
  console.log(await QRCode.toString(url, { type: "terminal", small: true }));
  console.log(`  Or enter this key manually:  ${secret}\n`);

  // 3) verify enrollment so you can't lock yourself out
  for (;;) {
    const code = await ask("  Enter the 6-digit code from your app to confirm: ");
    if (verifyTotp(secret, code)) {
      console.log("  ✓ Code verified.\n");
      break;
    }
    console.log("  ✗ Didn't match — wait for the next code and try again.\n");
  }

  // 4) persist. Base64-encode the argon2 hash so its `$` characters survive
  //    Bun's .env variable expansion (which would otherwise corrupt it).
  await upsertEnv({
    SERVERMIND_PASSWORD_HASH: Buffer.from(passwordHash, "utf8").toString("base64"),
    SERVERMIND_TOTP_SECRET: secret,
  });

  console.log(`  ✓ Saved to ${ENV_PATH} (chmod 600).`);
  console.log("  Restart ServerMind and log in with your password + a fresh code.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error("setup-auth failed:", e);
  process.exit(1);
});
