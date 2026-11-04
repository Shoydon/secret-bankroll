---
title: Everyday use
section: salts-tools
order: 7
summary: The salts-tools screen, the commands you will use day to day, and what to do when something stops working.
---

Once salts-tools is installed, it mostly looks after itself. It checks on every tool every 30 seconds, restarts anything that has stopped, and reconnects your agents if your computer goes to sleep or changes network. This page covers the few things you might want to do yourself.

## The salts-tools screen

Run `npx salts-tools` in a terminal to open a screen that shows what is running on your computer and lets you choose what each agent gets. It has four tabs:

| Tab | What it shows |
|---|---|
| **1 Services** | Each tool and whether it is `live` (an agent uses it), `live · not in use` or `error`. Every tool your computer can run is always on. Press **Enter** on a tool for its address, its log and where its files live. |
| **2 Agents** | The agents you have added to this computer, and the tools on for each. Press **a** to add an agent by its ID or its link. Press **Enter** on an agent to switch its tools on or off, fix anything marked **to do**, or unregister it, which turns off its tools and removes it from the list. |
| **3 Settings** | Whether the computer is connected, whether salts-tools starts at login, and where its files live. **disconnect** unpairs this computer. |
| **4 Log** | What salts-tools has been doing, newest at the bottom. |

Use the arrow keys or the numbers **1** to **4** to move around, **Esc** to go back, and **q** to quit. When something is wrong, the line under the list tells you what to do about it. Quitting the screen leaves your tools running.

## Everyday commands

| Command | What it does |
|---|---|
| `npx salts-tools` | Starts salts-tools if it is not running (connecting your computer the first time), then opens the salts-tools screen. |
| `npx salts-tools start` | Starts salts-tools without opening the screen. |
| `npx salts-tools stop` | Stops everything. The next `npx salts-tools start` brings back the same tools. |
| `npx salts-tools restart` | Gets a fresh address. Your agents follow it on their own. |
| `npx salts-tools autostart on` | Starts salts-tools when you log in. Use `off` to turn this off. |
| `npx salts-tools disconnect` | Unpairs this computer and takes its tools off every agent. Run `npx salts-tools` to pair it again. |
| `npx salts-tools reset` | Disconnects this computer, takes its tools off every agent and forgets everything, so you can start again from scratch. The matchmaker's people and jobs and the analyst's files are kept. |

## Footnotes

1. If your agent stops using a tool, check that your computer is awake and online, then run `npx salts-tools restart`.
2. If the screen says `disconnected`, the computer was unpaired. Run `npx salts-tools` to connect it again.
3. If a tool says `error`, the line under the list says why, for example what to install.
4. If a tool stays on `starting` for a long time, look at the **4 Log** tab to see what it is waiting for.
