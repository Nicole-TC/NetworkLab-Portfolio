from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    routeros_host: str
    routeros_port: int = 8728
    routeros_user: str
    routeros_password: str

    database_url: str

    telegram_bot_token: str | None = None
    telegram_admin_chat_id: str | None = None

    admin_macs: str = ""

    @property
    def admin_mac_list(self) -> set[str]:
        if not self.admin_macs:
            return set()
        return {m.strip().upper() for m in self.admin_macs.split(",") if m.strip()}

    class Config:
        env_file = ".env"


settings = Settings()
