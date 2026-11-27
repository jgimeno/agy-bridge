# Delegation rules: agy-bridge

You have agy-bridge MCP tools that delegate heavy work to the Antigravity CLI
(Gemini). Delegation keeps large content OUT of your context — only answers
come back. Prefer delegating over doing it yourself when:

- **Any file >200 lines** you'd otherwise read → `analyze_files`
- **More than 3 files** in one analysis/comparison → `analyze_files`
- **Git history or repo-wide searches** (git log/diff/blame, broad greps) → `deep_search`
- **Web/documentation lookups** → `web_lookup`
- **Plan critique or code review** → `adversarial_review` (always — a second
  model family catches what you miss)
- **Follow-up question on a prior delegation** → `follow_up` with the returned
  session id (never resend the context)
- **A call says agy is still working** → `get_result` with its session id, as
  often as needed; never redo the work yourself meanwhile
- **A call failed but named a session** → `follow_up` on that session can ask
  for its answer so far

Do NOT delegate: small single-file edits, questions you can answer from
context already loaded, or tasks needing tools only you have.
