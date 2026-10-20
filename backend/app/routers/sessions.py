from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session as DBSession

from app.database import get_db
from app.models import Dispositivo, EstadoDispositivo, Sesion
from app.config import settings
from app.routers.devices import check_ip_ping
from app import routeros_client

router = APIRouter(prefix="/sessions", tags=["sessions"])

# Tiempo máximo sin presencia física antes de cerrar automáticamente la sesión (en segundos)
DISCONNECT_TIMEOUT_SECONDS = 45


@router.post("/sync")
def sync_sessions(db: DBSession = Depends(get_db)):
    """
    Recorre los leases DHCP actuales y:
    - Si un dispositivo APROBADO está presente y no tiene sesión
      abierta, abre una sesión nueva.
    - Si ya tiene sesión abierta y está físicamente activo, actualiza 'ultimo_pulso'.
    - Verifica si alguna sesión superó su 'limite_tiempo_minutos'; si expiró,
      corta el acceso en MikroTik y cierra la sesión.
    - Cierra de inmediato las sesiones abiertas de dispositivos que se desconectaron de la red física.
    """
    leases = routeros_client.get_dhcp_leases()
    active_macs = routeros_client.get_hotspot_active_macs()
    real_network_macs = routeros_client.get_mikrotik_active_network_macs()
    # Solo dispositivos con tráfico real en bridge o asociación Wi-Fi (NO incluir leases estáticos/inactivos)
    macs_presentes = set(active_macs).union(real_network_macs)
    admin_macs = settings.admin_mac_list

    abiertas = 0
    cerradas = 0
    ahora = datetime.now()

    # Refrescar pulso solo si el dispositivo está REALMENTE activo y respondiendo
    for lease in leases:
        mac = (lease.get("mac_address") or "").strip().upper()
        if not mac:
            continue

        device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == mac).first()
        if not device:
            continue

        es_admin = mac in admin_macs or device.rol == "admin"
        esta_activo_real = es_admin or (mac in macs_presentes) or check_ip_ping(lease.get("ip_address"))

        sesion_abierta = (
            db.query(Sesion)
            .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
            .first()
        )

        if sesion_abierta and esta_activo_real:
            ultimo = sesion_abierta.ultimo_pulso or sesion_abierta.inicio
            delta = (ahora - ultimo).total_seconds()
            if 0 < delta <= 90:
                sesion_abierta.tiempo_activo_segundos = (getattr(sesion_abierta, "tiempo_activo_segundos", 0) or 0) + int(delta)
            sesion_abierta.ultimo_pulso = ahora
            sesion_abierta.direccion_ip = lease["ip_address"]

    # Evaluar sesiones abiertas para cierre por inactividad o expiración de tiempo
    sesiones_abiertas = db.query(Sesion).filter(Sesion.fin.is_(None)).all()

    for sesion in sesiones_abiertas:
        device = db.query(Dispositivo).filter(Dispositivo.id == sesion.dispositivo_id).first()
        if not device:
            continue

        mac_norm = (device.direccion_mac or "").strip().upper()
        es_admin = mac_norm in admin_macs or device.rol == "admin"
        sigue_presente = es_admin or (mac_norm in macs_presentes) or check_ip_ping(device.direccion_ip or sesion.direccion_ip)

        # 1. Chequear si expiró el tiempo límite asignado
        if sesion.limite_tiempo_minutos is not None and sesion.limite_tiempo_minutos > 0:
            segundos_transcurridos = (ahora - sesion.inicio).total_seconds()
            if segundos_transcurridos >= sesion.limite_tiempo_minutos * 60:
                # Tiempo cumplido: Revocar Hotspot bypass y cerrar sesión
                sesion.fin = ahora
                sesion.esta_expirada = True
                device.estado = EstadoDispositivo.pendiente
                if device.direccion_mac:
                    try:
                        routeros_client.revoke_hotspot_device(device.direccion_mac)
                    except Exception:
                        pass
                if device.direccion_ip:
                    try:
                        routeros_client.remove_bandwidth_limit(device.direccion_ip)
                        routeros_client.unblock_device(device.direccion_ip)
                    except Exception:
                        pass
                cerradas += 1
                continue

        # 2. Chequear si se desconectó de la red física
        if not sigue_presente:
            ultimo = sesion.ultimo_pulso or sesion.inicio
            if (ahora - ultimo).total_seconds() >= DISCONNECT_TIMEOUT_SECONDS:
                sesion.fin = sesion.ultimo_pulso or ahora
                sesion.esta_expirada = True
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
                cerradas += 1

    db.commit()

    return {"sesiones_abiertas": abiertas, "sesiones_cerradas": cerradas}


@router.get("/")
def list_sessions(device_id: int | None = None, db: DBSession = Depends(get_db)):
    """Historial completo de sesiones con detalle de equipo, duración y estado."""
    query = db.query(Sesion)
    if device_id is not None:
        query = query.filter(Sesion.dispositivo_id == device_id)
    sesiones = query.order_by(Sesion.inicio.desc()).limit(100).all()

    ahora = datetime.now()
    resultado = []
    for s in sesiones:
        dev = s.dispositivo
        fin = s.fin or ahora
        duracion_seg = int((fin - s.inicio).total_seconds())
        resultado.append(
            {
                "id": s.id,
                "dispositivo_id": s.dispositivo_id,
                "nombre_host": dev.nombre_host if dev else "Equipo",
                "direccion_mac": dev.direccion_mac if dev else "—",
                "direccion_ip": s.direccion_ip or (dev.direccion_ip if dev else "—"),
                "inicio": s.inicio,
                "fin": s.fin,
                "esta_activa": s.fin is None,
                "duracion_segundos": duracion_seg,
                "duracion_minutos": round(duracion_seg / 60, 1),
                "limite_tiempo_minutos": s.limite_tiempo_minutos,
                "limite_velocidad_mbps": s.limite_velocidad_mbps,
            }
        )
    return resultado


