import { emit, fail, JanusError } from "./output.ts";

type Handler = (verb: string | undefined, argv: string[]) => Promise<unknown>;

const NOUNS: Record<string, () => Promise<{ handle: Handler }>> = {};

async function main(): Promise<void> {
  const [noun, verb, ...rest] = process.argv.slice(2);
  if (noun === undefined || noun === "--help") {
    throw new JanusError("VALIDATION", `usage: janus <noun> <verb> [flags]; nouns: ${Object.keys(NOUNS).join(", ")}`);
  }
  const load = NOUNS[noun];
  if (load === undefined) {
    throw new JanusError("VALIDATION", `unknown command "${noun}"; nouns: ${Object.keys(NOUNS).join(", ")}`);
  }
  const mod = await load();
  emit(await mod.handle(verb, rest));
}

main().catch(fail);
