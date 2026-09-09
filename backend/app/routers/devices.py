from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Dispositivo, EstadoDispositivo, Sesion
from app import routeros_client

router = APIRouter(prefix="/devices", tags=["devices"])


@router.post("/sync")
def sync_devices(db: Session = Depends(get_db)):
    """
    Consulta los leases DHCP del router y da de alta como 'pendiente'
    cualquier dispositivo nuevo que no esté ya registrado.
    """
    leases = routeros_client.get_dhcp_leases()
    nuevos = 0

    for lease in leases:
        mac = lease["mac_address"]
        if not mac:
            continue

        device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == mac).first()
        if device is None:
            device = Dispositivo(
                direccion_mac=mac,
                direccion_ip=lease["ip_address"],
                nombre_host=lease["hostname"],
                estado=EstadoDispositivo.pendiente,
            )
            db.add(device)
            nuevos += 1
            # Por defecto, mientras está pendiente, lo bloqueamos
            if lease["ip_address"]:
                routeros_client.block_device(lease["ip_address"])
        else:
            device.direccion_ip = lease["ip_address"]
            device.nombre_host = lease["hostname"] or device.nombre_host
            device.ultima_actividad = datetime.now()

    db.commit()
    return {"nuevos_detectados": nuevos, "total_leases": len(leases)}


@router.get("/")
def list_devices(estado: EstadoDispositivo | None = None, db: Session = Depends(get_db)):
    query = db.query(Dispositivo)
    if estado:
        query = query.filter(Dispositivo.estado == estado)
    return query.order_by(Dispositivo.ultima_actividad.desc()).all()


@router.post("/{device_id}/approve")
def approve_device(
    device_id: int,
    time_limit_minutes: int | None = None,
    bandwidth_limit_mbps: int | None = None,
    custom_username: str | None = None,
    custom_password: str | None = None,
    db: Session = Depends(get_db),
):
    from app.models import Usuario, RolUsuario
    from app.auth import hashear_clave

    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

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
            usuario_asignado.esta_activo = True
        else:
            usuario_asignado = Usuario(
                nombre_usuario=nombre_user,
                clave_hash=hashear_clave(clave_plana),
                rol=RolUsuario.alumno,
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
        usuario_asignado.esta_activo = True

    device.usuario_id = usuario_asignado.id
    device.estado = EstadoDispositivo.aprobado
    device.limite_velocidad_mbps = bandwidth_limit_mbps
    db.commit()

    if device.direccion_ip:
        routeros_client.unblock_device(device.direccion_ip)
        routeros_client.set_bandwidth_limit(device.direccion_ip, bandwidth_limit_mbps)

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
        "estado": device.estado,
        "limite_tiempo_minutos": time_limit_minutes,
        "limite_velocidad_mbps": bandwidth_limit_mbps,
        "usuario_creado": {
            "id": usuario_asignado.id,
            "nombre_usuario": usuario_asignado.nombre_usuario,
            "clave_usada": clave_plana,
        },
    }


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


@router.post("/{device_id}/reject")
def reject_device(device_id: int, db: Session = Depends(get_db)):
    device = db.query(Dispositivo).filter(Dispositivo.id == device_id).first()
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.estado = EstadoDispositivo.rechazado
    db.commit()

    if device.direccion_ip:
        routeros_client.block_device(device.direccion_ip)
        routeros_client.remove_bandwidth_limit(device.direccion_ip)

    return {"ok": True, "device_id": device_id, "estado": device.estado}
