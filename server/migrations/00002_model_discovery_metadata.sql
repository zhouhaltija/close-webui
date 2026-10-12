-- SPDX-License-Identifier: AGPL-3.0-only
-- +goose Up
ALTER TABLE models ADD COLUMN discovery_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- +goose Down
ALTER TABLE models DROP COLUMN discovery_metadata;
