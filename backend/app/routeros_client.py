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

def kick_hotspot_active(mac_address: str, ip_address: str | None = None) -> None:
    """Remueve la sesión y host de Hotspot para forzar que tome las nuevas reglas de inmediato."""
    if not mac_address and not ip_address:
        return
    mac_norm = (mac_address or "").strip().upper()
    try:
        api = get_connection()
        try:
            hosts = api.path("ip", "hotspot", "host")
            for h in list(hosts):
                m = (h.get("mac-address") or "").strip().upper()
                addr = (h.get("address") or "").strip()
                if (mac_norm and m == mac_norm) or (ip_address and addr == ip_address):
                    hid = h.get(".id") or h.get("id")
                    if hid:
                        try:
                            hosts.remove(hid)
                        except Exception:
                            pass
            actives = api.path("ip", "hotspot", "active")
            for a in list(actives):
                m = (a.get("mac-address") or "").strip().upper()
                addr = (a.get("address") or "").strip()
                if (mac_norm and m == mac_norm) or (ip_address and addr == ip_address):
                    aid = a.get(".id") or a.get("id")
                    if aid:
                        try:
                            actives.remove(aid)
                        except Exception:
                            pass
        finally:
            api.close()
    except Exception as e:
        print("Nota cerrando hotspot active/host:", e)


def authorize_hotspot_device(mac_address: str, ip_address: str | None = None) -> None:
    """
    Habilita la salida a internet a un equipo agregándolo como 'bypassed' 
    en MikroTik Hotspot IP Bindings (comentario: 'lab-active').
    Limpia cualquier sesión previa de Hotspot para que la navegación sea instantánea.
    """
    if not mac_address:
        return
    mac_norm = mac_address.strip().upper()
    api = get_connection()
    try:
        bindings = api.path("ip", "hotspot", "ip-binding")
        for b in list(bindings):
            if (b.get("mac-address") or "").strip().upper() == mac_norm:
                if b.get("type") == "bypassed" and (not ip_address or b.get("address") == ip_address):
                    # Ya está correctamente en bypass
                    return
                eid = b.get(".id") or b.get("id")
                if eid:
                    try:
                        bindings.remove(eid)
                    except Exception:
                        pass
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

    # Forzar desconexión de sesión previa en Hotspot para que MikroTik tome el bypass
    kick_hotspot_active(mac_norm, ip_address)


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


# --- Módulo Filtrado Web: MODO LISTA BLANCA (Sitios Web Permitidos) ---

WHITELIST_NAME = "lab-whitelist"


def clean_legacy_blacklist_rules() -> None:
    """Elimina las reglas antiguas de lista negra (NXDOMAIN y TLS drops) para evitar conflictos."""
    api = get_connection()
    try:
        # 1. Remover entradas DNS estáticas antiguas (NXDOMAIN)
        dns_path = api.path("ip", "dns", "static")
        for entry in list(dns_path):
            if entry.get("comment") == "lab-blocked-domain" or entry.get("type") == "NXDOMAIN":
                eid = entry.get(".id") or entry.get("id")
                if eid:
                    dns_path.remove(eid)

        # 2. Remover reglas viejas de filter drop/reject
        filter_path = api.path("ip", "firewall", "filter")
        for entry in list(filter_path):
            c = entry.get("comment", "")
            if (
                c.startswith("lab-block-")
                or "lab-block-tls" in c
                or c == "lab-block-quic"
                or c == "lab-block-doh"
            ):
                eid = entry.get(".id") or entry.get("id")
                if eid:
                    filter_path.remove(eid)

        # 3. Remover redirecciones NAT viejas
        nat_path = api.path("ip", "firewall", "nat")
        for r in list(nat_path):
            c = r.get("comment", "")
            if c in ("lab-dns-force", "lab-dns-exempt") or c.startswith("dns-"):
                eid = r.get(".id") or r.get("id")
                if eid:
                    nat_path.remove(eid)

        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass
    except Exception as e:
        print("Nota limpiando reglas viejas de lista negra:", e)
    finally:
        api.close()


