# Personal Finance Manager

A single-file, offline personal income & expense tracker. No backend, no
database, no build step — just open `index.html` in a browser.

## Running it

Double-click `index.html`, or open it via **File → Open** in any modern
browser (Chrome, Edge, Firefox, Safari). Nothing to install, no server
required. All data is stored locally in the browser's `localStorage`,
scoped to wherever you open the file from.

On first launch you'll be asked to create a 6-digit PIN and a security
question — this protects the app's UI on this browser/device. See
**Security notes** below for what this does and doesn't protect against.

## What it does

- **Dashboard** — Overall, Today, and Current Month income/expense/net
  summaries, plus a live account-balance table. Everything is calculated
  from your transactions on the fly; nothing is cached.
- **Transactions** — Add/edit/delete income and expense entries with
  narration autocomplete (based on past entries), search, and filters
  (narration, account, type, date range, amount range — all combinable),
  plus sorting (newest/oldest/amount).
- **Accounts** — Create accounts with an opening balance. Balances are
  always `Opening Balance + Income − Expense`, computed live — never
  stored as a stale number. Accounts are deactivated, not deleted, so
  historical transactions always stay linked to something real.
- **Reports** — Monthly Income vs Expense, Account-wise, Daily Summary,
  Monthly Summary (with transaction counts), and Current Balances.
- **Backup / Restore** — Export everything to a JSON file, or export just
  your transactions to CSV (opens cleanly in Excel, including narrations
  or notes with commas/quotes/line breaks). Restoring a JSON backup is
  validated before anything is touched, and always asks for confirmation
  first since it replaces your current data.
- **Settings** — Change your PIN, update your security question, or load
  a small set of sample accounts/transactions to try the app out (see
  below — this only *adds* data, it never overwrites anything).

## Data storage

Everything lives in four `localStorage` keys, all prefixed `pfm_` so they
won't collide with any other local tools you keep in the same browser
profile:

| Key                 | Contents                                    |
|---------------------|----------------------------------------------|
| `pfm_accounts`      | Your accounts                                |
| `pfm_transactions`  | Your income/expense entries                  |
| `pfm_settings`      | PIN hash, security question hash, salts      |
| `pfm_metadata`      | Data version, app version, last backup time  |

Because it's `localStorage`, data is tied to the specific browser
profile and the specific way you opened the file (same path/origin).
**Back up regularly** via Backup → Export JSON if you rely on this data —
clearing browser data, using a different browser, or switching machines
will not carry it over automatically.

## Security notes

- The PIN and security-answer are **hashed** (SHA-256 with a random salt
  via the browser's Web Crypto API) — never stored in plain text.
- This is a **local UI lock**, not server-side authentication. Anyone
  with direct technical access to this browser's storage could
  potentially inspect or clear the underlying data. It stops casual
  access to the app; it is not bank-level security, and the app says so
  on the PIN-creation screen itself.
- PIN hashing depends on `window.crypto.subtle`, which requires a
  "secure context." Opening the file directly (`file://...`) works fine
  in current Chrome/Edge/Firefox. If you ever serve this from a plain
  `http://` address instead of opening it locally, PIN creation will
  fail silently in most browsers — use `https://` or open it directly.

## Demo data

Settings → **Load Sample Data** adds 5 sample accounts (Cash, Bank,
Credit Card, Household, Salary) and 3 sample transactions, dated today,
so you can see the Dashboard/Reports populated without manual entry.
This is opt-in only — it's never loaded automatically, and it only adds
records; it does not touch or remove anything you've already entered.

## Known environment dependencies

- Native `<input type="date">` and `<input type="number">` pickers vary
  slightly in appearance across browsers, but behavior is consistent.
- CSV export uses the browser's `Blob`/download-link mechanism — some
  browsers may prompt "keep file" for a locally-opened page; this is
  normal browser behavior for `file://` downloads, not an app error.
- No server sync, no multi-device support, no cloud backup — by design
  (see the "No Unrequested Features" scope in the original spec). If you
  need multi-device access, export a JSON backup and import it on the
  other device manually.

## Extending it later

The code is organized into clearly separated modules inside the single
`<script>` block: `Storage`, `Security`, `Accounts`/`AccountsView`,
`Transactions`/`TransactionsView`, `Dashboard`/`DashboardView`,
`Reports`/`ReportsView`, `Backup`/`BackupView`, `LockScreen`,
`SettingsView`, `UI`, and `Utilities`. Data versioning and a migration
hook (`MIGRATIONS` array in `Storage`) are already in place, so future
structural changes to the data model won't need to destroy existing
user data — just add a migration entry.
