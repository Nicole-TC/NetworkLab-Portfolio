import subprocess
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Dispositivo, EstadoDispositivo, Sesion
from app.config import settings
from app import routeros_client

router = APIRouter(prefix="/devices", tags=["devices"])


def check_ip_ping(ip: str) -> bool:
    """Verifica si la IP responde a ping (ICMP) o arping en la red en tiempo real."""
    if not ip or ip.strip() in ("127.0.0.1", "localhost", "::1"):
        return True
    clean_ip = ip.strip()
    try:
        res = subprocess.run(
            ["ping", "-c", "1", "-W", "1", clean_ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1.2,
        )
        if res.returncode == 0:
            return True
    except Exception:
        pass

    try:
        res_arp = subprocess.run(
            ["arping", "-c", "1", "-w", "1", clean_ip],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1.2,
        )
        if res_arp.returncode == 0:
            return True
    except Exception:
        pass

    return False


_last_exempt_cache: tuple | None = None


@router.post("/sync")
def sync_devices(db: Session = Depends(get_db)):
    """
    Consulta los leases DHCP del router y da de alta o actualiza los dispositivos.
    - Verifica presencia física real (Bridge/Wi-Fi/Ping/ARPing) para no revivir dispositivos desconectados.
    - La consola de administración se auto-aprueba y protege.
    - Los dispositivos de alumnos en DHCP que no tengan sesión activa pasan
      a estado 'pendiente' para aparecer de inmediato en la pestaña de Pendientes.
    - Cierra sesiones automáticamente si el dispositivo se desconecta de la red física.
    """
    global _last_exempt_cache
    try:
        leases = routeros_client.get_dhcp_leases()
        active_macs = routeros_client.get_hotspot_active_macs()
        real_active_macs = routeros_client.get_mikrotik_active_network_macs()
        nuevos = 0
        admin_macs = settings.admin_mac_list

        for lease in leases:
            mac = lease["mac_address"]
            if not mac:
                continue

            mac_norm = mac.strip().upper()
            es_admin = mac_norm in admin_macs
            is_physically_active = es_admin or (mac_norm in real_active_macs) or check_ip_ping(lease.get("ip_address"))

            device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == mac).first()
            if device is None:
                # Solo dar de alta nuevos dispositivos si son la consola admin o tienen presencia activa real
                if not (es_admin or is_physically_active):
                    continue

                estado_inicial = EstadoDispositivo.aprobado if es_admin else EstadoDispositivo.pendiente
                nombre_host = lease["hostname"] or ("Administrador" if es_admin else "")

                rol_inicial = "admin" if es_admin else "nivel_1"
                device = Dispositivo(
                    direccion_mac=mac,
                    direccion_ip=lease["ip_address"],
                    nombre_host=nombre_host,
                    estado=estado_inicial,
                    rol=rol_inicial,
                    ultima_actividad=datetime.now() if is_physically_active else None,
                )
                db.add(device)
                nuevos += 1
            else:
                device.direccion_ip = lease["ip_address"]
                if lease.get("hostname"):
                    device.nombre_host = lease["hostname"]

                # Solo actualizar última actividad si el equipo está REALMENTE activo y respondiendo
                if is_physically_active:
                    ahora = datetime.now()
                    device.ultima_actividad = ahora
                    sesion = (
                        db.query(Sesion)
                        .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
                        .order_by(Sesion.inicio.desc())
                        .first()
                    )
                    if sesion:
                        ultimo = sesion.ultimo_pulso or sesion.inicio
                        delta = (ahora - ultimo).total_seconds()
                        if 0 < delta <= 90:
                            sesion.tiempo_activo_segundos = (getattr(sesion, "tiempo_activo_segundos", 0) or 0) + int(delta)
                        elif delta > 90:
                            sesion.tiempo_activo_segundos = (getattr(sesion, "tiempo_activo_segundos", 0) or 0) + 5
                        sesion.ultimo_pulso = ahora
                    elif es_admin or device.estado == EstadoDispositivo.aprobado:
                        sesion = Sesion(
                            dispositivo_id=device.id,
                            direccion_ip=device.direccion_ip,
                            inicio=ahora,
                            ultimo_pulso=ahora,
                            tiempo_activo_segundos=10,
                            esta_expirada=False,
                        )
                        db.add(sesion)

                if es_admin:
                    device.rol = "admin"
                    if device.estado != EstadoDispositivo.aprobado:
                        device.estado = EstadoDispositivo.aprobado
                    if lease.get("ip_address"):
                        try:
                            routeros_client.make_dhcp_lease_static(
                                mac_address=mac,
                                ip_address=lease["ip_address"],
                                comment="NetworkLab-ADMIN",
                            )
                        except Exception:
                            pass
                else:
                    # Si el equipo de alumno no está físicamente activo, verificar y cerrar sesión colgada
                    if not is_physically_active:
                        sesion_colgada = (
                            db.query(Sesion)
                            .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
                            .first()
                        )
                        if sesion_colgada:
                            ahora_cierre = datetime.now()
                            ultimo_p = sesion_colgada.ultimo_pulso or sesion_colgada.inicio
                            if (ahora_cierre - ultimo_p).total_seconds() >= 45:
                                sesion_colgada.fin = sesion_colgada.ultimo_pulso or ahora_cierre
                                sesion_colgada.esta_expirada = True
                                device.estado = EstadoDispositivo.pendiente
                                if device.direccion_mac:
                                    try:
                                        routeros_client.revoke_hotspot_device(device.direccion_mac)
                                    except Exception:
                                        pass
                                if device.direccion_ip:
                                    try:
                                        routeros_client.remove_bandwidth_limit(device.direccion_ip)
                                    except Exception:
                                        pass

                    # Si el equipo no es admin y NO tiene una sesión activa abierta,
                    # debe figurar en 'pendiente' para que el docente pueda autorizarlo.
                    sesion_activa = any(s.fin is None for s in device.sesiones)
                    if not sesion_activa and device.estado != EstadoDispositivo.aprobado:
                        device.estado = EstadoDispositivo.pendiente

        db.commit()

        # Sincronizar dispositivos exentos (Administradores y Whitelist) con MikroTik solo ante cambios
        try:
            exempt_ips = set()
            admin_ips = set()
            for dev in db.query(Dispositivo).all():
                m_norm = (dev.direccion_mac or "").strip().upper()
                if m_norm in admin_macs:
                    if dev.direccion_ip:
                        admin_ips.add(dev.direccion_ip)
                        exempt_ips.add(dev.direccion_ip)
                elif getattr(dev, "exento_filtro", False) or getattr(dev, "rol", "") == "nivel_2":
                    if dev.direccion_ip:
                        exempt_ips.add(dev.direccion_ip)

            current_cache = (frozenset(admin_ips), frozenset(exempt_ips))
            if current_cache != _last_exempt_cache:
                routeros_client.sync_exempt_devices(list(exempt_ips))
                if admin_ips:
                    routeros_client.ensure_admin_bypass(list(admin_ips))
                _last_exempt_cache = current_cache
        except Exception as e:
            print("Nota sincronizando exentos:", e)

        return {"nuevos_detectados": nuevos, "total_leases": len(leases), "total_activos": len(active_macs)}
    except Exception as e:
        import traceback
        return {"error": str(e), "traceback": traceback.format_exc()}



