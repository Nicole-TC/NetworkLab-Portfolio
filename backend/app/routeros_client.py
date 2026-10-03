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
EXEMPT_LIST_NAME = "web-filter-exempt"
ADMIN_LIST_NAME = "admin-devices"


def ensure_admin_bypass(admin_ips: list[str] | None = None) -> None:
    """
    Garantiza pase libre absoluto y permanente para los dispositivos del Administrador:
    1. Agrega las IPs del admin a 'admin-devices' y 'web-filter-exempt' en /ip/firewall/address-list.
    2. Las elimina de 'blocked-devices' si estuvieran allí.
    3. Asegura reglas prioritarias 'accept' en /ip/firewall/filter para forward.
    4. Asegura reglas de redirección DNS en /ip/firewall/nat directo a 8.8.8.8 para evitar NXDOMAIN.
    5. Elimina cualquier limitador de ancho de banda (Simple Queue) asignado a la IP del admin.
    """
    admin_ips = [str(ip).strip() for ip in (admin_ips or []) if str(ip).strip()]
    if not admin_ips:
        return

    api = get_connection()
    try:
        # 1. Address Lists: admin-devices y web-filter-exempt
        addr_list_path = api.path("ip", "firewall", "address-list")
        entries = list(addr_list_path)

        for ip in admin_ips:
            has_admin = any(e.get("list") == ADMIN_LIST_NAME and e.get("address") == ip for e in entries)
            if not has_admin:
                addr_list_path.add(list=ADMIN_LIST_NAME, address=ip, comment="admin-protected-device")

            has_exempt = any(e.get("list") == EXEMPT_LIST_NAME and e.get("address") == ip for e in entries)
            if not has_exempt:
                addr_list_path.add(list=EXEMPT_LIST_NAME, address=ip, comment="admin-web-exempt")

            for e in entries:
                if e.get("list") == BLOCKED_LIST_NAME and e.get("address") == ip:
                    eid = e.get(".id") or e.get("id")
                    if eid:
                        addr_list_path.remove(eid)

        # 2. Firewall Filter: ACCEPT prioritario para el Administrador
        filter_path = api.path("ip", "firewall", "filter")
        filter_entries = list(filter_path)

        has_fwd_accept = any(
            r.get("comment") == "ADMIN-PASO-LIBRE-TOTAL" or 
            (r.get("chain") == "forward" and r.get("src-address-list") == ADMIN_LIST_NAME and r.get("action") == "accept")
            for r in filter_entries
        )
        if not has_fwd_accept:
            try:
                filter_path.add(
                    chain="forward",
                    **{"src-address-list": ADMIN_LIST_NAME},
                    action="accept",
                    comment="ADMIN-PASO-LIBRE-TOTAL",
                )
            except Exception as e:
                print("Nota filter admin accept:", e)

        # 3. NAT: DNS Bypass directo a 8.8.8.8:53 para que el admin nunca sufra NXDOMAIN
        nat_path = api.path("ip", "firewall", "nat")
        nat_entries = list(nat_path)

        has_nat_dns = any(
            r.get("comment") == "ADMIN-DNS-PASO-LIBRE" or
            (r.get("chain") == "dstnat" and r.get("src-address-list") == ADMIN_LIST_NAME and r.get("dst-port") == "53")
            for r in nat_entries
        )
        if not has_nat_dns:
            try:
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": ADMIN_LIST_NAME, "dst-port": "53"},
                    action="dst-nat",
                    **{"to-addresses": "8.8.8.8", "to-ports": "53"},
                    comment="ADMIN-DNS-PASO-LIBRE",
                )
                nat_path.add(
                    chain="dstnat",
                    protocol="tcp",
                    **{"src-address-list": ADMIN_LIST_NAME, "dst-port": "53"},
                    action="dst-nat",
                    **{"to-addresses": "8.8.8.8", "to-ports": "53"},
                    comment="ADMIN-DNS-PASO-LIBRE-TCP",
                )
            except Exception as e:
                print("Nota NAT admin dns:", e)

        # 4. Eliminar colas QoS si existieran para las IPs del admin
        try:
            queue_path = api.path("queue", "simple")
            for entry in list(queue_path):
                for ip in admin_ips:
                    if entry.get("name") == f"queue-{ip}" or entry.get("target") == f"{ip}/32":
                        eid = entry.get(".id") or entry.get("id")
                        if eid:
                            queue_path.remove(eid)
        except Exception:
            pass

    except Exception as e:
        print("Error en ensure_admin_bypass:", e)
    finally:
        api.close()


