ALTER TABLE nodes 
  ALTER COLUMN add_date TYPE TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN last_modified TYPE TIMESTAMP;