class RenameDeviceRequest(BaseModel):
    nombre_host: str


@router.post("/{device_id}/rename")
def rename_device(device_id: int, datos: RenameDeviceRequest, db: Session = Depends(get_db)):
    """Permite asignar o actualizar el nombre identificador de un dispositivo directamente."""
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")
    device.nombre_host = (datos.nombre_host or "").strip()
    db.commit()
    return {"ok": True, "id": device.id, "nombre_host": device.nombre_host}


@router.get("/")
def list_devices(estado: EstadoDispositivo | None = None, db: Session = Depends(get_db)):
    query = db.query(Dispositivo)
    if estado:
        query = query.filter(Dispositivo.estado == estado)
    dispositivos = query.order_by(Dispositivo.ultima_actividad.desc()).all()

    admin_macs = settings.admin_mac_list
    ahora = datetime.now()
    real_active_macs = routeros_client.get_mikrotik_active_network_macs()
    resultado = []
    for d in dispositivos:
        mac_norm = (d.direccion_mac or "").strip().upper()
        es_admin = mac_norm in admin_macs
        sesion_activa_obj = next((s for s in d.sesiones if s.fin is None), None)
        sesion_activa = sesion_activa_obj is not None

        # Presencia física real: enlace en switch/bridge MikroTik, ARP activo o respuesta ping
        esta_presente_red = es_admin or (mac_norm in real_active_macs) or check_ip_ping(d.direccion_ip)
        actividad_reciente = d.ultima_actividad and (ahora - d.ultima_actividad).total_seconds() < 90

        # Un equipo solo está en línea si es admin o si está REALMENTE presente en la red
        en_linea = es_admin or (esta_presente_red and (sesion_activa or bool(actividad_reciente)))

        usuario_nombre = None
        usuario_username = None
        if getattr(d, "usuario", None):
            usuario_nombre = d.usuario.nombre_completo or d.usuario.nombre_usuario
            usuario_username = d.usuario.nombre_usuario

        es_mac_aleatoria = False
        if mac_norm and len(mac_norm) >= 2:
            try:
                prim_byte = int(mac_norm.split(":")[0], 16)
                es_mac_aleatoria = bool(prim_byte & 2)
            except Exception:
                pass

        rol_final = "admin" if es_admin else (getattr(d, "rol", None) or "nivel_1")
        resultado.append(
            {
                "id": d.id,
                "direccion_mac": d.direccion_mac,
                "direccion_ip": d.direccion_ip,
                "nombre_host": d.nombre_host,
                "usuario_id": d.usuario_id,
                "usuario_nombre": usuario_nombre,
                "usuario_username": usuario_username,
                "es_mac_aleatoria": es_mac_aleatoria,
                "estado": d.estado.value if hasattr(d.estado, "value") else str(d.estado),
                "rol": rol_final,
                "primera_conexion": d.primera_conexion,
                "ultima_actividad": d.ultima_actividad,
                "limite_velocidad_mbps": d.limite_velocidad_mbps,
                "limite_tiempo_minutos": sesion_activa_obj.limite_tiempo_minutos if sesion_activa_obj else None,
                "es_admin": es_admin,
                "exento_filtro": bool(getattr(d, "exento_filtro", False) or es_admin),
                "en_linea": en_linea,
            }
        )
    return resultado



