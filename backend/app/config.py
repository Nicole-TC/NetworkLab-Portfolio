from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    routeros_host: str
    routeros_port: int = 8728
    routeros_user: str
    routeros_password: str

    database_url: str

    telegram_bot_token: str | None = None
    telegram_admin_chat_id: str | None = None

    class Config:
        env_file = ".env"


settings = Settings()
