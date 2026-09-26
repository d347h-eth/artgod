-- Additive competition settings leave existing target identity and orders intact.
ALTER TABLE trading_bidding_job_specs
ADD COLUMN extra_competition_traits_json TEXT NOT NULL DEFAULT '[]'
CHECK (json_valid(extra_competition_traits_json) AND json_type(extra_competition_traits_json) = 'array');
