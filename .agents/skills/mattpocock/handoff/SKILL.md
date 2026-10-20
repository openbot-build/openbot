---
argument-hint: What will the next session be used for?
description: Compact the current conversation into a handoff document for another agent to pick up.
disable-model-invocation: true
metadata:
    github-path: skills/productivity/handoff
    github-ref: refs/tags/v1.3.1
    github-repo: https://github.com/mattpocock/skills
    github-tree-sha: 2242e8f05424b8c2ae94194a90d97b88d16108ec
name: handoff
---
Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
