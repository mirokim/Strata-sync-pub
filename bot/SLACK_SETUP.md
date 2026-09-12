# Strata Sync Slack Bot Setup Guide

## Prerequisites

- Python 3.11+
- `pip install slack-bolt slack-sdk requests`
- Slack workspace admin permissions

---

## 1. Create the Slack app

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. App Name: `Strata Sync` (or any name you like)
3. Select the workspace, then **Create App**

---

## 2. Configure permissions (Scopes)

**OAuth & Permissions** → add the following scopes under **Bot Token Scopes**:

| Scope | Purpose |
|---|---|
| `app_mentions:read` | Receive channel mentions |
| `chat:write` | Send messages |
| `chat:write.customize` | Update the thinking message |
| `im:history` | Read DM messages |
| `im:read` | DM channel info |
| `im:write` | Send DM messages |
| `channels:history` | Channel message history |
| `groups:history` | Private channel history |
| `files:read` | Read attached images (Vision) |
| `files:write` | Upload images (send vault images) |

---

## 3. Enable Socket Mode

**Socket Mode** → toggle **Enable Socket Mode** ON

→ In the App-Level Token creation popup:
- Token Name: `socket-token`
- Scope: `connections:write`
- **Generate** → copy the token (`xapp-1-...`)

This is the **App Token**.

---

## 4. Configure Event Subscriptions

**Event Subscriptions** → **Enable Events** ON

Add under **Subscribe to bot events**:
- `app_mention` — @bot mentions in channels
- `message.im` — DM messages
- `app_home_opened` — Home tab opened

---

## 5. Configure App Home (optional)

**App Home** → **Home Tab** Enable → **Messages Tab** Enable

---

## 6. Install the app

**Install App** → **Install to Workspace** → allow permissions

After installing, copy the **Bot User OAuth Token** (`xoxb-...`)

This is the **Bot Token**.

---

## 7. Configure Strata Sync

In-app Settings → **Slack Bot** tab:

| Field | Value |
|---|---|
| **Bot Token** | `xoxb-...` (copied in step 6) |
| **App Token** | `xapp-1-...` (copied in step 3) |
| **Response model** | `claude-sonnet-4-6` (default) |

Click **Start** → confirm `✅ Bolt app started` appears in the log

---

## 8. Usage

### In a channel
```
@StrataSync What is the concept of Character A?
@StrataSync [art] Tell me the art direction
@StrataSync Show me an image of Character A
```

### In a DM
```
Explain Character A's skills
[spec] Summarize the February spec
Is there an image of the background illustration
```

### Persona tags
| Tag | Persona |
|---|---|
| `[chief]` or no tag | Chief Director |
| `[art]` | Art Director |
| `[spec]` | Design Director |
| `[tech]` | Programming Director |

### Image features
- **Automatic**: when answering, images referenced as `![[image.png]]` in the relevant documents are attached automatically
- **Explicit search**: when the message contains keywords such as "이미지 보여줘", "이미지 있어", "사진 보여줘" (show/have image, show photo), the vault is searched by file name and matching files are attached
- **Vision**: when the user attaches an image, Claude analyzes it and answers

---

## 9. Enterprise Grid environments (when image download fails)

When image URLs are blocked by SSO in enterprise Slack, the bot automatically falls back to thumbnail URLs.
If it still fails, beyond the `files:read` scope, ask the workspace admin to check the file access policy.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot does not respond | Electron app is not running | Launch the Strata Sync app and load the vault |
| `❌ Start failed` | Token error | Re-check the Bot/App Token |
| Image upload fails | `files:write` scope missing | Add the scope from step 2 and reinstall |
| Vision analysis not working | Anthropic API key missing | Enter the key in Settings → AI tab |
| Slow answers | RAG + LLM processing time | Normal (about 10–30 s), up to 90 s with Vision |
