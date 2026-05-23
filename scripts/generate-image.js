const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) {
    return "";
  }
  return process.argv[index + 1];
}

function envBool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return !["0", "false", "no"].includes(String(value).toLowerCase());
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function todayLocal() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, "utf8");
}

function safeText(value, max = 500) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function apiBase() {
  return String(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function apiKey() {
  return process.env.OPENAI_IMAGE_API_KEY || process.env.OPENAI_API_KEY || "";
}

async function postJSON(url, body) {
  const key = apiKey();
  if (!key) {
    throw new Error("missing OPENAI_IMAGE_API_KEY or OPENAI_API_KEY");
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const message = data && data.error && data.error.message ? data.error.message : text;
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return data;
}

function imageFromResponses(data) {
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (item.type === "image_generation_call" && item.result) {
      return {
        b64: item.result,
        revisedPrompt: item.revised_prompt || item.revisedPrompt || ""
      };
    }
    const content = Array.isArray(item.content) ? item.content : [];
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const b64 = part.b64_json || part.image_base64 || part.result;
      if (b64) {
        return {
          b64,
          revisedPrompt: part.revised_prompt || part.revisedPrompt || ""
        };
      }
    }
  }
  throw new Error("Responses API returned no image_generation result");
}

function imageFromImages(data) {
  const first = data && Array.isArray(data.data) ? data.data[0] : null;
  if (!first) {
    throw new Error("Images API returned no data item");
  }
  const b64 = first.b64_json || first.image_base64 || first.result;
  if (!b64) {
    throw new Error("Images API returned no base64 image");
  }
  return {
    b64,
    revisedPrompt: first.revised_prompt || first.revisedPrompt || ""
  };
}

async function generateWithResponses(prompt, options) {
  const tool = {
    type: "image_generation",
    size: options.size,
    quality: options.quality
  };
  if (options.outputFormat) {
    tool.output_format = options.outputFormat;
  }
  const body = {
    model: options.responsesModel,
    input: prompt,
    tools: [tool]
  };
  const data = await postJSON(`${apiBase()}/responses`, body);
  const image = imageFromResponses(data);
  return {
    ...image,
    model: options.responsesModel,
    mode: "responses"
  };
}

async function generateWithImages(prompt, options) {
  const body = {
    model: options.imagesModel,
    prompt,
    size: options.size,
    quality: options.quality,
    response_format: "b64_json"
  };
  try {
    const data = await postJSON(`${apiBase()}/images/generations`, body);
    const image = imageFromImages(data);
    return {
      ...image,
      model: options.imagesModel,
      mode: "images"
    };
  } catch (err) {
    if (!String(err.message || "").includes("response_format")) {
      throw err;
    }
    delete body.response_format;
    const data = await postJSON(`${apiBase()}/images/generations`, body);
    const image = imageFromImages(data);
    return {
      ...image,
      model: options.imagesModel,
      mode: "images"
    };
  }
}

async function generate(prompt, options) {
  if (options.mode === "responses") {
    return generateWithResponses(prompt, options);
  }
  if (options.mode === "images") {
    return generateWithImages(prompt, options);
  }
  try {
    return await generateWithResponses(prompt, options);
  } catch (err) {
    if (!options.autoFallback) {
      throw err;
    }
    const fallback = await generateWithImages(prompt, options);
    fallback.fallbackReason = err.message;
    return fallback;
  }
}

async function main() {
  const workspace = path.resolve(argValue("--workspace") || process.cwd());
  const prompt = safeText(argValue("--prompt"), 4000);
  if (!prompt) {
    throw new Error("missing --prompt");
  }

  const options = {
    mode: String(process.env.ONEBOT_IMAGE_API_MODE || "auto").toLowerCase(),
    responsesModel: process.env.ONEBOT_IMAGE_RESPONSES_MODEL || process.env.ONEBOT_IMAGE_MODEL || "gpt-5.5",
    imagesModel: process.env.ONEBOT_IMAGE_IMAGES_MODEL || "gpt-image-1",
    size: process.env.ONEBOT_IMAGE_SIZE || "1024x1024",
    quality: process.env.ONEBOT_IMAGE_QUALITY || "medium",
    outputFormat: process.env.ONEBOT_IMAGE_OUTPUT_FORMAT || "png",
    autoFallback: envBool("ONEBOT_IMAGE_AUTO_FALLBACK", true)
  };

  const result = await generate(prompt, options);
  const dir = path.join(workspace, "local_files", "generated", "images");
  ensureDir(dir);
  const hash = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 8);
  const fileName = `image-${timestampSlug()}-${hash}.png`;
  const imagePath = path.join(dir, fileName);
  fs.writeFileSync(imagePath, Buffer.from(result.b64, "base64"));

  const relativePath = path.relative(workspace, imagePath).replace(/\\/g, "/");
  const event = {
    time: new Date().toISOString(),
    type: "image_generation",
    group_id: process.env.QQ_IMAGE_GROUP_ID || "",
    message_id: process.env.QQ_IMAGE_MESSAGE_ID || "",
    user_id: process.env.QQ_IMAGE_USER_ID || "",
    mode: result.mode,
    model: result.model,
    size: options.size,
    quality: options.quality,
    prompt,
    revised_prompt: result.revisedPrompt || "",
    file: relativePath,
    fallback_reason: result.fallbackReason || ""
  };

  appendLine(path.join(workspace, "memory", `image-events-${todayLocal()}.jsonl`), JSON.stringify(event));
  appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} AI 生图: ${relativePath} (${result.model}; ${options.size}; ${options.quality})`);

  process.stdout.write(JSON.stringify({
    imagePath,
    relativePath,
    model: result.model,
    mode: result.mode,
    revisedPrompt: result.revisedPrompt || ""
  }));
}

main().catch((err) => {
  process.stderr.write(`${err.message || err}\n`);
  process.exit(1);
});