def sync_exempt_devices(exempt_ips: list[str]) -> None:
    """
    Sincroniza la address-list 'web-filter-exempt' en MikroTik.
    Los dispositivos en esta lista quedan exentos del filtrado web, bloqueo DoH y QUIC.
    """
    api = get_connection()
    try:
        address_list = api.path("ip", "firewall", "address-list")
        entries = list(address_list)

        # 1. Eliminar IPs que ya no están en exempt_ips
        for entry in entries:
            if entry.get("list") == EXEMPT_LIST_NAME:
                addr = entry.get("address")
                if addr not in exempt_ips:
                    entry_id = entry.get(".id") or entry.get("id")
                    if entry_id:
                        address_list.remove(entry_id)

        # 2. Agregar IPs exentas faltantes
        existing_addrs = {
            e.get("address")
            for e in address_list
            if e.get("list") == EXEMPT_LIST_NAME
        }
        for ip in exempt_ips:
            ip_clean = str(ip).strip()
            if ip_clean and ip_clean not in existing_addrs:
                address_list.add(list=EXEMPT_LIST_NAME, address=ip_clean, comment="lab-filter-exempt")
    finally:
        api.close()


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
    if not ip_address or ip_address.strip() in ("127.0.0.1", settings.routeros_host):
        return

    api = get_connection()
    try:
        address_list = api.path("ip", "firewall", "address-list")
        # El Administrador NUNCA puede ser bloqueado (Pase Libre Permanente)
        for entry in address_list:
            if entry.get("list") == ADMIN_LIST_NAME and entry.get("address") == ip_address:
                return
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


# --- Módulo Hotspot: Control Nativo de Acceso / Portal Cautivo ---

def authorize_hotspot_device(mac_address: str, ip_address: str | None = None) -> None:
    """
    Habilita la salida a internet a un equipo agregándolo como 'bypassed' 
    en MikroTik Hotspot IP Bindings (comentario: 'lab-active').
    """
    if not mac_address:
        return
    mac_norm = mac_address.strip().upper()
    api = get_connection()
    try:
        bindings = api.path("ip", "hotspot", "ip-binding")
        for b in bindings:
            if (b.get("mac-address") or "").strip().upper() == mac_norm:
                return
        kwargs = {
            "mac-address": mac_norm,
            "type": "bypassed",
            "comment": "lab-active",
        }
        if ip_address:
            kwargs["address"] = ip_address
        bindings.add(**kwargs)
    finally:
        api.close()


def revoke_hotspot_device(mac_address: str) -> None:
    """
    Revoca la navegación a un equipo eliminando su regla 'lab-active' 
    de Hotspot IP Bindings para que el router lo capture y obligue al portal cautivo.
    Nunca elimina las reglas de la consola de administración.
    """
    if not mac_address:
        return
    mac_norm = mac_address.strip().upper()
    if mac_norm in settings.admin_mac_list:
        return  # Proteger consola admin
    api = get_connection()
    try:
        bindings = api.path("ip", "hotspot", "ip-binding")
        for b in bindings:
            if (b.get("mac-address") or "").strip().upper() == mac_norm and b.get("comment") == "lab-active":
                entry_id = b.get(".id") or b.get("id")
                if entry_id:
                    bindings.remove(entry_id)
    finally:
        api.close()


