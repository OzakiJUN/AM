-- Leaving a server: the account stays (its messages are history) but is
-- marked as left. It disappears from the member directory, cannot log in,
-- and comes back only with a new invite code. NULL = still a member.
ALTER TABLE users ADD COLUMN left_at BIGINT;
