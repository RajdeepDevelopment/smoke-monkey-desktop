from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    nats_url: str = "nats://localhost:4222"
    nats_jetstream: bool = True
    document_stream: str = "DOCUMENTS"
    ingest_subject: str = "documents.ingest"
    ingested_subject: str = "documents.ingested"

    minio_endpoint: str = "localhost"
    minio_port: int = 9000
    minio_access_key: str = "ragminio"
    minio_secret_key: str = "ragminio_secret"
    minio_bucket: str = "documents"
    minio_secure: bool = False

    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "rag"
    postgres_password: str = "rag_secret"
    postgres_db: str = "ragdb"

    redis_host: str = "localhost"
    redis_port: int = 6379
    redis_password: str = ""

    # Deployment mode: "cloud" (default) uses Postgres + MinIO as before;
    # "local" writes chunks and PDFs to the on-disk SQLite/filesystem adapters
    # under `local_data_dir` — the same store rag-service reads on the desktop.
    storage_mode: str = "cloud"
    local_data_dir: str = "./data"
    local_poll_interval_s: float = 2.0

    ollama_base_url: str = "http://localhost:11434"
    ollama_embed_model: str = "nomic-embed-text"
    ollama_embed_dims: int = 768

    # Embedding provider: "openrouter" (cloud, default), "nvidia" (cloud) or "ollama" (local)
    embed_provider: str = "openrouter"
    openrouter_embed_model: str = "nvidia/nemotron-3-embed-1b:free"
    openrouter_embed_dims: int = 2048
    # Server default keys; per-user keys are read from Redis (set by api-gateway)
    openrouter_api_key: str = ""
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    nvidia_embed_model: str = "nvidia/nemotron-3-embed-1b"
    nvidia_embed_dims: int = 2048

    ocr_enabled: bool = False
    chunk_size: int = 800
    chunk_overlap: int = 80
    embed_batch_size: int = 32
    summary_enabled: bool = False

    @property
    def embed_provider_id(self) -> str:
        return self.embed_provider

    @property
    def embed_dims(self) -> int:
        if self.embed_provider == "openrouter":
            return self.openrouter_embed_dims
        if self.embed_provider == "nvidia":
            return self.nvidia_embed_dims
        return self.ollama_embed_dims

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def minio_public_endpoint(self) -> str:
        return f"http://{self.minio_endpoint}:{self.minio_port}"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
