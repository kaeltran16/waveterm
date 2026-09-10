CREATE TABLE IF NOT EXISTS db_pendingask (
    oref varchar(100) PRIMARY KEY,
    askid varchar(36) NOT NULL,
    blockid varchar(36) NOT NULL,
    ts int NOT NULL,
    prose boolean NOT NULL DEFAULT 0,
    questions json NOT NULL
);
