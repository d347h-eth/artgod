-- Create migrations tracking table
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  executed_at TIMESTAMP DEFAULT NOW()
);

-- Insert this migration into the tracking table
INSERT INTO migrations (name) VALUES ('001_initial_schema') ON CONFLICT (name) DO NOTHING;