def sync_whitelist_filter(
    allowed_domains: list[str],
    alcance: str = "todos",
    target_ips: list[str] | None = None,
    exempt_ips: list[str] | None = None,
) -> None:
    """
    Aplica el modo LISTA BLANCA estricto en MikroTik:
    - Solo los dominios en allowed_domains son accesibles por las estaciones restringidas.
    - Todo el resto de la navegación web externa queda bloqueada (reject tcp-reset).
    - Los administradores y equipos exentos tienen paso libre completo garantizado.
    """
    clean_legacy_blacklist_rules()

    target_ips = [str(ip).strip() for ip in (target_ips or []) if str(ip).strip()]
    exempt_ips = [str(ip).strip() for ip in (exempt_ips or []) if str(ip).strip()]

    api = get_connection()
    try:
        addr_list = api.path("ip", "firewall", "address-list")
        filter_path = api.path("ip", "firewall", "filter")

        # 1. Obtener IPs de administradores para eximirlas siempre
        admin_ips = [
            e.get("address")
            for e in list(addr_list)
            if e.get("list") == ADMIN_LIST_NAME and e.get("address")
        ]
        for aip in admin_ips:
            if aip not in exempt_ips:
                exempt_ips.append(aip)

        if admin_ips:
            ensure_admin_bypass(admin_ips)

        # 2. Sincronizar address-list de la Lista Blanca ('lab-whitelist') y Exentos
        for e in list(addr_list):
            list_name = e.get("list") or ""
            if list_name in (WHITELIST_NAME, EXEMPT_LIST_NAME) or list_name.startswith("lab-wl-tgt-") or list_name.startswith("lab-wl-exc-"):
                eid = e.get(".id") or e.get("id")
                if eid:
                    try:
                        addr_list.remove(eid)
                    except Exception:
                        pass

        # Agregar IPs exentas globales
        for xip in exempt_ips:
            if xip:
                try:
                    addr_list.add(list=EXEMPT_LIST_NAME, address=xip, comment="lab-filter-exempt")
                except Exception:
                    pass

        # Normalizar allowed_domains a lista de diccionarios estructurados
        rules_dominios = []
        for idx, item in enumerate(allowed_domains):
            if isinstance(item, dict):
                rules_dominios.append(item)
            elif isinstance(item, str) and item.strip():
                rules_dominios.append({
                    "id": idx + 1,
                    "dominio": item.strip(),
                    "alcance": "todos",
                    "target_ips": [],
                })

        def expandir_subdominios(d_str: str) -> set:
            d_clean = d_str.strip().lower()
            res = {d_clean}
            if "google" in d_clean:
                res.update(["google.com", "gstatic.com", "googleusercontent.com", "googleapis.com", "ggpht.com", "gvt1.com"])
            elif "wikipedia" in d_clean:
                res.update(["wikipedia.org", "wikimedia.org", "wikidata.org"])
            elif "github" in d_clean:
                res.update(["github.com", "githubassets.com", "githubusercontent.com", "githubcopilot.com"])
            elif "youtube" in d_clean or "youtu.be" in d_clean:
                res.update([
                    "youtube.com", "googlevideo.com", "ytimg.com", "youtu.be",
                    "google.com", "gstatic.com", "googleapis.com", "ggpht.com", "gvt1.com"
                ])
            return res

        dominios_expandidos_global = set()
        for r_dom in rules_dominios:
            dominios_expandidos_global.update(expandir_subdominios(r_dom["dominio"]))

        for d in dominios_expandidos_global:
            try:
                addr_list.add(list=WHITELIST_NAME, address=d, comment="lab-whitelist-entry")
            except Exception as ex:
                pass

        # 3. Configurar DNS Estático en RouterOS v7 (FWD hacia 8.8.8.8 con match-subdomain=yes + Sinkhole)
        try:
            dns_path = api.path("ip", "dns", "static")
            for entry in list(dns_path):
                c = entry.get("comment", "")
                if c.startswith("lab-wl-") or c.startswith("lab-dns-") or c == "lab-wl-block-yt":
                    eid = entry.get(".id") or entry.get("id")
                    if eid:
                        try:
                            dns_path.remove(eid)
                        except Exception:
                            pass

            # A. Sondas esenciales de Windows, Google y Apple (para que Windows y Android no muestren "Sin Internet")
            system_fwd_domains = [
                "msftconnecttest.com",
                "msftncsi.com",
                "connectivitycheck.gstatic.com",
                "connectivitycheck.android.com",
                "clients3.google.com",
                "captive.apple.com",
            ]
            for s_dom in system_fwd_domains:
                try:
                    dns_path.add(
                        name=s_dom,
                        type="FWD",
                        comment="lab-wl-dns-sys",
                        **{"forward-to": "8.8.8.8", "match-subdomain": "yes"}
                    )
                except Exception as ex:
                    print(f"Nota agregando FWD DNS para {s_dom}:", ex)

            # B. FWD para todas las plataformas de la Lista Blanca (con match-subdomain=yes)
            for d in dominios_expandidos_global:
                try:
                    dns_path.add(
                        name=d,
                        type="FWD",
                        comment="lab-wl-dns-fwd",
                        **{"forward-to": "8.8.8.8", "match-subdomain": "yes"}
                    )
                except Exception as ex:
                    print(f"Nota agregando FWD DNS para {d}:", ex)

            # C. SINKHOLE: Todo otro dominio que no esté en la Lista Blanca se resuelve a 0.0.0.0
            dns_path.add(
                regexp=".*",
                address="0.0.0.0",
                comment="lab-wl-dns-sinkhole",
            )
        except Exception as dns_ex:
            print("Error configurando DNS static FWD y sinkhole:", dns_ex)

        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass

        # 4. Limpiar reglas anteriores de Lista Blanca en Firewall Filter
        for r in list(filter_path):
            c = r.get("comment", "")
            if c.startswith("lab-wl-") or c.startswith("lab-whitelist-"):
                eid = r.get(".id") or r.get("id")
                if eid:
                    try:
                        filter_path.remove(eid)
                    except Exception:
                        pass

        # 5. Reglas de Firewall Filter para Lista Blanca:
        rules_to_create = []

        # A. Conexiones ya establecidas y relacionadas (REGLA PRIORITARIA #1 DE FIREWALL)
        rules_to_create.append({
            "chain": "forward",
            "connection-state": "established,related",
            "action": "accept",
            "comment": "lab-wl-established",
        })

        # B. Paso libre total para Admin y Exentos
        rules_to_create.append({
            "chain": "forward",
            "src-address-list": ADMIN_LIST_NAME,
            "action": "accept",
            "comment": "lab-wl-admin-pass",
        })
        rules_to_create.append({
            "chain": "forward",
            "src-address-list": EXEMPT_LIST_NAME,
            "action": "accept",
            "comment": "lab-wl-exempt-pass",
        })

        # C. Tráfico al servidor local / portal cautivo siempre permitido
        rules_to_create.append({
            "chain": "forward",
            "dst-address": "192.168.88.252",
            "action": "accept",
            "comment": "lab-wl-local-server",
        })

        # D. Permitir DNS y NTP
        rules_to_create.append({
            "chain": "forward",
            "protocol": "udp",
            "dst-port": "53",
            "action": "accept",
            "comment": "lab-wl-allow-dns-udp",
        })
        rules_to_create.append({
            "chain": "forward",
            "protocol": "tcp",
            "dst-port": "53",
            "action": "accept",
            "comment": "lab-wl-allow-dns-tcp",
        })
        rules_to_create.append({
            "chain": "forward",
            "protocol": "udp",
            "dst-port": "123",
            "action": "accept",
            "comment": "lab-wl-allow-ntp",
        })

        # E. RECHAZAR QUIC (UDP 443) con ICMP port unreachable
        # Esto previene el error QUIC_NETWORK_IDLE_TIMEOUT y fuerza a Chrome a usar TCP HTTPS instantáneamente
        rules_to_create.append({
            "chain": "forward",
            "protocol": "udp",
            "dst-port": "443",
            "action": "reject",
            "reject-with": "icmp-port-unreachable",
            "comment": "lab-wl-block-quic",
        })

        # F. DESCARTAR TRÁFICO HACIA DIRECCIONES SINKHOLE (0.0.0.0)
        rules_to_create.append({
            "chain": "forward",
            "dst-address": "0.0.0.0",
            "action": "reject",
            "reject-with": "tcp-reset",
            "comment": "lab-wl-block-sinkhole",
        })

        # G. Si YouTube NO está en la Lista Blanca, BLOQUEARLO EXPLÍCITAMENTE POR TLS/SNI
        youtube_autorizado = any("youtube" in r_dom["dominio"] for r_dom in rules_dominios)
        if not youtube_autorizado:
            for y_sni in ["*youtube*", "*googlevideo*", "*ytimg*", "*youtu.be*"]:
                rules_to_create.append({
                    "chain": "forward",
                    "protocol": "tcp",
                    "dst-port": "443",
                    "tls-host": y_sni,
                    "action": "reject",
                    "reject-with": "tcp-reset",
                    "comment": f"lab-wl-block-yt-{y_sni.strip('*')[:10]}",
                })

        # H. Reglas TLS-Host por Dominio según su Alcance específico (solo seleccionados / todos excepto)
        for r_dom in rules_dominios:
            dom_id = r_dom.get("id", 0)
            alcance = r_dom.get("alcance", "todos")
            target_ips = r_dom.get("target_ips", [])
            subdominios = expandir_subdominios(r_dom["dominio"])

            if alcance == "solo_seleccionados" and target_ips:
                list_name_tgt = f"lab-wl-tgt-{dom_id}"
                for tip in target_ips:
                    try:
                        addr_list.add(list=list_name_tgt, address=tip, comment=f"lab-wl-tgt-{dom_id}")
                    except Exception:
                        pass
                for sd in subdominios:
                    rules_to_create.append({
                        "chain": "forward",
                        "protocol": "tcp",
                        "dst-port": "443",
                        "src-address-list": f"!{list_name_tgt}",
                        "tls-host": f"*{sd}*",
                        "action": "reject",
                        "reject-with": "tcp-reset",
                        "comment": f"lab-wl-tls-block-non-sel-{sd[:10]}",
                    })
            elif alcance == "todos_excepto" and target_ips:
                list_name_exc = f"lab-wl-exc-{dom_id}"
                for tip in target_ips:
                    try:
                        addr_list.add(list=list_name_exc, address=tip, comment=f"lab-wl-exc-{dom_id}")
                    except Exception:
                        pass
                for sd in subdominios:
                    rules_to_create.append({
                        "chain": "forward",
                        "protocol": "tcp",
                        "dst-port": "443",
                        "src-address-list": list_name_exc,
                        "tls-host": f"*{sd}*",
                        "action": "reject",
                        "reject-with": "tcp-reset",
                        "comment": f"lab-wl-tls-exc-{sd[:10]}",
                    })

        # I. PERMITIR NAVEGACIÓN WEB (TCP 80 y 443)
        # Los dominios bloqueados ya son filtrados de raíz por DNS (resueltos a 0.0.0.0 y rechazados por la regla F).
        # Los dominios autorizados navegan con todos sus subdominios y CDNs de video/imágenes sin restricciones.
        rules_to_create.append({
            "chain": "forward",
            "protocol": "tcp",
            "dst-port": "80,443",
            "action": "accept",
            "comment": "lab-wl-allow-web-traffic",
        })

        # Crear cada regla individualmente
        created_rule_ids = []
        for r_args in rules_to_create:
            try:
                res = filter_path.add(**r_args)
                rid = res if isinstance(res, str) else (res.get(".id") if isinstance(res, dict) else None)
                if rid:
                    created_rule_ids.append(rid)
            except Exception as r_err:
                print(f"Nota agregando regla de firewall ({r_args.get('comment')}):", r_err)

        # Mover las reglas de la Lista Blanca hacia la posición superior manteniendo el orden correcto
        try:
            for rid in reversed(created_rule_ids):
                try:
                    api("ip/firewall/filter/move", numbers=rid, destination=0)
                except Exception:
                    pass
        except Exception:
            pass

        # 7. Prevenir fugas o bypass por IPv6 (fuerza todo el tráfico por IPv4 supervisado)
        try:
            ipv6_filter = api.path("ipv6", "firewall", "filter")
            has_ipv6_block = any(
                (r.get("comment") or "") == "lab-block-ipv6-bypass"
                for r in list(ipv6_filter)
            )
            if not has_ipv6_block:
                ipv6_filter.add(
                    chain="forward",
                    action="drop",
                    comment="lab-block-ipv6-bypass",
                )
        except Exception:
            pass

    except Exception as e:
        print("Error en sync_whitelist_filter:", e)
    finally:
        api.close()


