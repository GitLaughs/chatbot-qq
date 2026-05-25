#!/usr/bin/env node
const path = require("path");
const { writeEvidencePacket } = require("./lib/evidence-packet");

const args = parseArgs(process.argv.slice(2));
const workspace = path.resolve(args.workspace || process.cwd());
const output = args.output
  ? path.resolve(workspace, args.output)
  : path.join(workspace, "memory", "dreams", `${stamp()}-evidence.md`);
const sourceMapOutput = args["source-map-output"]
  ? path.resolve(workspace, args["source-map-output"])
  : "";

const packet = writeEvidencePacket({
  workspace,
  purpose: "dream",
  lookbackHours: args["lookback-hours"] || process.env.CHATBOT_QQ_DREAM_LOOKBACK_HOURS || 168,
  maxItemsPerKind: args["max-items-per-kind"] || process.env.CHATBOT_QQ_EVIDENCE_MAX_ITEMS_PER_KIND || 10,
  maxTextChars: args["max-text-chars"] || process.env.CHATBOT_QQ_EVIDENCE_MAX_TEXT_CHARS || 220,
  maxChars: args["max-chars"] || process.env.CHATBOT_QQ_EVIDENCE_MAX_CHARS || 14000,
  output,
  sourceMapOutput
});

console.log(path.relative(workspace, output).replace(/\\/g, "/"));
console.error(`dream evidence packet: scanned=${packet.stats.records_scanned} kept=${packet.stats.records_after_filter} users=${packet.stats.users}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}
