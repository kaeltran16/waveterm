CREATE TABLE db_usagebucket (
    harness TEXT NOT NULL,
    session TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    day TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    reasoning INTEGER NOT NULL,
    cacheread INTEGER NOT NULL,
    cachecreate INTEGER NOT NULL,
    cachecreate1h INTEGER NOT NULL,
    reportedcostusd REAL,
    msgs INTEGER NOT NULL,
    PRIMARY KEY (harness, session, provider, model, day)
);
CREATE INDEX db_usagebucket_day ON db_usagebucket (day);
CREATE TABLE db_usagesession (
    harness TEXT NOT NULL,
    session TEXT NOT NULL,
    cwd TEXT NOT NULL,
    title TEXT NOT NULL,
    PRIMARY KEY (harness, session)
);