def add_whitelist_domain(domain: str, alcance: str = "todos", target_ips=None, exempt_ips=None) -> None:
    """Añade un dominio a la Lista Blanca de MikroTik."""
    d_clean = domain.strip().lower()
    if not d_clean:
        return
    api = get_connection()
    try:
        addr_list = api.path("ip", "firewall", "address-list")
        filter_path = api.path("ip", "firewall", "filter")

        # Agregar a la lista lab-whitelist
        exists = any(
            e.get("list") == WHITELIST_NAME and e.get("address") == d_clean
            for e in list(addr_list)
        )
        if not exists:
            addr_list.add(list=WHITELIST_NAME, address=d_clean, comment="lab-whitelist-entry")

        # Agregar regla TLS-Host de paso antes del catch-all
        filter_path.add(
            chain="forward",
            protocol="tcp",
            **{"dst-port": "443"},
            **{"tls-host": f"*{d_clean}*"},
            action="accept",
            comment=f"lab-wl-tls-{d_clean[:14]}",
        )

        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass
    except Exception as e:
        print("Error en add_whitelist_domain:", e)
    finally:
        api.close()


def remove_whitelist_domain(domain: str) -> None:
    """Remueve un dominio de la Lista Blanca de MikroTik."""
    d_clean = domain.strip().lower()
    if not d_clean:
        return
    api = get_connection()
    try:
        addr_list = api.path("ip", "firewall", "address-list")
        for e in list(addr_list):
            if e.get("list") == WHITELIST_NAME and e.get("address") == d_clean:
                eid = e.get(".id") or e.get("id")
                if eid:
                    addr_list.remove(eid)

        filter_path = api.path("ip", "firewall", "filter")
        target_comment = f"lab-wl-tls-{d_clean[:14]}"
        for r in list(filter_path):
            if r.get("comment") == target_comment or r.get("tls-host") == f"*{d_clean}*":
                eid = r.get(".id") or r.get("id")
                if eid:
                    filter_path.remove(eid)

        try:
            api("ip/dns/cache/flush")
        except Exception:
            pass
    except Exception as e:
        print("Error en remove_whitelist_domain:", e)
    finally:
        api.close()


