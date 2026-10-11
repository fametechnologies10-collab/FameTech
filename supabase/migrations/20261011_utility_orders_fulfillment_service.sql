-- Which provider fulfilled/is fulfilling a utility order ('kingflexy-commission'; NULL = legacy Hubtel).
ALTER TABLE public.utility_orders ADD COLUMN IF NOT EXISTS fulfillment_service text;
