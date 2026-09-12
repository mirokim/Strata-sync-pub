-- Server generation: a random value minted when the database is (re)created. Clients keep it
-- with their sync cursor and drop their mirror when it changes (a wiped/reimported vault reuses
-- low sequence numbers, which a cursor comparison alone cannot detect).
INSERT OR IGNORE INTO counters(name, value) VALUES ('generation', abs(random()) % 2147483647 + 1);