# Wrappers de compatibilidad con llamadas anteriores
def add_dns_block(domain: str, alcance: str = "todos", target_ips=None, exempt_ips=None) -> None:
    add_whitelist_domain(domain, alcance, target_ips, exempt_ips)


def remove_dns_block(domain: str) -> None:
    remove_whitelist_domain(domain)


def get_dns_blocks() -> list[str]:
    api = get_connection()
    try:
        dns_stat = api.path("ip", "dns", "static")
        fwd_names = [e.get("name") for e in dns_stat if e.get("type") == "FWD" and e.get("name") and e.get("comment") == "lab-wl-dns-fwd"]
        if fwd_names:
            return sorted(list(set(fwd_names)))
        addr_list = api.path("ip", "firewall", "address-list")
        return [e.get("address") for e in addr_list if e.get("list") == WHITELIST_NAME and e.get("address")]
    except Exception:
        return []
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

    # Test login API RouterOS y lectura de recursos
    try:
        api = get_connection()
        uptime = "Activo"
        version = ""
        try:
            res = list(api.path("system", "resource"))
            if res:
                r = res[0]
                raw_up = str(r.get("uptime", "Activo"))
                uptime = raw_up
                cpu_load = f"{r.get('cpu-load', '0')}%"
                board_name = str(r.get("board-name", "RB750Gr3"))
                version = str(r.get("version", ""))
        except Exception:
            pass
        finally:
            api.close()

        return {
            "conectado": True,
            "tcp_alcanzable": True,
            "host": host,
            "puerto": port,
            "uptime": uptime,
            "cpu_load": cpu_load,
            "board_name": board_name,
            "version": version,
            "error": None,
        }
    except Exception as e:
        return {
            "conectado": False,
            "tcp_alcanzable": True,
            "host": host,
            "puerto": port,
            "uptime": "Desconectado",
            "cpu_load": "0%",
            "board_name": "MikroTik",
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


def get_mikrotik_active_network_macs() -> set[str]:
    """
    Obtiene el conjunto de direcciones MAC que tienen presencia y tráfico físico real en MikroTik:
    1. /interface/wireless/registration-table y /interface/wifi/registration-table (Wi-Fi activo).
    2. /interface/bridge/host (tabla de reenvío de hardware del bridge con tráfico reciente, age < 30s).
    3. /ip/hotspot/active (sesiones hotspot actualmente en curso).
    """
    api = get_connection()
    active_macs = set()
    try:
        # 1. Clientes Wi-Fi físicamente asociados (registration-table)
        try:
            reg_table = api.path("interface", "wireless", "registration-table")
            for r in reg_table:
                mac = (r.get("mac-address") or "").strip().upper()
                if mac:
                    active_macs.add(mac)
        except Exception:
            pass

        try:
            wifi_regs = api.path("interface", "wifi", "registration-table")
            for r in wifi_regs:
                mac = (r.get("mac-address") or "").strip().upper()
                if mac:
                    active_macs.add(mac)
        except Exception:
            pass

        # 2. Hosts en el bridge (con tráfico reciente no caducado)
        try:
            bridge_hosts = api.path("interface", "bridge", "host")
            for h in bridge_hosts:
                m = (h.get("mac-address") or "").strip().upper()
                if m and not h.get("local", False):
                    # Si el router reporta edad elevada (minutos o días), el equipo dejó de emitir paquetes
                    age_str = str(h.get("age") or "0s").lower()
                    if "m" in age_str or "h" in age_str or "d" in age_str:
                        continue
                    if ":" in age_str:
                        partes = age_str.split(":")
                        if len(partes) >= 2:
                            try:
                                if int(partes[-2]) > 0:
                                    continue
                            except Exception:
                                pass
                    active_macs.add(m)
        except Exception as e:
            print("Nota consulta bridge host:", e)

        # 3. Clientes Hotspot activos
        try:
            hotspot_actives = api.path("ip", "hotspot", "active")
            for ha in hotspot_actives:
                m = (ha.get("mac-address") or "").strip().upper()
                if m:
                    active_macs.add(m)
        except Exception:
            pass

        return active_macs
    finally:
        api.close()


def remove_dhcp_lease_mikrotik(mac_address: str | None = None, ip_address: str | None = None) -> bool:
    """
    Elimina una concesión DHCP inactiva directamente del router MikroTik.
    Evita que dispositivos desconectados sigan apareciendo como leases vigentes en el router.
    """
    if not mac_address and not ip_address:
        return False
    mac_norm = (mac_address or "").strip().upper()
    api = get_connection()
    try:
        leases = api.path("ip", "dhcp-server", "lease")
        eliminados = 0
        for l in leases:
            l_mac = (l.get("mac-address") or "").strip().upper()
            l_ip = (l.get("address") or "").strip()
            if (mac_norm and l_mac == mac_norm) or (ip_address and l_ip == ip_address):
                lid = l.get(".id") or l.get("id")
                if lid:
                    leases.remove(lid)
                    eliminados += 1
        return eliminados > 0
    except Exception as e:
        print("Nota eliminando lease DHCP en MikroTik:", e)
        return False
    finally:
        api.close()


def make_dhcp_lease_static(mac_address: str, ip_address: str, comment: str = "") -> bool:
    """
    Convierte la concesión DHCP en ESTÁTICA (Static Lease) en MikroTik.
    Amarra la IP exclusivamente a la MAC indicada, impidiendo que el servidor DHCP
    la recicle o se la asigne a otro dispositivo.
    """
    if not mac_address or not ip_address:
        return False
    mac_norm = mac_address.strip().upper()
    ip_norm = ip_address.strip()
    api = get_connection()
    try:
        leases = api.path("ip", "dhcp-server", "lease")
        encontrado = False
        for l in leases:
            l_mac = (l.get("mac-address") or "").strip().upper()
            if l_mac == mac_norm:
                lid = l.get(".id") or l.get("id")
                is_dyn = l.get("dynamic", False)
                if is_dyn and lid:
                    try:
                        api("ip/dhcp-server/lease/make-static", **{".id": lid})
                    except Exception:
                        pass
                try:
                    update_kwargs = {"comment": comment or f"NetworkLab - {mac_norm}"}
                    if ip_norm and l.get("address") != ip_norm:
                        update_kwargs["address"] = ip_norm
                    leases.update(**{".id": lid, **update_kwargs})
                except Exception as ex:
                    print("Nota actualizando lease estático:", ex)
                encontrado = True
                break

        if not encontrado:
            try:
                leases.add(
                    address=ip_norm,
                    **{
                        "mac-address": mac_norm,
                        "comment": comment or f"NetworkLab - {mac_norm}",
                    }
                )
            except Exception as ex:
                print("Nota registrando nueva reserva estática:", ex)
        return True
    except Exception as e:
        print("Error en make_dhcp_lease_static:", e)
        return False
    finally:
        api.close()





