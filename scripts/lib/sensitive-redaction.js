const SECRET_KEY_PATTERN = "(?:[a-z0-9]+[_-])*api[_-]?(?:key|token)|access[_-]?token|refresh[_-]?token|auth[_-]?token|bot[_-]?token|client[_-]?secret|session[_-]?cookie|private[_-]?key|password|token|cookie|secret|authorization";

function redactSecrets(value) {
  const key = SECRET_KEY_PATTERN;
  return String(value || "")
    .replace(new RegExp(`"((?:${key}))"\\s*:\\s*"[^"]*"`, "ig"), "\"$1\":\"***\"")
    .replace(new RegExp(`"((?:${key}))"\\s*:\\s*'[^']*'`, "ig"), "\"$1\":\"***\"")
    .replace(new RegExp(`"((?:${key}))"\\s*:\\s*[^,\\s}\\]]+`, "ig"), "\"$1\":\"***\"")
    .replace(new RegExp(`(${key})\\s*[:=]\\s*"[^"]*"(:\\d+)?(?=$|[\\s,，;；])`, "ig"), "$1=***$2")
    .replace(new RegExp(`(${key})\\s*[:=]\\s*'[^']*'(:\\d+)?(?=$|[\\s,，;；])`, "ig"), "$1=***$2")
    .replace(new RegExp(`(${key})\\s*[:=]\\s*"([^\\r\\n,，;；]*?)(:\\d+)?(?=$|[\\r\\n,，;；])`, "ig"), "$1=***$3")
    .replace(new RegExp(`(${key})\\s*[:=]\\s*'([^\\r\\n,，;；]*?)(:\\d+)?(?=$|[\\r\\n,，;；])`, "ig"), "$1=***$3")
    .replace(/\bBearer[ \t]+([^\s,，;；]+?)(:\d+)?(?=$|[\s,，;；])/ig, "Bearer ***$2")
    .replace(new RegExp(`(${key})\\s*[:=]\\s*([^\\s,，;；]+?)(:\\d+)?(?=$|[\\s,，;；])`, "ig"), "$1=***$3")
    .replace(new RegExp(`(${key})\\s*(是|为|叫)\\s*([^\\s,，;；]+?)(:\\d+)?(?=$|[\\s,，;；])`, "ig"), "$1 $2 ***$4")
    .replace(/sk-[a-z0-9_-]{8,}/ig, "sk-***");
}

function maskSensitive(value) {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return redactSecrets(value);
  }
  if (value && typeof value === "object") {
    try {
      return redactSecrets(JSON.stringify(value));
    } catch {
      return "[object]";
    }
  }
  return value;
}

function looksSensitive(value) {
  let text;
  if (value && typeof value === "object") {
    try {
      text = JSON.stringify(value);
    } catch {
      return false;
    }
  } else {
    text = String(value || "");
  }
  return redactSecrets(text) !== text;
}

module.exports = {
  looksSensitive,
  maskSensitive,
  redactSecrets
};
