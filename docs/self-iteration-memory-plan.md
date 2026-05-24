# QQ Bot Self-Iteration and Memory Rules

## Position

This bot should keep the current NapCat / OneBot + onebot-group-proxy + cc-connect architecture.
The goal is a low-friction full-feature assistant for known QQ groups and private users.

Memory should not depend on an LLM for every message. Deterministic code handles common,
repeatable work. Models are reserved for high-value summarization, rule review, and code
improvement proposals.

## Deterministic Layer

Code owns:

- `/记住`, `/忘记`, `/记忆`, and `/记忆 状态`.
- Scope routing: group, member, and private workspaces.
- Memory kind classification: `fact`, `preference`, `todo`, `project`, `joke`, `boundary`, `note`.
- Tags, normalized text, fingerprints, dedupe, soft deletes, and keyword search.
- File metadata, recent file lookup, parser paths, and upload context.
- Group trigger rules, quiet mode, admin checks, and route state.

## Model Review Layer

The model may suggest:

- Better memory classification regexes.
- Better command text and help output.
- New tests for edge cases.
- Small patches for command behavior, file indexing, and memory rules.

The model must not automatically:

- Edit secrets, env files, tokens, cookies, or provider keys.
- Enable cross-group search by default.
- Restart services, reload production, or deploy without tests.
- Run heavy always-on embeddings, local models, or per-message summarization.
- Apply self-generated patches without review.

## Iteration Loop

Each meaningful round should:

1. Implement a small deterministic improvement.
2. Ask a `gpt-5.5` xhigh sub-agent to review ideas against this plan.
3. Accept only ideas that fit the current architecture and server budget.
4. Add or update tests.
5. Run the local test suite before deployment.
6. Deploy only after the current server state remains healthy.

## Server Budget

Avoid always-on heavy workloads. Prefer JSONL, Markdown, and small local indexes. Use LLM calls
only for explicit commands like `/dream`, admin review, or user-requested complex answers.
