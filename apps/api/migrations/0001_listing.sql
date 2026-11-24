CREATE TABLE listing (
	position INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	id TEXT NOT NULL,
	agent_id TEXT,
	status INTEGER NOT NULL,
	UNIQUE (kind, id)
);

CREATE INDEX listing_by_kind ON listing (kind, position);

CREATE INDEX listing_by_agent ON listing (kind, agent_id, position);
