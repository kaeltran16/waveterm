CREATE TABLE IF NOT EXISTS db_runevent (
    oid varchar(36) PRIMARY KEY,
    runid varchar(36) NOT NULL,
    channelid varchar(36) NOT NULL,
    ts int NOT NULL,
    kind varchar(32) NOT NULL,
    phaseidx int,
    data json NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runevent_run ON db_runevent(runid, ts DESC);