@router.post("/{device_id}/approve")
def approve_device(
    device_id: int,
    time_limit_minutes: int | None = None,
    bandwidth_limit_mbps: int | None = None,
    rol: str | None = "nivel_1",
    exento_filtro: bool | None = None,
    custom_username: str | None = None,
    custom_password: str | None = None,
    db: Session = Depends(get_db),
):
    from app.models import Usuario, RolUsuario, PoliticaRol
    from app.auth import hashear_clave

    import traceback
    try:
        device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
        if not device:
            raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

        rol_final = (rol or getattr(device, "rol", "nivel_1") or "nivel_1").strip()
        device.rol = rol_final

        politica = db.query(PoliticaRol).filter(PoliticaRol.rol == rol_final).first()
        if time_limit_minutes is None and politica:
            time_limit_minutes = politica.tiempo_defecto_minutos
        if bandwidth_limit_mbps is None and politica:
            bandwidth_limit_mbps = politica.velocidad_defecto_mbps

        if exento_filtro is not None:
            device.exento_filtro = exento_filtro
        elif politica:
            device.exento_filtro = bool(politica.exento_filtro_defecto)
        elif rol_final == "nivel_2":
            device.exento_filtro = True

        rol_user_enum = RolUsuario.nivel_2 if rol_final == "nivel_2" else RolUsuario.nivel_1

        # 1. Crear o actualizar la cuenta de usuario para este equipo
        nombre_user = (custom_username or device.direccion_ip or device.nombre_host or f"pc-{device.id}").strip()
        clave_plana = (custom_password or "1234").strip()

        usuario_asignado = None
        if device.usuario_id:
            usuario_asignado = db.query(Usuario).filter(Usuario.id == device.usuario_id).first()

        if not usuario_asignado:
            usuario_existente_por_nombre = db.query(Usuario).filter(Usuario.nombre_usuario == nombre_user).first()
            if usuario_existente_por_nombre:
                usuario_asignado = usuario_existente_por_nombre
                usuario_asignado.clave_hash = hashear_clave(clave_plana)
                usuario_asignado.rol = rol_user_enum
                usuario_asignado.esta_activo = True
            else:
                usuario_asignado = Usuario(
                    nombre_usuario=nombre_user,
                    clave_hash=hashear_clave(clave_plana),
                    rol=rol_user_enum,
                    nombre_completo=device.nombre_host or f"Estación {nombre_user}",
                    esta_activo=True,
                )
                db.add(usuario_asignado)
                db.commit()
                db.refresh(usuario_asignado)
        else:
            if custom_password:
                usuario_asignado.clave_hash = hashear_clave(clave_plana)
            if custom_username:
                usuario_asignado.nombre_usuario = nombre_user
            usuario_asignado.rol = rol_user_enum
            usuario_asignado.esta_activo = True

        device.usuario_id = usuario_asignado.id
        device.estado = EstadoDispositivo.aprobado
        device.limite_velocidad_mbps = bandwidth_limit_mbps
        db.commit()

        # Reservar la IP de forma estática en MikroTik para que sea única y permanente
        if device.direccion_mac and device.direccion_ip:
            try:
                routeros_client.make_dhcp_lease_static(
                    mac_address=device.direccion_mac,
                    ip_address=device.direccion_ip,
                    comment=f"NetworkLab-{device.nombre_host or device.id}",
                )
            except Exception as e:
                print("Nota reservando lease estático al aprobar:", e)

        # Sincronizar exentos en MikroTik
        admin_macs = settings.admin_mac_list
        exempt_ips = set()
        for d in db.query(Dispositivo).all():
            m_norm = (d.direccion_mac or "").strip().upper()
            if m_norm in admin_macs or getattr(d, "exento_filtro", False):
                if d.direccion_ip:
                    exempt_ips.add(d.direccion_ip)
        try:
            routeros_client.sync_exempt_devices(list(exempt_ips))
        except Exception as e:
            print("Nota sync exentos:", e)

        if device.direccion_ip:
            routeros_client.unblock_device(device.direccion_ip)
            routeros_client.set_bandwidth_limit(device.direccion_ip, bandwidth_limit_mbps)

        if device.direccion_mac:
            routeros_client.authorize_hotspot_device(device.direccion_mac, device.direccion_ip)

        # 2. Crear o reactivar la sesión activa con su límite de tiempo y usuario
        ahora = datetime.now()
        sesion_abierta = (
            db.query(Sesion)
            .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
            .first()
        )

        if sesion_abierta:
            sesion_abierta.limite_tiempo_minutos = time_limit_minutes
            sesion_abierta.limite_velocidad_mbps = bandwidth_limit_mbps
            sesion_abierta.usuario_id = usuario_asignado.id
            sesion_abierta.inicio = ahora
            sesion_abierta.ultimo_pulso = ahora
            sesion_abierta.esta_expirada = False
        else:
            nueva_sesion = Sesion(
                dispositivo_id=device.id,
                usuario_id=usuario_asignado.id,
                direccion_ip=device.direccion_ip,
                inicio=ahora,
                ultimo_pulso=ahora,
                limite_tiempo_minutos=time_limit_minutes,
                limite_velocidad_mbps=bandwidth_limit_mbps,
                esta_expirada=False,
            )
            db.add(nueva_sesion)

        db.commit()

        return {
            "ok": True,
            "device_id": device_id,
            "estado": device.estado.value if hasattr(device.estado, "value") else str(device.estado),
            "limite_tiempo_minutos": time_limit_minutes,
            "limite_velocidad_mbps": bandwidth_limit_mbps,
            "usuario_creado": {
                "id": usuario_asignado.id,
                "nombre_usuario": usuario_asignado.nombre_usuario,
                "clave_usada": clave_plana,
            },
        }
    except HTTPException:
        raise
    except Exception as e:
        tb = traceback.format_exc()
        print("ERROR IN APPROVE_DEVICE:", tb)
        raise HTTPException(status_code=500, detail=f"{str(e)}: {tb}")


