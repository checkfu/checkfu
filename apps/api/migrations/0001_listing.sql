CREATE TABLE listing (
	kind TEXT NOT NULL,
	id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	agent_id TEXT,
	status INTEGER NOT NULL,
	PRIMARY KEY (kind, id)
);

CREATE INDEX listing_live ON listing (kind, created_at, id) WHERE status = 0;

CREATE INDEX listing_live_by_agent ON listing (kind, agent_id, created_at, id) WHERE status = 0;

CREATE INDEX listing_kept ON listing (kind, created_at, id) WHERE status <= 1;

CREATE INDEX listing_kept_by_agent ON listing (kind, agent_id, created_at, id) WHERE status <= 1;
