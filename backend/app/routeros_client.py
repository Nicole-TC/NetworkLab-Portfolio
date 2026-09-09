"""
Wrapper simple sobre librouteros para:
- Leer los leases de DHCP (dispositivos que piden IP en la red).
- Bloquear/desbloquear dispositivos usando una address-list de firewall.

Requiere que en el router exista (o se cree una sola vez) una regla de
firewall que descarte el trafico de la address-list "blocked-devices".
Eso se hace UNA vez a mano en Winbox (ver README), este backend solo
agrega o quita direcciones de esa lista.
"""

from librouteros import connect
from librouteros.query import Key

from app.config import settings

BLOCKED_LIST_NAME = "blocked-devices"


def get_connection():
    return connect(
        username=settings.routeros_user,
        password=settings.routeros_password,
        host=settings.routeros_host,
        port=settings.routeros_port,
    )


def get_dhcp_leases() -> list[dict]:
    """Devuelve la lista de leases activos: mac, ip, hostname."""
    api = get_connection()
    try:
        leases = api.path("ip", "dhcp-server", "lease")
        result = []
        for lease in leases:
            result.append(
                {
                    "mac_address": lease.get("mac-address"),
                    "ip_address": lease.get("address"),
                    "hostname": lease.get("host-name", ""),
                }
            )
        return result
    finally:
        api.close()


def block_device(ip_address: str) -> None:
    """Agrega la IP a la address-list de bloqueados."""
    api = get_connection()
    try:
        address_list = api.path("ip", "firewall", "address-list")
        for entry in address_list:
            if entry.get("list") == BLOCKED_LIST_NAME and entry.get("address") == ip_address:
                return
        address_list.add(list=BLOCKED_LIST_NAME, address=ip_address, comment="lab-panel")
    finally:
        api.close()


def unblock_device(ip_address: str) -> None:
    """Quita la IP de la address-list de bloqueados, si estaba."""
    api = get_connection()
    try:
        address_list = api.path("ip", "firewall", "address-list")
        for entry in address_list:
            if entry.get("list") == BLOCKED_LIST_NAME and entry.get("address") == ip_address:
                entry_id = entry.get(".id") or entry.get("id")
                if entry_id:
                    address_list.remove(entry_id)
    finally:
        api.close()


# --- Módulo QoS: Control de Ancho de Banda (Simple Queues) ---

def set_bandwidth_limit(ip_address: str, limit_mbps: int | None) -> None:
    """
    Crea o actualiza una Simple Queue en MikroTik para limitar la velocidad
    de subida y bajada de una IP específica (ej. 2 Mbps, 5 Mbps).
    Si limit_mbps es None o 0, elimina el límite.
    """
    if not limit_mbps or limit_mbps <= 0:
        remove_bandwidth_limit(ip_address)
        return

    api = get_connection()
    try:
        queue_path = api.path("queue", "simple")
        queue_name = f"queue-{ip_address}"
        target_ip = f"{ip_address}/32"
        max_limit = f"{limit_mbps}M/{limit_mbps}M"

        # Buscar si ya existe una cola para esta IP y eliminarla antes de recrear
        for entry in queue_path:
            if entry.get("name") == queue_name or entry.get("target") == target_ip:
                entry_id = entry.get(".id") or entry.get("id")
                if entry_id:
                    queue_path.remove(entry_id)

        queue_path.add(
            name=queue_name,
            target=target_ip,
            max_limit=max_limit,
            comment="lab-qos",
        )
    finally:
        api.close()


def remove_bandwidth_limit(ip_address: str) -> None:
    """Elimina la Simple Queue de una IP si existe."""
    api = get_connection()
    try:
        queue_path = api.path("queue", "simple")
        queue_name = f"queue-{ip_address}"
        target_ip = f"{ip_address}/32"

        for entry in queue_path:
            if entry.get("name") == queue_name or entry.get("target") == target_ip:
                entry_id = entry.get(".id") or entry.get("id")
                if entry_id:
                    queue_path.remove(entry_id)
    finally:
        api.close()


# --- Módulo Filtrado Web: Bloqueo de Sitios Web por DNS Estático ---

def add_dns_block(domain: str) -> None:
    """
    Agrega entradas estáticas de DNS en MikroTik apuntando a 127.0.0.1
    para bloquear el acceso a un dominio y sus subdominios.
    """
    dominio_limpio = domain.strip().lower()
    if not dominio_limpio:
        return

    api = get_connection()
    try:
        dns_path = api.path("ip", "dns", "static")
        patrones = [dominio_limpio, f"*.{dominio_limpio}"]

        for p in patrones:
            existe = any(entry.get("name") == p for entry in dns_path)
            if not existe:
                dns_path.add(
                    name=p,
                    address="127.0.0.1",
                    comment="lab-blocked-domain",
                )
    finally:
        api.close()


def remove_dns_block(domain: str) -> None:
    """Elimina las entradas de bloqueo de DNS de un dominio en MikroTik."""
    dominio_limpio = domain.strip().lower()
    if not dominio_limpio:
        return

    api = get_connection()
    try:
        dns_path = api.path("ip", "dns", "static")
        patrones = {dominio_limpio, f"*.{dominio_limpio}"}

        for entry in dns_path:
            if entry.get("comment") == "lab-blocked-domain" and entry.get("name") in patrones:
                entry_id = entry.get(".id") or entry.get("id")
                if entry_id:
                    dns_path.remove(entry_id)
    finally:
        api.close()


def get_dns_blocks() -> list[str]:
    """Devuelve la lista de dominios bloqueados en RouterOS."""
    api = get_connection()
    try:
        dns_path = api.path("ip", "dns", "static")
        dominios = set()
        for entry in dns_path:
            if entry.get("comment") == "lab-blocked-domain":
                nombre = entry.get("name", "")
                if nombre.startswith("*."):
                    dominios.add(nombre[2:])
                else:
                    dominios.add(nombre)
        return sorted(list(dominios))
    finally:
        api.close()


