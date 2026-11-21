# Frontdesk

Support ticket system for Arvo Systems. Node + Express, PostgreSQL, one static HTML screen (no build step).

## Run locally
```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/frontdesk   # empty database
npm start            # creates tables, SLA policies, holidays, 9 agents, 3 sample tickets
npm test             # unit tests always; API tests when DATABASE_URL is set
```
Open http://localhost:3000. Agent password for the demo is `frontdesk` (env `AGENT_PASSWORD`).
Customer pages: `/#/new` creates a ticket; the ticket link `/#/c/<token>` is the customer's access. Sample tickets' links are printed in the server log on first start.
Hosted DBs that need SSL (Render, Railway): set `PGSSL=1`. Set `SEED_SAMPLE=0` to skip sample tickets.

## Pages
`/#/` agent ticket list (Late / Waiting on customer / Due soon badges, Take button) · `/#/t/:id` ticket (Reply to customer tab, separate Internal note tab, history) · `/#/report` late-ticket report · `/#/new` and `/#/c/:token` customer pages.

## How each incident is handled
| Incident | Fix |
|---|---|
| INC-0291 two agents take one ticket | Claim is one atomic `UPDATE ... WHERE assignee_id IS NULL`; loser gets 409 "Already taken by X". Only the assigned agent can reply. Tested with two simultaneous requests. |
| INC-0304 note reached the customer | Notes are in their own table (`internal_notes`). Customer endpoints only query `messages` and select named columns, so a note cannot be returned by them. Tested. |
| INC-0318 no proof of what happened | `ticket_events` is append-only (DB triggers block UPDATE/DELETE/TRUNCATE, also on messages and notes). Every row has actor, server-side time and detail. Clients never send timestamps. First reply is its own event; internal notes do not count as a reply. |

## Decisions I made (the document leaves these open)
| Question | Decision |
|---|---|
| Hours / timezone | Mon-Fri 09:30-18:30, Asia/Kolkata, 9 working hours a day. Holidays come from the `holidays` table. |
| Critical | Reply 2 working hours. Resolve by 18:30 on the working day the clock starts. |
| Medium | Reply "half a day" = 4.5 working hours. Resolve "about 3 days" = 3 working days (27h). |
| Low | Reply 1 working day (9h). Resolve "about a week" = 5 working days. |
| Values | All in the `sla_policies` table, in minutes. Change them there. |
| Created outside hours | Clock starts at the next working moment (Fri 18:00 + 2h = Mon 11:00; not late on Sunday). |
| Waiting on customer | The agent's reply that asks a question pauses the clock. Customer's reply resumes it, and both deadlines move later by the working minutes spent waiting. Waiting tickets are never "late". |
| Auto-close | 5 working days in "waiting" with no customer reply. Actor is `system`. |
| Reopen | Customer can reopen within 7 calendar days of resolved or auto-closed. After that: 410 and "create a new ticket". Reopen restarts both SLA clocks from the reopen time. |
| **Priority change mid-way** | Deadlines are recalculated from the **original start** with the new priority, keeping paused time. The clock does not restart (otherwise raising then lowering priority could hide lateness). If the new deadline is already past, the ticket becomes late at once. Event logged with old and new deadlines. Breaches already recorded stay. |
| Breach record | When a deadline is missed, a `sla_breach` event is written once (by a background check every 60s, and at reply/resolve time), with how late and the paused time. The report reads these events. |
| Identity | Agents pick their name + shared demo password. Customers use the secret link of their ticket. |

## Hosting
Not deployed from here. On Render/Railway: create a Postgres DB, a Node web service with `npm install` / `npm start`, env `DATABASE_URL`, `PGSSL=1`. Tables and sample data are created on first start.

## Short note: what I did not finish, and why
- **Not deployed.** I built and tested everything locally; the live URL still needs the 10-minute Render/Railway step above.
- **Real login:** shared demo password and a session token. No per-agent passwords, no rate limiting.
- **No manager role:** any signed-in agent can open the late report.
- **No email notifications** and no customer reply by email.
- **New-ticket-after-window** is a fresh ticket; it is not linked back to the old one.
- **Holidays** are a small seeded sample list (no admin screen). Edit the `holidays` table.
- **Breach timing:** a breach is recorded when detected (within about a minute, or at the agent's reply). On free hosting that sleeps, the check runs when the app wakes or someone opens the list, so a sleeping app can record it late. The "late by" number is still measured against the real deadline.
- **No tamper-evident hash chain** on the event log; protection is database triggers only (a database owner could still drop them).
- **Not done:** search, pagination, attachments, edit of tickets by customer.
