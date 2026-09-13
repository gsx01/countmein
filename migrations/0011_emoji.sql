-- Per-user map pin emoji. A user may pick an emoji (admin UI) used as the glyph
-- on their driver / pickup map pins; NULL falls back to a role default. The
-- office pin always shows the OFFICE_EMOJI constant, not a user emoji.
ALTER TABLE users ADD COLUMN emoji TEXT;
