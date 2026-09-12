# Telegram Bot Setup Guide

## 1. Create the bot with BotFather

1. Search for [@BotFather](https://t.me/BotFather) in Telegram
2. Enter the `/newbot` command
3. Set the bot name and username
4. Save the issued **API Token**

## 2. Environment setup

### Option A: Environment variables (recommended)
```bash
export TELEGRAM_BOT_TOKEN="your-bot-token-here"
export ANTHROPIC_API_KEY="your-anthropic-key"
```

### Option B: .env file
```
# bot/.env
TELEGRAM_BOT_TOKEN=your-bot-token-here
ANTHROPIC_API_KEY=your-anthropic-key
```

### Option C: config.json
```json
{
  "telegram_bot_token": "your-bot-token-here",
  "claude_api_key": "your-anthropic-key",
  "vault_path": "C:/path/to/your/vault",
  "telegram_model": "claude-sonnet-4-20250514"
}
```

## 3. Run

```bash
cd bot
pip install -r requirements.txt
python telegram_bot.py
```

## 4. Bot commands (register with BotFather)

Register the following via `/setcommands` in BotFather:

```
ask - Ask the AI (e.g. /ask chief summarize issues)
search - Search vault documents
debate - Multi-persona debate
mirofish - MiroFish simulation
help - Help
```

## 5. Usage

| Command | Description | Example |
|--------|------|------|
| `/ask [persona] question` | Persona RAG query | `/ask art analyze character concept` |
| `/search keyword` | Vault search | `/search balance patch` |
| `/debate topic` | 4-person debate | `/debate PvP system` |
| `/mirofish topic` | Simulation | `/mirofish team dynamics` |
| Plain message | chief responds | `Summarize this sprint` |

## 6. Personas

| Tag | Aliases | Role |
|------|------|------|
| `chief` | PM, 수석, 디렉터 | Project lead |
| `art` | 아트 | Art direction |
| `spec` | 기획 | Game design / level design |
| `tech` | 기술, 프로그 | Programming / tech |

## 7. Electron integration

When the Strata Sync Electron app is running, the Electron RAG API is used automatically.
When the app is not running, it falls back to the local rag_simple.
