---
title: What is salts-tools
section: salts-tools
order: 1
summary: A small program that runs extra tools for your agent on your own computer, such as free web search and spreadsheet analysis.
---

salts-tools is a small program you run on your own computer, and it gives your agent tools that would otherwise cost money or need a server of your own. It starts each tool on your computer and connects it to your agent over a private, secure address, so your agent can use it from anywhere, including from Telegram or WhatsApp.

For example, once salts-tools is running you can ask your agent "What is the weather in Mumbai today?" and it will search the web for free, or attach a spreadsheet in the chat and ask "Which month had the highest sales?".

## What it can run

salts-tools can run five tools, and you can switch on as many of them as you like:

| Tool | What it gives your agent |
|---|---|
| **web** | Free web search, using a private search engine called SearXNG. There is no account to make and no bill for searches. See [Set up web search](/guide/web-search). |
| **matchmaker** | Reads resumes and cover letters and finds the best people for a job, for recruiters. See [Add the matchmaker](/guide/salts-tools-matchmaker). |
| **analyst** | Reads Excel and CSV files sent in the chat, answers questions about them, and builds new sheets with tables and charts. See [Add the spreadsheet analyst](/guide/salts-tools-analyst). |
| **coinbase-wallet** | Coinbase's non-custodial wallet, which your agent can pay with in USDC on Base, Polygon and Solana, for example a Coinbase Business checkout or a paid API. See [Add Coinbase Wallet](/guide/salts-tools-coinbase-wallet). |
| **zcash-wallet** | A Zcash wallet of your own, on your computer: your agent shows you an address, tells you your balance, makes shielded addresses and sends ZEC up to a limit you set. See [Add the Zcash wallet](/guide/salts-tools-zcash-wallet). |

One salts-tools can serve several agents at once, and you choose which tools each agent gets in the salts-tools screen in your terminal.

## What you need

salts-tools works on Mac, Windows and Linux. You will need to use a terminal (the Terminal app on a Mac, PowerShell on Windows) for one command, `npx salts-tools`, which opens a screen where you do everything else. The browser is only used once, to connect your computer to your account. [Install salts-tools](/guide/salts-tools-install) walks you through it. If you would like a hand, click the **ⓘ** next to salts-tools on your agent's **Capabilities** page and copy the prompt into an assistant you already use, such as Claude or ChatGPT.

Your agent can only use these tools while your computer is on, awake and connected to the internet. We recommend letting salts-tools start when you log in, so your agent gets its tools back on its own after a restart.

## Keeping it private

Each tool only listens on your own computer, and the address your agent uses refuses anyone who does not have a long password that salts-tools makes for you. You never need to see or copy it: salts-tools and your agent exchange it themselves. Your computer connects to your account once, when you approve it in the browser, and you can disconnect it at any time with `npx salts-tools disconnect`.
