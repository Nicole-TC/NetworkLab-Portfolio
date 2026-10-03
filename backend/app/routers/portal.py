from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, Dispositivo, Sesion, DominioBloqueado, EstadoDispositivo
from app.auth import requiere_usuario

router = APIRouter(prefix="/portal", tags=["portal_alumno"])


def _obtener_info_filtrado(db: Session):
    dominios_db = (
        db.query(DominioBloqueado)
        .filter(DominioBloqueado.esta_activo == True)
        .order_by(DominioBloqueado.categoria.asc(), DominioBloqueado.dominio.asc())
        .all()
    )
    categorias_bloqueadas = sorted(list({d.categoria or "General" for d in dominios_db}))
    lista_dominios = [
        {"dominio": d.dominio, "categoria": d.categoria or "General"}
        for d in dominios_db
    ]
    return categorias_bloqueadas, lista_dominios


@router.get("/estado-conexion")
def obtener_estado_conexion(
    request: Request,
    ip: str | None = None,
    db: Session = Depends(get_db),
):
    """
    Endpoint público del Portal Cautivo:
    Detecta automáticamente la IP de la computadora del alumno y devuelve su estado actual:
    - 'pendiente': Esperando aprobación del profesor.
    - 'aprobado': Acceso activo con Timer regresivo, límite QoS y filtros web.
    - 'rechazado' o 'expirado': Conexión finalizada o restringida.
    """
    # 1. Determinar la IP del cliente (cabecera proxy o conexión directa)
    client_ip = ip
    if not client_ip:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        else:
            client_ip = request.client.host if request.client else "127.0.0.1"

    # 2. Buscar el dispositivo en la base de datos por su IP
    device = db.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()

    # Si es localhost (pruebas locales), tomar el último dispositivo registrado o el primero aprobado
    if not device and client_ip in ("127.0.0.1", "localhost", "::1"):
        device = db.query(Dispositivo).order_by(Dispositivo.ultima_actividad.desc()).first()

    categorias_bloqueadas, lista_dominios = _obtener_info_filtrado(db)
    ahora = datetime.now()

    if device and client_ip not in ("127.0.0.1", "localhost", "::1"):
        device.ultima_actividad = ahora
        db.commit()

    dev_rol = (getattr(device, "rol", None) or "nivel_1") if device else "nivel_1"
    host_display = (device.nombre_host if device and device.nombre_host else f"Estación {client_ip}")

    # Caso A: Dispositivo no registrado aún
    if not device:
        return {
            "estado": "pendiente",
            "ip": client_ip,
            "nombre_host": host_display,
            "rol": "nivel_1",
            "mensaje": "Conectado a la red institucional / local. Esperando autorización del administrador...",
            "filtrado_web": {
                "total_bloqueados": len(lista_dominios),
                "categorias_restringidas": categorias_bloqueadas,
            },
        }

    # Caso B: Dispositivo en espera de aprobación
    if device.estado == EstadoDispositivo.pendiente:
        return {
            "estado": "pendiente",
            "ip": device.direccion_ip or client_ip,
            "nombre_host": host_display,
            "rol": dev_rol,
            "mensaje": "Tu equipo está conectado. Esperando que el administrador autorice tu acceso...",
            "filtrado_web": {
                "total_bloqueados": len(lista_dominios),
                "categorias_restringidas": categorias_bloqueadas,
            },
        }

    # Caso C: Dispositivo rechazado
    if device.estado == EstadoDispositivo.rechazado:
        return {
            "estado": "rechazado",
            "ip": device.direccion_ip or client_ip,
            "nombre_host": host_display,
            "rol": dev_rol,
            "mensaje": "El acceso a la red para este equipo está pausado o ha sido restringido.",
            "filtrado_web": {
                "total_bloqueados": len(lista_dominios),
                "categorias_restringidas": categorias_bloqueadas,
            },
        }

    # Caso D: Dispositivo aprobado -> calcular tiempo y velocidad asignada
    sesion_activa = (
        db.query(Sesion)
        .filter(Sesion.dispositivo_id == device.id, Sesion.fin.is_(None))
        .order_by(Sesion.inicio.desc())
        .first()
    )

    tiempo_restante_segundos = None
    segundos_transcurridos = 0
    limite_minutos = None
    limite_velocidad = device.limite_velocidad_mbps
    esta_expirada = False

    if sesion_activa:
        segundos_transcurridos = int((ahora - sesion_activa.inicio).total_seconds())
        limite_minutos = sesion_activa.limite_tiempo_minutos
        if sesion_activa.limite_velocidad_mbps is not None:
            limite_velocidad = sesion_activa.limite_velocidad_mbps
        esta_expirada = sesion_activa.esta_expirada

        if limite_minutos is not None and limite_minutos > 0:
            total_permitido = limite_minutos * 60
            tiempo_restante_segundos = max(0, total_permitido - segundos_transcurridos)
            if tiempo_restante_segundos <= 0:
                esta_expirada = True

    if esta_expirada:
        return {
            "estado": "expirado",
            "ip": device.direccion_ip or client_ip,
            "nombre_host": host_display,
            "rol": dev_rol,
            "mensaje": "Tu tiempo de conexión asignado ha finalizado.",
            "tiempo": {
                "limite_tiempo_minutos": limite_minutos,
                "segundos_transcurridos": segundos_transcurridos,
                "tiempo_restante_segundos": 0,
                "esta_expirada": True,
                "es_ilimitado": False,
            },
        }

    return {
        "estado": "aprobado",
        "ip": device.direccion_ip or client_ip,
        "nombre_host": host_display,
        "rol": dev_rol,
        "mensaje": "¡Conexión activa y autorizada!",
        "tiempo": {
            "limite_tiempo_minutos": limite_minutos,
            "segundos_transcurridos": segundos_transcurridos,
            "tiempo_restante_segundos": tiempo_restante_segundos,
            "esta_expirada": False,
            "es_ilimitado": limite_minutos is None,
        },
        "velocidad": {
            "limite_mbps": limite_velocidad,
            "es_ilimitada": limite_velocidad is None,
            "descripcion": f"{limite_velocidad} Mbps asignados (Control QoS)" if limite_velocidad else "Velocidad estándar de la red",
        },
        "filtrado_web": {
            "total_bloqueados": len(lista_dominios),
            "categorias_restringidas": categorias_bloqueadas,
            "dominios_bloqueados": lista_dominios,
        },
    }


