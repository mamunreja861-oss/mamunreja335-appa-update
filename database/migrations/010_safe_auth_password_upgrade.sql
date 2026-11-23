-- ============================================================================
-- MUN COMPUTER — Safe Authentication & Password Lifecycle Upgrade
-- Migration: 010_safe_auth_password_upgrade.sql (MySQL 8.0 InnoDB)
-- NON-DESTRUCTIVE & BACKWARD-COMPATIBLE ONLY:
--   - Preserves all existing tables, users, password hashes, customers,
--     applications, services, Annapurna Yojana, financial, inventory & audit data.
--   - NEVER uses DROP, TRUNCATE, DELETE, or seed-data replacement.
-- Rollback Note:
--   - All columns/indexes added below are nullable or defaulted cleanly so
--     existing queries continue working without data modification.
--   - Pre-upgrade JSON state snapshot & SHA-256 checksums preserved under
--     storage/backups/pre-auth-upgrade-20261121/.
-- ============================================================================

USE `mun_computer_db`;

-- 1. Safely ensure mandatory first-login / migration password lifecycle flags exist
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `must_change_password` TINYINT(1) NOT NULL DEFAULT 0 AFTER `password_changed_at`,
  ADD COLUMN IF NOT EXISTS `password_migration_required` TINYINT(1) NOT NULL DEFAULT 0 AFTER `must_change_password`,
  ADD COLUMN IF NOT EXISTS `totp_enabled` TINYINT(1) NOT NULL DEFAULT 0 AFTER `password_migration_required`,
  ADD COLUMN IF NOT EXISTS `totp_enrolled_at` TIMESTAMP NULL AFTER `totp_enabled`;

-- 2. Safely ensure password history table exists without altering existing history rows
CREATE TABLE IF NOT EXISTS `user_password_history` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` VARCHAR(40) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `changed_by` VARCHAR(40) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_uph_user` (`user_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Safely align password policy minimum length to 12 characters without deleting settings
UPDATE `security_settings`
SET `password_min_length` = 12
WHERE `password_min_length` < 12;
