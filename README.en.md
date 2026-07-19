# ChatKJB

[![한국어](https://img.shields.io/badge/%EC%96%B8%EC%96%B4-%ED%95%9C%EA%B5%AD%EC%96%B4-6b7280?style=for-the-badge)](README.md)
[![English](https://img.shields.io/badge/Language-English-0b5fff?style=for-the-badge)](README.en.md)

> Questions? Email **contact@kimjb.com**

---

## What is this?

**ChatKJB lets you use Telegram on your phone to give jobs to an AI assistant that works inside your Mac.**

Here is an easier way to think about it.

Imagine you have a very clever helper at home. This helper sits at your computer. It can read files, fix writing, and even write programs. But right now you are out of the house. So you send a text message saying "please do this," and the helper does the work at your computer and texts you back with the result.

**ChatKJB is that text-message window.**

| If you ever wanted this | ChatKJB does it |
| --- | --- |
| Give my home computer a job while I'm out | Just talk to it on Telegram |
| Let an AI edit my files directly | Point it at a folder and it reads and edits inside it |
| Start a long job and go do something else | It keeps texting you progress updates |
| Compare several AIs | Pick from 4 AIs, or use them all at once |

### Which AIs can it use?

ChatKJB does not build its own AI. It is a program that **calls in** 4 well-known AIs that already exist. It is like one remote control that turns on your TV, air conditioner, and fan.

| AI | Made by | Good at |
| --- | --- | --- |
| **Claude** | Anthropic | Long reading, judgment calls, reviewing, writing docs |
| **Codex** | OpenAI | Editing code, running tests, builds, Git work |
| **Antigravity** | Google | Images and audio, reading very long text at once |
| **Grok** | xAI | Fast one-shot jobs, useful as a second opinion |

> **Important:** You must sign up and log in to **at least one** of these 4 yourself. ChatKJB does not pay your AI bills for you.

### What you need

| Item | Notes |
| --- | --- |
| **A Mac** | macOS only right now. Windows is not supported. |
| **Node.js 26.4.0 or newer** | The engine that runs the program. Setup is explained below. |
| **A Telegram account** | Free. |
| **At least one AI account** | Any one from the table above. |
| **A folder to work in** | Where the files you want the AI to touch live. |

---

## Contents

This document has four parts. **If you are not technical, Part 1 is all you need.**

| Part | Who it's for | What's inside |
| --- | --- | --- |
| [Part 1](#part-1-using-it-on-telegram) | **Users** | How to actually give it jobs on Telegram |
| [Part 2](#part-2-installing-on-your-mac) | **Installers** | Setting it up and making it start automatically |
| [Part 3](#part-3-developer-guide) | **Contributors** | Structure and where to add features |
| [Part 4](#part-4-troubleshooting) | **Anyone stuck** | What to check when something breaks |

---

# Part 1. Using it on Telegram

## The whole flow, first

Here is the order things happen in.

```text
1. I send "/new" on Telegram
        ↓
2. ChatKJB opens a new little room (a "topic")
        ↓
3. In that room I write what I want, in plain words
        ↓
4. ChatKJB works out which folder this job belongs to
        ↓
5. The AI starts the actual work inside that folder
        ↓
6. Progress keeps posting into that room
        ↓
7. Risky steps ask "may I?" with a button
        ↓
8. It reports the result. Ask again in the same room to continue
```

## The 5 words you need to know

These come up constantly. Learn these and you're fine.

| Word | Plain meaning |
| --- | --- |
| **Project** | The **folder** the AI works in. Think "my thesis folder" or "my work folder." |
| **Topic** | A **small room inside a big Telegram group**. It's a Telegram feature that lets you have many small rooms inside one group. Usually **one job = one room**. |
| **Session** | One **continuous conversation** inside a room. The AI remembers what was said earlier. |
| **Provider** | The **name of the AI** doing the work: Claude, Codex, Antigravity, or Grok. |
| **Permission mode** | A setting for **how much the AI is allowed to do on its own**, from "ask me first" to "just handle it." |

## Your first job, step by step

Open Telegram and follow along.

**Step 1.** Open the Telegram group that has ChatKJB in it.

**Step 2.** Send exactly this:

```text
/new
```

**Step 3.** A new room appears. Go into it and write what you want **in full sentences**. The more detail, the better.

```text
Look through the posts in my blog folder, find any spelling mistakes,
and fix them. Then give me a list of everything you changed.
```

**Step 4.** ChatKJB picks the folder, renames the room, and starts working.

**Step 5.** If a button like this appears, read it and choose.

```text
May I modify this file?
[ Allow ]  [ Deny ]
```

**Step 6.** When it's done, the result appears. Message the same room again to keep going.

## Things you can ask for

| What you want | How to say it |
| --- | --- |
| Fix code | `Find why login is failing, fix it, and run the tests` |
| Write docs | `Rewrite the README so a first-time reader can follow it` |
| Check things | `After your edit, confirm typecheck and tests pass` |
| Analyze a file | `Read the PDF I just uploaded and summarize the main claims in a table` |
| Pick an AI | `/route which AI is best for this job?` |
| Compare AIs | `/synth find the risky parts of this design` |
| Search old records | `/query what did we decide about this rule before?` |
| See current state | `/status` |

## Command dictionary

Anything starting with `/` is a command. You don't need to memorize these — just look them up here when you need one.

### The ones you'll use most

| Command | What it does |
| --- | --- |
| `/start` | Shows help. **Try this first if you're stuck.** |
| `/new` | Opens a room for a new job. **The one you'll use most.** |
| `/new <project>` | Opens a room with a folder you name directly. |
| `/new browse` | Lets you browse and pick a folder visually. |
| `/status` | Shows what's running right now, at a glance. |
| `/stop` | **Stops** the current job. |
| `/doctor` | Runs a full health check to find what's broken. |
| `/usage` | Shows how much AI quota you've used and have left. |
| `/sessions` | Lists your recent jobs. |
| `/delete` | Deletes this room and its records. |
| `/reset` | Keeps the room but wipes **only the conversation memory**. |

### Steering a job

| Command | What it does |
| --- | --- |
| `/steer <instruction>` | Redirects the job **while it's running**. "No, not that — do it this way." |
| `/next <instruction>` | Queues up what to do **after** the current job finishes. |
| `/shotgun [description]` | Makes the AI **re-examine from scratch** when it missed something. |
| `/resume` | Restarts a job that was interrupted (for example, by a restart). |
| `/fork` | **Copies** the conversation so you can try a different direction. |
| `/compact` | **Summarizes** a conversation that has grown too long. |
| `/diff` | Shows what changed in the files. |
| `/upload <path>` | **Sends a result file from your computer to Telegram.** |
| `/memory <content>` | Asks it to remember a fact long-term. |

### Scheduling for later

| Command | What it does |
| --- | --- |
| `/reserve` | Schedules a job for later. |
| `/reserve <project> <time> <task>` | e.g. `/reserve blog tomorrow 9am run a spelling check` |
| `/reserve browse` | Schedules while picking the folder visually. |
| `/cancel` | Cancels a scheduled job. |
| `/restop` | Cancels only the auto-restart that fires when quota recovers. |

### Changing the AI and its power

| Command | What it does |
| --- | --- |
| `/provider` | **Switches the AI** for this room. It hands over a summary of the conversation. |
| `/firstp` | Sets the default AI for **rooms you open from now on**. |
| `/model` | Switches the **model** within the same AI (the same company's higher/lower tiers). |
| `/power` or `/effort` | Sets **how hard the AI thinks**. Harder means slower and more expensive. |
| `/thinking` | Turns Claude's extended thinking on or off. |
| `/mode` | Changes the **permission mode** (see below). |
| `/lean on` / `/lean off` | Turns "build only what's strictly needed" on or off. |
| `/tokenid <number>` | Picks which Codex account to use when you have several. |

**The 5 permission modes** — how much you trust the AI.

| Mode | Meaning | When to use |
| --- | --- | --- |
| `auto` | **Default.** Does ordinary work, asks about risky things. | Everyday |
| `default` | Asks more often. | When being careful |
| `acceptEdits` | Edits files without asking. | Heavy editing work |
| `plan` | **Read-only.** Changes nothing. | Planning only |
| `dontAsk` | Does almost everything on its own. | **Only for work you trust** |

### Using several AIs together

| Command | What it does | Watch out |
| --- | --- | --- |
| `/route <task>` | **Recommends** which AI suits this job. | Recommends only — does not run it. |
| `/synth <task>` | Asks all 4 AIs, has them critique each other, scores them, and merges the best answer. | **Uses a lot of time and quota.** |
| `/query <question>` | Searches your accumulated records (LLM-Wiki) for the answer. | Best used when nothing else is running. |
| `/compile [source]` | Turns raw records into proper filed records. | Only one runs at a time. |

### The 3-step workflow for big, vague requests

Instead of firing off a big job immediately, this pins down what you actually want **first**.

| Command | What it does |
| --- | --- |
| `/deepinterview <request>` | The AI asks **one question at a time** until the requirement is unambiguous. |
| `/ralplan <task or the result above>` | Builds a plan, then has other AIs **critique and review** it. |
| `/ultragoal <approved plan>` | Now it actually **implements and verifies**. |

Recommended order:

```text
/deepinterview a vague request
    ↓ (requirements clarified, I approve)
/ralplan the clarified requirements
    ↓ (plan reviewed, I approve)
/ultragoal the approved plan
    ↓
actual work + an evidence trail
```

- **Deep Interview** only asks questions. It does not touch files.
- **Ralplan** only plans. It will not execute before approval.
- **Ultragoal** executes only the approved scope, and counts a job "done" only when the evidence is complete.

> These three port workflows from [Gajae-Code](https://github.com/Yeachan-Heo/gajae-code). `/shotgun` ports the re-review flow from [fivetaku/shotgun](https://github.com/fivetaku/shotgun).

### Setting a goal

| Command | What it does |
| --- | --- |
| `/goal <condition>` | Sets a goal: "keep going until this condition holds." |
| `/goal clear` | Clears the goal. |

Example:

```text
/goal all tests pass and the README reflects the current features
```

> `/goal` works **only with Claude and Codex**. Antigravity and Grok have no equivalent feature.

## Reading the status

### `/status` — what's running

`/status` behaves differently **depending on where you type it**.

| Where you typed it | What you get |
| --- | --- |
| Inside a job room | Detailed status of that one job |
| In the main group (General) | **The full board.** Running, waiting, and approval-pending jobs as cards. |

Each card can show:

- Which folder, and what job
- Which AI and model
- How long it's been running
- Why it's waiting
- What needs to happen next
- A link straight to that room

### `/usage` — how much you've used

AI usage is not unlimited. `/usage` shows what's left.

| Where you typed it | What you get |
| --- | --- |
| In the main group | Usage across all 4 AIs |
| In a specific job room | Mostly what that room consumed |
| If the live lookup fails | The last saved value, plus the reason it failed |

### `/doctor` — what's broken

Run this first when something goes wrong. It checks:

- Whether each AI login is still valid
- Whether each AI program is installed at the right version
- Whether auto-start is registered
- Whether the database is writable
- Whether Telegram is reachable
- Whether there's disk space left
- Whether there are recent errors in the logs

## Sending and receiving files

### Sending (you → AI)

Just **drag or attach** a file into the job room. ChatKJB saves it on your computer and tells the AI where it is.

Supported: documents, photos, audio and voice, video, GIFs, stickers.

For PDFs, a separate tool can **extract just the text or just the images**.

### Receiving (AI → you)

```text
/upload output/report.pdf
```

Paths are relative to the current working folder. Absolute paths also work.

## How the project folder gets chosen

### Automatically

If you type `/new` with nothing after it, ChatKJB **reads your sentence** and works out which folder you mean.

The AI that does this picking runs **completely locked down**. It cannot edit files and cannot reach the internet. All it does is say "this looks like folder X." Then ChatKJB **verifies that answer again** before anything actually starts.

If the pick fails, the room is not deleted — just reword and try again.

### Manually

```text
/new browse
```

This shows the **drives** currently reachable on your Mac as buttons. Tap into folders one level at a time and press `Select this folder`.

Folders you never registered work fine too.

> **Privacy note:** If a drive name contains an account name or email (e.g. `GoogleDrive-user@example.com`), Telegram shows it **cleaned up** as `GoogleDrive`. While browsing, the full absolute path is never shown on screen either.

### When the folder list refreshes

- On startup
- Every 30 minutes
- After each job finishes
- Right before an automatic pick (so newly connected external or cloud drives are caught immediately)
- Instantly, if you send `/catbot`

The list stores **only the folder name, location, and a short description.** File contents and secret files like `.env` are never collected.

## Native AI commands still work

If you send a `/command` that ChatKJB doesn't use, and the current AI knows it natively, it is **passed straight through**. For example, in a Claude room you can use Claude's own `/init`, `/review`, `/mcp`, and `/help`.

Unknown commands are not silently dropped — you get a message back. If names collide, the ChatKJB command wins.

## How several AIs work in parallel (subagents)

Big jobs go faster when split up. ChatKJB hands off independent work — research, review, testing — to up to **3 helper AIs (subagents) at the same time.**

A few rules:

- It's "3 at once," not "3 total." When one finishes, its slot frees up and the next helper goes in.
- **File edits are never done in parallel.** If two helpers edit the same file, the file breaks. Parallel edits are allowed only when the files are fully separate.
- A helper creating **more** helpers (recursion) is **forbidden**, so the count can't spiral.
- The **main AI** is responsible for collecting results and doing the final check.

| AI | Mechanism used |
| --- | --- |
| Claude | Task/Agent |
| Codex | `collaboration.spawn_agent` (capped at 3 children, depth 1) |
| Antigravity | Built-in background subagent |
| Grok | Built-in subagent |

## When the AI asks you to choose

Sometimes the AI needs to ask "A or B?" mid-job. When that happens, **tappable buttons** appear in Telegram.

- One question block per turn
- 1–3 questions per block
- 2–4 choices per question
- Free-text input also possible

> **Note:** A pending question lives only in the running program's memory. If the program restarts before you answer, that question is lost.

## Finding old records (`/query` and `/compile`)

ChatKJB does not just pile up conversations. It uses a separate store called **LLM-Wiki**.

```text
10-inbox/     ← finished conversations land here (raw material)
    ↓  /compile  (file them properly)
30-wiki/      ← the filed, canonical records
    ↓  /query   (look things up)
answer
```

**`/query <question>`** answers using the canonical records only. If the records don't cover it, the rule is to say **"not in the wiki"** rather than make something up.

**`/compile [source]`** promotes raw material into canonical records.

- Default target is everything uncompiled in `10-inbox/`
- 45-minute time limit
- **Only one runs at a time** (further requests are refused while one is running)
- Creates no new room; posts only start/finish/error to the main group
- If the chosen AI fails, it does **not** silently fall back to another AI

## Safety measures

Because this automates work on your own machine, these safeguards are built in.

| Safeguard | What it does |
| --- | --- |
| **User check** | Only messages from the Telegram user and group in your config are processed. If a stranger finds the bot, it **does not respond at all.** |
| **Folder limits** | Work stays centered on registered folders. |
| **Approval prompts** | Risky or uncertain actions ask via button first. |
| **Secret masking** | Anything that looks like a token, API key, or password is masked as `[REDACTED]` in logs and messages. |
| **Secret files excluded** | `.env`, `projects.json`, and `data/` never go into Git. |
| **Always interruptible** | `/stop`, `/delete`, and `/reset` let you halt and clear anything. |

---

# Part 2. Installing on your Mac

This part is for **people installing it themselves.**

ChatKJB is **not** a service you host for many users. It's a personal tool you clone and run **on your own Mac, with your own bot, and your own AI accounts.**

## Very fast install (summary)

If you're already comfortable with dev tooling, this is all you need.

```bash
git clone https://github.com/<owner>/ChatKJB
cd ChatKJB
nvm use              # Node 26.4.0+
npm install
npm run setup        # prepares .env, projects.json, data/
# edit .env with your own values

# log in to whichever AIs you'll use (at least one)
npm run auth:setup   # Claude
codex login          # Codex
# Antigravity / Grok: log in once via their own CLIs

npm run build
npm start
# or register auto-start:
npm run launchd:install
```

Then send `/doctor` on Telegram to confirm.

---

Below is the **step-by-step** version.

## Step 1. Get Node.js ready

Node.js is the **engine** that runs this program — like an engine in a car.

Open Terminal and check:

```bash
node -v
```

You need a number **higher than** `v26.4.0`. If it's missing or lower, install or upgrade Node.js.

> **Why does the version matter?** This program uses parts like `better-sqlite3` that are compiled to fit your exact setup. If the Node you installed with differs from the Node you run with, the parts don't fit and you get errors. **Install and run with the same Node.**

## Step 2. Get the repository

```bash
git clone https://github.com/<owner>/ChatKJB
cd ChatKJB
nvm use
npm install
npm run setup
```

`npm run setup` prepares `.env`, `projects.json`, and `data/`. **If those already exist, it leaves them alone.**

## Step 3. Create your Telegram bot

You create the bot yourself. It's free and takes about 5 minutes.

**3-1. Make the bot**

1. Search for `@BotFather` on Telegram and open it. (This is Telegram's official bot.)
2. Send `/newbot`.
3. Give it a name when asked.
4. It gives you a **token** that looks like `123456:ABC-DEF...`. **This is a password. Never show it to anyone.**

**3-2. Make the group**

1. Create a new Telegram **group**. (You can be the only member.)
2. Make it a **supergroup** and turn on **Topics** in its settings.
   - Topics let you have many small rooms inside one group. **ChatKJB will not work without it.**
3. **Invite** your bot to the group.
4. Make the bot an **admin**.
5. Grant it `Manage Topics` and `Delete Messages`.

**3-3. Find your IDs**

Note your Telegram user ID (a number) and the group chat ID (a negative number). ChatKJB only processes messages where **both** match.

## Step 4. Fill in `.env`

`.env` holds your secret settings.

```bash
cp .env.example .env
chmod 600 .env
```

> **`chmod 600` is mandatory.** It makes the file readable by you and nobody else. If the permissions are wrong, the program **deliberately refuses to start.** That's a safeguard against leaking secrets.

At minimum, fill in these three:

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_CHAT_ID=-1001234567890
```

To allow multiple people, list IDs with commas:

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

You can use `TELEGRAM_ALLOWED_USER_ID` alone, `TELEGRAM_ALLOWED_USER_IDS` alone, or both (they merge).

**Time zone** follows your computer automatically. Set `TZ` to an IANA name only if you need to pin a different one.

Point at AI executables **only if** they can't be found automatically:

```dotenv
CLAUDE_CODE_EXECUTABLE=~/.local/bin/claude
CODEX_EXECUTABLE=/opt/homebrew/bin/codex
AGY_EXECUTABLE=~/.local/bin/agy
GROK_EXECUTABLE=~/.local/bin/grok
```

### Optional: delete local records when you delete a topic in the app

By default, deleting a topic in the Telegram app leaves the local record behind. To keep them in sync, get an API ID and API Hash from [my.telegram.org/apps](https://my.telegram.org/apps).

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
# optional; default is ./data/telegram-mtproto.session
TELEGRAM_MTPROTO_SESSION_PATH=./data/telegram-mtproto.session
```

> **The API Hash and the session file are exactly as sensitive as the bot token.** The session file is created atomically on first auth, forced to `0600`, and excluded from Git along with the whole `data/` folder.
>
> If you skip this, only this one feature is off; everything else works. Use `/delete` instead.

## Step 5. Log in to at least one AI

### Claude

```bash
npm run auth:setup
```

Extra accounts can go in `.env`. When one hits its limit, later sessions move to the next.

```dotenv
CLAUDE_CODE_OAUTH_TOKEN_2=sk-ant-oat01-replace-me
CLAUDE_CODE_OAUTH_TOKEN_3=sk-ant-oat01-replace-me
```

### Codex

Codex signs in with a ChatGPT account.

```bash
codex login
```

For several accounts, log in to a separate home folder per account:

```bash
CODEX_HOME=~/.codex codex login
CODEX_HOME=~/.codex-acct-b codex login
```

Then register them:

```dotenv
CODEX_ACCOUNT_HOMES=~/.codex,~/.codex-acct-b
```

Each folder needs an `auth.json`, and only **ChatGPT-mode logins** (`auth_mode=chatgpt`) are accepted.

### Antigravity

Log in **once** through the `agy` CLI with your subscription account.

```dotenv
AGY_EXECUTABLE=~/.local/bin/agy
```

If your setup uses Google One AI Premium quota, also enable `useG1Credits` in `~/.gemini/antigravity-cli/settings.json`.

You can limit which extension tools (MCP) get exposed to `agy` by listing names. You install and authenticate those tools yourself.

```dotenv
AGY_MCP_SERVERS=llm-wiki,obsidian,outlook,peekaboo,playwright,price-feed,literature-evidence,scihub
```

### Grok

```dotenv
GROK_EXECUTABLE=~/.local/bin/grok
GROK_MODEL=grok-4.5
```

Grok streams in small fragments; ChatKJB **reassembles** them and posts one complete message at a time. Internal `thought` events and raw tool logs are not forwarded.

## Step 6. Register work folders (optional)

`projects.json` lists folders you use often. **You can leave it empty** — `/new` auto-selection and `/new browse` cover it.

To pin some:

```bash
cp projects.example.json projects.json
```

```json
[
  {
    "name": "My Blog",
    "cwd": "~/work/blog",
    "defaultMode": "auto"
  }
]
```

| Field | Meaning |
| --- | --- |
| `name` | The name shown in Telegram. |
| `aliases` | (Optional) Other names that find the same project. |
| `cwd` | The real folder. Absolute paths, `~/...`, and SMB URLs are supported. |
| `defaultMode` | Default permission mode: `auto`, `default`, `acceptEdits`, `plan`, or `dontAsk`. |

> **This file contains real paths from your machine. Don't commit it.** (It's already excluded by default.)

Folders that aren't reachable at startup are skipped. Reconnect the drive and restart to get them back.

## Step 7. Run it

While developing (auto-reloads on code changes):

```bash
npm run dev
```

For real use:

```bash
npm run build
npm start
```

If it works, send `/start`, `/doctor`, and `/new` on Telegram.

## Step 8. Start automatically when the Mac boots

If opening Terminal every time is annoying, register auto-start.

```bash
npm run launchd:install
```

| What | Where |
| --- | --- |
| Executable | `<repo>/dist/index.js` |
| Launched through | `~/Library/Application Support/ChatKJB/ChatKJB.app` |
| Config | `<repo>/.env`, `projects.json` |
| Database | `<repo>/data/state.sqlite` |
| Registration | `~/Library/LaunchAgents/com.chatkjb.bot.plist` |
| Logs | `~/Library/Logs/com.chatkjb.bot/stdout.log`, `stderr.log` |

> **Important:** Whatever Node you had active when you ran `launchd:install` gets **baked into the registration.** If you change Node, redo `npm install` → `npm run build` → `npm run launchd:install` with the Node you want active.

### Showing up as ChatKJB in the permissions screen

If the bot just runs as Node, macOS **System Settings → Privacy & Security** shows the process as plain `node`. Your machine may run several Node-based programs, so there's no way to tell which one you'd be granting Full Disk Access to.

So `npm run launchd:install` also builds a **small app wrapper called `ChatKJB.app`**:

```text
~/Library/Application Support/ChatKJB/ChatKJB.app
```

The executable inside that app is **a copy of Node itself**. It does exactly the same work; only the **name and icon macOS sees** become ChatKJB. The icon is the same one the ChatKJB Terminal app uses. Being a background daemon, it never appears in the Dock.

Permission dialogs now show **ChatKJB** with its icon instead of `node`, so you can grant access with confidence.

> **Keeping permissions from resetting:** macOS treats an app as new if its signature changes, and asks for permissions again. So ChatKJB rebuilds the wrapper **only when the Node executable actually changes.** An ordinary reinstall leaves the existing app alone, so permissions you already granted stay granted.

To rebuild only the wrapper app:

```bash
npm run launchd:app
```

After changing code, you don't need to re-register — just restart:

```bash
npm run build
npm run launchd:restart
```

Check status:

```bash
launchctl print gui/$(id -u)/com.chatkjb.bot
```

Healthy output shows:

- `state = running`
- `program` pointing at the Node you intended
- `arguments` pointing at the repo's `dist/index.js`
- `working directory` set to the repo path

### Resuming work after a restart

Jobs that were **running** or **queued** right before a restart are **resumed automatically, once.**

Jobs that were **waiting for approval** or **waiting on quota** are **not** resumed automatically. That prevents a risky action you never approved from quietly executing.

If something wasn't resumed and you want to continue, send `/resume` in that room.

## Optional: the ChatKJB Terminal desktop app

`ChatKJB Terminal` is a Mac app that shows your ChatKJB conversation on a **terminal-style screen**.

How it differs from the normal Telegram app:

- It shows **only the one room** ChatKJB lives in, not all of Telegram.
- There are no contacts, calls, or general settings screens.
- Messages are not trapped in bubbles — they flow across the window width on a **dark terminal screen**.

> **Caution:** This is an **unofficial client**, not an official Telegram app. Reviewing Telegram's API terms and your own account security is your responsibility.

The app uses **API ID / API Hash**, not the bot token. Keep its session file separate from the bot's.

```dotenv
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
TELEGRAM_GUI_SESSION_PATH=./data/telegram-gui.session
```

### Building the app

```bash
npm run gui:macos:build    # build the app
npm run gui:macos:audit    # verify no secrets got bundled in
npm run gui:macos:smoke    # verify it launches and exits cleanly
```

To close, rebuild, and relaunch in one go:

```bash
./script/build_and_run.sh
./script/build_and_run.sh --verify   # also confirm it's running
```

The finished app lands at `.artifacts/ChatKJB Terminal.app`. **You can copy just that app to another Mac and it runs** — no repository or Node needed there. (Apple Silicon, macOS 14+)

> It's ad-hoc signed, so on a new Mac you may need to approve it once under **System Settings → Privacy & Security**.

### First launch

1. Enter the API ID, the 32-character API Hash, the forum chat ID, and the allowed user ID.
2. The app creates its config under `~/Library/Application Support/ChatKJB Terminal` (directory `0700`, files `0600`).
3. A **QR code** appears. Scan it from your phone: **Settings → Devices → Link Desktop Device**.
4. If you have two-step verification on, enter your password once after approving the QR.

> This adds **one device session**. Your phone's Telegram keeps working and is not logged out.
>
> To actually receive ChatKJB replies, **the bot service must still be running separately.** This app is only a viewing window.

### Quitting vs. logging out

| Action | Result |
| --- | --- |
| Close window / `⌘Q` | Just closes the screen. The session persists, so no QR next time. |
| **Session → Log out** | Really logs out server-side and deletes the session file. Your phone and the bot are untouched. |
| App won't open | End that session from your phone under **Settings → Devices**, delete the local session file, and reconnect via QR. |

### Migrating existing settings into the app

Moves only the GUI settings and the app's own Telegram session into Application Support. **Bot tokens, AI tokens, and the database are not copied, and originals are left in place.**

```bash
npm run gui:macos:migrate
# only if install verification failed
npm run gui:macos:migrate:rollback
```

Rollback only touches **files created by this migration**, and safely aborts if you've since modified them.

## Optional: personal backup mirrors (not needed for normal installs)

Backup to cloud storage or a NAS. **Unrelated to how the bot works — feel free to skip.**

```dotenv
CHATKJB_MIRROR_DEST=/absolute/path/to/mirror/ChatKJB
CHATKJB_NAS_SSH=user@nas-host
CHATKJB_NAS_PORT=22
# CHATKJB_NAS_REMOTE_DIR=$HOME/backups
```

```bash
npm run mirror:install-agent       # needs CHATKJB_MIRROR_DEST
npm run nas-mirror:install-agent   # needs CHATKJB_NAS_SSH
```

If unset, the scripts just print guidance and exit.

## Full environment variable reference

Everything you can put in `.env`. **Most of it you'll never touch.**

### Required

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | none | The bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | none | The group chat ID ChatKJB operates in. |
| `TELEGRAM_ALLOWED_USER_ID` | none | A single allowed user ID. |
| `TELEGRAM_ALLOWED_USER_IDS` | none | Multiple allowed user IDs, comma-separated. |

### AI related

| Variable | Default | Description |
| --- | --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | Required to use Claude. |
| `CLAUDE_CODE_OAUTH_TOKEN_2`, `_3` | none | Additional Claude accounts. |
| `CODEX_ACCOUNT_HOMES` | `~/.codex` | Codex account folders, comma-separated. |
| `CLAUDE_CODE_EXECUTABLE` | auto-detected | Path to the Claude executable. |
| `CODEX_EXECUTABLE` | auto-detected | Path to the Codex executable. |
| `AGY_EXECUTABLE` | auto-detected | Path to the Antigravity executable. |
| `GROK_EXECUTABLE` | auto-detected | Path to the Grok executable. |
| `GROK_MODEL` | `grok-4.5` | Default Grok model. |
| `AGY_MCP_SERVERS` | preset list | Extension tools exposed to Antigravity. |
| `GROK_MCP_SERVERS` | preset list | Extension tools exposed to Grok. |

### Telegram related

| Variable | Default | Description |
| --- | --- | --- |
| `TELEGRAM_IP_FAMILY` | `auto` | Connection family. Pin to `4` or `6` only on networks that need it. |
| `TELEGRAM_API_ID` | none | Needed to detect topics deleted from the app. |
| `TELEGRAM_API_HASH` | none | Set alongside the API ID. **Never expose it.** |
| `TELEGRAM_MTPROTO_SESSION_PATH` | `./data/telegram-mtproto.session` | The bot's session file. |
| `TELEGRAM_GUI_SESSION_PATH` | `./data/telegram-gui.session` | The Terminal app's session file. **Keep it separate from the bot's.** |

### Paths and storage

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_PATH` | `./data/state.sqlite` | State database location. |
| `PROJECTS_PATH` | `./projects.json` | Project list file. |
| `FILE_INBOX_DIR` | `~/.claude/channels/telegram/inbox` | Where Telegram attachments are saved. |
| `CLAUDE_MEMORY_DIR` | `~/.claude/memory` | Claude long-term memory location. |
| `LLM_WIKI_ROOT` or `WIKI_VAULT` | auto-detected | Record store location. Found automatically under mounted volumes (`/Volumes/*/LLM-Wiki`) and CloudStorage. |
| `KJB_WIKI_POST_COMPILE_SCRIPT` | none | Script to run after a successful `/compile` (absolute path only). |
| `CHATKJB_LOG_ROOT` | `~/Library/Logs` | Parent directory for log files. |

### Behavior tuning

| Variable | Default | Description |
| --- | --- | --- |
| `TZ` | OS setting | Time zone, as an IANA name. |
| `CHATKJB_LOCALE` | `ko-KR` | Date and number display format. |
| `APPROVAL_TIMEOUT_MINUTES` | `30` | How long to wait on an approval button. |
| `STATUS_DEBOUNCE_MS` | `2500` | Throttle interval for progress messages. |
| `MCP_TOOL_TIMEOUT_SECONDS` | `60` | Extension tool timeout. |
| `MCP_MAX_ATTEMPTS` | `3` | Extension tool retry count. |
| `CODEX_MCP_TIMEOUT_MINUTES` | `30` | Long-running Codex extension tool timeout. |
| `CODEX_MCP_HEARTBEAT_SECONDS` | `60` | Codex extension tool heartbeat interval. |
| `LONG_RUNNING_MCP_SERVERS` | `codex,obsidian` | Tools treated as long-running. |
| `PROVIDER_TURN_TIMEOUT_MINUTES` | `0` | Hard cap per turn. `0` means unlimited. |
| `TURN_IDLE_TIMEOUT_MINUTES` | `35` | Last-resort watchdog for fully stalled turns. |

### Backup (optional)

| Variable | Default | Description |
| --- | --- | --- |
| `CHATKJB_MIRROR_DEST` | none | Absolute path of the mirror target. |
| `CHATKJB_NAS_SSH` | none | NAS SSH target (`user@host`). |
| `CHATKJB_NAS_PORT` | `22` | NAS SSH port. |
| `CHATKJB_NAS_REMOTE_DIR` | `$HOME/backups` | Remote backup parent directory. |

### Internal (you don't set these)

| Variable | Purpose |
| --- | --- |
| `CHATKJB_PROJECT_DIR` | Repo location used by auto-start. |
| `CHATKJB_FOLDER_BROWSER_ROOT` | Narrows the browse root in tests. |

## Connecting LLM-Wiki (optional)

ChatKJB is built to collect long-lived records in a separate store called **LLM-Wiki**.

It finds the location automatically:

1. An `LLM-Wiki` folder on a mounted volume (`/Volumes/*/LLM-Wiki`)
2. An `LLM-Wiki` folder in a cloud drive under `~/Library/CloudStorage`
3. An `LLM-Wiki` folder sitting next to the ChatKJB repository

The third is the simplest.

```text
work/
  ChatKJB/
  LLM-Wiki/
```

If yours is somewhere else, point at it directly:

```dotenv
LLM_WIKI_ROOT=/absolute/path/to/LLM-Wiki
```

### Collecting transcripts

Finished conversations and `.result.md` logs can be gathered into LLM-Wiki's `10-inbox/`.

On Telegram:

```text
/dpbot
```

In the terminal:

```bash
npm run transcripts:dump
```

Details:

- Collects conversations in completed, error, aborted, and verification-failed states.
- Re-running on the same conversation records **only what's newly added.**
- Uses a normalized fingerprint (Unicode and whitespace) to cut duplicates.
- Searches your home folder, cloud storage, and connected external/network drives for `.result.md`. Trash, metadata, and dependency trees are skipped.
- **Never runs on a schedule.** Run it when you want it.

## Bundled extension tools (MCP)

MCP is a **part that gives an AI extra abilities**. A few come with the repository.

### PDF tools

`scripts/pdf-tools-mcp.py` — uses PyMuPDF.

| Tool | What it does |
| --- | --- |
| `pdftotext` | Extracts text to a `.txt` file and returns the path. |
| `pdf_extract_figures` | Saves PDF images as PNGs and returns the paths. |

The point is to **hand over a file path** instead of dumping a huge PDF into Telegram messages.

### Papers and clinical trials

`scripts/literature-evidence-mcp.py` — uses **public APIs only, no paid plan.**

| Tool | Source | Returns |
| --- | --- | --- |
| `search_papers` | Semantic Scholar (falls back to OpenAlex) | Title, authors, abstract, DOI/PMID, journal, year, citations, open PDF |
| `search_clinical_trials` | ClinicalTrials.gov API v2 | NCT ID, summary, status, phase, enrollment, condition, intervention, sponsor, dates |

> **Caution:** Any important conclusion drawn from abstracts and registry data alone **must be re-checked against the full text.**

### scihub

`scripts/scihub-mcp.py` — resolves a DOI, PMID, or URL through mirrors and downloads the PDF.

| Tool | What it does |
| --- | --- |
| `list_mirrors` | Shows the configured mirrors. |
| `resolve_paper` | Resolves the PDF URL and citation metadata (no download). |
| `fetch_paper` | Downloads the PDF and returns the local path. |

> **Complying with copyright and access rules is the caller's responsibility.** Prefer open-access sources where possible.

### price-feed (stock quotes)

`price-feed-mcp/` is a **standalone sub-package** that returns US and Korean stock quotes plus market sentiment.

| Tool | What it does |
| --- | --- |
| `get_quote` | Fetches the current price. |
| `get_order_book` | Fetches the order book (bids and asks). |
| `get_fear_greed` | Fetches the CNN Fear & Greed index. |
| `feed_status` | Confirms whether credentials are configured. |

```bash
cd price-feed-mcp
npm install
npm run build
npm test
npm start
```

> Credentials come from environment variables or a local secret file and are **never committed to Git.**

## Keeping all 4 AIs in sync (shared resources)

A layer that makes Claude, Codex, Antigravity, and Grok see **the same instructions and the same tool list**.

```text
~/.claude/shared-resources/RESOURCE.md
~/.claude/shared-resources/POLICIES.md
~/.claude/shared-resources/SKILLS.md
~/.claude/shared-resources/MEMORY-BRIDGE.md
~/.claude/shared-resources/connectors.json
~/.claude/shared-resources/codex-agents/lite.toml
```

What it does:

- Keeps `~/.claude/CLAUDE.md` as **the single source** and links it into each AI's native discovery location via safe symlinks.
- Stores long rules in `POLICIES.md` and reads **only the relevant section when that situation arises**, rather than injecting the whole thing every turn.
- Links the scattered memory stores so they can be found together.
- Merges installed skills and plugin skills into **one catalog**, including the bundled `skills/deep-interview`, `skills/ralplan`, and `skills/ultragoal`.
- Merges Claude's and Codex's extension tool configs into a shared registry.
- `connectors.json` is an **output, not an input.** Register tools permanently in the original Claude/Codex config, or they'll vanish on the next sync.
- Only the Codex root starts extension tools; helper agents use `lite.toml` and skip them. This **stops server processes from multiplying with every helper.**
- Per-tool secrets go in separate secret files. **Real values never appear in documentation.**

Adding a shared skill:

```bash
npm run skills:add-shared -- "Skill Title" --description "Use when ..."
npm run shared:sync    # re-sync after editing the content
```

---

# Part 3. Developer guide

## Stack

- TypeScript (ESM)
- Node.js 26.4.0+
- grammY (Telegram)
- Claude Agent SDK
- OpenAI Codex SDK
- Antigravity CLI backend
- Grok CLI backend
- better-sqlite3
- zod
- vitest

## Directory layout

| Path | Role |
| --- | --- |
| `src/` | Bot core and session execution logic |
| `src/gui/` | Telegram user client, loopback server, terminal-style web UI |
| `native/macos/` | WKWebView native shell, isolated backend spawn code, `Info.plist` |
| `script/build_and_run.sh` | Single entry point for the Terminal app: quit, build, run, verify |
| `scripts/` | Auth, launchd, transcript dump, PDF MCP, shared skill scripts |
| `skills/` | Bundled provider-neutral workflow skill definitions |
| `tests/` | vitest tests |
| `price-feed-mcp/` | Standalone quote MCP sub-package |
| `data/` | SQLite DB and runtime data (**excluded from Git**) |
| `dist/` | Build output |

## Key source files

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point, config loading, resource sync, command menu registration, bot start |
| `src/config.ts` | `.env`, `projects.json`, paths, account homes, environment validation |
| `src/bot.ts` | Telegram bot assembly and shared dependency creation |
| `src/bot/handlers/*.ts` | Command, button, message, and file handler groups |
| `src/session-manager.ts` | Session queue, provider switching, native goal delivery, quota state |
| `src/session/executors/{claude,codex,agy,grok}.ts` | Per-provider run/abort/retry/cleanup lifecycles |
| `src/session/executors/shared.ts` | The minimal host contract executors share |
| `src/user-input-protocol.ts` | Validates provider-neutral choice-UI requests, serializes answers |
| `src/workflow-skills.ts` | Bundled workflow list and per-session state paths |
| `src/child-process.ts` | Utility for terminating CLI child processes and their descendants |
| `src/session-prompts.ts` | Builds orchestration boundaries and subagent delegation guidance |
| `src/session-environment.ts` | Assembles provider CLI env/PATH, applies Codex multi-agent caps |
| `src/store.ts` | SQLite schema and CRUD |
| `src/model-catalog.ts` | Per-provider model lists and fallbacks |
| `src/cli-resolver.ts` | Locates the 4 provider executables |
| `src/doctor.ts` | Builds the `/doctor` report |
| `src/dashboard.ts` | Builds the `/status` board |
| `src/permission-broker.ts` | Tool approval and choice-question broker |
| `src/token-pool.ts` | Claude OAuth token rotation and quota state |
| `src/codex-account-pool.ts` | Codex account home rotation |
| `src/connectors.ts` | MCP connector merging and sync |
| `src/resource-sync.ts` | Generates shared instructions, memory, skills, connectors |
| `src/wiki-paths.ts` | LLM-Wiki path detection |
| `src/router.ts` | `/route` provider recommendation |
| `src/judge.ts` | `/synth` cross-critique, league scoring, merge |
| `src/stream-renderer.ts` | Renders session streams into Telegram messages |
| `src/redaction.ts` | Secret masking |
| `src/runtime-paths.ts` | Resolves the repo path at runtime |

## Execution lifecycle

`SessionManager` handles **coordination only**. Actual provider execution lives in dedicated executors, so a change to one provider never bleeds into another's path.

```text
Telegram message
  → SessionManager   : session/queue/provider selection and state
  → provider executor: run, stream, retry, abort, cleanup
  → Telegram result + SQLite session state
```

- Each of the 4 executors owns its own SDK/CLI lifecycle.
- On `/stop`, delete, or shutdown, `SessionManager` cancels and the executor clears pending input, timers, and sessions. CLI child processes are terminated down to their descendants.
- Executors and the coordinator share only the minimal contract in `shared.ts`. **When adding a provider, do not push provider-specific state back into `SessionManager`.**

## Request flow

1. `src/index.ts` initializes config, store, model catalog, and shared resources.
2. `src/bot.ts` receives updates and **verifies the user and group are allowed.**
3. `/new` creates an unassigned topic and passes the first message to an isolated read-only selector.
4. The verified project ID is resolved to a real path and a session is created.
5. `src/session-manager.ts` hands off to the configured provider's executor.
6. The executor sends streaming output, approvals, errors, and results to the topic.
7. State, usage, and summaries are persisted to SQLite.
8. Optionally, transcript dump ships finished sessions to the LLM-Wiki inbox.

## npm scripts

| Command | Role |
| --- | --- |
| `npm run dev` | Dev run via `tsx watch` |
| `npm run build` | Clean `dist/` and build |
| `npm start` | Run the build output |
| `npm run typecheck` | Type check |
| `npm test` | Full test suite |
| `npm run auth:setup` | Configure the Claude OAuth token |
| `npm run launchd:app` | Rebuild only the `ChatKJB.app` permissions wrapper |
| `npm run launchd:install` | Register auto-start (builds the wrapper too) |
| `npm run launchd:restart` | Restart auto-start |
| `npm run gui:macos:build` | Build the Terminal app + ad-hoc sign |
| `npm run gui:macos:audit` | Verify no secrets or sessions are bundled |
| `npm run gui:macos:smoke` | Verify launch, clean exit, and crash cleanup |
| `npm run gui:macos:migrate` | Migrate settings/session into Application Support |
| `npm run gui:macos:migrate:rollback` | Remove only this migration's new state |
| `npm run gui:render:check` | Verify rendering, scrolling, and input in a real browser |
| `npm run audit:portability` | **Scan tracked files for personal absolute paths and emails** |
| `npm run shared:sync` | Regenerate shared instructions, skills, connectors |
| `npm run skills:add-shared` | Scaffold a shared skill |
| `npm run transcripts:dump` | Collect transcripts and result logs |

## Adding a Telegram command

1. Add a `bot.command("name", ...)` handler in the fitting `src/bot/handlers/*.ts`. Register a new group in `src/bot/handlers/index.ts` if needed.
2. To surface it in the menu, add it to `setMyCommands` in `src/index.ts`.
3. If it needs persisted state, update `src/types.ts` and the `src/store.ts` migration.
4. If it affects provider execution, check the relevant executor and the `src/session-manager.ts` boundary together.
5. If users see it, **update the README command tables and the tests.**

## Verification

```bash
npm run typecheck
npm test
npm run build
```

A single test:

```bash
npm test -- tests/orchestration-tier0.test.ts
```

> `npm run test:agy-live` needs real credentials and network. Don't run it in a checkout without the live test files.

## Pre-commit checklist

- [ ] No `.env`, `projects.json`, `data/`, or logs staged for Git
- [ ] No real tokens or API keys in the README, tests, or logs
- [ ] `npm run audit:portability` passes (personal absolute paths and emails)
- [ ] If public commands changed, `setMyCommands`, `src/bot.ts`, and the README were updated together
- [ ] If config keys changed, `.env.example`, `src/config.ts`, and the README were updated together
- [ ] If the launchd label changes, the DB, logs, LaunchAgent, and docs were all reviewed

---

# Part 4. Troubleshooting

## Start here

In the terminal:

```bash
npm run typecheck
npm test
npm run build
launchctl print gui/$(id -u)/com.chatkjb.bot
```

On Telegram:

```text
/doctor
/status
/usage
```

## `.env permissions must be 0600`

**Symptom:** Config loading fails immediately on start.

**Cause:** Your `.env` is readable by others.

**Fix:**

```bash
chmod 600 .env
```

## `better-sqlite3` errors

**Symptom:** Native module errors during build or run.

**Cause:** The Node you installed with differs from the Node you're running with.

**Fix:**

```bash
node -v          # confirm v26.4.0 or newer
npm install
npm run build
```

## Telegram is completely silent

Check these in order.

1. Is `TELEGRAM_BOT_TOKEN` in `.env` correct?
2. Is `TELEGRAM_CHAT_ID` really that group's ID? (Usually a negative number starting with `-100`.)
3. Is **your** ID in `TELEGRAM_ALLOWED_USER_ID`?
4. Is the bot an **admin** with **topic management** permission?
5. If running via auto-start, read `~/Library/Logs/com.chatkjb.bot/stderr.log`.
6. If running directly, read the terminal output.

## A folder doesn't show up

1. Does `projects.json` live where `PROJECTS_PATH` says?
2. Does each `cwd` **actually exist**?
3. Can ChatKJB read and write that folder?
4. If it's an external drive or NAS, **is it mounted?**
5. Send `/new browse` on Telegram and see whether the drive appears.

## You hit an AI usage limit

```text
/usage
```

- Claude: register more accounts in `CLAUDE_CODE_OAUTH_TOKEN_2` and `_3`.
- Codex: register more account folders in `CODEX_ACCOUNT_HOMES`.
- A limited account waits for recovery or moves to the next account.
- It auto-resumes on recovery; send `/restop` in that room if you'd rather it didn't.

## Codex login fails

```bash
CODEX_HOME=~/.codex codex login
```

**Every** folder listed in `CODEX_ACCOUNT_HOMES` needs an `auth.json`, and it must be a **ChatGPT-mode login.**

## Antigravity doesn't work

```bash
agy --version
agy --help
```

Check the `AGY_EXECUTABLE` path, the CLI login state, and that `agy --print` works. Check `useG1Credits` if relevant.

## A job looks stuck

1. Run `/status` to confirm it's actually stuck (it may just be thinking hard).
2. Run `/stop` to halt it.
3. `TURN_IDLE_TIMEOUT_MINUTES` is the last-resort watchdog for fully stalled turns.
4. For slow extension tools, check `LONG_RUNNING_MCP_SERVERS`, `CODEX_MCP_TIMEOUT_MINUTES`, and `CODEX_MCP_HEARTBEAT_SECONDS`.

## The Terminal app won't open

1. Is `~/Library/Application Support/ChatKJB Terminal` **owned by you** with `0700` permissions?
2. Are the `.env` and session file inside regular files with `0600`?
3. In a dev environment, re-verify:

```bash
npm run gui:macos:audit
npm run gui:macos:smoke
```

---

# Current limitations

An honest list of what doesn't work today.

- Operates against **a single Telegram group.**
- Telegram Bot API limits make **large files** hard to send and receive.
- Syncing app-side topic deletion requires **both** `TELEGRAM_API_ID` and `TELEGRAM_API_HASH`. Otherwise use `/delete`.
- Per-folder work runs **one at a time** to avoid conflicts.
- **Codex** may not carry over a previous thread when switching accounts, so it starts fresh from a summary.
- **Antigravity** can only show as much as its CLI exposes about state, cancellation, and usage.
- **Grok** depends on the CLI executable and the CLI's model list response.
- **`/goal` works only with Claude and Codex.**
- **macOS only.** Windows and Linux are not supported.

---

# Quick reference

First install:

```bash
npm install
cp .env.example .env
chmod 600 .env
cp projects.example.json projects.json
npm run build
npm start
```

Verify:

```bash
npm run typecheck
npm test
npm run build
```

Auto-start:

```bash
npm run launchd:install
npm run launchd:restart
```

Common Telegram commands:

```text
/new
/reserve blog tomorrow 9am run a spelling check
/cancel
/status
/usage
/doctor
/stop
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.

## Contact

**contact@kimjb.com**