def get_hotspot_active_macs() -> set[str]:
    """
    Devuelve las direcciones MAC de los dispositivos que están efectivamente
    conectados y activos en la red física del MikroTik (Wi-Fi o cable).
    Verifica registration-table (para Wi-Fi), hotspot active y hotspot host con actividad reciente.
    """
    api = get_connection()
    try:
        active = set()
        wifi_macs = set()
        has_wifi_registrations = False

        # 1. Clientes Wi-Fi físicamente asociados a las antenas MikroTik
        try:
            reg_table = api.path("interface", "wireless", "registration-table")
            for r in reg_table:
                mac = r.get("mac-address")
                if mac:
                    m = mac.strip().upper()
                    wifi_macs.add(m)
                    active.add(m)
                    has_wifi_registrations = True
        except Exception:
            pass

        try:
            wifi_regs = api.path("interface", "wifi", "registration-table")
            for r in wifi_regs:
                mac = r.get("mac-address")
                if mac:
                    m = mac.strip().upper()
                    wifi_macs.add(m)
                    active.add(m)
                    has_wifi_registrations = True
        except Exception:
            pass

        # 2. Sesiones activas de Hotspot (usuarios autenticados)
        try:
            actives = api.path("ip", "hotspot", "active")
            for a in actives:
                mac = a.get("mac-address")
                if mac:
                    active.add(mac.strip().upper())
        except Exception:
            pass

        # 3. Hosts Hotspot (verificando que no lleven mucho tiempo idle)
        try:
            hosts = api.path("ip", "hotspot", "host")
            for h in hosts:
                mac = h.get("mac-address")
                if not mac:
                    continue
                m = mac.strip().upper()

                # Si el router reporta idle-time prolongado, no agregarlo como activo
                idle_str = str(h.get("idle-time") or "0s").lower()
                es_inactivo = False
                if ":" in idle_str:
                    partes = idle_str.split(":")
                    # Si minutos > 1 o horas > 0
                    if len(partes) >= 2:
                        try:
                            mins = int(partes[-2])
                            es_inactivo = mins >= 2
                        except Exception:
                            pass
                elif "m" in idle_str or "h" in idle_str or "d" in idle_str:
                    es_inactivo = True

                if not es_inactivo:
                    active.add(m)
        except Exception:
            pass

        return active
    except Exception:
        return set()
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
        # El Administrador NUNCA tiene límite de velocidad (Pase Libre Permanente)
        addr_list_path = api.path("ip", "firewall", "address-list")
        for e in addr_list_path:
            if e.get("list") == ADMIN_LIST_NAME and e.get("address") == ip_address:
                remove_bandwidth_limit(ip_address)
                return

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
            **{
                "name": queue_name,
                "target": target_ip,
                "max-limit": max_limit,
                "comment": "lab-qos",
            }
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


# --- Módulo Filtrado Web: Bloqueo de Sitios Web por DNS Estático y Firewall ---