@router.post("/{device_id}/bandwidth")
def update_bandwidth(
    device_id: int,
    bandwidth_limit_mbps: int | None = None,
    db: Session = Depends(get_db),
):
    """Actualiza la velocidad máxima de un dispositivo en caliente (QoS Simple Queues)."""
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.limite_velocidad_mbps = bandwidth_limit_mbps

    # Actualizar la sesión activa si existe
    sesion_abierta = (
        db.query(Sesion)
        .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
        .first()
    )
    if sesion_abierta:
        sesion_abierta.limite_velocidad_mbps = bandwidth_limit_mbps

    db.commit()

    if device.direccion_ip and device.estado == EstadoDispositivo.aprobado:
        routeros_client.set_bandwidth_limit(device.direccion_ip, bandwidth_limit_mbps)

    return {
        "ok": True,
        "device_id": device_id,
        "limite_velocidad_mbps": bandwidth_limit_mbps,
    }


@router.post("/{device_id}/config")
def update_device_config(
    device_id: int,
    time_limit_minutes: int | None = None,
    bandwidth_limit_mbps: int | None = None,
    nombre_host: str | None = None,
    rol: str | None = None,
    exento_filtro: bool | None = None,
    db: Session = Depends(get_db),
):
    """Actualiza configuración completa (tiempo, velocidad QoS, nombre de estación, rol, filtro) de un equipo."""
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    if nombre_host is not None and nombre_host.strip():
        device.nombre_host = nombre_host.strip()

    if rol is not None and rol.strip():
        device.rol = rol.strip()

    device.limite_velocidad_mbps = bandwidth_limit_mbps

    if exento_filtro is not None:
        device.exento_filtro = exento_filtro
    elif device.rol == "nivel_2" and device.exento_filtro is False:
        device.exento_filtro = True

    # Actualizar la sesión activa si existe
    sesion_abierta = (
        db.query(Sesion)
        .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
        .first()
    )
    if sesion_abierta:
        sesion_abierta.limite_velocidad_mbps = bandwidth_limit_mbps
        sesion_abierta.limite_tiempo_minutos = time_limit_minutes

    db.commit()

    if device.direccion_ip and device.estado == EstadoDispositivo.aprobado:
        routeros_client.set_bandwidth_limit(device.direccion_ip, bandwidth_limit_mbps)

    # Sincronizar lista de exentos en MikroTik
    admin_macs = settings.admin_mac_list
    exempt_ips = set()
    for d in db.query(Dispositivo).all():
        m_norm = (d.direccion_mac or "").strip().upper()
        if m_norm in admin_macs or getattr(d, "exento_filtro", False):
            if d.direccion_ip:
                exempt_ips.add(d.direccion_ip)
    try:
        routeros_client.sync_exempt_devices(list(exempt_ips))
    except Exception as e:
        print("Nota sync exentos:", e)

    return {
        "ok": True,
        "device_id": device_id,
        "nombre_host": device.nombre_host,
        "limite_tiempo_minutos": time_limit_minutes,
        "limite_velocidad_mbps": bandwidth_limit_mbps,
        "exento_filtro": getattr(device, "exento_filtro", False),
    }


