// Prints an Argon2id hash as a ready-to-paste .env line.
// The password comes from a hidden prompt, or from stdin when piped.
import { createInterface } from "node:readline";
import { hash } from "@node-rs/argon2";

function ask() {
  if (!process.stdin.isTTY) {
    const lines = createInterface({ input: process.stdin });
    return new Promise((resolve) => {
      let first;
      lines.on("line", (line) => { first ??= line; });
      lines.on("close", () => resolve(first ?? ""));
    });
  }
  process.stderr.write("Password: ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve) => {
    let value = "";
    process.stdin.on("data", (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stderr.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    });
  });
}

const password = await ask();
if (!password) {
  console.error("Empty password.");
  process.exit(1);
}
const encoded = await hash(password, { algorithm: 2 }); // 2 = Argon2id
// Compose expands $ signs. In .env single quotes prevent that, and in an
// environment: list each $ is doubled instead. Quotes there would join the value.
console.log(`# For .env:\nLIVE_ADMIN_PASSWORD_HASH='${encoded}'`);
console.log(`# For an environment: list in a compose file:\n- LIVE_ADMIN_PASSWORD_HASH=${encoded.replaceAll("$", "$$$$")}`);