@router.get("/active")
def list_active_sessions(db: DBSession = Depends(get_db)):
    """Dispositivos con sesión actualmente abierta (conectados ahora) con detalle de tiempo."""
    sesiones = (
        db.query(Sesion)
        .filter(Sesion.fin.is_(None))
        .order_by(Sesion.inicio.desc())
        .all()
    )

    ahora = datetime.now()
    resultado = []

    for s in sesiones:
        device = db.query(Dispositivo).filter(Dispositivo.id == s.dispositivo_id).first()
        segundos_transcurridos = int((ahora - s.inicio).total_seconds())

        remaining_seconds = None
        if s.limite_tiempo_minutos is not None and s.limite_tiempo_minutos > 0:
            total_segundos_permitidos = s.limite_tiempo_minutos * 60
            remaining_seconds = max(0, total_segundos_permitidos - segundos_transcurridos)

        resultado.append(
            {
                "id": s.id,
                "dispositivo_id": s.dispositivo_id,
                "nombre_host": device.nombre_host if device else "(sin nombre)",
                "direccion_mac": device.direccion_mac if device else "—",
                "direccion_ip": s.direccion_ip or (device.direccion_ip if device else "—"),
                "inicio": s.inicio,
                "ultimo_pulso": s.ultimo_pulso,
                "limite_tiempo_minutos": s.limite_tiempo_minutos,
                "limite_velocidad_mbps": s.limite_velocidad_mbps if s.limite_velocidad_mbps is not None else (device.limite_velocidad_mbps if device else None),
                "segundos_transcurridos": segundos_transcurridos,
                "tiempo_restante_segundos": remaining_seconds,
            }
        )

    return resultado


@router.post("/{session_id}/add-time")
def add_time_to_session(
    session_id: int,
    minutes: int = 15,
    db: DBSession = Depends(get_db),
):
    """Agrega minutos a una sesión activa o reactiva una sesión expirada."""
    sesion = db.query(Sesion).filter(Sesion.id == session_id).first()
    if not sesion:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    device = db.query(Dispositivo).filter(Dispositivo.id == sesion.dispositivo_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    ahora = datetime.now()

    # Si ya estaba cerrada / expirada, la reactivamos
    if sesion.fin is not None or sesion.esta_expirada:
        sesion.fin = None
        sesion.esta_expirada = False
        sesion.inicio = ahora
        sesion.ultimo_pulso = ahora
        sesion.limite_tiempo_minutos = minutes
        device.estado = EstadoDispositivo.aprobado
        if device.direccion_ip:
            routeros_client.unblock_device(device.direccion_ip)
            if sesion.limite_velocidad_mbps:
                routeros_client.set_bandwidth_limit(device.direccion_ip, sesion.limite_velocidad_mbps)
        if device.direccion_mac:
            routeros_client.authorize_hotspot_device(device.direccion_mac, device.direccion_ip)
    else:
        # Si sigue abierta, aumentamos el límite
        if sesion.limite_tiempo_minutos is None:
            sesion.limite_tiempo_minutos = minutes
        else:
            sesion.limite_tiempo_minutos += minutes

    db.commit()
    return {
        "ok": True,
        "session_id": sesion.id,
        "limite_tiempo_minutos": sesion.limite_tiempo_minutos,
    }


@router.post("/{session_id}/disconnect")
def disconnect_session(session_id: int, db: DBSession = Depends(get_db)):
    """Corta inmediatamente una sesión activa en MikroTik y deja el equipo en espera de nueva autorización."""
    sesion = db.query(Sesion).filter(Sesion.id == session_id).first()
    if not sesion:
        raise HTTPException(status_code=404, detail="Sesión no encontrada")

    device = db.query(Dispositivo).filter(Dispositivo.id == sesion.dispositivo_id).first()
    ahora = datetime.now()

    sesion.fin = ahora
    sesion.esta_expirada = True

    if device:
        device.estado = EstadoDispositivo.pendiente
        if device.direccion_mac:
            routeros_client.revoke_hotspot_device(device.direccion_mac)
        if device.direccion_ip:
            routeros_client.remove_bandwidth_limit(device.direccion_ip)
            routeros_client.unblock_device(device.direccion_ip)

    db.commit()
    return {"ok": True, "session_id": session_id, "desconectado": True}



@router.get("/device/{device_id}/total-time")
def total_connected_time(device_id: int, db: DBSession = Depends(get_db)):
    """
    Tiempo total conectado de un dispositivo, sumando todas sus
    sesiones (cerradas y la abierta si la tiene).
    """
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    sesiones = db.query(Sesion).filter(Sesion.dispositivo_id == device_id).all()
    ahora = datetime.now()
    total_segundos = 0.0

    for sesion in sesiones:
        fin_sesion = sesion.fin or ahora
        total_segundos += (fin_sesion - sesion.inicio).total_seconds()

    return {
        "dispositivo_id": device_id,
        "total_segundos": int(total_segundos),
        "total_minutos": round(total_segundos / 60, 1),
        "cantidad_sesiones": len(sesiones),
    }