@router.post("/{device_id}/toggle-filtro")
def toggle_filtro_dispositivo(device_id: int, db: Session = Depends(get_db)):
    """Alterna si un equipo está exento o sujeto al filtrado web."""
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.exento_filtro = not bool(getattr(device, "exento_filtro", False))
    db.commit()

    admin_macs = settings.admin_mac_list
    exempt_ips = set()
    for d in db.query(Dispositivo).all():
        m_norm = (d.direccion_mac or "").strip().upper()
        if m_norm in admin_macs or getattr(d, "exento_filtro", False):
            if d.direccion_ip:
                exempt_ips.add(d.direccion_ip)
    try:
        routeros_client.sync_exempt_devices(list(exempt_ips))
    except Exception as e:
        print("Nota sync exentos:", e)

    return {
        "ok": True,
        "device_id": device_id,
        "exento_filtro": device.exento_filtro,
        "mensaje": "Dispositivo exento del filtro web" if device.exento_filtro else "Dispositivo sujeto al filtro web",
    }


@router.post("/{device_id}/reject")
def reject_device(device_id: int, db: Session = Depends(get_db)):
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.estado = EstadoDispositivo.rechazado
    db.commit()

    # Cerrar sesiones activas
    for s in device.sesiones:
        if s.fin is None:
            s.fin = datetime.now()
            s.esta_expirada = True
    db.commit()

    # Expulsar y aislar activamente de la red MikroTik (Wi-Fi deauth, Hotspot disconnect, DHCP lease purge, ARP drop, Firewall drop)
    res_kick = {}
    try:
        res_kick = routeros_client.kick_and_isolate_device(device.direccion_mac, device.direccion_ip)
    except Exception as e:
        print(f"Nota expulsando dispositivo {device_id} en MikroTik: {e}")

    return {"ok": True, "device_id": device_id, "estado": device.estado, "mikrotik_isolation": res_kick}


