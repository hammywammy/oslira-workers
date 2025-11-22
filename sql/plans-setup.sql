-- plans-setup.sql
-- Ensures the plans table has the correct subscription tier data

-- Insert or update subscription tiers
INSERT INTO plans (name, display_name, price_monthly, credits_per_month, features) VALUES
  ('free', 'Free', 0, 0, '{"light_analyses": "0"}'),
  ('growth', 'Growth', 29, 250, '{"light_analyses": "250"}'),
  ('pro', 'Pro', 99, 1500, '{"light_analyses": "1500"}'),
  ('agency', 'Agency', 299, 5000, '{"light_analyses": "5000"}'),
  ('enterprise', 'Enterprise', 999, 20000, '{"light_analyses": "20000"}')
ON CONFLICT (name) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  price_monthly = EXCLUDED.price_monthly,
  credits_per_month = EXCLUDED.credits_per_month,
  features = EXCLUDED.features;