@router.get("/mi-estado")
def obtener_estado_alumno(
    usuario: Usuario = Depends(requiere_usuario),
    db: Session = Depends(get_db),
):
    """
    Devuelve la información de sesión, tiempo restante, velocidad QoS
    y lista de sitios restringidos para el usuario alumno autenticado.
    """
    ahora = datetime.now()

    # Buscar si tiene un dispositivo o sesión activa
    sesion_activa = (
        db.query(Sesion)
        .filter(
            (Sesion.usuario_id == usuario.id) | (Sesion.dispositivo.has(usuario_id=usuario.id)),
            Sesion.fin.is_(None),
        )
        .order_by(Sesion.inicio.desc())
        .first()
    )

    # Si no tiene sesión asignada específicamente a su ID, tomamos la última sesión activa general
    # para que en el entorno de laboratorio el alumno conectado a la PC vea su estado real
    if not sesion_activa:
        sesion_activa = db.query(Sesion).filter(Sesion.fin.is_(None)).order_by(Sesion.inicio.desc()).first()

    tiempo_restante_segundos = None
    segundos_transcurridos = 0
    limite_minutos = None
    limite_velocidad = None
    esta_expirada = False
    dispositivo_info = None

    if sesion_activa:
        segundos_transcurridos = int((ahora - sesion_activa.inicio).total_seconds())
        limite_minutos = sesion_activa.limite_tiempo_minutos
        limite_velocidad = sesion_activa.limite_velocidad_mbps
        esta_expirada = sesion_activa.esta_expirada

        if limite_minutos is not None and limite_minutos > 0:
            total_permitido = limite_minutos * 60
            tiempo_restante_segundos = max(0, total_permitido - segundos_transcurridos)
            if tiempo_restante_segundos <= 0:
                esta_expirada = True

        if sesion_activa.dispositivo:
            dispositivo_info = {
                "nombre_host": sesion_activa.dispositivo.nombre_host or "Computadora de Laboratorio",
                "direccion_ip": sesion_activa.direccion_ip or sesion_activa.dispositivo.direccion_ip,
                "direccion_mac": sesion_activa.dispositivo.direccion_mac,
                "estado": sesion_activa.dispositivo.estado.value,
            }

    # Obtener lista de dominios y categorías bloqueadas en el MikroTik
    dominios_db = (
        db.query(DominioBloqueado)
        .filter(DominioBloqueado.esta_activo == True)
        .order_by(DominioBloqueado.categoria.asc(), DominioBloqueado.dominio.asc())
        .all()
    )

    categorias_bloqueadas = sorted(list({d.categoria or "General" for d in dominios_db}))
    lista_dominios = [
        {"dominio": d.dominio, "categoria": d.categoria or "General"}
        for d in dominios_db
    ]

    return {
        "usuario": {
            "id": usuario.id,
            "nombre_usuario": usuario.nombre_usuario,
            "nombre_completo": usuario.nombre_completo or usuario.nombre_usuario,
            "rol": usuario.rol.value,
        },
        "dispositivo": dispositivo_info or {
            "nombre_host": "Estación de Trabajo",
            "direccion_ip": "Conectado a la Red",
            "direccion_mac": "—",
            "estado": "aprobado",
        },
        "tiempo": {
            "limite_tiempo_minutos": limite_minutos,
            "segundos_transcurridos": segundos_transcurridos,
            "tiempo_restante_segundos": tiempo_restante_segundos,
            "esta_expirada": esta_expirada,
            "es_ilimitado": limite_minutos is None,
        },
        "velocidad": {
            "limite_mbps": limite_velocidad,
            "es_ilimitada": limite_velocidad is None,
            "descripcion": f"{limite_velocidad} Mbps asignados (Control QoS)" if limite_velocidad else "Velocidad estándar del laboratorio",
        },
        "filtrado_web": {
            "total_bloqueados": len(lista_dominios),
            "categorias_restringidas": categorias_bloqueadas,
            "dominios_bloqueados": lista_dominios,
        },
    }


@router.post("/solicitar-acceso")
def solicitar_acceso(
    request: Request,
    ip: str | None = None,
    db: Session = Depends(get_db),
):
    """
    Permite a una estación que quedó expirada o rechazada volver a solicitar
    aprobación al profesor (pasando su estado a 'pendiente').
    """
    client_ip = ip
    if not client_ip:
        forwarded_for = request.headers.get("x-forwarded-for")
        if forwarded_for:
            client_ip = forwarded_for.split(",")[0].strip()
        else:
            client_ip = request.client.host if request.client else "127.0.0.1"

    device = db.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()
    if not device and client_ip in ("127.0.0.1", "localhost", "::1"):
        device = db.query(Dispositivo).order_by(Dispositivo.ultima_actividad.desc()).first()

    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.estado = EstadoDispositivo.pendiente
    device.ultima_actividad = datetime.now()
    db.commit()

    return {"ok": True, "mensaje": "Solicitud enviada al profesor", "estado": "pendiente"}
