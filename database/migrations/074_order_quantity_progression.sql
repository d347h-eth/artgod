-- Separate signed size, observed remainder and independently funded capacity.
ALTER TABLE orders ADD COLUMN original_quantity TEXT;
ALTER TABLE orders ADD COLUMN fillable_quantity TEXT;
