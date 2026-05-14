# Repo Agent Example

This project now includes a small read-only agent CLI that can inspect the codebase with local tools.

## Run It

```bash
npm run agent:repo -- "ไฟล์ไหนเป็นจุดเริ่มต้นของ law chatbot?"
```

## What It Can Do

- `list_files` to find relevant files
- `search_repo` to search text across the repository
- `read_file` to inspect specific file sections
- `git_status` to see the current working tree state

## Notes

- The agent uses the same OpenAI environment variables as the rest of the app.
- It is intentionally read-only so it can be used safely as a project navigator and explainer.
