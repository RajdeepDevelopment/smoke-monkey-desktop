-- Enable pgvector extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Full-text search is provided by Postgres directly; nothing extra to create here.
-- The `chunks` table (with the vector column) is created by the document-worker
-- on first boot; application tables are created by the api-gateway via TypeORM.
