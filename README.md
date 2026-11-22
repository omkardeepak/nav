# Frontdesk

Support ticket system for Arvo Systems. Node + Express, PostgreSQL, one static HTML screen (no build step).

## Run locally
```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/frontdesk   # empty database
npm start            # creates tables, SLA policies, holidays, 9 agents, 3 sample tickets
npm test             # unit tests always; API tests when DATABASE_URL is set
```
Open http://localhost:3000. Every account starts with the password `frontdesk` (env `AGENT_PASSWORD` sets that starting password). Each person has their own password and can change it at `/#/password`. **Meera is the support lead (manager)**; the other 9 are agents.
Customer pages: `/#/new` creates a ticket; the ticket link `/#/c/<token>` is the customer's access. Sample tickets' links are printed in the server log on first start.
Hosted DBs that need SSL (Render, Railway): set `PGSSL=1`. Set `SEED_SAMPLE=0` to skip sample tickets.

## Who can do what
| Role | Can |
|---|---|
| Agent (9) | See all tickets, take a ticket, reply (only on tickets they took), write internal notes, ask a question and wait, change priority, resolve, read history, change own password |
| Support lead (Meera) | Everything an agent can, plus the **late report**, the **holidays** page, and **reset an agent's password** |
| Customer | No login. Creates a ticket, replies, reopens within 7 days using the secret ticket link |
| System | Records SLA breaches and auto-closes; appears as "system" in the history |

## Run with Docker
```bash
docker compose up --build
```
Open http://localhost:3000. Every account starts with the password `frontdesk`. Meera is the support lead.

To run the test suite with Docker:
```bash
docker compose run --rm app npm test
# or using the test profile:
docker compose --profile test run --rm test
```

## Pages
`/#/` ticket list (Late / Waiting on customer / Due soon badges, Take button) · `/#/t/:id` ticket (Reply to customer tab, separate Internal note tab, history) · `/#/password` · lead only: `/#/report` (late tickets, which target, how late, why), `/#/holidays`, and `/#/people` · customer: `/#/new` and `/#/c/:token`.

## How each incident is handled
| Incident | Fix |
|---|---|
| INC-0291 two agents take one ticket | Claim is one atomic `UPDATE ... WHERE assignee_id IS NULL`; loser gets 409 "Already taken by X". Only the assigned agent can reply. Tested with two simultaneous requests. |
| INC-0304 note reached the customer | Notes are in their own table (`internal_notes`). Customer endpoints only query `messages` and select named columns, so a note cannot be returned by them. Tested. |
| INC-0318 no proof of what happened | `ticket_events` is append-only (DB triggers block UPDATE/DELETE/TRUNCATE, also on messages, notes, and account_events). Every row has actor, server-side time and detail. Clients never send timestamps. First reply is its own event; internal notes do not count as a reply. |

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
| Identity | Each agent has their own salted-hash password (scrypt), 12-hour sessions, and a lock after 10 wrong tries in 15 minutes. Customers use the secret link of their ticket. |
| Manager | One role, "manager" (Meera): only she sees the late report, edits holidays, and can reset an agent's password. She is not one of the 9 agents. |
| Holidays | Managed on the holidays page. Adding or removing a day **recalculates the deadlines of open tickets**, and each change is written to that ticket's history as `deadline_recalculated` with the old and new deadlines. |
| New ticket after the window | A link on the closed ticket page creates a new ticket that is **linked** to the old one (`previous_ticket_id`), shown on both tickets for agents. Customers never see the old conversation on the new ticket. |

## Deploy

Live URL: `https://<your-render-subdomain>.onrender.com`

### Deployment Steps (Render Blueprint)
1. **Connect Repo**: In the [Render Dashboard](https://dashboard.render.com), click **New +** -> **Blueprint**, and select this repository.
2. **Apply Blueprint**: Render will automatically detect `render.yaml`. Click **Apply** to provision:
   - The PostgreSQL database (`frontdesk-db`, free tier)
   - The web service (`frontdesk`, Docker runtime, free tier, with auto-deploy enabled)
3. **Configure CI/CD Automation (GitHub)**:
   - In Render, navigate to your `frontdesk` web service -> **Settings** -> copy the **Deploy Hook** URL.
   - In your GitHub repository, go to **Settings** -> **Secrets and variables** -> **Actions**:
     - Add Secret: `RENDER_DEPLOY_HOOK` = `<your-render-deploy-hook-url>`
     - Add Variable (or Secret): `APP_URL` = `https://<your-render-subdomain>.onrender.com`
   - On every push to `main`, once the `CI` workflow passes, the `Deploy` workflow triggers the deploy hook and verifies that `/healthz` on the live URL returns 200 within 5 minutes.

### Notes on Free Tier Instances
- **Cold Starts**: Render free instances automatically spin down (sleep) after 15 minutes of inactivity. The first request after a sleep period may take about 50-60 seconds to wake up.
- **Background Checks**: The SLA breach background checker runs on a 60-second timer while the service is awake. Additionally, when sleeping instances wake up, background breach checks automatically run whenever an agent loads the ticket list or late report (`maybeSweep()`).
- **Keep-Alive Suggestion**: To prevent the instance from sleeping during reviewer evaluation, set up a free external uptime monitor (such as [UptimeRobot](https://uptimerobot.com), [BetterStack](https://betterstack.com), or [cron-job.org](https://cron-job.org)) to send an HTTP GET request to `https://<your-render-subdomain>.onrender.com/healthz` every 10 minutes. The unauthenticated `/healthz` endpoint executes `SELECT 1`, keeping both the web service and the PostgreSQL database warm without any code modifications.

## Short note: what I did not finish, and why
Everything in the story's rules is built and tested. What is left is lower priority:
- **No email notifications.** Customers get no email when an agent replies; they must reopen their ticket link. Needs an email provider, which is outside the 8 hours.
- **No tamper-evident hash chain** on the event log. Database triggers stop edits and deletes, but a database owner could still drop the triggers.
- **SLA targets are edited in the `sla_policies` table**, not on a screen (holidays do have a screen).
- **Free-tier hosting sleeps** after inactivity. The breach and auto-close check also runs when the list or report is opened, so nothing is lost, but it may be recorded a little late.
- **Not done:** search, pagination, attachments, edit of tickets by customer.