@router.delete("/{device_id}")
def delete_device(device_id: int, db: Session = Depends(get_db)):
    """Elimina un dispositivo de la base de datos (siempre que no sea el administrador)."""
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    mac_norm = (device.direccion_mac or "").strip().upper()
    if mac_norm in settings.admin_mac_list or device.rol == "admin":
        raise HTTPException(status_code=403, detail="No se puede eliminar la consola administradora protegida")

    for s in list(device.sesiones):
        db.delete(s)

    db.delete(device)
    db.commit()
    return {"ok": True, "eliminado": device_id}


@router.post("/purge-offline")
def purge_offline_devices(db: Session = Depends(get_db)):
    """
    Limpia todos los dispositivos físicamente desconectados de la red y de MikroTik.
    Elimina la concesión DHCP obsoleta en RouterOS para que no vuelvan a revivir.
    """
    admin_macs = settings.admin_mac_list
    dispositivos = db.query(Dispositivo).all()
    real_active_macs = routeros_client.get_mikrotik_active_network_macs()
    eliminados = 0

    for d in dispositivos:
        mac_norm = (d.direccion_mac or "").strip().upper()
        if mac_norm in admin_macs or d.rol == "admin":
            continue

        esta_presente = (mac_norm in real_active_macs) or check_ip_ping(d.direccion_ip)

        if not esta_presente:
            # 1. Eliminar concesión DHCP remanente en MikroTik para evitar que vuelva a reaparecer
            try:
                routeros_client.remove_dhcp_lease_mikrotik(
                    mac_address=d.direccion_mac, ip_address=d.direccion_ip
                )
            except Exception as e:
                print(f"Nota purgando lease de MikroTik para {d.direccion_ip}: {e}")

            # 2. Desconectar de Hotspot si aún quedara sesión colgada en RouterOS
            try:
                routeros_client.kick_hotspot_active(mac_address=d.direccion_mac, ip_address=d.direccion_ip)
            except Exception:
                pass

            # 3. Eliminar sesiones y dispositivo en la BD local
            for s in list(d.sesiones):
                db.delete(s)
            db.delete(d)
            eliminados += 1

    db.commit()
    return {"ok": True, "purgados": eliminados}