def add_dns_block(
    domain: str,
    alcance: str = "todos",
    target_ips: list[str] | None = None,
    exempt_ips: list[str] | None = None,
) -> None:
    """
    Agrega bloqueo de dominio con alcance granular:
    - 'todos': Bloquea a todos los alumnos (admin exento).
    - 'todos_excepto': Bloquea a todos menos a las IPs en exempt_ips (y admin).
    - 'solo_seleccionados': Bloquea ÚNICAMENTE a las IPs en target_ips.
    """
    dominio_limpio = domain.strip().lower()
    if not dominio_limpio:
        return

    clean_tag = dominio_limpio.replace(".", "-")[:16]
    target_ips = [str(ip).strip() for ip in (target_ips or []) if str(ip).strip()]
    exempt_ips = [str(ip).strip() for ip in (exempt_ips or []) if str(ip).strip()]

    # Garantizar protección estricta y absoluta del Administrador:
    api_check = get_connection()
    admin_ips = []
    try:
        addr_list_check = api_check.path("ip", "firewall", "address-list")
        admin_ips = [
            e.get("address") for e in addr_list_check 
            if e.get("list") == ADMIN_LIST_NAME and e.get("address")
        ]
    except Exception:
        pass
    finally:
        api_check.close()

    # El Administrador NUNCA es objetivo de ningún bloqueo
    target_ips = [ip for ip in target_ips if ip not in admin_ips]
    # El Administrador SIEMPRE está en la lista de exentos
    for aip in admin_ips:
        if aip not in exempt_ips:
            exempt_ips.append(aip)

    if admin_ips:
        ensure_admin_bypass(admin_ips)

    # Dominios a bloquear (incluye variantes y subdominios)
    dominios_a_bloquear = {dominio_limpio}
    if "youtube" in dominio_limpio:
        dominios_a_bloquear.update([
            "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"
        ])
    elif "tiktok" in dominio_limpio:
        dominios_a_bloquear.update(["tiktok.com", "tiktokv.com", "tiktokcdn.com"])
    elif "facebook" in dominio_limpio:
        dominios_a_bloquear.update(["facebook.com", "fbcdn.net"])
    elif "instagram" in dominio_limpio:
        dominios_a_bloquear.update(["instagram.com", "cdninstagram.com"])

    # Bloquear DoH (DNS-over-HTTPS) para evitar que Brave/Chrome evadan el DNS del router
    doh_domains = ["dns.google", "cloudflare-dns.com", "mozilla.cloudflare-dns.com"]
    dominios_a_bloquear.update(doh_domains)

    api = get_connection()
    try:
        addr_list_path = api.path("ip", "firewall", "address-list")

        # Configurar address-list según alcance
        if alcance == "solo_seleccionados":
            list_name = f"tgt-{clean_tag}"
            rule_src_match = list_name
            # Limpiar entradas previas de esta lista
            for entry in list(addr_list_path):
                if entry.get("list") == list_name:
                    eid = entry.get(".id") or entry.get("id")
                    if eid:
                        addr_list_path.remove(eid)
            # Agregar IPs objetivo
            for tip in target_ips:
                addr_list_path.add(list=list_name, address=tip, comment=f"target-{dominio_limpio}")

        elif alcance == "todos_excepto":
            list_name = f"exp-{clean_tag}"
            rule_src_match = f"!{list_name}"
            # Limpiar entradas previas
            for entry in list(addr_list_path):
                if entry.get("list") == list_name:
                    eid = entry.get(".id") or entry.get("id")
                    if eid:
                        addr_list_path.remove(eid)
            # Agregar IPs exentas
            for eip in exempt_ips:
                addr_list_path.add(list=list_name, address=eip, comment=f"exempt-{dominio_limpio}")

        else:  # 'todos'
            rule_src_match = f"!{EXEMPT_LIST_NAME}"

        # 1. Redirección de DNS en NAT según alcance
        nat_path = api.path("ip", "firewall", "nat")
        nat_tags = ("lab-dns-force", "lab-dns-exempt", f"dns-{clean_tag}")
        for r in list(nat_path):
            if any(tag in (r.get("comment") or "") for tag in nat_tags):
                eid = r.get(".id") or r.get("id")
                if eid:
                    nat_path.remove(eid)

        try:
            if alcance == "solo_seleccionados":
                # A los seleccionados se les fuerza al DNS de MikroTik
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": rule_src_match, "dst-port": "53"},
                    action="redirect",
                    **{"to-ports": "53"},
                    comment=f"dns-{clean_tag}",
                )
                # A los no seleccionados se les reenvía a 8.8.8.8 para que no sufran NXDOMAIN
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": f"!{rule_src_match}", "dst-port": "53"},
                    action="dst-nat",
                    **{"to-addresses": "8.8.8.8", "to-ports": "53"},
                    comment=f"dns-{clean_tag}",
                )
            elif alcance == "todos_excepto":
                # Exentos van directo a 8.8.8.8
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": f"exp-{clean_tag}", "dst-port": "53"},
                    action="dst-nat",
                    **{"to-addresses": "8.8.8.8", "to-ports": "53"},
                    comment=f"dns-{clean_tag}",
                )
                # El resto forzado a MikroTik
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": f"!exp-{clean_tag}", "dst-port": "53"},
                    action="redirect",
                    **{"to-ports": "53"},
                    comment=f"dns-{clean_tag}",
                )
            else:
                # 'todos': Admin exento va a 8.8.8.8, alumnos a MikroTik
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": EXEMPT_LIST_NAME, "dst-port": "53"},
                    action="dst-nat",
                    **{"to-addresses": "8.8.8.8", "to-ports": "53"},
                    comment="lab-dns-exempt",
                )
                nat_path.add(
                    chain="dstnat",
                    protocol="udp",
                    **{"src-address-list": f"!{EXEMPT_LIST_NAME}", "dst-port": "53"},
                    action="redirect",
                    **{"to-ports": "53"},
                    comment="lab-dns-force",
                )
        except Exception as e:
            print("Nota NAT redirect:", e)

        # 2. Entradas DNS estáticas (NXDOMAIN)
        dns_path = api.path("ip", "dns", "static")
        for d in dominios_a_bloquear:
            for entry in list(dns_path):
                name = entry.get("name", "")
                if entry.get("comment") == "lab-blocked-domain" and (name == d or name == f"*.{d}" or name == f"www.{d}"):
                    entry_id = entry.get(".id") or entry.get("id")
                    if entry_id:
                        dns_path.remove(entry_id)

            try:
                dns_path.add(
                    name=d,
                    type="NXDOMAIN",
                    **{"match-subdomain": "yes"},
                    comment="lab-blocked-domain",
                )
            except Exception:
                dns_path.add(
                    name=d,
                    address="127.0.0.1",
                    comment="lab-blocked-domain",
                )

        # 3. Reglas de Firewall Filter con coincidencia de lista exacta
        try:
            filter_path = api.path("ip", "firewall", "filter")

            # 3a. Bloquear QUIC (UDP 443) para los afectados
            for r in list(filter_path):
                if r.get("comment") == "lab-block-quic":
                    eid = r.get(".id") or r.get("id")
                    if eid:
                        filter_path.remove(eid)

            filter_path.add(
                chain="forward",
                protocol="udp",
                **{"src-address-list": rule_src_match, "dst-port": "443"},
                action="drop",
                comment="lab-block-quic",
            )

            # 3b. Bloquear DoH (1.1.1.1, 8.8.8.8) para los afectados
            for r in list(filter_path):
                if r.get("comment") == "lab-block-doh":
                    eid = r.get(".id") or r.get("id")
                    if eid:
                        filter_path.remove(eid)

            for doh_ip in ["1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9"]:
                try:
                    filter_path.add(
                        chain="forward",
                        protocol="tcp",
                        **{"src-address-list": rule_src_match, "dst-port": "443", "dst-address": doh_ip},
                        action="reject",
                        **{"reject-with": "tcp-reset"},
                        comment="lab-block-doh",
                    )
                except Exception:
                    pass

            # 3c. Regla TLS-Host específica para el dominio
            tls_patterns = [f"*{dominio_limpio}*"]
            if "youtube" in dominio_limpio:
                tls_patterns.extend(["*googlevideo*", "*ytimg*", "*youtu.be*"])

            for r in list(filter_path):
                if r.get("comment") == f"lab-block-tls-{clean_tag}" or (r.get("comment") == "lab-block-tls" and r.get("tls-host") in tls_patterns):
                    eid = r.get(".id") or r.get("id")
                    if eid:
                        filter_path.remove(eid)

            for pattern in tls_patterns:
                try:
                    filter_path.add(
                        chain="forward",
                        protocol="tcp",
                        **{"src-address-list": rule_src_match, "dst-port": "443", "tls-host": pattern},
                        action="reject",
                        **{"reject-with": "tcp-reset"},
                        comment=f"lab-block-tls-{clean_tag}",
                    )
                except Exception as e:
                    print(f"Nota TLS-Host filter ({pattern}):", e)
        except Exception as e:
            print("Nota al configurar Firewall Filter:", e)

        # 4. Limpiar caché DNS de MikroTik
        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass
    finally:
        api.close()


