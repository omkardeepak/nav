CREATE TABLE IF NOT EXISTS agents (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, agent_id INT NOT NULL REFERENCES agents(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now());
-- resolve_min NULL = "end of the same working day"
CREATE TABLE IF NOT EXISTS sla_policies (priority TEXT PRIMARY KEY, reply_min INT NOT NULL, resolve_min INT, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS holidays (day DATE PRIMARY KEY, name TEXT);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,                       -- customer's private link
  customer_name TEXT NOT NULL, customer_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  priority TEXT NOT NULL REFERENCES sla_policies(priority),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','open','waiting','resolved','closed')),
  assignee_id INT REFERENCES agents(id),
  created_at TIMESTAMPTZ NOT NULL,
  sla_start TIMESTAMPTZ NOT NULL,                   -- created_at, or reopen time
  first_response_at TIMESTAMPTZ,
  reply_due TIMESTAMPTZ NOT NULL, resolve_due TIMESTAMPTZ NOT NULL,
  paused_at TIMESTAMPTZ, paused_total_min INT NOT NULL DEFAULT 0,
  done_at TIMESTAMPTZ,                              -- resolved or auto-closed at
  reply_breached BOOLEAN NOT NULL DEFAULT false,
  resolve_breached BOOLEAN NOT NULL DEFAULT false
);

-- Customer-visible conversation. Internal notes live in a different table on purpose,
-- so no customer-facing query can ever return them.
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id),
  author_type TEXT NOT NULL CHECK (author_type IN ('customer','agent')),
  author_id INT REFERENCES agents(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS internal_notes (
  id SERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id),
  agent_id INT NOT NULL REFERENCES agents(id), body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_events (
  id BIGSERIAL PRIMARY KEY, ticket_id INT NOT NULL REFERENCES tickets(id),
  type TEXT NOT NULL, actor_type TEXT NOT NULL CHECK (actor_type IN ('agent','customer','system')),
  actor_id INT, actor_name TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS account_events (
  id BIGSERIAL PRIMARY KEY, agent_id INT REFERENCES agents(id),
  type TEXT NOT NULL, actor_id INT REFERENCES agents(id),
  actor_name TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL
);

-- migrations (safe to re-run)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS previous_ticket_id INT REFERENCES tickets(id);
ALTER TABLE account_events ADD COLUMN IF NOT EXISTS detail JSONB NOT NULL DEFAULT '{}';
ALTER TABLE account_events ALTER COLUMN agent_id DROP NOT NULL;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE ticket_events ADD COLUMN IF NOT EXISTS hash TEXT;

-- Append-only: history cannot be edited or deleted (INC-0318)
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_ticket_events_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.hash IS NULL AND NEW.hash IS NOT NULL
     AND OLD.id = NEW.id
     AND OLD.ticket_id = NEW.ticket_id
     AND OLD.type = NEW.type
     AND OLD.actor_type = NEW.actor_type
     AND OLD.actor_id IS NOT DISTINCT FROM NEW.actor_id
     AND OLD.actor_name IS NOT DISTINCT FROM NEW.actor_name
     AND OLD.detail IS NOT DISTINCT FROM NEW.detail
     AND OLD.created_at = NEW.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'ticket_events is append-only';
END $$ LANGUAGE plpgsql;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['messages','internal_notes','account_events'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_ro ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_ro BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_change()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I_ro_trunc ON %I', t, t);
    EXECUTE format('CREATE TRIGGER %I_ro_trunc BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION forbid_change()', t, t);
  END LOOP;

  DROP TRIGGER IF EXISTS ticket_events_ro ON ticket_events;
  CREATE TRIGGER ticket_events_ro BEFORE UPDATE OR DELETE ON ticket_events FOR EACH ROW EXECUTE FUNCTION forbid_ticket_events_change();
  DROP TRIGGER IF EXISTS ticket_events_ro_trunc ON ticket_events;
  CREATE TRIGGER ticket_events_ro_trunc BEFORE TRUNCATE ON ticket_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_ticket_events_change();
END $$;
