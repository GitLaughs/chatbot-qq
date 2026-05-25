"use strict";

const { processPendingCandidatesBatch, readPendingCandidates } = require("./memory-store");

function deterministicTidy({ workspace, actedBy = "memory-tidy" }) {
  const results = { deduped: 0, expired: 0, skipped: 0, tidied_at: new Date().toISOString() };

  const candidates = readPendingCandidates({ workspace });
  const seenFingerprints = new Set();
  const seenTexts = new Set();
  const skipIndexes = new Set();

  candidates.forEach((candidate, index) => {
    const fingerprint = candidate.fingerprint || "";
    const textKey = `${candidate.kind}:${String(candidate.text || "").toLowerCase().trim()}`;
    if (fingerprint && seenFingerprints.has(fingerprint)) {
      skipIndexes.add(index + 1);
      results.deduped += 1;
    } else if (textKey.length > 3 && seenTexts.has(textKey)) {
      skipIndexes.add(index + 1);
      results.deduped += 1;
    } else {
      if (fingerprint) seenFingerprints.add(fingerprint);
      seenTexts.add(textKey);
    }
  });

  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600000;
  candidates.forEach((candidate, index) => {
    if (candidate.kind === "todo" && !candidate.applied_at && !candidate.skipped_at) {
      const created = new Date(candidate.created_at || candidate.source_time || 0).getTime();
      if (created < thirtyDaysAgo && created > 0) {
        skipIndexes.add(index + 1);
        results.expired += 1;
      }
    }
  });

  if (skipIndexes.size > 0) {
    const batch = processPendingCandidatesBatch({
      workspace,
      skipSelector: [...skipIndexes].sort((a, b) => a - b).join(","),
      actedBy
    });
    results.skipped = batch.skipped || 0;
  }

  return results;
}

function checkReflectionTriggers({ messagesSinceLastReflection = 0, hoursSinceLastReflection = 0 }) {
  const tidyInterval = Number(process.env.CHATBOT_QQ_MEMORY_TIDY_INTERVAL_MSGS || 100);
  const l1Interval = Number(process.env.CHATBOT_QQ_MEMORY_REFLECT_INTERVAL_HOURS || 6);
  const l2Interval = Number(process.env.CHATBOT_QQ_MEMORY_DEEP_REFLECT_INTERVAL_HOURS || 24);

  return {
    needsL0: messagesSinceLastReflection >= tidyInterval,
    needsL1: hoursSinceLastReflection >= l1Interval,
    needsL2: hoursSinceLastReflection >= l2Interval
  };
}

module.exports = {
  deterministicTidy,
  checkReflectionTriggers
};
