CREATE TABLE listing (
	kind TEXT NOT NULL,
	id TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	agent_id TEXT,
	status INTEGER NOT NULL,
	PRIMARY KEY (kind, id)
);

CREATE INDEX listing_by_kind ON listing (kind, created_at, id);

CREATE INDEX listing_by_agent ON listing (kind, agent_id, created_at, id);
