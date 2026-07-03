# Voice to ClickUp

A web app for speaking work notes, turning them into structured task drafts, and sending approved or manual tasks to ClickUp.

## Secure Multi-User Mode

The app supports Supabase Auth for multiple users. In this mode, each signed-in user saves their own OpenAI API key, ClickUp API token, and ClickUp list ID. Those credentials are encrypted on the server before they are stored in Supabase.

1. In Supabase, open SQL Editor and run `supabase/schema.sql`.
2. In Vercel, add these environment variables:

```bash
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APP_ENCRYPTION_KEY=
OPENAI_TASK_MODEL=gpt-5.5
OPENAI_TRANSCRIPTION_LANGUAGE=en
```

3. Generate `APP_ENCRYPTION_KEY` as a long random secret. A 32-byte base64 value is ideal.
4. Redeploy Vercel.
5. Users can create an account, sign in, and save their own API keys from Settings.

Do not expose `SUPABASE_SERVICE_ROLE_KEY` in browser code. It belongs in Vercel environment variables only.

## Local Setup

1. Copy `.env.example` to `.env`.
2. Add Supabase values for multi-user mode, or add the old OpenAI/ClickUp fallback values for local single-user mode.
3. Run:

```bash
npm start
```

4. Open `http://localhost:3000`.

## Vercel Environment Variables

Required for multi-user login mode:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `APP_ENCRYPTION_KEY`

Optional app settings:

- `OPENAI_TRANSCRIPTION_LANGUAGE` optional, defaults to `en`
- `OPENAI_TASK_MODEL` optional, defaults to `gpt-5.5`
- `CLICKUP_DEFAULT_ASSIGNEE_ID` optional

Legacy single-user fallback, used only if Supabase auth mode is not fully configured:

- `OPENAI_API_KEY`
- `CLICKUP_API_TOKEN`
- `CLICKUP_LIST_ID`

Never commit `.env` or real API keys to GitHub.

## API Surface

- `GET /api/session` returns auth/session and credential status.
- `POST /api/auth/signup` creates a Supabase Auth account.
- `POST /api/auth/login` signs in and sets HTTP-only cookies.
- `POST /api/auth/logout` clears the session cookies.
- `GET /api/user/credentials` returns saved/not-saved status only.
- `POST /api/user/credentials` encrypts and saves user API credentials.
- `GET /api/realtime/token` creates a short-lived OpenAI Realtime browser credential.
- `POST /api/tasks/extract` turns transcript text into task drafts.
- `POST /api/clickup/tasks` creates a ClickUp task.
- `POST /mcp` exposes a lightweight JSON-RPC `create_clickup_task` tool shape for legacy env-based usage.
