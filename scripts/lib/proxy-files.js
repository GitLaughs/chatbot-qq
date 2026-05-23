const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function createProxyFiles(deps) {
  const stats = {
    group_uploads: 0,
    download_requests: 0,
    archived: 0,
    pending_metadata: 0,
    parse_success: 0,
    parse_failed: 0,
    save_failed: 0,
    missing_file_id: 0
  };

  function inc(name) {
    stats[name] = (stats[name] || 0) + 1;
  }

  function handleGroupUpload(msg) {
    inc("group_uploads");
    const workspace = deps.workspaceForGroup(msg.group_id);
    const fileInfo = msg.file || {};
    const event = {
      time: new Date().toISOString(),
      type: "group_upload",
      group_id: String(msg.group_id),
      user_id: String(msg.user_id || ""),
      file: fileInfo
    };
    deps.appendLine(path.join(workspace, "memory", `file-events-${deps.todayLocal()}.jsonl`), JSON.stringify(event));
    deps.appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 上传: ${fileInfo.name || fileInfo.id || "unknown"} (${fileInfo.size || "unknown"} bytes)`);

    const fileID = fileInfo.id || fileInfo.file_id;
    if (!fileID) {
      inc("missing_file_id");
      deps.log("group upload no file id", msg.group_id);
      return;
    }
    const echo = `__file_${msg.group_id}_${Date.now()}`;
    deps.pendingFileDownloads.set(echo, { groupID: Number(msg.group_id), fileName: fileInfo.name || fileID, messageID: msg.message_id || "", fileInfo });
    inc("download_requests");
    deps.sendUpstream({
      action: "get_file",
      params: { file_id: String(fileID) },
      echo
    });
    deps.sendGroupText(Number(msg.group_id), msg.message_id || 0, `收到文件：${fileInfo.name || fileID}。正在自动下载归档；需要总结、提取重点或出题复习时直接 @ 我说需求。`);
  }

  function handleGroupFileDownloadResponse(pendingInfo, resp) {
    const data = resp.data || {};
    const source = data.file || data.path || data.url;
    const workspace = deps.workspaceForGroup(pendingInfo.groupID);
    const saved = saveGroupFileData(workspace, pendingInfo, { ...pendingInfo.fileInfo, ...data, source });
    if (saved) {
      deps.appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 已归档: ${saved.relativePath}`);
      inc("archived");
      deps.log("file archived", pendingInfo.groupID, saved.relativePath);
      archiveSavedFile(workspace, saved, pendingInfo).then((result) => {
        if (result && result.notice) {
          deps.sendGroupText(pendingInfo.groupID, pendingInfo.messageID || 0, fileArchiveNotice(saved, result));
        }
      }).catch((err) => {
        inc("parse_failed");
        deps.log("file archive parse failed", pendingInfo.groupID, saved.relativePath, err.message);
        deps.sendGroupText(pendingInfo.groupID, pendingInfo.messageID || 0, `文件已归档，但解析失败：${saved.relativePath}\n${err.message}`);
      });
      return true;
    }
    inc("pending_metadata");
    deps.appendLine(path.join(workspace, "local_files", "INDEX.md"), `- ${new Date().toISOString()} 文件待手动获取: ${pendingInfo.fileName}; get_file=${JSON.stringify(data)}`);
    deps.log("file metadata saved", pendingInfo.groupID, pendingInfo.fileName);
    return false;
  }

  function saveGroupFileData(workspace, pendingInfo, data) {
    const rawName = data.name || data.file_name || pendingInfo.fileName || data.file || data.file_id || `upload-${Date.now()}`;
    const name = deps.safeName(rawName);
    const dir = path.join(workspace, "local_files", "archive", deps.todayLocal());
    deps.ensureDir(dir);
    const target = uniquePath(path.join(dir, name));
    const source = data.source || data.path || data.file || data.url;
    try {
      if (source && typeof source === "string" && fs.existsSync(source)) {
        fs.copyFileSync(source, target);
      } else if (source && /^file:\/\//i.test(source)) {
        fs.copyFileSync(new URL(source), target);
      } else if (source && /^https?:\/\//i.test(source)) {
        execFileSync("curl", ["-fsSL", "-o", target, source], { timeout: 180000 });
      } else {
        return null;
      }
      const relativePath = path.relative(workspace, target).replace(/\\/g, "/");
      deps.appendLine(path.join(workspace, "memory", `file-events-${deps.todayLocal()}.jsonl`), JSON.stringify({
        time: new Date().toISOString(),
        type: "group_file_archived",
        group_id: String(pendingInfo.groupID),
        file: { ...data, local_path: relativePath }
      }));
      return { path: target, relativePath, name: path.basename(target) };
    } catch (err) {
      inc("save_failed");
      deps.log("group file save failed", pendingInfo.groupID, name, err.message);
      return null;
    }
  }

  async function archiveSavedFile(workspace, saved, pendingInfo) {
    const ext = path.extname(saved.path).toLowerCase();
    const sidecarDir = `${saved.path}.archive`;
    deps.ensureDir(sidecarDir);
    const meta = {
      time: new Date().toISOString(),
      group_id: String(pendingInfo.groupID),
      original_name: pendingInfo.fileName,
      file: saved.relativePath,
      size: fs.statSync(saved.path).size,
      parser: "none"
    };

    let extracted = "";
    if (ext === ".pdf") {
      extracted = await deps.extractPdfText(saved.path);
      meta.parser = "pdf-parse";
    } else if ([".txt", ".md", ".csv", ".json", ".log"].includes(ext)) {
      extracted = fs.readFileSync(saved.path, "utf8");
      meta.parser = "text";
    }

    fs.writeFileSync(path.join(sidecarDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    if (extracted) {
      const clean = extracted.replace(/\r\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
      fs.writeFileSync(path.join(sidecarDir, "extracted.txt"), clean, "utf8");
      fs.writeFileSync(path.join(sidecarDir, "summary.md"), deps.buildFileSummary(saved, clean, meta), "utf8");
      deps.appendLine(path.join(workspace, "memory", `file-archive-${deps.todayLocal()}.jsonl`), JSON.stringify({
        time: new Date().toISOString(),
        group_id: String(pendingInfo.groupID),
        file: saved.relativePath,
        extracted_chars: clean.length,
        summary: path.relative(workspace, path.join(sidecarDir, "summary.md")).replace(/\\/g, "/")
      }));
      inc("parse_success");
      return {
        notice: true,
        extractedPath: path.relative(workspace, path.join(sidecarDir, "extracted.txt")).replace(/\\/g, "/")
      };
    }

    inc("parse_success");
    return { notice: false };
  }

  function fileArchiveNotice(saved, result) {
    const lines = [`文件已归档：${saved.relativePath}`];
    if (result && result.extractedPath) {
      lines.push(`已提取文本：${result.extractedPath}`);
    }
    lines.push("需要总结、提取重点、讲某一页或出题复习时，直接 @ 我说需求。");
    return lines.join("\n");
  }

  function uniquePath(target) {
    if (!fs.existsSync(target)) {
      return target;
    }
    const parsed = path.parse(target);
    for (let i = 2; i < 1000; i += 1) {
      const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
      if (!fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
  }

  return {
    stats,
    handleGroupUpload,
    handleGroupFileDownloadResponse,
    saveGroupFileData,
    archiveSavedFile,
    fileArchiveNotice
  };
}

module.exports = { createProxyFiles };
