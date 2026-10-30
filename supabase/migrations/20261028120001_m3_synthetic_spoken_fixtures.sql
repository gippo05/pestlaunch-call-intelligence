
-- Offline Windows synthetic speech fixtures. Hashes were computed from the
-- final MP3 files after encoding. The corresponding gold transcripts and
-- generation provenance are stored beside the audio under supabase/tests.
insert into private.m3_synthetic_fixtures (fixture_reference, sha256)
values
  ('synthetic-spoken-1m-v1', 'e518b5a01477e514e0c30f5cb34206609ce3f092a47097bbe8a1453580c8b836'),
  ('synthetic-spoken-5m-v1', '1923642e0d2d76a0cb2db87c6a61ec9da73fed0b1b5838d23983fedaf28b65e0'),
  ('synthetic-spoken-20m-v1', 'edabf8f6e6fe4b96f29940d0b319604ff9dae58e3fe54ad8e9a66449f2b5fd32');
