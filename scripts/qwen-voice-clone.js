const fs = require("node:fs");
const path = require("node:path");

loadEnvFile(path.resolve(__dirname, "..", ".env"));

const supportedMimeTypes = new Map([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"]
]);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const args = {
    file: "",
    name: process.env.QWEN_TTS_PREFERRED_NAME || "mowan",
    model: process.env.QWEN_TTS_CLONE_MODEL || "qwen3-tts-vc-2026-01-22",
    region: process.env.QWEN_TTS_REGION || "beijing",
    dryRun: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--dry-run") {
      args.dryRun = true;
      continue;
    }
    if (item === "--file") {
      args.file = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (item === "--name") {
      args.name = argv[index + 1] || args.name;
      index += 1;
      continue;
    }
    if (item === "--model") {
      args.model = argv[index + 1] || args.model;
      index += 1;
      continue;
    }
    if (item === "--region") {
      args.region = argv[index + 1] || args.region;
      index += 1;
      continue;
    }
    if (!item.startsWith("--") && !args.file) {
      args.file = item;
    }
  }

  return args;
}

function customizationUrl(region) {
  return String(region).toLowerCase() === "singapore"
    ? "https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization"
    : "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization";
}

function validateAudioFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Audio file does not exist: ${resolved}`);
  }

  const ext = path.extname(resolved).toLowerCase();
  const mimeType = supportedMimeTypes.get(ext);
  if (!mimeType) {
    throw new Error(`Unsupported audio format: ${ext || "(none)"}. Use WAV, MP3, or M4A.`);
  }

  const stat = fs.statSync(resolved);
  const maxBytes = 10 * 1024 * 1024;
  if (!stat.isFile()) {
    throw new Error(`Audio path is not a file: ${resolved}`);
  }
  if (stat.size > maxBytes) {
    throw new Error("Audio file is larger than 10MB. Trim or compress it first.");
  }

  return {
    resolved,
    mimeType,
    sizeBytes: stat.size
  };
}

async function createVoice({ apiKey, audio, name, model, region }) {
  const audioBase64 = fs.readFileSync(audio.resolved).toString("base64");
  const response = await fetch(customizationUrl(region), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "qwen-voice-enrollment",
      input: {
        action: "create",
        target_model: model,
        preferred_name: name,
        audio: {
          data: `data:${audio.mimeType};base64,${audioBase64}`
        }
      }
    })
  });

  const responseText = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(responseText);
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error?.message || responseText || response.statusText;
    throw new Error(`DashScope ${response.status}: ${message}`);
  }

  const voice = payload?.output?.voice;
  if (!voice) {
    throw new Error(`DashScope did not return output.voice: ${responseText}`);
  }

  return {
    voice,
    requestId: payload?.request_id || payload?.requestId || null
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    throw new Error(
      "Usage: pnpm clone:voice -- --file ./voice-samples/sample.mp3 --name mowan"
    );
  }

  const audio = validateAudioFile(args.file);
  console.log(`Audio: ${audio.resolved}`);
  console.log(`Size: ${(audio.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Target model: ${args.model}`);
  console.log(`Region: ${args.region}`);

  if (args.dryRun) {
    console.log("Dry run passed. No audio was uploaded.");
    return;
  }

  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_TTS_API_KEY || "";
  if (!apiKey) {
    throw new Error("Missing DASHSCOPE_API_KEY in .env or current shell.");
  }

  const result = await createVoice({
    apiKey,
    audio,
    name: args.name,
    model: args.model,
    region: args.region
  });

  console.log("Voice clone created.");
  if (result.requestId) {
    console.log(`Request ID: ${result.requestId}`);
  }
  console.log(`QWEN_TTS_CLONE_MODEL=${args.model}`);
  console.log(`QWEN_TTS_VOICE=${result.voice}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
