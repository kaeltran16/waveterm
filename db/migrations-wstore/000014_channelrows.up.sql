CREATE TABLE IF NOT EXISTS db_run (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_run_channeloid ON db_run (json_extract(data, '$.channeloid'));

CREATE TABLE IF NOT EXISTS db_channelmessage (
    oid varchar(36) PRIMARY KEY,
    version int NOT NULL,
    data json NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_channelmessage_channeloid_ts ON db_channelmessage (json_extract(data, '$.channeloid'), json_extract(data, '$.ts'));
