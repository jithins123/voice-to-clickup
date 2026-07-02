# Voice to ClickUp

A web app for speaking work notes, turning them into structured task drafts, and sending approved tasks to ClickUp.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Add your OpenAI and ClickUp values.
3. Run:

```bash
npm start
```

4. Open `http://localhost:3000`.

## Vercel Environment Variables

Add these in Vercel Project Settings > Environment Variables:

- `OPENAI_API_KEY`
- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`
- `CLICKUP_DEFAULT_ASSIGNEE_ID` optional
- `OPENAI_TRANSCRIPTION_LANGUAGE` optional, defaults to `en`
- `OPENAI_REALTIME_MODEL` optional, defaults to `gpt-realtime-2`
- `OPENAI_TASK_MODEL` optional, defaults to `gpt-5.5`

Never commit `.env` or real API keys to GitHub.

## API Surface

- `GET /api/config` checks whether required server-side config exists.
- `GET /api/realtime/token` creates a short-lived OpenAI Realtime browser credential.
- `POST /api/tasks/extract` turns transcript text into task drafts.
- `POST /api/clickup/tasks` creates a ClickUp task.
- `POST /mcp` exposes a lightweight JSON-RPC `create_clickup_task` tool shape.
