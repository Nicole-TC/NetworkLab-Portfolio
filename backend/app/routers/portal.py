from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, Dispositivo, Sesion, DominioBloqueado, EstadoDispositivo
from app.auth import requiere_usuario
from app import routeros_client

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
    mac: str | None = None,
    db: Session = Depends(get_db),
):
    """
    Endpoint público del Portal Cautivo:
    Detecta automáticamente la IP y MAC de la estación o celular del alumno y devuelve su estado actual:
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

    # 2. Buscar el dispositivo por MAC si se especificó, o por IP
    device = None
    if mac and mac.strip():
        mac_clean = mac.strip().upper()
        device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == mac_clean).first()

    if not device and client_ip and client_ip not in ("192.168.88.1", "127.0.0.1", "localhost", "::1"):
        device = db.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()

    # Si no está en BD pero la IP pertenece a la red de clientes MikroTik (192.168.88.x),
    # intentar resolver su MAC desde DHCP leases de MikroTik para enlazar de inmediato su identidad real
    if not device and client_ip and client_ip.startswith("192.168.88.") and client_ip not in ("192.168.88.1", "192.168.88.252"):
        try:
            leases = routeros_client.get_dhcp_leases()
            for l in leases:
                if l.get("ip_address") == client_ip:
                    m = (l.get("mac_address") or "").strip().upper()
                    if m:
                        device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == m).first()
                        if device:
                            device.direccion_ip = client_ip
                            db.commit()
                        else:
                            nombre_h = l.get("hostname") or f"Estación {client_ip}"
                            device = Dispositivo(
                                direccion_mac=m,
                                direccion_ip=client_ip,
                                nombre_host=nombre_h,
                                estado=EstadoDispositivo.pendiente,
                                rol="nivel_1",
                                ultima_actividad=datetime.now(),
                            )
                            db.add(device)
                            db.commit()
                            db.refresh(device)
                    break
        except Exception as e:
            print("Nota auto-descubrimiento portal:", e)

    categorias_autorizadas, lista_dominios = _obtener_info_filtrado(db)
    ahora = datetime.now()

    if device and client_ip not in ("127.0.0.1", "localhost", "::1"):
        device.ultima_actividad = ahora
        db.commit()

    dev_rol = (getattr(device, "rol", None) or "nivel_1") if device else "nivel_1"

    # Determinar nombre e IP seguros para mostrar al alumno
    ip_segura = ""
    if device and device.direccion_ip:
        ip_segura = device.direccion_ip
    elif client_ip and not client_ip.startswith("172.") and client_ip not in ("192.168.88.1", "127.0.0.1", "localhost", "::1"):
        ip_segura = client_ip

    if device and device.nombre_host:
        host_display = device.nombre_host
    elif ip_segura:
        host_display = f"Estación {ip_segura}"
    else:
        host_display = "Dispositivo en Red"

    info_filtro = {
        "modo": "lista_blanca",
        "total_autorizados": len(lista_dominios),
        "categorias_autorizadas": categorias_autorizadas,
        "dominios_autorizados": lista_dominios,
        "total_bloqueados": len(lista_dominios),
        "categorias_restringidas": categorias_autorizadas,
    }

    # Caso A: Dispositivo no registrado aún
    if not device:
        return {
            "estado": "pendiente",
            "ip": ip_segura,
            "mac": mac or "",
            "nombre_host": host_display,
            "rol": "nivel_1",
            "mensaje": "Conectado a la red institucional / local. Esperando autorización del administrador...",
            "filtrado_web": info_filtro,
        }

    # Caso B: Dispositivo en espera de aprobación
    if device.estado == EstadoDispositivo.pendiente:
        return {
            "estado": "pendiente",
            "ip": device.direccion_ip or ip_segura,
            "mac": device.direccion_mac or mac or "",
            "nombre_host": host_display,
            "rol": dev_rol,
            "mensaje": "Tu equipo está conectado. Esperando que el administrador autorice tu acceso...",
            "filtrado_web": info_filtro,
        }

    # Caso C: Dispositivo rechazado
    if device.estado == EstadoDispositivo.rechazado:
        return {
            "estado": "rechazado",
            "ip": device.direccion_ip or ip_segura,
            "mac": device.direccion_mac or mac or "",
            "nombre_host": host_display,
            "rol": dev_rol,
            "mensaje": "El acceso a la red para este equipo está pausado o ha sido restringido.",
            "filtrado_web": info_filtro,
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
        # Acumular tiempo activo real neto (descartando tiempo muerto / baches largos de inactividad)
        ultimo = getattr(sesion_activa, "ultimo_pulso", None) or sesion_activa.inicio
        delta = (ahora - ultimo).total_seconds()
        if 0 < delta <= 90:
            sesion_activa.tiempo_activo_segundos = (getattr(sesion_activa, "tiempo_activo_segundos", 0) or 0) + int(delta)
        elif delta > 90:
            sesion_activa.tiempo_activo_segundos = (getattr(sesion_activa, "tiempo_activo_segundos", 0) or 0) + 5
        sesion_activa.ultimo_pulso = ahora
        db.commit()

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
            "ip": device.direccion_ip or ip_segura,
            "mac": device.direccion_mac or mac or "",
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
        "ip": device.direccion_ip or ip_segura,
        "mac": device.direccion_mac or mac or "",
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
        "filtrado_web": info_filtro,
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
            "modo": "lista_blanca",
            "total_autorizados": len(lista_dominios),
            "categorias_autorizadas": categorias_bloqueadas,
            "dominios_autorizados": lista_dominios,
            "total_bloqueados": len(lista_dominios),
            "categorias_restringidas": categorias_bloqueadas,
        },
    }


@router.post("/solicitar-acceso")
def solicitar_acceso(
    request: Request,
    ip: str | None = None,
    mac: str | None = None,
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

    device = None
    if mac and mac.strip():
        device = db.query(Dispositivo).filter(Dispositivo.direccion_mac == mac.strip().upper()).first()
    if not device and client_ip and client_ip not in ("192.168.88.1", "127.0.0.1", "localhost", "::1"):
        device = db.query(Dispositivo).filter(Dispositivo.direccion_ip == client_ip).first()

    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo no encontrado")

    device.estado = EstadoDispositivo.pendiente
    device.ultima_actividad = datetime.now()
    db.commit()

    return {"ok": True, "mensaje": "Solicitud enviada al profesor", "estado": "pendiente"}