def remove_dns_block(domain: str) -> None:
    """Elimina las entradas de bloqueo de DNS y reglas de Firewall Filter en MikroTik."""
    dominio_limpio = domain.strip().lower()
    if not dominio_limpio:
        return

    clean_tag = dominio_limpio.replace(".", "-")[:16]
    dominios_a_remover = {dominio_limpio}
    if "youtube" in dominio_limpio:
        dominios_a_remover.update([
            "youtube.com", "youtu.be", "googlevideo.com", "ytimg.com"
        ])

    api = get_connection()
    try:
        # 1. Remover entradas DNS
        dns_path = api.path("ip", "dns", "static")
        for entry in list(dns_path):
            name = entry.get("name", "")
            if entry.get("comment") == "lab-blocked-domain":
                for d in dominios_a_remover:
                    if name == d or name.endswith(f".{d}") or name == f"*.{d}":
                        entry_id = entry.get(".id") or entry.get("id")
                        if entry_id:
                            dns_path.remove(entry_id)
                        break

        # 2. Remover reglas TLS-Host en Firewall Filter asociadas
        try:
            filter_path = api.path("ip", "firewall", "filter")
            tls_patterns = [f"*{dominio_limpio}*"]
            if "youtube" in dominio_limpio:
                tls_patterns.extend(["*googlevideo*", "*ytimg*", "*youtu.be*"])

            for entry in list(filter_path):
                c = entry.get("comment", "")
                if c == f"lab-block-tls-{clean_tag}" or (c == "lab-block-tls" and entry.get("tls-host") in tls_patterns):
                    entry_id = entry.get(".id") or entry.get("id")
                    if entry_id:
                        filter_path.remove(entry_id)
        except Exception as e:
            print("Nota al remover regla TLS filter:", e)

        # 3. Remover address-lists dinámicas asociadas al dominio
        try:
            addr_list_path = api.path("ip", "firewall", "address-list")
            for entry in list(addr_list_path):
                l_name = entry.get("list", "")
                if l_name in (f"tgt-{clean_tag}", f"exp-{clean_tag}"):
                    eid = entry.get(".id") or entry.get("id")
                    if eid:
                        addr_list_path.remove(eid)
        except Exception as e:
            print("Nota al limpiar address-lists:", e)

        # 4. Limpiar reglas NAT asociadas
        try:
            nat_path = api.path("ip", "firewall", "nat")
            for r in list(nat_path):
                if f"dns-{clean_tag}" in (r.get("comment") or ""):
                    eid = r.get(".id") or r.get("id")
                    if eid:
                        nat_path.remove(eid)
        except Exception as e:
            print("Nota al limpiar NAT rules:", e)

        # 5. Limpiar caché DNS de MikroTik
        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass
    finally:
        api.close()


