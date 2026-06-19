-- Preserve provider default model for dashboard connection tests and routing UX.
ALTER TABLE provider_profiles ADD COLUMN default_model TEXT;