def get_dns_blocks() -> list[str]:
    """Devuelve la lista de dominios bloqueados en RouterOS."""
    api = get_connection()
    try:
        dns_path = api.path("ip", "dns", "static")
        dominios = set()
        doh_ignore = {"dns.google", "cloudflare-dns.com", "mozilla.cloudflare-dns.com"}
        for entry in dns_path:
            if entry.get("comment") == "lab-blocked-domain":
                nombre = entry.get("name", "")
                if nombre not in doh_ignore and not nombre.startswith("*."):
                    dominios.add(nombre)
        return sorted(list(dominios))
    finally:
        api.close()


def check_router_connection() -> dict:
    """Verifica de forma rápida y no bloqueante la comunicación con el router MikroTik."""
    import socket
    host = settings.routeros_host
    port = settings.routeros_port

    # Test TCP socket rápido con timeout corto (1.2s) para no demorar la UI
    try:
        with socket.create_connection((host, port), timeout=1.2):
            pass
    except Exception as e:
        return {
            "conectado": False,
            "tcp_alcanzable": False,
            "host": host,
            "puerto": port,
            "error": f"Sin enlace con {host}:{port} ({e})",
        }

    # Test login API RouterOS
    try:
        api = get_connection()
        api.close()
        return {
            "conectado": True,
            "tcp_alcanzable": True,
            "host": host,
            "puerto": port,
            "error": None,
        }
    except Exception as e:
        return {
            "conectado": False,
            "tcp_alcanzable": True,
            "host": host,
            "puerto": port,
            "error": f"Puerto accesible pero falló login API: {e}",
        }


def kick_and_isolate_device(mac_address: str, ip_address: str | None = None) -> dict:
    """
    Expulsa y aísla activamente a un dispositivo rechazado de la red MikroTik:
    1. Si está conectado vía Wi-Fi, envía Deauth (elimina de registration-table).
    2. Bloquea la IP en /ip/firewall/address-list ('blocked-devices').
    3. Remueve su concesión activa en /ip/dhcp-server/lease para forzar pérdida de IP.
    4. Limpia la entrada en /ip/arp para cortar comunicación local.
    5. Remueve la sesión activa en /ip/hotspot/active y /ip/hotspot/host.
    6. Remueve cualquier regla de bypass previa en /ip/hotspot/ip-binding.
    """
    mac_norm = (mac_address or "").strip().upper()
    admin_macs = settings.admin_mac_list
    if mac_norm in admin_macs:
        return {"ok": False, "motivo": "admin_protegido"}

    acciones = []
    try:
        api = get_connection()
    except Exception as e:
        return {"ok": False, "error": f"MikroTik inaccesible: {e}"}

    try:
        # 1. Hotspot IP Binding: revocar bypass
        try:
            bindings = api.path("ip", "hotspot", "ip-binding")
            for b in bindings:
                if (b.get("mac-address") or "").strip().upper() == mac_norm:
                    bid = b.get(".id") or b.get("id")
                    if bid:
                        bindings.remove(bid)
                        acciones.append("hotspot_binding_removido")
        except Exception as e:
            acciones.append(f"error_hotspot_binding: {e}")

        # 2. Hotspot Hosts & Actives: forzar desconexión inmediata de sesión
        try:
            hosts = api.path("ip", "hotspot", "host")
            for h in hosts:
                if (h.get("mac-address") or "").strip().upper() == mac_norm:
                    hid = h.get(".id") or h.get("id")
                    if hid:
                        hosts.remove(hid)
                        acciones.append("hotspot_host_expulsado")

            actives = api.path("ip", "hotspot", "active")
            for a in actives:
                if (a.get("mac-address") or "").strip().upper() == mac_norm:
                    aid = a.get(".id") or a.get("id")
                    if aid:
                        actives.remove(aid)
                        acciones.append("hotspot_active_expulsado")
        except Exception as e:
            acciones.append(f"error_hotspot_active: {e}")

        # 3. Desautenticación Wi-Fi (si está conectado por antena/WLAN)
        try:
            reg_table = api.path("interface", "wireless", "registration-table")
            for r in reg_table:
                if (r.get("mac-address") or "").strip().upper() == mac_norm:
                    rid = r.get(".id") or r.get("id")
                    if rid:
                        reg_table.remove(rid)
                        acciones.append("wifi_deauth_ejecutado")
        except Exception:
            try:
                wifi_regs = api.path("interface", "wifi", "registration-table")
                for r in wifi_regs:
                    if (r.get("mac-address") or "").strip().upper() == mac_norm:
                        rid = r.get(".id") or r.get("id")
                        if rid:
                            wifi_regs.remove(rid)
                            acciones.append("wifi_deauth_v7_ejecutado")
            except Exception:
                pass

        # 4. Bloquear en Firewall Address-List
        if ip_address and ip_address.strip() not in ("127.0.0.1", settings.routeros_host):
            try:
                addr_list = api.path("ip", "firewall", "address-list")
                esta_bloqueado = any(
                    e.get("list") == BLOCKED_LIST_NAME and e.get("address") == ip_address.strip()
                    for e in addr_list
                )
                if not esta_bloqueado:
                    addr_list.add(list=BLOCKED_LIST_NAME, address=ip_address.strip(), comment="lab-rechazado-aislado")
                    acciones.append("firewall_ip_bloqueada")
            except Exception as e:
                acciones.append(f"error_firewall: {e}")

        # 5. Revocar / Remover DHCP lease
        if mac_norm:
            try:
                leases = api.path("ip", "dhcp-server", "lease")
                for l in leases:
                    if (l.get("mac-address") or "").strip().upper() == mac_norm:
                        lid = l.get(".id") or l.get("id")
                        if lid:
                            leases.remove(lid)
                            acciones.append("dhcp_lease_removido")
            except Exception as e:
                acciones.append(f"error_dhcp: {e}")

        # 6. Purgar entrada ARP
        try:
            arps = api.path("ip", "arp")
            for arp in arps:
                if (arp.get("mac-address") or "").strip().upper() == mac_norm:
                    aid = arp.get(".id") or arp.get("id")
                    if aid:
                        arps.remove(aid)
                        acciones.append("arp_removido")
        except Exception as e:
            acciones.append(f"error_arp: {e}")

        # 7. Quitar limitador de ancho de banda si existía
        if ip_address:
            try:
                remove_bandwidth_limit(ip_address)
            except Exception:
                pass

        return {"ok": True, "acciones": acciones}
    finally:
        api.close()



